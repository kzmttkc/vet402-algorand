/**
 * Per-seller evidence page and README badge. Free routes (mounted before the payment middleware).
 *
 *   GET /seller/:host       what vet402 last saw from this seller (daily + census files), one card per resource
 *   GET /badge/:host.svg    shields-style badge: delivered <date> / mismatch / unreachable / unclear / not checked
 *
 * Reads the same files as /board through the same loader (board/latest.json and board/census-latest.json,
 * or GitHub raw), and classifies rows with board.ts displayClass(). The host is checked against a strict
 * pattern before anything is read (400 otherwise). Every string that came from a seller or a file is escaped.
 */
import type { Env, Hono } from "hono";
import {
  BOARD_ISSUES_URL,
  censusFileFor,
  defaultBoardFile,
  displayClass,
  esc,
  hostOf,
  isBoardDate,
  sharedBoardLoader,
  txLink,
  type BoardFile,
  type BoardLoader,
  type BoardRow,
  type DisplayClass,
  UNCLEAR_NOTE,
} from "./board.js";
import { certificateCtaHtml } from "./cert.js";

/** Public base URL used in the badge Markdown. */
export const SELLER_PAGE_BASE = "https://vet402-algorand.vercel.app";
/** What /seller pages say about the paid re-check (from AppConfig). Off = the box is not shown. */
export interface SellerPageOptions {
  auditLinkEnabled: boolean;
  auditPriceUsdc: string;
}
const AUDIT_OFF: SellerPageOptions = { auditLinkEnabled: false, auditPriceUsdc: "" };
export const PERA_URL = "https://perawallet.app";

/**
 * A DNS host name only: lowercase labels of [a-z0-9-] (no leading/trailing hyphen, 1–63 chars),
 * at least one dot, a TLD that starts with a letter (so no bare IPs), 253 chars at most. No port, no path.
 */
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lowercased host if valid, else null. */
export function parseHost(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const h = v.toLowerCase();
  return HOST_RE.test(h) ? h : null;
}

export interface SellerRow extends BoardRow {
  cls: DisplayClass;
  /** Which sweep recorded it. */
  source: "daily" | "census";
  /** UTC day of the row (from `at`, else the file's date). */
  day: string;
}

export interface SellerView {
  host: string;
  /** Latest row per resource (method + URL). */
  rows: SellerRow[];
  /** Badge class: null = not checked (no row, or only rows vet402 skipped without contacting the seller). */
  cls: DisplayClass | null;
  /** Latest day with a DELIVERED row (for "delivered <day>"). */
  deliveredDay?: string;
  counts: Record<DisplayClass, number>;
  networkName: string;
}

function dayOf(r: BoardRow, file: BoardFile): string {
  const d = r.at.slice(0, 10);
  return isBoardDate(d) ? d : isBoardDate(file.date) ? file.date : "";
}

/** Latest row per resource for one host, from the daily and census files. */
export function sellerView(host: string, files: { daily: BoardFile | null; census: BoardFile | null }): SellerView {
  const latest = new Map<string, SellerRow>();
  let networkName = "";
  for (const [source, f] of [
    ["census", files.census],
    ["daily", files.daily],
  ] as const) {
    if (!f) continue;
    for (const r of f.rows) {
      if (hostOf(r).toLowerCase() !== host) continue;
      networkName ||= f.networkName;
      const row: SellerRow = { ...r, cls: displayClass(r), source, day: dayOf(r, f) };
      const key = `${r.method} ${r.url}`;
      const prev = latest.get(key);
      // A row with a result beats a SKIPPED row (vet402 never contacted the seller), whatever the time; then the newest wins.
      const rank = (x: SellerRow) => (x.verdict === "SKIPPED" ? 0 : 1);
      if (!prev || rank(row) > rank(prev) || (rank(row) === rank(prev) && (row.at || row.day) > (prev.at || prev.day))) latest.set(key, row);
    }
  }
  const order: Record<DisplayClass, number> = { DELIVERED: 0, MISMATCH: 1, UNCLEAR: 2, UNREACHABLE: 3 };
  const rows = [...latest.values()].sort((a, b) => order[a.cls] - order[b.cls] || a.url.localeCompare(b.url));
  const counts: Record<DisplayClass, number> = { DELIVERED: 0, MISMATCH: 0, UNREACHABLE: 0, UNCLEAR: 0 };
  const contacted = rows.filter((r) => r.verdict !== "SKIPPED");
  for (const r of contacted) counts[r.cls]++;
  // Same rule as the board's seller summary: delivered wins, then on hold, then mismatch, then unreachable.
  const cls: DisplayClass | null =
    contacted.length === 0 ? null : counts.DELIVERED > 0 ? "DELIVERED" : counts.UNCLEAR > 0 ? "UNCLEAR" : counts.MISMATCH > 0 ? "MISMATCH" : "UNREACHABLE";
  const deliveredDay = contacted
    .filter((r) => r.cls === "DELIVERED")
    .map((r) => r.day)
    .filter(isBoardDate)
    .sort()
    .pop();
  return { host, rows, cls, deliveredDay, counts, networkName };
}

