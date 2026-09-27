import { test } from "node:test";
import assert from "node:assert/strict";
import { ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2, USDC_MAINNET_ASA_ID, USDC_TESTNET_ASA_ID } from "@x402/avm";
import type { SchemeNetworkClient } from "@x402/core/types";
import { checkBeforeBuy, checkUrl, CheckError } from "../src/check-client.js";

const VET402 = "https://vet402.test";
const TARGET = "https://seller.example/v1/data?city=tokyo";
const PAY_TO = "VET402PAYTOVET402PAYTOVET402PAYTOVET402PAYTOVET402PAYTOXXXX";

function paymentRequired(opts: { amount?: string; network?: string; asset?: string } = {}) {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: { url: checkUrl(VET402, TARGET), description: "vet402 check", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: opts.network ?? ALGORAND_MAINNET_CAIP2,
        asset: opts.asset ?? String(USDC_MAINNET_ASA_ID),
        amount: opts.amount ?? "50000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
  };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

const ANSWER = {
  verdict: "ALLOW",
  reason: "delivered",
  target: TARGET,
  customerPayment: { transaction: "TX_CUSTOMER", network: ALGORAND_MAINNET_CAIP2, amount: "50000", payTo: PAY_TO },
  downstreamPayment: { success: true, transaction: "TX_SELLER", network: ALGORAND_MAINNET_CAIP2 },
  delivery: { status: 200, contentType: "application/json", bytes: 20, summary: "object{a:number=1}", missingKeys: [] },
};

function fake(opts: { pr?: unknown; paidStatus?: number; paidBody?: unknown; paidHeaders?: Record<string, string>; unpaid?: Response } = {}) {
  const calls = { urls: [] as string[], signed: [] as Array<string | null>, payloads: 0, amounts: [] as string[] };
  const scheme: SchemeNetworkClient = {
    scheme: "exact",
    createPaymentPayload: async (x402Version, req) => {
      calls.payloads += 1;
      calls.amounts.push(String(req.amount));
      return { x402Version, payload: { paymentGroup: ["FAKE"], paymentIndex: 0 } };
    },
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.urls.push(req.url);
    const sig = req.headers.get("PAYMENT-SIGNATURE");
    calls.signed.push(sig);
    if (!sig) {
      return (
        opts.unpaid ??
        new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64(opts.pr ?? paymentRequired()), "content-type": "application/json" } })
      );
    }
    return new Response(JSON.stringify(opts.paidBody ?? ANSWER), {
      status: opts.paidStatus ?? 200,
      headers: { "content-type": "application/json", ...(opts.paidHeaders ?? {}) },
    });
  }) as typeof fetch;
  return { scheme, fetchImpl, calls };
}

test("pays vet402 once and returns the verdict with both tx ids", async () => {
  const f = fake();
  const r = await checkBeforeBuy(TARGET, { scheme: f.scheme, fetchImpl: f.fetchImpl, vet402Url: `${VET402}/` });
  assert.equal(r.httpStatus, 200);
  assert.equal(r.verdict, "ALLOW");
  assert.equal(r.reason, "delivered");
  assert.equal(r.customerPayment?.transaction, "TX_CUSTOMER");
  assert.equal(r.downstreamPayment?.transaction, "TX_SELLER");
  assert.equal(f.calls.payloads, 1);
  assert.deepEqual(f.calls.amounts, ["50000"]);
  assert.equal(f.calls.urls.length, 2);
  assert.equal(f.calls.urls[0], `${VET402}/v1/check?url=${encodeURIComponent(TARGET)}`);
  assert.equal(f.calls.signed[0], null);
  assert.ok(f.calls.signed[1]);
});

test("price above maxPriceUsdc: no payment is created", async () => {
  const f = fake({ pr: paymentRequired({ amount: "50001" }) });
  await assert.rejects(
    checkBeforeBuy(TARGET, { scheme: f.scheme, fetchImpl: f.fetchImpl, vet402Url: VET402 }),
    (e: unknown) => e instanceof CheckError && e.paid === false,
  );
  assert.equal(f.calls.payloads, 0);
  assert.equal(f.calls.urls.length, 1);
});

