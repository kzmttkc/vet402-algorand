/**
 * The MCP tools, as plain functions (tested without a transport).
 */
import { z } from "zod";
import {
  buyThrough,
  checkBeforeBuy,
  CheckError,
  VET402_DEFAULT_URL,
  VET402_DEFAULT_MAX_USDC,
  VET402_DEFAULT_MAX_BUY_USDC,
  type CheckNetwork,
} from "../../src/check-client.js";
import { secretKeyB64FromMnemonic } from "../../src/keys.js";
import { algorandEndpoints, cachedResources, BAZAAR_DEFAULT_URL, type NetworkFilter } from "./bazaar.js";

export interface ToolResult {
  [k: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export const CHECK_TOOL = {
  name: "vet402_check",
  config: {
    title: "Check an x402 endpoint with vet402 before buying (paid: 0.05 USDC)",
    description:
      "PAID TOOL: each call pays 0.05 USDC on Algorand (MainNet by default) from the wallet in the ALGORAND_MNEMONIC environment variable to vet402. " +
      "After your payment settles, vet402 buys the given x402 endpoint once with its own funds, compares what it delivered with what it declared " +
      "(Bazaar schema / 402 accepts), and returns ALLOW or REFUSE with a reason, the tx id of your payment to vet402, the tx id of vet402's payment " +
      "to the seller, and a summary of the delivery. Use it before paying an unfamiliar x402 endpoint yourself. " +
      "Requests vet402 refuses up front (invalid URL, its daily cap reached) return REFUSE without charging you. " +
      "Env: ALGORAND_MNEMONIC (required), VET402_NETWORK=mainnet|testnet (default mainnet), VET402_URL (default " +
      `${VET402_DEFAULT_URL}), VET402_MAX_PRICE_USDC (default ${VET402_DEFAULT_MAX_USDC}; the call refuses to pay more).`,
    inputSchema: { url: z.string().url().describe("The x402 endpoint (https) you are considering buying from") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
};

export const BUY_TOOL = {
  name: "vet402_buy",
  config: {
    title: "Buy an x402 resource through vet402 (paid: the seller's price + 0.005 USDC)",
    description:
      "PAID TOOL: pays the seller's price + 0.005 USDC (vet402's fee) on Algorand (MainNet by default) from the wallet in the ALGORAND_MNEMONIC " +
      "environment variable to vet402. First it reads the price for free (vet402's unpaid 402) and pays only if the total is at most " +
      `VET402_MAX_BUY_USDC (default ${VET402_DEFAULT_MAX_BUY_USDC}); otherwise nothing is paid and the price is returned. After your payment settles, ` +
      "vet402 pays the seller with its own wallet and returns the seller's response body as delivered, with vet402's verdict (ALLOW, or REFUSE when " +
      "the delivery does not match what the seller declared), the reason, the tx id of your payment to vet402 and of vet402's payment to the seller. " +
      "It signs only a payment to the address named in vet402's free 402 (with the default VET402_URL on MainNet: vet402's own address), never to the seller directly. " +
      "There are no refunds: if the seller cannot be paid after your payment settled, you get the reason and your tx id. Sellers vet402 will not buy " +
      "(above its per-call cap, not USDC on Algorand, private addresses) are refused before any payment. " +
      "Env: ALGORAND_MNEMONIC (required), VET402_NETWORK=mainnet|testnet (default mainnet), VET402_URL (default " +
      `${VET402_DEFAULT_URL}), VET402_MAX_BUY_USDC (default ${VET402_DEFAULT_MAX_BUY_USDC}).`,
    inputSchema: {
      url: z.string().url().describe("The x402 endpoint (https) to buy from"),
      method: z.enum(["GET", "POST"]).optional().describe("Request to the seller (default GET)"),
      body: z.unknown().optional().describe("POST only: the JSON body for the seller (a JSON value, or a JSON string)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
};

export const ENDPOINTS_TOOL = {
  name: "algorand_x402_endpoints",
  config: {
    title: "List Algorand x402 endpoints (free)",
    description:
      "Free, no payment. Lists x402 endpoints from the Bazaar discovery feed (facilitator.goplausible.xyz) that accept payment on an Algorand network, " +
      "with URL, method, description, price and settle count, most-settled first. Filter by a text query over URL and description.",
    inputSchema: {
      query: z.string().optional().describe("Case-insensitive text to match in the URL or description"),
      network: z.enum(["mainnet", "testnet", "any"]).optional().describe("Algorand network (default any)"),
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
};

/** The paying wallet and network from the MCP server's environment, or an isError result (nothing paid). */
function payingEnv(env: NodeJS.ProcessEnv, what: string): { secretKey: string; network: CheckNetwork; vet402Url: string } | ToolResult {
  const mnemonic = env.ALGORAND_MNEMONIC?.trim();
  if (!mnemonic) {
    return text(
      `ALGORAND_MNEMONIC is not set. ${what}, so it needs the 25-word mnemonic of an Algorand wallet ` +
        "that holds USDC (ASA 31566704 on MainNet) in the MCP server's environment. Nothing was paid.",
      true,
    );
  }
  const network = (env.VET402_NETWORK ?? "mainnet").trim().toLowerCase();
  if (network !== "mainnet" && network !== "testnet") {
    return text(`VET402_NETWORK must be mainnet or testnet, got "${network}". Nothing was paid.`, true);
  }
  try {
    return { secretKey: secretKeyB64FromMnemonic(mnemonic), network, vet402Url: env.VET402_URL?.trim() || VET402_DEFAULT_URL };
  } catch {
    // Never echo the mnemonic or the decoder's message.
    return text("ALGORAND_MNEMONIC could not be decoded (expected 25 Algorand words). Nothing was paid.", true);
  }
}

export async function runCheck(args: { url: string }, env: NodeJS.ProcessEnv = process.env, deps: { fetchImpl?: typeof fetch } = {}): Promise<ToolResult> {
  const pay = payingEnv(env, "vet402_check pays 0.05 USDC per call");
  if ("content" in pay) return pay;
  const { secretKey, network } = pay;
  try {
    const r = await checkBeforeBuy(args.url, {
      secretKey,
      network,
      vet402Url: pay.vet402Url,
      maxPriceUsdc: env.VET402_MAX_PRICE_USDC?.trim() || VET402_DEFAULT_MAX_USDC,
      fetchImpl: deps.fetchImpl,
    });
    const head = `${r.verdict} ${r.reason ?? ""}`.trim();
    return text(`${head}\n${JSON.stringify(r, null, 2)}`);
  } catch (e) {
    const paid = e instanceof CheckError && e.paid ? "A payment was signed; check the wallet history." : "Nothing was paid.";
    return text(`vet402_check failed: ${(e as Error).message} ${paid}`, true);
  }
}

/** Longest seller body put into the tool result (the rest is cut, and the result says so). */
export const MAX_BUY_BODY_CHARS = 100_000;

export async function runBuy(
  args: { url: string; method?: "GET" | "POST"; body?: unknown },
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetchImpl?: typeof fetch; scheme?: Parameters<typeof buyThrough>[1]["scheme"] } = {},
): Promise<ToolResult> {
  const pay = payingEnv(env, "vet402_buy pays the seller's price + 0.005 USDC per call");
  if ("content" in pay) return pay;
  const max = env.VET402_MAX_BUY_USDC?.trim() || VET402_DEFAULT_MAX_BUY_USDC;
  try {
    const r = await buyThrough(args.url, {
      secretKey: pay.secretKey,
      network: pay.network,
      vet402Url: pay.vet402Url,
      maxPriceUsdc: max,
      method: args.method,
      body: args.body,
      fetchImpl: deps.fetchImpl,
      scheme: deps.scheme,
    });
    if (!r.paid) {
      const why = r.refusal?.reason ?? "refused";
      const price = r.quote?.total?.usdc ? ` Price: ${r.quote.total.usdc} USDC.` : "";
      return text(`NOT BOUGHT ${why}: ${r.refusal?.detail ?? ""}${price} Nothing was paid.\n${JSON.stringify(r, null, 2)}`, true);
    }
    const cut = r.body && r.body.length > MAX_BUY_BODY_CHARS;
    const out = { ...r, body: cut ? r.body!.slice(0, MAX_BUY_BODY_CHARS) : r.body, ...(cut ? { bodyTruncated: true } : {}) };
    const head = r.httpStatus === 200 ? `${r.verdict} ${r.reason ?? ""}`.trim() : `PAID, NOT DELIVERED (HTTP ${r.httpStatus}) ${r.reason ?? ""}`.trim();
    return text(`${head}\n${JSON.stringify(out, null, 2)}`, r.httpStatus !== 200);
  } catch (e) {
    const paid = e instanceof CheckError && e.paid ? "A payment was signed; check the wallet history." : "Nothing was paid.";
    return text(`vet402_buy failed: ${(e as Error).message} ${paid}`, true);
  }
}

export async function runEndpoints(
  args: { query?: string; network?: NetworkFilter; limit?: number },
  deps: { fetchImpl?: typeof fetch; bazaarUrl?: string } = {},
): Promise<ToolResult> {
  try {
    const items = await cachedResources(deps.bazaarUrl ?? process.env.BAZAAR_URL ?? BAZAAR_DEFAULT_URL, deps.fetchImpl ?? fetch);
    const all = algorandEndpoints(items, { network: args.network });
    const matched = args.query ? algorandEndpoints(items, { query: args.query, network: args.network }) : all;
    const limit = args.limit ?? 50;
    const out = {
      source: BAZAAR_DEFAULT_URL,
      feedTotal: items.length,
      algorandTotal: all.length,
      matched: matched.length,
      returned: Math.min(limit, matched.length),
      endpoints: matched.slice(0, limit),
    };
    return text(JSON.stringify(out, null, 2));
  } catch (e) {
    return text(`Could not read the Bazaar feed: ${(e as Error).message}`, true);
  }
}
