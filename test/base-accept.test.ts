/**
 * BASE_ACCEPT: customers may also pay vet402 in Base USDC.
 * - off (the default): every 402 is byte-for-byte what it was before Base existed (golden from e563b4c).
 * - on: every paid route has two accepts, Algorand first, Base second, same atomic amount, BASE_PAY_TO, the tag.
 * - a Base payment goes through the same settle-first path: verify -> preflight -> settle -> pay the Algorand seller.
 * - /activity counts a Base customer only for a receipt the facilitator's signer sent with an EIP-3009 authorization.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALGORAND_TESTNET_CAIP2 } from "@x402/avm";
import { loadConfig, BASE_USDC } from "../src/config.js";
import { ActivityLedger, activityHtml, type BaseActivitySource } from "../src/activity.js";
import { AUTHORIZATION_USED_TOPIC, BaseCustomerReader, GOPLAUSIBLE_EVM_SIGNERS, TRANSFER_TOPIC } from "../src/base.js";
import { SNAP_REQUESTS, snapApp, snapshot402s } from "./x402-snapshot.js";

const BASE_PAY_TO = "0x1111111111111111111111111111111111111111";
const ON = { BASE_ACCEPT: "on", BASE_PAY_TO };
const HOST = "http://localhost:4031";

const golden = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "x402-402-off.json"), "utf8"));

test("BASE_ACCEPT off: every 402 equals the one from before Base existed (e563b4c)", async () => {
  assert.deepEqual(await snapshot402s({}), golden);
  assert.deepEqual(await snapshot402s({ BASE_ACCEPT: "off", BASE_PAY_TO }), golden);
});

test("BASE_ACCEPT is on or off; on needs a 0x BASE_PAY_TO", () => {
  assert.throws(() => loadConfig({ BASE_ACCEPT: "yes", BASE_PAY_TO }), /BASE_ACCEPT must be on or off/);
  assert.throws(() => loadConfig({ BASE_ACCEPT: "on" }), /BASE_PAY_TO/);
  assert.throws(() => loadConfig({ BASE_ACCEPT: "on", BASE_PAY_TO: "RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q" }), /BASE_PAY_TO/);
  assert.throws(() => loadConfig({ BASE_ACCEPT: "on", BASE_PAY_TO: `0x${"0".repeat(40)}` }), /BASE_PAY_TO/);
  assert.equal(loadConfig({}).base, undefined);
  const t = loadConfig(ON).base!;
  assert.equal(t.network, "eip155:84532");
  assert.equal(t.usdc, BASE_USDC.testnet.address);
  const m = loadConfig({ X402_NETWORK: "mainnet", I_UNDERSTAND_MAINNET_MOVES_REAL_FUNDS: "yes", ...ON }).base!;
  assert.equal(m.network, "eip155:8453");
  assert.equal(m.usdc, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(m.usdcName, "USD Coin");
});

test("BASE_ACCEPT on: two accepts on every paid route, Algorand unchanged first, Base second with the same amount", async () => {
  const on = await snapshot402s(ON);
  for (const [method, path] of SNAP_REQUESTS) {
    const key = `${method} ${path}`;
    const before = golden[key];
    const now = on[key];
    assert.equal(now.status, 402, key);
    const pr = now.paymentRequired as { accepts: Array<Record<string, any>>; extensions?: Record<string, unknown>; resource: unknown };
    const old = before.paymentRequired as typeof pr;
    assert.equal(pr.accepts.length, 2, key);
    assert.deepEqual(pr.accepts[0], old.accepts[0], `${key}: the Algorand accept is unchanged`);
    assert.deepEqual(pr.resource, old.resource);
    assert.deepEqual(pr.extensions, old.extensions, `${key}: the Bazaar declaration is the same object`);
    // POST /v1/buy never had a Bazaar declaration (only GET is listed); every other route declares it next to both accepts.
    if (!(method === "POST" && path.startsWith("/v1/buy"))) assert.ok(pr.extensions?.bazaar, `${key}: Bazaar declared next to both accepts`);
    const b = pr.accepts[1];
    assert.equal(b.scheme, "exact");
    assert.equal(b.network, "eip155:84532");
    assert.equal(b.asset, BASE_USDC.testnet.address);
    assert.equal(b.payTo, BASE_PAY_TO);
    assert.equal(b.amount, pr.accepts[0].amount, `${key}: same USDC amount`);
    assert.equal(b.extra.tag, "x402-global-challenge");
    assert.equal(b.extra.name, "USDC");
    assert.equal(b.extra.version, "2");
    assert.equal(b.extra.asset, undefined, "no Algorand ASA id on the Base accept");
    // Dynamic prices carry the same extra on both accepts.
    for (const k of ["auditPaying", "sellerAmount", "sellerPayTo", "buyFee"]) {
      if (k in pr.accepts[0].extra) assert.deepEqual(b.extra[k], pr.accepts[0].extra[k], `${key}: extra.${k}`);
    }
  }
  const buy = on[`GET /v1/buy?url=${encodeURIComponent(`${HOST}/honest`)}`].paymentRequired as { accepts: Array<{ amount: string }> };
  assert.equal(buy.accepts[1].amount, "15000", "seller 0.01 + fee 0.005");
});

const sig = (accepted: unknown, resource: unknown) =>
  Buffer.from(JSON.stringify({ x402Version: 2, resource, accepted, payload: { signature: "0xSIG", authorization: {} } })).toString("base64");

async function challenge(app: ReturnType<typeof snapApp>["app"], path: string, init: RequestInit = {}) {
  const res = await app.request(path, init);
  assert.equal(res.status, 402);
  return JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
}

test("Base payment on /v1/check: settled on Base first, then the Algorand seller is paid", async () => {
  const { app, trace } = snapApp(ON);
  const path = `/v1/check?url=${encodeURIComponent(`${HOST}/honest`)}`;
  const pr = await challenge(app, path);
  const res = await app.request(path, { headers: { "PAYMENT-SIGNATURE": sig(pr.accepts[1], pr.resource) } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.verdict, "ALLOW");
  assert.equal(body.customerPayment.network, "eip155:84532");
  assert.equal(body.customerPayment.payTo, BASE_PAY_TO);
  assert.equal(body.customerPayment.amount, "50000");
  assert.equal(body.downstreamPayment.network, ALGORAND_TESTNET_CAIP2);
  const iSettle = trace.findIndex((t) => t.startsWith("settle eip155:84532 50000 " + BASE_PAY_TO));
  assert.ok(iSettle >= 0, trace.join(" | "));
  assert.ok(trace.findIndex((t) => t.startsWith("verify eip155:84532")) < iSettle);
  assert.ok(trace.indexOf("pay /honest") > iSettle, "seller paid only after the Base settlement");
});

test("Base payment that does not settle: the seller is never paid", async () => {
  const { app, trace } = snapApp(ON, [], false);
  const path = `/v1/check?url=${encodeURIComponent(`${HOST}/honest`)}`;
  const pr = await challenge(app, path);
  const res = await app.request(path, { headers: { "PAYMENT-SIGNATURE": sig(pr.accepts[1], pr.resource) } });
  assert.equal(res.status, 402);
  assert.ok(!trace.some((t) => t.startsWith("pay ")), trace.join(" | "));
});

test("Base payment: a changed amount or payTo matches no requirement and never settles", async () => {
  const { app, trace } = snapApp(ON);
  const path = `/v1/check?url=${encodeURIComponent(`${HOST}/honest`)}`;
  const pr = await challenge(app, path);
  for (const tampered of [{ ...pr.accepts[1], amount: "1" }, { ...pr.accepts[1], payTo: "0x2222222222222222222222222222222222222222" }]) {
    const res = await app.request(path, { headers: { "PAYMENT-SIGNATURE": sig(tampered, pr.resource) } });
    assert.equal(res.status, 402);
  }
  assert.ok(!trace.some((t) => t.startsWith("verify") || t.startsWith("settle")), trace.join(" | "));
});

test("Base payment on a shifted path (/v1/check/, /V1/check) is refused before settlement", async () => {
  const { app, trace } = snapApp(ON);
  const pr = await challenge(app, `/v1/check?url=${encodeURIComponent(`${HOST}/honest`)}`);
  for (const p of ["/v1/check/", "/V1/check"]) {
    const res = await app.request(`${p}?url=${encodeURIComponent(`${HOST}/honest`)}`, { headers: { "PAYMENT-SIGNATURE": sig(pr.accepts[1], pr.resource) } });
    assert.notEqual(res.status, 200, p);
  }
  assert.ok(!trace.some((t) => t.startsWith("settle")), trace.join(" | "));
});

test("HEAD is priced like GET on Base too: an unpaid HEAD is a 402 with both accepts", async () => {
  const { app, trace } = snapApp(ON);
  const pr = await challenge(app, `/v1/check?url=${encodeURIComponent(`${HOST}/honest`)}`, { method: "HEAD" });
  assert.equal(pr.accepts.length, 2);
  assert.ok(!trace.some((t) => t.startsWith("look") || t.startsWith("pay")));
});

test("Base payment on /v1/buy: the Base amount is seller price + fee, the daily cap is reserved before settlement, the seller is paid after", async () => {
  const { app, trace } = snapApp(ON);
  const path = `/v1/buy?url=${encodeURIComponent(`${HOST}/honest`)}`;
  const pr = await challenge(app, path);
  const res = await app.request(path, { headers: { "PAYMENT-SIGNATURE": sig(pr.accepts[1], pr.resource) } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get("x-vet402-customer-tx"), "CUSTOMER_TX_eip155:84532");
  assert.equal(res.headers.get("x-vet402-seller-tx"), "SELLER_TX");
  const iSettle = trace.findIndex((t) => t === `settle eip155:84532 15000 ${BASE_PAY_TO}`);
  assert.ok(iSettle >= 0, trace.join(" | "));
  assert.ok(trace.indexOf("pay /honest") > iSettle);
});

test("Base payment on /v1/buy over the per-call cap is refused before settlement (caps are chain-blind)", async () => {
  const { app, trace } = snapApp({ ...ON, PROBE_MAX_PER_CALL_USDC: "0.005" });
  const res = await app.request(`/v1/buy?url=${encodeURIComponent(`${HOST}/honest`)}`);
  assert.equal(res.status, 422, "refused before any 402: nothing to sign on either chain");
  assert.ok(!trace.some((t) => t.startsWith("settle")));
});

test("Base payment on /v1/audit carries the planned count; vet402 pays at most that many sellers after settlement", async () => {
  const { app, trace } = snapApp(ON);
  const path = `/v1/audit?seller=${encodeURIComponent("localhost:4031")}`;
  const pr = await challenge(app, path);
  assert.equal(pr.accepts[1].extra.auditPaying, 1);
  assert.equal(pr.accepts[1].amount, "500000");
  const res = await app.request(path, { headers: { "PAYMENT-SIGNATURE": sig(pr.accepts[1], pr.resource) } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.customerPayment.network, "eip155:84532");
  assert.equal(trace.filter((t) => t.startsWith("pay ")).length, 1);
});

test("Base payment on /v1/verdict settles on Base and pays no seller", async () => {
  const { app, trace } = snapApp(ON);
  const path = SNAP_REQUESTS.find(([, p]) => p.startsWith("/v1/verdict"))![1];
  const pr = await challenge(app, path);
  assert.equal(pr.accepts[1].amount, "1000");
  const res = await app.request(path, { headers: { "PAYMENT-SIGNATURE": sig(pr.accepts[1], pr.resource) } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).customerPayment.payTo, BASE_PAY_TO);
  assert.ok(!trace.some((t) => t.startsWith("pay ")));
});

// ---- /activity: Base customers --------------------------------------------------------------

const USDC = BASE_USDC.testnet.address;
const SIGNER = GOPLAUSIBLE_EVM_SIGNERS[0];
const CAROL = "0xca11d50b661310a915b34ff17b7e9e9f74c1388b";
const pad = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const T0 = 1790479000;

interface FakeTx {
  hash: string;
  from: string;
  to: string;
  payer: string;
  amount: bigint;
  auth: boolean;
  block: number;
  time: number;
  status?: string;
}

function baseChain(txs: FakeTx[]) {
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/token-transfers")) {
      assert.equal(u.searchParams.get("filter"), "to");
      assert.equal(u.searchParams.get("token"), USDC);
      return Response.json({
        items: txs.map((t) => ({
          transaction_hash: t.hash,
          block_number: t.block,
          log_index: 3,
          timestamp: new Date(t.time * 1000).toISOString(),
          from: { hash: t.payer },
          to: { hash: BASE_PAY_TO },
          total: { value: t.amount.toString() },
        })),
        next_page_params: null,
      });
    }
    const req = JSON.parse(String(init?.body));
    assert.equal(req.method, "eth_getTransactionReceipt");
    const t = txs.find((x) => x.hash === req.params[0])!;
    const logs = [
      ...(t.auth ? [{ address: USDC, topics: [AUTHORIZATION_USED_TOPIC, pad(t.payer), word(7n)], data: "0x", logIndex: "0x2" }] : []),
      { address: USDC, topics: [TRANSFER_TOPIC, pad(t.payer), pad(BASE_PAY_TO)], data: word(t.amount), logIndex: "0x3" },
    ];
    return Response.json({ jsonrpc: "2.0", id: 1, result: { status: t.status ?? "0x1", from: t.from, to: t.to, logs } });
  }) as unknown as typeof fetch;
  return f;
}

test("Base reader: only a receipt sent by the facilitator's signer with an EIP-3009 authorization is a customer", async () => {
  const cfg = loadConfig(ON);
  const reader = new BaseCustomerReader(cfg.base!, {
    fetchImpl: baseChain([
      { hash: "0xaaa", from: SIGNER, to: USDC, payer: CAROL, amount: 50000n, auth: true, block: 10, time: T0 },
      { hash: "0xbbb", from: CAROL, to: USDC, payer: CAROL, amount: 50000n, auth: false, block: 11, time: T0 + 5 }, // a plain transfer
      { hash: "0xccc", from: SIGNER, to: USDC, payer: CAROL, amount: 50000n, auth: false, block: 12, time: T0 + 9 }, // no authorization
      { hash: "0xddd", from: SIGNER, to: USDC, payer: CAROL, amount: 50000n, auth: true, block: 13, time: T0 + 12, status: "0x0" }, // reverted
    ]),
  });
  const r = await reader.read();
  assert.deepEqual(r.payments.map((p) => [p.tx, p.customer, p.amount]), [["0xaaa", CAROL, 50000n]]);
  assert.deepEqual(r.notCounted.map((n) => [n.tx, n.reason]), [
    ["0xbbb", "not_sent_by_x402_facilitator"],
    ["0xccc", "no_eip3009_authorization"],
    ["0xddd", "failed_or_unreadable"],
  ]);
});

const ALGO_PAYTO = "RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q";
const ALGO_PAYER = "OZ3KMLALTO67BZLYLCZOT7IJBGN7JTO5A3MJHI2267EKQDASFKS52KU6VY";
const SELLER1 = "K5HIZPOUUUBQ5WJ6I3DT6NGIQUMALYJYSVVBY7CXA3BYBWY6225DNNBDSA";

/** Algorand indexer with one seller payment by the payer at `time`, nothing received on Algorand. */
function algoIndexer(sellerPayTime: number) {
  return (async (url: string) => {
    const u = new URL(url);
    const m = u.pathname.match(/^\/v2\/accounts\/([A-Z2-7]+)\/transactions$/);
    if (m && m[1] === ALGO_PAYER) {
      return Response.json({
        transactions: [
          {
            id: "SELLERTX1",
            sender: ALGO_PAYER,
            "tx-type": "axfer",
            fee: 0,
            group: "GS",
            "confirmed-round": 200,
            "round-time": sellerPayTime,
            "intra-round-offset": 1,
            "asset-transfer-transaction": { "asset-id": 10458941, amount: 10000, receiver: SELLER1, "close-amount": 0 },
          },
        ],
      });
    }
    if (m) return Response.json({ transactions: [] });
    return new Response("?", { status: 400 });
  }) as unknown as typeof fetch;
}

