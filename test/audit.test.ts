/**
 * Seller audit (GET /v1/audit): the plan is free and shown before payment, the
 * seller's resources are bought only after the customer's payment settles, and
 * every cap of probe() still holds. A cap hit stops the audit: the rest is not
 * paid and is reported as SKIPPED.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALGORAND_TESTNET_CAIP2 } from "@x402/avm";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/server.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { SpendLedger } from "../src/caps.js";
import { LocalSpendGuard, type SpendGuard } from "../src/spend.js";
import type { ProbeDeps } from "../src/probe.js";
import type { BazaarItem, Catalog } from "../src/bazaar.js";
import { parseSeller, planAudit, runAudit } from "../src/audit.js";
import { readFileSync } from "node:fs";
import { VERCEL_MAX_DURATION_SEC } from "../src/config.js";

const NET = ALGORAND_TESTNET_CAIP2;
const ASA = "10458941";
const VET402 = "VETPAYTOVETPAYTOVETPAYTOVETPAYTOVETPAYTOVETPAYTOVETPAYTOVE"; // address-shaped (58 chars, base32)
const SELLER = "SELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELL";
const OTHER = "OTHERSELLEROTHERSELLEROTHERSELLEROTHERSELLEROTHERSELLEROTHE";
const HOST = "http://localhost:4031";

type Trace = string[];

function fakeFacilitator(trace: Trace): FacilitatorClient {
  const N = NET as `${string}:${string}`;
  return {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: N, extra: { feePayer: "FEEPAYER" } }], extensions: [], signers: {} };
    },
    async verify() {
      trace.push("verify");
      return { isValid: true, payer: "CUSTOMER" };
    },
    async settle() {
      trace.push("settle");
      return { success: true, transaction: "CUSTOMER_TX", network: N, payer: "CUSTOMER" };
    },
  };
}

const accept = (amount: string, payTo = SELLER) => ({ scheme: "exact", network: NET, asset: ASA, amount, payTo, maxTimeoutSeconds: 60, extra: {} });
const item = (path: string, amount: string, extra: Partial<BazaarItem> = {}): BazaarItem => ({
  resourceUrl: `${HOST}${path}`,
  method: "GET",
  accepts: [accept(amount, extra.accepts?.[0]?.payTo ?? SELLER)],
  ...extra,
});
const catalogOf = (items: BazaarItem[]): Catalog & { reads: number } => {
  const c = { reads: 0, async items() { c.reads++; return items; } };
  return c;
};

/** The TestNet test sellers: /honest delivers, /liar does not, /pricey is above the per-call cap. */
const SELLER_ITEMS = [item("/honest", "10000", { settleCount: 9 }), item("/liar", "10000", { settleCount: 5 }), item("/pricey", "500000", { settleCount: 1 })];

function sellerDeps(trace: Trace, prices: Record<string, string> = {}): ProbeDeps & { paid: string[]; seen: RequestInit[] } {
  const paid: string[] = [];
  const seen: RequestInit[] = [];
  const priceOf = (path: string) => prices[path] ?? (path === "/pricey" ? "500000" : "10000");
  const pr = (path: string) => ({
    x402Version: 2,
    resource: { url: `${HOST}${path}`, description: "Tokyo forecast", mimeType: "application/json" },
    accepts: [accept(priceOf(path))],
    extensions: { bazaar: { info: { output: { type: "json", example: { forecast: "sunny", temperature: 21 } } } } },
  });
  return {
    paid,
    seen,
    fetchImpl: async (url, init) => {
      if (!trace.includes("settle")) assert.fail(`seller looked at before the customer's payment settled (${url})`);
      seen.push(init);
      const path = new URL(url).pathname;
      trace.push(`look ${path}`);
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr(path))).toString("base64") } });
    },
    paidFetch: async (url, _approved, init) => {
      if (!trace.includes("settle")) assert.fail("seller paid before the customer's payment settled");
      seen.push(init);
      const path = new URL(url).pathname;
      trace.push(`pay ${path}`);
      paid.push(path);
      const body = path === "/liar" ? { message: "thanks for paying" } : { forecast: "sunny", temperature: 21 };
      return {
        response: new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
        settle: { success: true, transaction: `TX_${path.slice(1).toUpperCase()}`, network: NET },
        signed: true,
      };
    },
  };
}

