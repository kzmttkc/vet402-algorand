/**
 * vet402 on Algorand — paid check endpoint.
 *
 *   GET /v1/check?url=<x402 URL>   (0.05 USDC)
 *
 * Order (settle-first, see settle-first.ts):
 *   1. customer's payment is verified, then SETTLED on-chain
 *   2. only then vet402 pays the target seller (within caps)
 *   3. delivery is checked against the seller's declaration
 *   4. ALLOW / REFUSE with both tx ids and a delivery summary
 *
 *   GET /v1/audit?seller=<host or payTo>   (0.50 USDC): the same check for each of
 *   the seller's Bazaar-listed resources, planned for free before payment (audit.ts).
 *
 * Runs locally (`npm run server`) and on Vercel (zero-config Hono: this file's
 * default export). Layout follows algorandfoundation/x402-demo.
 */
import { pathToFileURL } from "node:url";
import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { x402HTTPResourceServer, x402ResourceServer } from "@x402/hono";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { HTTPFacilitatorClient, type HTTPRequestContext } from "@x402/core/server";
import type { ResourceServerExtension } from "@x402/core/types";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402-avm/extensions";
import { atomicToUsdc, loadConfig, usdcToAtomic, type AppConfig } from "./config.js";
import { loadKeys, loadPayer } from "./keys.js";
import { SpendLedger } from "./caps.js";
import { IndexedSpendGuard, usdcSentToday, type SpendGuard } from "./spend.js";
import { makePaidFetch, probe, type ProbeDeps } from "./probe.js";
import { checkTarget } from "./target.js";
import { settleFirstMiddleware, type SettleFirstEnv } from "./settle-first.js";
import { FAVICON_ICO_B64, demoHtml, landingHtml } from "./landing.js";
import { ActivityLedger, activityHtml, type ActivityReport } from "./activity.js";
import { registerBoard } from "./board.js";
import { registerSeller } from "./seller.js";
import { registerVerdictLookup } from "./lookup.js";
import { BazaarCatalog, UrlListCatalog, type Catalog } from "./bazaar.js";
import { applyHeadroom, parseSeller, planAudit, runAudit, type AuditPlan, type PlanOutcome, type SellerRef } from "./audit.js";

type FacilitatorLike = ConstructorParameters<typeof x402ResourceServer>[0];

export const CHECK_OUTPUT_EXAMPLE = {
  verdict: "ALLOW",
  reason: "delivered",
  target: "https://seller.example/v1/data",
  customerPayment: { transaction: "TXID_CUSTOMER...", network: "algorand:...", amount: "50000", payTo: "VET402..." },
  declared: { description: "Weather data", mimeType: "application/json", expectedKeys: ["weather", "temperature"] },
  price: { amountAtomic: "5000", usdc: "0.005000", payTo: "SELLER...", network: "algorand:...", asset: "31566704" },
  downstreamPayment: { success: true, transaction: "TXID_SELLER...", network: "algorand:..." },
  delivery: { status: 200, contentType: "application/json", bytes: 64, summary: "object{weather:string=\"sunny\", temperature:number=70}", missingKeys: [] },
};

export const AUDIT_OUTPUT_EXAMPLE = {
  seller: "seller.example",
  network: "algorand:...",
  customerPayment: { transaction: "TXID_CUSTOMER...", network: "algorand:...", amount: "500000", payTo: "VET402..." },
  summary: { checked: 3, delivered: 1, mismatch: 1, unreachable: 0, unclear: 1, skipped: 0, sellerPayments: 2, spentUsdc: "0.020000" },
  results: [
    {
      resourceUrl: "https://seller.example/v1/data",
      verdict: "ALLOW",
      reason: "delivered",
      class: "delivered",
      customerTx: "TXID_CUSTOMER...",
      downstreamPayment: { success: true, transaction: "TXID_SELLER..." },
    },
  ],
  plan: { found: 3, checking: 3, paying: 2, plannedSpendUsdc: "0.020000", auditBudgetUsdc: "0.400000", notChecked: { total: 0, counts: {}, items: [] } },
};

export interface AppDeps {
  payTo: string;
  probeDeps: ProbeDeps;
  guard: SpendGuard;
  /** Injected in tests; default is the HTTP facilitator at cfg.facilitatorUrl. */
  facilitator?: FacilitatorLike;
  /** Public activity ledger (GET /activity, /activity.json). Omitted = routes not mounted. */
  activity?: { get(): Promise<ActivityReport> };
  /** Where /v1/audit reads a seller's resources. Default: the Bazaar feed at cfg.bazaarUrl (cached). */
  catalog?: Catalog;
}

