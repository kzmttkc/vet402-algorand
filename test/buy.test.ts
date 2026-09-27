/**
 * GET|POST /v1/buy: the price is the seller's price + vet402's fee, computed from a free read
 * of the seller's 402; everything vet402 would not buy is refused before the customer is
 * charged; a price change or a tampered payment never settles; the customer's payment settles
 * before the seller is paid; and the seller's body comes back byte for byte.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2 } from "@x402/avm";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/server.js";
import { loadConfig, usdcToAtomic, type AppConfig } from "../src/config.js";
import { SpendLedger } from "../src/caps.js";
import { LocalSpendGuard, type SpendGuard } from "../src/spend.js";
import type { ProbeDeps } from "../src/probe.js";
import { buyPriceAtomic, BUY_MAX_REQUEST_BYTES, readBodyCapped } from "../src/buy.js";
import { ActivityLedger } from "../src/activity.js";
import type { BazaarItem, Catalog } from "../src/bazaar.js";
import { VERDICT_PRICE_USDC } from "../src/lookup.js";

const NET = ALGORAND_TESTNET_CAIP2;
const ASA = "10458941";
const VET402 = "VETPAYTOVETPAYTOVETPAYTOVETPAYTOVETPAYTOVETPAYTOVETPAYTOVE";
const PAYER = "VETPAYERVETPAYERVETPAYERVETPAYERVETPAYERVETPAYERVETPAYERVE";
const SELLER = "SELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELL";
const HOST = "http://localhost:4031";

type Trace = string[];

function fakeFacilitator(trace: Trace, settleOk = true): FacilitatorClient {
  const N = NET as `${string}:${string}`;
  return {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: N, extra: { feePayer: "FEEPAYER" } }], extensions: [], signers: {} };
    },
    async verify(_p, req) {
      trace.push(`verify ${req.amount}`);
      return { isValid: true, payer: "CUSTOMER" };
    },
    async settle(_p, req) {
      trace.push(`settle ${req.amount}`);
      return settleOk
        ? { success: true, transaction: "CUSTOMER_TX", network: N, payer: "CUSTOMER" }
        : { success: false, errorReason: "insufficient_funds", transaction: "", network: N };
    },
  };
}

interface SellerState {
  /** Seller's 402 accept, changed by tests between reads. */
  accept: { scheme: string; network: string; asset: string; amount: string; payTo: string; maxTimeoutSeconds: number; extra: Record<string, unknown> };
  status402?: number;
  /** Paid body per path. */
  body: (path: string) => { bytes: Uint8Array; contentType: string };
  paySucceeds: boolean;
  /** Called on every unpaid read, before the 402 is built. */
  onLook?: () => void;
  /** POST-only seller: a GET is answered 405. */
  postOnly?: boolean;
  /** Paid response status (default 200). */
  paidStatus?: number;
  /** The seller's payment waits for this. */
  payGate?: Promise<void>;
}

const LIAR_BODY = '{"message":"thanks for paying"}';
// Byte-exact: odd spacing, key order and a trailing newline must survive.
const HONEST_BODY = '{ "forecast":"sunny",  "temperature":21, "city":"Tokyo" }\n';

function sellerDeps(trace: Trace, s: SellerState): ProbeDeps & { paid: { url: string; approved: unknown; init: RequestInit }[]; looks: RequestInit[] } {
  const paid: { url: string; approved: unknown; init: RequestInit }[] = [];
  const looks: RequestInit[] = [];
  const pr = (path: string) => ({
    x402Version: 2,
    resource: { url: `${HOST}${path}`, description: "Tokyo forecast", mimeType: "application/json" },
    accepts: [s.accept],
    extensions: {
      bazaar: {
        info: { output: { type: "json", example: { forecast: "sunny", temperature: 21 } } },
        schema: { properties: { output: { properties: { example: { type: "object", required: ["forecast", "temperature"] } } } } },
      },
    },
  });
  return {
    paid,
    looks,
    ownAddresses: [VET402, PAYER],
    fetchImpl: async (url, init) => {
      looks.push(init);
      trace.push(`look ${new URL(url).pathname}`);
      s.onLook?.();
      if (s.postOnly && init.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (s.status402 && s.status402 !== 402) return new Response("ok", { status: s.status402 });
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr(new URL(url).pathname))).toString("base64") } });
    },
    paidFetch: async (url, approved, init) => {
      if (!trace.some((t) => t.startsWith("settle"))) assert.fail("seller paid before the customer's payment settled");
      const path = new URL(url).pathname;
      trace.push(`pay ${path}`);
      paid.push({ url, approved, init });
      await s.payGate;
      if (!s.paySucceeds) {
        return { response: new Response("{}", { status: 402 }), settle: { success: false, errorReason: "insufficient_funds" }, signed: true };
      }
      const b = s.body(path);
      const status = s.paidStatus ?? 200;
      const nullBody = status === 204 || status === 205 || status === 304;
      return {
        response: new Response(nullBody ? null : (b.bytes as Uint8Array<ArrayBuffer>), { status, headers: nullBody ? {} : { "content-type": b.contentType } }),
        settle: { success: true, transaction: "SELLER_TX", network: NET },
        signed: true,
      };
    },
  };
}

