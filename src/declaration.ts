import type { Declaration } from "./verdict.js";

/**
 * Algorand CAIP-2 appears in two forms: the full genesis hash
 * ("algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=", used by @x402/avm 2.11
 * and the GoPlausible facilitator) and a 32-char truncation (used by @x402/avm >= 2.20).
 * Compare on the first 32 chars of the reference.
 */
export function normalizeNetwork(n: string): string {
  const m = /^algorand:(.+)$/.exec(n);
  return m ? `algorand:${m[1].slice(0, 32)}` : n;
}

export function sameNetwork(a: string, b: string): boolean {
  return normalizeNetwork(a) === normalizeNetwork(b);
}

/** Minimal shapes of the x402 v2 PaymentRequired we rely on. */
export interface AcceptLike {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  extra?: Record<string, unknown>;
}

export interface PaymentRequiredLike {
  x402Version: number;
  resource?: { url?: string; description?: string; mimeType?: string };
  accepts: AcceptLike[];
  extensions?: Record<string, unknown>;
}

/** Pull the seller's promise out of its 402 (resource info + Bazaar extension). */
export function declarationFrom(pr: PaymentRequiredLike): Declaration {
  const bazaar = (pr.extensions?.bazaar ?? undefined) as
    | { info?: { output?: { example?: unknown; schema?: Record<string, unknown> } } }
    | undefined;
  const output = bazaar?.info?.output;
  return {
    resourceUrl: pr.resource?.url,
    description: pr.resource?.description,
    mimeType: pr.resource?.mimeType,
    outputExample: output?.example,
    outputSchema: output?.schema && typeof output.schema === "object" ? output.schema : undefined,
  };
}

/**
 * Pick the accept entry we are able to pay: exact scheme, our network, our USDC.
 * Among matches, the cheapest one.
 */
export function selectAccept(
  accepts: AcceptLike[],
  network: string,
  usdcAsaId: string,
): AcceptLike | undefined {
  const ok = accepts.filter(
    (a) =>
      a.scheme === "exact" &&
      sameNetwork(a.network, network) &&
      String(a.asset) === String(usdcAsaId) &&
      /^\d+$/.test(String(a.amount)),
  );
  ok.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : BigInt(a.amount) > BigInt(b.amount) ? 1 : 0));
  return ok[0];
}
