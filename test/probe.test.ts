import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ALGORAND_TESTNET_CAIP2, USDC_TESTNET_ASA_ID } from "@x402/avm";
import { mnemonicFromSeed } from "@algorandfoundation/algokit-utils/algo25";
import { probe, makePaidFetch, type ProbeDeps, type PaidFetchResult } from "../src/probe.js";
import { SpendLedger } from "../src/caps.js";
import { loadConfig } from "../src/config.js";
import { secretKeyB64FromMnemonic } from "../src/keys.js";
import type { AcceptLike } from "../src/declaration.js";

const cfg = { ...loadConfig({ ALLOW_PRIVATE_TARGETS: "1" }) };
const SELLER = "SELLERADDRESSSELLERADDRESSSELLERADDRESSSELLERADDRESSSELLER";

function paymentRequired(amount: string, opts: { network?: string; asset?: string } = {}) {
  return {
    x402Version: 2,
    resource: { url: "http://localhost:4031/x", description: "Tokyo forecast", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: opts.network ?? ALGORAND_TESTNET_CAIP2,
        asset: opts.asset ?? String(USDC_TESTNET_ASA_ID),
        amount,
        payTo: SELLER,
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
    extensions: {
      bazaar: {
        info: {
          output: {
            type: "json",
            example: { forecast: "sunny", temperature: 21 },
            schema: { type: "object", required: ["forecast", "temperature"] },
          },
        },
      },
    },
  };
}

const res402 = (pr: unknown) =>
  new Response(JSON.stringify({}), {
    status: 402,
    headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64"), "content-type": "application/json" },
  });

function fakeDeps(pr: unknown, delivered: unknown, settle: PaidFetchResult["settle"] = { success: true, transaction: "TX_SELLER_1", network: ALGORAND_TESTNET_CAIP2 }) {
  const calls = { unpaid: [] as RequestInit[], paid: [] as AcceptLike[] };
  const deps: ProbeDeps = {
    fetchImpl: async (_u, init) => {
      calls.unpaid.push(init);
      return res402(pr);
    },
    paidFetch: async (_u, approved) => {
      calls.paid.push(approved);
      return {
        response: new Response(typeof delivered === "string" ? delivered : JSON.stringify(delivered), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        settle,
        signed: true,
      };
    },
  };
  return { deps, calls };
}

const ledger = () => new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic);

test("honest seller: pays once, ALLOW delivered, downstream tx id returned", async () => {
  const { deps, calls } = fakeDeps(paymentRequired("10000"), { forecast: "sunny", temperature: 21 });
  const l = ledger();
  const r = await probe("http://localhost:4031/honest", cfg, l, deps);
  assert.equal(r.verdict, "ALLOW");
  assert.equal(r.reason, "delivered");
  assert.equal(r.downstreamPayment?.transaction, "TX_SELLER_1");
  assert.equal(calls.paid.length, 1);
  assert.equal(calls.unpaid[0].redirect, "manual");
  assert.equal(l.spentTodayAtomic(), 10_000n);
  assert.deepEqual(r.declared?.expectedKeys, ["forecast", "temperature"]);
});

test("lying seller: REFUSE delivery_missing_keys with evidence", async () => {
  const { deps } = fakeDeps(paymentRequired("10000"), { message: "thanks for paying" });
  const r = await probe("http://localhost:4031/liar", cfg, ledger(), deps);
  assert.equal(r.verdict, "REFUSE");
  assert.equal(r.reason, "delivery_missing_keys");
  assert.deepEqual(r.delivery?.missingKeys, ["forecast", "temperature"]);
  assert.equal(r.downstreamPayment?.transaction, "TX_SELLER_1");
});

test("price over cap: REFUSE price_over_cap and never calls the paying fetch", async () => {
  const { deps, calls } = fakeDeps(paymentRequired("500000"), { forecast: "x", temperature: 1 });
  const l = ledger();
  const r = await probe("http://localhost:4031/pricey", cfg, l, deps);
  assert.equal(r.reason, "price_over_cap");
  assert.equal(calls.paid.length, 0);
  assert.equal(l.spentTodayAtomic(), 0n);
  assert.equal(r.price?.usdc, "0.500000");
});

test("daily cap: stops paying once the day's budget is used", async () => {
  const { deps, calls } = fakeDeps(paymentRequired("40000"), { forecast: "x", temperature: 1 });
  const l = new SpendLedger(40_000n, 80_000n);
  assert.equal((await probe("http://localhost:4031/honest", cfg, l, deps)).reason, "delivered");
  assert.equal((await probe("http://localhost:4031/honest", cfg, l, deps)).reason, "delivered");
  assert.equal((await probe("http://localhost:4031/honest", cfg, l, deps)).reason, "daily_cap_reached");
  assert.equal(calls.paid.length, 2);
});

test("not_x402 when target answers 200 without payment", async () => {
  const deps: ProbeDeps = {
    fetchImpl: async () => new Response("{}", { status: 200 }),
    paidFetch: async () => assert.fail("must not pay"),
  };
  assert.equal((await probe("http://localhost:1/free", cfg, ledger(), deps)).reason, "not_x402");
});

test("not_x402 when 402 has no parseable requirements", async () => {
  const deps: ProbeDeps = {
    fetchImpl: async () => new Response("pay me", { status: 402 }),
    paidFetch: async () => assert.fail("must not pay"),
  };
  assert.equal((await probe("http://localhost:1/x", cfg, ledger(), deps)).reason, "not_x402");
});

test("no_supported_accept for other networks or assets", async () => {
  for (const pr of [paymentRequired("10000", { network: "eip155:8453" }), paymentRequired("10000", { asset: "31566704" })]) {
    const { deps, calls } = fakeDeps(pr, {});
    assert.equal((await probe("http://localhost:4031/x", cfg, ledger(), deps)).reason, "no_supported_accept");
    assert.equal(calls.paid.length, 0);
  }
});

test("truncated (>=2.20 style) CAIP-2 from a seller is accepted as TestNet", async () => {
  const { deps } = fakeDeps(paymentRequired("10000", { network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe" }), { forecast: "a", temperature: 1 });
  assert.equal((await probe("http://localhost:4031/x", cfg, ledger(), deps)).reason, "delivered");
});

test("payment_failed when settlement is not successful", async () => {
  const { deps } = fakeDeps(paymentRequired("10000"), { forecast: "a", temperature: 1 }, { success: false, errorReason: "insufficient_funds" });
  const r = await probe("http://localhost:4031/x", cfg, ledger(), deps);
  assert.equal(r.reason, "payment_failed");
  assert.match(r.detail ?? "", /insufficient_funds/);
});

test("payment_failed before signing gives the budget back", async () => {
  const l = ledger();
  const deps: ProbeDeps = {
    fetchImpl: async () => res402(paymentRequired("10000")),
    paidFetch: async () => {
      throw Object.assign(new Error("Failed to create payment payload"), { signed: false });
    },
  };
  assert.equal((await probe("http://localhost:4031/x", cfg, l, deps)).reason, "payment_failed");
  assert.equal(l.spentTodayAtomic(), 0n);
});

test("invalid_target in strict mode (no private hosts)", async () => {
  const strict = loadConfig({});
  const { deps, calls } = fakeDeps(paymentRequired("10000"), {});
  const r = await probe("http://localhost:4031/honest", strict, ledger(), deps);
  assert.equal(r.reason, "invalid_target");
  assert.equal(calls.unpaid.length, 0);
});

test("real paying client: seller raising the price after our look is not paid (no signature)", async () => {
  const seed = new Uint8Array(randomBytes(32));
  const sk = secretKeyB64FromMnemonic(mnemonicFromSeed(seed));
  let hits = 0;
  const baseFetch = (async (req: Request) => {
    hits += 1;
    if (req.headers.has("PAYMENT-SIGNATURE")) assert.fail("must not send a payment");
    return res402(paymentRequired("30000")); // seller now asks 0.03 instead of the approved 0.01
  }) as unknown as typeof fetch;
  const paidFetch = makePaidFetch(cfg, sk, baseFetch);
  const approved = paymentRequired("10000").accepts[0] as AcceptLike;
  await assert.rejects(
    () => paidFetch("http://localhost:4031/x", approved, { method: "GET" }),
    (e: Error & { signed?: boolean }) => e.signed === false && /filtered out by policies/.test(e.message),
  );
  assert.equal(hits, 1);
});

test("real paying client: over-cap requirement is refused before signing", async () => {
  const seed = new Uint8Array(randomBytes(32));
  const sk = secretKeyB64FromMnemonic(mnemonicFromSeed(seed));
  const baseFetch = (async (req: Request) => {
    if (req.headers.has("PAYMENT-SIGNATURE")) assert.fail("must not send a payment");
    return res402(paymentRequired("500000"));
  }) as unknown as typeof fetch;
  const paidFetch = makePaidFetch(cfg, sk, baseFetch);
  const approved = paymentRequired("500000").accepts[0] as AcceptLike; // even if a bug approved it
  await assert.rejects(
    () => paidFetch("http://localhost:4031/x", approved, { method: "GET" }),
    (e: Error & { signed?: boolean }) => e.signed === false && /filtered out by policies/.test(e.message),
  );
});
