/**
 * "What to fix first": the census rows that did not deliver, grouped by failure mode.
 * GET /board/fix-first (HTML) and GET /board/fix-first.json. Free routes, read-only.
 *
 * Every group comes from the reason and detail vet402 recorded (verdict.ts reasons, the
 * status code in "expected 402, got N" / "status N, ..." and the delivery status line).
 * A row the table does not know goes to "other", so the groups always add up to the rows
 * that did not deliver. Nothing here pays, probes or writes; it only reads a board file.
 */
import type { Env, Hono } from "hono";
import {
  CENSUS_DATES,
  DISPLAY_CLASSES,
  censusFileFor,
  defaultBoardFile,
  displayClass,
  esc,
  hostOf,
  notSent,
  sellerPath,
  sharedBoardLoader,
  type BoardFile,
  type BoardLoader,
  type BoardRow,
  type DisplayClass,
} from "./board.js";

export type FixSide = "seller" | "vet402" | "unsorted";

export interface FixMode {
  key: string;
  title: string;
  /** What vet402 saw, in plain words. */
  what: string;
  /** One line for the builder. */
  fix: string;
  side: FixSide;
  /** 1 = a listing or config change, 2 = a server change, 3 = depends on someone else (facilitator). */
  effort: 1 | 2 | 3;
}

/** Order here is only the tie-break after hosts and effort. */
export const FIX_MODES: readonly FixMode[] = [
  {
    key: "gone",
    title: "The listed URL is gone",
    what: "The URL answered 404 or 410, or its host no longer resolves.",
    fix: "Remove the listing from the Bazaar, or put the endpoint back at that URL.",
    side: "seller",
    effort: 1,
  },
  {
    key: "unreadable_402",
    title: "A 402 the stock x402 client cannot read",
    what: "The URL answered 402, but the payment requirements were only in the body or could not be read.",
    fix: "Serve the 402 in the PAYMENT-REQUIRED header; the stock v2 client does not read the body.",
    side: "seller",
    effort: 1,
  },
  {
    key: "example_rejected",
    title: "The published example input was rejected",
    what: "The request with the seller's own example input got 400, 404 or 422 (before or after payment).",
    fix: "Publish an example input that works as written: real values, not ADDRESS, [symbol] or an empty body.",
    side: "seller",
    effort: 1,
  },
  {
    key: "example_placeholder",
    title: "The example input is a placeholder",
    what: "The example has a placeholder vet402 does not make up (an address, key, token…), so nothing was sent.",
    fix: "Replace the placeholder in the listing's example with a real value that works.",
    side: "seller",
    effort: 1,
  },
  {
    key: "missing_keys",
    title: "The response did not match the listing",
    what: "vet402 paid and got JSON, but keys the listing declared were missing.",
    fix: "Make the listing's output schema match what the route returns; mark as required only keys it always sends.",
    side: "seller",
    effort: 1,
  },
  {
    key: "not_json",
    title: "The paid response was not JSON",
    what: "vet402 paid and got a 200 that was not JSON (or was empty).",
    fix: "Return JSON, or declare the real mimeType (for example image/png) in the listing.",
    side: "seller",
    effort: 1,
  },
  {
    key: "wrong_method",
    title: "The listed method is not accepted",
    what: "The URL answered 405 to the method the listing gives.",
    fix: "List the method the route accepts (GET or POST), or accept the listed one.",
    side: "seller",
    effort: 1,
  },
  {
    key: "free_200",
    title: "Answered 200 without asking for payment",
    what: "The URL answered 200 to an unpaid request.",
    fix: "Answer 402 until the request is paid, or remove the URL from the paid listing.",
    side: "seller",
    effort: 1,
  },
  {
    key: "no_accept",
    title: "No Algorand MainNet USDC option",
    what: "The 402 had no exact accept for USDC on Algorand MainNet.",
    fix: "Add an exact accept for Algorand MainNet USDC (ASA 31566704).",
    side: "seller",
    effort: 1,
  },
  {
    key: "auth",
    title: "Asks for its own login or key",
    what: "The URL answered 401 or 403 (before or after payment).",
    fix: "Let the x402 payment be enough: answer 402 to an unpaid request and the data to a paid one.",
    side: "seller",
    effort: 2,
  },
  {
    key: "down",
    title: "Server error before payment",
    what: "The URL answered 5xx (for example 503) before any payment.",
    fix: "Bring the server back up, or remove the listing while it is down.",
    side: "seller",
    effort: 2,
  },
  {
    key: "server_error_paid",
    title: "Server error on the paid request",
    what: "The paid request got 5xx.",
    fix: "Check the route's logs: the handler or its upstream failed on the paid request.",
    side: "seller",
    effort: 2,
  },
  {
    key: "no_receipt",
    title: "Answered 200 but sent no settlement receipt",
    what: "The paid request got a 200 with no settlement receipt, so the payment was not shown as settled.",
    fix: "Settle the payment and return the PAYMENT-RESPONSE header with the 200.",
    side: "seller",
    effort: 2,
  },
  {
    key: "rate_limited",
    title: "Rate-limited the paid request",
    what: "The request got 429 Too Many Requests.",
    fix: "Let paid requests through the rate limiter; a valid payment should not get a 429.",
    side: "seller",
    effort: 2,
  },
  {
    key: "timeout",
    title: "No answer in time",
    what: "The request timed out or the connection failed.",
    fix: "Make the route answer within a few seconds; look for slow upstream calls or cold starts.",
    side: "seller",
    effort: 2,
  },
  {
    key: "facilitator_quota",
    title: "The facilitator's sub-cent quota ran out",
    what: "The facilitator refused to settle with subcent_quota_exceeded.",
    fix: "Ask your facilitator about its sub-cent settlement quota for this payTo.",
    side: "seller",
    effort: 3,
  },
  {
    key: "payment_refused",
    title: "A signed payment got 402 again",
    what: "vet402 sent a signed payment and the server answered 402 again without settling.",
    fix: "Check the route's verify/settle step and return the facilitator's error as errorReason.",
    side: "seller",
    effort: 3,
  },
  {
    key: "vet402_limit",
    title: "vet402's own limits",
    what: "vet402 did not buy: the price was over its per-call cap, its daily cap was reached, or the row was skipped.",
    fix: "Nothing for the seller to fix.",
    side: "vet402",
    effort: 1,
  },
  {
    key: "other",
    title: "Other",
    what: "A reason this page does not group yet.",
    fix: "See the seller page for the recorded reason.",
    side: "unsorted",
    effort: 3,
  },
];