const baseCfg = (env: NodeJS.ProcessEnv = {}): AppConfig => loadConfig({ ALLOW_PRIVATE_TARGETS: "1", ...env });
const guardFor = (cfg: AppConfig) => new LocalSpendGuard(new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic));

function appWith(o: { cfg?: AppConfig; items?: BazaarItem[]; trace?: Trace; deps?: ProbeDeps; guard?: SpendGuard; catalog?: Catalog }) {
  const cfg = o.cfg ?? baseCfg();
  const trace = o.trace ?? [];
  const deps = o.deps ?? sellerDeps(trace);
  const app = createApp(cfg, { payTo: VET402, probeDeps: deps, guard: o.guard ?? guardFor(cfg), facilitator: fakeFacilitator(trace), catalog: o.catalog ?? catalogOf(o.items ?? SELLER_ITEMS) });
  return { app, trace, cfg };
}

async function payFor(app: ReturnType<typeof createApp>, path: string) {
  const first = await app.request(path);
  if (first.status !== 402) return { first, paid: null as Response | null };
  const pr = JSON.parse(Buffer.from(first.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
  const payload = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { paymentGroup: [], paymentIndex: 0 } };
  const paid = await app.request(path, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") } });
  return { first, paid };
}

interface AuditBody {
  seller: string;
  customerPayment: { transaction: string };
  summary: Record<string, number | string>;
  results: { resourceUrl: string; verdict: string; reason: string; class: string; customerTx?: string; downstreamPayment?: { transaction?: string } }[];
  plan: { found: number; checking: number; paying: number; notChecked: { total: number; counts: Record<string, number> } };
}

test("parseSeller: host, URL, host:port and payTo address; junk is rejected", () => {
  assert.deepEqual(parseSeller("api.example.com"), { kind: "host", host: "api.example.com", raw: "api.example.com" });
  assert.equal((parseSeller("https://API.example.com/v1/x") as { host: string }).host, "api.example.com");
  assert.equal((parseSeller("localhost:4031") as { host: string }).host, "localhost:4031");
  assert.equal(parseSeller(SELLER)?.kind, "payTo");
  for (const bad of [undefined, "", "   ", "https://user:pw@x.example", "a b c"]) assert.equal(parseSeller(bad), null, String(bad));
});

test("402 of /v1/audit: same shape as /v1/check (exact, USDC ASA, challenge tag, Bazaar input/output) plus the free plan", async () => {
  const { app, trace } = appWith({});
  const res = await app.request(`/v1/audit?seller=${encodeURIComponent("localhost:4031")}`);
  assert.equal(res.status, 402);
  const pr = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
  assert.equal(pr.accepts[0].scheme, "exact");
  assert.equal(pr.accepts[0].asset, ASA);
  assert.equal(pr.accepts[0].amount, "500000");
  assert.equal(pr.accepts[0].extra.tag, "x402-global-challenge");
  assert.ok(pr.extensions?.bazaar?.info?.input, "Bazaar input declared");
  assert.ok(pr.extensions?.bazaar?.info?.output?.example, "Bazaar output declared");
  const body = (await res.json()) as { audit: { found: number; checking: number; paying: number; targets: { resourceUrl: string; willPay: boolean }[] } };
  assert.equal(body.audit.found, 3);
  assert.equal(body.audit.checking, 3);
  assert.equal(body.audit.paying, 2);
  assert.deepEqual(body.audit.targets.map((t) => [t.resourceUrl.replace(HOST, ""), t.willPay]), [["/honest", true], ["/liar", true], ["/pricey", false]]);
  assert.deepEqual(trace, [], "no facilitator call, no seller contact for the free plan");

  // /v1/check's 402 is unchanged: no audit plan in it.
  const chk = await app.request(`/v1/check?url=${encodeURIComponent(`${HOST}/honest`)}`);
  assert.equal(chk.status, 402);
  assert.equal(((await chk.json()) as { audit?: unknown }).audit, undefined);
});

test("seller with no listed resource: 404 before any 402, and a paid request is never settled", async () => {
  const trace: Trace = [];
  const { app } = appWith({ trace, items: [item("/x", "10000", { accepts: [accept("10000", OTHER)] })] });
  const unpaid = await app.request(`/v1/audit?seller=${SELLER}`);
  assert.equal(unpaid.status, 404);
  const b = (await unpaid.json()) as { error: string; detail: string };
  assert.equal(b.error, "seller_not_found");
  assert.match(b.detail, /Nothing was charged/);

  // A client that signs anyway (e.g. reused challenge) is verified but not settled.
  const { app: app2 } = appWith({ trace, items: SELLER_ITEMS });
  const pr = JSON.parse(Buffer.from((await app2.request(`/v1/audit?seller=${SELLER}`)).headers.get("PAYMENT-REQUIRED")!, "base64").toString());
  const { app: empty } = appWith({ trace, items: [] });
  const payload = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { paymentGroup: [], paymentIndex: 0 } };
  const paid = await empty.request(`/v1/audit?seller=${SELLER}`, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") } });
  assert.equal(paid.status, 404);
  assert.deepEqual(trace, ["verify"], "verified only: the customer is not charged");
});

test("invalid or own seller is refused for free", async () => {
  const { app } = appWith({});
  assert.equal((await app.request("/v1/audit")).status, 400);
  const own = await app.request(`/v1/audit?seller=${VET402}`);
  assert.equal(own.status, 400);
  assert.equal(((await own.json()) as { error: string }).error, "self_dealing");
  const ownHost = await app.request("/v1/audit?seller=vet402-algorand.vercel.app");
  assert.equal(ownHost.status, 400);
});

test("plan states before payment how many will be checked when the audit budget or target limit is exceeded", async () => {
  // 6 resources at 0.10 = 0.60 listed; budget 0.40 -> 4 paid, 2 over budget.
  const cfg = baseCfg({ PROBE_MAX_PER_CALL_USDC: "0.10", PROBE_MAX_PER_DAY_USDC: "5" });
  const items = Array.from({ length: 6 }, (_, i) => item(`/r${i}`, "100000", { settleCount: 10 - i }));
  const out = await planAudit("localhost:4031", items, { cfg, ownAddresses: [VET402] });
  assert.ok(out.ok);
  const p = out.plan;
  assert.equal(p.found, 6);
  assert.equal(p.checking, 4);
  assert.equal(p.paying, 4);
  assert.equal(p.plannedSpendUsdc, "0.400000");
  assert.deepEqual(p.notChecked.counts, { over_audit_budget: 2 });
  assert.deepEqual(p.targets.map((t) => t.resourceUrl.replace(HOST, "")), ["/r0", "/r1", "/r2", "/r3"]); // most-bought first
  assert.match(p.note, /check 4 of 6/);

  // Target limit 3: the 4th and later are listed as over_target_limit.
  const lim = await planAudit("localhost:4031", items, { cfg: baseCfg({ PROBE_MAX_PER_CALL_USDC: "0.10", PROBE_MAX_PER_DAY_USDC: "5", AUDIT_MAX_TARGETS: "3" }), ownAddresses: [VET402] });
  assert.ok(lim.ok);
  assert.equal(lim.plan.checking, 3);
  assert.deepEqual(lim.plan.notChecked.counts, { over_target_limit: 3 });

  // Daily headroom smaller than the budget trims the plan the same way, before payment.
  const tight = await planAudit("localhost:4031", items, { cfg, ownAddresses: [VET402], headroomAtomic: 150_000n });
  assert.ok(tight.ok);
  assert.equal(tight.plan.paying, 1);
  assert.equal(tight.plan.notChecked.counts.over_daily_headroom, 5);

  // Unsupported requests (PUT, path templates) are listed, never bought; if nothing is buyable: 422, free.
  const none = await planAudit("localhost:4031", [item("/u/{id}", "10000"), item("/put", "10000", { method: "PUT" })], { cfg, ownAddresses: [VET402] });
  assert.ok(!none.ok);
  assert.equal(none.status, 422);
  assert.deepEqual((none.body as { notChecked: { counts: unknown } }).notChecked.counts, { path_params: 1, method_not_probed: 1 });
});

test("one audit of the TestNet test seller: ALLOW, REFUSE delivery_missing_keys, REFUSE price_over_cap; settle before any seller contact", async () => {
  const trace: Trace = [];
  const deps = sellerDeps(trace);
  const { app } = appWith({ trace, deps });
  const { paid } = await payFor(app, `/v1/audit?seller=${SELLER}`);
  assert.equal(paid!.status, 200);
  const b = (await paid!.json()) as AuditBody;
  assert.deepEqual(trace.slice(0, 2), ["verify", "settle"]);
  assert.deepEqual(trace.slice(2), ["look /honest", "pay /honest", "look /liar", "pay /liar", "look /pricey"]);
  assert.deepEqual(
    b.results.map((r) => [r.resourceUrl.replace(HOST, ""), r.verdict, r.reason, r.class]),
    [
      ["/honest", "ALLOW", "delivered", "delivered"],
      ["/liar", "REFUSE", "delivery_missing_keys", "mismatch"],
      ["/pricey", "REFUSE", "price_over_cap", "unclear"],
    ],
  );
  assert.equal(b.customerPayment.transaction, "CUSTOMER_TX");
  for (const r of b.results) assert.equal(r.customerTx, "CUSTOMER_TX");
  assert.equal(b.results[0].downstreamPayment?.transaction, "TX_HONEST");
  assert.equal(b.results[2].downstreamPayment, undefined, "pricey never paid");
  assert.deepEqual(deps.paid, ["/honest", "/liar"]);
  assert.deepEqual(
    { ...b.summary },
    { checked: 3, delivered: 1, mismatch: 1, unreachable: 0, unclear: 1, skipped: 0, sellerPayments: 2, spentUsdc: "0.020000" },
  );
  assert.equal(b.plan.found, 3);
});

test("daily cap hit mid-audit: stops without paying the rest, rest reported as SKIPPED", async () => {
  // Daily cap 0.04, 0.03 already spent today: /honest (0.01) fits, /liar would exceed.
  const cfg = baseCfg({ PROBE_MAX_PER_CALL_USDC: "0.04", PROBE_MAX_PER_DAY_USDC: "0.04" });
  const ledger = new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic);
  ledger.reserve(30_000n);
  const trace: Trace = [];
  const deps = sellerDeps(trace);
  const items = [...SELLER_ITEMS.slice(0, 2), item("/honest2", "10000", { settleCount: 0 })];
  // The free plan does not read the daily cap (cheap); the paid request trims to headroom (0.01): only /honest is paid.
  const { app } = appWith({ cfg, trace, deps, items, guard: new LocalSpendGuard(ledger) });
  const { first, paid: paid0 } = await payFor(app, `/v1/audit?seller=${SELLER}`);
  assert.equal(((await first.json()) as { audit: { paying: number } }).audit.paying, 3);
  const b0 = (await paid0!.json()) as AuditBody;
  assert.deepEqual(deps.paid, ["/honest"]);
  assert.equal(b0.plan.paying, 1);
  assert.equal(b0.plan.notChecked.counts.over_daily_headroom, 2);

  // Someone else spends between plan and run: the probe-level cap stops the audit.
  const ledger2 = new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic);
  const trace2: Trace = [];
  const deps2 = sellerDeps(trace2);
  let reserves = 0;
  const racing: SpendGuard = {
    async reserve(a) {
      if (++reserves === 2) ledger2.reserve(cfg.maxPerDayAtomic - 10_000n - 5_000n); // another request fills the day
      return ledger2.reserve(a);
    },
    release: (id) => ledger2.release(id),
    commit: (id) => ledger2.commit(id),
    headroom: async () => ({ ok: true as const, remainingAtomic: cfg.maxPerDayAtomic - ledger2.spentTodayAtomic() }),
  };
  const { app: app2 } = appWith({ cfg, trace: trace2, deps: deps2, items, guard: racing });
  const { paid } = await payFor(app2, `/v1/audit?seller=${SELLER}`);
  const b = (await paid!.json()) as AuditBody;
  assert.deepEqual(deps2.paid, ["/honest"], "nothing paid after the cap");
  assert.deepEqual(
    b.results.map((r) => [r.resourceUrl.replace(HOST, ""), r.verdict, r.reason]),
    [
      ["/honest", "ALLOW", "delivered"],
      ["/liar", "SKIPPED", "daily_cap"],
      ["/honest2", "SKIPPED", "daily_cap"],
    ],
  );
  assert.equal(b.summary.skipped, 2);
  assert.equal(b.summary.stoppedBy, "daily_cap");
});

