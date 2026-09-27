/**
 * /try — the first step for someone who has never used x402. Free routes (mounted before the payment middlewares).
 *
 *   GET  /try               the page: pick a seller (or paste its URL), see what vet402 got last time, try it free
 *   GET  /try/preview?url=  free JSON: vet402's last recorded result for that URL (same data as /v1/verdict) and
 *                           today's price through /v1/buy (same reading as the unpaid /v1/buy 402). Never charges,
 *                           never pays anyone, never sends a customer body (quote() in buy.ts). 30 reads/min per IP.
 *   GET  /try/sellers.json  the sellers vet402 has bought from (board + census), DELIVERED first, cheapest first
 *   POST /try/run           "Try vet402 (free, once per person)": vet402 buys once with its trial wallet (trial.ts)
 *   GET  /try/log(.json)    public record of the trials: time, seller, result, tx (no IP, no hash)
 */
import type { Context, Hono } from "hono";
import { atomicToUsdc, type AppConfig } from "./config.js";
import {
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
import { claimKeys, isAlgorandAddress, type TrialLog, type TrialStore } from "./trial.js";
import type { SettleFirstEnv } from "./settle-first.js";

export const TRY_PREVIEWS_PER_MINUTE = 30;
export const TRY_RUNS_PER_MINUTE = 5;
const RUN_MAX_BODY = 4 * 1024;
const BODY_PREVIEW_CHARS = 1500;

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
}

export interface TryDeps {
  /** Main probe deps: fetchImpl, resolveHost, ownAddresses (every vet402 wallet, the trial wallet included). */
  probeDeps: ProbeDeps;
  catalog: Catalog;
  trial?: TrialDeps;
  boardFile?: string;
  load?: BoardLoader;
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
}

const CLASS_ORDER: Record<DisplayClass, number> = { DELIVERED: 0, MISMATCH: 1, UNCLEAR: 2, UNREACHABLE: 3 };