const sellerState = (amount = "10000", payTo = SELLER): SellerState => ({
  accept: { scheme: "exact", network: NET, asset: ASA, amount, payTo, maxTimeoutSeconds: 60, extra: {} },
  body: (path) => ({ bytes: Buffer.from(path === "/liar" ? LIAR_BODY : HONEST_BODY), contentType: "application/json" }),
  paySucceeds: true,
});

const baseCfg = (env: NodeJS.ProcessEnv = {}): AppConfig => loadConfig({ ALLOW_PRIVATE_TARGETS: "1", ...env });
const guardFor = (cfg: AppConfig) => new LocalSpendGuard(new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic));

const catalogOf = (items: BazaarItem[]): Catalog & { reads: number } => {
  const c = { reads: 0, async items() { c.reads++; return items; } };
  return c;
};

function setup(o: { cfg?: AppConfig; state?: SellerState; guard?: SpendGuard; settleOk?: boolean; catalog?: Catalog; facilitator?: FacilitatorClient } = {}) {
  const cfg = o.cfg ?? baseCfg();
  const trace: Trace = [];
  const state = o.state ?? sellerState();
  const deps = sellerDeps(trace, state);
  const catalog = o.catalog ?? catalogOf([]);
  const app = createApp(cfg, { payTo: VET402, probeDeps: deps, guard: o.guard ?? guardFor(cfg), facilitator: o.facilitator ?? fakeFacilitator(trace, o.settleOk ?? true), catalog });
  return { app, trace, state, deps, cfg, catalog };
}

const buyPath = (target: string) => `/v1/buy?url=${encodeURIComponent(target)}`;
const decodePR = (res: Response) => JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
const sig = (accepted: unknown, resource: unknown) =>
  Buffer.from(JSON.stringify({ x402Version: 2, resource, accepted, payload: { paymentGroup: [], paymentIndex: 0 } })).toString("base64");

/** Read the free 402, then pay what it asks (optionally tampered) on `paidPath`. */
async function buy(app: ReturnType<typeof createApp>, path: string, o: { init?: RequestInit; tamper?: (a: Record<string, unknown>) => void; paidPath?: string; between?: () => void } = {}) {
  const first = await app.request(path, o.init);
  if (first.status !== 402) return { first, paid: null as Response | null, accepted: null };
  const pr = decodePR(first);
  const accepted = structuredClone(pr.accepts[0]);
  o.tamper?.(accepted);
  o.between?.();
  const headers = { ...((o.init?.headers as Record<string, string>) ?? {}), "PAYMENT-SIGNATURE": sig(accepted, pr.resource) };
  const paid = await app.request(o.paidPath ?? path, { ...o.init, headers });
  return { first, paid, accepted: pr.accepts[0] };
}

const settled = (trace: Trace) => trace.some((t) => t.startsWith("settle"));

test("dynamic price: 402 amount = seller price + fee (integer atomic), the seller's price and payTo are in extra", async () => {
  assert.equal(buyPriceAtomic(10_000n, 5_000n), 15_000n);
  for (const [seller, total] of [["10000", "15000"], ["37000", "42000"], ["1", "5001"]]) {
    const { app, trace } = setup({ state: sellerState(seller) });
    const res = await app.request(buyPath(`${HOST}/honest`));
    assert.equal(res.status, 402);
    const a = decodePR(res).accepts[0];
    assert.equal(a.amount, total);
    assert.match(a.amount, /^\d+$/);
    assert.equal(a.payTo, VET402);
    assert.equal(a.asset, ASA);
    assert.deepEqual([a.extra.sellerAmount, a.extra.sellerPayTo, a.extra.buyFee], [seller, SELLER, "5000"]);
    const body = (await res.json()) as { buy: { total: { amountAtomic: string }; fee: { usdc: string }; refund: string } };
    assert.equal(body.buy.total.amountAtomic, total);
    assert.equal(body.buy.fee.usdc, "0.005000");
    assert.equal(body.buy.refund, "none");
    assert.ok(!settled(trace) && !trace.some((t) => t.startsWith("verify")));
  }
  // BUY_FEE_USDC is configurable.
  const { app } = setup({ cfg: baseCfg({ BUY_FEE_USDC: "0.02" }) });
  assert.equal(decodePR(await app.request(buyPath(`${HOST}/honest`))).accepts[0].amount, "30000");
});

test("pre-check refusals are free: over the per-call cap, vet402's own payTo, a private address, another network, not USDC", async () => {
  const cases: { name: string; state?: SellerState; cfg?: AppConfig; status: number; reason: string }[] = [
    { name: "over cap", state: sellerState("500000"), status: 422, reason: "price_over_cap" },
    { name: "self (payTo)", state: sellerState("10000", VET402), status: 422, reason: "self_dealing" },
    { name: "self (payer)", state: sellerState("10000", PAYER), status: 422, reason: "self_dealing" },
    { name: "private address", cfg: loadConfig({}), status: 400, reason: "invalid_target" },
    { name: "other network", state: { ...sellerState(), accept: { ...sellerState().accept, network: ALGORAND_MAINNET_CAIP2 } }, status: 422, reason: "no_supported_accept" },
    { name: "not USDC", state: { ...sellerState(), accept: { ...sellerState().accept, asset: "31566704" } }, status: 422, reason: "no_supported_accept" },
    { name: "not x402", state: { ...sellerState(), status402: 200 }, status: 422, reason: "not_x402" },
  ];
  for (const k of cases) {
    const { app, trace, deps } = setup({ state: k.state, cfg: k.cfg });
    const res = await app.request(buyPath(`${HOST}/honest`));
    assert.equal(res.status, k.status, k.name);
    const body = (await res.json()) as { reason: string; charged: boolean };
    assert.equal(body.reason, k.reason, k.name);
    assert.equal(body.charged, false, k.name);
    assert.equal(res.headers.get("PAYMENT-REQUIRED"), null, `${k.name}: nothing to sign`);
    assert.equal(deps.paid.length, 0, k.name);
    assert.ok(!settled(trace), k.name);
  }
});

