/** Types for the plain-JS CLI (bin/vet402-cert.mjs), used by the tests. */
export declare const DEFAULT_URL: string;
export declare const MAINNET_PAY_TO: string;
export declare const NETWORKS: Record<"mainnet" | "testnet", { caip2: string; usdc: string }>;
export declare function usdcToAtomic(s: string): bigint;
export declare function parseArgs(argv: string[]): { seller: string | undefined; yes: boolean; help: boolean };
export declare function allowedRequirement(
  r: { scheme: string; network: string; asset: string; amount: string; payTo: string },
  o: { network: string; maxAtomic: bigint; payTo?: string },
): boolean;
export declare function payToLock(vet402Url: string, network: string): string | undefined;
