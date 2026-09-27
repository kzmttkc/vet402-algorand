/**
 * /try — the first step for someone who has never used x402. Free routes (mounted before the payment middlewares).
 *
 *   GET  /try               the page: pick a seller (or paste its URL), see what vet402 got last time, try it free
 *   GET  /try/preview?url=  free JSON: vet402's last recorded result for that URL (same data as /v1/verdict) and
 *                           today's price through /v1/buy (same reading as the unpaid /v1/buy 402). Never charges,
 *                           never pays anyone, never sends a customer body (quote() in buy.ts). 30 reads/min per IP.
 *   GET  /try/sellers.json  the sellers vet402 has paid (board + census): the ones the free try can buy first
 *                           (GET, paid, DELIVERED or MISMATCH, within the trial cap), then "own wallet only" ones
 *   POST /try/run           "Try vet402 (free, once per person)": vet402 buys once with its trial wallet (trial.ts)
 *   GET  /try/log(.json)    public record of the trials: time, seller, result, tx (no IP, no hash)
 */
import type { Context, Hono } from "hono";
import { atomicToUsdc, usdcToAtomic, type AppConfig } from "./config.js";
import {
  BOARD_ISSUES_URL,
  UNCLEAR_NOTE,
  censusFileFor,
  defaultBoardFile,
  displayClass,
  esc,
  hostOf,
  sellerPath,
  sharedBoardLoader,
  txLink,
  type BoardFile,
  type BoardLoader,
  type BoardRow,
  type DisplayClass,
} from "./board.js";
import { lookupVerdict, normalizeTargetUrl } from "./lookup.js";
import { BUY_PATH, QuoteLimiter, quote, readBodyCapped, type QuoteOutcome } from "./buy.js";
import { probeWithBody, type ProbeDeps } from "./probe.js";
import { checkTarget } from "./target.js";
import type { Catalog } from "./bazaar.js";
import type { SpendGuard } from "./spend.js";
import { SELLER_PAGE_BASE } from "./seller.js";
import { BASE_CSS, topNav } from "./landing.js";
import { claimKeys, countedLog, handleToken, isAlgorandAddress, normalizeFrom, normalizeHandle, type TrialLog, type TrialStore } from "./trial.js";
import { timingSafeEqual } from "node:crypto";
import type { SettleFirstEnv } from "./settle-first.js";
import type { ActivityReport } from "./activity.js";
import { WALLET_JS, WALLET_JS_SHA } from "./web/wallet-bundle.gen.js";

export const TRY_PREVIEWS_PER_MINUTE = 30;
export const TRY_RUNS_PER_MINUTE = 5;
/** Free tries paid to one seller host per UTC day (so one seller cannot drain the trial wallet). */
export const TRY_PER_SELLER_PER_DAY = 3;
const RUN_MAX_BODY = 4 * 1024;

/** Most of the seller's answer the free trial shows, in bytes of text. */
export const TRY_PREVIEW_BYTES = 2048;

const TEXTUAL = /^(text\/[\w.+-]+|application\/([\w.+-]*\+)?(json|xml)|application\/(javascript|x-ndjson|csv|x-www-form-urlencoded))$/;

/**
 * What the seller returned, as data for the page: text (JSON pretty-printed) up to TRY_PREVIEW_BYTES,
 * or only the type and size for images and other binary answers. The page puts `text` in with textContent.
 */
export function contentPreview(bytes: Buffer, contentType: string | null): { contentType: string | null; bytes: number; text?: string; truncated: boolean } {
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const base = { contentType, bytes: bytes.length, truncated: false };
  if (bytes.length === 0) return { ...base, text: "" };
  if (!TEXTUAL.test(ct)) return base;
  let text = bytes.toString("utf8");
  if (/json/.test(ct)) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* not valid JSON: show as sent */
    }
  }
  const b = Buffer.from(text, "utf8");
  if (b.length <= TRY_PREVIEW_BYTES) return { ...base, text };
  return { ...base, text: b.subarray(0, TRY_PREVIEW_BYTES).toString("utf8").replace(/\uFFFD+$/, ""), truncated: true };
}

/** Why vet402 answered as it did, in plain words (the reason code stays next to it). */
export function because(r: { reason: string; detail?: string; declared?: { expectedKeys?: string[]; exampleKeys?: string[] }; delivery?: { status: number; missingKeys: string[] } }): string {
  const req = r.declared?.expectedKeys ?? [];
  switch (r.reason) {
    case "delivered":
      return req.length
        ? `the answer is JSON and has every field the listing promised (${req.slice(0, 8).join(", ")})`
        : (r.declared?.exampleKeys?.length ?? 0) > 0
          ? "the answer is JSON and has the fields shown in the listing's example"
          : "the answer is non-empty JSON, and the listing promised nothing more specific";
    case "delivery_missing_keys":
      return `the answer is missing ${(r.delivery?.missingKeys ?? []).slice(0, 8).join(", ") || "the fields"} that the listing promised`;
    case "not_json":
      return "the listing promised JSON, and the answer is not JSON";
    case "empty_body":
      return "the answer was empty";
    case "http_error":
      return `the seller took the payment and answered with an error (HTTP ${r.delivery?.status ?? "?"})`;
    case "payment_failed":
      return "the payment did not go through, so nothing was delivered";
    case "not_x402":
      return "the URL did not ask for payment, so there was nothing to buy";
    default:
      return r.detail ? `${r.reason}: ${r.detail}` : r.reason;
  }
}

export interface TrialDeps {
  address: string;
  maxPerCallAtomic: bigint;
  maxPerDayAtomic: bigint;
  hashKey: Buffer;
  store: TrialStore;
  /** Daily cap of the trial wallet (chain-backed in production). */
  guard: SpendGuard;
  /** Pays from the trial wallet. */
  paidFetch: ProbeDeps["paidFetch"];
  /** X handles not shown (removal requests; env TRY_HIDDEN_HANDLES). Compared case-insensitively. */
  hiddenHandles?: string[];
}

export interface TryDeps {
  /** Main probe deps: fetchImpl, resolveHost, ownAddresses (every vet402 wallet, the trial wallet included). */
  probeDeps: ProbeDeps;
  catalog: Catalog;
  trial?: TrialDeps;
  boardFile?: string;
  load?: BoardLoader;
  /** Paying customers for the "today" line (the /activity ledger). */
  activity?: { get(): Promise<ActivityReport> };
  previewsPerMinute?: number;
  runsPerMinute?: number;
  now?: () => number;
}

/** Client IP as the platform reports it (Vercel sets x-real-ip / x-forwarded-for). */
export function clientIp(c: Context<SettleFirstEnv>): string {
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real;
  const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || "local";
}

/** The key "once per person" is counted by: an IPv4 address, or the /64 of an IPv6 address (one home or phone gets a whole /64). */
export function personKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const full = ip.split("%")[0];
  const [head, tail = ""] = full.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = full.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => (g || "0").toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

const short = (usdc: string) => usdc.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

export interface SellerOption {
  /** url */
  u: string;
  /** method */
  m: string;
  /** host */
  h: string;
  /** display class */
  c: DisplayClass;
  /** price USDC as recorded */
  p: string;
  /** The free try can buy it: GET, vet402 paid it last time, DELIVERED or MISMATCH, within the trial cap. */
  t: boolean;
  /** Why not, in plain words (only when t is false), e.g. "own wallet only: this seller needs a POST". */
  w?: string;
}

