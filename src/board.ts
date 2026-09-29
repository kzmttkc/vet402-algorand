/**
 * Daily delivery board: GET /board (HTML) and GET /board.json. Free routes.
 *
 * Reads the file written by scripts/board-sweep.ts (default board/latest.json),
 * or the same file name from GitHub raw when the deployment has no local copy.
 * Every row is one purchase vet402 made with its own payer wallet, or a row it
 * skipped. Nothing on this page is generated: with no file (or no rows) the page
 * says the sweep has not run yet. All strings are escaped; no external JS.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
  /** Placeholders in that example vet402 replaced with fresh random values (e.g. ["hash"]). */
  filled?: string[];
  /** Placeholders vet402 would not make up (reason placeholder_unfillable: not sent, not paid). */
  unfillable?: string[];
  declared?: { description?: string; mimeType?: string; expectedKeys?: string[] };
  priceUsdc?: string;
  payTo?: string;
  verdict: BoardVerdict;
  /** Reason word from verdict.ts, or daily_cap / cap_check_unavailable for skipped rows. */
  reason: string;
  detail?: string;
  /**
   * true when the seller's settlement receipt said success, or when the payment was found settled on
   * chain after the facilitator answered "transaction already in ledger" (src/settled.ts; detail says so).
   */
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
  /**
   * refuse leaves out rows vet402 never sent (placeholder_unfillable): those are counted in `unclear`.
   * rows = allow + refuse + skipped + unclear. (`unclear` is absent in files written before 2026-09-28.)
   */
  totals: { rows: number; allow: number; refuse: number; skipped: number; unclear?: number; paidUsdc: string };
  /** Set only on hand-made sample files. The page shows it as a banner. */
  fixture?: string;
  /** Set when the day's purchases finished (a later scheduled run that day buys nothing). */
  completedAt?: string;
  /**
   * The check after the run (src/reconcile.ts): is every USDC transfer the board wallet sent during the
   * run on a row? Absent in files written before 2026-09-30. The page shows a banner unless status is ok.
   */
  reconcile?: BoardReconcile;
  rows: BoardRow[];
}

export interface BoardReconcile {
  checkedAt: string;
  status: "ok" | "unmatched" | "unavailable";
  transfers: number;
  onRows: number;
  recorded: number;
  unmatched: number;
  /** The payments on no row (at most 50): tx, amount, payTo, and why no row could be chosen. */
  unmatchedTx?: { tx: string; amountUsdc: string; payTo: string; why: string }[];
  error?: string;
}

function cleanReconcile(v: unknown): BoardReconcile | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const status = o.status === "ok" || o.status === "unmatched" || o.status === "unavailable" ? o.status : undefined;
  if (!status) return undefined;
  const n = (x: unknown) => (typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : 0);
  const len = (x: unknown) => (Array.isArray(x) ? x.length : n(x));
  return {
    checkedAt: str(o.checkedAt, 40) ?? "",
    status,
    transfers: n(o.transfers),
    onRows: n(o.onRows),
    recorded: len(o.recorded),
    unmatched: len(o.unmatched),
    unmatchedTx: Array.isArray(o.unmatched)
      ? o.unmatched.slice(0, 50).flatMap((u) => {
          const x = (u ?? {}) as Record<string, unknown>;
          const tx = str(x.tx, 60);
          return tx && TXID.test(tx) ? [{ tx, amountUsdc: str(x.amountUsdc, 20) ?? "", payTo: str(x.payTo, 60) ?? "", why: str(x.why, 200) ?? "" }] : [];
        })
      : undefined,
    error: str(o.error, 300),
  };
}

/** The banner for a run whose payments are not all on a row, or could not be checked ("" when all are). */
export function reconcileBanner(r: BoardReconcile | undefined): string {
  if (!r || r.status === "ok") return "";
  if (r.status === "unavailable")
    return "Payment check not done: after this run the chain could not be read, so it is not confirmed that every payment the board wallet made is on a row.";
  const s = r.unmatched === 1 ? "" : "s";
  return `Payment check: ${r.unmatched} USDC payment${s} the board wallet made during this run ${r.unmatched === 1 ? "is" : "are"} on chain but on no row, because ${r.unmatched === 1 ? "it" : "they"} could not be paired one to one with a purchase. Listed in board.json under reconcile.`;
}

export const BOARD_ISSUES_URL = "https://github.com/kzmttkc/vet402-algorand/issues";

export function defaultBoardFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.BOARD_FILE ?? join(process.cwd(), "board", "latest.json");
}

/** The census file sits next to the daily file. With a date (YYYY-MM-DD), that day's census. */
export function censusFileFor(dailyFile: string, date?: string): string {
  return join(dirname(dailyFile), date ? `census-${date}.json` : "census-latest.json");
}

/** A real calendar day written YYYY-MM-DD, nothing else. */
export function isBoardDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

/**
 * Census days the /board census view offers as tabs (census-YYYY-MM-DD.json). 09-27 is the first census;
 * 09-28 reruns it with the corrected verdict code (the 09-27 file is kept as it was).
 */
export const CENSUS_DATES: readonly string[] = ["2026-09-27", "2026-09-28"];

