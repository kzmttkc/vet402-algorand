import { config as loadDotenv } from "dotenv";
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
} from "@x402/avm";

/**
 * Env files: `.env`, then `.env.<network>.local` (e.g. `.env.mainnet.local`, which
 * holds the MainNet payer mnemonic). Both gitignored. Real env vars always win.
 */
export function loadEnvFiles(): void {
  loadDotenv({ quiet: true });
  const net = (process.env.X402_NETWORK ?? "testnet").toLowerCase();
  loadDotenv({ path: `.env.${net}.local`, quiet: true });
}
loadEnvFiles();

/** Owner's Pera wallet: receives customer payments on MainNet (USDC opted in). */
export const MAINNET_DEFAULT_PAY_TO = "RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q";

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

/**
 * The smallest amount a customer can pay vet402: a check, or a purchase (/v1/buy) of the
 * cheapest possible seller price (1 atomic unit) plus the fee. /activity counts payments
 * from this amount up as customer payments.
 */
export function minCustomerPriceAtomic(cfg: Pick<AppConfig, "checkPriceUsdc" | "buyFeeAtomic">): bigint {
  const check = usdcToAtomic(cfg.checkPriceUsdc);
  const buy = cfg.buyFeeAtomic + 1n;
  return check < buy ? check : buy;
}

export interface AppConfig {
  networkName: NetworkName;
  network: string; // CAIP-2
  usdcAsaId: string;
  facilitatorUrl: string;
  indexerUrl: string;
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
  /** Where customers pay vet402. undefined = TestNet keys file (vet402 account). */
  payTo?: string;
  keysFile: string;
  /** Local spend ledger (backup to the indexer). undefined = in-memory only (serverless). */
  spendLedgerFile?: string;
  probeTimeoutMs: number;
  /** Show the paid re-check (/v1/audit?seller=) on /seller pages. Off until /v1/audit is live (SELLER_PAGE_AUDIT=on). */
  auditLinkEnabled: boolean;
  /** Price of one seller audit (GET /v1/audit), in USDC. */
  auditPriceUsdc: string;
  /** Most resources one audit looks at. */
  auditMaxTargets: number;
  /** Most vet402 pays sellers within one audit (atomic USDC). Always below the audit price. */
  auditMaxSpendAtomic: bigint;
  /** Wall-clock limit of one audit; the rest is SKIPPED, not paid. */
  auditDeadlineMs: number;
  /** Bazaar discovery feed the audit reads the seller's resources from. */
  bazaarUrl: string;
  /** vet402's fee on GET|POST /v1/buy (atomic USDC): the customer pays the seller's price plus this. */
  buyFeeAtomic: bigint;
}

const DEFAULT_CAPS: Record<NetworkName, { perCall: string; perDay: string }> = {
  testnet: { perCall: "0.04", perDay: "1.00" },
  mainnet: { perCall: "0.10", perDay: "3.00" },
};

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
  const caps = DEFAULT_CAPS[networkName];
  const maxPerCall = usdcToAtomic(env.PROBE_MAX_PER_CALL_USDC ?? caps.perCall);
  const maxPerDay = usdcToAtomic(env.PROBE_MAX_PER_DAY_USDC ?? caps.perDay);
  if (maxPerCall > maxPerDay) throw new Error("PROBE_MAX_PER_CALL_USDC must not exceed PROBE_MAX_PER_DAY_USDC");
  const allowPrivate = env.ALLOW_PRIVATE_TARGETS === "1";
  if (isMain && allowPrivate) throw new Error("ALLOW_PRIVATE_TARGETS=1 is not allowed on MainNet");
  const onServerless = !!env.VERCEL;
  // Validated (usdcToAtomic throws on junk) and shown short: "0.50", not "0.500000".
  const auditPrice = atomicToUsdc(usdcToAtomic(env.AUDIT_PRICE_USDC ?? "0.50")).replace(/0{1,4}$/, "");
  const auditMaxSpend = usdcToAtomic(env.AUDIT_MAX_SPEND_USDC ?? "0.40");
  if (auditMaxSpend >= usdcToAtomic(auditPrice)) throw new Error("AUDIT_MAX_SPEND_USDC must be below AUDIT_PRICE_USDC");
  // A /v1/buy payment is at most maxPerCall + fee. It must stay below the audit price, or /activity
  // (which tells an audit from a check by amount) would count a purchase as an audit.
  const buyFee = usdcToAtomic(env.BUY_FEE_USDC ?? "0.005");
  if (buyFee <= 0n) throw new Error("BUY_FEE_USDC must be above 0");
  if (maxPerCall + buyFee >= usdcToAtomic(auditPrice)) throw new Error("PROBE_MAX_PER_CALL_USDC + BUY_FEE_USDC must be below AUDIT_PRICE_USDC");
  const auditMaxTargets = Number(env.AUDIT_MAX_TARGETS ?? 10);
  if (!Number.isInteger(auditMaxTargets) || auditMaxTargets < 1 || auditMaxTargets > 50) throw new Error("AUDIT_MAX_TARGETS must be an integer 1..50");
  // The upper bound (60 s under the function limit) is checked in createApp: the limit lives in server.ts (`export const config`).
  const auditDeadlineRaw = env.AUDIT_DEADLINE_MS ?? "240000";
  const auditDeadlineMs = /^\d+$/.test(auditDeadlineRaw.trim()) ? Number(auditDeadlineRaw.trim()) : NaN;
  if (!Number.isSafeInteger(auditDeadlineMs) || auditDeadlineMs <= 0) {
    throw new Error(`AUDIT_DEADLINE_MS must be a whole number of ms, got ${auditDeadlineRaw}`);
  }
  return {
    networkName,
    network: isMain ? ALGORAND_MAINNET_CAIP2 : ALGORAND_TESTNET_CAIP2,
    usdcAsaId: String(isMain ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID),
    facilitatorUrl: env.FACILITATOR_URL ?? "https://facilitator.goplausible.xyz",
    indexerUrl: env.INDEXER_URL ?? (isMain ? "https://mainnet-idx.algonode.cloud" : "https://testnet-idx.algonode.cloud"),
    port: Number(env.PORT ?? 4021),
    checkPriceUsdc: env.CHECK_PRICE_USDC ?? "0.05",
    maxPerCallAtomic: maxPerCall,
    maxPerDayAtomic: maxPerDay,
    allowPrivateTargets: allowPrivate,
    challengeTag: "x402-global-challenge",
    payTo: env.VET402_PAY_TO ?? (isMain ? MAINNET_DEFAULT_PAY_TO : undefined),
    keysFile: env.KEYS_FILE ?? `.keys/${networkName}.json`,
    spendLedgerFile: env.SPEND_LEDGER_FILE ?? (onServerless ? undefined : `state/spend-${networkName}.json`),
    probeTimeoutMs: Number(env.PROBE_TIMEOUT_MS ?? 20000),
    auditLinkEnabled: env.SELLER_PAGE_AUDIT === "on",
    auditPriceUsdc: auditPrice,
    auditMaxTargets,
    auditMaxSpendAtomic: auditMaxSpend,
    auditDeadlineMs,
    bazaarUrl: env.BAZAAR_URL ?? "https://facilitator.goplausible.xyz/discovery/resources",
    buyFeeAtomic: buyFee,
  };
}