test("a refusal that appears only at payment time (seller raised the price above the cap) is not settled", async () => {
  const { app, trace, deps, state } = setup();
  const { paid } = await buy(app, buyPath(`${HOST}/honest`), { between: () => (state.accept = { ...state.accept, amount: "500000" }) });
  assert.equal(paid!.status, 402);
  assert.ok(!settled(trace), trace.join(","));
  assert.equal(deps.paid.length, 0);
});

test("the seller's price changed between the free 402 and the payment: not settled, seller not paid", async () => {
  const { app, trace, deps, state } = setup();
  const { paid } = await buy(app, buyPath(`${HOST}/honest`), { between: () => (state.accept = { ...state.accept, amount: "12000" }) });
  assert.equal(paid!.status, 402);
  assert.ok(!settled(trace) && !trace.some((t) => t.startsWith("verify")), trace.join(","));
  assert.equal(deps.paid.length, 0);
  // The 402 names the new price: 12000 + 5000.
  assert.equal(decodePR(paid!).accepts[0].amount, "17000");
});

test("the seller's payTo changed between the free 402 and the payment: not settled", async () => {
  const { app, trace, deps, state } = setup();
  const OTHER = "OTHERSELLEROTHERSELLEROTHERSELLEROTHERSELLEROTHERSELLEROTHE";
  const { paid } = await buy(app, buyPath(`${HOST}/honest`), { between: () => (state.accept = { ...state.accept, payTo: OTHER }) });
  assert.equal(paid!.status, 402);
  assert.ok(!settled(trace));
  assert.equal(deps.paid.length, 0);
});

test("a tampered payment (amount, seller amount, seller payTo) is not accepted: never verified or settled", async () => {
  const tampers: [string, (a: Record<string, unknown>) => void][] = [
    ["amount lowered", (a) => (a.amount = "5001")],
    ["amount = seller price only", (a) => (a.amount = "10000")],
    ["sellerAmount", (a) => ((a.extra as Record<string, unknown>).sellerAmount = "1")],
    ["sellerPayTo", (a) => ((a.extra as Record<string, unknown>).sellerPayTo = VET402)],
    ["payTo", (a) => (a.payTo = SELLER)],
  ];
  for (const [name, tamper] of tampers) {
    const { app, trace, deps } = setup();
    const { paid } = await buy(app, buyPath(`${HOST}/honest`), { tamper });
    assert.equal(paid!.status, 402, name);
    assert.ok(!settled(trace) && !trace.some((t) => t.startsWith("verify")), `${name}: ${trace.join(",")}`);
    assert.equal(deps.paid.length, 0, name);
  }
});

test("order: free read -> verify -> settle (customer, seller price + fee) -> pay seller (seller price, locked payTo)", async () => {
  const { app, trace, deps } = setup();
  const { paid } = await buy(app, buyPath(`${HOST}/honest`));
  assert.equal(paid!.status, 200);
  const iSettle = trace.indexOf("settle 15000");
  const iPay = trace.indexOf("pay /honest");
  assert.ok(iSettle > 0 && iPay > iSettle, trace.join(","));
  assert.ok(trace.indexOf("verify 15000") < iSettle);
  assert.equal(trace.filter((t) => t.startsWith("pay")).length, 1, "exactly one seller payment");
  const approved = deps.paid[0].approved as { amount: string; payTo: string };
  assert.deepEqual([approved.amount, approved.payTo], ["10000", SELLER]);
});

test("ALLOW: the seller's body is returned byte for byte with its content-type; verdict and both tx ids in headers", async () => {
  const { app } = setup();
  const { paid } = await buy(app, buyPath(`${HOST}/honest`));
  assert.equal(paid!.status, 200);
  assert.equal(await paid!.text(), HONEST_BODY);
  assert.equal(paid!.headers.get("content-type"), "application/json");
  assert.equal(paid!.headers.get("x-vet402-verdict"), "ALLOW");
  assert.equal(paid!.headers.get("x-vet402-reason"), "delivered");
  assert.equal(paid!.headers.get("x-vet402-customer-tx"), "CUSTOMER_TX");
  assert.equal(paid!.headers.get("x-vet402-seller-tx"), "SELLER_TX");
  assert.equal(paid!.headers.get("x-content-type-options"), "nosniff");
  assert.match(paid!.headers.get("content-security-policy") ?? "", /sandbox/);
  assert.ok(paid!.headers.get("PAYMENT-RESPONSE"), "customer settlement header");
});

