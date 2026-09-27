/**
 * The two MCP tools, as plain functions (tested without a transport).
 */
import { z } from "zod";
import { checkBeforeBuy, CheckError, VET402_DEFAULT_URL, VET402_DEFAULT_MAX_USDC, type CheckNetwork } from "../../src/check-client.js";
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

export async function runCheck(args: { url: string }, env: NodeJS.ProcessEnv = process.env, deps: { fetchImpl?: typeof fetch } = {}): Promise<ToolResult> {
  const mnemonic = env.ALGORAND_MNEMONIC?.trim();
  if (!mnemonic) {
    return text(
      "ALGORAND_MNEMONIC is not set. vet402_check pays 0.05 USDC per call, so it needs the 25-word mnemonic of an Algorand wallet " +
        "that holds USDC (ASA 31566704 on MainNet) in the MCP server's environment. Nothing was paid.",
      true,
    );
  }
  const network = (env.VET402_NETWORK ?? "mainnet").trim().toLowerCase();
  if (network !== "mainnet" && network !== "testnet") {
    return text(`VET402_NETWORK must be mainnet or testnet, got "${network}". Nothing was paid.`, true);
  }
  let secretKey: string;
  try {
    secretKey = secretKeyB64FromMnemonic(mnemonic);
  } catch {
    // Never echo the mnemonic or the decoder's message.
    return text("ALGORAND_MNEMONIC could not be decoded (expected 25 Algorand words). Nothing was paid.", true);
  }
  try {
    const r = await checkBeforeBuy(args.url, {
      secretKey,
      network: network as CheckNetwork,
      vet402Url: env.VET402_URL?.trim() || VET402_DEFAULT_URL,
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
