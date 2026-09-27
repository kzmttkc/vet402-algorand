/** Run one probe as vet402 directly (no customer payment). Useful for cap checks and debugging. */
import { loadConfig } from "../src/config.js";
import { loadPayer } from "../src/keys.js";
import { LocalSpendGuard } from "../src/spend.js";
import { SpendLedger } from "../src/caps.js";
import { makePaidFetch, probe } from "../src/probe.js";

const cfg = loadConfig();
const payer = loadPayer(cfg.networkName, cfg.keysFile);
const target = process.argv[2];
if (!target) throw new Error("usage: tsx scripts/probe-once.ts <x402 URL>");
const ledger = new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic, cfg.spendLedgerFile);
const r = await probe(target, cfg, new LocalSpendGuard(ledger), {
  fetchImpl: (u, i) => fetch(u, i),
  paidFetch: makePaidFetch(cfg, payer.secretKeyB64),
  ownAddresses: [payer.address],
});
console.log(JSON.stringify(r, null, 2));
