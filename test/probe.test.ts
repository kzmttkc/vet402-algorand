import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ALGORAND_TESTNET_CAIP2, USDC_TESTNET_ASA_ID } from "@x402/avm";
import { mnemonicFromSeed } from "@algorandfoundation/algokit-utils/algo25";
import { declareDiscoveryExtension } from "@x402-avm/extensions";
import { probe, makePaidFetch, parsePaymentRequired, type ProbeDeps, type PaidFetchResult } from "../src/probe.js";
import { SpendLedger } from "../src/caps.js";
import { LocalSpendGuard } from "../src/spend.js";
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

const rawLedger = () => new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic);
const guardOf = (l: SpendLedger) => new LocalSpendGuard(l);
const ledger = () => guardOf(rawLedger());

test("honest seller: pays once, ALLOW delivered, downstream tx id returned", async () => {
  const { deps, calls } = fakeDeps(paymentRequired("10000"), { forecast: "sunny", temperature: 21 });
  const l = rawLedger();
  const r = await probe("http://localhost:4031/honest", cfg, guardOf(l), deps);
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
  const l = rawLedger();
  const r = await probe("http://localhost:4031/pricey", cfg, guardOf(l), deps);
  assert.equal(r.reason, "price_over_cap");
  assert.equal(calls.paid.length, 0);
  assert.equal(l.spentTodayAtomic(), 0n);
  assert.equal(r.price?.usdc, "0.500000");
});

