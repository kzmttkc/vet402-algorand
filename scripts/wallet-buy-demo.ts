/**
 * TestNet only: runs the /try wallet purchase (src/web/pay.ts, the code the page bundles) with a
 * TestNet key in place of Pera / Lute, against a local vet402 (npm run server) and test sellers.
 *
 *   npx tsx scripts/wallet-buy-demo.ts <x402 URL> [--fresh]
 *
 * --fresh: make a new TestNet account (funded from the keys file's client: 0.3 ALGO, USDC opt-in,
 * 0.05 USDC) so the first purchase is at cost, then buy twice: first at cost, then at the normal price.
 * Prints each price, the verdict, and the confirmed round of the customer's and the seller's payment.
 */
import { randomBytes } from "node:crypto";
import { AlgorandClient, algo } from "@algorandfoundation/algokit-utils";
import { mnemonicFromSeed } from "@algorandfoundation/algokit-utils/algo25";
import { toClientAvmSigner } from "@x402/avm";
import { loadConfig } from "../src/config.js";
import { loadKeys, secretKeyB64FromMnemonic } from "../src/keys.js";
import { payAndBuy, TRY_MAX_SELLER_ATOMIC } from "../src/web/pay.js";

const cfg = loadConfig();
if (cfg.networkName !== "testnet") throw new Error("wallet-buy-demo runs on TestNet only");
const target = process.argv[2];
if (!target) throw new Error("usage: npx tsx scripts/wallet-buy-demo.ts <x402 URL> [--fresh]");
const base = process.env.VET402_URL ?? `http://localhost:${cfg.port}`;
const keys = loadKeys(cfg.keysFile);
const algorand = AlgorandClient.testNet();

let mnemonic = keys.client.mnemonic;
if (process.argv.includes("--fresh")) {
  mnemonic = mnemonicFromSeed(randomBytes(32));
  const client = algorand.account.fromMnemonic(keys.client.mnemonic);
  const fresh = algorand.account.fromMnemonic(mnemonic);
  await algorand.send.payment({ sender: client.addr, receiver: fresh.addr, amount: algo(0.3) });
  await algorand.send.assetOptIn({ sender: fresh.addr, assetId: BigInt(cfg.usdcAsaId) });
  await algorand.send.assetTransfer({ sender: client.addr, receiver: fresh.addr, assetId: BigInt(cfg.usdcAsaId), amount: 50_000n });
  console.log(`fresh TestNet account ${fresh.addr} funded (0.3 ALGO, 0.05 USDC)`);
}
const signer = toClientAvmSigner(secretKeyB64FromMnemonic(mnemonic));

async function round(tx?: string) {
  if (!tx) return null;
  for (let i = 0; i < 15; i++) {
    const r = await fetch(`${cfg.indexerUrl}/v2/transactions/${tx}`);
    if (r.ok) return ((await r.json()) as { transaction: { "confirmed-round": number } }).transaction["confirmed-round"];
    await new Promise((res) => setTimeout(res, 2000));
  }
  return null;
}

for (const n of process.argv.includes("--fresh") ? [1, 2] : [1]) {
  // What the page does: read the free 402 for this payer, show the total, then pay exactly that.
  const q = await fetch(`${base}/v1/buy?url=${encodeURIComponent(target)}&payer=${signer.address}`, { headers: { accept: "application/json" } });
  const info = ((await q.json()) as { buy?: { total: { amountAtomic: string; usdc: string }; fee: { amountAtomic: string; usdc: string }; firstPurchase?: unknown } }).buy;
  if (q.status !== 402 || !info) throw new Error(`no price: HTTP ${q.status}`);
  console.log(`purchase ${n}: shown total ${info.total.usdc} USDC (fee ${info.fee.usdc}${info.firstPurchase ? ", first purchase at cost" : ""})`);
  const r = await payAndBuy(signer, { vet402Base: base, target, network: "testnet", expectedTotalAtomic: info.total.amountAtomic, maxTotalAtomic: TRY_MAX_SELLER_ATOMIC + BigInt(info.fee.amountAtomic), payer: signer.address });
  const [c, s] = [await round(r.customerTx), await round(r.sellerTx)];
  console.log(`  HTTP ${r.status} verdict ${r.verdict} (${r.reason}) body ${r.bodyText.slice(0, 80)}`);
  console.log(`  customer -> vet402 ${r.customerTx} round ${c}`);
  console.log(`  vet402 -> seller   ${r.sellerTx} round ${s}${c && s ? (c < s ? "  (after the customer's)" : "  (NOT after)") : ""}`);
}