test("REFUSE (liar): the body is still returned as-is, with REFUSE and the reason in headers", async () => {
  const { app } = setup();
  const { paid } = await buy(app, buyPath(`${HOST}/liar`));
  assert.equal(paid!.status, 200);
  assert.equal(await paid!.text(), LIAR_BODY);
  assert.equal(paid!.headers.get("x-vet402-verdict"), "REFUSE");
  assert.equal(paid!.headers.get("x-vet402-reason"), "delivery_missing_keys");
  assert.equal(paid!.headers.get("x-vet402-seller-tx"), "SELLER_TX");
});

test("binary bodies survive unchanged", async () => {
  const state = sellerState();
  const bytes = new Uint8Array([0, 255, 1, 254, 0x80, 0x0a, 0xc3, 0x28]);
  state.body = () => ({ bytes, contentType: "application/octet-stream" });
  const { app } = setup({ state });
  const { paid } = await buy(app, buyPath(`${HOST}/honest`));
  assert.deepEqual(new Uint8Array(await paid!.arrayBuffer()), bytes);
  assert.equal(paid!.headers.get("content-type"), "application/octet-stream");
  assert.equal(paid!.headers.get("x-vet402-verdict"), "REFUSE"); // not JSON: the declaration is not met, but the body is delivered
});

test("a body above 1 MB is not forwarded in part: 502 with both tx ids, no refund", async () => {
  const state = sellerState();
  state.body = () => ({ bytes: new Uint8Array(1_000_001), contentType: "application/octet-stream" });
  const { app } = setup({ state });
  const { paid } = await buy(app, buyPath(`${HOST}/honest`));
  assert.equal(paid!.status, 502);
  const body = (await paid!.json()) as { error: string; refund: string };
  assert.deepEqual([body.error, body.refund], ["response_too_large", "none"]);
  assert.equal(paid!.headers.get("x-vet402-customer-tx"), "CUSTOMER_TX");
  assert.equal(paid!.headers.get("x-vet402-seller-tx"), "SELLER_TX");
});

test("seller payment fails after the customer paid: 502 with the reason and the customer's tx, no refund", async () => {
  const state = sellerState();
  state.paySucceeds = false;
  const { app, trace } = setup({ state });
  const { paid } = await buy(app, buyPath(`${HOST}/honest`));
  assert.equal(paid!.status, 502);
  const body = (await paid!.json()) as { error: string; reason: string; refund: string; customerPayment: { transaction: string } };
  assert.deepEqual([body.error, body.reason, body.refund, body.customerPayment.transaction], ["seller_not_paid", "payment_failed", "none", "CUSTOMER_TX"]);
  assert.equal(paid!.headers.get("x-vet402-verdict"), "REFUSE");
  assert.equal(paid!.headers.get("x-vet402-customer-tx"), "CUSTOMER_TX");
  assert.ok(settled(trace));
});

test("seller raises its price after the customer settled: vet402 does not pay it (price_changed), 502", async () => {
  const state = sellerState();
  const { app, trace, deps } = setup({ state });
  state.onLook = () => {
    if (settled(trace)) state.accept = { ...state.accept, amount: "11000" };
  };
  const { paid } = await buy(app, buyPath(`${HOST}/honest`));
  assert.equal(paid!.status, 502);
  assert.equal(((await paid!.json()) as { reason: string }).reason, "price_changed");
  assert.equal(deps.paid.length, 0);
});

test("customer settlement fails: the seller is never paid", async () => {
  const { app, deps } = setup({ settleOk: false });
  const { paid } = await buy(app, buyPath(`${HOST}/honest`));
  assert.equal(paid!.status, 402);
  assert.equal(deps.paid.length, 0);
});

test("daily headroom below the seller's price: refused before settle", async () => {
  const cfg = baseCfg();
  const low: SpendGuard = { ...guardFor(cfg), reserve: async () => ({ ok: false, reason: "daily_cap_reached", detail: "x" }), release() {}, commit() {}, headroom: async () => ({ ok: true, remainingAtomic: 9_999n }) };
  const { app, trace, deps } = setup({ cfg, guard: low });
  const { paid } = await buy(app, buyPath(`${HOST}/honest`));
  assert.equal(paid!.status, 503);
  assert.ok(!settled(trace));
  assert.equal(deps.paid.length, 0);
});

test("POST: the customer's body is sent to the seller only after the customer's payment settled, unchanged, with content-type only", async () => {
  const { app, deps, trace } = setup();
  const json = '{"city":"Tokyo","days":[1,2]}';
  const init: RequestInit = { method: "POST", body: json, headers: { "content-type": "application/json", authorization: "Bearer secret", cookie: "s=1", "x-custom": "y" } };
  const { paid } = await buy(app, buyPath(`${HOST}/honest`), { init });
  assert.equal(paid!.status, 200);
  assert.equal(await paid!.text(), HONEST_BODY);
  // Before settlement (free price, paid request's price): a plain GET, no body.
  const iSettle = trace.findIndex((t) => t.startsWith("settle"));
  const before = trace.slice(0, iSettle).filter((t) => t.startsWith("look")).length;
  assert.equal(before, 2);
  for (const seen of deps.looks.slice(0, before)) {
    assert.equal(seen.method, "GET");
    assert.equal(seen.body, undefined);
  }
  // After settlement: the probe read and the payment carry the customer's body and only content-type.
  assert.ok(deps.looks.length > before);
  for (const seen of [...deps.looks.slice(before), deps.paid[0].init]) {
    assert.equal(seen.method, "POST");
    assert.equal(Buffer.from(seen.body as Uint8Array).toString(), json);
    assert.deepEqual(Object.keys((seen.headers as Record<string, string>) ?? {}), ["content-type"]);
  }
});

