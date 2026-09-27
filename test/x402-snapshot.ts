/**
 * The unpaid 402 of every paid route, from the real app with a fake facilitator, seller and Bazaar.
 * Used by base-accept.test.ts: with BASE_ACCEPT off the result must equal the golden file taken from
 * the code before Base existed (test/fixtures/x402-402-off.json, from e563b4c).
 * Imports only modules that existed at e563b4c, so the same file produces the golden there.
 */
import { join } from "node:path";
import { ALGORAND_TESTNET_CAIP2 } from "@x402/avm";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { SpendLedger } from "../src/caps.js";
import { LocalSpendGuard } from "../src/spend.js";
import type { ProbeDeps } from "../src/probe.js";

export const SNAP_VET402 = "VETPAYTOVETPAYTOVETPAYTOVETPAYTOVETPAYTOVETPAYTOVETPAYTOVE";
export const SNAP_SELLER = "SELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELL";
const NET = ALGORAND_TESTNET_CAIP2;
const ASA = "10458941";
const HOST = "http://localhost:4031";
export const SNAP_VERDICT_URL =
  "https://api.algorand-indexer.xyz/v2/accounts/X4O2W7XDNXAMPWAURGGL4VDJMZTCO2EDOH7NPWBKFBKOTJQVPUYR5FRAMI?address=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export const SNAP_REQUESTS: Array<[string, string]> = [
  ["GET", `/v1/check?url=${encodeURIComponent(`${HOST}/honest`)}`],
  ["HEAD", `/v1/check?url=${encodeURIComponent(`${HOST}/honest`)}`],
  ["GET", `/v1/audit?seller=${encodeURIComponent("localhost:4031")}`],
  ["GET", `/v1/verdict?url=${encodeURIComponent(SNAP_VERDICT_URL)}`],
  ["GET", `/v1/buy?url=${encodeURIComponent(`${HOST}/honest`)}`],
  ["POST", `/v1/buy?url=${encodeURIComponent(`${HOST}/honest`)}`],
];

/** Supports Algorand TestNet and both Base networks (the Algorand requirements do not depend on the extra kinds). */
export function snapFacilitator(trace: string[] = [], settleOk = true): FacilitatorClient {
  return {
    async getSupported() {
      return {
        kinds: [
          { x402Version: 2, scheme: "exact", network: NET as `${string}:${string}`, extra: { feePayer: "FEEPAYER" } },
          { x402Version: 2, scheme: "exact", network: "eip155:84532" },
          { x402Version: 2, scheme: "exact", network: "eip155:8453" },
        ],
        extensions: [],
        signers: {},
      };
    },
    async verify(p, req) {
      trace.push(`verify ${req.network} ${req.amount} ${req.payTo}`);
      return { isValid: true, payer: "CUSTOMER" };
    },
    async settle(p, req) {
      trace.push(`settle ${req.network} ${req.amount} ${req.payTo}`);
      return settleOk
        ? { success: true, transaction: `CUSTOMER_TX_${req.network}`, network: req.network, payer: "CUSTOMER" }
        : { success: false, errorReason: "insufficient_funds", transaction: "", network: req.network };
    },
  };
}

const sellerAccept = (amount: string) => ({ scheme: "exact", network: NET, asset: ASA, amount, payTo: SNAP_SELLER, maxTimeoutSeconds: 60, extra: {} });

export function snapSellerDeps(trace: string[] = []): ProbeDeps {
  const pr = (path: string) => ({
    x402Version: 2,
    resource: { url: `${HOST}${path}`, description: "Tokyo forecast", mimeType: "application/json" },
    accepts: [sellerAccept("10000")],
    extensions: { bazaar: { info: { output: { type: "json", example: { forecast: "sunny", temperature: 21 } } } } },
  });
  return {
    ownAddresses: [SNAP_VET402],
    fetchImpl: async (url) => {
      trace.push(`look ${new URL(url).pathname}`);
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr(new URL(url).pathname))).toString("base64") } });
    },
    paidFetch: async (url) => {
      if (!trace.some((t) => t.startsWith("settle"))) throw new Error("seller paid before the customer's payment settled");
      trace.push(`pay ${new URL(url).pathname}`);
      return {
        response: new Response(JSON.stringify({ forecast: "sunny", temperature: 21 }), { status: 200, headers: { "content-type": "application/json" } }),
        settle: { success: true, transaction: "SELLER_TX", network: NET },
        signed: true,
      };
    },
  };
}

export const snapCatalog = {
  async items() {
    return [{ resourceUrl: `${HOST}/honest`, method: "GET", accepts: [sellerAccept("10000")], settleCount: 3 }];
  },
};

export function snapApp(env: NodeJS.ProcessEnv = {}, trace: string[] = [], settleOk = true) {
  process.env.BOARD_FILE = join(import.meta.dirname, "fixtures", "board-snap", "latest.json");
  process.env.BOARD_REMOTE = "off";
  const cfg = loadConfig({ ALLOW_PRIVATE_TARGETS: "1", ...env });
  const guard = new LocalSpendGuard(new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic));
  const app = createApp(cfg, { payTo: SNAP_VET402, probeDeps: snapSellerDeps(trace), guard, facilitator: snapFacilitator(trace, settleOk), catalog: snapCatalog });
  return { cfg, app, trace };
}

export interface Snap {
  status: number;
  paymentRequired: unknown;
  body: unknown;
}

export async function snapshot402s(env: NodeJS.ProcessEnv = {}): Promise<Record<string, Snap>> {
  const { app } = snapApp(env);
  const out: Record<string, Snap> = {};
  for (const [method, path] of SNAP_REQUESTS) {
    const init: RequestInit = method === "POST" ? { method, headers: { "content-type": "application/json" }, body: "{}" } : { method };
    const res = await app.request(path, init);
    const h = res.headers.get("PAYMENT-REQUIRED");
    const text = await res.text();
    out[`${method} ${path}`] = { status: res.status, paymentRequired: h ? JSON.parse(Buffer.from(h, "base64").toString()) : null, body: text ? JSON.parse(text) : null };
  }
  return out;
}

// `npx tsx test/x402-snapshot.ts > file`: print the snapshot with BASE_ACCEPT unset.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  snapshot402s().then((s) => process.stdout.write(`${JSON.stringify(s, null, 1)}\n`));
}
