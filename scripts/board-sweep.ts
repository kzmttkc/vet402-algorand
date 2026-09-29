/**
 * Daily delivery board sweep: vet402 buys once from x402 sellers with its own
 * payer wallet, judges each delivery with the normal probe(), and writes
 * board/YYYY-MM-DD.json + board/latest.json for GET /board.
 *
 *   npx tsx scripts/board-sweep.ts --dry-run                 # MainNet needs X402_NETWORK=mainnet; no key, no payment
 *   npx tsx scripts/board-sweep.ts                           # daily: one resource per host (the cheapest)
 *   npx tsx scripts/board-sweep.ts --census                  # every resource once (board/census-YYYY-MM-DD.json)
 *   npx tsx scripts/board-sweep.ts --targets <url,url,...>   # explicit list (TestNet sellers)
 *
 *   npx tsx scripts/board-sweep.ts --repair-settled <file> [--write]   # re-check "already in ledger" rows on chain (no payment)
 *   npx tsx scripts/board-sweep.ts --reconcile <file> [--write]        # payment check of a written file on chain (no payment)
 *
 * Options: --out <dir> --limit <n> --concurrency <1-4> --host-gap-ms <n, min 60000> --max-age-days <n> --bazaar <url> --share-payer-wallet
 *
 * Fairness to sellers (2026-09-28: 581 purchases from agent402.tools in about 30 minutes, answered
 * with 429 and the facilitator's subcent quota):
 * - At most MAX_PER_HOST_PER_RUN (5) purchases per seller host per run, counting what was already
 *   attempted today (resume). The rest of that host's resources are written as SKIPPED
 *   not_measured_this_run: vet402 did not contact them, and they are not counted against the seller.
 *   Which 5 rotates by UTC day, so later runs reach the rest.
 * - Census takes turns between hosts (round-robin), never has two purchases in flight to the same
 *   host, and waits at least 60 s between the end of one purchase from a host and the next one.
 *
 * Recording: when a seller's facilitator answers "transaction already in ledger", the payment did
 * settle. The run reads the group of that tx from the indexer and, when vet402's own transfer to the
 * seller is there, records the row as paid with that tx (src/settled.ts). Read-only; the caps are not touched.
 *
 * Payment check (src/reconcile.ts): at the end of every run, every USDC transfer the board wallet sent
 * during the run must be on a row. A transfer on no row is written to its row only when the pairing is
 * one to one; the rest are kept in the file under reconcile.unmatched and the run exits with code 3
 * (after the files are written, so the workflow commits them and then fails). When the indexer cannot
 * be read, the check says so and the run also exits with code 3.
 *
 * Once a day: a daily run writes completedAt when its purchases are done. A later scheduled run on the
 * same UTC day finds it in today's file and buys nothing; it only repeats the payment check (read-only).
 * A file without completedAt (a run that stopped early) is resumed as before: nothing already attempted
 * today is bought again.
 *
 * Money rules:
 * - vet402 pays sellers directly. It never pays its own hosts or its own addresses
 *   (filtered here, and refused again inside probe() as self_dealing).
 * - Every payment goes through probe(): per-call cap before any signature, and a
 *   daily cap that is max(indexer "USDC sent today by the payer", local ledger).
 *   The board has its own daily cap (BOARD_MAX_PER_DAY_USDC, default = PROBE_MAX_PER_DAY_USDC)
 *   and its own ledger file. The /v1/check caps are not touched.
 * - When the cap is hit, the rest is written as SKIPPED daily_cap and the run stops.
 * - Each resource is bought at most once per UTC day: an attempt is journaled
 *   before paying, and a rerun skips anything already attempted (resume).
 * - Sellers get the example input they published in the Bazaar. PUT/DELETE,
 *   form bodies and path templates are not probed. A placeholder in it ("<sha256-hex-64-chars>")
 *   gets a fresh random value each time; one vet402 cannot fill (an address, an email…) makes the
 *   row REFUSE placeholder_unfillable, not paid (shown as UNCLEAR).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { seedFromMnemonic } from "@algorandfoundation/algokit-utils/algo25";
import { atomicToUsdc, loadConfig, usdcToAtomic, type AppConfig } from "../src/config.js";
import { SpendLedger } from "../src/caps.js";
import { IndexedSpendGuard, usdcSentToday } from "../src/spend.js";
import { makePaidFetch, probe, type ProbeDeps, type ProbeResult } from "../src/probe.js";
import { selectAccept } from "../src/declaration.js";
import { addressFromSeed, loadKeys, secretKeyB64FromMnemonic, loadPayer, type Payer } from "../src/keys.js";
import { notSent, type BoardFile, type BoardRow } from "../src/board.js";
import { alreadyInLedgerTx, findSettledPaymentWithRetry, type SettledPayment } from "../src/settled.js";
import { WINDOW_LEAD_MS, reconcileLine, reconcileRows, type ReconcileResult } from "../src/reconcile.js";
import { DEFAULT_BAZAAR, OWN_HOSTS, buildPaidRequest, buildRequest, fetchBazaar, isOwnHost, withInput, type BazaarItem } from "../src/bazaar.js";

// Moved to src/bazaar.ts (shared with the paid seller audit); re-exported for existing callers.
export { DEFAULT_BAZAAR, OWN_HOSTS, buildRequest, fetchBazaar, isOwnHost, withInput, type BazaarItem };

/** MainNet payer wallet (public address, README "MainNet run record"). Used only when no key is loaded. */
export const KNOWN_MAINNET_PAYER = "OZ3KMLALTO67BZLYLCZOT7IJBGN7JTO5A3MJHI2267EKQDASFKS52KU6VY";

export interface Candidate {
  /** `${method} ${url}`: one purchase per key per UTC day. */
  key: string;
  /** The URL as published (placeholders in place): stable across runs, used for the key and the row. */
  url: string;
  /** Where the purchase is sent when a filled query placeholder makes it differ from `url`. */
  requestUrl?: string;
  host: string;
  method: "GET" | "POST";
  body?: string;
  contentType?: string;
  /** What we send, for the board ("?a=1", "body {...}", "(none)"). */
  input: string;
  /** Placeholders in the seller's example replaced with fresh random values (e.g. ["hash"]). */
  filled?: string[];
  /** Placeholders vet402 would not make up: this candidate is recorded as placeholder_unfillable and never bought. */
  unfillable?: string[];
  priceAtomic?: bigint;
  payTo?: string;
  description?: string;
  lastSeen?: string;
  settleCount?: number;
}