test("audit budget hit (live price above the listed one): stops without paying the rest, rest SKIPPED", async () => {
  // Listed 0.01 each, but /liar now asks 0.35: 0.01 + 0.35 fits 0.40, then /honest2 (0.10 live) does not.
  const cfg = baseCfg({ PROBE_MAX_PER_CALL_USDC: "0.40", PROBE_MAX_PER_DAY_USDC: "5" });
  const trace: Trace = [];
  const deps = sellerDeps(trace, { "/liar": "350000", "/honest2": "100000" });
  const items = [...SELLER_ITEMS.slice(0, 2), item("/honest2", "10000", { settleCount: 0 }), item("/honest3", "10000", { settleCount: 0 })];
  const { app } = appWith({ cfg, trace, deps, items });
  const { paid } = await payFor(app, `/v1/audit?seller=${SELLER}`);
  const b = (await paid!.json()) as AuditBody;
  assert.deepEqual(deps.paid, ["/honest", "/liar"]);
  assert.deepEqual(
    b.results.map((r) => [r.resourceUrl.replace(HOST, ""), r.verdict, r.reason]),
    [
      ["/honest", "ALLOW", "delivered"],
      ["/liar", "REFUSE", "delivery_missing_keys"],
      ["/honest2", "SKIPPED", "audit_budget"],
      ["/honest3", "SKIPPED", "audit_budget"],
    ],
  );
  assert.equal(b.summary.spentUsdc, "0.360000");
  assert.equal(b.summary.stoppedBy, "audit_budget");
});