/** One option per method + URL (newest record wins), UNREACHABLE left out; DELIVERED first, then cheapest. */
export function sellerOptions(files: (BoardFile | null)[]): SellerOption[] {
  const m = new Map<string, SellerOption & { at: string }>();
  for (const f of files) {
    for (const r of f?.rows ?? []) {
      if (r.verdict === "SKIPPED" || !normalizeTargetUrl(r.url)) continue;
      const key = `${r.method} ${r.url}`;
      const prev = m.get(key);
      if (prev && prev.at >= r.at) continue;
      m.set(key, { u: r.url, m: r.method, h: hostOf(r), c: displayClass(r), p: r.priceUsdc ? short(r.priceUsdc) : "", at: r.at });
    }
  }
  const price = (p: string) => (p ? Number(p) : Number.POSITIVE_INFINITY);
  return [...m.values()]
    .filter((o) => o.c !== "UNREACHABLE")
    .sort((a, b) => CLASS_ORDER[a.c] - CLASS_ORDER[b.c] || price(a.p) - price(b.p) || a.h.localeCompare(b.h) || a.u.localeCompare(b.u))
    .map(({ at: _at, ...o }) => o);
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
      }),
      200,
      { "cache-control": "public, max-age=300" },
    ),
  );

  app.get("/try/sellers.json", async (c) => {
    const [daily, census] = await files();
    if (!optionsCache || optionsCache.daily !== daily || optionsCache.census !== census) optionsCache = { daily, census, list: sellerOptions([census, daily]) };
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
    const trialCheck = !trial
      ? { available: false, reason: "trials_off" }
      : q.ok && q.priceRead === "get" && q.sellerAtomic <= trial.maxPerCallAtomic
        ? { available: true, maxUsdc: atomicToUsdc(trial.maxPerCallAtomic) }
        : { available: false, reason: !q.ok ? q.body.reason : q.priceRead !== "get" ? "post_only" : "price_over_trial_cap", maxUsdc: atomicToUsdc(trial.maxPerCallAtomic) };
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

  const logOf = async (): Promise<TrialLog | null> => (trial ? trial.store.log() : null);

  app.get("/try/log.json", async (c) => {
    if (!trial) return c.json({ error: "trials_off" }, 404);
    try {
      const log = await trial.store.log();
      return c.json({ wallet: trial.address, network: cfg.network, people: log.people, trials: log.entries.length, entries: log.entries }, 200, { "cache-control": "public, max-age=60" });
    } catch (e) {
      return c.json({ error: "indexer_unavailable", detail: String((e as Error).message ?? e).slice(0, 200) }, 503, { "cache-control": "no-store" });
    }
  });

  app.get("/try/log", async (c) => {
    if (!trial) return c.text("Free trials are not open on this deployment.", 404);
    let log: TrialLog | null = null;
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
    let input: { url?: unknown; address?: unknown };
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

    const keys = claimKeys(trial.hashKey, ip, address);
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
      let recorded = true;
      try {
        await trial.store.record({ at: new Date().toISOString(), url, host: t.url.host, class: cls, reason: r.reason, priceUsdc: r.price ? short(r.price.usdc) : undefined, sellerTx });
      } catch {
        recorded = false;
      }
      const d = out.delivered;
      const textual = /json|text|xml|javascript|csv/i.test(d?.contentType ?? "");
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
          delivery: r.delivery ? { status: r.delivery.status, contentType: r.delivery.contentType, bytes: r.delivery.bytes, summary: r.delivery.summary, missingKeys: r.delivery.missingKeys } : undefined,
          ...(d && textual ? { bodyPreview: d.bytes.toString("utf8").slice(0, BODY_PREVIEW_CHARS) } : {}),
          declared: r.declared ? { description: r.declared.description } : undefined,
          recorded,
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
.card h2{font-size:17px;margin:0 0 10px;display:flex;gap:10px;align-items:center}
.num{display:inline-grid;place-items:center;flex:none;width:26px;height:26px;border-radius:50%;background:rgba(96,165,250,.16);color:var(--acc);font-weight:700;font-size:13px}
label{display:block;font-size:14px;color:var(--mut);margin:0 0 6px}
input[type=search],input[type=text]{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card2);color:var(--fg);font-size:16px}
input:focus{outline:2px solid var(--acc);outline-offset:1px}
#list{list-style:none;margin:8px 0 0;padding:0;max-height:300px;overflow-y:auto;border:1px solid var(--line);border-radius:10px}
#list:empty{display:none}
#list li{padding:9px 12px;border-bottom:1px solid var(--line);cursor:pointer;display:flex;gap:8px;align-items:baseline;justify-content:space-between}
#list li:last-child{border-bottom:0}
#list li[aria-selected=true],#list li:hover{background:#172033}
#list .u{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
#list .m{flex:none;font-size:12px;color:var(--mut);white-space:nowrap}
.chip{font-size:11px;font-weight:700;letter-spacing:.03em;padding:1px 6px;border-radius:999px;border:1px solid currentColor;margin-right:6px}
.hint{font-size:13px;color:var(--mut);margin:8px 0 0}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
.out{margin-top:14px;font-size:16px}
.out:empty{display:none}
.out p{margin:0 0 8px}
.out .big{font-size:19px;font-weight:650}
.out .sub{color:var(--mut);font-size:14px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:10px;font-size:13px;max-height:260px;overflow:auto;margin:8px 0}
details{margin-top:10px;font-size:14px;color:var(--mut)}
.next{font-size:15px;color:#cbd5e1}
.err{color:var(--mismatch)}
`;

/** Client script: no interpolation inside (String.raw), all seller text goes through textContent. */
const TRY_JS = String.raw`
(function(){
  var cfg=JSON.parse(document.getElementById('cfg').textContent||'{}');
  var q=document.getElementById('q'),list=document.getElementById('list'),hint=document.getElementById('hint');
  var bPrev=document.getElementById('preview'),bRun=document.getElementById('run');
  var outPrev=document.getElementById('outPreview'),outRun=document.getElementById('outRun');
  var addr=document.getElementById('addr');
  var sellers=[],picked=null;
  var CLS={DELIVERED:'delivered',MISMATCH:'mismatch',UNREACHABLE:'unreach',UNCLEAR:'unclear'};
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
  function link(href,text){var a=el('a',null,text);a.href=href;a.rel='noopener';return a}
  function p(parent,cls,parts){var e=el('p',cls);parts.forEach(function(x){e.appendChild(typeof x==='string'?document.createTextNode(x):x)});parent.appendChild(e);return e}
  function isUrl(s){return /^https?:\/\/\S+$/i.test(s)}
  function current(){var v=q.value.trim();return picked&&picked.u===v?picked:(isUrl(v)?{u:v,m:'GET'}:null)}
  function render(items){
    list.textContent='';
    items.slice(0,40).forEach(function(s){
      var li=el('li');li.setAttribute('role','option');li.tabIndex=-1;
      var u=el('span','u');var chip=el('span','chip '+CLS[s.c],s.c);u.appendChild(chip);u.appendChild(document.createTextNode(s.u.replace(/^https?:\/\//,'')));
      li.appendChild(u);li.appendChild(el('span','m',(s.m!=='GET'?s.m+' · ':'')+(s.p?s.p+' USDC':'')));
      li.addEventListener('click',function(){pick(s)});
      list.appendChild(li);
    });
  }
  function filter(){
    var v=q.value.trim().toLowerCase();picked=null;
    if(isUrl(v)){list.textContent='';hint.textContent='Using the URL you pasted.';sync();return}
    var words=v.split(/\s+/).filter(Boolean);
    var hits=sellers.filter(function(s){var t=(s.u+' '+s.c).toLowerCase();return words.every(function(w){return t.indexOf(w)>=0})});
    render(hits);
    hint.textContent=sellers.length?(hits.length+' of '+sellers.length+' listings match. Sellers that delivered come first, cheapest first.'):'Loading the list…';
    sync();
  }
  function pick(s){picked=s;q.value=s.u;list.textContent='';hint.textContent=s.h+' · last result '+s.c+(s.p?' · '+s.p+' USDC':'');sync();outPrev.textContent='';outRun.textContent=''}
  function sync(){var c=current();bPrev.disabled=!c;if(bRun)bRun.disabled=!c}
  q.addEventListener('input',filter);
  q.addEventListener('focus',function(){if(!q.value)filter()});
  fetch('/try/sellers.json').then(function(r){return r.json()}).then(function(j){sellers=j.sellers||[];filter()}).catch(function(){hint.textContent='The list could not be loaded. You can still paste a URL.'});
  if(cfg.trial){fetch('/try/log.json').then(function(r){return r.ok?r.json():null}).then(function(j){if(!j)return;var e=document.getElementById('people');e.textContent='';e.appendChild(document.createTextNode(j.people+(j.people===1?' person has':' people have')+' tried vet402 so far · '));e.appendChild(link('/try/log','see every try'))}).catch(function(){})}

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
    if(b.ok)return 'Buying through vet402 now costs '+b.total.usdc.replace(/0+$/,'').replace(/\.$/,'')+' USDC: the seller\'s '+b.sellerPrice.usdc.replace(/0+$/,'').replace(/\.$/,'')+' + vet402\'s fee '+b.fee.usdc.replace(/0+$/,'').replace(/\.$/,'')+'.';
    return 'vet402 would not buy it right now: '+(b.detail||b.reason)+'.';
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
      if(bRun&&j.trial&&!j.trial.available){var why={post_only:'The free try buys with a plain GET; this seller needs a POST.',price_over_trial_cap:'The free try covers sellers up to '+j.trial.maxUsdc+' USDC.'}[j.trial.reason];if(why)p(outPrev,'sub',[why])}
    }).catch(function(e){outPrev.textContent='';p(outPrev,'err',['Could not check: '+e.message])}).then(function(){sync()});
  });

  if(bRun)bRun.addEventListener('click',function(){
    var c=current();if(!c)return;
    bRun.disabled=true;bPrev.disabled=true;outRun.textContent='';p(outRun,'sub',['vet402 is buying it now with its trial wallet. This takes about 10 seconds…']);
    var body={url:c.u};var a=addr&&addr.value.trim();if(a)body.address=a;
    fetch('/try/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {s:r.status,j:j}})}).then(function(x){
      outRun.textContent='';var j=x.j;
      if(x.s!==200){p(outRun,'err big',[j.detail||j.error||('HTTP '+x.s)]);if(j.error==='already_tried'||j.error==='daily_cap_reached')nextLine();return}
      var price=j.price?j.price.usdc+' USDC':'the price';
      var head={DELIVERED:'vet402 paid '+price+' and got what the listing promised.',MISMATCH:'vet402 paid '+price+', and what came back did not match the listing.',UNREACHABLE:'This URL did not ask for payment, so vet402 paid nothing.',UNCLEAR:'vet402 could not get a clear answer this time. Nothing is held against the seller.'}[j.class]||j.class;
      p(outRun,'big '+(CLS[j.class]||''),[head]);
      if(j.declared&&j.declared.description)p(outRun,'sub',['The listing said: '+j.declared.description]);
      if(j.delivery)p(outRun,'sub',['What came back: '+j.delivery.summary+' ('+j.delivery.bytes+' bytes, '+(j.delivery.contentType||'no type')+')']);
      if(j.bodyPreview){outRun.appendChild(el('pre',null,j.bodyPreview))}
      if(j.sellerTxUrl)p(outRun,null,['Receipt on the blockchain: ',link(j.sellerTxUrl,'vet402 → seller '+j.sellerTx.slice(0,10)+'…')]);
      if(j.class!=='DELIVERED')p(outRun,'sub',['Reason code: '+j.reason+(j.detail?' ('+j.detail+')':'')]);
      nextLine();
    }).catch(function(e){outRun.textContent='';p(outRun,'err',['Something went wrong: '+e.message])}).then(function(){sync()});
  });
  function nextLine(){p(outRun,'next',['Want the content for yourself? Pay the seller\'s price + '+cfg.fee+' USDC with your own wallet through ',link('/#developers','/v1/buy'),' and vet402 checks it on the way.'])}
})();
`;

export function tryHtml(o: { networkName: string; buyFeeUsdc: string; trial: { address: string; maxUsdc: string } | null }): string {
  const cfgJson = JSON.stringify({ trial: !!o.trial, fee: short(o.buyFeeUsdc), network: o.networkName }).replace(/</g, "\\u003c");
  const net = o.networkName === "mainnet" ? "Algorand" : `Algorand ${esc(o.networkName)}`;
  const trialCard = o.trial
    ? `<div class="card" id="trial"><h2><span class="num">3</span>Watch vet402 buy it — free, once per person</h2>
<p class="sub" style="margin:0 0 10px;color:var(--mut);font-size:14px">vet402 pays the seller (up to ${esc(short(o.trial.maxUsdc))} USDC) from its own trial wallet on ${net}, then shows you what came back and the receipt.</p>
<label for="addr">Your Algorand address (optional; it also counts as your one try)</label>
<input id="addr" type="text" inputmode="latin" autocomplete="off" spellcheck="false" placeholder="ABCD…">
<div class="row"><button class="btn" id="run" disabled>Try it free</button></div>
<div class="out" id="outRun" aria-live="polite"></div></div>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Try vet402</title>
<meta name="description" content="Pick a paid API on Algorand, see what vet402 got when it bought it, and watch vet402 buy it once for free.">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<style>${BASE_CSS}${TRY_CSS}</style>
</head><body>
${topNav()}
<main>
<h1>${o.trial ? "Watch vet402 buy from a real seller. Free, once per person." : "See what a paid API delivered before you pay it."}</h1>
<p class="lead">${o.trial ? "No wallet and no USDC needed. vet402 pays with its own wallet, checks what came back against the listing, and shows you the receipt." : "Pick a seller and see, for free, what vet402 got when it paid it with its own wallet."}</p>
<p class="people" id="people"></p>
<div class="card"><h2><span class="num">1</span>Pick a seller</h2>
<label for="q">Search the sellers vet402 has bought from, or paste the URL of a paid API</label>
<input id="q" type="search" autocomplete="off" spellcheck="false" placeholder="e.g. weather, news, https://…" aria-controls="list">
<ul id="list" role="listbox" aria-label="sellers"></ul>
<p class="hint" id="hint">Loading the list…</p>
</div>
<div class="card"><h2><span class="num">2</span>See what vet402 got last time</h2>
<div class="row"><button class="btn${o.trial ? " ghost" : ""}" id="preview" disabled>Check for free</button></div>
<div class="out" id="outPreview" aria-live="polite"></div></div>
${trialCard}
<p class="next">Building an agent? The same checks are paid HTTP endpoints: <a href="/#developers">/v1/check, /v1/buy, /v1/verdict, /v1/audit and an MCP server</a>.</p>
</main>
<footer>${o.trial ? `Trial wallet <code>${esc(o.trial.address.slice(0, 6))}…${esc(o.trial.address.slice(-6))}</code> · <a href="/try/log">every free try</a> · ` : ""}<a href="/board?view=census">Board</a> · <a href="/activity">Activity</a></footer>
<script type="application/json" id="cfg">${cfgJson}</script>
<script>${TRY_JS}</script>
</body></html>`;
}

export function tryLogHtml(log: TrialLog | null, wallet: string, networkName: string): string {
  const cls: Record<string, string> = { DELIVERED: "delivered", MISMATCH: "mismatch", UNREACHABLE: "unreach", UNCLEAR: "unclear" };
  const rows = (log?.entries ?? [])
    .map((e) => {
      const tx = e.sellerTx ? txLink(e.sellerTx, networkName) : undefined;
      return `<tr><td>${esc(e.at.replace("T", " ").replace("Z", ""))}</td><td><a href="${esc(sellerPath(e.host))}">${esc(e.host)}</a><br><small>${esc(e.url)}</small></td><td class="${cls[e.class] ?? ""}">${esc(e.class)}<br><small>${esc(e.reason)}</small></td><td>${esc(e.priceUsdc ?? "")}</td><td>${tx ? `<a href="${esc(tx)}" rel="noopener"><code>${esc(e.sellerTx!.slice(0, 10))}…</code></a>` : "—"}</td></tr>`;
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
${log ? `<p><b>${log.people}</b> ${log.people === 1 ? "person has" : "people have"} tried vet402 · <b>${log.entries.length}</b> ${log.entries.length === 1 ? "purchase" : "purchases"}. vet402 paid for these from its trial wallet <a href="${esc(acct)}" rel="noopener"><code>${esc(wallet)}</code></a>. They are not customer payments and are not counted as customers on <a href="/activity">/activity</a>.</p>` : `<p>The Algorand indexer cannot be read right now. Try again shortly.</p>`}
<div class="tw"><table><thead><tr><th>time (UTC)</th><th>seller</th><th>result</th><th>USDC</th><th>vet402 → seller tx</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5"><small>No tries yet.</small></td></tr>'}</tbody></table></div>
<p><small>Read from the blockchain: each try is written as a note on a 0-ALGO transaction from the trial wallet to itself. No IP address or hash is shown here. <a href="/try/log.json">JSON</a> · <a href="/try">Try it</a></small></p>
</main></body></html>`;
}
