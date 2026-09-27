/**
 * Daily delivery board: GET /board (HTML) and GET /board.json. Free routes.
 *
 * Reads the file written by scripts/board-sweep.ts (default board/latest.json).
 * Every row is one purchase vet402 made with its own payer wallet, or a row it
 * skipped. Nothing on this page is generated: with no file (or no rows) the page
 * says the sweep has not run yet. All strings are escaped; no external JS.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Env, Hono } from "hono";

export type BoardVerdict = "ALLOW" | "REFUSE" | "SKIPPED";

export interface BoardRow {
  /** ISO time the row was decided. */
  at: string;
  url: string;
  host: string;
  method: string;
  /** Short summary of the input vet402 sent (the seller's own Bazaar example). */
  input?: string;
  declared?: { description?: string; mimeType?: string; expectedKeys?: string[] };
  priceUsdc?: string;
  payTo?: string;
  verdict: BoardVerdict;
  /** Reason word from verdict.ts, or daily_cap / cap_check_unavailable for skipped rows. */
  reason: string;
  detail?: string;
  /** true only when the seller's settlement receipt said success. */
  paid: boolean;
  /** vet402 -> seller transaction id. */
  tx?: string;
  delivery?: string;
}

export interface BoardFile {
  version: 1;
  network: string;
  networkName: string;
  /** UTC day of the sweep, YYYY-MM-DD. */
  date: string;
  startedAt: string;
  finishedAt: string;
  payer?: string;
  caps?: { perCallUsdc: string; perDayUsdc: string };
  spentTodayBeforeUsdc?: string;
  selection?: { source: string; candidates: number; excluded: Record<string, number> };
  totals: { rows: number; allow: number; refuse: number; skipped: number; paidUsdc: string };
  /** Set only on hand-made sample files. The page shows it as a banner. */
  fixture?: string;
  rows: BoardRow[];
}

export const BOARD_ISSUES_URL = "https://github.com/kzmttkc/vet402-algorand/issues";

export function defaultBoardFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.BOARD_FILE ?? join(process.cwd(), "board", "latest.json");
}

/** The census file sits next to the daily file. */
export function censusFileFor(dailyFile: string): string {
  return join(dirname(dailyFile), "census-latest.json");
}

const TXID = /^[A-Z2-7]{52}$/;
const VERDICTS: BoardVerdict[] = ["ALLOW", "REFUSE", "SKIPPED"];

function str(v: unknown, max = 300): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function cleanRow(r: unknown): BoardRow | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const verdict = VERDICTS.includes(o.verdict as BoardVerdict) ? (o.verdict as BoardVerdict) : null;
  if (!verdict) return null;
  const d = o.declared && typeof o.declared === "object" ? (o.declared as Record<string, unknown>) : undefined;
  const tx = typeof o.tx === "string" && TXID.test(o.tx) ? o.tx : undefined;
  return {
    at: str(o.at, 40) ?? "",
    url: str(o.url, 500) ?? "",
    host: str(o.host, 200) ?? "",
    method: str(o.method, 10) ?? "GET",
    input: str(o.input, 300),
    declared: d
      ? {
          description: str(d.description, 200),
          mimeType: str(d.mimeType, 80),
          expectedKeys: Array.isArray(d.expectedKeys) ? d.expectedKeys.slice(0, 20).map((k) => str(k, 60) ?? "") : undefined,
        }
      : undefined,
    priceUsdc: str(o.priceUsdc, 20),
    payTo: str(o.payTo, 80),
    verdict,
    reason: str(o.reason, 60) ?? "",
    detail: str(o.detail, 300),
    paid: o.paid === true,
    tx,
    delivery: str(o.delivery, 300),
  };
}