test("unpaid POST is not a free relay: a POST-only seller is priced only from its Bazaar-listed example input", async () => {
  const state = { ...sellerState(), postOnly: true };
  // Not listed: refused, and the seller only ever saw a bodiless GET.
  {
    const { app, deps } = setup({ state });
    const res = await app.request(buyPath(`${HOST}/honest`), { method: "POST", body: '{"secret":"relay me"}', headers: { "content-type": "application/json" } });
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { reason: string }).reason, "not_listed");
    assert.deepEqual(deps.looks.map((l) => [l.method, l.body]), [["GET", undefined]]);
  }
  // Listed for POST: priced with the listed example body, never the customer's.
  const listed: BazaarItem = { resourceUrl: `${HOST}/honest`, method: "POST", accepts: [state.accept], discoveryInfo: { input: { method: "POST", body: { city: "Example" }, bodyType: "json" } } };
  const { app, deps, trace } = setup({ state, catalog: catalogOf([listed]) });
  const init: RequestInit = { method: "POST", body: '{"city":"Tokyo"}', headers: { "content-type": "application/json" } };
  const { first, paid } = await buy(app, buyPath(`${HOST}/honest`), { init });
  assert.equal(first.status, 402);
  assert.equal(((await first.json()) as { buy: { priceRead: string } }).buy.priceRead, "listed_example");
  assert.equal(paid!.status, 200);
  const iSettle = trace.findIndex((t) => t.startsWith("settle"));
  const beforeLooks = deps.looks.slice(0, trace.slice(0, iSettle).filter((t) => t.startsWith("look")).length);
  assert.ok(beforeLooks.length >= 2);
  for (const l of beforeLooks) assert.ok(l.body === undefined || String(l.body) === '{"city":"Example"}', `pre-settle body ${String(l.body)}`);
  assert.equal(Buffer.from(deps.paid[0].init.body as Uint8Array).toString(), '{"city":"Tokyo"}');
});

test("price reads are limited per client IP (in memory): the 31st in a minute is 429 and does not reach the seller", async () => {
  const { app, deps } = setup();
  for (let i = 0; i < 30; i++) assert.equal((await app.request(buyPath(`${HOST}/honest`), { headers: { "x-real-ip": "203.0.113.9" } })).status, 402);
  const looks = deps.looks.length;
  const over = await app.request(buyPath(`${HOST}/honest`), { headers: { "x-real-ip": "203.0.113.9" } });
  assert.equal(over.status, 429);
  assert.equal(((await over.json()) as { reason: string }).reason, "rate_limited");
  assert.equal(deps.looks.length, looks);
  assert.equal((await app.request(buyPath(`${HOST}/honest`), { headers: { "x-real-ip": "203.0.113.10" } })).status, 402, "another client is not limited");
});

test("a chunked POST body with no content-length is cut at 64 KB (413), not read to the end", async () => {
  let pulled = 0;
  const chunk = new Uint8Array(16 * 1024).fill(0x20);
  const endless = new ReadableStream<Uint8Array>({
    pull(ctl) {
      pulled++;
      if (pulled > 1000) return ctl.close();
      ctl.enqueue(chunk);
    },
  });
  const capped = await readBodyCapped(endless, BUY_MAX_REQUEST_BYTES);
  assert.equal(capped.ok, false);
  assert.ok(pulled <= 7, `read ${pulled} chunks`);
  const { app, deps } = setup();
  const big = new ReadableStream<Uint8Array>({
    start(ctl) {
      for (let i = 0; i < 8; i++) ctl.enqueue(chunk);
      ctl.close();
    },
  });
  const req = new Request(`http://localhost${buyPath(`${HOST}/honest`)}`, { method: "POST", body: big, headers: { "content-type": "application/json" }, duplex: "half" } as RequestInit);
  assert.equal(req.headers.get("content-length"), null);
  const res = await app.fetch(req);
  assert.equal(res.status, 413);
  assert.equal(deps.looks.length, 0);
});

test("POST guards are free: non-JSON content-type (415), too large (413), invalid JSON (400)", async () => {
  const cases: [RequestInit, number][] = [
    [{ method: "POST", body: "a=1", headers: { "content-type": "application/x-www-form-urlencoded" } }, 415],
    [{ method: "POST", body: JSON.stringify({ x: "y".repeat(BUY_MAX_REQUEST_BYTES) }), headers: { "content-type": "application/json" } }, 413],
    [{ method: "POST", body: "{not json", headers: { "content-type": "application/json" } }, 400],
  ];
  for (const [init, status] of cases) {
    const { app, trace, deps } = setup();
    const res = await app.request(buyPath(`${HOST}/honest`), init);
    assert.equal(res.status, status);
    assert.equal(deps.looks.length, 0, "the seller is not contacted");
    // Paid: still refused, never settled.
    const again = await app.request(buyPath(`${HOST}/honest`), { ...init, headers: { ...(init.headers as Record<string, string>), "PAYMENT-SIGNATURE": sig({ amount: "15000" }, {}) } });
    assert.notEqual(again.status, 200);
    assert.ok(!settled(trace));
  }
});