test("private addresses and self-dealing stay refused inside an audit", async () => {
  const cfg = loadConfig({}); // private targets not allowed
  const items = [item("/honest", "10000"), { ...item("/x", "10000"), resourceUrl: "https://seller.example/x" }];
  const out = await planAudit(SELLER, items, { cfg, ownAddresses: [VET402], resolveHost: async () => ["10.0.0.5"] });
  assert.ok(!out.ok);
  assert.equal(out.status, 422);
  assert.equal((out.body as { notChecked: { counts: Record<string, number> } }).notChecked.counts.invalid_target, 2);

  // Seller whose resource pays into vet402: never planned.
  const self = await planAudit("localhost:4031", [item("/self", "10000", { accepts: [accept("10000", VET402)] })], { cfg: baseCfg(), ownAddresses: [VET402] });
  assert.ok(!self.ok);
  assert.equal((self.body as { notChecked: { counts: Record<string, number> } }).notChecked.counts.own_wallet, 1);

  // A seller that switches payTo to vet402 at pay time is refused by probe() (self_dealing), not paid.
  const trace: Trace = [];
  const deps = sellerDeps(trace);
  const look = deps.fetchImpl;
  deps.fetchImpl = async (url, init) => {
    const r = await look(url, init);
    const pr = JSON.parse(Buffer.from(r.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
    pr.accepts[0].payTo = VET402;
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  };
  const { app } = appWith({ trace, deps, items: SELLER_ITEMS.slice(0, 1) });
  const { paid } = await payFor(app, `/v1/audit?seller=${SELLER}`);
  const b = (await paid!.json()) as AuditBody;
  assert.equal(b.results[0].reason, "self_dealing");
  assert.deepEqual(deps.paid, []);
});

test("the seller's declared example input is sent (query and POST body)", async () => {
  const trace: Trace = [];
  const deps = sellerDeps(trace);
  const items = [
    item("/q", "10000", { settleCount: 2, discoveryInfo: { input: { method: "GET", queryParams: { city: "Tokyo" } } } }),
    item("/p", "10000", { settleCount: 1, method: "POST", discoveryInfo: { input: { method: "POST", bodyType: "json", body: { q: "x" } } } }),
  ];
  const { app } = appWith({ trace, deps, items });
  const { paid } = await payFor(app, `/v1/audit?seller=${SELLER}`);
  const b = (await paid!.json()) as AuditBody & { results: { url: string; input: string }[] };
  assert.equal(b.results[0].url, `${HOST}/q?city=Tokyo`);
  assert.equal(deps.seen[2].method, "POST");
  assert.equal(deps.seen[2].body, JSON.stringify({ q: "x" }));
});

test("catalog is read once per plan and a Bazaar outage is a free 503", async () => {
  const cat = catalogOf(SELLER_ITEMS);
  const { app } = appWith({ catalog: cat });
  await app.request(`/v1/audit?seller=${SELLER}`);
  assert.equal(cat.reads, 1);
  const down: Catalog = { items: async () => { throw new Error("bazaar 502"); } };
  const { app: a2, trace } = appWith({ catalog: down });
  const r = await a2.request(`/v1/audit?seller=${SELLER}`);
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { error: string }).error, "bazaar_unavailable");
  assert.deepEqual(trace, []);
});

