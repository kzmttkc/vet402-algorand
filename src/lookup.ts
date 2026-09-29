/**
 * GET /v1/verdict?url=<x402 URL>   (0.001 USDC)
 *
 * What vet402 recorded the last time it bought from this URL with its own wallet: the class
 * (DELIVERED / MISMATCH / UNREACHABLE / UNCLEAR), the reason code, the day and the vet402 -> seller tx.
 * Read from the same files as /board and /seller (board/latest.json and the latest census, or GitHub raw).
 *
 * vet402 pays nobody here. The customer's payment settles first (settle-first.ts) and the handler only
 * reads files: there is no downstream payment, no probe and no spend reservation in this module.
 * A URL with no result is refused with 404 before any payment (free check, and again before settlement).
 */
import type { Context, Hono } from "hono";
import { x402HTTPResourceServer, type x402ResourceServer } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402-avm/extensions";
import type { AppConfig } from "./config.js";
import {
  UNCLEAR_NOTE,
  censusFileFor,
  defaultBoardFile,
  displayClass,
  isBoardDate,
  sellerPath,
  sharedBoardLoader,
  txLink,
  type BoardFile,
  type BoardLoader,
  type DisplayClass,
} from "./board.js";
import { settleFirstMiddleware, type SettleFirstEnv } from "./settle-first.js";
import { SELLER_PAGE_BASE } from "./seller.js";
import { withBase } from "./base.js";
import { LISTING_EXAMPLE_HOST, LISTING_EXAMPLE_URL } from "./bazaar.js";

export const VERDICT_PATH = "/v1/verdict";
export const VERDICT_PRICE_USDC = "0.001";
const MAX_URL = 2000;
const MAX_RESULTS = 20;

export interface VerdictEntry {
  class: DisplayClass;
  /** false only for UNCLEAR: vet402 or the payment path could not reach a result. */
  countedAgainstSeller: boolean;
  reason: string;
  detail?: string;
  /** UTC day of the purchase, YYYY-MM-DD. */
  date: string;
  at: string;
  method: string;
  /** The URL vet402 actually bought (with the example input the seller published). */
  url: string;
  host: string;
  priceUsdc?: string;
  paid: boolean;
  /** vet402 -> seller transaction (only when the seller's settlement receipt said success). */
  sellerTx?: string;
  sellerTxUrl?: string;
  /** Which sweep recorded it. */
  source: "daily" | "census";
}

export interface VerdictLookup {
  /** exact: the same URL; path: same origin and path, a different query (vet402 bought with the seller's example input). */
  match: "exact" | "path";
  /** The newest result. */
  latest: VerdictEntry;
  /** Newest result per method and bought URL, newest first. */
  results: VerdictEntry[];
}

export type VerdictOutcome = { ok: true; url: string; lookup: VerdictLookup } | { ok: false; status: 400 | 404; body: Record<string, unknown> };

/** http(s) URL in its canonical form, else null. */
export function normalizeTargetUrl(v: unknown): URL | null {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_URL) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.hash = "";
    return u;
  } catch {
    return null;
  }
}