test("maxPriceUsdc can be raised explicitly", async () => {
  const f = fake({ pr: paymentRequired({ amount: "100000" }) });
  const r = await checkBeforeBuy(TARGET, { scheme: f.scheme, fetchImpl: f.fetchImpl, vet402Url: VET402, maxPriceUsdc: "0.10" });
  assert.equal(r.verdict, "ALLOW");
  assert.equal(f.calls.payloads, 1);
});

test("wrong asset or other network: no payment is created", async () => {
  for (const pr of [paymentRequired({ asset: "12345" }), paymentRequired({ network: ALGORAND_TESTNET_CAIP2, asset: String(USDC_TESTNET_ASA_ID) })]) {
    const f = fake({ pr });
    await assert.rejects(checkBeforeBuy(TARGET, { scheme: f.scheme, fetchImpl: f.fetchImpl, vet402Url: VET402 }), CheckError);
    assert.equal(f.calls.payloads, 0);
  }
});

test("testnet: pays the TestNet USDC accept (truncated CAIP-2 form also matches)", async () => {
  const truncated = `algorand:${ALGORAND_TESTNET_CAIP2.slice("algorand:".length, "algorand:".length + 32)}`;
  const f = fake({ pr: paymentRequired({ network: truncated, asset: String(USDC_TESTNET_ASA_ID) }) });
  const r = await checkBeforeBuy(TARGET, { scheme: f.scheme, fetchImpl: f.fetchImpl, vet402Url: VET402, network: "testnet" });
  assert.equal(r.verdict, "ALLOW");
  assert.equal(f.calls.payloads, 1);
});

