/**
 * Customer role (TestNet only): buy one x402 resource through vet402 (GET /v1/buy) and print
 * the free price, the verdict headers, the body exactly as delivered, and the confirmed round
 * of both payments (read from the indexer): the customer's payment must come first.
 *
 *   npx tsx scripts/buy-demo.ts http://localhost:4031/honest
 */
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactAvmScheme, toClientAvmSigner } from "@x402/avm";
import { loadConfig, usdcToAtomic } from "../src/config.js";
import { loadKeys, secretKeyB64FromMnemonic } from "../src/keys.js";
import { makeCheckClient } from "../src/check-client.js";

const cfg = loadConfig();
if (cfg.networkName !== "testnet") throw new Error("buy-demo pays as the TestNet client only");
const keys = loadKeys(cfg.keysFile);
const target = process.argv[2];
if (!target) throw new Error("usage: npx tsx scripts/buy-demo.ts <x402 URL>");
const vet402 = process.env.VET402_URL ?? `http://localhost:${cfg.port}`;
const url = `${vet402}/v1/buy?url=${encodeURIComponent(target)}`;

async function txRound(tx: string | null): Promise<{ round: number; offset: number } | null> {
  if (!tx) return null;
  for (let i = 0; i < 15; i++) {
    const r = await fetch(`${cfg.indexerUrl}/v2/transactions/${tx}`);
    if (r.ok) {
      const t = ((await r.json()) as { transaction: { "confirmed-round": number; "intra-round-offset"?: number } }).transaction;
      return { round: t["confirmed-round"], offset: t["intra-round-offset"] ?? 0 };
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  return null;
}

// 1) Free price (no payment).
const free = await fetch(url);
const quote = ((await free.json()) as { buy?: { sellerPrice: { usdc: string }; fee: { usdc: string }; total: { usdc: string } }; reason?: string; detail?: string });
if (free.status !== 402) {
  console.log(`free price        HTTP ${free.status}  refused: ${quote.reason} (${quote.detail})  nothing charged`);
  process.exit(0);
}
console.log(`free price        HTTP 402  seller ${quote.buy?.sellerPrice.usdc} + fee ${quote.buy?.fee.usdc} = ${quote.buy?.total.usdc} USDC`);

// 2) Pay and buy.
const scheme = new ExactAvmScheme(toClientAvmSigner(secretKeyB64FromMnemonic(keys.client.mnemonic)), { algorandClient: AlgorandClient.testNet() });
const { client } = makeCheckClient(scheme, "testnet", usdcToAtomic(process.env.CUSTOMER_MAX_USDC ?? "0.10"));
const res = await wrapFetchWithPayment(fetch, client)(url, { method: "GET" });
const body = await res.text();
const h = (n: string) => res.headers.get(n);
console.log(`HTTP ${res.status}  content-type ${h("content-type")}`);
console.log(`verdict           ${h("x-vet402-verdict")}  reason=${h("x-vet402-reason")}`);
console.log(`body              ${body.length > 300 ? `${body.slice(0, 300)}...` : body}`);
const c = await txRound(h("x-vet402-customer-tx"));
const s = await txRound(h("x-vet402-seller-tx"));
console.log(`customer -> vet402  ${h("x-vet402-customer-tx")}  round ${c?.round}`);
const after = c && s ? (c.round < s.round || (c.round === s.round && c.offset < s.offset) ? "  (after customer)" : "  (NOT after customer)") : "";
console.log(`vet402 -> seller    ${h("x-vet402-seller-tx") ?? "(not paid)"}${s ? `  round ${s.round}` : ""}${after}`);