/** Latest recorded result for this URL (exact first; else the same origin + path). SKIPPED rows are not results. */
export function lookupVerdict(target: URL, files: { daily: BoardFile | null; census: BoardFile | null }): VerdictLookup | null {
  const exact = new Map<string, VerdictEntry>();
  const path = new Map<string, VerdictEntry>();
  const want = target.href;
  const wantPath = target.origin + target.pathname;
  for (const [source, f] of [
    ["census", files.census],
    ["daily", files.daily],
  ] as const) {
    if (!f) continue;
    for (const r of f.rows) {
      if (r.verdict === "SKIPPED") continue;
      const u = normalizeTargetUrl(r.url);
      if (!u) continue;
      const into = u.href === want ? exact : u.origin + u.pathname === wantPath ? path : null;
      if (!into) continue;
      const d = r.at.slice(0, 10);
      const cls = displayClass(r);
      const link = txLink(r.tx, f.networkName);
      const e: VerdictEntry = {
        class: cls,
        countedAgainstSeller: cls !== "UNCLEAR",
        reason: r.reason,
        ...(r.detail ? { detail: r.detail } : {}),
        date: isBoardDate(d) ? d : isBoardDate(f.date) ? f.date : "",
        at: r.at,
        method: r.method,
        url: r.url,
        host: r.host || u.host,
        ...(r.priceUsdc ? { priceUsdc: r.priceUsdc } : {}),
        paid: r.paid,
        ...(r.paid && link ? { sellerTx: r.tx, sellerTxUrl: link } : {}),
        source,
      };
      const key = `${r.method} ${u.href}`;
      const prev = into.get(key);
      if (!prev || (e.at || e.date) > (prev.at || prev.date)) into.set(key, e);
    }
  }
  const pick = exact.size ? exact : path.size ? path : null;
  if (!pick) return null;
  const results = [...pick.values()].sort((a, b) => ((b.at || b.date) > (a.at || a.date) ? 1 : (b.at || b.date) < (a.at || a.date) ? -1 : 0)).slice(0, MAX_RESULTS);
  return { match: pick === exact ? "exact" : "path", latest: results[0], results };
}

export const VERDICT_OUTPUT_EXAMPLE = {
  url: LISTING_EXAMPLE_URL,
  match: "exact",
  class: "DELIVERED",
  countedAgainstSeller: true,
  reason: "delivered",
  date: "2026-09-29",
  sellerTx: "TXID_SELLER...",
  sellerTxUrl: "https://allo.info/tx/TXID_SELLER...",
  latest: { class: "DELIVERED", reason: "delivered", date: "2026-09-29", method: "GET", url: LISTING_EXAMPLE_URL, paid: true, sellerTx: "TXID_SELLER...", source: "daily" },
  results: [],
  sellerPage: `https://vet402-algorand.vercel.app/seller/${LISTING_EXAMPLE_HOST}`,
  customerPayment: { transaction: "TXID_CUSTOMER...", network: "algorand:...", amount: "1000", payTo: "VET402..." },
  note: "vet402 made no payment to the seller for this answer; it reports its own earlier purchase.",
};

export interface VerdictRouteOptions {
  file?: string;
  load?: BoardLoader;
}

/**
 * Register the paid GET /v1/verdict with its own settle-first middleware. Call BEFORE the main payment
 * middleware (so this route never reaches it) and after the free routes. HEAD is priced like GET and any
 * path other than exactly /v1/verdict is refused before settlement (settle-first.ts, preflight below).
 */
