/**
 * Order is the contract: the customer's payment must be SETTLED before vet402
 * touches the seller. These tests drive the real Hono app + x402 resource server
 * with a fake facilitator, and fail if the seller is contacted before settle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALGORAND_TESTNET_CAIP2 } from "@x402/avm";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { SpendLedger } from "../src/caps.js";
import { LocalSpendGuard, type SpendGuard } from "../src/spend.js";
import type { ProbeDeps } from "../src/probe.js";
import type { FacilitatorClient } from "@x402/core/server";
import { LISTING_EXAMPLE_URL } from "../src/bazaar.js";
import { checkBeforeCharge, PRECHARGE_DNS_TIMEOUT_MS } from "../src/target.js";

const cfg = loadConfig({ ALLOW_PRIVATE_TARGETS: "1" });
const VET402 = "VET402PAYTOVET402PAYTOVET402PAYTOVET402PAYTOVET402PAYTOVET4";
const SELLER = "SELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELL";

type Trace = string[];

function fakeFacilitator(trace: Trace, settleOk = true): FacilitatorClient {
  const NET = ALGORAND_TESTNET_CAIP2 as `${string}:${string}`;
  return {
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: "exact", network: NET, extra: { feePayer: "FEEPAYER" } }],
        extensions: [],
        signers: {},
      };
    },
    async verify() {
      trace.push("verify");
      return { isValid: true, payer: "CUSTOMER" };
    },
    async settle() {
      trace.push("settle");
      return settleOk
        ? { success: true, transaction: "CUSTOMER_TX", network: NET, payer: "CUSTOMER" }
        : { success: false, errorReason: "insufficient_funds", transaction: "", network: NET };
    },
  };
}

const sellerPR = {
  x402Version: 2,
  resource: { url: "http://localhost:4031/honest", description: "forecast", mimeType: "application/json" },
  accepts: [{ scheme: "exact", network: ALGORAND_TESTNET_CAIP2, asset: "10458941", amount: "10000", payTo: SELLER, maxTimeoutSeconds: 60, extra: {} }],
  extensions: { bazaar: { info: { output: { type: "json", example: { forecast: "sunny", temperature: 21 } } } } },
};

function probeDeps(trace: Trace): ProbeDeps {
  const mustBeSettled = (what: string) => {
    if (!trace.includes("settle")) assert.fail(`${what} called before the customer's payment settled (trace: ${trace.join(",")})`);
    trace.push(what);
  };
  return {
    fetchImpl: async () => {
      mustBeSettled("probe");
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(sellerPR)).toString("base64") } });
    },
    paidFetch: async () => {
      mustBeSettled("pay-seller");
      return {
        response: new Response(JSON.stringify({ forecast: "sunny", temperature: 21 }), { status: 200, headers: { "content-type": "application/json" } }),
        settle: { success: true, transaction: "SELLER_TX", network: ALGORAND_TESTNET_CAIP2 },
        signed: true,
      };
    },
  };
}

async function paidRequest(app: ReturnType<typeof createApp>, target: string) {
  const path = `/v1/check?url=${encodeURIComponent(target)}`;
  const first = await app.request(path);
  assert.equal(first.status, 402);
  const pr = JSON.parse(Buffer.from(first.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
  assert.equal(pr.accepts[0].extra.tag, "x402-global-challenge");
  const payload = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { paymentGroup: [], paymentIndex: 0 } };
  return app.request(path, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") } });
}

const guard = () => new LocalSpendGuard(new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic));

test("order: verify -> settle (customer) -> probe -> pay seller; both tx ids in the body", async () => {
  const trace: Trace = [];
  const app = createApp(cfg, { payTo: VET402, probeDeps: probeDeps(trace), guard: guard(), facilitator: fakeFacilitator(trace) });
  const res = await paidRequest(app, "http://localhost:4031/honest");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { verdict: string; reason: string; customerPayment: { transaction: string }; downstreamPayment: { transaction: string } };
  assert.deepEqual(trace, ["verify", "settle", "probe", "pay-seller"]);
  assert.equal(body.verdict, "ALLOW");
  assert.equal(body.customerPayment.transaction, "CUSTOMER_TX");
  assert.equal(body.downstreamPayment.transaction, "SELLER_TX");
  assert.ok(res.headers.get("PAYMENT-RESPONSE"), "settlement header still returned");
});

test("customer settle fails -> seller is never contacted, 402 returned", async () => {
  const trace: Trace = [];
  const app = createApp(cfg, { payTo: VET402, probeDeps: probeDeps(trace), guard: guard(), facilitator: fakeFacilitator(trace, false) });
  const res = await paidRequest(app, "http://localhost:4031/honest");
  assert.equal(res.status, 402);
  assert.deepEqual(trace, ["verify", "settle"]);
  assert.equal(((await res.json()) as { error: string }).error, "customer_settlement_failed");
});

test("customer settle throws -> seller is never contacted, 402/502 returned", async () => {
  const trace: Trace = [];
  const f = fakeFacilitator(trace);
  f.settle = async () => {
    trace.push("settle-threw");
    throw new Error("facilitator down");
  };
  const app = createApp(cfg, { payTo: VET402, probeDeps: probeDeps(trace), guard: guard(), facilitator: f });
  const res = await paidRequest(app, "http://localhost:4031/honest");
  assert.ok([402, 502].includes(res.status), `status ${res.status}`);
  assert.deepEqual(trace, ["verify", "settle-threw"]);
});

test("invalid target is refused before settle (customer not charged)", async () => {
  const trace: Trace = [];
  const strict = loadConfig({});
  const deps = probeDeps(trace);
  deps.resolveHost = async (h) => (h === "localhost" ? ["127.0.0.1"] : ["66.33.22.11"]); // offline: no real DNS in tests
  const app = createApp(strict, { payTo: VET402, probeDeps: deps, guard: guard(), facilitator: fakeFacilitator(trace) });
  // The unpaid request is refused without a 402 (nothing to sign) ...
  const path = `/v1/check?url=${encodeURIComponent("http://localhost:4031/honest")}`;
  const unpaid = await app.request(path);
  assert.equal(unpaid.status, 400);
  assert.equal(unpaid.headers.get("PAYMENT-REQUIRED"), null);
  // ... and a payment signed anyway is still refused after verify, before settle.
  const res = await app.request(path, { headers: { "PAYMENT-SIGNATURE": await signedFor(app) } });
  assert.equal(res.status, 400);
  assert.deepEqual(trace, ["verify"]);
});

/** A signed payment for /v1/check (its requirements do not depend on ?url=), taken from the 402 of a buyable target. */
async function signedFor(app: ReturnType<typeof createApp>): Promise<string> {
  const first = await app.request(`/v1/check?url=${encodeURIComponent(LISTING_EXAMPLE_URL)}`);
  assert.equal(first.status, 402);
  const pr = JSON.parse(Buffer.from(first.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
  return Buffer.from(JSON.stringify({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { paymentGroup: [], paymentIndex: 0 } })).toString("base64");
}

/** Strict config (production rules: https, public addresses) with a fake DNS; the seller is never contacted. */
function strictApp(trace: Trace, dns: Record<string, string[] | "ENOTFOUND">) {
  const deps = probeDeps(trace);
  deps.resolveHost = async (h) => {
    trace.push(`dns ${h}`);
    const a = dns[h] ?? "ENOTFOUND";
    if (a === "ENOTFOUND") throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${h}`), { code: "ENOTFOUND" });
    return a;
  };
  return createApp(loadConfig({}), { payTo: VET402, probeDeps: deps, guard: guard(), facilitator: fakeFacilitator(trace) });
}
const PUBLIC_DNS = { [new URL(LISTING_EXAMPLE_URL).hostname]: ["66.33.22.11"] };

test("unpaid /v1/check for a host that does not resolve (the old placeholder example): 400 with a reason, no 402, nothing verified", async () => {
  const trace: Trace = [];
  const app = strictApp(trace, PUBLIC_DNS);
  const res = await app.request(`/v1/check?url=${encodeURIComponent("https://seller.example/v1/data")}`);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("PAYMENT-REQUIRED"), null);
  const body = (await res.json()) as { verdict: string; reason: string; detail: string; charged: boolean; target: string };
  assert.deepEqual(body, { verdict: "REFUSE", reason: "invalid_target", target: "https://seller.example/v1/data", detail: "host does not resolve", charged: false });
  assert.deepEqual(trace, ["dns seller.example"]);
});

test("unpaid /v1/check: http, a private address and vet402's own host are refused without a 402", async () => {
  const cases: Array<[string, number, string, string]> = [
    [LISTING_EXAMPLE_URL.replace("https:", "http:"), 400, "invalid_target", "https required"],
    ["https://inside.example/x", 400, "invalid_target", "private or unresolvable address"],
    ["https://10.0.0.7/x", 400, "invalid_target", "private or unresolvable address"],
    ["https://vet402-algorand.vercel.app/v1/check?url=x", 422, "self_dealing", "this URL is vet402 itself; vet402 never buys from itself"],
    ["https://api.vet402.com/x", 422, "self_dealing", "this URL is vet402 itself; vet402 never buys from itself"],
  ];
  for (const [url, status, reason, detail] of cases) {
    const trace: Trace = [];
    const app = strictApp(trace, { ...PUBLIC_DNS, "inside.example": ["93.184.216.34", "192.168.1.9"], "vet402-algorand.vercel.app": ["76.76.21.21"], "api.vet402.com": ["76.76.21.22"] });
    const res = await app.request(`/v1/check?url=${encodeURIComponent(url)}`);
    assert.equal(res.status, status, url);
    assert.equal(res.headers.get("PAYMENT-REQUIRED"), null, url);
    const body = (await res.json()) as { reason: string; detail: string; charged: boolean };
    assert.equal(body.reason, reason, url);
    assert.equal(body.detail, detail, url);
    assert.equal(body.charged, false, url);
    assert.ok(!trace.some((t) => t === "verify" || t === "settle"), url);
  }
});

test("unpaid /v1/check for a target on the host serving the request (a preview deployment of vet402): 422 self_dealing", async () => {
  const trace: Trace = [];
  const app = strictApp(trace, { ...PUBLIC_DNS, "vet402-preview.example": ["76.76.21.23"] });
  const res = await app.request(`https://vet402-preview.example/v1/check?url=${encodeURIComponent("https://vet402-preview.example/v1/verdict")}`);
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as { reason: string }).reason, "self_dealing");
});