/** Local TestNet targets (ALLOW_PRIVATE_TARGETS only): exempt from the free try's list. */
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const CLASS_ORDER: Record<DisplayClass, number> = { DELIVERED: 0, MISMATCH: 1, UNCLEAR: 2, UNREACHABLE: 3 };

/** vet402 paid this seller on this record and could judge the delivery: DELIVERED or MISMATCH with a settled payment. */
const paidAndJudged = (r: BoardRow) => r.paid === true && ["DELIVERED", "MISMATCH"].includes(displayClass(r));

/**
 * The payTo vet402 recorded for each GET URL the free try may pay, for its allowlist: the newest record of that URL
 * must be a paid one (DELIVERED or MISMATCH). A URL whose last attempt did not get paid (UNCLEAR, payment_failed)
 * is not listed, so a visitor's one try is not spent on a seller vet402 itself could not pay.
 */
export function recordedPayTo(files: (BoardFile | null)[]): Map<string, string> {
  const m = new Map<string, BoardRow>();
  for (const f of files) {
    for (const r of f?.rows ?? []) {
      if (r.method !== "GET" || r.verdict === "SKIPPED") continue;
      const u = normalizeTargetUrl(r.url)?.toString();
      if (!u) continue;
      const prev = m.get(u);
      if (!prev || prev.at < r.at) m.set(u, r);
    }
  }
  return new Map([...m].filter(([, r]) => paidAndJudged(r) && r.payTo).map(([u, r]) => [u, r.payTo!]));
}

/**
 * The sellers vet402 has paid: one option per method + URL (newest record wins), and only when that record was paid
 * (an attempt vet402 could not pay, e.g. payment_failed, is left out: it is not a seller vet402 has bought from).
 * The ones the free try can buy come first (GET, paid, DELIVERED or MISMATCH, price within `trialMaxAtomic`),
 * then the rest, marked "own wallet only" with the reason; inside each, DELIVERED first, then cheapest.
 */
export function sellerOptions(files: (BoardFile | null)[], o: { trialMaxAtomic?: bigint } = {}): SellerOption[] {
  const m = new Map<string, { r: BoardRow; at: string }>();
  for (const f of files) {
    for (const r of f?.rows ?? []) {
      if (r.verdict === "SKIPPED" || !normalizeTargetUrl(r.url)) continue;
      const key = `${r.method} ${r.url}`;
      const prev = m.get(key);
      if (prev && prev.at >= r.at) continue;
      m.set(key, { r, at: r.at });
    }
  }
  const overCap = (p?: string) => {
    if (o.trialMaxAtomic === undefined) return false;
    try {
      return !p || usdcToAtomic(p) > o.trialMaxAtomic;
    } catch {
      return true;
    }
  };
  const price = (p: string) => (p ? Number(p) : Number.POSITIVE_INFINITY);
  return [...m.values()]
    .filter(({ r }) => r.paid === true && displayClass(r) !== "UNREACHABLE")
    .map(({ r }): SellerOption => {
      const c = displayClass(r);
      const w =
        r.method !== "GET"
          ? `own wallet only: this seller needs a ${r.method}, and the free try only does GET`
          : !paidAndJudged(r)
            ? "own wallet only: vet402 could not tell what this seller delivered last time"
            : overCap(r.priceUsdc)
              ? "own wallet only: its price is above what the free try pays"
              : undefined;
      return { u: r.url, m: r.method, h: hostOf(r), c, p: r.priceUsdc ? short(r.priceUsdc) : "", t: !w, ...(w ? { w } : {}) };
    })
    .sort((a, b) => Number(b.t) - Number(a.t) || CLASS_ORDER[a.c] - CLASS_ORDER[b.c] || price(a.p) - price(b.p) || a.h.localeCompare(b.h) || a.u.localeCompare(b.u));
}

function priceOut(q: QuoteOutcome, network: string) {
  if (!q.ok) return { ok: false as const, reason: q.body.reason, detail: q.body.detail, status: q.status };
  return {
    ok: true as const,
    method: q.priceRead === "get" ? "GET" : "POST",
    priceRead: q.priceRead,
    network,
    sellerPrice: { amountAtomic: q.sellerAtomic.toString(), usdc: atomicToUsdc(q.sellerAtomic) },
    fee: { amountAtomic: q.feeAtomic.toString(), usdc: atomicToUsdc(q.feeAtomic) },
    total: { amountAtomic: q.customerAtomic.toString(), usdc: atomicToUsdc(q.customerAtomic) },
  };
}

