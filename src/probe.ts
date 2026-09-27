/**
 * Pays a downstream x402 endpoint (as vet402) and checks what it delivered
 * against what its 402 declared.
 *
 * Order matters: price and caps are checked BEFORE any signature is created.
 * The paying client is additionally locked (policy + hook) to the exact accept
 * we approved, and to a single payload per probe, so a seller cannot raise the
 * price or ask twice between our look and our payment.
 */
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from "@x402/fetch";
import { PaymentRequiredV2Schema } from "@x402/core/schemas";
import { ExactAvmScheme, toClientAvmSigner, ALGORAND_TESTNET_GENESIS_HASH, ALGORAND_MAINNET_GENESIS_HASH } from "@x402/avm";
import { atomicToUsdc, type AppConfig } from "./config.js";
import type { SpendGuard } from "./spend.js";
import { declarationFrom, sameNetwork, selectAccept, type AcceptLike, type PaymentRequiredLike } from "./declaration.js";
import { checkTarget } from "./target.js";
import { exampleKeys, expectedKeys, judgeDelivery, type Reason, type Verdict } from "./verdict.js";

export const MAX_BODY_BYTES = 1_000_000;

export interface ProbeResult {
  verdict: Verdict;
  reason: Reason;
  target: string;
  detail?: string;
  /** expectedKeys = schema.required (a miss is a REFUSE); exampleKeys = hints used only when nothing is required. */
  declared?: { description?: string; mimeType?: string; expectedKeys: string[]; exampleKeys?: string[] };
  price?: { amountAtomic: string; usdc: string; payTo: string; network: string; asset: string };
  downstreamPayment?: { success: boolean; transaction?: string; network?: string; payer?: string; errorReason?: string };
  delivery?: { status: number; contentType: string | null; bytes: number; summary: string; missingKeys: string[] };
}

export interface PaidFetchResult {
  response: Response;
  settle: { success: boolean; transaction?: string; network?: string; payer?: string; errorReason?: string } | null;
  /** true once a payment signature has been created (money may move). */
  signed: boolean;
}

export interface ProbeDeps {
  /** Unpaid fetch used to read the seller's 402. */
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  /** Pays exactly `approved` and returns the paid response. */
  paidFetch: (url: string, approved: AcceptLike, init: RequestInit) => Promise<PaidFetchResult>;
  resolveHost?: (host: string) => Promise<string[]>;
  /** vet402's own addresses (customer payTo, payer). Sellers paying into these are refused. */
  ownAddresses?: string[];
}

