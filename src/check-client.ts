/**
 * Client part for agents: "check with vet402 before you buy".
 *
 *   const r = await checkBeforeBuy("https://seller.example/v1/data", { mnemonic, network: "mainnet" });
 *   if (r.verdict === "ALLOW") { ...buy it yourself... }
 *
 * Pays vet402 (default 0.05 USDC on Algorand) for GET /v1/check?url=<target>
 * and returns vet402's JSON answer (verdict, reason, both tx ids, delivery summary).
 *
 * No side effects on import: this module does not read env files or print.
 * It is also used inside the stdio MCP server, where stdout belongs to JSON-RPC.
 */
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from "@x402/fetch";
import {
  ExactAvmScheme,
  toClientAvmSigner,
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
} from "@x402/avm";
import type { SchemeNetworkClient } from "@x402/core/types";
import { secretKeyB64FromMnemonic } from "./keys.js";
import { sameNetwork, normalizeNetwork } from "./declaration.js";

export const VET402_DEFAULT_URL = "https://vet402-algorand.vercel.app";
/** vet402's published price per check. The client refuses to pay more unless raised. */
export const VET402_DEFAULT_MAX_USDC = "0.05";
/** Most one purchase through vet402 (/v1/buy: seller price + fee) may cost by default. */
export const VET402_DEFAULT_MAX_BUY_USDC = "0.10";
/**
 * Where the public vet402 (VET402_DEFAULT_URL) is paid on MainNet. Same value as
 * MAINNET_DEFAULT_PAY_TO in config.ts (a test checks it); not imported, because config.ts
 * loads env files on import and this module must have no side effects.
 */
export const VET402_MAINNET_PAY_TO = "RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q";
/** Largest vet402 answer the client reads (vet402 forwards at most 1 MB of seller body). */
export const MAX_ANSWER_BYTES = 1_100_000;
const FREE_READ_TIMEOUT_MS = 30_000;
const PAID_TIMEOUT_MS = 120_000;

const isDefaultVet402 = (u: string | undefined) => !u || u.replace(/\/+$/, "") === VET402_DEFAULT_URL;

/** Where a payment may go: exactly `payTo` (when set), never to any of `notPayTo`. */
export interface PayToLock {
  payTo?: string;
  notPayTo?: string[];
}

export type CheckNetwork = "mainnet" | "testnet";

export interface CheckOptions {
  /** 25-word Algorand mnemonic of the paying wallet. Give this or `secretKey`. */
  mnemonic?: string;
  /** Base64 of the 64-byte secret key (seed || pubkey). Give this or `mnemonic`. */
  secretKey?: string;
  /** Default "mainnet". */
  network?: CheckNetwork;
  /** vet402 base URL. Default https://vet402-algorand.vercel.app */
  vet402Url?: string;
  /** Most this call may pay vet402, in USDC. Default "0.05". */
  maxPriceUsdc?: string;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Injected in tests; default ExactAvmScheme with the given key. */
  scheme?: SchemeNetworkClient;
}

export interface CheckResult {
  /** HTTP status from vet402. 200 = paid and judged; 400/503 = refused before charging. */
  httpStatus: number;
  verdict?: "ALLOW" | "REFUSE";
  reason?: string;
  target?: string;
  detail?: string;
  /** Your payment to vet402 (tx id in `transaction`). */
  customerPayment?: { transaction?: string; network?: string; amount?: string; payTo?: string; [k: string]: unknown };
  /** vet402's payment to the seller (tx id in `transaction`), when it paid. */
  downstreamPayment?: { success?: boolean; transaction?: string; network?: string; [k: string]: unknown };
  price?: { amountAtomic?: string; usdc?: string; payTo?: string; network?: string; asset?: string };
  declared?: { description?: string; mimeType?: string; expectedKeys?: string[] };
  delivery?: { status?: number; contentType?: string | null; bytes?: number; summary?: string; missingKeys?: string[] };
  [k: string]: unknown;
}

/** vet402 did not give a verdict (payment refused by the client or not accepted by vet402). */
export class CheckError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly paid: boolean = false,
  ) {
    super(message);
    this.name = "CheckError";
  }
}

const NETWORKS: Record<CheckNetwork, { caip2: string; usdc: string }> = {
  mainnet: { caip2: ALGORAND_MAINNET_CAIP2, usdc: String(USDC_MAINNET_ASA_ID) },
  testnet: { caip2: ALGORAND_TESTNET_CAIP2, usdc: String(USDC_TESTNET_ASA_ID) },
};