test("HEAD is refused (it would deliver no body), paid or not; never settled", async () => {
  const { app, trace, deps } = setup();
  const unpaid = await app.request(buyPath(`${HOST}/honest`), { method: "HEAD" });
  assert.equal(unpaid.status, 405);
  const first = await app.request(buyPath(`${HOST}/honest`));
  const pr = decodePR(first);
  const paid = await app.request(buyPath(`${HOST}/honest`), { method: "HEAD", headers: { "PAYMENT-SIGNATURE": sig(pr.accepts[0], pr.resource) } });
  assert.notEqual(paid.status, 200);
  assert.ok(!settled(trace), trace.join(","));
  assert.equal(deps.paid.length, 0);
});

test("path drift (/v1/buy/, /V1/buy, //v1/buy): never settled, seller never paid", async () => {
  for (const drift of ["/v1/buy/", "/V1/buy", "/v1/BUY", "//v1/buy"]) {
    const { app, trace, deps } = setup();
    const q = `?url=${encodeURIComponent(`${HOST}/honest`)}`;
    const { paid, first } = await buy(app, "/v1/buy" + q, { paidPath: drift + q });
    assert.equal(first.status, 402);
    assert.notEqual(paid!.status, 200, drift);
    assert.ok(!settled(trace), `${drift}: ${trace.join(",")}`);
    assert.equal(deps.paid.length, 0, drift);
    const unpaid = await setup().app.request(drift + q);
    assert.notEqual(unpaid.status, 200, drift);
  }
});

test("/v1/check still works next to /v1/buy (its own middleware is untouched)", async () => {
  const { app } = setup();
  const res = await app.request(`/v1/check?url=${encodeURIComponent(`${HOST}/honest`)}`);
  assert.equal(res.status, 402);
  assert.equal(decodePR(res).accepts[0].amount, "50000");
});

test("config: BUY_FEE_USDC default 0.005, at least 0.001; fee + per-call cap must stay below the audit price", () => {
  const cfg = baseCfg();
  assert.equal(cfg.buyFeeAtomic, 5_000n);
  assert.throws(() => baseCfg({ BUY_FEE_USDC: "0" }), /BUY_FEE_USDC/);
  assert.throws(() => baseCfg({ BUY_FEE_USDC: "0.0009" }), /at least 0.001/);
  assert.throws(() => baseCfg({ BUY_FEE_USDC: "0.47" }), /below AUDIT_PRICE_USDC/);
});

test("seller answers 204 / 205 after both payments: 200 with an empty body, verdict and both tx ids still in headers", async () => {
  for (const status of [204, 205]) {
    const state = sellerState();
    state.paidStatus = status;
    const { app } = setup({ state });
    const { paid } = await buy(app, buyPath(`${HOST}/honest`));
    assert.equal(paid!.status, 200, `seller ${status}`);
    assert.equal((await paid!.arrayBuffer()).byteLength, 0);
    assert.equal(paid!.headers.get("x-vet402-seller-status"), String(status));
    assert.equal(paid!.headers.get("x-vet402-verdict"), "REFUSE");
    assert.ok(paid!.headers.get("x-vet402-reason"));
    assert.equal(paid!.headers.get("x-vet402-customer-tx"), "CUSTOMER_TX");
    assert.equal(paid!.headers.get("x-vet402-seller-tx"), "SELLER_TX");
  }
  // Any other 2xx is 200 too.
  const state = sellerState();
  state.paidStatus = 201;
  const { app } = setup({ state });
  const { paid } = await buy(app, buyPath(`${HOST}/honest`));
  assert.equal(paid!.status, 200);
  assert.equal(await paid!.text(), HONEST_BODY);
  assert.equal(paid!.headers.get("x-vet402-seller-status"), "201");
});

test("an x402 v1 payment is refused before settlement (v1 is matched by scheme and network only)", async () => {
  const t: Trace = [];
  const f = fakeFacilitator(t);
  const N = NET as `${string}:${string}`;
  f.getSupported = async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: N }, { x402Version: 1, scheme: "exact", network: N }], extensions: [], signers: {} });
  const { app, deps } = setup({ facilitator: f });
  const trace = t;
  const first = await app.request(buyPath(`${HOST}/honest`));
  const pr = decodePR(first);
  const v1 = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: pr.accepts[0].network, accepted: { ...pr.accepts[0], amount: "1" }, payload: { paymentGroup: [], paymentIndex: 0 } })).toString("base64");
  const paid = await app.request(buyPath(`${HOST}/honest`), { headers: { "PAYMENT-SIGNATURE": v1 } });
  assert.equal(paid.status, 400);
  assert.equal(((await paid.json()) as { reason: string }).reason, "unsupported_x402_version");
  assert.ok(!settled(trace), trace.join(","));
  assert.equal(deps.paid.length, 0);
});