test("config: audit budget must be below the audit price", () => {
  assert.throws(() => loadConfig({ AUDIT_PRICE_USDC: "0.30", AUDIT_MAX_SPEND_USDC: "0.30" }), /below AUDIT_PRICE_USDC/);
  const c = loadConfig({});
  assert.equal(c.auditPriceUsdc, "0.50");
  assert.equal(c.auditMaxSpendAtomic, 400_000n);
  assert.equal(c.auditMaxTargets, 10);
});

test("a target planned as 'read the price only' is never paid, even if its live price dropped under the cap", async () => {
  const trace: Trace = [];
  const deps = sellerDeps(trace, { "/pricey": "10000" }); // listed 0.50, live 0.01
  const { app } = appWith({ trace, deps });
  const { first, paid } = await payFor(app, `/v1/audit?seller=${SELLER}`);
  assert.equal(((await first.json()) as { audit: { paying: number } }).audit.paying, 2);
  const b = (await paid!.json()) as AuditBody;
  assert.deepEqual(deps.paid, ["/honest", "/liar"], "no more payments than the plan's paying");
  const pricey = b.results.find((r) => r.resourceUrl.endsWith("/pricey"))!;
  assert.deepEqual([pricey.verdict, pricey.reason], ["SKIPPED", "plan_changed"]);
  assert.equal(b.summary.sellerPayments, 2);
});