test("unpaid /v1/check for the listed example seller: still the 402 (DNS only, the seller is not contacted)", async () => {
  const trace: Trace = [];
  const app = strictApp(trace, PUBLIC_DNS);
  const res = await app.request(`/v1/check?url=${encodeURIComponent(LISTING_EXAMPLE_URL)}`);
  assert.equal(res.status, 402);
  const pr = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
  assert.equal(pr.accepts[0].amount, "50000");
  assert.equal(pr.accepts[0].payTo, VET402);
  assert.deepEqual(pr.extensions.bazaar.info.input, { type: "http", queryParams: { url: LISTING_EXAMPLE_URL }, method: "GET" });
  assert.deepEqual(trace, [`dns ${new URL(LISTING_EXAMPLE_URL).hostname}`]);
});

test("a payment signed for a host that does not resolve is refused after verify, before settle (the second guard)", async () => {
  const trace: Trace = [];
  const app = strictApp(trace, PUBLIC_DNS);
  const res = await app.request(`/v1/check?url=${encodeURIComponent("https://seller.example/v1/data")}`, { headers: { "PAYMENT-SIGNATURE": await signedFor(app) } });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { reason: string }).reason, "invalid_target");
  assert.ok(trace.includes("verify"));
  assert.ok(!trace.includes("settle"));
});

