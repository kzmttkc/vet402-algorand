import { config as loadDotenv } from "dotenv";
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
} from "@x402/avm";

loadDotenv({ quiet: true });

export type NetworkName = "testnet" | "mainnet";

/** USDC has 6 decimals on Algorand. 1 USDC = 1_000_000 atomic units. */
export const USDC_DECIMALS = 6;

export function usdcToAtomic(usdc: string | number): bigint {
  const s = typeof usdc === "number" ? usdc.toFixed(USDC_DECIMALS) : usdc.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid USDC amount: ${usdc}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > USDC_DECIMALS) throw new Error(`too many decimals: ${usdc}`);
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, "0"));
}

export function atomicToUsdc(atomic: bigint): string {
  const neg = atomic < 0n;
  const a = neg ? -atomic : atomic;
  const whole = a / 10n ** BigInt(USDC_DECIMALS);
  const frac = (a % 10n ** BigInt(USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export interface AppConfig {
  networkName: NetworkName;
  network: string; // CAIP-2
  usdcAsaId: string;
  facilitatorUrl: string;
  port: number;
  /** Price the customer pays vet402 per check, in USDC (e.g. "0.05"). */
  checkPriceUsdc: string;
  /** Hard cap vet402 will pay one downstream seller per check (atomic USDC). */
  maxPerCallAtomic: bigint;
  /** Hard cap vet402 will pay downstream sellers per UTC day (atomic USDC). */
  maxPerDayAtomic: bigint;
  /** Allow probing localhost / private IPs (local TestNet demo only). */
  allowPrivateTargets: boolean;
  /** Tag put into accepts[].extra for the Algorand x402 Global Challenge. */
  challengeTag: string;
  keysFile: string;
  spendLedgerFile: string;
  probeTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const networkName = (env.X402_NETWORK ?? "testnet").toLowerCase();
  if (networkName !== "testnet" && networkName !== "mainnet") {
    throw new Error(`X402_NETWORK must be testnet or mainnet, got ${networkName}`);
  }
  if (networkName === "mainnet" && env.I_UNDERSTAND_MAINNET_MOVES_REAL_FUNDS !== "yes") {
    throw new Error(
      "MainNet is locked. Set I_UNDERSTAND_MAINNET_MOVES_REAL_FUNDS=yes only after owner approval.",
    );
  }
  const isMain = networkName === "mainnet";
  const maxPerCall = usdcToAtomic(env.PROBE_MAX_PER_CALL_USDC ?? "0.04");
  const checkPrice = env.CHECK_PRICE_USDC ?? "0.05";
  if (maxPerCall > usdcToAtomic(checkPrice)) {
    // vet402 must never pay a seller more than the customer paid vet402.
    throw new Error("PROBE_MAX_PER_CALL_USDC must not exceed CHECK_PRICE_USDC");
  }
  return {
    networkName,
    network: isMain ? ALGORAND_MAINNET_CAIP2 : ALGORAND_TESTNET_CAIP2,
    usdcAsaId: String(isMain ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID),
    facilitatorUrl: env.FACILITATOR_URL ?? "https://facilitator.goplausible.xyz",
    port: Number(env.PORT ?? 4021),
    checkPriceUsdc: checkPrice,
    maxPerCallAtomic: maxPerCall,
    maxPerDayAtomic: usdcToAtomic(env.PROBE_MAX_PER_DAY_USDC ?? "1.00"),
    allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === "1",
    challengeTag: "x402-global-challenge",
    keysFile: env.KEYS_FILE ?? `.keys/${networkName}.json`,
    spendLedgerFile: env.SPEND_LEDGER_FILE ?? `state/spend-${networkName}.json`,
    probeTimeoutMs: Number(env.PROBE_TIMEOUT_MS ?? 20000),
  };
}
