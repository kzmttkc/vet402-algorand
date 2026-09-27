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
export function makeCheckClient(scheme: SchemeNetworkClient, network: CheckNetwork, maxAtomic: bigint) {
  const net = NETWORKS[network];
  const state = { signed: 0 };
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
        BigInt(r.amount) <= maxAtomic,
    ),
  );
  client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
    if (state.signed >= 1) return { abort: true, reason: "one payment per check" };
    if (BigInt(r.amount) > maxAtomic) return { abort: true, reason: "price above maxPriceUsdc" };
    return undefined;
  });
  client.onAfterPaymentCreation(async () => {
    state.signed += 1;
  });
  return { client, state };
}

/**
 * Pay vet402 to check `targetUrl` and return its verdict. vet402 pays the target
 * itself only after your payment has settled, and answers with both tx ids.
 */
export async function checkBeforeBuy(targetUrl: string, opts: CheckOptions): Promise<CheckResult> {
  if (!targetUrl || typeof targetUrl !== "string") throw new CheckError("targetUrl is required");
  const network = opts.network ?? "mainnet";
  if (!(network in NETWORKS)) throw new CheckError(`network must be mainnet or testnet, got ${String(network)}`);

  let scheme = opts.scheme;
  if (!scheme) {
    const sk = opts.secretKey?.trim() || (opts.mnemonic?.trim() ? secretKeyB64FromMnemonic(opts.mnemonic.trim()) : "");
    if (!sk) throw new CheckError("a paying key is required: pass mnemonic or secretKey");
    scheme = new ExactAvmScheme(toClientAvmSigner(sk));
  }

  const maxAtomic = usdcToAtomic(opts.maxPriceUsdc ?? VET402_DEFAULT_MAX_USDC);
  const { client, state } = makeCheckClient(scheme, network, maxAtomic);
  const baseFetch = opts.fetchImpl ?? fetch;
  const payingFetch = wrapFetchWithPayment(baseFetch, client);

  let res: Response;
  try {
    res = await payingFetch(checkUrl(opts.vet402Url ?? VET402_DEFAULT_URL, targetUrl), { method: "GET" });
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