test("the seller's price is reserved on the daily cap before settlement: a concurrent purchase near the cap is refused unpaid; no double reservation", async () => {
  const cfg = baseCfg();
  const ledger = new SpendLedger(cfg.maxPerCallAtomic, 15_000n); // room for one 0.01 purchase
  let open!: () => void;
  const state = sellerState();
  state.payGate = new Promise<void>((r) => (open = r));
  const { app, trace, deps } = setup({ cfg, state, guard: new LocalSpendGuard(ledger) });
  const firstDone = buy(app, buyPath(`${HOST}/honest`));
  for (let i = 0; i < 200 && !trace.includes("pay /honest"); i++) await new Promise((r) => setImmediate(r));
  assert.ok(trace.includes("pay /honest"), "first purchase is paying the seller");
  assert.equal(ledger.spentTodayAtomic(), 10_000n);
  const second = await buy(app, buyPath(`${HOST}/honest`));
  assert.equal(second.paid!.status, 503);
  assert.equal(((await second.paid!.json()) as { reason: string }).reason, "daily_cap_reached");
  assert.equal(trace.filter((t) => t.startsWith("settle")).length, 1, "the second customer was not charged");
  open();
  const first = await firstDone;
  assert.equal(first.paid!.status, 200);
  assert.equal(deps.paid.length, 1);
  assert.equal(ledger.spentTodayAtomic(), 10_000n, "reserved once, committed once");
});

test("customer settlement fails: the reservation is given back", async () => {
  const cfg = baseCfg();
  const ledger = new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic);
  const { app, deps } = setup({ cfg, guard: new LocalSpendGuard(ledger), settleOk: false });
  const { paid } = await buy(app, buyPath(`${HOST}/honest`));
  assert.equal(paid!.status, 402);
  assert.equal(deps.paid.length, 0);
  assert.equal(ledger.spentTodayAtomic(), 0n);
});

test("seller refused after settlement without a signature: the reservation is given back", async () => {
  const cfg = baseCfg();
  const ledger = new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic);
  const state = sellerState();
  const { app, trace } = setup({ cfg, state, guard: new LocalSpendGuard(ledger) });
  state.onLook = () => {
    if (settled(trace)) state.accept = { ...state.accept, amount: "11000" };
  };
  const { paid } = await buy(app, buyPath(`${HOST}/honest`));
  assert.equal(paid!.status, 502);
  assert.equal(ledger.spentTodayAtomic(), 0n);
});

test("one facilitator /supported read is shared by /v1/check, /v1/audit, /v1/verdict and /v1/buy", async () => {
  let reads = 0;
  const trace: Trace = [];
  const f = fakeFacilitator(trace);
  const base = f.getSupported.bind(f);
  f.getSupported = async () => {
    reads++;
    await new Promise((r) => setTimeout(r, 20));
    return base();
  };
  const { app } = setup({ facilitator: f });
  const answers = await Promise.all([
    app.request(`/v1/check?url=${encodeURIComponent(`${HOST}/honest`)}`),
    app.request("/v1/audit?seller=localhost:4031"),
    app.request("/v1/verdict?url=not-a-url"),
    app.request(buyPath(`${HOST}/honest`)),
    app.request(buyPath(`${HOST}/liar`)),
  ]);
  assert.equal(reads, 1);
  for (const a of answers) assert.ok(a.status < 500, `status ${a.status}`);
  assert.equal(answers[0].status, 402);
  assert.equal(answers[3].status, 402);
});

test("GET / (JSON) lists /v1/verdict and /v1/buy", async () => {
  const { app } = setup();
  const res = await app.request("/", { headers: { accept: "application/json" } });
  const body = (await res.json()) as { endpoints: Record<string, string> };
  assert.ok(body.endpoints["GET /v1/verdict?url=<x402 URL>"]?.includes("0.001"));
  assert.ok(body.endpoints["GET|POST /v1/buy?url=<x402 URL>"]?.includes("0.005"));
  assert.ok(body.endpoints["GET /v1/check?url=<x402 URL>"]);
});

// ---- /activity ----------------------------------------------------------------------------------

const ASA_M = "31566704";
const PT = "RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q";
const PY = "OZ3KMLALTO67BZLYLCZOT7IJBGN7JTO5A3MJHI2267EKQDASFKS52KU6VY";
const FEEPAYER = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
const ALICE = "ALICEALICEALICEALICEALICEALICEALICEALICEALICEALICEALICEALIC";
const BOB = "BOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBO";
const MALLORY = "MALLORYMALLORYMALLORYMALLORYMALLORYMALLORYMALLORYMALLORYMAL";
const SA = "SELLERAAAASELLERAAAASELLERAAAASELLERAAAASELLERAAAASELLERAAA";
const T0 = 1790479000;

function ledgerOf(incoming: [id: string, from: string, amount: number, round: number][], payouts: [id: string, amount: number, round: number][]) {
  const ax = (id: string, s: string, r: string, amount: number, round: number, group?: string) => ({
    id, sender: s, "tx-type": "axfer", fee: 0, ...(group ? { group } : {}), "confirmed-round": round, "round-time": T0 + round * 3, "intra-round-offset": 1,
    "asset-transfer-transaction": { "asset-id": Number(ASA_M), amount, receiver: r, "close-amount": 0 },
  });
  const ins = incoming.map(([id, from, amount, round]) => ax(id, from, PT, amount, round, `G-${id}`));
  const outs = payouts.map(([id, amount, round]) => ax(id, PY, SA, amount, round));
  const groups = Object.fromEntries(ins.map((t) => [t.group!, [{ id: `F-${t.id}`, sender: FEEPAYER, "tx-type": "pay", fee: 2000, group: t.group, "confirmed-round": t["confirmed-round"], "round-time": t["round-time"], "intra-round-offset": 0 }, t]]));
  const f = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.includes(PT)) return Response.json({ transactions: ins });
    if (u.pathname.includes(PY)) return Response.json({ transactions: outs });
    return Response.json({ transactions: groups[u.searchParams.get("group-id")!] ?? [] });
  }) as unknown as typeof fetch;
  return new ActivityLedger({
    networkName: "mainnet", indexerUrl: "https://idx", asaId: ASA_M, payTo: PT, payer: PY, fetchImpl: f,
    priceAtomic: 50_000n, buyFeeAtomic: 5_000n, verdictPriceAtomic: usdcToAtomic(VERDICT_PRICE_USDC), auditPriceAtomic: 500_000n,
  });
}

