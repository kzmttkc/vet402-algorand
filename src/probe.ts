/**
 * Pays a downstream x402 endpoint (as vet402) and checks what it delivered
 * against what its 402 declared.
 *
 * Order matters: price and caps are checked BEFORE any signature is created.
 * The paying client is additionally locked (policy + hook) to the exact accept
 * we approved, and to a single payload per probe, so a seller cannot raise the
 * price or ask twice between our look and our payment.
 */
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from "@x402/fetch";
import { ExactAvmScheme, toClientAvmSigner, ALGORAND_TESTNET_GENESIS_HASH, ALGORAND_MAINNET_GENESIS_HASH } from "@x402/avm";
import { atomicToUsdc, type AppConfig } from "./config.js";
import type { SpendLedger } from "./caps.js";
import { declarationFrom, sameNetwork, selectAccept, type AcceptLike, type PaymentRequiredLike } from "./declaration.js";
import { checkTarget } from "./target.js";
import { expectedKeys, judgeDelivery, type Reason, type Verdict } from "./verdict.js";

const MAX_BODY_BYTES = 1_000_000;

export interface ProbeResult {
  verdict: Verdict;
  reason: Reason;
  target: string;
  detail?: string;
  declared?: { description?: string; mimeType?: string; expectedKeys: string[] };
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

function parsePaymentRequired(res: Response, bodyText: string): PaymentRequiredLike | null {
  let body: unknown;
  try {
    body = bodyText ? JSON.parse(bodyText) : undefined;
  } catch {
    body = undefined;
  }
  try {
    const pr = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((n) => res.headers.get(n), body);
    return pr as unknown as PaymentRequiredLike;
  } catch {
    return null;
  }
}

export async function probe(target: string, cfg: AppConfig, ledger: SpendLedger, deps: ProbeDeps): Promise<ProbeResult> {
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
  const pr = parsePaymentRequired(first, firstBody);
  if (!pr || !Array.isArray(pr.accepts)) {
    return { verdict: "REFUSE", reason: "not_x402", target: url, detail: "402 without parseable x402 payment requirements" };
  }
  const decl = declarationFrom(pr);
  const declared = { description: decl.description, mimeType: decl.mimeType, expectedKeys: expectedKeys(decl) };

  // 2) Choose what we would pay, and check caps before any signature exists.
  const accept = selectAccept(pr.accepts, cfg.network, cfg.usdcAsaId);
  if (!accept) {
    return { verdict: "REFUSE", reason: "no_supported_accept", target: url, declared, detail: `no exact/${cfg.network}/USDC ${cfg.usdcAsaId} accept` };
  }
  const amount = BigInt(accept.amount);
  const price = { amountAtomic: accept.amount, usdc: atomicToUsdc(amount), payTo: accept.payTo, network: accept.network, asset: String(accept.asset) };
  const cap = ledger.reserve(amount);
  if (!cap.ok) return { verdict: "REFUSE", reason: cap.reason, target: url, declared, price, detail: cap.detail };

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
    const scheme = new ExactAvmScheme(signer);
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