function usdcToAtomic(usdc: string): bigint {
  const s = usdc.trim().replace(/^\$/, "");
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new CheckError(`invalid USDC amount: ${usdc}`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

export function checkUrl(vet402Url: string, targetUrl: string): string {
  return `${vet402Url.replace(/\/+$/, "")}/v1/check?url=${encodeURIComponent(targetUrl)}`;
}

/**
 * Builds the paying x402 client for vet402: one payment per call, only exact/USDC
 * on the chosen Algorand network, never above `maxAtomic`.
 */
export function makeCheckClient(scheme: SchemeNetworkClient, network: CheckNetwork, maxAtomic: bigint, lock: PayToLock = {}) {
  const net = NETWORKS[network];
  const state = { signed: 0 };
  const payToAllowed = (to: string) => (!lock.payTo || to === lock.payTo) && !(lock.notPayTo ?? []).includes(to);
  const client = new x402Client();
  client.register(net.caip2 as `${string}:${string}`, scheme);
  const truncated = normalizeNetwork(net.caip2);
  if (truncated !== net.caip2) client.register(truncated as `${string}:${string}`, scheme);
  client.registerPolicy((_v, reqs) =>
    reqs.filter(
      (r) =>
        r.scheme === "exact" &&
        sameNetwork(r.network, net.caip2) &&
        String(r.asset) === net.usdc &&
        /^\d+$/.test(String(r.amount)) &&
        BigInt(r.amount) <= maxAtomic &&
        payToAllowed(r.payTo),
    ),
  );
  client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
    if (state.signed >= 1) return { abort: true, reason: "one payment per check" };
    if (BigInt(r.amount) > maxAtomic) return { abort: true, reason: "price above maxPriceUsdc" };
    if (!payToAllowed(r.payTo)) return { abort: true, reason: "payTo is not vet402's" };
    return undefined;
  });
  client.onAfterPaymentCreation(async () => {
    state.signed += 1;
  });
  return { client, state };
}

/** The paying scheme for `opts` (injected in tests, else ExactAvmScheme with the given key). */
function payingScheme(opts: CheckOptions): { scheme: SchemeNetworkClient; network: CheckNetwork } {
  const network = opts.network ?? "mainnet";
  if (!(network in NETWORKS)) throw new CheckError(`network must be mainnet or testnet, got ${String(network)}`);
  if (opts.scheme) return { scheme: opts.scheme, network };
  const sk = opts.secretKey?.trim() || (opts.mnemonic?.trim() ? secretKeyB64FromMnemonic(opts.mnemonic.trim()) : "");
  if (!sk) throw new CheckError("a paying key is required: pass mnemonic or secretKey");
  const algorandClient = network === "testnet" ? AlgorandClient.testNet() : AlgorandClient.mainNet();
  return { scheme: new ExactAvmScheme(toClientAvmSigner(sk), { algorandClient }), network };
}

/**
 * Pay vet402 to check `targetUrl` and return its verdict. vet402 pays the target
 * itself only after your payment has settled, and answers with both tx ids.
 * With the default vet402 URL on MainNet, only a payment to vet402's own address is signed.
 */
export async function checkBeforeBuy(targetUrl: string, opts: CheckOptions): Promise<CheckResult> {
  if (!targetUrl || typeof targetUrl !== "string") throw new CheckError("targetUrl is required");
  const { scheme, network } = payingScheme(opts);

  const maxAtomic = usdcToAtomic(opts.maxPriceUsdc ?? VET402_DEFAULT_MAX_USDC);
  const lock: PayToLock = isDefaultVet402(opts.vet402Url) && network === "mainnet" ? { payTo: VET402_MAINNET_PAY_TO } : {};
  const { client, state } = makeCheckClient(scheme, network, maxAtomic, lock);
  const baseFetch = opts.fetchImpl ?? fetch;
  const payingFetch = wrapFetchWithPayment(baseFetch, client);

  let res: Response;
  try {
    res = await payingFetch(checkUrl(opts.vet402Url ?? VET402_DEFAULT_URL, targetUrl), { method: "GET", redirect: "error", signal: AbortSignal.timeout(PAID_TIMEOUT_MS) });
  } catch (e) {
    throw new CheckError(`vet402 check failed before a verdict: ${(e as Error).message ?? String(e)}`, undefined, state.signed > 0);
  }

  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new CheckError(`vet402 answered HTTP ${res.status} with non-JSON`, res.status, state.signed > 0);
  }

  if (res.status === 402) {
    let why = "payment not accepted";
    try {
      why = new x402HTTPClient(client).getPaymentRequiredResponse((n) => res.headers.get(n), body).error ?? why;
    } catch {
      /* keep default */
    }
    throw new CheckError(`vet402 did not accept the payment: ${why}`, 402, state.signed > 0);
  }
  if (typeof body.verdict !== "string") {
    throw new CheckError(`vet402 answered HTTP ${res.status} without a verdict: ${String(body.error ?? text).slice(0, 200)}`, res.status, state.signed > 0);
  }

  // The settle header carries payment 1's tx id too; use it when the body lacks it.
  const result = { ...body, httpStatus: res.status } as CheckResult;
  if (res.status === 200 && !result.customerPayment?.transaction) {
    try {
      const s = new x402HTTPClient(client).getPaymentSettleResponse((n) => res.headers.get(n));
      if (s.success && s.transaction) result.customerPayment = { ...(result.customerPayment ?? {}), transaction: s.transaction, network: s.network };
    } catch {
      /* no settle header */
    }
  }
  return result;
}