/** Parse and bound a board file. Returns null when absent or unreadable. */
export function parseBoard(text: string): BoardFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.rows)) return null;
  const rows = o.rows.slice(0, 5000).map(cleanRow).filter((r): r is BoardRow => r !== null);
  const t = (o.totals ?? {}) as Record<string, unknown>;
  return {
    version: 1,
    network: str(o.network, 80) ?? "",
    networkName: str(o.networkName, 20) ?? "",
    date: str(o.date, 20) ?? "",
    startedAt: str(o.startedAt, 40) ?? "",
    finishedAt: str(o.finishedAt, 40) ?? "",
    payer: str(o.payer, 80),
    caps: o.caps && typeof o.caps === "object" ? { perCallUsdc: str((o.caps as Record<string, unknown>).perCallUsdc, 20) ?? "", perDayUsdc: str((o.caps as Record<string, unknown>).perDayUsdc, 20) ?? "" } : undefined,
    spentTodayBeforeUsdc: str(o.spentTodayBeforeUsdc, 20),
    selection: o.selection as BoardFile["selection"],
    totals: {
      rows: rows.length,
      allow: rows.filter((r) => r.verdict === "ALLOW").length,
      refuse: rows.filter((r) => r.verdict === "REFUSE").length,
      skipped: rows.filter((r) => r.verdict === "SKIPPED").length,
      paidUsdc: str(t.paidUsdc, 20) ?? "0",
    },
    fixture: str(o.fixture, 200),
    rows,
  };
}