/**
 * Vercel function settings (read statically by Vercel from this entry file; a
 * `functions` entry in vercel.json is not matched for zero-config Hono).
 * An audit buys up to 10 resources in one request.
 */
export const config = { maxDuration: 300 };
export const VERCEL_MAX_DURATION_SEC = config.maxDuration;
/** An audit must end at least this long before the function limit (settlement, Bazaar read, response). */
export const AUDIT_DEADLINE_MARGIN_SEC = 60;

export function createApp(cfg: AppConfig, deps: AppDeps) {
  const deadlineMax = (VERCEL_MAX_DURATION_SEC - AUDIT_DEADLINE_MARGIN_SEC) * 1000;
  if (cfg.auditDeadlineMs > deadlineMax) {
    throw new Error(`AUDIT_DEADLINE_MS must be at most ${deadlineMax} (${AUDIT_DEADLINE_MARGIN_SEC} s under the ${VERCEL_MAX_DURATION_SEC} s function limit), got ${cfg.auditDeadlineMs}`);
  }
  const facilitator = deps.facilitator ?? new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator).register(cfg.network as `${string}:${string}`, new ExactAvmScheme());
  resourceServer.registerExtension(bazaarResourceServerExtension as unknown as ResourceServerExtension);

  const discovery = declareDiscoveryExtension({
    input: { url: "https://seller.example/v1/data" },
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "x402 endpoint for vet402 to pay and check" } },
      required: ["url"],
    },
    output: {
      example: CHECK_OUTPUT_EXAMPLE,
      schema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["ALLOW", "REFUSE"] },
          reason: { type: "string" },
          target: { type: "string" },
          customerPayment: { type: "object" },
          downstreamPayment: { type: "object" },
          delivery: { type: "object" },
        },
        required: ["verdict", "reason", "target", "customerPayment"],
      },
    },
  });

  const auditPriceAtomic = usdcToAtomic(cfg.auditPriceUsdc).toString();
  /** `paying` of the cached plan for the request's seller; 0 when there is no plan (then no payment can match). */
  const auditPayingFor = async (ctx: HTTPRequestContext): Promise<number> => {
    const seller = ctx.adapter.getQueryParam?.("seller");
    const s = Array.isArray(seller) ? seller[0] : seller;
    const ref = parseSeller(s);
    if (!ref || !s) return 0;
    try {
      const out = await cachedPlan(sellerKey(ref), s);
      return out.ok ? out.plan.paying : 0;
    } catch {
      return 0;
    }
  };

  const auditDiscovery = declareDiscoveryExtension({
    input: { seller: "seller.example" },
    inputSchema: {
      type: "object",
      properties: { seller: { type: "string", description: "the seller to audit: its host (api.example.com) or its Algorand payTo address" } },
      required: ["seller"],
    },
    output: {
      example: AUDIT_OUTPUT_EXAMPLE,
      schema: {
        type: "object",
        properties: {
          seller: { type: "string" },
          customerPayment: { type: "object" },
          summary: { type: "object" },
          results: { type: "array" },
          plan: { type: "object" },
        },
        required: ["seller", "customerPayment", "summary", "results"],
      },
    },
  });

  const httpServer = new x402HTTPResourceServer(resourceServer, {
    "GET /v1/check": {
      accepts: [
        {
          scheme: "exact",
          price: `$${cfg.checkPriceUsdc}`,
          network: cfg.network as `${string}:${string}`,
          payTo: deps.payTo,
          extra: { asset: cfg.usdcAsaId, tag: cfg.challengeTag },
        },
      ],
      description:
        "Check an x402 seller before your first payment to it: vet402 pays it once with its own wallet and tells you if the delivery matched the listing (GET endpoints).",
      mimeType: "application/json",
      extensions: discovery,
    },
    "GET /v1/audit": {
      accepts: [
        {
          scheme: "exact",
          // AssetAmount with the planned count: see "The number of resources to be paid" below.
          price: async (ctx: HTTPRequestContext) => ({ amount: auditPriceAtomic, asset: cfg.usdcAsaId, extra: { auditPaying: await auditPayingFor(ctx) } }),
          network: cfg.network as `${string}:${string}`,
          payTo: deps.payTo,
          extra: { asset: cfg.usdcAsaId, tag: cfg.challengeTag },
        },
      ],
      description:
        `Seller audit: vet402 buys each of your Bazaar-listed resources from its own wallet (up to ${cfg.auditMaxTargets}, at most ${atomicToUsdc(cfg.auditMaxSpendAtomic)} USDC in total), only after your payment has settled, and returns a verdict per resource with both payment tx ids. The unpaid request is free and shows which resources will be checked.`,
      mimeType: "application/json",
      extensions: auditDiscovery,
    },
  });

  const ownAddresses = [...new Set([deps.payTo, ...(deps.probeDeps.ownAddresses ?? [])])];
  const probeDeps: ProbeDeps = { ...deps.probeDeps, ownAddresses };

  const catalog = deps.catalog ?? new BazaarCatalog(cfg.bazaarUrl);
  /**
   * Audit plans. The unpaid request is cheap: plans (and negative answers) are cached
   * for PLAN_TTL_MS per seller, the Bazaar feed for 5 minutes, and today's daily-cap
   * headroom is read only for a paid request. The paid request takes the same cached
   * plan when it is still there (else it plans again) and trims it to the headroom.
   *
   * The number of resources to be paid is part of the price itself: the 402's
   * accepts[0].extra.auditPaying = N (see `auditPrice`). x402 only accepts a payment
   * whose `accepted` equals the requirements computed for the paid request, so a
   * payment signed for N is refused (402, not settled) on any instance whose plan now
   * says something else, and an accepted payment carries its N: vet402 then pays for
   * at most min(N, the paid-time plan trimmed to the daily headroom). Nothing of this
   * depends on memory shared between instances.
   */
  const PLAN_TTL_MS = 5 * 60_000;
  const MAX_CACHED_SELLERS = 500;
  const planCache = new Map<string, { at: number; outcome: Promise<PlanOutcome> }>();
  const remember = <V extends { at: number }>(m: Map<string, V>, k: string, v: V) => {
    m.delete(k);
    m.set(k, v);
    if (m.size > MAX_CACHED_SELLERS) m.delete(m.keys().next().value!);
  };
  const sellerKey = (ref: SellerRef) => (ref.kind === "host" ? `host:${ref.host}` : `payTo:${ref.address}`);
  const cachedPlan = (key: string, seller: string): Promise<PlanOutcome> => {
    const hit = planCache.get(key);
    if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.outcome;
    const outcome = catalog.items().then((items) => planAudit(seller, items, { cfg, ownAddresses, resolveHost: deps.probeDeps.resolveHost }));
    remember(planCache, key, { at: Date.now(), outcome });
    outcome.catch(() => {
      if (planCache.get(key)?.outcome === outcome) planCache.delete(key); // a Bazaar outage is not cached
    });
    return outcome;
  };
  const invalidSeller = (c: Context<SettleFirstEnv>) =>
    c.json({ error: "invalid_seller", detail: "seller must be a host (api.example.com) or an Algorand payTo address" }, 400);
  const bazaarDown = (c: Context<SettleFirstEnv>, seller: string, e: unknown) =>
    c.json({ error: "bazaar_unavailable", seller, detail: String((e as Error).message ?? e).slice(0, 200) }, 503);
  /** The paid request's plan and the most it may pay for (kept per request object). */
  const auditRuns = new WeakMap<Request, { plan: AuditPlan; maxPayments: number }>();

  const app = new Hono<SettleFirstEnv>();

  app.get("/favicon.ico", (c) =>
    c.body(Buffer.from(FAVICON_ICO_B64, "base64"), 200, { "content-type": "image/x-icon", "cache-control": "public, max-age=86400" }),
  );

  app.get("/demo", (c) => c.html(demoHtml()));

  app.get("/", (c) => {
    const caps = { perCallUsdc: atomicToUsdc(cfg.maxPerCallAtomic), perDayUsdc: atomicToUsdc(cfg.maxPerDayAtomic) };
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("application/json") && !accept.includes("text/html")) {
      return c.json({
        service: "vet402 (Algorand)",
        network: cfg.network,
        endpoints: {
          "GET /v1/check?url=<x402 URL>": `${cfg.checkPriceUsdc} USDC`,
          "GET /v1/audit?seller=<host or payTo>": `${cfg.auditPriceUsdc} USDC (the unpaid request shows the plan for free)`,
        },
        order: "customer payment settles first; the seller is paid only after that",
        caps,
      });
    }
    return c.html(landingHtml({ network: cfg.network, priceUsdc: String(cfg.checkPriceUsdc), ...caps }));
  });

  // Public, free, read-only: mounted before the payment middleware so it is never charged.
  if (deps.activity) {
    const activity = deps.activity;
    const cacheControl = "public, max-age=60, s-maxage=60";
    const unavailable = (e: unknown) => ({ error: "indexer_unavailable", detail: String((e as Error).message ?? e).slice(0, 200) });
    app.get("/activity.json", async (c) => {
      try {
        return c.json(await activity.get(), 200, { "cache-control": cacheControl });
      } catch (e) {
        return c.json(unavailable(e), 503, { "cache-control": "no-store" });
      }
    });
    app.get("/activity", async (c) => {
      try {
        return c.html(activityHtml(await activity.get()), 200, { "cache-control": cacheControl });
      } catch (e) {
        return c.text(`vet402 activity: the Algorand indexer cannot be read right now (${unavailable(e).detail}). Try again shortly.`, 503, { "cache-control": "no-store" });
      }
    });
  }
  registerBoard(app); // free: GET /board, /board.json (before the payment middleware)
  registerSeller(app, cfg); // free: GET /seller/:host, /badge/:host.svg (before the payment middleware)
  registerVerdictLookup(app, cfg, resourceServer, deps.payTo); // paid, own settle-first: GET /v1/verdict (pays no seller)

  app.use(
    settleFirstMiddleware(httpServer, {
      // Free checks: a request we cannot serve is refused before the customer is charged.
      beforeChallenge: async (c) => {
        if (c.req.path !== "/v1/audit") return null;
        const seller = c.req.query("seller") ?? "";
        const ref = parseSeller(seller);
        if (!ref) return { stop: invalidSeller(c) };
        let out: PlanOutcome;
        try {
          out = await cachedPlan(sellerKey(ref), seller);
        } catch (e) {
          return { stop: bazaarDown(c, seller, e) };
        }
        if (!out.ok) return { stop: c.json(out.body, out.status) };
        return { info: { audit: out.plan } };
      },
      preflight: async (c) => {
        // Only the exact paid paths reach a handler; anything else (/v1/check/, /V1/check, ...) is refused before settlement.
        if (c.req.path !== "/v1/check" && c.req.path !== "/v1/audit") return c.json({ error: "not_found", path: c.req.path }, 404);
        if (c.req.path === "/v1/audit") {
          const seller = c.req.query("seller") ?? "";
          const ref = parseSeller(seller);
          if (!ref) return invalidSeller(c);
          const h = await deps.guard.headroom();
          if (!h.ok) return c.json({ error: h.reason, seller, detail: h.detail }, 503);
          let out: PlanOutcome;
          try {
            out = await cachedPlan(sellerKey(ref), seller);
          } catch (e) {
            return bazaarDown(c, seller, e);
          }
          if (!out.ok) return c.json(out.body, out.status);
          const plan = applyHeadroom(out.plan, h.remainingAtomic);
          if (plan.paying === 0) return c.json({ error: "daily_cap_reached", seller, detail: "today's remaining cap cannot pay for any planned resource. Nothing was charged.", audit: plan }, 503);
          // N the buyer accepted (verified: it equals the requirements computed for this request).
          const shown = Number(c.get("paidRequirements")?.extra?.auditPaying);
          if (!Number.isSafeInteger(shown) || shown < 1) return c.json({ error: "plan_changed", seller, detail: "the payment does not name how many resources it pays for. Nothing was charged." }, 409);
          auditRuns.set(c.req.raw, { plan, maxPayments: Math.min(shown, plan.paying) });
          return null;
        }
        const target = c.req.query("url");
        if (!target) return c.json({ error: "missing url query parameter" }, 400);
        const t = await checkTarget(target, cfg.allowPrivateTargets, deps.probeDeps.resolveHost);
        if (!t.ok) return c.json({ verdict: "REFUSE", reason: "invalid_target", target, detail: t.detail }, 400);
        const h = await deps.guard.headroom();
        if (!h.ok) return c.json({ verdict: "REFUSE", reason: h.reason, target, detail: h.detail }, 503);
        return null;
      },
    }),
  );

  app.get("/v1/check", async (c) => {
    const customerPayment = c.get("customerPayment");
    // Defence in depth: never pay a seller unless this request's own payment has settled.
    if (!customerPayment) return c.json({ error: "payment_required" }, 402);
    const target = c.req.query("url") ?? "";
    try {
      const result = await probe(target, cfg, deps.guard, probeDeps);
      return c.json({ ...result, customerPayment }, 200);
    } catch (e) {
      // The customer has paid: always answer with a verdict.
      return c.json({ verdict: "REFUSE", reason: "probe_error", target, customerPayment, detail: String((e as Error).message ?? e).slice(0, 200) }, 200);
    }
  });

  app.get("/v1/audit", async (c) => {
    const customerPayment = c.get("customerPayment");
    // Defence in depth: never pay a seller unless this request's own payment has settled.
    if (!customerPayment) return c.json({ error: "payment_required" }, 402);
    const planned = auditRuns.get(c.req.raw);
    if (!planned) return c.json({ error: "audit_plan_missing", customerPayment }, 500);
    const { plan, maxPayments } = planned;
    const { found, checking, paying, plannedSpendUsdc, auditBudgetUsdc, maxTargets, notChecked, note } = plan;
    const planOut = { found, checking, paying, plannedSpendUsdc, auditBudgetUsdc, maxTargets, notChecked, note };
    try {
      const run = await runAudit(plan, { cfg, guard: deps.guard, probeDeps, customerTx: customerPayment.transaction, maxPayments, deadlineMs: cfg.auditDeadlineMs });
      return c.json({ seller: plan.seller, network: cfg.network, customerPayment, summary: run.summary, results: run.results, plan: planOut }, 200);
    } catch (e) {
      // The customer has paid: always answer.
      return c.json({ seller: plan.seller, network: cfg.network, customerPayment, error: "audit_error", detail: String((e as Error).message ?? e).slice(0, 200), plan: planOut }, 200);
    }
  });

  return app;
}