export function buyUrl(vet402Url: string, targetUrl: string): string {
  return `${vet402Url.replace(/\/+$/, "")}/v1/buy?url=${encodeURIComponent(targetUrl)}`;
}

export interface BuyOptions extends CheckOptions {
  /** Request to the seller: GET (default) or POST with a JSON body. */
  method?: "GET" | "POST";
  /** POST body: a JSON string, or a value that is serialised with JSON.stringify. */
  body?: unknown;
  /** Most this purchase may cost in total (seller price + vet402's fee), in USDC. Default "0.10". */
  maxPriceUsdc?: string;
}

export interface BuyResult {
  /** false = nothing was paid (vet402 refused for free, or the price was above maxPriceUsdc). */
  paid: boolean;
  /** HTTP status from vet402 (of the free quote when paid is false). */
  httpStatus: number;
  /** The free quote from vet402's unpaid 402 (`buy`: seller price, fee, total). */
  quote?: { total?: { amountAtomic?: string; usdc?: string }; sellerPrice?: { usdc?: string; payTo?: string }; fee?: { usdc?: string }; [k: string]: unknown };
  /** Why nothing was paid (vet402's refusal body, or `price_above_max`). */
  refusal?: { reason?: string; detail?: string; [k: string]: unknown };
  verdict?: string;
  reason?: string;
  customerTx?: string;
  sellerTx?: string;
  sellerStatus?: string;
  contentType?: string | null;
  /** The seller's body as vet402 returned it: text for text/JSON types, else base64. */
  body?: string;
  bodyEncoding?: "utf8" | "base64";
}

const isTextType = (ct: string | null) => !ct || /^(text\/|application\/(json|[a-z0-9.+-]*\+json|xml|javascript))/i.test(ct);

/**
 * Buy an x402 resource through vet402 (GET|POST /v1/buy): read the free price first, pay only if
 * the total (seller price + fee) is within `maxPriceUsdc`, and return the seller's body as vet402
 * delivered it, with vet402's verdict and both tx ids (x-vet402-* headers). No refunds.
 */
