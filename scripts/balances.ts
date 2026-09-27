/** Print ALGO / USDC balances and USDC opt-in state of the TestNet accounts (addresses only). */
import { loadConfig } from "../src/config.js";
import { loadKeys, type Role } from "../src/keys.js";

const cfg = loadConfig();
const keys = loadKeys(cfg.keysFile);
const ALGOD = cfg.networkName === "mainnet" ? "https://mainnet-api.algonode.cloud" : "https://testnet-api.algonode.cloud";

export async function accountState(address: string, asaId: string) {
  const r = await fetch(`${ALGOD}/v2/accounts/${address}`);
  if (!r.ok) throw new Error(`algod ${r.status} for ${address}`);
  const a = (await r.json()) as { amount: number; assets?: { "asset-id": number; amount: number }[] };
  const usdc = a.assets?.find((x) => String(x["asset-id"]) === asaId);
  return { microAlgo: BigInt(a.amount), optedIn: !!usdc, usdcAtomic: BigInt(usdc?.amount ?? 0) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const role of ["client", "vet402", "seller"] as Role[]) {
    const s = await accountState(keys[role].address, cfg.usdcAsaId);
    console.log(`${role.padEnd(7)} ${keys[role].address}  ALGO=${Number(s.microAlgo) / 1e6}  USDC=${s.optedIn ? Number(s.usdcAtomic) / 1e6 : "not opted in"}`);
  }
}
