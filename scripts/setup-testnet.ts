/**
 * One-shot TestNet preparation, idempotent. Needs only the CLIENT account funded:
 *   step A (after ALGO arrives at client): client sends ALGO to vet402/seller, all three opt in to USDC
 *   step B (after USDC arrives at client): client sends USDC to vet402 so it can pay sellers
 * TestNet only. Prints addresses and tx ids, never keys.
 */
import { AlgorandClient, algo } from "@algorandfoundation/algokit-utils";
import { loadConfig, usdcToAtomic } from "../src/config.js";
import { loadKeys, type Role } from "../src/keys.js";
import { accountState } from "./balances.js";

const cfg = loadConfig();
if (cfg.networkName !== "testnet") throw new Error("setup:testnet runs on TestNet only");
const keys = loadKeys(cfg.keysFile);
const algorand = AlgorandClient.testNet();
const acct = Object.fromEntries(
  (["client", "vet402", "seller"] as Role[]).map((r) => [r, algorand.account.fromMnemonic(keys[r].mnemonic)]),
) as Record<Role, ReturnType<typeof algorand.account.fromMnemonic>>;
const asa = BigInt(cfg.usdcAsaId);
const ALGO_TOPUP = 0.5; // ALGO per non-client account (min balance 0.1 + opt-in 0.1 + margin)
const VET402_USDC = usdcToAtomic(process.env.VET402_USDC ?? "1.00");

const client = await accountState(keys.client.address, cfg.usdcAsaId);
if (client.microAlgo < 1_500_000n) {
  console.log(`client has ${Number(client.microAlgo) / 1e6} ALGO; need >= 1.5. Fund ${keys.client.address} first.`);
  process.exit(3);
}
for (const role of ["vet402", "seller"] as Role[]) {
  const s = await accountState(keys[role].address, cfg.usdcAsaId);
  if (s.microAlgo < 300_000n) {
    const r = await algorand.send.payment({ sender: acct.client.addr, receiver: acct[role].addr, amount: algo(ALGO_TOPUP) });
    console.log(`ALGO ${ALGO_TOPUP} -> ${role}: ${r.txIds[0]}`);
  }
}
for (const role of ["client", "vet402", "seller"] as Role[]) {
  const s = await accountState(keys[role].address, cfg.usdcAsaId);
  if (!s.optedIn) {
    const r = await algorand.send.assetOptIn({ sender: acct[role].addr, assetId: asa });
    console.log(`USDC opt-in ${role}: ${r.txIds[0]}`);
  }
}
const c2 = await accountState(keys.client.address, cfg.usdcAsaId);
const v2 = await accountState(keys.vet402.address, cfg.usdcAsaId);
if (v2.usdcAtomic < VET402_USDC / 2n) {
  if (c2.usdcAtomic < VET402_USDC + usdcToAtomic("0.20")) {
    console.log(`client has ${Number(c2.usdcAtomic) / 1e6} USDC; get TestNet USDC to ${keys.client.address} (Circle faucet), then rerun.`);
    process.exit(4);
  }
  const r = await algorand.send.assetTransfer({ sender: acct.client.addr, receiver: acct.vet402.addr, assetId: asa, amount: VET402_USDC });
  console.log(`USDC ${Number(VET402_USDC) / 1e6} -> vet402: ${r.txIds[0]}`);
}
console.log("TestNet setup complete.");