const MODE = new Map(FIX_MODES.map((m) => [m.key, m]));

const VET402_LIMIT_REASONS = new Set(["price_over_cap", "daily_cap_reached", "cap_check_unavailable", "self_dealing", "daily_cap"]);

/** The status code at the start of a string ("expected 402, got 503", "status 429, …", "502 application/json …"). */
function statusIn(s: string | undefined, re: RegExp): number | undefined {
  const m = re.exec(s ?? "");
  return m ? Number(m[1]) : undefined;
}

function byStatus(code: number | undefined, paid: boolean): string {
  if (code === undefined) return "other";
  if (code === 400 || code === 422) return "example_rejected";
  if (code === 404) return paid ? "example_rejected" : "gone";
  if (code === 410) return "gone";
  if (code === 401 || code === 403) return "auth";
  if (code === 405) return "wrong_method";
  if (code === 408) return "timeout";
  if (code === 429) return "rate_limited";
  if (code >= 500 && code < 600) return paid ? "server_error_paid" : "down";
  return "other";
}

const TIMEOUT = /aborted due to timeout|timed out|timeout|fetch failed|ECONNRESET|ECONNREFUSED|socket hang up/i;

/**
 * The failure mode of one row that did not deliver (DELIVERED rows return null).
 * "Before payment" = the unpaid look (not_x402 "expected 402, got N"); "paid request" = payment_failed
 * "status N, …" and http_error (the status is the first number of `delivery`).
 */
