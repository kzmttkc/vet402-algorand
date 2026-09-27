/**
 * Bazaar discovery feed (the x402 facilitator's catalogue of paid resources) and
 * the request vet402 sends to a listed resource. Shared by the daily board sweep
 * (scripts/board-sweep.ts) and the paid seller audit (src/audit.ts).
 *
 * Read-only: nothing here signs or pays.
 */
import type { AcceptLike } from "./declaration.js";
import type { ProbeDeps } from "./probe.js";

export const DEFAULT_BAZAAR = "https://facilitator.goplausible.xyz/discovery/resources";
/** vet402's own hosts: never bought from (self-dealing by host). */
export const OWN_HOSTS = ["vet402-algorand.vercel.app", "vet402.com"];
const MAX_BODY_CHARS = 8192;

export interface BazaarItem {
  resourceUrl: string;
  method?: string;
  description?: string;
  mimeType?: string;
  accepts: AcceptLike[];
  discoveryInfo?: {
    input?: { method?: string; queryParams?: Record<string, unknown>; body?: unknown; bodyType?: string; pathParams?: unknown };
  };
  lastSeen?: string;
  settleCount?: number;
}

export function isOwnHost(host: string, ownHosts: string[] = OWN_HOSTS): boolean {
  const h = host.toLowerCase();
  return ownHosts.some((o) => h === o || h.endsWith(`.${o}`));
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export type BuiltRequest =
  | { ok: true; url: string; method: "GET" | "POST"; body?: string; contentType?: string; input: string }
  | { ok: false; reason: string };

/** Turn a Bazaar item into the request vet402 will send (the seller's own example input). */
export function buildRequest(item: BazaarItem): BuiltRequest {
  const inp = item.discoveryInfo?.input ?? {};
  const method = String(inp.method ?? item.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") return { ok: false, reason: "method_not_probed" };
  let u: URL;
  try {
    u = new URL(item.resourceUrl);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  let path = u.pathname;
  try {
    path = decodeURI(u.pathname);
  } catch {
    /* keep raw */
  }
  if (/\{[^}]*\}|\/:[A-Za-z_]/.test(path)) return { ok: false, reason: "path_params" };
  let q = inp.queryParams as Record<string, unknown> | undefined;
  // Some listings nest the whole input object inside queryParams; unwrap it.
  if (q && typeof q === "object" && q.type === "http" && q.queryParams && typeof q.queryParams === "object") {
    q = q.queryParams as Record<string, unknown>;
  }
  if (q && typeof q === "object" && !Array.isArray(q)) {
    for (const [k, raw] of Object.entries(q)) {
      // A schema-style value ({type, description, example|default}) contributes its example/default only.
      const v = raw && typeof raw === "object" ? ((raw as Record<string, unknown>).example ?? (raw as Record<string, unknown>).default) : raw;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") u.searchParams.set(k, String(v));
    }
  }
  let body: string | undefined;
  let contentType: string | undefined;
  if (method === "POST" && inp.body !== undefined) {
    if (inp.bodyType && inp.bodyType !== "json") return { ok: false, reason: "body_not_json" };
    body = JSON.stringify(inp.body);
    if (body.length > MAX_BODY_CHARS) return { ok: false, reason: "body_too_large" };
    contentType = "application/json";
  }
  const input = [u.search ? clip(u.search, 140) : "", body ? `body ${clip(body, 140)}` : ""].filter(Boolean).join(" ") || "(none)";
  return { ok: true, url: u.toString(), method, body, contentType, input };
}

/** Every item of the feed, following `offset` until `pagination.total`. */
export async function fetchBazaar(base = DEFAULT_BAZAAR, fetchImpl: typeof fetch = fetch): Promise<BazaarItem[]> {
  const items: BazaarItem[] = [];
  for (let page = 0, offset = 0; page < 40; page++) {
    const res = await fetchImpl(`${base}?limit=500&offset=${offset}`, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`bazaar ${res.status}`);
    const body = (await res.json()) as { items?: BazaarItem[]; pagination?: { total?: number } };
    if (!Array.isArray(body.items)) throw new Error("bazaar: malformed response");
    items.push(...body.items);
    offset += body.items.length;
    const total = body.pagination?.total ?? 0;
    if (body.items.length === 0 || offset >= total) return items;
  }
  throw new Error("bazaar: too many pages");
}

/** Where the audit reads the list of a seller's resources. */
export interface Catalog {
  items(): Promise<BazaarItem[]>;
}

/** The Bazaar feed, cached in memory for `ttlMs` (default 5 minutes). A failed read is not cached. */
export class BazaarCatalog implements Catalog {
  private cache: { at: number; items: Promise<BazaarItem[]> } | null = null;
  constructor(
    private readonly base = DEFAULT_BAZAAR,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  items(): Promise<BazaarItem[]> {
    const t = this.now();
    if (this.cache && t - this.cache.at < this.ttlMs) return this.cache.items;
    const items = fetchBazaar(this.base, this.fetchImpl);
    this.cache = { at: t, items };
    items.catch(() => {
      if (this.cache?.items === items) this.cache = null;
    });
    return items;
  }
}

/**
 * A fixed list of URLs read from their own unpaid 402 (local TestNet run: the test
 * sellers on localhost are not in the Bazaar). Never used on MainNet.
 */
export class UrlListCatalog implements Catalog {
  constructor(
    private readonly urls: string[],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async items(): Promise<BazaarItem[]> {
    const out: BazaarItem[] = [];
    for (const url of this.urls) {
      const res = await this.fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000) });
      const header = res.headers.get("payment-required");
      let pr: { accepts?: AcceptLike[]; resource?: { description?: string; mimeType?: string } } | undefined;
      try {
        pr = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : ((await res.json()) as typeof pr);
      } catch {
        pr = undefined;
      }
      if (res.status !== 402 || !pr || !Array.isArray(pr.accepts)) continue;
      out.push({ resourceUrl: url, method: "GET", accepts: pr.accepts, description: pr.resource?.description, mimeType: pr.resource?.mimeType });
    }
    return out;
  }
}

/** Send a request's method/body through the normal probe() request path. */
export function withInput(deps: ProbeDeps, c: { method: "GET" | "POST"; body?: string; contentType?: string }): ProbeDeps {
  const shape = (init: RequestInit): RequestInit => ({
    ...init,
    method: c.method,
    ...(c.body !== undefined ? { body: c.body, headers: { "content-type": c.contentType ?? "application/json" } } : {}),
  });
  return {
    ...deps,
    fetchImpl: (url, init) => deps.fetchImpl(url, shape(init)),
    paidFetch: (url, approved, init) => deps.paidFetch(url, approved, shape(init)),
  };
}
