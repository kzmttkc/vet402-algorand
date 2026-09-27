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
  const app = createApp(strict, { payTo: VET402, probeDeps: probeDeps(trace), guard: guard(), facilitator: fakeFacilitator(trace) });
  const res = await paidRequest(app, "http://localhost:4031/honest");
  assert.equal(res.status, 400);
  assert.deepEqual(trace, ["verify"]);
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