export function registerTry(app: Hono<SettleFirstEnv>, cfg: AppConfig, deps: TryDeps): void {
  const file = deps.boardFile ?? defaultBoardFile();
  const load = deps.load ?? sharedBoardLoader();
  const previews = new QuoteLimiter(deps.previewsPerMinute ?? TRY_PREVIEWS_PER_MINUTE, deps.now);
  const runs = new QuoteLimiter(deps.runsPerMinute ?? TRY_RUNS_PER_MINUTE, deps.now);
  const trial = deps.trial;
  const trialCfg: AppConfig | null = trial ? { ...cfg, maxPerCallAtomic: trial.maxPerCallAtomic, maxPerDayAtomic: trial.maxPerDayAtomic } : null;
  const trialProbeDeps: ProbeDeps | null = trial ? { ...deps.probeDeps, paidFetch: trial.paidFetch } : null;
  /** Claim keys with a trial running on this instance. */
  const busy = new Set<string>();

  const files = () => Promise.all([load(file), load(censusFileFor(file))]);
  let optionsCache: { daily: BoardFile | null; census: BoardFile | null; list: SellerOption[] } | null = null;

  app.get("/try", (c) =>
    c.html(
      tryHtml({
        networkName: cfg.networkName,
        buyFeeUsdc: atomicToUsdc(cfg.buyFeeAtomic),
        trial: trial ? { address: trial.address, maxUsdc: atomicToUsdc(trial.maxPerCallAtomic) } : null,
        walletJs: `/try/wallet.js?v=${WALLET_JS_SHA}`,
      }),
      200,
      { "cache-control": "public, max-age=300" },
    ),
  );

  // The wallet code (Pera, Lute, x402 AVM client) as one file, loaded by /try only when the visitor opens the wallet step.
  app.get("/try/wallet.js", (c) =>
    c.body(WALLET_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": c.req.query("v") === WALLET_JS_SHA ? "public, max-age=31536000, immutable" : "public, max-age=300",
      "x-content-type-options": "nosniff",
    }),
  );

  app.get("/try/sellers.json", async (c) => {
    const [daily, census] = await files();
    if (!optionsCache || optionsCache.daily !== daily || optionsCache.census !== census) optionsCache = { daily, census, list: sellerOptions([census, daily], { trialMaxAtomic: trial?.maxPerCallAtomic }) };
    return c.json({ sellers: optionsCache.list }, 200, { "cache-control": "public, max-age=300" });
  });

  app.get("/try/preview", async (c) => {
    const raw = c.req.query("url");
    const u = normalizeTargetUrl(raw);
    if (!u) return c.json({ error: "invalid_url", detail: "url must be an http(s) URL", charged: false }, 400);
    if (!previews.take(clientIp(c))) {
      return c.json({ error: "rate_limited", detail: `at most ${deps.previewsPerMinute ?? TRY_PREVIEWS_PER_MINUTE} previews per minute; nothing was charged`, charged: false }, 429);
    }
    const [[daily, census], q] = await Promise.all([
      files(),
      // Same reading as the unpaid /v1/buy: a plain GET, else the Bazaar-listed example input. No customer body exists here.
      quote({ method: "POST", path: BUY_PATH, url: u.href, contentType: "application/json", contentLength: "0", body: () => null }, cfg, deps),
    ]);
    const lookup = lookupVerdict(u, { daily, census });
    const latest = lookup?.latest;
    // Same allowlist as /try/run: a seller vet402 paid successfully last time (local TestNet targets exempt).
    const listed = (cfg.allowPrivateTargets && LOCAL_HOSTS.includes(u.hostname)) || recordedPayTo([census, daily]).has(u.toString());
    const trialCheck = !trial
      ? { available: false, reason: "trials_off" }
      : q.ok && q.priceRead === "get" && q.sellerAtomic <= trial.maxPerCallAtomic && listed
        ? { available: true, maxUsdc: atomicToUsdc(trial.maxPerCallAtomic) }
        : { available: false, reason: !q.ok ? q.body.reason : q.priceRead !== "get" ? "post_only" : q.sellerAtomic > trial.maxPerCallAtomic ? "price_over_trial_cap" : "not_listed", maxUsdc: atomicToUsdc(trial.maxPerCallAtomic) };
    return c.json(
      {
        url: u.href,
        charged: false,
        last: latest
          ? {
              match: lookup!.match,
              class: latest.class,
              countedAgainstSeller: latest.countedAgainstSeller,
              reason: latest.reason,
              ...(latest.detail ? { detail: latest.detail } : {}),
              date: latest.date,
              method: latest.method,
              url: latest.url,
              ...(latest.priceUsdc ? { priceUsdc: short(latest.priceUsdc) } : {}),
              paid: latest.paid,
              ...(latest.sellerTx ? { sellerTx: latest.sellerTx, sellerTxUrl: latest.sellerTxUrl } : {}),
              ...(latest.class === "UNCLEAR" ? { unclearNote: UNCLEAR_NOTE } : {}),
            }
          : null,
        buy: priceOut(q, cfg.network),
        trial: trialCheck,
        sellerPage: `${SELLER_PAGE_BASE}${sellerPath(latest?.host ?? u.host)}`,
      },
      200,
      { "cache-control": "no-store" },
    );
  });

  const hidden = new Set((trial?.hiddenHandles ?? []).map((h) => normalizeHandle(h)?.toLowerCase()).filter(Boolean));
  /** The public view: hidden handles dropped; operator tries marked and left out of people / trials (countedLog). */
  const logOf = async (): Promise<ShownLog | null> => {
    if (!trial) return null;
    const log = countedLog(await trial.store.log());
    return { ...log, entries: log.entries.map(({ handle, ...e }) => (handle && !hidden.has(handle.toLowerCase()) ? { ...e, handle } : e)) };
  };
  const handles = new QuoteLimiter(5, deps.now);

  // "First people to try vet402": the visitor may add an X handle to their own try, once, with the token /try/run gave them.
  app.post("/try/handle", async (c) => {
    if (!trial) return c.json({ error: "trials_off" }, 404);
    if (!handles.take(clientIp(c))) return c.json({ error: "rate_limited" }, 429);
    if ((c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase() !== "application/json") return c.json({ error: "unsupported_media_type" }, 415);
    const read = await readBodyCapped(c.req.raw.body, 1024);
    if (!read.ok) return c.json({ error: "request_too_large" }, 413);
    let input: { record?: unknown; token?: unknown; handle?: unknown };
    try {
      input = JSON.parse(Buffer.from(read.bytes).toString("utf8") || "{}") as typeof input;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const handle = normalizeHandle(input.handle);
    if (!handle) return c.json({ error: "invalid_handle", detail: "An X handle: letters, digits and _ only, up to 15." }, 400);
    const record = typeof input.record === "string" && /^[A-Z0-9]{1,52}$/.test(input.record) ? input.record : "";
    const token = typeof input.token === "string" ? input.token : "";
    const want = Buffer.from(handleToken(trial.hashKey, record));
    const got = Buffer.from(token);
    if (!record || got.length !== want.length || !timingSafeEqual(got, want)) return c.json({ error: "not_your_try", detail: "Only the person who ran this try can add a name to it." }, 403);
    try {
      const r = await trial.store.attachHandle(record, handle);
      if (r === "exists") return c.json({ error: "already_named", detail: "This try already has a name." }, 409);
    } catch (e) {
      return c.json({ error: "cannot_record", detail: String((e as Error).message ?? e).slice(0, 120) }, 503);
    }
    return c.json({ ok: true, handle }, 200);
  });

  // Real numbers only, per UTC day (last 14): free tries (trial records, by ?from= tag) and paying customers (/activity, operator excluded).
  // Page views are not counted: there is no free store on the deployment that outlives an instance.
  app.get("/try/stats.json", async (c) => {
    const now = deps.now?.() ?? Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const [log, act] = await Promise.all([logOf().catch(() => null), deps.activity ? deps.activity.get().catch(() => null) : Promise.resolve(null)]);
    const days = Array.from({ length: 14 }, (_, i) => new Date(now - i * 86_400_000).toISOString().slice(0, 10));
    const byDay = days.map((date) => {
      const tries = log ? log.entries.filter((e) => !e.operatorTest && e.at.slice(0, 10) === date) : null;
      const from: Record<string, number> = {};
      for (const e of tries ?? []) from[e.from ?? "direct"] = (from[e.from ?? "direct"] ?? 0) + 1;
      const paid = act ? new Set(act.rows.filter((r) => !r.operatorTest && r.time.slice(0, 10) === date).map((r) => r.customer)).size : null;
      return { date, tried: tries ? tries.length : null, from: tries ? from : null, paid };
    });
    const t = byDay[0];
    return c.json(
      { date: today, triedToday: t.tried, triedTotal: log ? log.people : null, paidToday: t.paid, byDay, note: "tried = free tries recorded on-chain; paid = distinct addresses that paid vet402 (x402) that day; page views are not counted" },
      200,
      { "cache-control": "public, max-age=60" },
    );
  });

  app.get("/try/log.json", async (c) => {
    if (!trial) return c.json({ error: "trials_off" }, 404);
    try {
      const log = (await logOf())!;
      return c.json({ wallet: trial.address, network: cfg.network, people: log.people, trials: log.trials, entries: log.entries }, 200, { "cache-control": "public, max-age=60" });
    } catch (e) {
      return c.json({ error: "indexer_unavailable", detail: String((e as Error).message ?? e).slice(0, 200) }, 503, { "cache-control": "no-store" });
    }
  });

  app.get("/try/log", async (c) => {
    if (!trial) return c.text("Free trials are not open on this deployment.", 404);
    let log: ShownLog | null = null;
    try {
      log = await logOf();
    } catch {
      log = null;
    }
    return c.html(tryLogHtml(log, trial.address, cfg.networkName), log ? 200 : 503, { "cache-control": log ? "public, max-age=60" : "no-store" });
  });

  app.post("/try/run", async (c) => {
    if (!trial || !trialCfg || !trialProbeDeps) return c.json({ error: "trials_off", detail: "Free trials are not open on this deployment." }, 404);
    const ip = clientIp(c);
    if (!runs.take(ip)) return c.json({ error: "rate_limited", detail: "Too many requests. Wait a minute." }, 429);
    const ct = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    // JSON only: a cross-site form cannot send it without a CORS preflight, which this route never answers.
    if (ct !== "application/json") return c.json({ error: "unsupported_media_type", detail: "send application/json" }, 415);
    const read = await readBodyCapped(c.req.raw.body, RUN_MAX_BODY);
    if (!read.ok) return c.json({ error: "request_too_large" }, 413);
    let input: { url?: unknown; address?: unknown; from?: unknown };
    try {
      input = JSON.parse(Buffer.from(read.bytes).toString("utf8") || "{}") as typeof input;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const target = typeof input.url === "string" ? input.url.trim() : "";
    const address = typeof input.address === "string" && input.address.trim() ? input.address.trim() : undefined;
    if (address !== undefined && !isAlgorandAddress(address)) return c.json({ error: "invalid_address", detail: "That is not an Algorand address." }, 400);
    const t = await checkTarget(target, cfg.allowPrivateTargets, deps.probeDeps.resolveHost);
    if (!t.ok) return c.json({ error: "invalid_target", detail: t.detail }, 400);
    const url = t.url.toString();

    // Only sellers vet402 paid successfully last time (the "free try" rows of the list), paid to the payTo it recorded then:
    // nobody can point the trial wallet at a new URL of their own. Local TestNet runs (private targets) are exempt.
    let listedPayTo: string | undefined;
    if (!(cfg.allowPrivateTargets && LOCAL_HOSTS.includes(t.url.hostname))) {
      const [daily, census] = await files();
      listedPayTo = recordedPayTo([census, daily]).get(url);
      if (!listedPayTo) return c.json({ error: "not_listed", detail: "The free try covers sellers vet402 paid successfully last time, with a plain GET: pick one marked \"free try\" in the list. Any other URL can be checked for free or bought with your own wallet.", used: false }, 422);
    }
    try {
      const today = new Date(deps.now?.() ?? Date.now()).toISOString().slice(0, 10);
      const log = await trial.store.log();
      if (log.entries.filter((e) => e.host === t.url.host && e.at.slice(0, 10) === today).length >= TRY_PER_SELLER_PER_DAY) {
        return c.json({ error: "seller_tried_enough", detail: `This seller has had ${TRY_PER_SELLER_PER_DAY} free tries today. Pick another one, or come back tomorrow (UTC).` }, 429);
      }
    } catch {
      return c.json({ error: "cannot_check", detail: "vet402 cannot read today's free tries, so it will not pay now. Try again shortly." }, 503);
    }

    const keys = claimKeys(trial.hashKey, personKey(ip), address);
    if (keys.some((k) => busy.has(k))) return c.json({ error: "already_running", detail: "Your free try is already running." }, 409);
    for (const k of keys) busy.add(k);
    try {
      let used: boolean;
      try {
        used = await trial.store.isClaimed(keys);
      } catch (e) {
        return c.json({ error: "cannot_check", detail: `vet402 cannot check whether you have tried before, so it will not pay now (${String((e as Error).message ?? e).slice(0, 120)}). Try again shortly.` }, 503);
      }
      if (used) return c.json({ error: "already_tried", detail: "You have used your free try. To buy again, pay with your own wallet through /v1/buy." }, 403);
      const h = await trial.guard.headroom();
      if (!h.ok) {
        return h.reason === "daily_cap_reached"
          ? c.json({ error: "daily_cap_reached", detail: "Today's free tries are used up. Come back tomorrow (UTC)." }, 503)
          : c.json({ error: "cannot_check", detail: "vet402 cannot read today's trial spending, so it will not pay now. Try again shortly." }, 503);
      }
      // Free look first (nothing signed, the try is not used): price, network, USDC, caps, not a vet402 wallet.
      const q = await quote({ method: "GET", path: BUY_PATH, url, body: () => null }, trialCfg, { probeDeps: trialProbeDeps, catalog: deps.catalog });
      if (!q.ok) return c.json({ error: "not_buyable", reason: q.body.reason, detail: q.body.detail, used: false }, 422);
      if (listedPayTo !== undefined && q.accept.payTo !== listedPayTo) {
        return c.json({ error: "not_buyable", reason: "payto_changed", detail: "This seller now asks to be paid to a different address than when vet402 bought from it, so the free try does not pay it.", used: false }, 422);
      }
      if (q.sellerAtomic > h.remainingAtomic) return c.json({ error: "daily_cap_reached", detail: "Today's free tries are used up. Come back tomorrow (UTC)." }, 503);
      try {
        await trial.store.claim(keys);
      } catch (e) {
        return c.json({ error: "cannot_record", detail: `vet402 could not record your try, so it did not pay (${String((e as Error).message ?? e).slice(0, 120)}).` }, 503);
      }

      // Every probe guard applies: private targets, own wallets, one payment, payTo lock, per-call and daily caps.
      const out = await probeWithBody(url, trialCfg, trial.guard, trialProbeDeps, { method: "GET", expect: q.accept });
      const r = out.result;
      const paid = !!r.downstreamPayment?.success;
      const cls = displayClass({ verdict: r.verdict, reason: r.reason, detail: r.detail, paid });
      const sellerTx = paid ? r.downstreamPayment?.transaction : undefined;
      let recordId: string | undefined;
      try {
        const from = normalizeFrom(input.from);
        recordId = await trial.store.record({ at: new Date().toISOString(), url, host: t.url.host, class: cls, reason: r.reason, priceUsdc: r.price ? short(r.price.usdc) : undefined, sellerTx, ...(from ? { from } : {}) });
      } catch {
        recordId = undefined;
      }
      const d = out.delivered;
      return c.json(
        {
          url,
          class: cls,
          verdict: r.verdict,
          reason: r.reason,
          ...(r.detail ? { detail: r.detail } : {}),
          price: r.price ? { usdc: short(r.price.usdc), payTo: r.price.payTo } : undefined,
          paidBy: trial.address,
          ...(sellerTx ? { sellerTx, sellerTxUrl: txLink(sellerTx, cfg.networkName) } : {}),
          // What the seller returned: text up to 2 KB (the page shows it with textContent), or type and size only.
          delivery: d ? { status: d.status, missingKeys: r.delivery?.missingKeys ?? [], ...contentPreview(d.bytes, d.contentType) } : undefined,
          because: because({ reason: r.reason, detail: r.detail, declared: r.declared, delivery: d ? { status: d.status, missingKeys: r.delivery?.missingKeys ?? [] } : undefined }),
          declared: r.declared ? { description: r.declared.description, mimeType: r.declared.mimeType, expectedKeys: r.declared.expectedKeys, exampleKeys: r.declared.exampleKeys ?? [] } : undefined,
          recorded: !!recordId,
          // Lets this visitor (and only them) add an X handle to this try: POST /try/handle.
          ...(recordId ? { record: { id: recordId, token: handleToken(trial.hashKey, recordId) } } : {}),
          note: "A free trial: vet402 paid with its trial wallet. It is not a customer payment.",
        },
        200,
        { "cache-control": "no-store" },
      );
    } finally {
      for (const k of keys) busy.delete(k);
    }
  });
}

const TRY_CSS = `
main{max-width:760px;margin:0 auto;padding:4px 16px 24px}
h1{font-size:clamp(24px,5vw,34px);line-height:1.2;margin:8px 0 10px}
.lead{color:#cbd5e1;font-size:17px;margin:0 0 6px}
.people{color:var(--mut);font-size:14px;margin:0 0 20px;min-height:1.4em}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:14px 0}
.card[hidden]{display:none}
.card h2{font-size:17px;margin:0 0 10px;display:flex;gap:10px;align-items:center}
.card .intro{margin:0 0 10px;color:var(--mut);font-size:14px}
.num{display:inline-grid;place-items:center;flex:none;width:26px;height:26px;border-radius:50%;background:rgba(96,165,250,.16);color:var(--acc);font-weight:700;font-size:13px}
label{display:block;font-size:14px;color:var(--mut);margin:0 0 6px}
input[type=search],input[type=text]{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card2);color:var(--fg);font-size:16px}
input:focus{outline:2px solid var(--acc);outline-offset:1px}
#list{list-style:none;margin:8px 0 0;padding:0;max-height:300px;overflow-y:auto;border:1px solid var(--line);border-radius:10px}
#list:empty{display:none}
#list li{padding:9px 12px;border-bottom:1px solid var(--line);cursor:pointer;display:flex;gap:8px;align-items:baseline;justify-content:space-between}
#list li:last-child{border-bottom:0}
#list li:hover,#list li:focus{background:#172033;outline:none}
#list .u{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
#list .m{flex:none;font-size:12px;color:var(--mut);white-space:nowrap}
#list li{flex-wrap:wrap}#list .w{flex-basis:100%;font-size:12px;color:var(--mut)}
.chip{font-size:11px;font-weight:700;letter-spacing:.03em;padding:1px 6px;border-radius:999px;border:1px solid currentColor;margin-right:6px}
.hint{font-size:13px;color:var(--mut);margin:8px 0 0}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
.out{margin-top:14px;font-size:16px}
.out:empty{display:none}
.out p{margin:0 0 8px}
.out .big{font-size:19px;font-weight:650}
.out .sub{color:var(--mut);font-size:14px}
.total{font-size:30px;font-weight:750;margin:6px 0 2px;font-variant-numeric:tabular-nums}
pre{white-space:pre-wrap;word-break:break-word;background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:10px;font-size:13px;max-height:320px;overflow:auto;margin:8px 0}
.roles{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-top:12px}
.roles a{display:block;background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:12px;text-decoration:none;color:var(--fg)}
.roles a b{display:block;font-size:13px;color:var(--mut);font-weight:600;margin-bottom:2px}
.next{font-size:15px;color:#cbd5e1}
h3.lbl{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin:14px 0 4px}
.err{color:var(--mismatch)}
.card2{background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:12px;margin-top:12px}
.card2 input{flex:1;min-width:0}
#firstList{margin:0;padding-left:18px;font-size:14px}
#firstList li{margin:3px 0}
`;

/** Client script: no interpolation inside (String.raw); all seller text goes through textContent. */
const TRY_JS = String.raw`
(function(){
  var cfg=JSON.parse(document.getElementById('cfg').textContent||'{}');
  function $(id){return document.getElementById(id)}
  var q=$('q'),list=$('list'),hint=$('hint'),bPrev=$('preview'),bRun=$('run'),outPrev=$('outPreview'),outRun=$('outRun'),addr=$('addr');
  var wCard=$('wallet'),wOut=$('wOut'),wQuote=$('wQuote'),wWho=$('wWho');
  var sellers=[],picked=null,walletMod=null;
  var from=(new URLSearchParams(location.search).get('from')||'');if(!/^[A-Za-z0-9-]{1,20}$/.test(from))from='';
  var CLS={DELIVERED:'delivered',MISMATCH:'mismatch',UNREACHABLE:'unreach',UNCLEAR:'unclear'};
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
  function link(href,text){var a=el('a',null,text);a.href=href;a.rel='noopener';return a}
  function p(parent,cls,parts){var e=el('p',cls);parts.forEach(function(x){e.appendChild(typeof x==='string'?document.createTextNode(x):x)});parent.appendChild(e);return e}
  function usd(s){return String(s).replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'')}
  function isUrl(s){return /^https?:\/\/\S+$/i.test(s)}
  function current(){var v=q.value.trim();return picked&&picked.u===v?picked:(isUrl(v)?{u:v,m:'GET',h:(v.split('/')[2]||'')}:null)}
  function render(items){
    list.textContent='';
    items.slice(0,40).forEach(function(s){
      var li=el('li');li.setAttribute('role','option');li.tabIndex=0;
      var u=el('span','u');u.appendChild(el('span','chip '+CLS[s.c],s.c));u.appendChild(document.createTextNode(s.u.replace(/^https?:\/\//,'')));
      li.appendChild(u);li.appendChild(el('span','m',(s.t&&cfg.trial?'free try · ':'')+(s.m!=='GET'?s.m+' · ':'')+(s.p?s.p+' USDC':'')));
      if(cfg.trial&&s.w)li.appendChild(el('span','w',s.w));
      li.addEventListener('click',function(){pick(s)});
      li.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();pick(s)}});
      list.appendChild(li);
    });
  }
  function filter(){
    var v=q.value.trim().toLowerCase();picked=null;
    if(isUrl(v)){list.textContent='';hint.textContent='Using the URL you pasted.';sync();return}
    var words=v.split(/\s+/).filter(Boolean);
    var hits=sellers.filter(function(s){var t=(s.u+' '+s.c).toLowerCase();return words.every(function(w){return t.indexOf(w)>=0})});
    render(hits);
    hint.textContent=sellers.length?(hits.length+' of '+sellers.length+' listings match. '+(cfg.trial?'The ones the free try can buy come first; the rest you can buy with your own wallet.':'Sellers that delivered come first, cheapest first.')):'Loading the list…';
    sync();
  }
  function pick(s){picked=s;q.value=s.u;list.textContent='';hint.textContent=s.h+' · last result '+s.c+(s.p?' · '+s.p+' USDC':'')+(cfg.trial&&s.w?' · '+s.w:'');outPrev.textContent='';outRun.textContent='';wReset();sync()}
  function sync(){var c=current();bPrev.disabled=!c;if(bRun)bRun.disabled=!c}
  q.addEventListener('input',function(){filter();wReset()});
  q.addEventListener('focus',function(){if(!q.value)filter()});
  fetch('/try/sellers.json').then(function(r){return r.json()}).then(function(j){sellers=j.sellers||[];filter()}).catch(function(){hint.textContent='The list could not be loaded. You can still paste a URL.'});
  fetch('/try/stats.json').then(function(r){return r.ok?r.json():null}).then(function(j){
    if(!j)return;var parts=[];
    if(j.triedToday!=null)parts.push(j.triedToday+(j.triedToday===1?' person':' people')+' tried vet402 free');
    if(j.paidToday!=null)parts.push(j.paidToday+' paid through vet402 with their own wallet');
    if(!parts.length)return;var e=$('people');e.textContent='Today (UTC): '+parts.join(' · ')+(cfg.trial?' · ':'');
    if(cfg.trial)e.appendChild(link('/try/log','every free try'));
  }).catch(function(){});

  function lastSentence(l){
    if(!l)return 'vet402 has no record for this URL yet.';
    var when='On '+l.date+', ';var price=l.priceUsdc?(l.priceUsdc+' USDC'):'the listed price';
    var how=l.match==='path'?' (same address, with the example input the seller published)':'';
    if(l.class==='DELIVERED')return when+'vet402 paid '+price+how+' and got what the listing promised.';
    if(l.class==='MISMATCH')return when+'vet402 paid '+price+how+', and what came back did not match the listing.';
    if(l.class==='UNREACHABLE')return when+'this URL did not ask for payment at all'+how+', so vet402 paid nothing.';
    return when+'vet402 could not get a clear answer'+how+'. This is not held against the seller.';
  }
  function priceSentence(b){
    if(b.ok)return 'Buying it through vet402 now costs '+usd(b.total.usdc)+' USDC: the seller\'s '+usd(b.sellerPrice.usdc)+' + vet402\'s fee '+usd(b.fee.usdc)+' (no fee on your first purchase).';
    return 'vet402 would not buy it right now: '+(b.detail||b.reason)+'.';
  }
  function buyButton(parent,label){
    if(!cfg.wallet)return;
    var r=el('div','row');var b=el('button','btn',label);b.addEventListener('click',openWallet);r.appendChild(b);parent.appendChild(r);
  }
  bPrev.addEventListener('click',function(){
    var c=current();if(!c)return;bPrev.disabled=true;outPrev.textContent='';p(outPrev,'sub',['Checking… (free)']);
    fetch('/try/preview?url='+encodeURIComponent(c.u)).then(function(r){return r.json().then(function(j){return {s:r.status,j:j}})}).then(function(x){
      outPrev.textContent='';var j=x.j;
      if(x.s!==200){p(outPrev,'err',[j.detail||j.error||('HTTP '+x.s)]);return}
      var l=j.last;var s=p(outPrev,'big',[lastSentence(l)]);if(l)s.classList.add(CLS[l.class]);
      if(l&&l.sellerTxUrl)p(outPrev,'sub',['Receipt: ',link(l.sellerTxUrl,'vet402 → seller payment '+l.sellerTx.slice(0,10)+'…')]);
      if(l&&l.class!=='DELIVERED'&&l.reason)p(outPrev,'sub',['Reason code: '+l.reason+(l.detail?' ('+l.detail+')':'')]);
      p(outPrev,null,[priceSentence(j.buy)]);
      p(outPrev,'sub',[link(j.sellerPage,'Everything vet402 recorded for this seller')]);
      if(bRun&&j.trial&&!j.trial.available){var why={post_only:'The free try buys with a plain GET; this seller needs a POST.',price_over_trial_cap:'The free try covers sellers up to '+usd(j.trial.maxUsdc)+' USDC.',not_listed:'The free try covers sellers vet402 paid successfully last time. You can buy this one with your own wallet.'}[j.trial.reason];if(why)p(outPrev,'sub',[why])}
      if(j.buy.ok)buyButton(outPrev,'Buy it through vet402 with your wallet');
    }).catch(function(e){outPrev.textContent='';p(outPrev,'err',['Could not check: '+e.message])}).then(function(){sync()});
  });

  if(bRun)bRun.addEventListener('click',function(){
    var c=current();if(!c)return;
    bRun.disabled=true;bPrev.disabled=true;outRun.textContent='';p(outRun,'sub',['vet402 is buying it now with its trial wallet. This takes about 10 seconds…']);
    var body={url:c.u};var a=addr&&addr.value.trim();if(a)body.address=a;if(from)body.from=from;
    fetch('/try/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {s:r.status,j:j}})}).then(function(x){
      outRun.textContent='';var j=x.j;
      if(x.s!==200){p(outRun,'err big',[j.detail||j.error||('HTTP '+x.s)]);if(j.error==='already_tried'||j.error==='daily_cap_reached')nextSteps(c);return}
      var price=j.price?usd(j.price.usdc)+' USDC':'the price';
      p(outRun,'big '+(CLS[j.class]||''),[{DELIVERED:'Delivered.',MISMATCH:'Paid, and it did not match the listing.',UNREACHABLE:'Nothing to buy here.',UNCLEAR:'No clear answer this time.'}[j.class]||j.class]);
      var d=j.declared||{};
      var promised=[];if(d.description)promised.push(d.description);
      if(d.expectedKeys&&d.expectedKeys.length)promised.push('Required fields: '+d.expectedKeys.join(', '));
      else if(d.exampleKeys&&d.exampleKeys.length)promised.push('Example fields: '+d.exampleKeys.join(', '));
      outRun.appendChild(el('h3','lbl','The listing promised'));
      p(outRun,null,[promised.length?promised.join(' · '):'Nothing specific (no description or output schema).']);
      outRun.appendChild(el('h3','lbl','What actually came back'+(j.price?' (vet402 paid '+price+')':'')));
      if(j.delivery){
        if(j.delivery.text!=null){var pre=el('pre');pre.textContent=j.delivery.text+(j.delivery.truncated?'\n…(truncated, '+j.delivery.bytes+' bytes)':'');outRun.appendChild(pre)}
        p(outRun,'sub',[(j.delivery.contentType||'no content-type')+' · '+j.delivery.bytes+' bytes · HTTP '+j.delivery.status]);
      }else p(outRun,null,['Nothing: the seller was not paid.']);
      outRun.appendChild(el('h3','lbl','So vet402 says'));
      p(outRun,null,[j.verdict+' because '+j.because+'.']);
      if(j.sellerTxUrl)p(outRun,'sub',['Receipt on the blockchain: ',link(j.sellerTxUrl,'vet402 → seller '+j.sellerTx.slice(0,10)+'…')]);
      nextSteps(c);
      if(j.record)nameForm(j.record);
    }).catch(function(e){outRun.textContent='';p(outRun,'err',['Something went wrong: '+e.message])}).then(function(){sync()});
  });
  function nextSteps(c){
    var box=el('div','roles');
    var b=el('a');b.href=cfg.wallet?'#wallet':'/#developers';b.appendChild(el('b',null,'Try another seller or your own input'));b.appendChild(document.createTextNode('Your first purchase with your own wallet has no vet402 fee →'));
    if(cfg.wallet)b.addEventListener('click',function(e){e.preventDefault();openWallet()});
    var d=el('a');d.href='https://github.com/kzmttkc/vet402-algorand/tree/main/mcp';d.rel='noopener';d.appendChild(el('b',null,'Add it to your agent in one line'));d.appendChild(document.createTextNode('The MCP server, or /v1/verdict for 0.001 USDC before each purchase →'));
    var s=el('a');s.href='/seller/'+encodeURIComponent(c.h||'');s.appendChild(el('b',null,'Sell an x402 API?'));s.appendChild(document.createTextNode('See your seller page and get a delivery certificate →'));
    box.appendChild(b);box.appendChild(d);box.appendChild(s);outRun.appendChild(box);
  }
  function nameForm(rec){
    var box=el('div','card2');box.appendChild(el('h3','lbl','First people to try vet402 on Algorand'));
    p(box,'sub',['Want your X handle on the list, next to this try? Optional.']);
    var r=el('div','row');var inp=el('input');inp.type='text';inp.placeholder='@yourhandle';inp.maxLength=16;inp.autocomplete='off';inp.setAttribute('aria-label','X handle');
    var b=el('button','btn ghost','Add me');r.appendChild(inp);r.appendChild(b);box.appendChild(r);
    var msg=p(box,'sub',['It is written in a public Algorand transaction note with this try and cannot be erased from the chain; if you ask in a GitHub issue, vet402 stops showing it here.']);
    b.addEventListener('click',function(){
      var h=inp.value.trim();if(!/^@?[A-Za-z0-9_]{1,15}$/.test(h)){msg.textContent='Letters, digits and _ only, up to 15.';return}
      b.disabled=true;
      fetch('/try/handle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({record:rec.id,token:rec.token,handle:h})}).then(function(r){return r.json().then(function(j){return {s:r.status,j:j}})}).then(function(x){
        msg.textContent=x.s===200?('Added '+x.j.handle+'. Thank you for trying vet402.'):(x.j.detail||x.j.error||('HTTP '+x.s));if(x.s!==200)b.disabled=false;else firstPeople();
      }).catch(function(e){msg.textContent='Not added: '+e.message;b.disabled=false});
    });
    outRun.appendChild(box);
  }
  function firstPeople(){
    var list=$('firstList');if(!list)return;
    fetch('/try/log.json').then(function(r){return r.ok?r.json():null}).then(function(j){
      if(!j)return;var named=j.entries.filter(function(e){return e.handle&&!e.operatorTest}).reverse().slice(0,30);
      list.textContent='';$('first').hidden=!named.length;
      named.forEach(function(e){var li=el('li');var a=link('https://x.com/'+e.handle.slice(1),e.handle);a.rel='noopener nofollow';li.appendChild(a);
        li.appendChild(document.createTextNode(' · '+e.at.slice(0,10)+' · '+e.host+' · '));li.appendChild(el('span',CLS[e.class],e.class));list.appendChild(li)});
    }).catch(function(){});
  }
  if(cfg.trial)firstPeople();

  /* ---- pay with your own wallet (loaded on demand) ---- */
  var quoted=null;
  function wReset(){quoted=null;if(wQuote)wQuote.textContent='';if(wOut)wOut.textContent=''}
  function loadWallet(){
    if(walletMod)return Promise.resolve(walletMod);
    return import(cfg.walletJs).then(function(){walletMod=window.vet402Wallet;if(!walletMod)throw new Error('wallet code did not load');return walletMod});
  }
  function openWallet(){
    if(!wCard)return;wCard.hidden=false;wCard.scrollIntoView({behavior:'smooth',block:'start'});
    loadWallet().then(function(){if(walletMod.address())priceFor(walletMod.address())}).catch(function(e){wCard.hidden=true});
  }
  function connect(kind){
    wOut.textContent='';p(wOut,'sub',['Opening '+(kind==='pera'?'Pera':'Lute')+'…']);
    loadWallet().then(function(w){return w.connect(kind,cfg.network)}).then(function(r){
      wOut.textContent='';wWho.textContent='Connected: '+r.name+' '+r.address.slice(0,6)+'…'+r.address.slice(-6);priceFor(r.address);
    }).catch(function(e){wOut.textContent='';p(wOut,'err',['Wallet not connected: '+(e&&e.message||e)])});
  }
  function priceFor(address){
    var c=current();wQuote.textContent='';wOut.textContent='';if(!c){p(wQuote,'sub',['Pick a seller first.']);return}
    p(wQuote,'sub',['Reading the price… (free)']);
    fetch('/v1/buy?url='+encodeURIComponent(c.u)+'&payer='+encodeURIComponent(address),{headers:{accept:'application/json'}}).then(function(r){return r.json().then(function(j){return {s:r.status,j:j}})}).then(function(x){
      wQuote.textContent='';var j=x.j;
      if(x.s!==402||!j.buy){p(wQuote,'err',['vet402 would not buy it: '+(j.detail||j.reason||j.error||('HTTP '+x.s))]);return}
      var b=j.buy;
      if(BigInt(b.sellerPrice.amountAtomic)>BigInt(walletMod.maxSellerAtomic)){p(wQuote,'sub',['This page buys sellers up to 0.10 USDC. This one asks '+usd(b.sellerPrice.usdc)+' USDC.']);return}
      quoted={target:c.u,total:b.total,fee:b.fee};
      p(wQuote,'sub',['You pay']);p(wQuote,'total',[usd(b.total.usdc)+' USDC']);
      p(wQuote,'sub',[b.firstPurchase?'The seller\'s price only: your first purchase through vet402 has no fee.':'The seller\'s '+usd(b.sellerPrice.usdc)+' + vet402\'s fee '+usd(b.fee.usdc)+'. No refunds.']);
      var r=el('div','row');var go=el('button','btn','Pay '+usd(b.total.usdc)+' USDC');go.addEventListener('click',pay);r.appendChild(go);wQuote.appendChild(r);
      p(wQuote,'sub',['Nothing is paid until you approve it in your wallet.']);
    }).catch(function(e){wQuote.textContent='';p(wQuote,'err',['Could not read the price: '+e.message])});
  }
  function pay(ev){
    if(!quoted||!walletMod)return;var btn=ev.target;btn.disabled=true;wOut.textContent='';
    var step=p(wOut,'sub',['Approve the payment in your wallet…']);
    walletMod.buy({target:quoted.target,network:cfg.network,expectedTotalAtomic:quoted.total.amountAtomic,feeAtomic:quoted.fee.amountAtomic,onStep:function(s){step.textContent={price:'Checking the price…',sign:'Approve the payment in your wallet…',send:'Paid. vet402 is buying it from the seller now…'}[s]||s}}).then(function(r){
      wOut.textContent='';
      if(r.status!==200){p(wOut,'err big',[(r.error&&(r.error.detail||r.error.error))||('HTTP '+r.status)]);if(r.customerTx)p(wOut,'sub',['Your payment: ',link(cfg.txBase+r.customerTx,r.customerTx.slice(0,10)+'…')]);return}
      var ok=r.verdict==='ALLOW';
      p(wOut,'big '+(ok?'delivered':'mismatch'),[ok?'Here is what the seller returned. vet402 checked it: it matches the listing.':'Here is what the seller returned. vet402 checked it: it does not match the listing ('+(r.reason||'')+').']);
      wOut.appendChild(el('pre',null,r.bodyText.slice(0,8000)+(r.bodyText.length>8000?'\n…':'')));
      p(wOut,'sub',[r.contentType+' · '+r.bytes+' bytes']);
      if(r.customerTx)p(wOut,null,['Your payment to vet402: ',link(cfg.txBase+r.customerTx,r.customerTx.slice(0,10)+'…')]);
      if(r.sellerTx)p(wOut,null,['vet402\'s payment to the seller: ',link(cfg.txBase+r.sellerTx,r.sellerTx.slice(0,10)+'…')]);
    }).catch(function(e){wOut.textContent='';p(wOut,'err',[(e&&e.name==='PriceChangedError')?'The price changed before you paid. Nothing was paid.':'Not paid: '+(e&&e.message||e)]);if(e&&e.name==='PriceChangedError'&&walletMod.address())priceFor(walletMod.address())});
  }
  if(wCard){$('wPera').addEventListener('click',function(){connect('pera')});$('wLute').addEventListener('click',function(){connect('lute')})}
})();
`;

export function tryHtml(o: { networkName: string; buyFeeUsdc: string; trial: { address: string; maxUsdc: string } | null; walletJs?: string }): string {
  const cfgJson = JSON.stringify({
    trial: !!o.trial,
    wallet: !!o.walletJs,
    walletJs: o.walletJs ?? "",
    fee: short(o.buyFeeUsdc),
    network: o.networkName,
    txBase: o.networkName === "mainnet" ? "https://allo.info/tx/" : "https://lora.algokit.io/testnet/transaction/",
  }).replace(/</g, "\\u003c");
  const net = o.networkName === "mainnet" ? "Algorand" : `Algorand ${esc(o.networkName)}`;
  const step2 = o.trial
    ? `<div class="card" id="trial"><h2><span class="num">2</span>Watch vet402 buy it — free, once per person</h2>
<p class="intro">vet402 pays the seller (up to ${esc(short(o.trial.maxUsdc))} USDC) from its own trial wallet on ${net}, checks what came back against the listing, and shows you the result and the receipt.</p>
<label for="addr">Your Algorand address (optional; it also counts as your one try)</label>
<input id="addr" type="text" autocomplete="off" spellcheck="false" placeholder="ABCD…">
<div class="row"><button class="btn" id="run" disabled>Try it free</button><button class="btn ghost" id="preview" disabled>Only show what vet402 got last time</button></div>
<div class="out" id="outRun" aria-live="polite"></div>
<div class="out" id="outPreview" aria-live="polite"></div></div>`
    : `<div class="card"><h2><span class="num">2</span>See what vet402 got last time</h2>
<div class="row"><button class="btn" id="preview" disabled>Check for free</button></div>
<div class="out" id="outPreview" aria-live="polite"></div></div>`;
  const wallet = o.walletJs
    ? `<div class="card" id="wallet" hidden><h2><span class="num">3</span>Get the content with your own wallet</h2>
<p class="intro">vet402 buys it from the seller for you, checks it, and hands you exactly what the seller returned, with both receipts. You pay the seller's price + ${esc(short(o.buyFeeUsdc))} USDC; your first purchase has no vet402 fee. No refunds.</p>
<div class="row"><button class="btn" id="wPera">Connect Pera</button><button class="btn ghost" id="wLute">Connect Lute</button></div>
<p class="hint" id="wWho"></p>
<div class="out" id="wQuote" aria-live="polite"></div>
<div class="out" id="wOut" aria-live="polite"></div></div>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Try vet402</title>
<meta name="description" content="Pick a paid API on Algorand, watch vet402 buy it once for free, and see what it delivered.">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<style>${BASE_CSS}${TRY_CSS}</style>
</head><body>
${topNav()}
<main>
<h1>${o.trial ? "Watch vet402 buy from a real seller. Free, once per person." : "See what a paid API delivered before you pay it."}</h1>
<p class="lead">${o.trial ? "No wallet and no USDC needed. vet402 pays with its own wallet, checks what came back against the listing, and shows you the receipt." : "Pick a seller and see, for free, what vet402 got when it paid it with its own wallet."}</p>
<p class="people" id="people"></p>
<div class="card"><h2><span class="num">1</span>Pick a seller</h2>
<label for="q">Search the sellers vet402 has paid, or paste the URL of a paid API</label>
<input id="q" type="search" autocomplete="off" spellcheck="false" placeholder="e.g. weather, news, https://…" aria-controls="list">
<ul id="list" role="listbox" aria-label="sellers"></ul>
<p class="hint" id="hint">Loading the list…</p>
</div>
${step2}
${wallet}
${o.trial ? `<div class="card" id="first" hidden><h2>First people to try vet402 on Algorand</h2><ol id="firstList"></ol><p class="hint">Listed only when they added their X handle themselves. To have yours removed, <a href="${BOARD_ISSUES_URL}" rel="noopener">open a GitHub issue</a>.</p></div>` : ""}
<p class="next">Building an agent? The same checks are paid HTTP endpoints: <a href="/#developers">/v1/check, /v1/buy, /v1/verdict, /v1/audit and an MCP server</a>.</p>
</main>
<footer>${o.trial ? `Trial wallet <code>${esc(o.trial.address.slice(0, 6))}…${esc(o.trial.address.slice(-6))}</code> · <a href="/try/log">every free try</a> · ` : ""}<a href="/board?view=census">Board</a> · <a href="/activity">Activity</a></footer>
<script type="application/json" id="cfg">${cfgJson}</script>
<script>${TRY_JS}</script>
</body></html>`;
}

/** /try/log as shown: operator tries are in `entries` (operatorTest) but not in `people` or `trials`. */
export type ShownLog = TrialLog & { trials: number };

export function tryLogHtml(log: ShownLog | null, wallet: string, networkName: string): string {
  const cls: Record<string, string> = { DELIVERED: "delivered", MISMATCH: "mismatch", UNREACHABLE: "unreach", UNCLEAR: "unclear" };
  const rows = (log?.entries ?? [])
    .map((e) => {
      const tx = e.sellerTx ? txLink(e.sellerTx, networkName) : undefined;
      return `<tr><td>${esc(e.at.replace("T", " ").replace("Z", ""))}</td><td><a href="${esc(sellerPath(e.host))}">${esc(e.host)}</a><br><small>${esc(e.url)}</small></td><td class="${cls[e.class] ?? ""}">${esc(e.class)}<br><small>${esc(e.reason)}</small>${e.operatorTest ? '<br><small class="op">operator test (not counted)</small>' : ""}</td><td>${esc(e.priceUsdc ?? "")}</td><td>${tx ? `<a href="${esc(tx)}" rel="noopener"><code>${esc(e.sellerTx!.slice(0, 10))}…</code></a>` : "—"}</td><td>${e.handle ? `<a href="https://x.com/${esc(e.handle.slice(1))}" rel="noopener nofollow">${esc(e.handle)}</a>` : ""}</td></tr>`;
    })
    .join("");
  const acct = networkName === "mainnet" ? `https://allo.info/account/${wallet}` : `https://lora.algokit.io/testnet/account/${wallet}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>vet402 free tries</title>
<link rel="icon" href="/favicon.ico" sizes="32x32">
<style>${BASE_CSS}
main{max-width:960px;margin:0 auto;padding:4px 16px 24px}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:12px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--mut);font-weight:600;white-space:nowrap}
small{color:var(--mut)}
</style></head><body>
${topNav()}
<main>
<h1>Free tries</h1>
${log ? `<p><b>${log.people}</b> ${log.people === 1 ? "person has" : "people have"} tried vet402 · <b>${log.trials}</b> ${log.trials === 1 ? "purchase" : "purchases"}${log.entries.length > log.trials ? ` (plus ${log.entries.length - log.trials} operator ${log.entries.length - log.trials === 1 ? "test" : "tests"}, not counted)` : ""}. vet402 paid for these from its trial wallet <a href="${esc(acct)}" rel="noopener"><code>${esc(wallet)}</code></a>. They are not customer payments and are not counted as customers on <a href="/activity">/activity</a>.</p>` : `<p>The Algorand indexer cannot be read right now. Try again shortly.</p>`}
<div class="tw"><table><thead><tr><th>time (UTC)</th><th>seller</th><th>result</th><th>USDC</th><th>vet402 → seller tx</th><th>name</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6"><small>No tries yet.</small></td></tr>'}</tbody></table></div>
<p><small>Read from the blockchain: each try is written as a note on a 0-ALGO transaction from the trial wallet to itself. No IP address or hash is shown here. A name appears only when that visitor added it; to have one removed, <a href="${BOARD_ISSUES_URL}" rel="noopener">open a GitHub issue</a>. <a href="/try/log.json">JSON</a> · <a href="/try">Try it</a></small></p>
</main></body></html>`;
}