const BADGE: Record<DisplayClass | "NONE", { color: string; word: string }> = {
  DELIVERED: { color: "#2e9e4f", word: "delivered" },
  MISMATCH: { color: "#d73a3a", word: "mismatch" },
  UNREACHABLE: { color: "#8a8f98", word: "unreachable" },
  // Grey, never red: an UNCLEAR result is not held against the seller.
  UNCLEAR: { color: "#9f9f9f", word: "unclear" },
  NONE: { color: "#8a8f98", word: "not checked" },
};

/** Rough Verdana 11px width, enough for a badge. */
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[mw]/.test(ch) ? 9 : /[il.1 -]/.test(ch) ? 4 : /[0-9]/.test(ch) ? 7 : 6.5;
  return Math.ceil(w);
}

export function badgeText(v: Pick<SellerView, "cls" | "deliveredDay">): string {
  const b = BADGE[v.cls ?? "NONE"];
  return v.cls === "DELIVERED" && v.deliveredDay && isBoardDate(v.deliveredDay) ? `${b.word} ${v.deliveredDay}` : b.word;
}

export function badgeSvg(v: Pick<SellerView, "cls" | "deliveredDay">): string {
  const left = "vet402";
  const right = badgeText(v);
  const color = BADGE[v.cls ?? "NONE"].color;
  const lw = textWidth(left) + 12;
  const rw = textWidth(right) + 12;
  const w = lw + rw;
  const label = esc(`${left}: ${right}`);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}">` +
    `<title>${label}</title>` +
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(left)}</text><text x="${lw / 2}" y="14">${esc(left)}</text>` +
    `<text x="${lw + rw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(right)}</text><text x="${lw + rw / 2}" y="14">${esc(right)}</text>` +
    `</g></svg>`
  );
}

export function badgeMarkdown(host: string, base = SELLER_PAGE_BASE): string {
  const h = encodeURIComponent(host);
  return `[![vet402](${base}/badge/${h}.svg)](${base}/seller/${h})`;
}

const CSS_CLASS: Record<DisplayClass, string> = { DELIVERED: "delivered", MISMATCH: "mismatch", UNREACHABLE: "unreach", UNCLEAR: "unclear" };

function pathOf(u: string): string {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
}