export function failureMode(r: Pick<BoardRow, "verdict" | "reason" | "detail" | "paid" | "delivery">): string | null {
  if (displayClass(r) === "DELIVERED") return null;
  if (r.verdict === "SKIPPED") return "vet402_limit";
  if (notSent(r)) return "example_placeholder";
  if (VET402_LIMIT_REASONS.has(r.reason)) return "vet402_limit";
  switch (r.reason) {
    case "not_x402": {
      if (/without parseable x402 payment requirements/.test(r.detail ?? "")) return "unreadable_402";
      const code = statusIn(r.detail, /^expected 402, got (\d{3})\b/);
      if (code !== undefined && code >= 200 && code < 300) return "free_200";
      return byStatus(code, false);
    }
    case "requirements_body_only":
      return "unreadable_402";
    case "invalid_target":
      return /does not resolve/.test(r.detail ?? "") ? "gone" : "other";
    case "no_supported_accept":
      return "no_accept";
    case "payment_failed": {
      const d = r.detail ?? "";
      const code = statusIn(d, /^status (\d{3})\b/);
      if (code === undefined) return TIMEOUT.test(d) ? "timeout" : "other";
      if (code === 402) return /subcent_quota_exceeded/.test(d) ? "facilitator_quota" : "payment_refused";
      if (code >= 200 && code < 300) return "no_receipt";
      return byStatus(code, true);
    }
    case "probe_error":
      return TIMEOUT.test(r.detail ?? "") ? "timeout" : "other";
    case "http_error":
      return byStatus(statusIn(r.delivery, /^(\d{3})\b/), true);
    case "not_json":
    case "empty_body":
      return "not_json";
    case "delivery_missing_keys":
      return "missing_keys";
    default:
      return "other";
  }
}

export interface FixSeller {
  host: string;
  listings: number;
  sellerPage: string;
}

export interface FixGroup extends FixMode {
  listings: number;
  hosts: number;
  /** How the board shows these rows (DELIVERED is always 0). */
  byClass: Record<DisplayClass, number>;
  /** Recorded reason words in this group, with counts. */
  reasons: Record<string, number>;
  /** Up to 3 distinct recorded details, most common first (seller-controlled text: escape it). */
  seen: string[];
  sellers: FixSeller[];
}

export interface FixFirst {
  version: 1;
  date: string;
  network: string;
  networkName: string;
  rows: number;
  delivered: number;
  notDelivered: number;
  byClass: Record<DisplayClass, number>;
  groups: FixGroup[];
}

function zero(): Record<DisplayClass, number> {
  return Object.fromEntries(DISPLAY_CLASSES.map((c) => [c, 0])) as Record<DisplayClass, number>;
}

const SIDE_ORDER: Record<FixSide, number> = { seller: 0, vet402: 1, unsorted: 2 };