export interface SelectOptions {
  network: string;
  usdcAsaId: string;
  maxPerCallAtomic: bigint;
  now: Date;
  /** null = no freshness filter (census). */
  maxAgeDays: number | null;
  ownAddresses: string[];
  ownHosts?: string[];
  allowPrivate: boolean;
  /** true = keep only the cheapest resource per host (daily board). */
  perHost: boolean;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function selectCandidates(items: BazaarItem[], o: SelectOptions): { candidates: Candidate[]; excluded: Record<string, number> } {
  const excluded: Record<string, number> = {};
  const out = (r: string) => {
    excluded[r] = (excluded[r] ?? 0) + 1;
  };
  const cutoff = o.maxAgeDays === null ? null : o.now.getTime() - o.maxAgeDays * 86_400_000;
  const own = new Set(o.ownAddresses.filter(Boolean));
  const seen = new Set<string>();
  const list: Candidate[] = [];
  for (const it of items) {
    if (!it || typeof it.resourceUrl !== "string" || !Array.isArray(it.accepts)) {
      out("malformed");
      continue;
    }
    const accept = selectAccept(it.accepts, o.network, o.usdcAsaId);
    if (!accept) {
      out("other_network_or_asset");
      continue;
    }
    if (it.accepts.some((a) => own.has(a.payTo))) {
      out("own_address");
      continue;
    }
    let host: string;
    let protocol: string;
    try {
      const u = new URL(it.resourceUrl);
      host = u.hostname.toLowerCase();
      protocol = u.protocol;
    } catch {
      out("bad_url");
      continue;
    }
    if (isOwnHost(host, o.ownHosts)) {
      out("own_host");
      continue;
    }
    const price = BigInt(accept.amount);
    if (price > o.maxPerCallAtomic) {
      out("price_over_cap");
      continue;
    }
    if (cutoff !== null) {
      const t = it.lastSeen ? Date.parse(it.lastSeen) : NaN;
      if (!Number.isFinite(t) || t < cutoff) {
        out("stale");
        continue;
      }
    }
    if (!o.allowPrivate && protocol !== "https:") {
      out("not_https");
      continue;
    }
    const pr = buildPaidRequest(it);
    // An example with a placeholder vet402 cannot fill stays a candidate: runSweep records it without paying.
    if (!pr.ok && !("fields" in pr)) {
      out(pr.reason);
      continue;
    }
    const b = pr.ok ? pr : { ...pr, unfillable: pr.fields };
    const key = `${b.method} ${b.url}`;
    if (seen.has(key)) {
      out("duplicate_url");
      continue;
    }
    seen.add(key);
    list.push({
      key,
      url: b.url,
      host,
      method: b.method,
      ...(b.ok
        ? { body: b.body, contentType: b.contentType, ...(b.requestUrl ? { requestUrl: b.requestUrl } : {}), ...(b.filled ? { filled: b.filled } : {}) }
        : { unfillable: b.unfillable }),
      input: b.input,
      priceAtomic: price,
      payTo: accept.payTo,
      description: it.description,
      lastSeen: it.lastSeen,
      settleCount: it.settleCount,
    });
  }
  let chosen = list;
  if (o.perHost) {
    const best = new Map<string, Candidate>();
    for (const c of list) {
      const b = best.get(c.host);
      // Prefer a resource vet402 can actually send (no unfillable placeholder), then the cheapest.
      const better =
        !b ||
        (!!b.unfillable && !c.unfillable) ||
        (!b.unfillable === !c.unfillable &&
          (c.priceAtomic! < b.priceAtomic! ||
            (c.priceAtomic === b.priceAtomic && ((c.settleCount ?? 0) > (b.settleCount ?? 0) || ((c.settleCount ?? 0) === (b.settleCount ?? 0) && c.url < b.url)))));
      if (better) best.set(c.host, c);
    }
    chosen = [...best.values()];
    const n = list.length - chosen.length;
    if (n > 0) excluded.not_cheapest_on_host = n;
  }
  chosen.sort((a, b) => (a.priceAtomic! < b.priceAtomic! ? -1 : a.priceAtomic! > b.priceAtomic! ? 1 : a.host.localeCompare(b.host) || a.url.localeCompare(b.url)));
  // Census: take turns between hosts, so no seller gets a burst of purchases (2026-09-27: 280 × 429 from one host).
  if (!o.perHost) chosen = interleaveByHost(chosen);
  return { candidates: chosen, excluded };
}

/**
 * Round-robin by host: one resource from each host in turn, keeping each host's own order
 * and the hosts in the order they first appear. The same host sits next to itself only in
 * the tail, once every other host has run out.
 */
export function interleaveByHost<T extends { host: string }>(list: T[]): T[] {
  const queues = new Map<string, T[]>();
  for (const c of list) {
    const q = queues.get(c.host);
    if (q) q.push(c);
    else queues.set(c.host, [c]);
  }
  const out: T[] = [];
  const qs = [...queues.values()];
  for (let round = 0; out.length < list.length; round++) {
    for (const q of qs) if (round < q.length) out.push(q[round]);
  }
  return out;
}

/** At most this many purchases per seller host per run (today's earlier attempts count). */
export const MAX_PER_HOST_PER_RUN = 5;

/** SKIPPED reason for a resource left out by the per-host limit: not contacted, not counted against the seller. */
export const NOT_MEASURED = "not_measured_this_run";

/**
 * Rotate each host's own resources by `shift(host, n)` places, keeping the slots each host holds in
 * the list (so a round-robin order stays round-robin). With a per-day shift, the first few of a host
 * are different resources on different days.
 */
export function rotateWithinHost<T extends { host: string }>(list: T[], shift: (host: string, n: number) => number): T[] {
  const slots = new Map<string, number[]>();
  list.forEach((c, i) => {
    const s = slots.get(c.host);
    if (s) s.push(i);
    else slots.set(c.host, [i]);
  });
  const out = list.slice();
  for (const idx of slots.values()) {
    const n = idx.length;
    const k = ((Math.trunc(shift(list[idx[0]].host, n)) % n) + n) % n;
    if (k === 0) continue;
    idx.forEach((slot, j) => (out[slot] = list[idx[(j + k) % n]]));
  }
  return out;
}

/** Per-day shift: UTC day d starts each host at resource d·max (mod n). */
export function dayShift(date: string, max: number): (host: string, n: number) => number {
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  return (_h, n) => (Number.isFinite(day) ? (day * max) % n : 0);
}

/** The first (max − already attempted) resources of each host, in list order; the rest are not bought this run. */
export function limitPerHost<T extends { host: string }>(list: T[], max: number, prior?: Map<string, number>): { take: T[]; rest: T[] } {
  const used = new Map<string, number>(prior ?? []);
  const take: T[] = [];
  const rest: T[] = [];
  for (const c of list) {
    const n = used.get(c.host) ?? 0;
    if (n < max) {
      take.push(c);
      used.set(c.host, n + 1);
    } else rest.push(c);
  }
  return { take, rest };
}

/** Host of a "METHOD url" key ("" if the url does not parse). */
export function hostOfKey(key: string): string {
  try {
    return new URL(key.slice(key.indexOf(" ") + 1)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Purchases already attempted today per host (from the resume keys). */
export function attemptsPerHost(keys: Iterable<string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) {
    const h = hostOfKey(k);
    if (h) m.set(h, (m.get(h) ?? 0) + 1);
  }
  return m;
}

const CAP_STOP: Record<string, string> = { daily_cap_reached: "daily_cap", cap_check_unavailable: "cap_check_unavailable" };

function baseRow(c: Candidate, at: string): Pick<BoardRow, "at" | "url" | "host" | "method" | "input" | "filled" | "payTo" | "priceUsdc" | "declared"> {
  return {
    at,
    url: c.url,
    host: c.host,
    method: c.method,
    input: c.input,
    ...(c.filled?.length ? { filled: c.filled } : {}),
    payTo: c.payTo,
    priceUsdc: c.priceAtomic !== undefined ? atomicToUsdc(c.priceAtomic) : undefined,
    declared: c.description ? { description: clip(c.description, 200) } : undefined,
  };
}

export function skippedRow(c: Candidate, reason: string, at: string, detail?: string): BoardRow {
  return { ...baseRow(c, at), verdict: "SKIPPED", reason, detail, paid: false };
}

/** A resource left out by the per-host limit: not contacted this run, not paid, not counted against the seller. */
export function notMeasuredRow(c: Candidate, at: string, max: number): BoardRow {
  return skippedRow(
    c,
    NOT_MEASURED,
    at,
    `not measured this run: vet402 buys at most ${max} resources per seller host per run, at least 60 s apart; not contacted, not paid, not counted against the seller`,
  );
}

/**
 * A payment_failed row whose payment was found settled on chain ("transaction already in ledger"):
 * paid, with vet402's own transfer as tx and the amount that moved. verdict/reason stay as recorded.
 */
export function markSettled(row: BoardRow, s: SettledPayment, errorTx: string): BoardRow {
  return {
    ...row,
    paid: true,
    tx: s.tx,
    priceUsdc: atomicToUsdc(s.amountAtomic),
    // Fits the 300-character detail the board keeps: the error names errorTx, this names vet402's transfer.
    detail: clip(`${row.detail ?? ""} · settled on chain: vet402's transfer ${s.tx} (same group, round ${s.round}); no delivery`, 300),
  };
}

/** Looks up vet402's settled transfer for a payment_failed "already in ledger" answer (null = not found). */
export type SettledCheck = (c: Candidate, errorTx: string, window: { from: number; to: number }) => Promise<SettledPayment | null>;

/** A candidate whose example has a placeholder vet402 would not make up: recorded, never sent, never paid (UNCLEAR). */
export function unfillableRow(c: Candidate, at: string): BoardRow {
  const fields = c.unfillable ?? [];
  return {
    ...baseRow(c, at),
    verdict: "REFUSE",
    reason: "placeholder_unfillable",
    detail: clip(`the seller's example input has a placeholder vet402 does not make up (${fields.join(", ")}): not sent, not paid`, 300),
    unfillable: fields,
    paid: false,
  };
}

export function rowFromResult(c: Candidate, r: ProbeResult, at: string): BoardRow {
  const b = baseRow(c, at);
  const tx = r.downstreamPayment?.transaction || undefined;
  return {
    ...b,
    priceUsdc: r.price?.usdc ?? b.priceUsdc,
    payTo: r.price?.payTo ?? b.payTo,
    declared: r.declared
      ? { description: r.declared.description ? clip(r.declared.description, 200) : b.declared?.description, mimeType: r.declared.mimeType, expectedKeys: r.declared.expectedKeys }
      : b.declared,
    verdict: r.verdict,
    reason: r.reason,
    detail: r.detail ? clip(r.detail, 300) : undefined,
    paid: r.downstreamPayment?.success === true,
    tx,
    delivery: r.delivery ? clip(`${r.delivery.status} ${r.delivery.contentType ?? ""} ${r.delivery.summary}`, 300) : undefined,
  };
}

export interface RunOptions {
  probeOne: (c: Candidate) => Promise<ProbeResult>;
  headroom?: () => Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>;
  concurrency?: number;
  /**
   * Minimum wait between the end of one purchase from a host and the start of the next one
   * from the same host (ms). Default 0. A host never has two purchases in flight at once.
   */
  hostGapMs?: number;
  /**
   * At most this many purchases per host in this run (default: no limit). The rest are written as
   * SKIPPED not_measured_this_run and never handed to probeOne.
   */
  maxPerHost?: number;
  /** Purchases already attempted today per host; they count toward maxPerHost. */
  priorPerHost?: Map<string, number>;
  /** "transaction already in ledger": look the payment up on chain and record it as paid when it settled. */
  checkSettled?: SettledCheck;
  /** Tx ids already recorded today (a settled lookup never records one of these a second time). */
  knownTx?: Set<string>;
  /** Test hooks: clock (ms) and sleep. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Keys already attempted today (never bought twice). */
  done?: Set<string>;
  onAttempt?: (key: string) => void;
  onRow?: (row: BoardRow) => void;
  now?: () => Date;
}

/**
 * Buy each candidate once through probeOne. Stops at the first cap refusal:
 * that candidate and every one not yet started become SKIPPED.
 */
export async function runSweep(cands: Candidate[], o: RunOptions): Promise<BoardRow[]> {
  const now = o.now ?? (() => new Date());
  const clock = o.clock ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gap = Math.max(0, o.hostGapMs ?? 0);
  const todo = cands.filter((c) => !o.done?.has(c.key));
  const rows: BoardRow[] = [];
  const emit = (r: BoardRow) => {
    rows.push(r);
    o.onRow?.(r);
  };
  // Nothing to send and nothing to pay: record these first, and never hand them to probeOne.
  for (const c of todo) if (c.unfillable?.length) emit(unfillableRow(c, now().toISOString()));
  const sendable = todo.filter((c) => !c.unfillable?.length);
  // Fairness: at most maxPerHost purchases per host (today's earlier attempts count); the rest are not contacted.
  const max = o.maxPerHost ?? Infinity;
  const { take: pending, rest } = Number.isFinite(max) ? limitPerHost(sendable, max, o.priorPerHost) : { take: sendable, rest: [] as Candidate[] };
  for (const c of rest) emit(notMeasuredRow(c, now().toISOString(), max));
  const knownTx = new Set(o.knownTx ?? []);
  let stop: { reason: string; detail?: string } | null = null;
  if (o.headroom) {
    const h = await o.headroom();
    if (!h.ok) stop = { reason: CAP_STOP[h.reason] ?? h.reason, detail: h.detail };
  }
  const started = new Array<boolean>(pending.length).fill(false);
  let first = 0; // every index below this has started
  const busy = new Set<string>();
  const lastEnd = new Map<string, number>();
  // Wakes workers waiting for a host to become free.
  let wake: (() => void) | null = null;
  let woken = new Promise<void>((r) => (wake = r));
  const signal = () => {
    const w = wake;
    woken = new Promise<void>((r) => (wake = r));
    w?.();
  };
  /** Next candidate whose host is idle and past its gap; else how long to wait (Infinity = until a host frees up). */
  const pick = (): { i: number } | { waitMs: number } | null => {
    while (first < pending.length && started[first]) first++;
    if (first >= pending.length) return null;
    let waitMs = Infinity;
    const t = clock();
    for (let i = first; i < pending.length; i++) {
      if (started[i]) continue;
      const h = pending[i].host;
      if (busy.has(h)) continue;
      const ready = (lastEnd.get(h) ?? -Infinity) + gap - t;
      if (ready <= 0) return { i };
      waitMs = Math.min(waitMs, ready);
    }
    return { waitMs };
  };
  const worker = async () => {
    while (!stop) {
      const p = pick();
      if (!p) return;
      if ("waitMs" in p) {
        await (Number.isFinite(p.waitMs) ? Promise.race([sleep(p.waitMs), woken]) : woken);
        continue;
      }
      started[p.i] = true;
      const c = pending[p.i];
      busy.add(c.host);
      o.onAttempt?.(c.key);
      const attemptStart = clock();
      let r: ProbeResult;
      try {
        r = await o.probeOne(c);
      } catch (e) {
        r = { verdict: "REFUSE", reason: "probe_error", target: c.url, detail: String((e as Error).message ?? e).slice(0, 200) };
      } finally {
        busy.delete(c.host);
        lastEnd.set(c.host, clock());
      }
      const capStop = CAP_STOP[r.reason];
      if (capStop) {
        stop ??= { reason: capStop, detail: r.detail };
        const row = skippedRow(c, capStop, now().toISOString(), r.detail);
        if (r.price) row.priceUsdc = r.price.usdc;
        emit(row);
      } else {
        let row = rowFromResult(c, r, now().toISOString());
        if (row.tx) knownTx.add(row.tx);
        const errorTx = r.reason === "payment_failed" && !row.paid ? alreadyInLedgerTx(r.detail) : undefined;
        if (errorTx && o.checkSettled) {
          // From a minute before this purchase started to a minute after its answer (unix seconds).
          const window = { from: Math.floor(attemptStart / 1000) - 60, to: Math.ceil(clock() / 1000) + 60 };
          try {
            // Match against what vet402 approved on the live 402 (payTo and price), not the Bazaar listing.
            const approved: Candidate = r.price ? { ...c, payTo: r.price.payTo, priceAtomic: BigInt(r.price.amountAtomic) } : c;
            const s = await o.checkSettled(approved, errorTx, window);
            if (s && !knownTx.has(s.tx)) {
              row = markSettled(row, s, errorTx);
              knownTx.add(s.tx);
            } else {
              row = { ...row, detail: clip(`${row.detail ?? ""} · ${s ? "its transfer is already recorded on another row" : "not found settled on chain"}`, 300) };
            }
          } catch (e) {
            row = { ...row, detail: clip(`${row.detail ?? ""} · on-chain check failed: ${String((e as Error).message ?? e)}`, 300) };
          }
        }
        emit(row);
      }
      signal();
    }
  };
  const n = Math.max(1, Math.min(4, o.concurrency ?? 1));
  await Promise.all(Array.from({ length: n }, worker));
  const s = stop as { reason: string; detail?: string } | null;
  if (s) for (let i = 0; i < pending.length; i++) if (!started[i]) emit(skippedRow(pending[i], s.reason, now().toISOString()));
  return rows;
}

export function totalsOf(rows: BoardRow[]): BoardFile["totals"] {
  let paid = 0n;
  for (const r of rows) if (r.paid && r.priceUsdc) paid += usdcToAtomic(r.priceUsdc);
  return {
    rows: rows.length,
    allow: rows.filter((r) => r.verdict === "ALLOW").length,
    refuse: rows.filter((r) => r.verdict === "REFUSE" && !notSent(r)).length,
    skipped: rows.filter((r) => r.verdict === "SKIPPED").length,
    unclear: rows.filter(notSent).length,
    paidUsdc: atomicToUsdc(paid),
  };
}

/** Keys that must not be bought again today, and attempts that never produced a row (crash mid-purchase). */
export function resumeState(prev: { rows?: BoardRow[]; attempts?: string[] } | null): { keep: BoardRow[]; done: Set<string>; interrupted: string[] } {
  const rows = prev?.rows ?? [];
  const keep = rows.filter((r) => r.verdict !== "SKIPPED" || r.reason === "interrupted");
  const done = new Set(keep.map((r) => `${r.method} ${r.url}`));
  const withRow = new Set(rows.map((r) => `${r.method} ${r.url}`));
  const interrupted = (prev?.attempts ?? []).filter((k) => !withRow.has(k) && !done.has(k));
  for (const k of interrupted) done.add(k);
  return { keep, done, interrupted };
}

/**
 * Re-check a written board file: every payment_failed "already in ledger" row not yet paid is looked up
 * on chain (window: 15 min before the row's time to 1 min after) and marked paid when vet402's transfer
 * is found. Totals are recomputed. Returns the rows it changed.
 */
export async function repairSettled(
  board: { rows: BoardRow[]; totals?: BoardFile["totals"] },
  check: SettledCheck,
): Promise<{ changed: BoardRow[]; notFound: string[] }> {
  const known = new Set(board.rows.filter((r) => r.paid && r.tx).map((r) => r.tx!));
  const changed: BoardRow[] = [];
  const notFound: string[] = [];
  for (let i = 0; i < board.rows.length; i++) {
    const r = board.rows[i];
    const errorTx = r.reason === "payment_failed" && !r.paid ? alreadyInLedgerTx(r.detail) : undefined;
    const at = Date.parse(r.at);
    if (!errorTx || !r.payTo || !r.priceUsdc || !Number.isFinite(at)) continue;
    const c: Candidate = { key: `${r.method} ${r.url}`, url: r.url, host: r.host, method: r.method as "GET" | "POST", input: r.input ?? "", payTo: r.payTo, priceAtomic: usdcToAtomic(r.priceUsdc) };
    const s = await check(c, errorTx, { from: Math.floor(at / 1000) - 900, to: Math.ceil(at / 1000) + 60 });
    if (!s || known.has(s.tx)) {
      notFound.push(errorTx);
      continue;
    }
    known.add(s.tx);
    board.rows[i] = markSettled(r, s, errorTx);
    changed.push(board.rows[i]);
  }
  // Only the paid total moves (verdicts and reasons are unchanged); the rest of the file stays as written.
  if (changed.length && board.totals) board.totals = { ...board.totals, paidUsdc: totalsOf(board.rows).paidUsdc };
  return { changed, notFound };
}

/** The indexer lookup used by a run and by --repair-settled. */
export function indexerSettledCheck(cfg: Pick<AppConfig, "indexerUrl" | "usdcAsaId">, payer: string): SettledCheck {
  return (c, errorTx, window) =>
    c.payTo && c.priceAtomic !== undefined
      ? findSettledPaymentWithRetry({ indexerUrl: cfg.indexerUrl, txid: errorTx, payer, payTo: c.payTo, asaId: cfg.usdcAsaId, maxAmountAtomic: c.priceAtomic, window })
      : Promise.resolve(null);
}

/** A board file as the sweep writes it: the payment check is kept in full (the page reads a summary of it). */
export type WrittenBoard = Omit<BoardFile, "reconcile"> & { reconcile?: ReconcileResult };

/** Exit code of a run whose payment check found a payment on no row, or could not read the chain. */
export const EXIT_PAYMENT_CHECK = 3;

/** tx ids on any row of any board file in `dir` (daily and census, every day). */
export function recordedTxIn(dir: string): Set<string> {
  const out = new Set<string>();
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      const d = JSON.parse(readFileSync(join(dir, n), "utf8")) as { rows?: unknown };
      if (Array.isArray(d.rows)) for (const r of d.rows as BoardRow[]) if (r && typeof r.tx === "string" && r.tx) out.add(r.tx);
    } catch {
      /* not a board file */
    }
  }
  return out;
}

/** The daily for this UTC day already finished its purchases (a later run that day buys nothing). */
export function dailyComplete(prev: { completedAt?: unknown } | null | undefined): boolean {
  return typeof prev?.completedAt === "string" && Number.isFinite(Date.parse(prev.completedAt));
}

/**
 * The payment check on a written file (read-only): rows paired one to one are updated in place and
 * totals.paidUsdc follows. The window runs from 2 minutes before the file's startedAt to `to`.
 */
export async function reconcileFile(
  board: { rows: BoardRow[]; startedAt?: string; payer?: string; totals?: BoardFile["totals"] },
  dir: string,
  cfg: Pick<AppConfig, "indexerUrl" | "usdcAsaId">,
  to: Date,
  fetchImpl?: typeof fetch,
): Promise<ReconcileResult> {
  const started = Date.parse(board.startedAt ?? "");
  if (!board.payer || !Number.isFinite(started)) throw new Error("the file has no payer or startedAt");
  const recorded = recordedTxIn(dir);
  for (const r of board.rows) if (r.tx) recorded.add(r.tx);
  const res = await reconcileRows({
    indexerUrl: cfg.indexerUrl,
    payer: board.payer,
    asaId: cfg.usdcAsaId,
    rows: board.rows,
    recorded,
    from: new Date(started - WINDOW_LEAD_MS),
    to,
    fetchImpl,
  });
  if (res.recorded.length && board.totals) board.totals = { ...board.totals, paidUsdc: totalsOf(board.rows).paidUsdc };
  return res;
}

function logReconcile(r: ReconcileResult): void {
  console.log(reconcileLine(r));
  for (const x of r.recorded) console.log(`  recorded paid (settled on chain): tx ${x.tx}  ${x.url}`);
  for (const u of r.unmatched) console.log(`  ON NO ROW: tx ${u.tx} · ${u.amountUsdc} USDC to ${u.payTo} · round ${u.round} · ${u.why}`);
}

function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** At least 60 s between purchases from one host; --host-gap-ms can only make it longer. */
export const MIN_HOST_GAP_MS = 60_000;
export function hostGapMs(argv: string[]): number {
  const v = Number(argValue(argv, "--host-gap-ms") ?? MIN_HOST_GAP_MS);
  return Number.isFinite(v) ? Math.max(MIN_HOST_GAP_MS, v) : MIN_HOST_GAP_MS;
}

function addressOfMnemonic(m: string | undefined): string | undefined {
  const s = m?.trim();
  return s ? addressFromSeed(seedFromMnemonic(s)) : undefined;
}

/** --repair-settled <file> [--write]: re-check "already in ledger" rows of a written file on chain. No key, no payment. */
async function repairMain(argv: string[], file: string): Promise<void> {
  const cfg: AppConfig = loadConfig({ ...process.env, I_UNDERSTAND_MAINNET_MOVES_REAL_FUNDS: "yes" });
  const board = JSON.parse(readFileSync(file, "utf8")) as BoardFile;
  if (!board.payer) throw new Error(`${file} has no payer`);
  if (board.network !== cfg.network) throw new Error(`${file} is ${board.network}; this run reads ${cfg.network} (set X402_NETWORK)`);
  const before = board.totals?.paidUsdc;
  const { changed, notFound } = await repairSettled(board, indexerSettledCheck(cfg, board.payer));
  for (const r of changed) console.log(`paid    ${r.priceUsdc}  ${r.host}  tx ${r.tx}`);
  for (const t of notFound) console.log(`not found settled: ${t}`);
  console.log(`${file}: ${changed.length} row(s) found settled on chain · paid ${before} → ${board.totals?.paidUsdc} USDC`);
  if (changed.length && argv.includes("--write")) {
    writeJsonAtomic(file, board);
    console.log(`written: ${file}`);
  } else if (changed.length) console.log("not written (add --write)");
}

/**
 * --reconcile <file> [--write]: the payment check on a written file, for the time the file covers
 * (startedAt - 2 min to finishedAt + 2 min). No key, no payment. Exit code 3 when a payment is on no row.
 */
async function reconcileMain(argv: string[], file: string): Promise<number> {
  const cfg: AppConfig = loadConfig({ ...process.env, I_UNDERSTAND_MAINNET_MOVES_REAL_FUNDS: "yes" });
  const board = JSON.parse(readFileSync(file, "utf8")) as WrittenBoard;
  if (board.network !== cfg.network) throw new Error(`${file} is ${board.network}; this run reads ${cfg.network} (set X402_NETWORK)`);
  const before = board.totals?.paidUsdc;
  const to = new Date(Date.parse(board.finishedAt) + WINDOW_LEAD_MS);
  const r = await reconcileFile(board, dirname(file), cfg, to);
  logReconcile(r);
  console.log(`${file}: paid ${before} → ${board.totals?.paidUsdc} USDC`);
  if (argv.includes("--write") && r.status !== "unavailable") {
    board.reconcile = r;
    writeJsonAtomic(file, board);
    console.log(`written: ${file}`);
  } else if (r.recorded.length || r.unmatched.length) console.log("not written (add --write)");
  return r.status === "ok" ? 0 : EXIT_PAYMENT_CHECK;
}

/**
 * Today's daily already finished its purchases: buy nothing. Repeat the payment check (read-only): a
 * payment the facilitator settled after the first check (a transaction stays valid for about 1,000
 * rounds) shows up now. The file is rewritten only when the check changed something.
 */
async function recheckCompletedDaily(file: string, latest: string, cfg: AppConfig): Promise<number> {
  const board = JSON.parse(readFileSync(file, "utf8")) as WrittenBoard;
  console.log(`daily for ${board.date} already completed at ${board.completedAt} (${file}): no purchase in this run.`);
  const prev = board.reconcile;
  const r = await reconcileFile(board, dirname(file), cfg, new Date());
  logReconcile(r);
  if (r.status === "unavailable" && prev?.status === "ok") {
    console.log("the earlier payment check of this run found every payment on a row; kept as it is.");
    return 0;
  }
  const changed = !prev || prev.status !== r.status || r.recorded.length > 0 || prev.unmatched.map((u) => u.tx).join() !== r.unmatched.map((u) => u.tx).join();
  if (changed) {
    board.reconcile = r;
    writeJsonAtomic(file, board);
    const l = existsSync(latest) ? (JSON.parse(readFileSync(latest, "utf8")) as { date?: string }) : null;
    if (l?.date === board.date) writeJsonAtomic(latest, board);
    console.log(`written: ${file}`);
  }
  return r.status === "ok" ? 0 : EXIT_PAYMENT_CHECK;
}

export async function main(argv: string[]): Promise<number> {
  const repair = argValue(argv, "--repair-settled");
  if (repair) {
    await repairMain(argv, repair);
    return 0;
  }
  const reconcileOnly = argValue(argv, "--reconcile");
  if (reconcileOnly) return reconcileMain(argv, reconcileOnly);
  const dryRun = argv.includes("--dry-run");
  const census = argv.includes("--census");
  const env = process.env;
  // A dry run never builds a signer, so it does not need the MainNet unlock.
  const cfg: AppConfig = loadConfig(dryRun ? { ...env, I_UNDERSTAND_MAINNET_MOVES_REAL_FUNDS: "yes" } : env);
  const targets = argValue(argv, "--targets");
  // The day is fixed at start: file names, the indexer's "sent today" window and the ledger's
  // day all use it, even if the run crosses 00:00 UTC.
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const outDir = argValue(argv, "--out") ?? (cfg.networkName === "mainnet" ? "board" : join("state", "board-testnet"));
  const file = join(outDir, census ? `census-${date}.json` : `${date}.json`);
  const latest = join(outDir, census ? "census-latest.json" : "latest.json");
  // Several schedules a day: the first one that finishes the daily is the only one that buys.
  if (!dryRun && !census && !targets && existsSync(file) && dailyComplete(JSON.parse(readFileSync(file, "utf8")) as { completedAt?: unknown })) {
    return recheckCompletedDaily(file, latest, cfg);
  }
  const boardPerDay = env.BOARD_MAX_PER_DAY_USDC ? usdcToAtomic(env.BOARD_MAX_PER_DAY_USDC) : cfg.maxPerDayAtomic;
  if (boardPerDay < cfg.maxPerCallAtomic) throw new Error("BOARD_MAX_PER_DAY_USDC must be >= the per-call cap");
  const boardCfg: AppConfig = { ...cfg, maxPerDayAtomic: boardPerDay };

  const testnetKeys = cfg.networkName === "testnet" && existsSync(cfg.keysFile) ? loadKeys(cfg.keysFile) : undefined;
  const customerPayTo = cfg.payTo ?? testnetKeys?.vet402.address;
  const customerPayer =
    addressOfMnemonic(env.PAYER_MNEMONIC) ?? (cfg.networkName === "mainnet" ? KNOWN_MAINNET_PAYER : testnetKeys?.vet402.address);
  let boardPayer: Payer | undefined;
  let boardPayerAddress: string | undefined;
  if (!dryRun) {
    const m = env.BOARD_PAYER_MNEMONIC?.trim();
    boardPayer = m ? { address: addressOfMnemonic(m)!, secretKeyB64: secretKeyB64FromMnemonic(m) } : loadPayer(cfg.networkName, cfg.keysFile, env);
    boardPayerAddress = boardPayer.address;
  } else {
    boardPayerAddress = addressOfMnemonic(env.BOARD_PAYER_MNEMONIC) ?? env.BOARD_PAYER_ADDRESS ?? customerPayer;
  }
  const sharedWallet = !!boardPayerAddress && boardPayerAddress === customerPayer;
  // On the /v1/check payer wallet, board purchases would (1) use up the customers' daily cap (same
  // on-chain total) and (2) show up in /activity, which pairs any payer payout with the latest
  // unpaid customer payment within 300 s: a board purchase could be credited to a customer.
  if (!dryRun && cfg.networkName === "mainnet" && sharedWallet && !argv.includes("--share-payer-wallet")) {
    throw new Error(
      "MainNet board runs need their own wallet: set BOARD_PAYER_MNEMONIC (not the /v1/check payer). --share-payer-wallet overrides this.",
    );
  }
  const ownAddresses = [...new Set([customerPayTo, customerPayer, boardPayerAddress].filter((a): a is string => !!a))];
  const ownHosts = [...OWN_HOSTS, ...(env.BOARD_OWN_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)];

  // --- candidates
  let candidates: Candidate[];
  let selection: NonNullable<BoardFile["selection"]>;
  if (targets) {
    candidates = targets
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((u) => ({ key: `GET ${u}`, url: u, host: new URL(u).hostname, method: "GET" as const, input: "(none)" }));
    candidates = candidates.filter((c, i) => candidates.findIndex((d) => d.key === c.key) === i);
    selection = { source: "targets", candidates: candidates.length, excluded: {} };
  } else {
    const bazaar = argValue(argv, "--bazaar") ?? DEFAULT_BAZAAR;
    const items = await fetchBazaar(bazaar);
    const maxAge = argValue(argv, "--max-age-days");
    const r = selectCandidates(items, {
      network: cfg.network,
      usdcAsaId: cfg.usdcAsaId,
      maxPerCallAtomic: cfg.maxPerCallAtomic,
      now,
      maxAgeDays: census ? (maxAge ? Number(maxAge) : null) : Number(maxAge ?? 7),
      ownAddresses,
      ownHosts,
      allowPrivate: cfg.allowPrivateTargets,
      perHost: !census,
    });
    candidates = r.candidates;
    selection = { source: `${bazaar} (${items.length} items)`, candidates: candidates.length, excluded: r.excluded };
  }
  // Census: each day starts each host at a different resource, so the per-host limit reaches the rest on later days.
  if (census) candidates = rotateWithinHost(candidates, dayShift(date, MAX_PER_HOST_PER_RUN));
  const limit = argValue(argv, "--limit");
  if (limit) candidates = candidates.slice(0, Number(limit));
  const readSpent = boardPayerAddress
    ? () => usdcSentToday({ indexerUrl: cfg.indexerUrl, address: boardPayerAddress!, asaId: cfg.usdcAsaId, now })
    : undefined;
  // Daily and census share one "bought today" record and one ledger for the day.
  const otherFile = join(outDir, census ? `${date}.json` : `census-${date}.json`);
  const ledgerFile = join(outDir, `spend-${cfg.networkName}.json`);

  const listedEstimate = candidates.reduce((s, c) => s + (c.priceAtomic ?? 0n), 0n);
  const hosts = new Set(candidates.map((c) => c.host)).size;
  console.log(`mode ${census ? "census" : targets ? "targets" : "daily"} · ${cfg.networkName} ${cfg.network}`);
  console.log(`source ${selection.source}`);
  console.log(`excluded ${JSON.stringify(selection.excluded)}`);
  const nFilled = candidates.filter((c) => c.filled?.length).length;
  const nUnfillable = candidates.filter((c) => c.unfillable?.length).length;
  if (nFilled || nUnfillable) console.log(`placeholders: ${nFilled} filled with fresh values · ${nUnfillable} not fillable (recorded as placeholder_unfillable, not paid)`);
  console.log(`board payer ${boardPayerAddress ?? "(unknown)"}${sharedWallet ? " (same wallet as /v1/check: its daily cap reads the same on-chain total)" : ""}`);
  console.log(`own addresses excluded: ${ownAddresses.join(", ")} · own hosts excluded: ${ownHosts.join(", ")}`);

  if (dryRun) {
    // The same plan runSweep makes (no resume files are read in a dry run): unfillable rows are not sent, then ≤ 5 per host.
    const { take: plan, rest: notMeasured } = limitPerHost(
      candidates.filter((c) => !c.unfillable?.length),
      MAX_PER_HOST_PER_RUN,
    );
    const show = census ? plan.slice(0, 20) : plan;
    for (const c of show) console.log(`  ${c.priceAtomic !== undefined ? atomicToUsdc(c.priceAtomic) : "?"}  ${c.method.padEnd(4)} ${c.url.slice(0, 110)}  ${c.lastSeen?.slice(0, 10) ?? ""}`);
    if (show.length < plan.length) console.log(`  … ${plan.length - show.length} more`);
    let spent: bigint | undefined;
    try {
      spent = readSpent ? await readSpent() : undefined;
    } catch (e) {
      console.log(`indexer: ${(e as Error).message}`);
    }
    let fit = 0;
    let acc = spent ?? 0n;
    for (const c of plan) {
      if (acc + (c.priceAtomic ?? 0n) > boardPerDay) break;
      acc += c.priceAtomic ?? 0n;
      fit++;
    }
    const perHost = (xs: Candidate[]) => {
      const m = new Map<string, number>();
      for (const c of xs) m.set(c.host, (m.get(c.host) ?? 0) + 1);
      const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
      return top ? `${top[1]} (${top[0]})` : "0";
    };
    const planEstimate = plan.reduce((s, c) => s + (c.priceAtomic ?? 0n), 0n);
    console.log(
      `listed ${candidates.length} · hosts ${hosts} · most per host ${perHost(candidates)} · listed total ${atomicToUsdc(listedEstimate)} USDC`,
    );
    console.log(
      `this run: buy ${plan.length} (≤ ${MAX_PER_HOST_PER_RUN} per host; most per host ${perHost(plan)}) · estimate ${atomicToUsdc(planEstimate)} USDC · not measured this run ${notMeasured.length} (SKIPPED ${NOT_MEASURED}, not paid)`,
    );
    console.log(
      `board daily cap ${atomicToUsdc(boardPerDay)} USDC · spent today ${spent !== undefined ? atomicToUsdc(spent) : "unknown"} USDC · would buy ${fit}, would skip ${plan.length - fit} (daily_cap)`,
    );
    let tail = 0;
    for (let i = plan.length - 1; i >= 0 && plan[i].host === plan[plan.length - 1]?.host; i--) tail++;
    let adjacent = 0;
    for (let i = 1; i < plan.length; i++) if (plan[i].host === plan[i - 1].host) adjacent++;
    console.log(
      `pacing: ${census ? "round-robin by host" : "one per host"} · never two purchases in flight to one host · ≥ ${hostGapMs(argv)} ms between purchases from one host · same host next to itself ${adjacent} times (tail run ${tail > 1 ? `${tail} × ${plan[plan.length - 1].host}` : "none"})`,
    );
    console.log("dry-run: no payment was made and no file was written.");
    return 0;
  }

  if (!census && !targets && existsSync(otherFile)) {
    console.log(`census already ran on ${date} (${otherFile}); the daily sweep does not run on a census day.`);
    return 0;
  }
  const readJson = (f: string) => (existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { rows?: BoardRow[]; attempts?: string[] }) : null);
  const prev = readJson(file);
  const { keep, done, interrupted } = resumeState(prev);
  if (!targets) {
    const other = resumeState(readJson(otherFile)).done;
    const already = candidates.filter((c) => other.has(c.key) && !done.has(c.key)).length;
    for (const k of other) done.add(k);
    if (already > 0) selection.excluded[census ? "bought_by_daily_today" : "bought_by_census_today"] = already;
  }
  const rows: BoardRow[] = [...keep];
  const attempts: string[] = [...new Set([...(prev?.attempts ?? [])])];
  for (const k of interrupted) {
    const c = candidates.find((x) => x.key === k);
    const [method, ...rest] = k.split(" ");
    rows.push(
      c
        ? skippedRow(c, "interrupted", now.toISOString(), "an earlier run stopped during this purchase; not retried today")
        : { at: now.toISOString(), url: rest.join(" "), host: "", method, verdict: "SKIPPED", reason: "interrupted", paid: false },
    );
  }
  const startedAt = (prev as { startedAt?: string } | null)?.startedAt ?? now.toISOString();
  let completedAt: string | undefined;
  let reconcile: ReconcileResult | undefined;
  const snapshot = (): WrittenBoard & { attempts: string[]; mode: string } => ({
    version: 1,
    mode: census ? "census" : targets ? "targets" : "daily",
    network: cfg.network,
    networkName: cfg.networkName,
    date,
    startedAt,
    finishedAt: new Date().toISOString(),
    payer: boardPayerAddress,
    caps: { perCallUsdc: atomicToUsdc(cfg.maxPerCallAtomic), perDayUsdc: atomicToUsdc(boardPerDay) },
    selection,
    totals: totalsOf(rows),
    ...(completedAt ? { completedAt } : {}),
    ...(reconcile ? { reconcile } : {}),
    rows,
    attempts,
  });