export function sellerHtml(v: SellerView, o: SellerPageOptions = AUDIT_OFF): string {
  const h = esc(v.host);
  const enc = encodeURIComponent(v.host);
  const summary = v.cls
    ? `<p class="kpi">Latest: <b class="${CSS_CLASS[v.cls]}">${esc(badgeText(v))}</b> · ${v.rows.length} resource${v.rows.length === 1 ? "" : "s"} · ` +
      `<span class="delivered">${v.counts.DELIVERED} delivered</span> · <span class="mismatch">${v.counts.MISMATCH} mismatch</span> · ` +
      `<span class="unreach">${v.counts.UNREACHABLE} unreachable</span> · <span class="unclear">${v.counts.UNCLEAR} unclear</span></p>`
    : `<p class="kpi">Not checked yet: vet402 has no purchase from this seller on the board.</p>`;
  const cards = v.rows
    .map((r) => {
      const link = txLink(r.tx, v.networkName);
      const decl = [r.declared?.description, r.declared?.expectedKeys?.length ? `keys: ${r.declared.expectedKeys.join(", ")}` : ""].filter(Boolean).join(" · ");
      return (
        `<li class="card"><div class="top"><b class="${CSS_CLASS[r.cls]}">${r.cls}</b><span>${esc(r.day)} · ${r.source}${r.priceUsdc ? ` · ${esc(r.priceUsdc)} USDC` : ""}</span></div>` +
        `<div class="u">${esc(r.method)} ${esc(pathOf(r.url))}</div>` +
        (decl ? `<small>${esc(decl)}</small>` : "") +
        `<div>reason <code>${esc(r.reason)}</code>${r.detail ? ` <small>${esc(r.detail)}</small>` : ""}</div>` +
        (r.cls === "UNCLEAR" ? `<div><small class="nc">${esc(UNCLEAR_NOTE)}</small></div>` : "") +
        `<div>vet402 → seller tx: ${link ? `<a href="${esc(link)}" rel="noopener">${esc(r.tx)}</a>` : "no payment was made"}</div>` +
        `</li>`
      );
    })
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h} · vet402</title>
<meta name="description" content="What vet402 received when it bought from ${h} on Algorand: one purchase per listed resource, with the on-chain payment.">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<style>
:root{--bg:#0a0e17;--fg:#e8ecf3;--mut:#8a93a6;--line:rgba(255,255,255,.09);--card:#111827;--delivered:#34d399;--mismatch:#f87171;--unreach:#9ca3af;--unclear:#f59e0b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}
a{color:#93c5fd;overflow-wrap:anywhere}
main{max-width:760px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:20px;margin:0 0 4px;overflow-wrap:anywhere}
.kpi{margin:4px 0 12px;color:var(--mut)}
.delivered{color:var(--delivered)} .mismatch{color:var(--mismatch)} .unreach{color:var(--unreach)} .unclear{color:var(--unclear)}
.box{border:1px solid var(--line);border-radius:8px;background:var(--card);padding:10px 12px;margin:0 0 12px}
.box p{margin:4px 0}
pre{margin:6px 0 0;padding:8px;background:#0b1220;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-all;font-size:12px}
code{font-size:12px;overflow-wrap:anywhere}
small{color:var(--mut);overflow-wrap:anywhere}
ul{list-style:none;padding:0;margin:0}
.card{border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:0 0 8px;font-size:14px;overflow-wrap:anywhere}
.card .top{display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap}
.card .top span{color:var(--mut);font-size:13px}
.u{font-family:ui-monospace,monospace;font-size:13px}
.method{color:#cbd5e1}
</style>
</head><body><main>
<p><small><a href="/board">delivery board</a> › seller</small></p>
<h1>${h}</h1>
<p><img src="/badge/${esc(enc)}.svg" alt="vet402: ${esc(badgeText(v))}" height="20"></p>
${summary}
${
  o.auditLinkEnabled
    ? `${certificateCtaHtml(v.host, o.auditPriceUsdc).replace(/<\/div>$/, "")}
<p><small>No USDC on Algorand? In the Pera Wallet app you can buy USDC with a card: <a href="${PERA_URL}" rel="noopener">perawallet.app</a></small></p>
</div>
`
    : ""
}<div class="box">
<p>Badge for your README (Markdown):</p>
<pre><code>${esc(badgeMarkdown(v.host))}</code></pre>
</div>
<p class="method">Each result below is one purchase: vet402 bought the resource once with its own money, sent the example input the seller published, and compared the response with the seller's declaration. One purchase can go wrong for reasons on either side, so this is not a rating. UNCLEAR results are not counted against the seller. If something here is wrong, please open a <a href="${BOARD_ISSUES_URL}" rel="noopener">GitHub issue</a>.</p>
<ul>${cards}</ul>
<p><small><a href="/board?view=census">census</a> · <a href="/board">daily board</a> · <a href="/">vet402</a></small></p>
</main></body></html>`;
}

/** Register GET /seller/:host and GET /badge/:host.svg. Call before the payment middleware. */
export function registerSeller<E extends Env>(
  app: Hono<E>,
  o: SellerPageOptions = AUDIT_OFF,
  file: string = defaultBoardFile(),
  load: BoardLoader = sharedBoardLoader(),
): void {
  const page: SellerPageOptions = { auditLinkEnabled: o.auditLinkEnabled, auditPriceUsdc: o.auditPriceUsdc };
  const view = async (host: string) => {
    const [daily, census] = await Promise.all([load(file), load(censusFileFor(file))]);
    return sellerView(host, { daily, census });
  };
  app.get("/seller/:host", async (c) => {
    const host = parseHost(c.req.param("host"));
    if (!host) return c.text("invalid host", 400, { "cache-control": "no-store" });
    c.header("cache-control", "public, max-age=300");
    return c.html(sellerHtml(await view(host), page));
  });
  app.get("/badge/:file", async (c) => {
    const f = c.req.param("file");
    const host = f.endsWith(".svg") ? parseHost(f.slice(0, -4)) : null;
    if (!host) return c.text("invalid host", 400, { "cache-control": "no-store" });
    return c.body(badgeSvg(await view(host)), 200, {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    });
  });
}
