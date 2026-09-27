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

const MAX_BODY_BYTES = 1_000_000;

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

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
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

export async function probe(target: string, cfg: AppConfig, ledger: SpendGuard, deps: ProbeDeps): Promise<ProbeResult> {
  const t = await checkTarget(target, cfg.allowPrivateTargets, deps.resolveHost);
  if (!t.ok) return { verdict: "REFUSE", reason: "invalid_target", target, detail: t.detail };
  const url = t.url.toString();
  const init = (): RequestInit => ({ method: "GET", redirect: "manual", signal: AbortSignal.timeout(cfg.probeTimeoutMs) });

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
  const accept = selectAccept(pr.accepts, cfg.network, cfg.usdcAsaId);
  if (!accept) {
    return { verdict: "REFUSE", reason: "no_supported_accept", target: url, declared, detail: `no exact/${cfg.network}/USDC ${cfg.usdcAsaId} accept` };
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

  const bodyText = await readCapped(paid.response).catch(() => "");
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
