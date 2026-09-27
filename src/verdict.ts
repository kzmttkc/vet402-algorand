/**
 * Pure delivery-vs-declaration check. No network, no I/O.
 *
 * Reason words are a stable, machine-readable contract. Do not rename them.
 */
export const REASONS = [
  "delivered", // ALLOW: 200, JSON, declared keys present, non-empty
  "not_x402", // target did not answer 402 with x402 payment requirements
  "no_supported_accept", // no accepts[] entry on our network + USDC
  "price_over_cap", // price above per-call cap: we did not pay
  "daily_cap_reached", // paying would exceed the daily cap: we did not pay
  "invalid_target", // URL rejected before any request (scheme, private host, ...)
  "payment_failed", // we tried to pay but settlement did not succeed
  "http_error", // paid, but the seller answered non-2xx
  "not_json", // paid, 200, body is not JSON
  "empty_body", // paid, 200, JSON but empty ({} / [] / null / "")
  "delivery_missing_keys", // paid, 200, JSON, but declared output keys missing
  "probe_error", // network/timeout/unexpected error while probing
] as const;

export type Reason = (typeof REASONS)[number];
export type Verdict = "ALLOW" | "REFUSE";

export interface Declaration {
  resourceUrl?: string;
  description?: string;
  mimeType?: string;
  /** Example output declared via Bazaar (`extensions.bazaar.info.output.example`). */
  outputExample?: unknown;
  /** JSON schema declared via Bazaar (`extensions.bazaar.info.output.schema`). */
  outputSchema?: Record<string, unknown>;
}

export interface Delivery {
  status: number;
  contentType: string | null;
  bodyText: string;
}

export interface DeliveryJudgement {
  verdict: Verdict;
  reason: Reason;
  expectedKeys: string[];
  missingKeys: string[];
  /** Short, bounded summary of what was delivered (never the full body). */
  summary: string;
}

/**
 * Keys the seller promised. Priority: schema.required, else schema.properties,
 * else the top-level keys of the declared example object.
 */
export function expectedKeys(decl: Declaration): string[] {
  const schema = decl.outputSchema;
  if (schema && typeof schema === "object") {
    const req = (schema as { required?: unknown }).required;
    if (Array.isArray(req) && req.every((k) => typeof k === "string") && req.length > 0) {
      return [...req] as string[];
    }
    const props = (schema as { properties?: unknown }).properties;
    if (props && typeof props === "object" && !Array.isArray(props)) {
      const keys = Object.keys(props);
      if (keys.length > 0) return keys;
    }
  }
  const ex = decl.outputExample;
  if (ex && typeof ex === "object" && !Array.isArray(ex)) return Object.keys(ex);
  return [];
}

function isEmptyJson(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

export function summarize(value: unknown, max = 240): string {
  let s: string;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      const t = Array.isArray(v) ? `array(${v.length})` : v === null ? "null" : typeof v;
      const preview = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? `=${JSON.stringify(v).slice(0, 40)}` : "";
      return `${k}:${t}${preview}`;
    });
    s = `object{${entries.join(", ")}}`;
  } else if (Array.isArray(value)) {
    s = `array(${value.length})`;
  } else {
    s = `${typeof value}:${JSON.stringify(value)}`;
  }
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function judgeDelivery(decl: Declaration, d: Delivery): DeliveryJudgement {
  const keys = expectedKeys(decl);
  const base = { expectedKeys: keys, missingKeys: [] as string[] };
  if (d.status < 200 || d.status >= 300) {
    return { ...base, verdict: "REFUSE", reason: "http_error", summary: `status ${d.status}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(d.bodyText);
  } catch {
    const snippet = d.bodyText.slice(0, 80).replace(/\s+/g, " ");
    return {
      ...base,
      verdict: "REFUSE",
      reason: "not_json",
      summary: `content-type ${d.contentType ?? "none"}, ${d.bodyText.length} bytes: ${snippet}`,
    };
  }
  if (isEmptyJson(parsed)) {
    return { ...base, verdict: "REFUSE", reason: "empty_body", summary: summarize(parsed) };
  }
  if (keys.length > 0) {
    const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    const missing = keys.filter((k) => !(k in obj) || isEmptyValue(obj[k]));
    if (missing.length > 0) {
      return { ...base, missingKeys: missing, verdict: "REFUSE", reason: "delivery_missing_keys", summary: summarize(parsed) };
    }
  }
  return { ...base, verdict: "ALLOW", reason: "delivered", summary: summarize(parsed) };
}