export async function buyThrough(targetUrl: string, opts: BuyOptions): Promise<BuyResult> {
  if (!targetUrl || typeof targetUrl !== "string") throw new CheckError("targetUrl is required");
  const { scheme, network } = payingScheme(opts);
  const method = opts.method ?? "GET";
  if (method !== "GET" && method !== "POST") throw new CheckError(`method must be GET or POST, got ${String(method)}`);
  const body = method === "POST" ? (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? {})) : undefined;
  const init = (timeoutMs: number): RequestInit => ({
    method,
    redirect: "error", // a redirect could point the payment request somewhere else
    signal: AbortSignal.timeout(timeoutMs),
    ...(body !== undefined ? { body, headers: { "content-type": "application/json" } } : {}),
  });
  const url = buyUrl(opts.vet402Url ?? VET402_DEFAULT_URL, targetUrl);
  const baseFetch = opts.fetchImpl ?? fetch;
  const maxAtomic = usdcToAtomic(opts.maxPriceUsdc ?? VET402_DEFAULT_MAX_BUY_USDC);
  const net = NETWORKS[network];

  // 1) Free quote: nothing is signed.
  let free: Response;
  let freeText: string;
  try {
    free = await baseFetch(url, init(FREE_READ_TIMEOUT_MS));
    freeText = (await readCappedBytes(free, MAX_ANSWER_BYTES)).toString("utf8");
  } catch (e) {
    throw new CheckError(`vet402 could not be reached: ${(e as Error).message ?? String(e)}`);
  }
  let freeBody: Record<string, unknown> = {};
  try {
    freeBody = freeText ? (JSON.parse(freeText) as Record<string, unknown>) : {};
  } catch {
    /* keep empty */
  }
  if (free.status !== 402) {
    return { paid: false, httpStatus: free.status, refusal: { reason: String(freeBody.reason ?? freeBody.error ?? `HTTP ${free.status}`), detail: freeBody.detail as string | undefined } };
  }
  const quote = freeBody.buy as BuyResult["quote"];
  const totalRaw = quote?.total?.amountAtomic;
  if (!totalRaw || !/^\d+$/.test(totalRaw)) throw new CheckError("vet402's 402 has no buy.total price");
  const total = BigInt(totalRaw);

  // The address vet402 asks to be paid at, from the free 402's requirements. The payment is locked to it.
  let accepts: Array<{ scheme?: string; network?: string; asset?: unknown; amount?: unknown; payTo?: string; extra?: Record<string, unknown> }> = [];
  try {
    const pr = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((n) => free.headers.get(n), freeBody);
    accepts = (pr.accepts ?? []) as typeof accepts;
  } catch {
    throw new CheckError("vet402's 402 has no readable payment requirements");
  }
  const ours = accepts.find((a) => a.scheme === "exact" && sameNetwork(String(a.network), net.caip2) && String(a.asset) === net.usdc && String(a.amount) === totalRaw);
  if (!ours?.payTo) throw new CheckError(`vet402's 402 has no exact USDC requirement of ${totalRaw} on ${network}`);
  const sellerAddresses = [quote?.sellerPrice?.payTo, ours.extra?.sellerPayTo].filter((a): a is string => typeof a === "string" && a.length > 0);
  if (sellerAddresses.includes(ours.payTo)) {
    throw new CheckError("vet402's 402 asks to be paid at the seller's address (a purchase through vet402 pays vet402, never the seller directly). Nothing was paid.");
  }
  if (isDefaultVet402(opts.vet402Url) && network === "mainnet" && ours.payTo !== VET402_MAINNET_PAY_TO) {
    throw new CheckError(`vet402's 402 asks to be paid at ${ours.payTo}, not vet402's MainNet address ${VET402_MAINNET_PAY_TO}. Nothing was paid.`);
  }
  if (total > maxAtomic) {
    return { paid: false, httpStatus: 402, quote, refusal: { reason: "price_above_max", detail: `total ${quote?.total?.usdc} USDC is above maxPriceUsdc ${opts.maxPriceUsdc ?? VET402_DEFAULT_MAX_BUY_USDC}` } };
  }

  // 2) Pay at most the quoted total, only to the address the free 402 named, never to the seller's.
  const { client, state } = makeCheckClient(scheme, network, total, { payTo: ours.payTo, notPayTo: sellerAddresses });
  let res: Response;
  try {
    res = await wrapFetchWithPayment(baseFetch, client)(url, init(PAID_TIMEOUT_MS));
  } catch (e) {
    throw new CheckError(`vet402 purchase failed before an answer: ${(e as Error).message ?? String(e)}`, undefined, state.signed > 0);
  }
  if (res.status === 402) {
    throw new CheckError("vet402 did not accept the payment (the price may have changed; ask again)", 402, state.signed > 0);
  }
  // From here a payment may have settled: every failure says so.
  try {
    const h = (n: string) => res.headers.get(n) ?? undefined;
    const bytes = await readCappedBytes(res, MAX_ANSWER_BYTES);
    const contentType = res.headers.get("content-type");
    const text = isTextType(contentType);
    let customerTx = h("x-vet402-customer-tx");
    if (!customerTx) {
      try {
        const st = new x402HTTPClient(client).getPaymentSettleResponse((n) => res.headers.get(n));
        if (st.success) customerTx = st.transaction;
      } catch {
        /* no settle header */
      }
    }
    return {
      paid: true,
      httpStatus: res.status,
      quote,
      verdict: h("x-vet402-verdict"),
      reason: h("x-vet402-reason"),
      customerTx,
      sellerTx: h("x-vet402-seller-tx"),
      sellerStatus: h("x-vet402-seller-status"),
      contentType,
      body: text ? bytes.toString("utf8") : bytes.toString("base64"),
      bodyEncoding: text ? "utf8" : "base64",
    };
  } catch (e) {
    throw new CheckError(`vet402 answered HTTP ${res.status}, but the answer could not be read: ${(e as Error).message ?? String(e)}`, res.status, state.signed > 0);
  }
}

/** Read a response body, failing once it passes `max` bytes. */
async function readCappedBytes(res: Response, max: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`answer above ${max} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
