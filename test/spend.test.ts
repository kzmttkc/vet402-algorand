import { test } from "node:test";
import assert from "node:assert/strict";
import { SpendLedger } from "../src/caps.js";
import { IndexedSpendGuard, usdcSentToday } from "../src/spend.js";

const ME = "PAYERADDRESS";
const ASA = "31566704";
const axfer = (sender: string, receiver: string, amount: number, asa = ASA, close = 0) => ({
  sender,
  "tx-type": "axfer",
  "asset-transfer-transaction": { "asset-id": Number(asa), amount, receiver, "close-amount": close },
});

function mockIndexer(pages: unknown[][], status = 200) {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    if (status !== 200) return new Response("err", { status });
    const next = new URL(url).searchParams.get("next");
    const i = next ? Number(next) : 0;
    return new Response(JSON.stringify({ transactions: pages[i], ...(i + 1 < pages.length ? { "next-token": String(i + 1) } : {}) }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, urls };
}

test("usdcSentToday sums only our outgoing USDC since 00:00 UTC, across pages", async () => {
  const { f, urls } = mockIndexer([
    [axfer(ME, "SELLER1", 10_000), axfer("OTHER", ME, 999_999), axfer(ME, ME, 0)],
    [axfer(ME, "SELLER2", 20_000, ASA, 5), axfer(ME, "SELLER3", 7, "10458941")],
  ]);
  const total = await usdcSentToday({ indexerUrl: "https://idx", address: ME, asaId: ASA, now: new Date("2026-09-27T15:00:00Z"), fetchImpl: f });
  assert.equal(total, 30_005n);
  assert.equal(urls.length, 2);
  const q = new URL(urls[0]).searchParams;
  assert.equal(q.get("after-time"), "2026-09-27T00:00:00Z");
  assert.equal(q.get("asset-id"), ASA);
  assert.equal(q.get("tx-type"), "axfer");
  assert.match(urls[0], /\/v2\/accounts\/PAYERADDRESS\/transactions\?/);
});

test("usdcSentToday: 404 (unknown account) is 0; 5xx and malformed bodies throw", async () => {
  assert.equal(await usdcSentToday({ indexerUrl: "https://idx", address: ME, asaId: ASA, fetchImpl: mockIndexer([], 404).f }), 0n);
  await assert.rejects(usdcSentToday({ indexerUrl: "https://idx", address: ME, asaId: ASA, fetchImpl: mockIndexer([], 503).f }));
  const bad = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(usdcSentToday({ indexerUrl: "https://idx", address: ME, asaId: ASA, fetchImpl: bad }));
});

test("guard fails closed when the indexer cannot be read", async () => {
  const g = new IndexedSpendGuard(new SpendLedger(100_000n, 3_000_000n), async () => {
    throw new Error("indexer 503");
  });
  const d = await g.reserve(10_000n);
  assert.equal(d.ok, false);
  assert.equal(!d.ok && d.reason, "cap_check_unavailable");
  const h = await g.headroom();
  assert.equal(!h.ok && h.reason, "cap_check_unavailable");
});

test("guard uses on-chain spend (fresh serverless instance, empty local ledger)", async () => {
  const g = new IndexedSpendGuard(new SpendLedger(100_000n, 3_000_000n), async () => 2_950_000n);
  const d = await g.reserve(100_000n);
  assert.equal(!d.ok && d.reason, "daily_cap_reached");
  assert.equal((await g.reserve(50_000n)).ok, true);
  const h = await g.headroom();
  assert.equal(h.ok, true);
});

test("guard uses the larger of chain and local (indexer lag after our own payment)", async () => {
  const ledger = new SpendLedger(100_000n, 150_000n);
  const g = new IndexedSpendGuard(ledger, async () => 0n); // indexer has not seen our payment yet
  assert.equal((await g.reserve(100_000n)).ok, true);
  const d = await g.reserve(100_000n);
  assert.equal(!d.ok && d.reason, "daily_cap_reached");
});

test("guard: per-call cap still refuses before touching the indexer", async () => {
  let called = 0;
  const g = new IndexedSpendGuard(new SpendLedger(100_000n, 3_000_000n), async () => {
    called++;
    return 0n;
  });
  const d = await g.reserve(100_001n);
  assert.equal(!d.ok && d.reason, "price_over_cap");
  assert.equal(called, 0);
});

test("headroom reports daily_cap_reached when the day is used up", async () => {
  const g = new IndexedSpendGuard(new SpendLedger(100_000n, 3_000_000n), async () => 3_000_000n);
  const h = await g.headroom();
  assert.equal(!h.ok && h.reason, "daily_cap_reached");
});