const TXID = /^[A-Z2-7]{52}$/;
const VERDICTS: BoardVerdict[] = ["ALLOW", "REFUSE", "SKIPPED"];

function str(v: unknown, max = 300): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** A row vet402 recorded without sending anything (a placeholder it does not make up): UNCLEAR, never a REFUSE of the seller. */
export function notSent(r: Pick<BoardRow, "verdict" | "reason">): boolean {
  return r.verdict === "REFUSE" && r.reason === "placeholder_unfillable";
}

function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.slice(0, 20).map((k) => str(k, 80) ?? "").filter(Boolean);
  return out.length ? out : undefined;
}

/** "vet402 filled hash with a fresh random value" for a row whose example had placeholders; "" otherwise. */
export function filledNote(r: Pick<BoardRow, "filled">): string {
  return r.filled?.length ? `vet402 filled ${r.filled.join(", ")} with a fresh random value (the seller's example had a placeholder)` : "";
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
    ...(strList(o.filled) ? { filled: strList(o.filled) } : {}),
    ...(strList(o.unfillable) ? { unfillable: strList(o.unfillable) } : {}),
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
      refuse: rows.filter((r) => r.verdict === "REFUSE" && !notSent(r)).length,
      skipped: rows.filter((r) => r.verdict === "SKIPPED").length,
      unclear: rows.filter(notSent).length,
      paidUsdc: str(t.paidUsdc, 20) ?? "0",
    },
    fixture: str(o.fixture, 200),
    completedAt: str(o.completedAt, 40),
    reconcile: cleanReconcile(o.reconcile),
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

/**
 * Where the published board files live when the deployment has no local copy
 * (Vercel does not bundle board/*.json into the function). Only these file
 * names are ever fetched; the base URL is fixed.
 */