test("/activity: a buy pairs with its seller payment; a verdict is a customer with no seller payment; a check is unchanged", async () => {
  const r = await ledgerOf(
    [["BUY1", ALICE, 15_000, 100], ["VERD1", BOB, 1_000, 105], ["CHECK1", BOB, 50_000, 130]],
    [["OUT1", 10_000, 102], ["OUT5", 10_000, 131]],
  ).get();
  assert.deepEqual(r.rows.map((w) => [w.customerTx, w.kind, w.sellerTx]), [["CHECK1", "check", "OUT5"], ["VERD1", "verdict", null], ["BUY1", "buy", "OUT1"]]);
  assert.deepEqual(r.notCounted, []);
  assert.equal(r.unmatchedPayouts.length, 0);
  assert.equal(r.totals.customers.payments, 3);
});

test("/activity cannot be inflated with small payments: unpaired, too small for the seller payment, or a verdict next to a seller payment", async () => {
  const r = await ledgerOf(
    [
      ["SPAM1", MALLORY, 6_000, 100], // could be a buy, but no seller payment follows
      ["SPAM2", MALLORY, 5_001, 101],
      ["DUST", MALLORY, 500, 102], // below everything
      ["SMALL", MALLORY, 12_000, 108], // 12000 - 5000 fee < 9000 paid to the seller
      ["VERD2", MALLORY, 1_000, 300], // a lookup never takes a seller payment (the others are out of the 300 s window by now)
    ],
    [["OUT3", 9_000, 109], ["OUT4", 500, 301]],
  ).get();
  assert.deepEqual(r.rows.map((w) => w.customerTx), ["VERD2"]);
  assert.equal(r.totals.customers.payments, 1);
  assert.deepEqual(r.notCounted.map((n) => [n.tx, n.reason]).sort(), [["DUST", "below_price"], ["SMALL", "below_price"], ["SPAM1", "below_price"], ["SPAM2", "below_price"]]);
  assert.deepEqual(r.unmatchedPayouts.map((p) => p.tx).sort(), ["OUT3", "OUT4"]);
});

test("/activity: the fee rule is exact (payment - fee == seller payment pairs; one atomic unit more does not)", async () => {
  const ok = await ledgerOf([["B", ALICE, 15_000, 100]], [["O", 10_000, 101]]).get();
  assert.deepEqual(ok.rows.map((w) => [w.kind, w.sellerTx]), [["buy", "O"]]);
  const no = await ledgerOf([["B", ALICE, 15_000, 100]], [["O", 10_001, 101]]).get();
  assert.equal(no.rows.length, 0);
  assert.deepEqual(no.unmatchedPayouts.map((p) => p.tx), ["O"]);
});

test("/activity A1: a small payment slipped between a check and its seller payment does not take it (+1 customer)", async () => {
  const r = await ledgerOf(
    [["CHECK1", BOB, 50_000, 100], ["X1", MALLORY, 20_000, 101]],
    [["OUT1", 10_000, 103]],
  ).get();
  assert.deepEqual(r.rows.map((w) => [w.customerTx, w.kind, w.sellerTx]), [["CHECK1", "check", "OUT1"]]);
  assert.deepEqual(r.notCounted.map((n) => [n.tx, n.reason]), [["X1", "below_price"]]);
  assert.equal(r.totals.customers.payments, 1);
});

test("/activity A2: a small payment slipped into an audit does not take one of its seller payments (+1 customer)", async () => {
  const r = await ledgerOf(
    [["AUDIT1", BOB, 500_000, 100], ["X2", MALLORY, 20_000, 101]],
    [["OUT1", 10_000, 103], ["OUT2", 10_000, 104]],
  ).get();
  assert.deepEqual(r.rows.map((w) => [w.customerTx, w.kind, w.sellerPayments.map((p) => p.tx)]), [["AUDIT1", "audit", ["OUT1", "OUT2"]]]);
  assert.deepEqual(r.notCounted.map((n) => n.tx), ["X2"]);
  assert.equal(r.totals.customers.payments, 1);
});

test("/activity: between two purchases, a seller payment goes to the one whose (payment - fee) equals it", async () => {
  const r = await ledgerOf(
    [["BUY1", ALICE, 15_000, 100], ["X3", MALLORY, 40_000, 101]],
    [["OUT1", 10_000, 103]],
  ).get();
  assert.deepEqual(r.rows.map((w) => [w.customerTx, w.kind, w.sellerTx]), [["BUY1", "buy", "OUT1"]]);
  assert.deepEqual(r.notCounted.map((n) => n.tx), ["X3"]);
});
