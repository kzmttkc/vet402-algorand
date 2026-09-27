/**
 * Placeholders in a seller's published example input ("<sha256-hex-64-chars>", "{{uuid}}", "YOUR_...").
 *
 * Sent verbatim, a placeholder makes a write-type seller answer 400 before settlement, and a fixed
 * value would be refused the second time (e.g. 409 for a hash that was already timestamped). So each
 * placeholder is replaced with a fresh random value that fits its schema or hint, on every request.
 *
 * vet402 makes only plain digests (hex) and UUIDs, and never an identity, a credential or a chain
 * reference: a hint or field name that names an address, key, transaction, block, party, order, id,
 * account or signature stays unfilled, and the caller does not pay (placeholder_unfillable). A seller's
 * `pattern` is read only in known shapes and never compiled. Strings that are not placeholders are never
 * changed. Pure: no network, no I/O; randomness only from Web Crypto.
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

/** "privateKey", "tx_hash", "recipient-hex" → ["private", "key", "tx", "hash", "recipient", "hex"]. */
function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Words (in the hint or the field name) that point at something real vet402 must not make up:
 * a chain reference, a key, a party, an identifier, a credential, a link.
 */
function neverInvent(w: string): boolean {
  if (w === "uuid" || w === "guid") return false;
  return (
    /^(tx|txn|transaction|block|pub|pubkey|publickey|public|private|privkey|key|keys|apikey|sender|recipient|receiver|from|to|order|address|addr|account|signature|sig|wallet|email|mail|phone|name|user|username|secret|token|password|passphrase|mnemonic|seed|url|uri|link|host|ip)$/.test(w) ||
    /^(tx|block|order|address|account|sig)/.test(w) || // txhash, txid, blockhash, orderid, addresses, signatures
    /(key|id|ids|address|addr|account|signature|sig|sender|recipient|token|secret)$/.test(w) // privatekey, orderid, userid, ...
  );
}

/** Hint words that describe a plain digest ("<sha256-hex-64-chars>", "<64-hex-sha256>", "<document hash>"). */
const HEX_WORDS = /^(sha|sha1|sha224|sha256|sha384|sha512|sha3|keccak|keccak256|blake2b|blake2b256|md5|\d+|hex|hexadecimal|hash|digest|merkle|root|chars?|characters|digits?|lowercase|random|nonce|salt|of|the|a|file|document|content|data)$/;
const UUID_WORDS = /^(uuid|guid|v4|uuidv4|random)$/;

function randomHex(n: number, upper = false): string {
  const bytes = new Uint8Array(Math.ceil(n / 2));
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, n);
  return upper ? hex.toUpperCase() : hex;
}

