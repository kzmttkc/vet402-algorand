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
  // 2.95 on-chain + the 0.05 just reserved (not yet on-chain) = 3.00 = cap: no room left.
  // (Before the 2026-09-27 race fix this said ok: the ledger held only 0.05 and the reservation was lost.)
  const h = await g.headroom();
  assert.equal(!h.ok && h.reason, "daily_cap_reached");
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

// Race regression (review 2026-09-27): the daily cap must hold when the chain total is
// larger than the local ledger (fresh instance / fresh CI runner) and reserves run concurrently.
test("IndexedSpendGuard: 3 concurrent reserves on a slow indexer never exceed the daily cap", async () => {
  const cap = 60_000_000n;
  const per = 100_000n;
  const chain = 59_900_000n; // earlier run today already sent 59.9 USDC; this ledger is fresh
  const guard = new IndexedSpendGuard(new SpendLedger(per, cap), async () => {
    await new Promise((r) => setTimeout(r, 20));
    return chain;
  });
  const res = await Promise.all([1, 2, 3].map(() => guard.reserve(per)));
  const ok = res.filter((r) => r.ok).length;
  assert.equal(ok, 1);
  assert.ok(chain + BigInt(ok) * per <= cap);
  assert.deepEqual(
    res.filter((r) => !r.ok).map((r) => (r as { reason: string }).reason),
    ["daily_cap_reached", "daily_cap_reached"],
  );
});

test("IndexedSpendGuard: a payment the indexer has not shown yet still counts", async () => {
  const cap = 60_000_000n;
  const per = 100_000n;
  const guard = new IndexedSpendGuard(new SpendLedger(per, cap), async () => 59_900_000n); // indexer lags
  const a = await guard.reserve(per);
  assert.ok(a.ok);
  guard.commit((a as { reservationId: string }).reservationId);
  const b = await guard.reserve(per);
  assert.equal(b.ok, false);
  assert.equal((b as { reason: string }).reason, "daily_cap_reached");
});

test("IndexedSpendGuard: once the indexer catches up, the same payment is not counted twice", async () => {
  let chain = 1_000_000n;
  const guard = new IndexedSpendGuard(new SpendLedger(1_000_000n, 3_000_000n), async () => chain);
  const a = await guard.reserve(1_000_000n); // ledger: max(0, 1.0) + 1.0 = 2.0
  assert.ok(a.ok);
  guard.commit((a as { reservationId: string }).reservationId);
  chain = 2_000_000n; // the indexer now includes that payment
  const b = await guard.reserve(1_000_000n); // max(2.0, 2.0) + 1.0 = 3.0 <= 3.0
  assert.ok(b.ok);
  const c = await guard.reserve(1n);
  assert.equal(c.ok, false);
});

test("SpendLedger.raiseFloor only raises, and a released reservation returns to the floor", () => {
  const l = new SpendLedger(100n, 1_000n);
  l.raiseFloor(500n);
  l.raiseFloor(200n);
  assert.equal(l.spentTodayAtomic(), 500n);
  const r = l.reserveAtLeast(100n, 0n);
  assert.ok(r.ok);
  l.release((r as { reservationId: string }).reservationId);
  assert.equal(l.spentTodayAtomic(), 500n);
});
