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
 * Options: --out <dir> --limit <n> --concurrency <1-4> --host-gap-ms <n, min 2000> --max-age-days <n> --bazaar <url> --share-payer-wallet
 *
 * Pacing: census takes turns between hosts (round-robin), never has two purchases in flight to the
 * same host, and waits at least 2 s between the end of one purchase from a host and the next one.
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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  const pending = todo.filter((c) => !c.unfillable?.length);
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
        emit(rowFromResult(c, r, now().toISOString()));
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

/** At least 2 s between purchases from one host; --host-gap-ms can only make it longer. */
export const MIN_HOST_GAP_MS = 2000;
export function hostGapMs(argv: string[]): number {
  const v = Number(argValue(argv, "--host-gap-ms") ?? MIN_HOST_GAP_MS);
  return Number.isFinite(v) ? Math.max(MIN_HOST_GAP_MS, v) : MIN_HOST_GAP_MS;
}

function addressOfMnemonic(m: string | undefined): string | undefined {
  const s = m?.trim();
  return s ? addressFromSeed(seedFromMnemonic(s)) : undefined;
}

async function main(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const census = argv.includes("--census");
  const env = process.env;
  // A dry run never builds a signer, so it does not need the MainNet unlock.
  const cfg: AppConfig = loadConfig(dryRun ? { ...env, I_UNDERSTAND_MAINNET_MOVES_REAL_FUNDS: "yes" } : env);
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
  const now = new Date();
  let candidates: Candidate[];
  let selection: NonNullable<BoardFile["selection"]>;
  const targets = argValue(argv, "--targets");
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
  const limit = argValue(argv, "--limit");
  if (limit) candidates = candidates.slice(0, Number(limit));

  // The day is fixed at start: file names, the indexer's "sent today" window and the ledger's
  // day all use it, even if the run crosses 00:00 UTC.
  const date = now.toISOString().slice(0, 10);
  const outDir = argValue(argv, "--out") ?? (cfg.networkName === "mainnet" ? "board" : join("state", "board-testnet"));
  const file = join(outDir, census ? `census-${date}.json` : `${date}.json`);
  const latest = join(outDir, census ? "census-latest.json" : "latest.json");
  const readSpent = boardPayerAddress
    ? () => usdcSentToday({ indexerUrl: cfg.indexerUrl, address: boardPayerAddress!, asaId: cfg.usdcAsaId, now })
    : undefined;
  // Daily and census share one "bought today" record and one ledger for the day.
  const otherFile = join(outDir, census ? `${date}.json` : `census-${date}.json`);
  const ledgerFile = join(outDir, `spend-${cfg.networkName}.json`);

  const estimate = candidates.reduce((s, c) => s + (c.priceAtomic ?? 0n), 0n);
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
    const show = census ? candidates.slice(0, 20) : candidates;
    for (const c of show) console.log(`  ${c.priceAtomic !== undefined ? atomicToUsdc(c.priceAtomic) : "?"}  ${c.method.padEnd(4)} ${c.url.slice(0, 110)}  ${c.lastSeen?.slice(0, 10) ?? ""}`);
    if (show.length < candidates.length) console.log(`  … ${candidates.length - show.length} more`);
    let spent: bigint | undefined;
    try {
      spent = readSpent ? await readSpent() : undefined;
    } catch (e) {
      console.log(`indexer: ${(e as Error).message}`);
    }
    let fit = 0;
    let acc = spent ?? 0n;
    for (const c of candidates) {
      if (acc + (c.priceAtomic ?? 0n) > boardPerDay) break;
      acc += c.priceAtomic ?? 0n;
      fit++;
    }
    console.log(
      `candidates ${candidates.length} · hosts ${hosts} · estimate ${atomicToUsdc(estimate)} USDC · board daily cap ${atomicToUsdc(boardPerDay)} USDC · spent today ${spent !== undefined ? atomicToUsdc(spent) : "unknown"} USDC · would buy ${fit}, would skip ${candidates.length - fit} (daily_cap)`,
    );
    let tail = 0;
    for (let i = candidates.length - 1; i >= 0 && candidates[i].host === candidates[candidates.length - 1]?.host; i--) tail++;
    let adjacent = 0;
    for (let i = 1; i < candidates.length; i++) if (candidates[i].host === candidates[i - 1].host) adjacent++;
    console.log(
      `pacing: ${census ? "round-robin by host" : "one per host"} · never two purchases in flight to one host · ≥ ${hostGapMs(argv)} ms between purchases from one host · same host next to itself ${adjacent} times (tail run ${tail > 1 ? `${tail} × ${candidates[candidates.length - 1].host}` : "none"})`,
    );
    console.log("dry-run: no payment was made and no file was written.");
    return;
  }

  if (!census && !targets && existsSync(otherFile)) {
    console.log(`census already ran on ${date} (${otherFile}); the daily sweep does not run on a census day.`);
    return;
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
  const snapshot = (): BoardFile & { attempts: string[]; mode: string } => ({
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
  console.log(`buying ${candidates.filter((c) => !done.has(c.key)).length} (already done today: ${done.size}) · estimate ${atomicToUsdc(estimate)} USDC · headroom ${h0.ok ? atomicToUsdc(h0.remainingAtomic) : h0.reason}`);

  await runSweep(candidates, {
    probeOne: (c) => probe(c.requestUrl ?? c.url, boardCfg, guard, withInput(baseDeps, c)),
    headroom: async () => (h0.ok ? { ok: true } : { ok: false, reason: h0.reason, detail: h0.detail }),
    concurrency: census ? Number(argValue(argv, "--concurrency") ?? 3) : 1,
    hostGapMs: hostGapMs(argv),
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
  const final = snapshot();
  writeJsonAtomic(file, final);
  writeJsonAtomic(latest, final);
  const t = final.totals;
  console.log(`done: ${t.rows} rows · ALLOW ${t.allow} · REFUSE ${t.refuse} · SKIPPED ${t.skipped} · UNCLEAR (not sent) ${t.unclear ?? 0} · paid ${t.paidUsdc} USDC → ${file}, ${latest}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`board-sweep: ${(e as Error).message}`);
    process.exit(1);
  });
}