export function registerVerdictLookup(
  app: Hono<SettleFirstEnv>,
  cfg: AppConfig,
  resourceServer: x402ResourceServer,
  payTo: string,
  o: VerdictRouteOptions = {},
): void {
  const file = o.file ?? defaultBoardFile();
  const load = o.load ?? sharedBoardLoader();
  const discovery = declareDiscoveryExtension({
    input: { url: LISTING_EXAMPLE_URL },
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "x402 endpoint to look up in vet402's own purchase records" } },
      required: ["url"],
    },
    output: {
      example: VERDICT_OUTPUT_EXAMPLE,
      schema: {
        type: "object",
        properties: {
          url: { type: "string" },
          match: { type: "string", enum: ["exact", "path"] },
          class: { type: "string", enum: ["DELIVERED", "MISMATCH", "UNREACHABLE", "UNCLEAR"] },
          countedAgainstSeller: { type: "boolean" },
          reason: { type: "string" },
          date: { type: "string" },
          sellerTx: { type: "string" },
          latest: { type: "object" },
          results: { type: "array" },
          customerPayment: { type: "object" },
        },
        required: ["url", "class", "reason", "date", "customerPayment"],
      },
    },
  });
  const httpServer = new x402HTTPResourceServer(resourceServer, {
    [`GET ${VERDICT_PATH}`]: {
      accepts: withBase(
        cfg,
        {
          scheme: "exact",
          price: `$${VERDICT_PRICE_USDC}`,
          network: cfg.network as `${string}:${string}`,
          payTo,
          extra: { asset: cfg.usdcAsaId, tag: cfg.challengeTag },
        },
        `$${VERDICT_PRICE_USDC}`,
      ),
      description:
        "What vet402 found the last time it bought from this x402 URL with its own wallet: DELIVERED, MISMATCH, UNREACHABLE or UNCLEAR, the reason, the day and the vet402 -> seller tx. vet402 pays nobody for this answer. A URL with no result is a free 404.",
      mimeType: "application/json",
      extensions: discovery,
    },
  });

  const outcome = async (c: Context<SettleFirstEnv>): Promise<VerdictOutcome> => {
    const raw = c.req.query("url");
    if (!raw) return { ok: false, status: 400, body: { error: "missing url query parameter" } };
    const u = normalizeTargetUrl(raw);
    if (!u) return { ok: false, status: 400, body: { error: "invalid_url", url: raw.slice(0, 200), detail: "url must be an http(s) URL" } };
    const [daily, census] = await Promise.all([load(file), load(censusFileFor(file))]);
    const lookup = lookupVerdict(u, { daily, census });
    if (!lookup) {
      return {
        ok: false,
        status: 404,
        body: { error: "no_result", url: u.href, detail: "vet402 has no purchase result for this URL. Nothing was charged. GET /v1/check buys it and tells you." },
      };
    }
    return { ok: true, url: u.href, lookup };
  };
  const notFound = (c: Context<SettleFirstEnv>) => c.json({ error: "not_found", path: c.req.path }, 404);
  /** The paid request's lookup, fixed before settlement (kept per request object). */
  const found = new WeakMap<Request, { url: string; lookup: VerdictLookup }>();

  app.use(
    settleFirstMiddleware(httpServer, {
      beforeChallenge: async (c) => {
        if (c.req.path !== VERDICT_PATH) return { stop: notFound(c) };
        const out = await outcome(c);
        if (!out.ok) return { stop: c.json(out.body, out.status) };
        return { info: { lookup: { found: true, match: out.lookup.match, results: out.lookup.results.length } } };
      },
      preflight: async (c) => {
        // Only the exact paid path reaches the handler (/v1/verdict/, /V1/verdict, ... are refused before settlement).
        if (c.req.path !== VERDICT_PATH) return notFound(c);
        const out = await outcome(c);
        if (!out.ok) return c.json(out.body, out.status);
        found.set(c.req.raw, { url: out.url, lookup: out.lookup });
        return null;
      },
    }),
  );

  app.get(VERDICT_PATH, (c) => {
    const customerPayment = c.get("customerPayment");
    // Defence in depth: answer only for a request whose own payment has settled.
    if (!customerPayment) return c.json({ error: "payment_required" }, 402);
    const hit = found.get(c.req.raw);
    if (!hit) return c.json({ error: "lookup_missing", customerPayment }, 500);
    const { latest, results, match } = hit.lookup;
    return c.json(
      {
        url: hit.url,
        match,
        class: latest.class,
        countedAgainstSeller: latest.countedAgainstSeller,
        reason: latest.reason,
        date: latest.date,
        ...(latest.sellerTx ? { sellerTx: latest.sellerTx, sellerTxUrl: latest.sellerTxUrl } : {}),
        ...(latest.class === "UNCLEAR" ? { unclearNote: UNCLEAR_NOTE } : {}),
        latest,
        results,
        sellerPage: `${SELLER_PAGE_BASE}${sellerPath(latest.host)}`,
        customerPayment,
        note: "vet402 made no payment to the seller for this answer; it reports its own earlier purchase.",
      },
      200,
    );
  });
}