  // Ledger lives in board/ (committed by the workflow), so the next run starts from today's total.
  const ledger = new SpendLedger(cfg.maxPerCallAtomic, boardPerDay, ledgerFile, () => now);
  const guard = new IndexedSpendGuard(ledger, readSpent!);
  try {
    ledger.raiseFloor(await readSpent!()); // on-chain total at start is the floor for this run
  } catch {
    /* headroom() below reports cap_check_unavailable and nothing is bought */
  }
  const baseDeps: ProbeDeps = {
    fetchImpl: (u, i) => fetch(u, i),
    paidFetch: makePaidFetch(boardCfg, boardPayer!.secretKeyB64),
    ownAddresses,
  };
  const h0 = await guard.headroom();
  // Today's earlier attempts (this file and the other mode's) count toward the per-host limit.
  const priorPerHost = attemptsPerHost(done);
  const plan = limitPerHost(
    candidates.filter((c) => !done.has(c.key) && !c.unfillable?.length),
    MAX_PER_HOST_PER_RUN,
    priorPerHost,
  );
  const estimate = plan.take.reduce((s, c) => s + (c.priceAtomic ?? 0n), 0n);
  console.log(
    `buying ${plan.take.length} (≤ ${MAX_PER_HOST_PER_RUN} per host; not measured this run ${plan.rest.length}; already done today: ${done.size}) · estimate ${atomicToUsdc(estimate)} USDC · headroom ${h0.ok ? atomicToUsdc(h0.remainingAtomic) : h0.reason}`,
  );
  // Tx ids already recorded today: an "already in ledger" lookup never records one of them again.
  const knownTx = new Set<string>();
  for (const f of [file, otherFile]) for (const r of readJson(f)?.rows ?? []) if (r.paid && r.tx) knownTx.add(r.tx);