export function readBoard(file: string): BoardFile | null {
  try {
    return parseBoard(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function txLink(tx: string | undefined, networkName: string): string | undefined {
  if (!tx || !TXID.test(tx)) return undefined;
  // allo.info has no TestNet host (testnet.allo.info does not resolve, checked 2026-09-27); TestNet goes to Lora.
  return networkName === "mainnet" ? `https://allo.info/tx/${tx}` : `https://lora.algokit.io/testnet/transaction/${tx}`;
}

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    const p = x.pathname.length > 32 ? x.pathname.slice(0, 31) + "…" : x.pathname;
    return `${x.host}${p}`;
  } catch {
    return u.slice(0, 48);
  }
}

const COLOR: Record<BoardVerdict, string> = { ALLOW: "var(--allow)", REFUSE: "var(--refuse)", SKIPPED: "var(--skip)" };

/** SVG network: vet402 in the middle, one dot per row, played in the order of the file. */
function networkSvg(board: BoardFile | null): { svg: string; cycleMs: number } {
  const rows = board?.rows ?? [];
  const n = rows.length;
  // Whole playback stays under ~8 s (a short vertical video), whatever the row count.
  const step = n > 0 ? Math.min(0.7, 7 / n) : 0;
  const dense = n > 48;
  const dotR = n > 400 ? 2.2 : n > 24 ? 5 : 7;
  const travel = 0.45;
  const start = 0.6;
  const parts: string[] = [];
  rows.forEach((r, i) => {
    // Few rows: one or two rings. Many rows: a sunflower spiral around vet402.
    const ring = dense ? 44 + 140 * Math.sqrt((i + 0.5) / n) : n > 24 ? (i % 2 === 0 ? 132 : 168) : 150;
    const a = dense ? i * 2.39996323 : -Math.PI / 2 + (2 * Math.PI * i) / n;
    const x = +(Math.cos(a) * ring).toFixed(1);
    const y = +(Math.sin(a) * ring).toFixed(1);
    const d = +(start + i * step).toFixed(2);
    const color = COLOR[r.verdict];
    const label = `${shortUrl(r.url)}: ${r.verdict} ${r.reason}`;
    if (n <= 200) parts.push(`<line class="edge" x1="0" y1="0" x2="${x}" y2="${y}"/>`);
    // A light travels only when vet402 actually paid (there is a settled tx).
    if (r.paid) {
      parts.push(`<line class="pulse" pathLength="1" x1="0" y1="0" x2="${x}" y2="${y}" style="stroke:${color};color:${color};--d:${d}s"/>`);
    }
    parts.push(
      `<g class="node" data-i="${i}" tabindex="0" role="button" aria-label="${esc(label)}" style="--d:${(d + travel).toFixed(2)}s">` +
        `<title>${esc(label)}</title>` +
        `<circle class="hit" cx="${x}" cy="${y}" r="${n > 400 ? 4 : 14}"/>` +
        `<circle class="ping" cx="${x}" cy="${y}" r="${dotR}" style="stroke:${color}"/>` +
        `<circle class="dot" cx="${x}" cy="${y}" r="${dotR}" style="fill:${color}"/>` +
        `</g>`,
    );
  });
  const cycleMs = Math.round((start + Math.max(0, n - 1) * step + travel + 0.4) * 1000);
  const svg =
    `<svg id="net" class="play" viewBox="-200 -200 400 400" role="img" aria-label="vet402 and the sellers it bought from">` +
    `<defs><radialGradient id="core"><stop offset="0" stop-color="#1d2a44"/><stop offset="1" stop-color="#0d1322"/></radialGradient></defs>` +
    parts.join("") +
    `<circle class="core" r="30" fill="url(#core)"/>` +
    `<text class="core-t" y="5" text-anchor="middle">vet402</text>` +
    `</svg>`;
  return { svg, cycleMs };
}

function rowsJson(board: BoardFile | null): string {
  const rows = (board?.rows ?? []).map((r) => ({
    url: r.url,
    verdict: r.verdict,
    reason: r.reason,
    detail: r.detail ?? "",
    price: r.priceUsdc ?? "",
    tx: r.tx && TXID.test(r.tx) ? r.tx : "",
    link: txLink(r.tx, board?.networkName ?? "") ?? "",
    at: r.at,
  }));
  // Safe inside <script type="application/json">: no "<" can close the tag.
  return JSON.stringify(rows).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export type BoardView = "daily" | "census";

export function boardHtml(board: BoardFile | null, view: BoardView = "daily"): string {
  const has = !!board && board.rows.length > 0;
  const netLabel = board?.networkName === "mainnet" ? "Algorand MainNet" : board?.networkName === "testnet" ? "Algorand TestNet" : esc(board?.networkName ?? "");
  const { svg, cycleMs } = networkSvg(board);
  const t = board?.totals;
  const what = view === "census" ? "resources" : "sellers";
  const tabs = `<nav class="tabs"><a href="/board"${view === "daily" ? ' aria-current="page"' : ""}>Daily (one per seller)</a><a href="/board?view=census"${view === "census" ? ' aria-current="page"' : ""}>Census (every listed resource)</a></nav>`;
  const headline = has
    ? `<p class="kpi"><span>${esc(board!.date)}</span> · <span>${netLabel}</span> · <b>${t!.rows}</b> ${what} · <b class="a">${t!.allow} ALLOW</b> · <b class="r">${t!.refuse} REFUSE</b> · <b class="s">${t!.skipped} skipped</b> · paid <b>${esc(t!.paidUsdc)}</b> USDC</p>`
    : `<p class="kpi">Not run yet. vet402 has not run a sweep, so there is nothing to show.</p>`;
  const fixture = board?.fixture ? `<p class="fixture">FIXTURE: ${esc(board.fixture)}</p>` : "";
  const tableRows = (board?.rows ?? [])
    .map((r, i) => {
      const link = txLink(r.tx, board!.networkName);
      const tx = link ? `<a href="${esc(link)}" rel="noopener">${esc(r.tx!.slice(0, 8))}…</a>` : "—";
      const decl = [r.declared?.description, r.declared?.expectedKeys?.length ? `keys: ${r.declared.expectedKeys.join(", ")}` : ""].filter(Boolean).join(" · ");
      return (
        `<tr id="row-${i}"><td>${esc(r.at.slice(11, 19))}</td>` +
        `<td class="u"><span class="h">${esc(r.method)} ${esc(shortUrl(r.url))}</span>${decl ? `<br><small>${esc(decl)}</small>` : ""}${r.input ? `<br><small>sent: ${esc(r.input)}</small>` : ""}</td>` +
        `<td>${esc(r.priceUsdc ?? "")}</td>` +
        `<td class="v ${r.verdict.toLowerCase()}">${esc(r.verdict)}</td>` +
        `<td><code>${esc(r.reason)}</code>${r.detail ? `<br><small>${esc(r.detail)}</small>` : ""}</td>` +
        `<td>${tx}</td></tr>`
      );
    })
    .join("");
  const table = has
    ? `<div class="tw"><table><thead><tr><th>UTC</th><th>seller (declared)</th><th>USDC</th><th>verdict</th><th>reason</th><th>vet402 → seller tx</th></tr></thead><tbody>${tableRows}</tbody></table></div>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>vet402 delivery board</title>
<meta name="description" content="Each day vet402 buys once from active x402 sellers on Algorand with its own money and records whether the delivery matched the declaration.">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<style>
:root{--bg:#0a0e17;--fg:#e8ecf3;--mut:#8a93a6;--line:rgba(255,255,255,.09);--allow:#34d399;--refuse:#f87171;--skip:#6b7280;--card:#111827}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}
a{color:#93c5fd}
.hero{padding:20px 16px 8px;max-width:760px;margin:0 auto;text-align:center}
.hero h1{font-size:20px;margin:0 0 4px;letter-spacing:.01em}
.tabs{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin:0 0 10px;font-size:13px}
.tabs a{padding:3px 10px;border:1px solid var(--line);border-radius:999px;color:var(--mut);text-decoration:none}
.tabs a[aria-current]{color:var(--fg);border-color:#60a5fa}
.kpi{margin:4px 0 0;color:var(--mut);font-size:14px}
.kpi b{color:var(--fg);white-space:nowrap} .kpi .a{color:var(--allow)} .kpi .r{color:var(--refuse)} .kpi .s{color:var(--skip)}
.fixture{display:inline-block;margin:8px 0 0;padding:2px 8px;border:1px solid #f59e0b;color:#f59e0b;border-radius:4px;font-size:13px}
#net{display:block;width:100%;max-width:520px;margin:6px auto 0;height:auto;overflow:visible}
.edge{stroke:var(--line);stroke-width:1}
.pulse{stroke-width:3;stroke-linecap:round;stroke-dasharray:.16 1.4;stroke-dashoffset:-1.2;opacity:0;filter:drop-shadow(0 0 4px currentColor)}
.core{stroke:#60a5fa;stroke-width:1.5}
.core-t{fill:#dbeafe;font:600 12px system-ui,sans-serif}
.node{cursor:pointer;outline:none}
.hit{fill:transparent}
.dot{transform-box:fill-box;transform-origin:center}
.ping{fill:none;stroke-width:2;opacity:0;transform-box:fill-box;transform-origin:center}
.node:focus .dot,.node.sel .dot{stroke:#fff;stroke-width:2}
.play .pulse{animation:run .45s linear var(--d) both}
.play .dot{animation:settle .35s ease-out var(--d) both}
.play .ping{animation:ping .9s ease-out var(--d) both}
@keyframes run{0%{stroke-dashoffset:.16;opacity:1}90%{opacity:1}100%{stroke-dashoffset:-1;opacity:0}}
@keyframes settle{0%{fill:#1f2937;transform:scale(.55)}60%{transform:scale(1.35)}100%{transform:scale(1)}}
@keyframes ping{0%{opacity:0;transform:scale(1)}1%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(3)}}
@media (prefers-reduced-motion:reduce){.play .pulse,.play .dot,.play .ping{animation:none}}
.legend{color:var(--mut);font-size:13px;margin:2px 0 0}
.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin:0 4px 0 10px;vertical-align:middle}
#detail{max-width:520px;margin:8px auto 0;min-height:3.2em;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);font-size:14px;text-align:left;overflow-wrap:anywhere}
main{max-width:980px;margin:0 auto;padding:8px 16px 40px}
.method{color:#cbd5e1;max-width:760px}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--mut);font-weight:600;white-space:nowrap}
td.u{min-width:220px;overflow-wrap:anywhere}
small{color:var(--mut)}
code{font-size:12px}
.v.allow{color:var(--allow)} .v.refuse{color:var(--refuse)} .v.skipped{color:var(--skip)}
tr.sel td{background:#172033}
</style>
</head><body>
<section class="hero">
${tabs}
<h1>vet402 bought it. Did it arrive?</h1>
${headline}
${fixture}
${svg}
<p class="legend"><i style="background:var(--allow)"></i>ALLOW<i style="background:var(--refuse)"></i>REFUSE<i style="background:var(--skip)"></i>skipped · a light = vet402 paid the seller on-chain</p>
<div id="detail" aria-live="polite">${has ? "Tap a dot to see that purchase." : "Not run yet."}</div>
</section>
<main>
<p class="method">What this is: vet402 bought from each seller once, with its own money, and compared what came back with what the seller declared (Bazaar description, output schema or example). It sent the example input the seller published. One result does not rate a seller: a single purchase can fail for reasons on either side. Reason codes are shown as they are. If a row is wrong, please open a <a href="${BOARD_ISSUES_URL}" rel="noopener">GitHub issue</a>.</p>
${table}
<p><small><a href="/board.json${view === "census" ? "?view=census" : ""}">board.json</a> · <a href="/">vet402</a> · per call cap ${esc(board?.caps?.perCallUsdc ?? "")} USDC, per day cap ${esc(board?.caps?.perDayUsdc ?? "")} USDC${board?.payer ? ` · payer <code>${esc(board.payer)}</code>` : ""}</small></p>
</main>
<script type="application/json" id="rows">${rowsJson(board)}</script>
<script>
(function(){
  var rows=[];try{rows=JSON.parse(document.getElementById('rows').textContent||'[]')}catch(e){}
  var det=document.getElementById('detail'),net=document.getElementById('net');
  function show(i){
    var r=rows[i];if(!r)return;
    document.querySelectorAll('.node.sel,tr.sel').forEach(function(e){e.classList.remove('sel')});
    var n=document.querySelector('.node[data-i="'+i+'"]');if(n)n.classList.add('sel');
    var tr=document.getElementById('row-'+i);if(tr)tr.classList.add('sel');
    det.textContent='';
    var b=document.createElement('b');b.textContent=r.verdict+' · '+r.reason;det.appendChild(b);
    det.appendChild(document.createElement('br'));
    det.appendChild(document.createTextNode(r.url+(r.price?' · '+r.price+' USDC':'')));
    if(r.detail){det.appendChild(document.createElement('br'));det.appendChild(document.createTextNode(r.detail))}
    det.appendChild(document.createElement('br'));
    if(r.link){var a=document.createElement('a');a.href=r.link;a.rel='noopener';a.textContent='tx '+r.tx;det.appendChild(a)}
    else det.appendChild(document.createTextNode('no payment was made'));
  }
  document.querySelectorAll('.node').forEach(function(n){
    n.addEventListener('click',function(){show(+n.getAttribute('data-i'))});
    n.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();show(+n.getAttribute('data-i'))}});
  });
  var still=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!still&&rows.length&&net){setInterval(function(){net.classList.remove('play');void net.getBoundingClientRect();net.classList.add('play')},${cycleMs + 2500})}
})();
</script>
</body></html>`;
}

/** Register the free board routes. Call before the payment middleware. */
export function registerBoard<E extends Env>(app: Hono<E>, file: string = defaultBoardFile()): void {
  const pick = (v: string | undefined): { view: BoardView; path: string } =>
    v === "census" ? { view: "census", path: censusFileFor(file) } : { view: "daily", path: file };
  app.get("/board.json", (c) => {
    const { path } = pick(c.req.query("view"));
    c.header("cache-control", "public, max-age=300");
    return c.json(readBoard(path) ?? { version: 1, rows: [], note: "not run yet" });
  });
  app.get("/board", (c) => {
    const { view, path } = pick(c.req.query("view"));
    c.header("cache-control", "public, max-age=300");
    return c.html(boardHtml(readBoard(path), view));
  });
}