/** Seller groups first: most hosts, then the easier fix, then most listings. vet402's own groups, then "other", last. */
export function fixFirst(board: BoardFile): FixFirst {
  const acc = new Map<string, { rows: BoardRow[]; hosts: Map<string, number>; details: Map<string, number> }>();
  const byClass = zero();
  let delivered = 0;
  for (const r of board.rows) {
    const cls = displayClass(r);
    byClass[cls]++;
    const key = failureMode(r);
    if (key === null) {
      delivered++;
      continue;
    }
    let a = acc.get(key);
    if (!a) acc.set(key, (a = { rows: [], hosts: new Map(), details: new Map() }));
    a.rows.push(r);
    const h = hostOf(r);
    a.hosts.set(h, (a.hosts.get(h) ?? 0) + 1);
    const d = (r.detail ?? "").slice(0, 160);
    if (d) a.details.set(d, (a.details.get(d) ?? 0) + 1);
  }
  const groups: FixGroup[] = [...acc.entries()].map(([key, a]) => {
    const mode = MODE.get(key) ?? MODE.get("other")!;
    const reasons: Record<string, number> = {};
    const cls = zero();
    for (const r of a.rows) {
      reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
      cls[displayClass(r)]++;
    }
    const sellers = [...a.hosts.entries()]
      .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
      .map(([host, listings]) => ({ host, listings, sellerPage: sellerPath(host) }));
    const seen = [...a.details.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 3).map(([d]) => d);
    return { ...mode, listings: a.rows.length, hosts: a.hosts.size, byClass: cls, reasons, seen, sellers };
  });
  const order = new Map(FIX_MODES.map((m, i) => [m.key, i]));
  groups.sort(
    (a, b) =>
      SIDE_ORDER[a.side] - SIDE_ORDER[b.side] ||
      b.hosts - a.hosts ||
      a.effort - b.effort ||
      b.listings - a.listings ||
      (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0),
  );
  return {
    version: 1,
    date: board.date,
    network: board.network,
    networkName: board.networkName,
    rows: board.rows.length,
    delivered,
    notDelivered: board.rows.length - delivered,
    byClass,
    groups,
  };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

const EFFORT_LABEL: Record<FixMode["effort"], string> = { 1: "listing or config change", 2: "server change", 3: "needs the facilitator" };
const HOSTS_SHOWN = 12;

function sellerLinks(g: FixGroup): string {
  const link = (s: FixSeller) => `<li><a href="${esc(s.sellerPage)}">${esc(s.host)}</a> <small>${fmt(s.listings)}</small></li>`;
  const first = g.sellers.slice(0, HOSTS_SHOWN).map(link).join("");
  const rest = g.sellers.slice(HOSTS_SHOWN);
  return (
    `<ul class="hosts">${first}</ul>` +
    (rest.length ? `<details><summary>${fmt(rest.length)} more sellers</summary><ul class="hosts">${rest.map(link).join("")}</ul></details>` : "")
  );
}

function classLine(c: Record<DisplayClass, number>): string {
  return DISPLAY_CLASSES.filter((k) => c[k] > 0)
    .map((k) => `${fmt(c[k])} ${k}`)
    .join(" · ");
}

function groupCard(g: FixGroup, i: number, date: string): string {
  const note =
    g.key === "missing_keys" && date < "2026-09-28"
      ? `<p class="what"><small>Census days before 2026-09-28 also counted example keys as promised; from 09-28 only required keys count.</small></p>`
      : "";
  return (
    `<li class="g ${g.side}" id="${esc(g.key)}">` +
    `<h2><span class="n">${i + 1}</span> ${esc(g.title)}</h2>` +
    `<p class="cnt"><b>${fmt(g.hosts)}</b> ${g.hosts === 1 ? "seller" : "sellers"} · <b>${fmt(g.listings)}</b> ${g.listings === 1 ? "listing" : "listings"}${g.side === "seller" ? ` · <small>${EFFORT_LABEL[g.effort]}</small>` : ""}</p>` +
    `<p class="fix">${g.side === "seller" ? "Fix: " : ""}${esc(g.fix)}</p>` +
    `<p class="what">${esc(g.what)}</p>` +
    note +
    (g.seen.length ? `<p class="what"><small>Recorded: ${g.seen.map((d) => `<code>${esc(d)}</code>`).join(" · ")}</small></p>` : "") +
    `<p class="what"><small>On the board: ${esc(classLine(g.byClass))} · reason ${Object.keys(g.reasons)
      .sort()
      .map((r) => `<code>${esc(r)}</code>`)
      .join(", ")}</small></p>` +
    sellerLinks(g) +
    `</li>`
  );
}

export function fixFirstHtml(board: BoardFile | null, o: { date?: string; censusDates?: readonly string[] } = {}): string {
  const has = !!board && board.rows.length > 0;
  const ff = has ? fixFirst(board!) : null;
  const seller = ff?.groups.filter((g) => g.side === "seller") ?? [];
  const ours = ff?.groups.filter((g) => g.side === "vet402") ?? [];
  const unsorted = ff?.groups.filter((g) => g.side === "unsorted") ?? [];
  const days = [...(o.censusDates ?? CENSUS_DATES)].sort();
  const dayLink = (href: string, label: string, current: boolean) => `<a href="${esc(href)}"${current ? ' aria-current="page"' : ""}>${esc(label)}</a>`;
  const dayNav =
    `<nav class="tabs" aria-label="census day">` +
    dayLink("/board/fix-first", "latest", !o.date) +
    days.map((d) => dayLink(`/board/fix-first?date=${d}`, d, o.date === d)).join("") +
    `</nav>`;
  const jsonHref = `/board/fix-first.json${o.date ? `?date=${o.date}` : ""}`;
  const head = ff
    ? `<p class="lead">vet402 tried to buy every x402 resource listed on Algorand (census ${esc(ff.date)}). <b>${fmt(ff.notDelivered)}</b> of ${fmt(ff.rows)} did not deliver. Here they are by what went wrong, the fix that reaches the most sellers first.</p>` +
      `<p class="kpi">${esc(classLine({ ...ff.byClass, DELIVERED: 0 }))}</p>`
    : `<p class="lead">Not run yet${o.date ? ` for ${esc(o.date)}` : ""}. There is no census to group.</p>`;
  const list = (gs: FixGroup[], start: number) => `<ol class="groups">${gs.map((g, i) => groupCard(g, start + i, ff!.date)).join("")}</ol>`;
  const body = ff
    ? list(seller, 0) +
      (ours.length ? `<h2 class="sec">Not for sellers to fix</h2>${list(ours, seller.length)}` : "") +
      (unsorted.length ? `<h2 class="sec">Not grouped yet</h2>${list(unsorted, seller.length + ours.length)}` : "")
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>What to fix first · vet402</title>
<meta name="description" content="The x402 resources vet402 could not buy on Algorand, grouped by what went wrong, with one fix per group.">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<style>
:root{--bg:#0a0e17;--fg:#e8ecf3;--mut:#8a93a6;--line:rgba(255,255,255,.09);--card:#111827;--acc:#60a5fa}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}
a{color:#93c5fd}
main{max-width:720px;margin:0 auto;padding:16px 16px 40px}
h1{font-size:20px;margin:4px 0 6px}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 10px;font-size:13px}
.tabs a{padding:3px 10px;border:1px solid var(--line);border-radius:999px;color:var(--mut);text-decoration:none}
.tabs a[aria-current]{color:var(--fg);border-color:var(--acc)}
.lead{margin:0 0 4px}
.kpi{margin:0 0 12px;color:var(--mut);font-size:13px}
ol.groups{list-style:none;margin:0;padding:0}
.g{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 12px;overflow-wrap:anywhere}
.g.vet402,.g.unsorted{opacity:.8}
.g h2{font-size:16px;margin:0 0 2px}
.g .n{display:inline-block;min-width:1.6em;color:var(--acc)}
.cnt{margin:0 0 6px;color:var(--mut);font-size:14px}
.cnt b{color:var(--fg)}
.fix{margin:0 0 6px;font-weight:600}
.what{margin:0 0 4px;color:#cbd5e1;font-size:14px}
small,.what small{color:var(--mut)}
code{font-size:12px}
ul.hosts{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:4px 12px;font-size:13px}
details{margin-top:4px;font-size:13px;color:var(--mut)}
h2.sec{font-size:15px;color:var(--mut);margin:20px 0 8px}
</style>
</head><body><main>
<nav class="tabs"><a href="/board">Daily</a><a href="/board?view=census">Census</a><a href="/board/fix-first" aria-current="page">What to fix first</a></nav>
${dayNav}
<h1>What to fix first</h1>
${head}
${body}
<p><small>Each count is one purchase attempt on the census day, not a rating: one attempt can fail for reasons on either side. Groups come from the reason vet402 recorded. <a href="${esc(jsonHref)}">fix-first.json</a> · <a href="/board?view=census${o.date ? `&amp;date=${esc(o.date)}` : ""}">every row</a> · <a href="https://github.com/kzmttkc/vet402-algorand/issues" rel="noopener">report a mistake</a></small></p>
</main></body></html>`;
}

/** GET /board/fix-first and /board/fix-first.json. Free. ?date= only for a day in CENSUS_DATES; else the latest census. */
export function registerFixFirst<E extends Env>(app: Hono<E>, file: string = defaultBoardFile(), load: BoardLoader = sharedBoardLoader()): void {
  const pick = (d: string | undefined) =>
    d !== undefined && CENSUS_DATES.includes(d) ? { path: censusFileFor(file, d), date: d } : { path: censusFileFor(file), date: undefined };
  app.get("/board/fix-first.json", async (c) => {
    const { path } = pick(c.req.query("date"));
    const board = await load(path);
    c.header("cache-control", "public, max-age=300");
    return c.json(board && board.rows.length ? fixFirst(board) : { version: 1, groups: [], note: "not run yet" });
  });
  app.get("/board/fix-first", async (c) => {
    const { path, date } = pick(c.req.query("date"));
    c.header("cache-control", "public, max-age=300");
    return c.html(fixFirstHtml(await load(path), { date }));
  });
}