function baseSource(reader: { read: BaseActivitySource["read"] }): BaseActivitySource {
  return { network: "eip155:84532", payTo: BASE_PAY_TO, usdc: USDC, explorerUrl: "https://sepolia.basescan.org", signers: GOPLAUSIBLE_EVM_SIGNERS, read: () => reader.read() };
}

const ledger = (base: BaseActivitySource | undefined, sellerPayTime: number) =>
  new ActivityLedger({
    networkName: "testnet",
    indexerUrl: "https://idx.example",
    asaId: "10458941",
    payTo: ALGO_PAYTO,
    payer: ALGO_PAYER,
    priceAtomic: 50000n,
    buyFeeAtomic: 5000n,
    verdictPriceAtomic: 1000n,
    auditPriceAtomic: 500000n,
    fetchImpl: algoIndexer(sellerPayTime),
    ...(base ? { base } : {}),
  });

test("/activity: a Base customer counts and pairs with the Algorand seller payment made after it", async () => {
  const cfg = loadConfig(ON);
  const reader = new BaseCustomerReader(cfg.base!, { fetchImpl: baseChain([{ hash: "0xaaa", from: SIGNER, to: USDC, payer: CAROL, amount: 50000n, auth: true, block: 10, time: T0 }]) });
  const r = await ledger(baseSource(reader), T0 + 4).get();
  assert.equal(r.totals.customers.payments, 1);
  assert.equal(r.totals.customers.addresses, 1);
  assert.equal(r.totals.sellerPayments.payments, 1);
  assert.equal(r.totals.sellerPayments.unmatched, 0);
  assert.equal(r.rows[0].network, "eip155:84532");
  assert.equal(r.rows[0].customerTx, "0xaaa");
  assert.equal(r.rows[0].sellerTx, "SELLERTX1");
  assert.equal(r.base?.status, "counted");
  assert.equal(r.base?.status === "counted" && r.base.customers.payments, 1);
  const html = activityHtml(r);
  assert.match(html, /paid on Base/);
  assert.match(html, /sepolia\.basescan\.org\/tx\/0xaaa/);
});

test("/activity: a seller payment before the Base customer's payment does not pair with it", async () => {
  const cfg = loadConfig(ON);
  const reader = new BaseCustomerReader(cfg.base!, { fetchImpl: baseChain([{ hash: "0xaaa", from: SIGNER, to: USDC, payer: CAROL, amount: 50000n, auth: true, block: 10, time: T0 }]) });
  const r = await ledger(baseSource(reader), T0 - 10).get();
  assert.equal(r.totals.sellerPayments.unmatched, 1);
  assert.equal(r.rows[0].sellerTx, null);
});

test("/activity: Base unreadable -> Algorand still served and Base is stated as not counted", async () => {
  const r = await ledger(baseSource({ read: async () => { throw new Error("base explorer 503"); } }), T0).get();
  assert.equal(r.base?.status, "not_counted");
  assert.equal(r.totals.customers.payments, 0);
  assert.ok(r.method.some((m) => m.includes("NOT counted")));
  assert.match(activityHtml(r), /Base payments: not counted/);
});

test("/activity: BASE_ACCEPT off -> the report has no base field", async () => {
  const r = await ledger(undefined, T0).get();
  assert.equal("base" in r, false);
  assert.equal(r.method.some((m) => m.includes("Base")), false);
});