/** The body up to MAX_BODY_BYTES; `truncated` = there was more (the rest is not read). */
export async function readCappedBytes(res: Response): Promise<{ bytes: Buffer; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: Buffer.alloc(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return { bytes: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(value);
  }
  return { bytes: Buffer.concat(chunks), truncated: false };
}

export async function readCapped(res: Response): Promise<string> {
  return (await readCappedBytes(res)).bytes.toString("utf8");
}

/**
 * Where the seller's payment requirements were read from.
 * - "client": the way the x402 paying client reads them (PAYMENT-REQUIRED header, or a v1 JSON body).
 * - "body": x402 v2 requirements found only in the JSON body, with no PAYMENT-REQUIRED header.
 *   The paying client (@x402/fetch 2.11 / @x402/core getPaymentRequiredResponse) rejects this
 *   shape, so vet402 can read it but cannot pay it.
 */
export type RequirementsSource = "client" | "body";

export function parsePaymentRequired(
  res: Response,
  bodyText: string,
): { pr: PaymentRequiredLike; source: RequirementsSource } | null {
  let body: unknown;
  try {
    body = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    body = undefined;
  }
  try {
    const pr = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((n) => res.headers.get(n), body);
    return { pr: pr as unknown as PaymentRequiredLike, source: "client" };
  } catch {
    // fall through to the body-only v2 form
  }
  if (res.headers.get("PAYMENT-REQUIRED")) return null; // a header that does not decode is not replaced by the body
  const v2 = PaymentRequiredV2Schema.safeParse(body);
  if (!v2.success) return null;
  return { pr: v2.data as unknown as PaymentRequiredLike, source: "body" };
}

/** Options used by /v1/buy (buy.ts). /v1/check and /v1/audit call probe() without them. */
export interface ProbeOptions {
  /** Request to send to the seller (default GET, no body). */
  method?: "GET" | "POST";
  body?: Uint8Array<ArrayBuffer>;
  contentType?: string;
  /**
   * The accept the customer paid for. vet402 then pays exactly this one (same scheme, network,
   * asset, payTo; the seller's amount may be lower, never higher). If the seller now asks for
   * anything else, nothing is paid (reason price_changed).
   */
  expect?: AcceptLike;
  /**
   * A reservation the caller already holds on `ledger` for up to `amountAtomic` (/v1/buy takes it
   * before the customer's payment settles). probe() uses it instead of reserving again, and
   * releases it on every path that does not sign a payment.
   */
  reservation?: { id: string; amountAtomic: bigint };
}

/** What the seller delivered after being paid, byte for byte (only when it was paid). */
export interface DeliveredBody {
  status: number;
  contentType: string | null;
  bytes: Buffer;
  /** The body was larger than MAX_BODY_BYTES; `bytes` holds only the first part. */
  truncated: boolean;
}

export async function probe(target: string, cfg: AppConfig, ledger: SpendGuard, deps: ProbeDeps): Promise<ProbeResult> {
  return (await probeWithBody(target, cfg, ledger, deps)).result;
}

/** probe() that also hands back the seller's paid response body (for /v1/buy). */
export async function probeWithBody(
  target: string,
  cfg: AppConfig,
  ledger: SpendGuard,
  deps: ProbeDeps,
  opts: ProbeOptions = {},
): Promise<{ result: ProbeResult; delivered?: DeliveredBody }> {
  let delivered: DeliveredBody | undefined;
  const r = opts.reservation;
  if (!r) {
    const result = await probeCore(target, cfg, ledger, deps, opts, (d) => {
      delivered = d;
    });
    return { result, delivered };
  }
  // Hand the held reservation to probeCore as its "reserve"; release it if probeCore never used or settled it.
  let done = false;
  const held: SpendGuard = {
    reserve: async (amount) =>
      amount <= r.amountAtomic
        ? { ok: true, reservationId: r.id }
        : { ok: false, reason: "price_over_cap", detail: `seller asks ${amount}, reserved ${r.amountAtomic}` },
    release: (id) => {
      done = true;
      ledger.release(id);
    },
    commit: (id) => {
      done = true;
      ledger.commit(id);
    },
    headroom: () => ledger.headroom(),
  };
  try {
    const result = await probeCore(target, cfg, held, deps, opts, (d) => {
      delivered = d;
    });
    return { result, delivered };
  } finally {
    if (!done) ledger.release(r.id);
  }
}

async function probeCore(
  target: string,
  cfg: AppConfig,
  ledger: SpendGuard,
  deps: ProbeDeps,
  opts: ProbeOptions,
  onDelivered: (d: DeliveredBody) => void,
): Promise<ProbeResult> {
  const t = await checkTarget(target, cfg.allowPrivateTargets, deps.resolveHost);
  if (!t.ok) return { verdict: "REFUSE", reason: "invalid_target", target, detail: t.detail };
  const url = t.url.toString();
  const method = opts.method ?? "GET";
  const init = (): RequestInit => ({
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(cfg.probeTimeoutMs),
    ...(method === "POST" ? { body: opts.body ?? new Uint8Array(0), headers: { "content-type": opts.contentType ?? "application/json" } } : {}),
  });

  // 1) Look at the 402 without paying.
  let first: Response;
  let firstBody: string;
  try {
    first = await deps.fetchImpl(url, init());
    firstBody = await readCapped(first);
  } catch (e) {
    return { verdict: "REFUSE", reason: "probe_error", target: url, detail: (e as Error).message.slice(0, 200) };
  }
  if (first.status !== 402) {
    return { verdict: "REFUSE", reason: "not_x402", target: url, detail: `expected 402, got ${first.status}` };
  }
  const parsed = parsePaymentRequired(first, firstBody);
  if (!parsed || !Array.isArray(parsed.pr.accepts)) {
    return { verdict: "REFUSE", reason: "not_x402", target: url, detail: "402 without parseable x402 payment requirements" };
  }
  const pr = parsed.pr;
  const decl = declarationFrom(pr);
  const declared = { description: decl.description, mimeType: decl.mimeType, expectedKeys: expectedKeys(decl), exampleKeys: exampleKeys(decl) };

  // 2) Choose what we would pay, and check caps before any signature exists.
  const selected = selectAccept(pr.accepts, cfg.network, cfg.usdcAsaId);
  if (!selected) {
    return { verdict: "REFUSE", reason: "no_supported_accept", target: url, declared, detail: `no exact/${cfg.network}/USDC ${cfg.usdcAsaId} accept` };
  }
  let accept = selected;
  if (opts.expect) {
    const e = opts.expect;
    // The seller must still offer what the customer paid for; it may have lowered the price.
    const same = pr.accepts.find(
      (a) =>
        a.scheme === e.scheme &&
        sameNetwork(a.network, e.network) &&
        String(a.asset) === String(e.asset) &&
        a.payTo === e.payTo &&
        /^\d+$/.test(String(a.amount)) &&
        BigInt(a.amount) <= BigInt(e.amount),
    );
    if (!same) {
      return {
        verdict: "REFUSE",
        reason: "price_changed",
        target: url,
        declared,
        price: { amountAtomic: selected.amount, usdc: atomicToUsdc(BigInt(selected.amount)), payTo: selected.payTo, network: selected.network, asset: String(selected.asset) },
        detail: `the seller now asks ${selected.amount} to ${selected.payTo}; the customer paid for ${e.amount} to ${e.payTo}. vet402 did not pay.`,
      };
    }
    // Pay (and reserve) the seller's current price: the paying client is locked to at most this.
    accept = same;
  }
  const amount = BigInt(accept.amount);
  const price = { amountAtomic: accept.amount, usdc: atomicToUsdc(amount), payTo: accept.payTo, network: accept.network, asset: String(accept.asset) };
  if (deps.ownAddresses?.includes(accept.payTo)) {
    return { verdict: "REFUSE", reason: "self_dealing", target: url, declared, price, detail: "seller payTo is a vet402 wallet; vet402 never pays itself" };
  }
  const cap = await ledger.reserve(amount);
  if (!cap.ok) return { verdict: "REFUSE", reason: cap.reason, target: url, declared, price, detail: cap.detail };
  if (parsed.source === "body") {
    // Readable and within every check, but the paying client cannot pay a body-only v2 402. Do not try.
    ledger.release(cap.reservationId);
    return {
      verdict: "REFUSE",
      reason: "requirements_body_only",
      target: url,
      declared,
      price,
      detail: "x402 v2 requirements are in the 402 body only (no PAYMENT-REQUIRED header); the x402 paying client cannot pay this, so vet402 did not pay",
    };
  }

  // 3) Pay and fetch.
  let paid: PaidFetchResult;
  try {
    paid = await deps.paidFetch(url, accept, init());
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    // If no signature was produced, give the budget back.
    if (!(e as { signed?: boolean }).signed) ledger.release(cap.reservationId);
    else ledger.commit(cap.reservationId);
    return { verdict: "REFUSE", reason: "payment_failed", target: url, declared, price, detail: msg.slice(0, 200) };
  }
  if (paid.signed) ledger.commit(cap.reservationId);
  else ledger.release(cap.reservationId);

  const read = await readCappedBytes(paid.response).catch(() => ({ bytes: Buffer.alloc(0), truncated: false }));
  const bodyText = read.bytes.toString("utf8");
  const downstreamPayment = paid.settle ?? undefined;
  if (!paid.settle || !paid.settle.success) {
    return {
      verdict: "REFUSE",
      reason: "payment_failed",
      target: url,
      declared,
      price,
      downstreamPayment,
      detail: `status ${paid.response.status}${paid.settle?.errorReason ? `, ${paid.settle.errorReason}` : ", no settlement receipt"}`,
    };
  }

  onDelivered({ status: paid.response.status, contentType: paid.response.headers.get("content-type"), bytes: read.bytes, truncated: read.truncated });

  // 4) Compare delivery with declaration.
  const j = judgeDelivery(decl, { status: paid.response.status, contentType: paid.response.headers.get("content-type"), bodyText });
  return {
    verdict: j.verdict,
    reason: j.reason,
    target: url,
    ...(j.note ? { detail: j.note } : {}),
    declared,
    price,
    downstreamPayment,
    delivery: {
      status: paid.response.status,
      contentType: paid.response.headers.get("content-type"),
      bytes: Buffer.byteLength(bodyText),
      summary: j.summary,
      missingKeys: j.missingKeys,
    },
  };
}

/** Real paying fetch: @x402/fetch wrapFetchWithPayment + ExactAvmScheme, locked to `approved`. */
export function makePaidFetch(cfg: AppConfig, secretKeyB64: string, baseFetch: typeof fetch = fetch): ProbeDeps["paidFetch"] {
  const signer = toClientAvmSigner(secretKeyB64);
  return async (url, approved, init) => {
    let signedCount = 0;
    const client = new x402Client();
    const scheme = new ExactAvmScheme(signer, {
      algorandClient: cfg.networkName === "mainnet" ? AlgorandClient.mainNet() : AlgorandClient.testNet(),
    });
    client.register(cfg.network as `${string}:${string}`, scheme);
    // Newer sellers advertise the truncated CAIP-2; register that form too.
    const genesis = cfg.networkName === "mainnet" ? ALGORAND_MAINNET_GENESIS_HASH : ALGORAND_TESTNET_GENESIS_HASH;
    const truncated = `algorand:${genesis.slice(0, 32)}`;
    if (truncated !== cfg.network) client.register(truncated as `${string}:${string}`, scheme);
    // Policy: only the exact accept we approved, never above the per-call cap.
    client.registerPolicy((_v, reqs) =>
      reqs.filter(
        (r) =>
          r.scheme === "exact" &&
          sameNetwork(r.network, approved.network) &&
          String(r.asset) === String(approved.asset) &&
          r.payTo === approved.payTo &&
          /^\d+$/.test(String(r.amount)) &&
          BigInt(r.amount) <= BigInt(approved.amount) &&
          BigInt(r.amount) <= cfg.maxPerCallAtomic,
      ),
    );
    client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
      if (signedCount >= 1) return { abort: true, reason: "vet402: one payment per probe" };
      if (BigInt(r.amount) > cfg.maxPerCallAtomic) return { abort: true, reason: "vet402: price_over_cap" };
      if (BigInt(r.amount) > BigInt(approved.amount)) return { abort: true, reason: "vet402: price changed" };
      return undefined;
    });
    client.onAfterPaymentCreation(async () => {
      signedCount += 1;
    });
    const payingFetch = wrapFetchWithPayment(baseFetch, client);
    let response: Response;
    try {
      response = await payingFetch(url, init);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      (err as Error & { signed?: boolean }).signed = signedCount > 0;
      throw err;
    }
    let settle: PaidFetchResult["settle"] = null;
    try {
      const s = new x402HTTPClient(client).getPaymentSettleResponse((n) => response.headers.get(n));
      settle = { success: s.success, transaction: s.transaction, network: s.network, payer: s.payer, errorReason: s.errorReason };
    } catch {
      settle = null;
    }
    return { response, settle, signed: signedCount > 0 };
  };
}