test("refused before charging (400 invalid_target): verdict returned, nothing signed", async () => {
  const unpaid = new Response(JSON.stringify({ verdict: "REFUSE", reason: "invalid_target", target: "http://10.0.0.1/x", detail: "private" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
  const f = fake({ unpaid });
  const r = await checkBeforeBuy("http://10.0.0.1/x", { scheme: f.scheme, fetchImpl: f.fetchImpl, vet402Url: VET402 });
  assert.equal(r.httpStatus, 400);
  assert.equal(r.verdict, "REFUSE");
  assert.equal(r.reason, "invalid_target");
  assert.equal(f.calls.payloads, 0);
});

test("payment not accepted by vet402 (402 after signing): CheckError with paid=true", async () => {
  const f = fake({ paidStatus: 402, paidBody: {}, paidHeaders: { "PAYMENT-REQUIRED": b64({ ...paymentRequired(), error: "insufficient_funds" }) } });
  await assert.rejects(
    checkBeforeBuy(TARGET, { scheme: f.scheme, fetchImpl: f.fetchImpl, vet402Url: VET402 }),
    (e: unknown) => e instanceof CheckError && e.httpStatus === 402 && e.paid === true && /insufficient_funds/.test(e.message),
  );
  assert.equal(f.calls.payloads, 1);
});

test("customer tx id falls back to the PAYMENT-RESPONSE header", async () => {
  const { customerPayment: _omit, ...noCustomer } = ANSWER;
  const settle = { success: true, transaction: "TX_FROM_HEADER", network: ALGORAND_MAINNET_CAIP2, payer: "PAYER" };
  const f = fake({ paidBody: noCustomer, paidHeaders: { "PAYMENT-RESPONSE": b64(settle) } });
  const r = await checkBeforeBuy(TARGET, { scheme: f.scheme, fetchImpl: f.fetchImpl, vet402Url: VET402 });
  assert.equal(r.customerPayment?.transaction, "TX_FROM_HEADER");
});

test("no key: CheckError and no request is sent", async () => {
  let called = 0;
  const fetchImpl = (async () => {
    called += 1;
    return new Response("{}");
  }) as typeof fetch;
  await assert.rejects(checkBeforeBuy(TARGET, { fetchImpl, vet402Url: VET402 }), /mnemonic or secretKey/);
  assert.equal(called, 0);
});

test("invalid maxPriceUsdc is rejected before any request", async () => {
  const f = fake();
  await assert.rejects(checkBeforeBuy(TARGET, { scheme: f.scheme, fetchImpl: f.fetchImpl, maxPriceUsdc: "abc" }), /invalid USDC amount/);
  assert.equal(f.calls.urls.length, 0);
});

// ---- buyThrough (/v1/buy) ------------------------------------------------------------------------

import { buyThrough, buyUrl } from "../src/check-client.js";

function buyFake(
  opts: {
    total?: string;
    unpaidStatus?: number;
    unpaidBody?: unknown;
    paidStatus?: number;
    paidBody?: Uint8Array<ArrayBuffer> | string | ReadableStream<Uint8Array>;
    paidHeaders?: Record<string, string>;
    priceAtPayment?: string;
    payTo?: string;
    payToAtPayment?: string;
    sellerPayTo?: string;
    quoteSellerPayTo?: string;
  } = {},
) {
  const calls = { requests: [] as { url: string; method: string; body: string; signed: boolean; redirect: string }[], payloads: 0, amounts: [] as string[] };
  const total = opts.total ?? "15000";
  const pr = (amount: string, payTo: string) => ({
    x402Version: 2,
    resource: { url: buyUrl(VET402, TARGET), description: "vet402 buy", mimeType: "application/octet-stream" },
    accepts: [{ scheme: "exact", network: ALGORAND_MAINNET_CAIP2, asset: String(USDC_MAINNET_ASA_ID), amount, payTo, maxTimeoutSeconds: 60, extra: { sellerAmount: "10000", sellerPayTo: opts.sellerPayTo ?? "SELLERADDR", buyFee: "5000" } }],
  });
  const scheme: SchemeNetworkClient = {
    scheme: "exact",
    createPaymentPayload: async (x402Version, req) => {
      calls.payloads += 1;
      calls.amounts.push(String(req.amount));
      return { x402Version, payload: { paymentGroup: ["FAKE"], paymentIndex: 0 } };
    },
  };
  let unpaidSeen = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const sig = req.headers.get("PAYMENT-SIGNATURE");
    calls.requests.push({ url: req.url, method: req.method, body: await req.clone().text(), signed: !!sig, redirect: req.redirect });
    if (!sig) {
      unpaidSeen++;
      if (opts.unpaidStatus && opts.unpaidStatus !== 402) return Response.json(opts.unpaidBody ?? {}, { status: opts.unpaidStatus });
      const later = unpaidSeen > 1;
      const amount = later && opts.priceAtPayment ? opts.priceAtPayment : total;
      const payTo = later && opts.payToAtPayment ? opts.payToAtPayment : (opts.payTo ?? PAY_TO);
      const body = { buy: { total: { amountAtomic: amount, usdc: `0.${amount.padStart(6, "0")}` }, sellerPrice: { usdc: "0.010000", ...(opts.quoteSellerPayTo ? { payTo: opts.quoteSellerPayTo } : {}) }, fee: { usdc: "0.005000" }, refund: "none" } };
      return new Response(JSON.stringify(body), { status: 402, headers: { "PAYMENT-REQUIRED": b64(pr(amount, payTo)), "content-type": "application/json" } });
    }
    const b = opts.paidBody ?? '{ "forecast":"sunny" }\n';
    return new Response(b, {
      status: opts.paidStatus ?? 200,
      headers: {
        "content-type": "application/json",
        "x-vet402-verdict": "ALLOW",
        "x-vet402-reason": "delivered",
        "x-vet402-customer-tx": "TX_CUSTOMER",
        "x-vet402-seller-tx": "TX_SELLER",
        "x-vet402-seller-status": "200",
        ...(opts.paidHeaders ?? {}),
      },
    });
  }) as typeof fetch;
  return { scheme, fetchImpl, calls };
}

test("buyThrough: free price first, pays exactly the quoted total once, returns the body and both tx ids", async () => {
  const f = buyFake();
  const r = await buyThrough(TARGET, { scheme: f.scheme, fetchImpl: f.fetchImpl, vet402Url: VET402 });
  assert.equal(r.paid, true);
  assert.equal(r.httpStatus, 200);
  assert.equal(r.body, '{ "forecast":"sunny" }\n');
  assert.equal(r.bodyEncoding, "utf8");
  assert.deepEqual([r.verdict, r.reason, r.customerTx, r.sellerTx], ["ALLOW", "delivered", "TX_CUSTOMER", "TX_SELLER"]);
  assert.equal(r.quote?.total?.amountAtomic, "15000");
  assert.equal(f.calls.payloads, 1);
  assert.deepEqual(f.calls.amounts, ["15000"]);
  assert.equal(f.calls.requests[0].signed, false, "the first request is the free price read");
  assert.equal(f.calls.requests[0].url, `${VET402}/v1/buy?url=${encodeURIComponent(TARGET)}`);
});

test("buyThrough: a total above maxPriceUsdc (default 0.10) is not paid; the price is returned", async () => {
  const f = buyFake({ total: "105000" });
  const r = await buyThrough(TARGET, { scheme: f.scheme, fetchImpl: f.fetchImpl, vet402Url: VET402 });
  assert.equal(r.paid, false);
  assert.equal(r.refusal?.reason, "price_above_max");
  assert.equal(r.quote?.total?.amountAtomic, "105000");
  assert.equal(f.calls.payloads, 0);
  assert.equal(f.calls.requests.length, 1);
  const raised = buyFake({ total: "105000" });
  assert.equal((await buyThrough(TARGET, { scheme: raised.scheme, fetchImpl: raised.fetchImpl, vet402Url: VET402, maxPriceUsdc: "0.2" })).paid, true);
});

test("buyThrough: vet402's free refusal is returned unpaid", async () => {
  const f = buyFake({ unpaidStatus: 422, unpaidBody: { verdict: "REFUSE", reason: "price_over_cap", detail: "seller price 0.5", charged: false } });
  const r = await buyThrough(TARGET, { scheme: f.scheme, fetchImpl: f.fetchImpl, vet402Url: VET402 });
  assert.deepEqual([r.paid, r.httpStatus, r.refusal?.reason], [false, 422, "price_over_cap"]);
  assert.equal(f.calls.payloads, 0);
});

test("buyThrough: a price raised between the free read and the payment is not signed", async () => {
  const f = buyFake({ total: "15000", priceAtPayment: "16000" });
  await assert.rejects(buyThrough(TARGET, { scheme: f.scheme, fetchImpl: f.fetchImpl, vet402Url: VET402 }), CheckError);
  assert.equal(f.calls.payloads, 0);
});

test("buyThrough: POST sends the JSON body; binary bodies come back as base64", async () => {
  const bin = new Uint8Array([0, 255, 1, 2]);
  const f = buyFake({ paidBody: bin, paidHeaders: { "content-type": "application/octet-stream" } });
  const r = await buyThrough(TARGET, { scheme: f.scheme, fetchImpl: f.fetchImpl, vet402Url: VET402, method: "POST", body: { city: "Tokyo" } });
  assert.deepEqual(f.calls.requests.map((q) => [q.method, q.body]), [["POST", '{"city":"Tokyo"}'], ["POST", '{"city":"Tokyo"}'], ["POST", '{"city":"Tokyo"}']]);
  assert.equal(r.bodyEncoding, "base64");
  assert.deepEqual(Buffer.from(r.body!, "base64"), Buffer.from(bin));
});

import { VET402_MAINNET_PAY_TO, VET402_DEFAULT_URL } from "../src/check-client.js";
import { MAINNET_DEFAULT_PAY_TO } from "../src/config.js";

const OTHER = "ATTACKERATTACKERATTACKERATTACKERATTACKERATTACKERATTACKERAAA";

test("buyThrough: vet402's payTo changed between the free read and the payment: nothing is signed", async () => {
  const f = buyFake({ payToAtPayment: OTHER });
  const e = await buyThrough(TARGET, { scheme: f.scheme, fetchImpl: f.fetchImpl, vet402Url: VET402 }).catch((x) => x);
  assert.ok(e instanceof CheckError);
  assert.equal(e.paid, false);
  assert.equal(f.calls.payloads, 0);
});

test("buyThrough: a 402 asking to be paid at the seller's address (extra.sellerPayTo or buy.sellerPrice.payTo) is never signed", async () => {
  for (const f of [buyFake({ payTo: OTHER, sellerPayTo: OTHER }), buyFake({ payTo: OTHER, quoteSellerPayTo: OTHER })]) {
    const e = await buyThrough(TARGET, { scheme: f.scheme, fetchImpl: f.fetchImpl, vet402Url: VET402 }).catch((x) => x);
    assert.ok(e instanceof CheckError);
    assert.match(e.message, /seller's address/);
    assert.equal(f.calls.payloads, 0);
    assert.equal(f.calls.requests.length, 1, "only the free read");
  }
});

test("default vet402 URL on MainNet: only vet402's own address is paid (buyThrough and checkBeforeBuy)", async () => {
  assert.equal(VET402_MAINNET_PAY_TO, MAINNET_DEFAULT_PAY_TO);
  const wrong = buyFake({ payTo: OTHER });
  const e = await buyThrough(TARGET, { scheme: wrong.scheme, fetchImpl: wrong.fetchImpl }).catch((x) => x);
  assert.ok(e instanceof CheckError);
  assert.equal(wrong.calls.payloads, 0);
  assert.ok(wrong.calls.requests[0].url.startsWith(`${VET402_DEFAULT_URL}/v1/buy?`));
  const right = buyFake({ payTo: VET402_MAINNET_PAY_TO });
  assert.equal((await buyThrough(TARGET, { scheme: right.scheme, fetchImpl: right.fetchImpl })).paid, true);
  assert.equal(right.calls.payloads, 1);

  const checkWrong = fake({ pr: { ...paymentRequired(), accepts: [{ ...paymentRequired().accepts[0], payTo: OTHER }] } });
  await assert.rejects(checkBeforeBuy(TARGET, { scheme: checkWrong.scheme, fetchImpl: checkWrong.fetchImpl }), CheckError);
  assert.equal(checkWrong.calls.payloads, 0);
  const checkRight = fake({ pr: { ...paymentRequired(), accepts: [{ ...paymentRequired().accepts[0], payTo: VET402_MAINNET_PAY_TO }] } });
  assert.equal((await checkBeforeBuy(TARGET, { scheme: checkRight.scheme, fetchImpl: checkRight.fetchImpl })).verdict, "ALLOW");
  assert.equal(checkRight.calls.payloads, 1);
});

test("buyThrough: every request refuses redirects", async () => {
  const f = buyFake();
  await buyThrough(TARGET, { scheme: f.scheme, fetchImpl: f.fetchImpl, vet402Url: VET402 });
  assert.ok(f.calls.requests.length >= 2);
  for (const r of f.calls.requests) assert.equal(r.redirect, "error");
});

test("buyThrough: after the payment, an unreadable or oversized answer says a payment was signed", async () => {
  const broken = new ReadableStream<Uint8Array>({
    start(ctl) {
      ctl.enqueue(new TextEncoder().encode("{"));
      ctl.error(new Error("connection reset"));
    },
  });
  const f = buyFake({ paidBody: broken });
  const e = await buyThrough(TARGET, { scheme: f.scheme, fetchImpl: f.fetchImpl, vet402Url: VET402 }).catch((x) => x);
  assert.ok(e instanceof CheckError);
  assert.equal(e.paid, true);
  assert.match(e.message, /could not be read/);
  const big = buyFake({ paidBody: new Uint8Array(1_200_000) });
  const e2 = await buyThrough(TARGET, { scheme: big.scheme, fetchImpl: big.fetchImpl, vet402Url: VET402 }).catch((x) => x);
  assert.ok(e2 instanceof CheckError);
  assert.equal(e2.paid, true);
});