  await runSweep(candidates, {
    probeOne: (c) => probe(c.requestUrl ?? c.url, boardCfg, guard, withInput(baseDeps, c)),
    headroom: async () => (h0.ok ? { ok: true } : { ok: false, reason: h0.reason, detail: h0.detail }),
    concurrency: census ? Number(argValue(argv, "--concurrency") ?? 3) : 1,
    hostGapMs: hostGapMs(argv),
    maxPerHost: MAX_PER_HOST_PER_RUN,
    priorPerHost,
    checkSettled: indexerSettledCheck(cfg, boardPayerAddress!),
    knownTx,
    done,
    onAttempt: (k) => {
      attempts.push(k);
      writeJsonAtomic(file, snapshot());
    },
    onRow: (r) => {
      rows.push(r);
      writeJsonAtomic(file, snapshot());
      console.log(`${r.verdict.padEnd(7)} ${r.reason.padEnd(22)} ${(r.priceUsdc ?? "").padEnd(9)} ${r.url.slice(0, 90)}${r.tx ? `  tx ${r.tx}` : ""}`);
    },
  });
  // Done buying for today, unless nothing could be bought because the cap could not be read (a later run retries).
  if (!rows.some((r) => r.reason === "cap_check_unavailable")) completedAt = new Date().toISOString();
  writeJsonAtomic(file, snapshot());
  // Payment check: every board-wallet USDC transfer of this run must be on a row. The indexer can trail
  // the chain by a few seconds, so it waits a little when this run paid anything.
  if (attempts.length > (prev?.attempts?.length ?? 0)) await new Promise<void>((r) => setTimeout(r, 15_000));
  const recorded = recordedTxIn(outDir);
  for (const r of rows) if (r.tx) recorded.add(r.tx);
  reconcile = await reconcileRows({
    indexerUrl: cfg.indexerUrl,
    payer: boardPayerAddress!,
    asaId: cfg.usdcAsaId,
    rows,
    recorded,
    from: new Date(Date.parse(startedAt) - WINDOW_LEAD_MS),
    to: new Date(),
  });
  const final = snapshot();
  writeJsonAtomic(file, final);
  writeJsonAtomic(latest, final);
  const t = final.totals;
  console.log(`done: ${t.rows} rows · ALLOW ${t.allow} · REFUSE ${t.refuse} · SKIPPED ${t.skipped} · UNCLEAR (not sent) ${t.unclear ?? 0} · paid ${t.paidUsdc} USDC → ${file}, ${latest}`);
  logReconcile(reconcile);
  return reconcile.status === "ok" ? 0 : EXIT_PAYMENT_CHECK;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code) process.exitCode = code;
    },
    (e) => {
      console.error(`board-sweep: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