test("checkBeforeCharge: DNS that does not answer in time is a refusal with the reason, not a hang", async () => {
  const t0 = Date.now();
  const r = await checkBeforeCharge("https://slow.example/x", { allowPrivate: false, resolve: () => new Promise(() => {}), isOwnHost: () => false, timeoutMs: 50 });
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(r, { ok: false, status: 400, reason: "invalid_target", detail: "host did not resolve within 0.05 s" });
  const late = await checkBeforeCharge("https://slow.example/x", { allowPrivate: false, resolve: async () => ["93.184.216.34"], isOwnHost: () => false, timeoutMs: 50 });
  assert.equal(late.ok, true);
  assert.equal(PRECHARGE_DNS_TIMEOUT_MS <= 5000, true, "a few seconds at most on the unpaid request");
});

test("cap unverifiable (indexer down) is refused before settle (customer not charged)", async () => {
  const trace: Trace = [];
  const down: SpendGuard = {
    reserve: async () => ({ ok: false, reason: "cap_check_unavailable", detail: "x" }),
    release: () => {},
    commit: () => {},
    headroom: async () => ({ ok: false, reason: "cap_check_unavailable", detail: "indexer 503" }),
  };
  const app = createApp(cfg, { payTo: VET402, probeDeps: probeDeps(trace), guard: down, facilitator: fakeFacilitator(trace) });
  const res = await paidRequest(app, "http://localhost:4031/honest");
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as { reason: string }).reason, "cap_check_unavailable");
  assert.deepEqual(trace, ["verify"]);
});

test("seller paying into vet402's own wallet is refused (self_dealing), no seller payment", async () => {
  const trace: Trace = [];
  const deps = probeDeps(trace);
  const selfPR = { ...sellerPR, accepts: [{ ...sellerPR.accepts[0], payTo: VET402 }] };
  deps.fetchImpl = async () => {
    trace.push("probe");
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(selfPR)).toString("base64") } });
  };
  const app = createApp(cfg, { payTo: VET402, probeDeps: deps, guard: guard(), facilitator: fakeFacilitator(trace) });
  const res = await paidRequest(app, "http://localhost:4031/honest");
  const body = (await res.json()) as { reason: string };
  assert.equal(body.reason, "self_dealing");
  assert.ok(!trace.includes("pay-seller"));
});

test("unpaid request never reaches verify/settle/probe", async () => {
  const trace: Trace = [];
  const app = createApp(cfg, { payTo: VET402, probeDeps: probeDeps(trace), guard: guard(), facilitator: fakeFacilitator(trace) });
  const res = await app.request("/v1/check?url=http://localhost:4031/honest");
  assert.equal(res.status, 402);
  assert.deepEqual(trace, []);
});

test("unpaid HEAD request is priced like GET: never reaches verify/settle/probe, no seller payment", async () => {
  const trace: Trace = [];
  const app = createApp(cfg, { payTo: VET402, probeDeps: probeDeps(trace), guard: guard(), facilitator: fakeFacilitator(trace) });
  const res = await app.request("/v1/check?url=http://localhost:4031/honest", { method: "HEAD" });
  assert.equal(res.status, 402);
  assert.deepEqual(trace, []);
});