test("daily cap: stops paying once the day's budget is used", async () => {
  const { deps, calls } = fakeDeps(paymentRequired("40000"), { forecast: "x", temperature: 1 });
  const l = guardOf(new SpendLedger(40_000n, 80_000n));
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
  const raw = rawLedger();
  const l = guardOf(raw);
  const deps: ProbeDeps = {
    fetchImpl: async () => res402(paymentRequired("10000")),
    paidFetch: async () => {
      throw Object.assign(new Error("Failed to create payment payload"), { signed: false });
    },
  };
  assert.equal((await probe("http://localhost:4031/x", cfg, l, deps)).reason, "payment_failed");
  assert.equal(raw.spentTodayAtomic(), 0n);
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

test("self_dealing: never pays a seller whose payTo is one of our own wallets", async () => {
  const { deps, calls } = fakeDeps(paymentRequired("10000"), { forecast: "a", temperature: 1 });
  const r = await probe("http://localhost:4031/x", cfg, ledger(), { ...deps, ownAddresses: [SELLER] });
  assert.equal(r.reason, "self_dealing");
  assert.equal(calls.paid.length, 0);
});

// --- Bazaar declarations in the standard layout (declareDiscoveryExtension) ---

function withExtensions(pr: ReturnType<typeof paymentRequired>, extensions: unknown) {
  return { ...pr, extensions } as unknown as ReturnType<typeof paymentRequired>;
}
const stdRequired = declareDiscoveryExtension({
  output: {
    example: { forecast: "sunny", temperature: 21 },
    schema: { type: "object", properties: { forecast: { type: "string" }, temperature: { type: "number" } }, required: ["forecast", "temperature"] },
  },
} as never);
const stdExampleOnly = declareDiscoveryExtension({ output: { example: { forecast: "sunny", temperature: 21 } } } as never);

test("standard-layout schema.required: liar is REFUSE delivery_missing_keys, honest is ALLOW", async () => {
  const pr = withExtensions(paymentRequired("10000"), stdRequired);
  const liar = await probe("http://localhost:4031/liar", cfg, ledger(), fakeDeps(pr, { message: "thanks for paying" }).deps);
  assert.equal(liar.reason, "delivery_missing_keys");
  assert.deepEqual(liar.delivery?.missingKeys, ["forecast", "temperature"]);
  const honest = await probe("http://localhost:4031/honest", cfg, ledger(), fakeDeps(pr, { forecast: "sunny", temperature: 21, city: "Tokyo" }).deps);
  assert.equal(honest.verdict, "ALLOW");
  assert.equal(honest.detail, undefined);
});

test("example-only seller: a delivery without the example keys is ALLOW with a note", async () => {
  const pr = withExtensions(paymentRequired("10000"), stdExampleOnly);
  const r = await probe("http://localhost:4031/x", cfg, ledger(), fakeDeps(pr, { forecast: "sunny" }).deps);
  assert.equal(r.verdict, "ALLOW");
  assert.equal(r.reason, "delivered");
  assert.equal(r.detail, "example keys not seen: temperature");
  assert.deepEqual(r.declared?.expectedKeys, []);
  assert.deepEqual(r.declared?.exampleKeys, ["forecast", "temperature"]);
});

// --- 402 with x402 v2 requirements in the JSON body only (no PAYMENT-REQUIRED header) ---

const bodyOnly402 = (pr: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(pr), { status: 402, headers: { "content-type": "application/json", ...headers } });

function bodyOnlyDeps(pr: unknown, headers?: Record<string, string>) {
  const calls = { paid: 0 };
  const deps: ProbeDeps = {
    fetchImpl: async () => bodyOnly402(pr, headers),
    paidFetch: async () => {
      calls.paid += 1;
      return assert.fail("must not pay a body-only 402");
    },
  };
  return { deps, calls };
}

test("parsePaymentRequired: header first, v2 body only when there is no header", () => {
  const pr = paymentRequired("10000");
  const h = parsePaymentRequired(res402(pr), "{}");
  assert.equal(h?.source, "client");
  assert.equal(h?.pr.accepts[0].amount, "10000");
  const b = parsePaymentRequired(bodyOnly402(pr), JSON.stringify(pr));
  assert.equal(b?.source, "body");
  assert.equal(b?.pr.accepts[0].payTo, SELLER);
  assert.deepEqual(b?.pr.extensions, pr.extensions);
});

test("parsePaymentRequired: body is validated strictly (x402 v2 schema)", () => {
  const pr = paymentRequired("10000");
  const bad: unknown[] = [
    { ...pr, x402Version: 3 },
    { ...pr, accepts: [] },
    { ...pr, accepts: [{ ...pr.accepts[0], amount: "" }] },
    { ...pr, accepts: [{ ...pr.accepts[0], maxTimeoutSeconds: undefined }] },
    { ...pr, accepts: [{ ...pr.accepts[0], network: "algorand" }] },
    { ...pr, resource: undefined },
    [pr],
    "x402Version",
  ];
  for (const b of bad) assert.equal(parsePaymentRequired(bodyOnly402(b), JSON.stringify(b)), null, JSON.stringify(b).slice(0, 80));
  assert.equal(parsePaymentRequired(bodyOnly402(pr), JSON.stringify(pr).slice(0, -1)), null, "truncated JSON");
  assert.equal(parsePaymentRequired(bodyOnly402(pr), ""), null);
});

test("parsePaymentRequired: a PAYMENT-REQUIRED header that does not decode is not replaced by the body", () => {
  const pr = paymentRequired("10000");
  assert.equal(parsePaymentRequired(bodyOnly402(pr, { "PAYMENT-REQUIRED": "%%%not-base64%%%" }), JSON.stringify(pr)), null);
});

test("body-only v2 402: readable, passes every check, REFUSE requirements_body_only, never pays, budget untouched", async () => {
  const { deps, calls } = bodyOnlyDeps(paymentRequired("10000"));
  const raw = rawLedger();
  const r = await probe("http://localhost:4031/x", cfg, guardOf(raw), deps);
  assert.equal(r.verdict, "REFUSE");
  assert.equal(r.reason, "requirements_body_only");
  assert.equal(r.price?.amountAtomic, "10000");
  assert.equal(r.price?.payTo, SELLER);
  assert.deepEqual(r.declared?.expectedKeys, ["forecast", "temperature"]);
  assert.equal(calls.paid, 0);
  assert.equal(raw.spentTodayAtomic(), 0n);
});

test("body-only v2 402 goes through the same selectAccept / cap / payTo checks first", async () => {
  assert.equal((await probe("http://localhost:4031/x", cfg, ledger(), bodyOnlyDeps(paymentRequired("500000")).deps)).reason, "price_over_cap");
  assert.equal((await probe("http://localhost:4031/x", cfg, ledger(), bodyOnlyDeps(paymentRequired("10000", { network: "eip155:8453" })).deps)).reason, "no_supported_accept");
  assert.equal((await probe("http://localhost:4031/x", cfg, ledger(), bodyOnlyDeps(paymentRequired("10000", { asset: "31566704" })).deps)).reason, "no_supported_accept");
  const own = await probe("http://localhost:4031/x", cfg, ledger(), { ...bodyOnlyDeps(paymentRequired("10000")).deps, ownAddresses: [SELLER] });
  assert.equal(own.reason, "self_dealing");
  const full = guardOf(new SpendLedger(40_000n, 5_000n));
  assert.equal((await probe("http://localhost:4031/x", cfg, full, bodyOnlyDeps(paymentRequired("10000")).deps)).reason, "daily_cap_reached");
});

test("real paying client (@x402/fetch) cannot pay a body-only v2 402: rejects before any signature", async () => {
  const seed = new Uint8Array(randomBytes(32));
  const sk = secretKeyB64FromMnemonic(mnemonicFromSeed(seed));
  const baseFetch = (async (req: Request) => {
    if (req.headers.has("PAYMENT-SIGNATURE") || req.headers.has("X-PAYMENT")) assert.fail("must not send a payment");
    return bodyOnly402(paymentRequired("10000"));
  }) as unknown as typeof fetch;
  const paidFetch = makePaidFetch(cfg, sk, baseFetch);
  const approved = paymentRequired("10000").accepts[0] as AcceptLike;
  await assert.rejects(
    () => paidFetch("http://localhost:4031/x", approved, { method: "GET" }),
    (e: Error & { signed?: boolean }) => e.signed === false && /Failed to parse payment requirements/.test(e.message),
  );
});
