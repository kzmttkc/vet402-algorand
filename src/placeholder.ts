/**
 * Placeholders in a seller's published example input ("<sha256-hex-64-chars>", "{{uuid}}", "YOUR_...").
 *
 * Sent verbatim, a placeholder makes a write-type seller answer 400 before settlement, and a fixed
 * value would be refused the second time (e.g. 409 for a hash that was already timestamped). So each
 * placeholder is replaced with a fresh random value that fits its schema or hint, on every request.
 *
 * vet402 never invents an identity or a credential: an address, email, key, token, txid or URL stays
 * unfilled, and the caller does not pay (placeholder_unfillable). Strings that are not placeholders are
 * never changed. Pure: no network, no I/O; randomness only from Web Crypto.
 */

/** Schema facts that may sit next to an example value (Bazaar schema-style query params). */
export interface FieldSchema {
  type?: unknown;
  format?: unknown;
  pattern?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  enum?: unknown;
}

/** HTML element names: "<a>" or "<br>" as an example value is HTML, not a placeholder. */
const HTML_TAGS = new Set(
  (
    "a abbr article aside audio b blockquote body br button canvas code div em embed footer form h1 h2 h3 h4 h5 h6 " +
    "head header hr html i iframe img input label li link main meta nav ol option p pre script section select small " +
    "source span strong style sub sup svg table tbody td template textarea tfoot th thead title tr u ul video"
  ).split(" "),
);

/**
 * The hint inside a placeholder, or undefined when `s` is not one.
 * Placeholders: the whole string is `<...>` (not an HTML tag), `{{...}}`, or `YOUR_...`.
 */
export function placeholderHint(s: string): string | undefined {
  const t = s.trim();
  let m = /^<([^<>]+)>$/.exec(t);
  if (m) {
    const inner = m[1].trim();
    // `<a href="x">`, `</p>`, `<!-- -->`, `<?xml ?>`, `<br>` are markup, not placeholders.
    if (!inner || /[="'`]/.test(inner) || /^[/!?]/.test(inner)) return undefined;
    if (HTML_TAGS.has(inner.toLowerCase().replace(/\s*\/$/, ""))) return undefined;
    return inner;
  }
  m = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(t);
  if (m) return m[1];
  m = /^YOUR_([A-Z0-9_]+)$/.exec(t);
  if (m) return m[1].replace(/_/g, " ");
  return undefined;
}

export function isPlaceholder(s: string): boolean {
  return placeholderHint(s) !== undefined;
}

/** Hints vet402 must not invent a value for: identities, credentials, links, chain references. */
const NEVER_INVENT =
  /address|\baddr\b|e-?mail|wallet|account|\bkey\b|api[\s_-]?key|secret|token|password|passphrase|mnemonic|seed|private|signature|\bsig\b|\burl\b|\buri\b|link|txid|tx[\s_-]?id|transaction|phone|\bname\b|user(name)?\b/i;

/** Hash names and the hex length of their digest. */
const HASH_HEX_LEN: [RegExp, number][] = [
  [/sha-?512|sha3-?512|blake2b(?!-?256)/i, 128],
  [/sha-?384/i, 96],
  [/sha-?256|sha3-?256|keccak-?256|blake2b-?256|merkle/i, 64],
  [/sha-?224/i, 56],
  [/sha-?1\b|sha1/i, 40],
  [/md5/i, 32],
];
const HASH_NAMES = /sha3?-?(1|224|256|384|512)|keccak-?256|blake2b(-?256)?|md5/gi;

function randomHex(n: number): string {
  const bytes = new Uint8Array(Math.ceil(n / 2));
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, n);
}

function int(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/** A hex-only pattern (`^[0-9a-f]{64}$`, `^[a-fA-F0-9]+$`, …) and its fixed length, if any. */
function hexPattern(p: string): { len?: number } | undefined {
  const m = /^\^?\[(?:0-9a-fA-F|a-fA-F0-9|0-9a-f|a-f0-9|0-9A-F|A-F0-9)\](?:\{(\d+)\}|\+|\*)\$?$/.exec(p);
  if (!m) return undefined;
  return { len: m[1] ? Number(m[1]) : undefined };
}

export type Fill = { ok: true; value: string } | { ok: false };

/**
 * A fresh value for a placeholder with this hint and optional schema, or { ok: false } when vet402
 * cannot (or must not) make one up.
 */
export function fillPlaceholder(hint: string, schema: FieldSchema = {}): Fill {
  const h = hint.toLowerCase();
  const format = typeof schema.format === "string" ? schema.format.toLowerCase() : "";
  const pattern = typeof schema.pattern === "string" ? schema.pattern : undefined;
  const minLen = int(schema.minLength);
  const maxLen = int(schema.maxLength);
  if (schema.type !== undefined && schema.type !== "string") return { ok: false };
  if (NEVER_INVENT.test(h) || /email|uri|url|hostname|ipv[46]/.test(format)) return { ok: false };

  const fits = (v: string): Fill => {
    if (minLen !== undefined && v.length < minLen) return { ok: false };
    if (maxLen !== undefined && v.length > maxLen) return { ok: false };
    if (pattern !== undefined) {
      try {
        if (!new RegExp(pattern).test(v)) return { ok: false };
      } catch {
        return { ok: false };
      }
    }
    return { ok: true, value: v };
  };

  if (Array.isArray(schema.enum)) {
    const first = schema.enum.find((e): e is string => typeof e === "string" && !isPlaceholder(e));
    return first !== undefined ? fits(first) : { ok: false };
  }
  if (format === "uuid" || /\buuid\b|guid/.test(h)) return fits(globalThis.crypto.randomUUID());

  const hexPat = pattern !== undefined ? hexPattern(pattern) : undefined;
  const hexHint = /hex|hash|digest/.test(h) || HASH_HEX_LEN.some(([re]) => re.test(h));
  if (hexHint || hexPat) {
    // A bare number in the hint is the length ("<sha256-hex-64-chars>", "<64-hex-sha256>"); hash names are not.
    const bare = /(?:^|[^a-z0-9])(\d{1,4})(?![0-9])/.exec(h.replace(HASH_NAMES, " "));
    const n =
      (bare ? Number(bare[1]) : undefined) ??
      hexPat?.len ??
      HASH_HEX_LEN.find(([re]) => re.test(h))?.[1] ??
      Math.min(Math.max(64, minLen ?? 0), maxLen ?? Infinity);
    if (n < 1 || n > 1024) return { ok: false };
    return fits(randomHex(n));
  }
  return { ok: false };
}

export interface FillResult<T> {
  value: T;
  /** Paths of the placeholders replaced with fresh values ("hash", "files[1].hash"). */
  filled: string[];
  /** Paths of placeholders vet402 did not fill (left as they were). */
  unfillable: string[];
}

/**
 * Replace every placeholder string in a JSON value (objects and arrays, any depth). Each placeholder
 * gets its own fresh value; everything else is returned unchanged.
 */
export function fillPlaceholders<T>(value: T, path = ""): FillResult<T> {
  const filled: string[] = [];
  const unfillable: string[] = [];
  const walk = (v: unknown, p: string): unknown => {
    if (typeof v === "string") {
      const hint = placeholderHint(v);
      if (hint === undefined) return v;
      const f = fillPlaceholder(hint);
      if (f.ok) {
        filled.push(p || "(body)");
        return f.value;
      }
      unfillable.push(p || "(body)");
      return v;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, p ? `${p}.${k}` : k);
      return out;
    }
    return v;
  };
  return { value: walk(value, path) as T, filled, unfillable };
}