/** Production wiring from env: chain-backed daily cap, real paying fetch. */
export function createAppFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const cfg = loadConfig(env);
  const payer = loadPayer(cfg.networkName, cfg.keysFile, env);
  const payTo = cfg.payTo ?? loadKeys(cfg.keysFile).vet402.address;
  const ledger = new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic, cfg.spendLedgerFile);
  const guard = new IndexedSpendGuard(ledger, () =>
    usdcSentToday({ indexerUrl: cfg.indexerUrl, address: payer.address, asaId: cfg.usdcAsaId }),
  );
  const probeDeps: ProbeDeps = {
    fetchImpl: (url, init) => fetch(url, init),
    paidFetch: makePaidFetch(cfg, payer.secretKeyB64),
    ownAddresses: [payTo, payer.address],
  };
  // Public addresses only: the activity page never needs the payer's secret.
  const activity = new ActivityLedger({
    networkName: cfg.networkName,
    indexerUrl: cfg.indexerUrl,
    asaId: cfg.usdcAsaId,
    payTo,
    payer: env.VET402_PAYER_ADDRESS?.trim() || payer.address,
    priceAtomic: usdcToAtomic(cfg.checkPriceUsdc),
    auditPriceAtomic: usdcToAtomic(cfg.auditPriceUsdc),
    auditMaxTargets: cfg.auditMaxTargets,
  });
  // Local TestNet only: the test sellers on localhost are not in the Bazaar, so list them by URL.
  const catalogUrls = (env.AUDIT_CATALOG_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (catalogUrls.length && !cfg.allowPrivateTargets) throw new Error("AUDIT_CATALOG_URLS is for the local TestNet run only (needs ALLOW_PRIVATE_TARGETS=1)");
  const catalog = catalogUrls.length ? new UrlListCatalog(catalogUrls) : undefined;
  return { cfg, payTo, payer: payer.address, app: createApp(cfg, { payTo, probeDeps, guard, activity, catalog }) };
}

// Vercel entry (zero-config Hono): build lazily so importing this module has no side effects.
let built: ReturnType<typeof createAppFromEnv>["app"] | null = null;
const entry = new Hono();
entry.all("*", (c) => {
  built ??= createAppFromEnv().app;
  return built.fetch(c.req.raw);
});
export default entry;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { cfg, payTo, payer, app } = createAppFromEnv();
  serve({ fetch: app.fetch, port: cfg.port }, () => {
    console.log(`vet402 (Algorand ${cfg.networkName}) on http://localhost:${cfg.port}  payTo=${payTo}  payer=${payer}`);
  });
}