function int(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

type KnownPattern = { kind: "hex"; min: number; max: number; upper: boolean } | { kind: "uuid"; upper: boolean };

const HEX_CLASS = /\[(?:0-9a-fA-F|0-9A-Fa-f|a-fA-F0-9|A-Fa-f0-9|0-9a-f|a-f0-9|0-9A-F|A-F0-9)\]/g;

/**
 * A seller-supplied `pattern` is read only when it is one of a few known shapes (a hex string of a
 * fixed or bounded length, a UUID). It is never compiled: a seller's regular expression is not run.
 */
export function knownPattern(p: string): KnownPattern | undefined {
  if (p.length > 200) return undefined;
  const classes = p.match(HEX_CLASS) ?? [];
  if (classes.length === 0) return undefined;
  const upper = classes.every((c) => !/a-f/.test(c));
  const shape = p.replace(HEX_CLASS, "H").replace(/^\^/, "").replace(/\$$/, "");
  const m = /^H(?:\{(\d{1,4})\}|\{(\d{1,4}),(\d{1,4})\}|(\+))$/.exec(shape);
  if (m) {
    if (m[1]) return { kind: "hex", min: Number(m[1]), max: Number(m[1]), upper };
    if (m[2]) return { kind: "hex", min: Number(m[2]), max: Number(m[3]), upper };
    return { kind: "hex", min: 1, max: 1024, upper };
  }
  if (shape === "H{8}-H{4}-H{4}-H{4}-H{12}" || /^H\{8\}-H\{4\}-4H\{3\}-\[(?:89ab|89abAB|89AB)\]H\{3\}-H\{12\}$/.test(shape)) {
    return { kind: "uuid", upper };
  }
  return undefined;
}

export type Fill = { ok: true; value: string } | { ok: false };

/**
 * A fresh value for a placeholder with this hint (and optional schema and field name), or { ok: false }
 * when vet402 cannot (or must not) make one up. Only two kinds are ever made: a plain hex digest and a
 * UUID v4. The hint must describe only that ("<sha256-hex-64-chars>"); a hint or field name that names
 * a transaction, block, key, party, order, id, address, account or signature is left alone.
 */
export function fillPlaceholder(hint: string, schema: FieldSchema = {}, key = ""): Fill {
  const h = hint.toLowerCase();
  const hw = words(hint);
  const kw = words(key);
  const format = typeof schema.format === "string" ? schema.format.toLowerCase() : "";
  const pattern = typeof schema.pattern === "string" ? schema.pattern : undefined;
  const minLen = int(schema.minLength);
  const maxLen = int(schema.maxLength);
  if (schema.type !== undefined && schema.type !== "string") return { ok: false };
  if (schema.enum !== undefined) return { ok: false };
  if (format && format !== "uuid") return { ok: false };
  if (hw.some(neverInvent) || kw.some(neverInvent)) return { ok: false };
  const pat = pattern !== undefined ? knownPattern(pattern) : undefined;
  if (pattern !== undefined && !pat) return { ok: false };

  const lengthOk = (n: number) => (minLen === undefined || n >= minLen) && (maxLen === undefined || n <= maxLen);

  const uuidWanted = format === "uuid" || pat?.kind === "uuid" || (hw.length > 0 && hw.every((w) => UUID_WORDS.test(w)) && hw.some((w) => w !== "random"));
  if (uuidWanted) {
    if (pat && pat.kind !== "uuid") return { ok: false };
    if (!hw.every((w) => UUID_WORDS.test(w) || HEX_WORDS.test(w))) return { ok: false };
    if (!lengthOk(36)) return { ok: false };
    const v = globalThis.crypto.randomUUID();
    return { ok: true, value: pat?.upper ? v.toUpperCase() : v };
  }

  const hexHint = hw.length > 0 && hw.every((w) => HEX_WORDS.test(w)) && (/hex|hash|digest/.test(h) || HASH_HEX_LEN.some(([re]) => re.test(h)));
  if (!hexHint && pat?.kind !== "hex") return { ok: false };
  if (!hw.every((w) => HEX_WORDS.test(w))) return { ok: false };
  if (pat && pat.kind !== "hex") return { ok: false };
  // A bare number in the hint is the length ("<sha256-hex-64-chars>", "<64-hex-sha256>"); hash names are not.
  const bare = /(?:^|[^a-z0-9])(\d{1,4})(?![0-9])/.exec(h.replace(HASH_NAMES, " "));
  const lo = Math.max(minLen ?? 1, pat?.min ?? 1);
  const hi = Math.min(maxLen ?? 1024, pat?.max ?? 1024);
  const n = (bare ? Number(bare[1]) : undefined) ?? HASH_HEX_LEN.find(([re]) => re.test(h))?.[1] ?? Math.min(Math.max(64, lo), hi);
  if (n < 1 || n > 1024 || n < lo || n > hi) return { ok: false };
  return { ok: true, value: randomHex(n, pat?.upper) };
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
/** Every key on the path, so a parent names the value too: "tx.hash" → "tx hash"; "files[1].hash" → "files hash". */
function pathKeys(path: string): string {
  return path.replace(/\[\d+\]/g, "").split(".").join(" ");
}

export function fillPlaceholders<T>(value: T, path = ""): FillResult<T> {
  const filled: string[] = [];
  const unfillable: string[] = [];
  const walk = (v: unknown, p: string): unknown => {
    if (typeof v === "string") {
      const hint = placeholderHint(v);
      if (hint === undefined) return v;
      const f = fillPlaceholder(hint, {}, pathKeys(p));
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
      // defineProperty keeps an own "__proto__" key as data (plain assignment would set the prototype and drop it).
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        Object.defineProperty(out, k, { value: walk(x, p ? `${p}.${k}` : k), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    return v;
  };
  return { value: walk(value, path) as T, filled, unfillable };
}
