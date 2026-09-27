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

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Where a seller's output JSON schema lives in its Bazaar extension.
 *
 * Standard (`declareDiscoveryExtension`, x402 Bazaar): the extension carries a JSON schema
 * of its own `info`, and the output schema is embedded at
 * `bazaar.schema.properties.output.properties.example`.
 * Some sellers instead put it next to the example at `bazaar.info.output.schema`.
 * The explicit `info.output.schema` wins when both exist.
 */
export function outputSchemaFrom(bazaar: unknown): Obj | undefined {
  if (!isObj(bazaar)) return undefined;
  const info = isObj(bazaar.info) ? bazaar.info : undefined;
  const infoOutput = info && isObj(info.output) ? info.output : undefined;
  if (infoOutput && isObj(infoOutput.schema)) return infoOutput.schema;
  const schema = isObj(bazaar.schema) ? bazaar.schema : undefined;
  const props = schema && isObj(schema.properties) ? schema.properties : undefined;
  const output = props && isObj(props.output) ? props.output : undefined;
  const outProps = output && isObj(output.properties) ? output.properties : undefined;
  const example = outProps && isObj(outProps.example) ? outProps.example : undefined;
  return example;
}

/** Pull the seller's promise out of its 402 (resource info + Bazaar extension). */
export function declarationFrom(pr: PaymentRequiredLike): Declaration {
  const bazaar = pr.extensions?.bazaar;
  const info = isObj(bazaar) && isObj(bazaar.info) ? bazaar.info : undefined;
  const output = info && isObj(info.output) ? info.output : undefined;
  return {
    resourceUrl: pr.resource?.url,
    description: pr.resource?.description,
    mimeType: pr.resource?.mimeType,
    outputExample: output?.example,
    outputSchema: outputSchemaFrom(bazaar),
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