export const BOARD_REMOTE_BASE = "https://raw.githubusercontent.com/kzmttkc/vet402-algorand/main/board/";
export const BOARD_REMOTE_FILES: readonly string[] = ["latest.json", "census-latest.json"];
/** Dated census files may also be fetched, only for the fixed list CENSUS_DATES (no directory listing, no API). */
export function isRemoteBoardName(name: string): boolean {
  if (BOARD_REMOTE_FILES.includes(name)) return true;
  const m = /^census-(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
  return !!m && CENSUS_DATES.includes(m[1]);
}
/** The loader keeps at most this many file names in its cache (oldest dropped first). */
export const BOARD_CACHE_MAX = 20;
const REMOTE_MAX_BYTES = 16 * 1024 * 1024;

export interface BoardLoaderOptions {
  /** Set false to never fetch (local file only). */
  remote?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  okTtlMs?: number;
  failTtlMs?: number;
  /** Most file names kept in the cache. Default BOARD_CACHE_MAX. */
  maxEntries?: number;
}

export type BoardLoader = (file: string) => Promise<BoardFile | null>;

let shared: BoardLoader | null = null;
/** One loader (one cache) for /board and /seller in this process. */
export function sharedBoardLoader(): BoardLoader {
  shared ??= createBoardLoader({ remote: process.env.BOARD_REMOTE !== "off" });
  return shared;
}

/**
 * Local file first; if it is missing, the same file name from GitHub raw.
 * Success is cached 5 min, failure 30 s (a failure keeps serving the last good copy).
 */
export function createBoardLoader(o: BoardLoaderOptions = {}): BoardLoader {
  const remote = o.remote ?? true;
  const fetchImpl = o.fetchImpl ?? ((u, i) => fetch(u, i));
  const now = o.now ?? Date.now;
  const timeoutMs = o.timeoutMs ?? 5_000;
  const okTtl = o.okTtlMs ?? 5 * 60_000;
  const failTtl = o.failTtlMs ?? 30_000;
  const maxEntries = Math.max(1, o.maxEntries ?? BOARD_CACHE_MAX);
  const cache = new Map<string, { until: number; board: BoardFile | null; good: BoardFile | null }>();
  const inflight = new Map<string, Promise<BoardFile | null>>();

  async function fetchRemote(name: string): Promise<BoardFile | null> {
    try {
      const res = await fetchImpl(BOARD_REMOTE_BASE + name, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      const len = Number(res.headers.get("content-length") ?? "0");
      if (len > REMOTE_MAX_BYTES) return null;
      const text = await res.text();
      if (text.length > REMOTE_MAX_BYTES) return null;
      return parseBoard(text);
    } catch {
      return null;
    }
  }

  return async (file: string) => {
    const local = readBoard(file);
    if (local) return local;
    const name = basename(file);
    if (!remote || !isRemoteBoardName(name)) return null;
    const hit = cache.get(name);
    if (hit && hit.until > now()) return hit.board;
    const running = inflight.get(name);
    if (running) return running;
    const p = fetchRemote(name).then((board) => {
      const good = board ?? cache.get(name)?.good ?? null;
      cache.delete(name); // re-insert as newest
      cache.set(name, { until: now() + (board ? okTtl : failTtl), board: good, good });
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value!);
      inflight.delete(name);
      return good;
    });
    inflight.set(name, p);
    return p;
  };
}

/**
 * How the page shows a row. Display only: the file and /board.json keep verdict/reason as recorded.
 *
 * DELIVERED   ALLOW.
 * MISMATCH    vet402 paid (settlement receipt said success) and the delivery did not match what it compared against.
 *             A payment found settled on chain after a payment_failed answer is not a MISMATCH: nothing was
 *             delivered to compare, so it stays UNCLEAR (it still counts as paid in totals and payments.csv).
 * UNREACHABLE the URL did not answer with a 402 (404, 410, 405, 401, 200, 5xx…) or its host does not resolve.
 * UNCLEAR     vet402 or the payment path could not reach a result: rate limits, facilitator quota, payment
 *             not settled for any reason, timeouts, fetch errors, vet402's own price cap or daily cap,
 *             no accept vet402 can pay, a 402 vet402's client could not read, a 400/403/408/429 or a redirect
 *             on the unpaid look (input or bot rules, not proof the seller is absent). Never shown as REFUSE.
 */
export type DisplayClass = "DELIVERED" | "MISMATCH" | "UNREACHABLE" | "UNCLEAR";
export const DISPLAY_CLASSES: DisplayClass[] = ["DELIVERED", "MISMATCH", "UNREACHABLE", "UNCLEAR"];

/** Shown on every UNCLEAR row (/board, /seller): the result is not held against the seller. */
export const UNCLEAR_NOTE =
  "Not counted against this seller: vet402 or the payment path could not reach a result (for example rate limits or a facilitator quota).";

/**
 * Notes on single purchases whose result stays as recorded (the declared keys were there) but whose content
 * was later found to differ from the listing's description. Keyed by vet402's payment tx id, so a later
 * purchase of the same URL never inherits the note. Facts only; the evidence is in README "Corrections".
 *
 * Such a row keeps its class and stays in the DELIVERED count: the class says what the check found (declared
 * keys), and a file is corrected only toward what the chain shows. The mismatch is outside the check, so it is
 * shown next to the class (`label`) and in full (`text`), and the headline says how many DELIVERED rows carry one.
 */
export interface ContentNote {
  /** Short, shown under the class in the result column and on the seller card. */
  label: string;
  /** The facts, shown with the reason. */
  text: string;
}
const SPEECH_TONE_NOTE: ContentNote = {
  label: "Content note: the declared keys came back, but the audio is a generated tone, not speech. This mismatch is outside what vet402 checks.",
  text:
    "Note added 2026-09-29: the declared keys were present, so the result stays DELIVERED. vet402 checks the declared keys, not the content. " +
    "The content did not match the listing's description (speech synthesis): the answer's id began with audio-free- and its audio_url held a WAV file with RIFF size 29,876. " +
    "In the seller's public source at commit c2b4344, generateWavBase64() (src/providers/openrouter.ts) builds that answer for this 56-character input: 3.73 s of 8-bit audio " +
    "at 8,000 samples a second, a tone whose pitch follows the input characters, not synthesized speech. Details: README, Corrections.",
};
export const CONTENT_NOTES: Readonly<Record<string, ContentNote>> = {
  // moltworld.xyz POST /v1/models/tts-1/audio/speech, census 2026-09-27 and 2026-09-28
  AMVUEQ3SOQQLWOJSCNQPZO4ZEB3LFSHKRGT7TNAAVDOFWBHF7CZQ: SPEECH_TONE_NOTE,
  XXF5QZMWBATOATXZCUSZYYABIXYYIZ6A7GRY7RZ6YVFZ4YIPWXPA: SPEECH_TONE_NOTE,
  // moltworld.xyz POST /v1/models/gpt-audio-mini/audio/speech, census 2026-09-28
  "5NZLANQCS3GFGVF7KJEXVG3DDVXKE54BU62YB3ZHVVAQYORPCZAA": SPEECH_TONE_NOTE,
};

/** The content note for this purchase ("" when there is none). */
export function contentNote(r: Pick<BoardRow, "tx">): string {
  return r.tx ? (CONTENT_NOTES[r.tx]?.text ?? "") : "";
}

/** The short label for this purchase's content note ("" when there is none). */
export function contentLabel(r: Pick<BoardRow, "tx">): string {
  return r.tx ? (CONTENT_NOTES[r.tx]?.label ?? "") : "";
}

/** Unpaid-look status codes that say more about vet402's request than about the seller. */
const UNCLEAR_LOOK_STATUS = new Set([400, 403, 408, 429]);

export function displayClass(r: Pick<BoardRow, "verdict" | "reason" | "detail" | "paid">): DisplayClass {
  if (r.verdict === "ALLOW") return "DELIVERED";
  if (r.verdict !== "REFUSE") return "UNCLEAR";
  if (r.paid && r.reason !== "payment_failed") return "MISMATCH";
  if (r.reason === "not_x402") {
    const m = /^expected 402, got (\d{3})\b/.exec(r.detail ?? "");
    if (!m) return "UNCLEAR";
    const code = Number(m[1]);
    if (UNCLEAR_LOOK_STATUS.has(code) || (code >= 300 && code < 400)) return "UNCLEAR";
    return "UNREACHABLE";
  }
  if (r.reason === "invalid_target" && /does not resolve/.test(r.detail ?? "")) return "UNREACHABLE";
  return "UNCLEAR";
}

export interface HostSummary {
  host: string;
  listings: number;
  /** vet402 paid this host at least once (a settled tx). */
  paid: boolean;
  counts: Record<DisplayClass, number>;
  /** DELIVERED if any row delivered; else UNCLEAR if any row is unclear (on hold); else MISMATCH if any; else UNREACHABLE. */
  cls: DisplayClass;
}

export function hostOf(r: Pick<BoardRow, "host" | "url">): string {
  if (r.host) return r.host;
  try {
    return new URL(r.url).host;
  } catch {
    return r.url;
  }
}

const HOST_ORDER: Record<DisplayClass, number> = { DELIVERED: 0, MISMATCH: 1, UNCLEAR: 2, UNREACHABLE: 3 };

/** One entry per seller host, grouped by class, then by listing count. */
export function hostSummaries(rows: BoardRow[]): HostSummary[] {
  const m = new Map<string, HostSummary>();
  for (const r of rows) {
    const h = hostOf(r);
    let s = m.get(h);
    if (!s) {
      s = { host: h, listings: 0, paid: false, counts: { DELIVERED: 0, MISMATCH: 0, UNREACHABLE: 0, UNCLEAR: 0 }, cls: "UNREACHABLE" };
      m.set(h, s);
    }
    s.listings++;
    s.paid ||= r.paid;
    s.counts[displayClass(r)]++;
  }
  const out = [...m.values()];
  for (const s of out) {
    s.cls = s.counts.DELIVERED > 0 ? "DELIVERED" : s.counts.UNCLEAR > 0 ? "UNCLEAR" : s.counts.MISMATCH > 0 ? "MISMATCH" : "UNREACHABLE";
  }
  return out.sort((a, b) => HOST_ORDER[a.cls] - HOST_ORDER[b.cls] || b.listings - a.listings || a.host.localeCompare(b.host));
}

export function countBy<T>(xs: T[], f: (x: T) => DisplayClass): Record<DisplayClass, number> {
  const c: Record<DisplayClass, number> = { DELIVERED: 0, MISMATCH: 0, UNREACHABLE: 0, UNCLEAR: 0 };
  for (const x of xs) c[f(x)]++;
  return c;
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

const COLOR: Record<DisplayClass, string> = {
  DELIVERED: "var(--delivered)",
  MISMATCH: "var(--mismatch)",
  UNREACHABLE: "var(--unreach)",
  UNCLEAR: "var(--unclear)",
};
const CSS_CLASS: Record<DisplayClass, string> = { DELIVERED: "delivered", MISMATCH: "mismatch", UNREACHABLE: "unreach", UNCLEAR: "unclear" };

interface Point {
  label: string;
  cls: DisplayClass;
  /** A light travels only when vet402 actually paid (a settled tx). */
  paid: boolean;
}

/** SVG network: vet402 in the middle, one dot per point, played in order. */
function networkSvg(points: Point[], attr: "data-i" | "data-h"): { svg: string; cycleMs: number } {
  const n = points.length;
  // Whole playback stays under ~8 s (a short vertical video), whatever the count.
  const step = n > 0 ? Math.min(0.7, 7 / n) : 0;
  const dense = n > 48;
  const dotR = n > 400 ? 2.2 : n > 24 ? 5 : 7;
  const travel = 0.45;
  const start = 0.6;
  const parts: string[] = [];
  points.forEach((p, i) => {
    // Few points: one or two rings. Many points: a sunflower spiral around vet402.
    const ring = dense ? 44 + 140 * Math.sqrt((i + 0.5) / n) : n > 24 ? (i % 2 === 0 ? 132 : 168) : 150;
    const a = dense ? i * 2.39996323 : -Math.PI / 2 + (2 * Math.PI * i) / n;
    const x = +(Math.cos(a) * ring).toFixed(1);
    const y = +(Math.sin(a) * ring).toFixed(1);
    const d = +(start + i * step).toFixed(2);
    const color = COLOR[p.cls];
    if (n <= 200) parts.push(`<line class="edge" x1="0" y1="0" x2="${x}" y2="${y}"/>`);
    if (p.paid) {
      parts.push(`<line class="pulse" pathLength="1" x1="0" y1="0" x2="${x}" y2="${y}" style="stroke:${color};color:${color};--d:${d}s"/>`);
    }
    parts.push(
      `<g class="node" ${attr}="${i}" tabindex="0" role="button" aria-label="${esc(p.label)}" style="--d:${(d + travel).toFixed(2)}s">` +
        `<title>${esc(p.label)}</title>` +
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

/** Safe inside <script type="application/json">: no "<" can close the tag. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function rowsJson(board: BoardFile | null): string {
  const rows = (board?.rows ?? []).map((r) => ({
    url: r.url,
    host: hostOf(r),
    cls: displayClass(r),
    reason: r.reason,
    detail: r.detail ?? "",
    price: r.priceUsdc ?? "",
    tx: r.tx && TXID.test(r.tx) ? r.tx : "",
    link: txLink(r.tx, board?.networkName ?? "") ?? "",
    at: r.at,
    note: contentNote(r),
  }));
  return scriptJson(rows);
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export type BoardView = "daily" | "census";

export interface BoardHtmlOptions {
  /** Census day asked for with ?date= (undefined = the latest census). */
  date?: string;
  /** Census days offered as tabs. Default CENSUS_DATES. */
  censusDates?: readonly string[];
}

/** Census day tabs: "latest" plus each known day. */
function censusDateNav(board: BoardFile | null, o: BoardHtmlOptions): string {
  const days = [...(o.censusDates ?? CENSUS_DATES)].filter(isBoardDate).sort();
  const link = (href: string, label: string, current: boolean) => `<a href="${esc(href)}"${current ? ' aria-current="page"' : ""}>${esc(label)}</a>`;
  return (
    `<nav class="tabs dates" aria-label="census day">` +
    link("/board?view=census", "latest", !o.date) +
    days.map((d) => link(`/board?view=census&date=${d}`, d, o.date === d)).join("") +
    `</nav>`
  );
}

export function sellerPath(host: string): string {
  return `/seller/${encodeURIComponent(host)}`;
}

export function boardHtml(board: BoardFile | null, view: BoardView = "daily", o: BoardHtmlOptions = {}): string {
  const has = !!board && board.rows.length > 0;
  const rows = board?.rows ?? [];
  const netLabel = board?.networkName === "mainnet" ? "Algorand MainNet" : board?.networkName === "testnet" ? "Algorand TestNet" : esc(board?.networkName ?? "");
  const hosts = view === "census" ? hostSummaries(rows) : [];
  const points: Point[] =
    view === "census"
      ? hosts.map((h) => ({ label: `${h.host}: ${h.cls} (${h.listings} listed)`, cls: h.cls, paid: h.paid }))
      : rows.map((r) => ({ label: `${shortUrl(r.url)}: ${displayClass(r)} ${r.reason}`, cls: displayClass(r), paid: r.paid }));
  const { svg, cycleMs } = networkSvg(points, view === "census" ? "data-h" : "data-i");
  const c = countBy(rows, displayClass);
  const noted = rows.filter((r) => displayClass(r) === "DELIVERED" && contentNote(r)).length;
  const what = view === "census" ? "listed resources" : "sellers";
  const tabs =
    `<nav class="tabs"><a href="/board"${view === "daily" ? ' aria-current="page"' : ""}>Daily (one per seller)</a><a href="/board?view=census"${view === "census" ? ' aria-current="page"' : ""}>Census (every listed resource)</a><a href="/board/fix-first">What to fix first</a><a href="/fairness">Payments to other teams</a></nav>` +
    (view === "census" ? censusDateNav(board, o) : "");
  const headline = has
    ? `<p class="kpi"><span>${esc(board!.date)}</span> · <span>${netLabel}</span> · <b>${fmt(rows.length)}</b> ${what} · <b class="delivered">${fmt(c.DELIVERED)} DELIVERED</b>${noted ? ` (${fmt(noted)} with a content note)` : ""} · <b class="mismatch">${fmt(c.MISMATCH)} MISMATCH</b> · <b class="unreach">${fmt(c.UNREACHABLE)} UNREACHABLE</b> · <b class="unclear">${fmt(c.UNCLEAR)} UNCLEAR</b> · paid <b>${esc(board!.totals.paidUsdc)}</b> USDC</p>`
    : `<p class="kpi">Not run yet${o.date ? ` for ${esc(o.date)}` : ""}. vet402 has not run a sweep${o.date ? " on that day" : ""}, so there is nothing to show.</p>`;
  let sellers = "";
  if (has && view === "census") {
    const hc = countBy(hosts, (h) => h.cls);
    const top = hosts.reduce((m, h) => Math.max(m, h.listings), 0);
    sellers =
      `<div class="sellers"><p><b>${fmt(hosts.length)}</b> sellers: ` +
      `<b class="delivered">${fmt(hc.DELIVERED)}</b> delivered at least once · ` +
      `<b class="mismatch">${fmt(hc.MISMATCH)}</b> were paid, and no answer passed the check · ` +
      `<b class="unreach">${fmt(hc.UNREACHABLE)}</b> did not answer with a 402 on any URL · ` +
      `<b class="unclear">${fmt(hc.UNCLEAR)}</b> on hold (some results were UNCLEAR)</p>` +
      `<p class="note">The Bazaar lists ${fmt(rows.length)} resources from ${fmt(hosts.length)} sellers: one seller can list many URLs (for example one verification URL per transaction; the largest lists ${fmt(top)}). So the picture below has one dot per seller.</p></div>`;
  }
  const fixture = board?.fixture ? `<p class="fixture">FIXTURE: ${esc(board.fixture)}</p>` : "";
  const unchecked = reconcileBanner(board?.reconcile);
  const payCheck = unchecked ? `<p class="fixture">${esc(unchecked)}</p>` : "";
  const tableRows = rows
    .map((r, i) => {
      const link = txLink(r.tx, board!.networkName);
      const tx = link ? `<a href="${esc(link)}" rel="noopener">${esc(r.tx!.slice(0, 8))}…</a>` : "no payment";
      const note = contentNote(r);
      const label = contentLabel(r);
      const decl = [r.declared?.description, r.declared?.expectedKeys?.length ? `keys: ${r.declared.expectedKeys.join(", ")}` : ""].filter(Boolean).join(" · ");
      const cls = displayClass(r);
      return (
        `<tr id="row-${i}"><td>${esc(r.at.slice(11, 19))}</td>` +
        `<td class="u"><span class="h">${esc(r.method)} ${esc(shortUrl(r.url))}</span>${r.host ? ` <a class="sl" href="${esc(sellerPath(r.host))}">seller page</a>` : ""}${decl ? `<br><small>${esc(decl)}</small>` : ""}${r.input ? `<br><small>sent: ${esc(r.input)}</small>` : ""}${filledNote(r) ? `<br><small>${esc(filledNote(r))}</small>` : ""}</td>` +
        `<td>${esc(r.priceUsdc ?? "")}</td>` +
        `<td class="v ${CSS_CLASS[cls]}">${cls}${label ? `<br><small class="cn">${esc(label)}</small>` : ""}${cls === "UNCLEAR" ? `<br><small class="nc">${esc(UNCLEAR_NOTE)}</small>` : ""}</td>` +
        `<td><code>${esc(r.reason)}</code>${r.detail ? `<br><small>${esc(r.detail)}</small>` : ""}${note ? `<br><small class="cn">${esc(note)}</small>` : ""}</td>` +
        `<td>${tx}</td></tr>`
      );
    })
    .join("");
  const table = has
    ? `<div class="tw"><table><thead><tr><th>UTC</th><th>seller (declared)</th><th>USDC</th><th>result</th><th>reason code</th><th>vet402 → seller tx</th></tr></thead><tbody>${tableRows}</tbody></table></div>`
    : "";
  const hostsJson = scriptJson(hosts.map((h) => ({ host: h.host, cls: h.cls, listings: h.listings, paid: h.paid, counts: h.counts })));
  const lightNote = view === "census" ? "a light = vet402 paid this seller on-chain at least once" : "a light = vet402 paid the seller on-chain";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>vet402 delivery board</title>
<meta name="description" content="vet402 buys from x402 sellers on Algorand with its own money and records whether the paid answer had the fields the seller declared.">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<style>
:root{--bg:#0a0e17;--fg:#e8ecf3;--mut:#8a93a6;--line:rgba(255,255,255,.09);--delivered:#34d399;--mismatch:#f87171;--unreach:#6b7280;--unclear:#f59e0b;--card:#111827}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}
a{color:#93c5fd}
.hero{padding:20px 16px 8px;max-width:760px;margin:0 auto;text-align:center}
.hero h1{font-size:20px;margin:0 0 4px;letter-spacing:.01em}
.tabs{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin:0 0 10px;font-size:13px}
.tabs a{padding:3px 10px;border:1px solid var(--line);border-radius:999px;color:var(--mut);text-decoration:none}
.tabs a[aria-current]{color:var(--fg);border-color:#60a5fa}
.tabs.dates{margin-top:-4px;font-size:12px}
a.sl{font-size:12px;white-space:nowrap}
.kpi{margin:4px 0 0;color:var(--mut);font-size:14px}
.kpi b,.sellers b{color:var(--fg);white-space:nowrap}
.delivered{color:var(--delivered)!important} .mismatch{color:var(--mismatch)!important} .unreach{color:#9ca3af!important} .unclear{color:var(--unclear)!important}
.sellers{margin:8px auto 0;max-width:620px;font-size:14px;color:var(--mut)}
.sellers p{margin:2px 0}
.sellers .note{font-size:13px}
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
tr.sel td{background:#172033}
</style>
</head><body>
<section class="hero">
${tabs}
<h1>vet402 bought it. Did it arrive?</h1>
${headline}
${sellers}
${fixture}
${payCheck}
${svg}
<p class="legend"><i style="background:var(--delivered)"></i>DELIVERED<i style="background:var(--mismatch)"></i>MISMATCH<i style="background:var(--unreach)"></i>UNREACHABLE<i style="background:var(--unclear)"></i>UNCLEAR · ${lightNote}</p>
<div id="detail" aria-live="polite">${has ? (view === "census" ? "Tap a dot to see that seller." : "Tap a dot to see that purchase.") : "Not run yet."}</div>
</section>
<main>
<p class="method">What this is: vet402 bought from each listed resource with its own money, sent the example input the seller published, and checked what came back: after payment, a 2xx answer of non-empty JSON with the keys the listing marks as required (with no required list, at least one key of its example). It does not check whether the content itself is right. vet402 does not rate a seller on the result of one purchase: a single purchase can go wrong for reasons on either side. DELIVERED: the answer passed that check. MISMATCH: vet402 paid and the answer failed that check (an error status, not JSON, empty, or a required key missing). UNREACHABLE: the URL did not ask for payment: it answered with another status (for example 401, 404, 405, 410 or 5xx), its host did not resolve, or it gave the content away with a 200. UNCLEAR: vet402 or the payment path could not reach a result (rate limits, facilitator quota, a payment that did not settle, timeouts, vet402's own price cap, or a 402 vet402's client could not read); these are not counted against the seller. Reason codes are shown as recorded. If something here is wrong, please open a <a href="${BOARD_ISSUES_URL}" rel="noopener">GitHub issue</a>.</p>
${table}
<p><small><a href="/board.json${view === "census" ? "?view=census" : ""}">board.json</a> · <a href="/">vet402</a> · per call cap ${esc(board?.caps?.perCallUsdc ?? "")} USDC, per day cap ${esc(board?.caps?.perDayUsdc ?? "")} USDC${board?.payer ? ` · payer <code>${esc(board.payer)}</code>` : ""}</small></p>
</main>
<script type="application/json" id="rows">${rowsJson(board)}</script>
<script type="application/json" id="hosts">${hostsJson}</script>
<script>
(function(){
  function load(id){try{return JSON.parse(document.getElementById(id).textContent||'[]')}catch(e){return []}}
  var rows=load('rows'),hosts=load('hosts');
  var det=document.getElementById('detail'),net=document.getElementById('net');
  function line(t){det.appendChild(document.createElement('br'));det.appendChild(document.createTextNode(t))}
  function head(t){det.textContent='';var b=document.createElement('b');b.textContent=t;det.appendChild(b)}
  function mark(n,tr){
    document.querySelectorAll('.node.sel,tr.sel').forEach(function(e){e.classList.remove('sel')});
    if(n)n.classList.add('sel');if(tr)tr.classList.add('sel');
  }
  function showRow(i,n){
    var r=rows[i];if(!r)return;
    mark(n,document.getElementById('row-'+i));
    head(r.cls+' · '+r.reason);
    line(r.url+(r.price?' · '+r.price+' USDC':''));
    if(r.detail)line(r.detail);
    if(r.cls==='UNCLEAR')line(${scriptJson(UNCLEAR_NOTE)});
    if(r.note)line(r.note);
    det.appendChild(document.createElement('br'));
    if(r.link){var a=document.createElement('a');a.href=r.link;a.rel='noopener';a.textContent='tx '+r.tx;det.appendChild(a)}
    else det.appendChild(document.createTextNode('no payment was made'));
    sellerLink(r.host);
  }
  function sellerLink(h){
    if(!h)return;
    det.appendChild(document.createElement('br'));
    var s=document.createElement('a');s.href='/seller/'+encodeURIComponent(h);s.textContent='seller page: '+h;det.appendChild(s);
  }
  function showHost(i,n){
    var h=hosts[i];if(!h)return;
    mark(n,null);
    head(h.cls+' · '+h.host);
    var c=h.counts;
    line(h.listings+' listed · delivered '+c.DELIVERED+' · mismatch '+c.MISMATCH+' · unreachable '+c.UNREACHABLE+' · unclear '+c.UNCLEAR);
    line(h.paid?'vet402 paid this seller at least once':'no payment was made');
    sellerLink(h.host);
  }
  document.querySelectorAll('.node').forEach(function(n){
    var hi=n.getAttribute('data-h');
    function go(){if(hi!==null)showHost(+hi,n);else showRow(+n.getAttribute('data-i'),n)}
    n.addEventListener('click',go);
    n.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();go()}});
  });
  var still=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!still&&rows.length&&net){setInterval(function(){net.classList.remove('play');void net.getBoundingClientRect();net.classList.add('play')},${cycleMs + 2500})}
})();
</script>
</body></html>`;
}

/**
 * vet402's own purchases, one line per payment (GET /board/payments.csv, free).
 * A row counts only when it is paid (settlement receipt success, or found settled on chain) and carries a valid tx id;
 * the same tx found in several files is listed once. Oldest first.
 * Columns: time_utc, payer (vet402's wallet), seller_pay_to, host, amount_usdc, tx, class.
 */
export const PAYMENTS_CSV_HEADER = ["time_utc", "payer", "seller_pay_to", "host", "amount_usdc", "tx", "class"] as const;

/** RFC 4180 cell; a leading = + - @ (spreadsheet formula) is neutralised with a quote mark. */
function csvCell(v: unknown): string {
  let s = String(v ?? "").replace(/[\r\n]+/g, " ");
  if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One board file, read for vet402's own purchases. */
export interface PurchaseSource {
  kind: "daily" | "census";
  board: BoardFile | null;
}
export interface PaidPurchase {
  row: BoardRow & { tx: string };
  kind: PurchaseSource["kind"];
  board: BoardFile;
}

/** Settled vet402 payments (paid and a valid tx id), each tx once (first file wins), oldest first. */
export function paidPurchases(sources: PurchaseSource[]): PaidPurchase[] {
  const seen = new Set<string>();
  const out: PaidPurchase[] = [];
  for (const { kind, board } of sources) {
    if (!board) continue;
    for (const r of board.rows) {
      if (!r.paid || !r.tx || !TXID.test(r.tx) || seen.has(r.tx)) continue;
      seen.add(r.tx);
      out.push({ row: r as BoardRow & { tx: string }, kind, board });
    }
  }
  return out.sort((a, b) => (a.row.at < b.row.at ? -1 : a.row.at > b.row.at ? 1 : 0));
}

/** The files the purchase exports read: the daily file, the latest census, and every census day on the fixed list. */
export async function loadPurchaseSources(file: string, load: BoardLoader): Promise<PurchaseSource[]> {
  const names: [PurchaseSource["kind"], string][] = [
    ["daily", file],
    ["census", censusFileFor(file)],
    ...CENSUS_DATES.filter(isBoardDate).map((d): [PurchaseSource["kind"], string] => ["census", censusFileFor(file, d)]),
  ];
  return Promise.all(names.map(async ([kind, n]) => ({ kind, board: await load(n) })));
}

export function paymentsCsv(files: (BoardFile | null)[]): string {
  const rows = paidPurchases(files.map((board) => ({ kind: "census" as const, board }))).map(({ row: r, board: f }) =>
    [r.at, f.payer ?? "", r.payTo ?? "", hostOf(r), r.priceUsdc ?? "", r.tx, displayClass(r)].map(csvCell).join(","),
  );
  return [PAYMENTS_CSV_HEADER.join(","), ...rows].join("\r\n") + "\r\n";
}

/** Receipt page for a settled tx at the facilitator (the string only; vet402 never fetches it). */
export const RECEIPT_BASE = "https://facilitator.goplausible.xyz/api/receipt/";

export interface VerdictFeedItem {
  /** vet402 -> seller settlement tx. */
  purchaseTx: string;
  network: string;
  payer: string;
  payTo: string;
  host: string;
  resource: string;
  amountUsdc: string;
  class: DisplayClass;
  reason: string;
  checkedAt: string;
  receiptUrl: string;
  /** The board file that recorded it, named by its day: census-YYYY-MM-DD.json or YYYY-MM-DD.json (daily). */
  sourceFile: string;
}

function sourceFileName(kind: PurchaseSource["kind"], b: BoardFile): string {
  const day = isBoardDate(b.date) ? b.date : null;
  if (kind === "census") return day ? `census-${day}.json` : "census-latest.json";
  return day ? `${day}.json` : "latest.json";
}

/** GET /board/verdicts.json: one item per settled vet402 purchase (unpaid rows are left out). */
export function verdictsFeed(sources: PurchaseSource[]): { version: 1; count: number; verdicts: VerdictFeedItem[] } {
  const verdicts = paidPurchases(sources).map(({ row: r, kind, board: b }) => ({
    purchaseTx: r.tx,
    network: b.network,
    payer: b.payer ?? "",
    payTo: r.payTo ?? "",
    host: hostOf(r),
    resource: r.url,
    amountUsdc: r.priceUsdc ?? "",
    class: displayClass(r),
    reason: r.reason,
    checkedAt: r.at,
    receiptUrl: RECEIPT_BASE + encodeURIComponent(r.tx),
    sourceFile: sourceFileName(kind, b),
  }));
  return { version: 1, count: verdicts.length, verdicts };
}

/** Register the free board routes. Call before the payment middleware. */
export function registerBoard<E extends Env>(
  app: Hono<E>,
  file: string = defaultBoardFile(),
  load: BoardLoader = sharedBoardLoader(),
): void {
  // ?date= is honoured only for the census view and only for a day in CENSUS_DATES; anything else is the latest file.
  const pick = (v: string | undefined, d: string | undefined): { view: BoardView; path: string; date?: string } =>
    v === "census"
      ? d !== undefined && CENSUS_DATES.includes(d)
        ? { view: "census", path: censusFileFor(file, d), date: d }
        : { view: "census", path: censusFileFor(file) }
      : { view: "daily", path: file };
  // Every census day on the fixed list, the latest census and the daily file: vet402's own payments, deduplicated by tx.
  app.get("/board/payments.csv", async (c) => {
    const files = (await loadPurchaseSources(file, load)).map((s) => s.board);
    return c.body(paymentsCsv(files), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'inline; filename="vet402-payments.csv"',
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    });
  });
  // Same files as payments.csv, as JSON: one item per settled purchase.
  app.get("/board/verdicts.json", async (c) => {
    c.header("cache-control", "public, max-age=300");
    return c.json(verdictsFeed(await loadPurchaseSources(file, load)));
  });
  app.get("/board.json", async (c) => {
    const { path } = pick(c.req.query("view"), c.req.query("date"));
    c.header("cache-control", "public, max-age=300");
    return c.json((await load(path)) ?? { version: 1, rows: [], note: "not run yet" });
  });
  app.get("/board", async (c) => {
    const asked = c.req.query("view");
    let { view, path, date } = pick(asked, c.req.query("date"));
    let board = await load(path);
    // Before the first daily sweep, the plain /board shows the latest census instead of an empty page.
    if (asked === undefined && !board?.rows?.length) {
      const census = await load(censusFileFor(file));
      if (census?.rows?.length) {
        view = "census";
        board = census;
      }
    }
    c.header("cache-control", "public, max-age=300");
    return c.html(boardHtml(board, view, { date }));
  });
}
