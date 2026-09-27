/**
 * Pure delivery-vs-declaration check. No network, no I/O.
 *
 * Reason words are a stable, machine-readable contract. Do not rename them.
 */
export const REASONS = [
  "delivered", // ALLOW: 200, JSON, non-empty, every schema.required key present (example-only keys are hints: a miss is noted, not refused)
  "not_x402", // target did not answer 402 with x402 payment requirements
  "no_supported_accept", // no accepts[] entry on our network + USDC
  "requirements_body_only", // 402 carries x402 v2 requirements only in its JSON body (no PAYMENT-REQUIRED header): readable, but the x402 paying client cannot pay it; we did not pay
  "price_over_cap", // price above per-call cap: we did not pay
  "daily_cap_reached", // paying would exceed the daily cap: we did not pay
  "cap_check_unavailable", // today's spend could not be read from the chain: we did not pay
  "self_dealing", // seller payTo is one of vet402's own wallets: we never pay ourselves
  "invalid_target", // URL rejected before any request (scheme, private host, ...)
  "payment_failed", // we tried to pay but settlement did not succeed
  "http_error", // paid, but the seller answered non-2xx
  "not_json", // paid, 200, body is not JSON
  "empty_body", // paid, 200, JSON but empty ({} / [] / null / "")
  "delivery_missing_keys", // paid, 200, JSON, but a key the output schema lists as `required` is absent
  "probe_error", // network/timeout/unexpected error while probing
  "price_changed", // /v1/buy: the seller's price or payTo is no longer the one the customer paid for: we did not pay
] as const;

export type Reason = (typeof REASONS)[number];
export type Verdict = "ALLOW" | "REFUSE";

export interface Declaration {
  resourceUrl?: string;
  description?: string;
  mimeType?: string;
  /** Example output declared via Bazaar (`extensions.bazaar.info.output.example`). */
  outputExample?: unknown;
  /** Output JSON schema declared via Bazaar (see `outputSchemaFrom` in declaration.ts). */
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
  /** Promised keys (schema.required). Missing one of these is a REFUSE. */
  expectedKeys: string[];
  missingKeys: string[];
  /** Hint keys (example / schema.properties) used only when nothing is required. */
  exampleKeys: string[];
  /** Hint keys not present in the delivery. Never a REFUSE on their own. */
  unseenExampleKeys: string[];
  /** e.g. "example keys not seen: a, b" on an ALLOW. */
  note?: string;
  /** Short, bounded summary of what was delivered (never the full body). */
  summary: string;
}

function requiredOf(decl: Declaration): string[] {
  const req = (decl.outputSchema as { required?: unknown } | undefined)?.required;
  if (!Array.isArray(req)) return [];
  return [...new Set(req.filter((k): k is string => typeof k === "string"))].slice(0, 50);
}

/**
 * Keys the seller promised: the output schema's `required` list, and nothing else.
 * An example is an illustration and `properties` without `required` are optional
 * (JSON Schema), so neither is a promise.
 */
export function expectedKeys(decl: Declaration): string[] {
  return requiredOf(decl);
}

/**
 * Keys vet402 looks for as a hint when nothing is required: schema.properties keys,
 * then the top-level keys of the declared example object. Empty when `required` exists.
 */
export function exampleKeys(decl: Declaration): string[] {
  if (requiredOf(decl).length > 0) return [];
  const keys: string[] = [];
  const props = (decl.outputSchema as { properties?: unknown } | undefined)?.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) keys.push(...Object.keys(props));
  const ex = decl.outputExample;
  if (ex && typeof ex === "object" && !Array.isArray(ex)) keys.push(...Object.keys(ex));
  return [...new Set(keys)];
}

/** A key counts as delivered when it exists as the object's own key, whatever its value (null included). */
function hasKey(obj: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, k);
}

function keyList(keys: string[], max = 200): string {
  const s = keys.join(", ");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function isEmptyJson(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
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
  const hints = exampleKeys(decl);
  const base = { expectedKeys: keys, missingKeys: [] as string[], exampleKeys: hints, unseenExampleKeys: [] as string[] };
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
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const missing = keys.filter((k) => !hasKey(obj, k));
  if (missing.length > 0) {
    return { ...base, missingKeys: missing, verdict: "REFUSE", reason: "delivery_missing_keys", summary: summarize(parsed) };
  }
  const unseen = hints.filter((k) => !hasKey(obj, k));
  // No required list, but the seller showed an example: a response with none of its keys (e.g. an error object) is not the product.
  if (keys.length === 0 && hints.length > 0 && unseen.length === hints.length) {
    return { ...base, missingKeys: unseen.slice(0, 50), verdict: "REFUSE", reason: "delivery_missing_keys", summary: summarize(parsed) };
  }
  const note = unseen.length > 0 ? `example keys not seen: ${keyList(unseen)}` : undefined;
  return { ...base, unseenExampleKeys: unseen, ...(note ? { note } : {}), verdict: "ALLOW", reason: "delivered", summary: summarize(parsed) };
}