test("never more payments than the paying shown before payment (plan re-made after the cache expired)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-27T00:00:00Z") });
  const trace: Trace = [];
  const deps = sellerDeps(trace);
  let items = SELLER_ITEMS.slice(0, 1); // shown: /honest only
  const cat: Catalog = { items: async () => items };
  const { app } = appWith({ trace, deps, catalog: cat });
  const first = await app.request(`/v1/audit?seller=${SELLER}`);
  assert.equal(((await first.json()) as { audit: { paying: number } }).audit.paying, 1);
  const pr = JSON.parse(Buffer.from(first.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
  // The seller lists two more resources and the 5-minute plan cache expires before the buyer pays.
  items = [item("/honest0", "10000", { settleCount: 99 }), ...SELLER_ITEMS];
  t.mock.timers.tick(6 * 60_000);
  const payload = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { paymentGroup: [], paymentIndex: 0 } };
  const paid = await app.request(`/v1/audit?seller=${SELLER}`, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") } });
  const b = (await paid.json()) as AuditBody;
  assert.equal(deps.paid.length, 1, "paid once, as shown");
  assert.deepEqual(
    b.results.filter((r) => r.verdict === "SKIPPED").map((r) => r.reason),
    ["plan_changed", "plan_changed"],
  );
});

test("payTo lock: a live 402 asking a different payTo is refused before signing (payto_changed)", async () => {
  const trace: Trace = [];
  const deps = sellerDeps(trace);
  const look = deps.fetchImpl;
  deps.fetchImpl = async (url, init) => {
    const r = await look(url, init);
    if (!url.endsWith("/liar")) return r;
    const pr = JSON.parse(Buffer.from(r.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
    pr.accepts[0].payTo = OTHER; // not vet402's own, just not the seller that was named
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  };
  const guard = guardFor(baseCfg());
  const { app } = appWith({ trace, deps, guard });
  const { paid } = await payFor(app, `/v1/audit?seller=${SELLER}`);
  const b = (await paid!.json()) as AuditBody;
  const liar = b.results.find((r) => r.resourceUrl.endsWith("/liar"))!;
  assert.deepEqual([liar.verdict, liar.reason], ["REFUSE", "payto_changed"]);
  assert.deepEqual(deps.paid, ["/honest"], "OTHER is never paid");
  assert.equal(b.summary.sellerPayments, 1);
  // The refused reservation was given back: only /honest counts against the day.
  assert.deepEqual(await guard.headroom(), { ok: true, remainingAtomic: baseCfg().maxPerDayAtomic - 10_000n });
});

test("unpaid /v1/audit is cheap: no daily-cap read, plan and Bazaar cached across requests", async () => {
  const cat = catalogOf(SELLER_ITEMS);
  let headroomReads = 0;
  const cfg = baseCfg();
  const inner = guardFor(cfg);
  const counting: SpendGuard = { reserve: (a) => inner.reserve(a), release: (i) => inner.release(i), commit: (i) => inner.commit(i), headroom: () => (headroomReads++, inner.headroom()) };
  let dns = 0;
  const trace: Trace = [];
  const deps = { ...sellerDeps(trace), resolveHost: async () => (dns++, ["127.0.0.1"]) };
  const { app } = appWith({ cfg, catalog: cat, guard: counting, deps, trace });
  for (let i = 0; i < 5; i++) assert.equal((await app.request(`/v1/audit?seller=${SELLER}`)).status, 402);
  for (let i = 0; i < 3; i++) assert.equal((await app.request("/v1/audit?seller=nobody.example")).status, 404);
  assert.equal(headroomReads, 0);
  assert.equal(cat.reads, 2, "one plan per seller, cached");
  assert.deepEqual(trace, []);
});

test("exact paths only: /v1/check/, /V1/check, /v1/audit/ with a payment are refused before settlement", async () => {
  const trace: Trace = [];
  const { app } = appWith({ trace });
  const challenge = await app.request(`/v1/check?url=${encodeURIComponent(`${HOST}/honest`)}`);
  const pr = JSON.parse(Buffer.from(challenge.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
  const sig = Buffer.from(JSON.stringify({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { paymentGroup: [], paymentIndex: 0 } })).toString("base64");
  for (const path of [`/v1/check/?url=${encodeURIComponent(`${HOST}/honest`)}`, `/V1/check?url=${encodeURIComponent(`${HOST}/honest`)}`, `/v1/audit/?seller=${SELLER}`, `/v1//check?url=x`]) {
    const res = await app.request(path, { headers: { "PAYMENT-SIGNATURE": sig } });
    assert.ok([402, 404].includes(res.status), `${path} -> ${res.status}`);
    assert.ok(!trace.includes("settle"), `${path} settled the customer's payment (trace ${trace.join(",")})`);
  }
});

test("unpaid HEAD /v1/audit never reaches a seller", async () => {
  const trace: Trace = [];
  const deps = sellerDeps(trace);
  const { app } = appWith({ trace, deps });
  const res = await app.request(`/v1/audit?seller=${SELLER}`, { method: "HEAD" });
  assert.equal(res.status, 402);
  assert.deepEqual(deps.paid, []);
  assert.deepEqual(trace, []);
});

test("runAudit: maxPayments stops paying at the shown count; the deadline leaves room for one worst-case target", async () => {
  const cfg = baseCfg();
  const trace = ["settle"];
  const deps = sellerDeps(trace);
  const plan = await planAudit("localhost:4031", [...SELLER_ITEMS.slice(0, 2), item("/honest2", "10000")], { cfg, ownAddresses: [VET402] });
  assert.ok(plan.ok);
  const r = await runAudit(plan.plan, { cfg, guard: guardFor(cfg), probeDeps: deps, maxPayments: 1 });
  assert.deepEqual(r.results.map((x) => x.reason), ["delivered", "plan_changed", "plan_changed"]);
  let t = 0;
  const slow = await runAudit(plan.plan, { cfg, guard: guardFor(cfg), probeDeps: sellerDeps(trace), deadlineMs: 2 * cfg.probeTimeoutMs + 10_000 + 1, now: () => (t += 1) });
  assert.deepEqual(slow.results.map((x) => x.reason), ["delivered", "time_limit", "time_limit"]);
});

test("config: AUDIT_DEADLINE_MS must be a number at least 60 s under vercel.json maxDuration", () => {
  const vj = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(vj.functions["src/server.ts"].maxDuration, VERCEL_MAX_DURATION_SEC);
  assert.equal(loadConfig({}).auditDeadlineMs, (VERCEL_MAX_DURATION_SEC - 60) * 1000);
  for (const bad of ["abc", "", "1e5", "-1", "0", String((VERCEL_MAX_DURATION_SEC - 59) * 1000)]) {
    assert.throws(() => loadConfig({ AUDIT_DEADLINE_MS: bad }), /AUDIT_DEADLINE_MS/, bad);
  }
  assert.equal(loadConfig({ AUDIT_DEADLINE_MS: "120000" }).auditDeadlineMs, 120_000);
});
