/**
 * Customer role (TestNet only): pay vet402 for one seller audit and print the
 * verdict per resource, both tx ids, and the confirmed round of every payment
 * (read from the indexer) so the order can be checked: the customer's payment
 * must come before every seller payment.
 *
 *   npx tsx scripts/audit-demo.ts <seller host or payTo>
 */
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactAvmScheme, toClientAvmSigner } from "@x402/avm";
import { loadConfig, usdcToAtomic } from "../src/config.js";
import { loadKeys, secretKeyB64FromMnemonic } from "../src/keys.js";
import { makeCheckClient } from "../src/check-client.js";

const cfg = loadConfig();
if (cfg.networkName !== "testnet") throw new Error("audit-demo pays as the TestNet client only");
const keys = loadKeys(cfg.keysFile);
const seller = process.argv[2];
if (!seller) throw new Error("usage: npx tsx scripts/audit-demo.ts <seller host or payTo>");
const vet402 = process.env.VET402_URL ?? `http://localhost:${cfg.port}`;
const url = `${vet402}/v1/audit?seller=${encodeURIComponent(seller)}`;

async function roundOf(tx: string | undefined): Promise<number | null> {
  if (!tx) return null;
  for (let i = 0; i < 15; i++) {
    const r = await fetch(`${cfg.indexerUrl}/v2/transactions/${tx}`);
    if (r.ok) return ((await r.json()) as { transaction: { "confirmed-round": number } }).transaction["confirmed-round"];
    await new Promise((res) => setTimeout(res, 2000));
  }
  return null;
}

// 1) Free plan (no payment).
const free = await fetch(url);
const plan = ((await free.json()) as { audit?: { found: number; checking: number; paying: number; plannedSpendUsdc: string; note: string } }).audit;
console.log(`free plan         HTTP ${free.status}  found=${plan?.found} checking=${plan?.checking} paying=${plan?.paying} planned=${plan?.plannedSpendUsdc} USDC`);
if (free.status !== 402) process.exit(1);

// 2) Pay and run.
const scheme = new ExactAvmScheme(toClientAvmSigner(secretKeyB64FromMnemonic(keys.client.mnemonic)), { algorandClient: AlgorandClient.testNet() });
const { client } = makeCheckClient(scheme, "testnet", usdcToAtomic(process.env.CUSTOMER_MAX_USDC ?? cfg.auditPriceUsdc));
const res = await wrapFetchWithPayment(fetch, client)(url, { method: "GET" });
const body = (await res.json()) as {
  customerPayment?: { transaction?: string };
  summary?: Record<string, unknown>;
  results?: { resourceUrl: string; verdict: string; reason: string; class: string; downstreamPayment?: { transaction?: string } }[];
};
console.log(`HTTP ${res.status}`);
const customerTx = body.customerPayment?.transaction;
const customerRound = await roundOf(customerTx);
console.log(`customer -> vet402  ${customerTx ?? "(none)"}  round ${customerRound}`);
for (const r of body.results ?? []) {
  const tx = r.downstreamPayment?.transaction;
  const round = await roundOf(tx);
  const order = round === null ? "" : customerRound !== null && customerRound < round ? "  (after customer)" : "  (NOT after customer)";
  console.log(`${r.verdict.padEnd(7)} ${r.reason.padEnd(22)} ${r.class.padEnd(9)} ${r.resourceUrl}  seller tx ${tx ?? "(not paid)"}${round !== null ? `  round ${round}` : ""}${order}`);
}
console.log(`summary ${JSON.stringify(body.summary)}`);
