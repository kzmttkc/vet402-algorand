/**
 * /fairness: payments to other challenge teams. Offline: the leaderboard and the indexer are faked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2 } from "@x402/avm";
import {
  FAIRNESS_TTL_MS,
  FairnessLedger,
  boardReason,
  fairnessHtml,
  headline,
  registerFairness,
  runInfoOf,
  type BoardRunInfo,
  type FairnessOptions,
} from "../src/fairness.js";
import { boardHtml } from "../src/board.js";
import { topNav } from "../src/landing.js";

const ASA = "31566704";
const IDX = "https://idx.test";
const API = "https://lb.test/data/leaderboards";
const addr = (c: string) => c.repeat(58);
/** A distinct 52-char tx id per (c, n). */
const txid = (c: string, n: number) => {
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let s = "";
  for (let v = n; s.length < 8; v = Math.floor(v / 32)) s = B32[v % 32] + s;
  return (c + "Q".repeat(43) + s).slice(0, 52);
};

const PAYTO = addr("R");
const BOARD = addr("B");
const PAYER = addr("P");
const TRIAL = addr("T");
const ALICE = addr("A"); // participant, primary address
const ALICE2 = addr("C"); // participant, second MainNet account
const ALICE_TEST = addr("D"); // participant, TestNet account (not counted)
const BOB = addr("E"); // participant
const OUTSIDER = addr("O"); // seller not in the challenge

type Tx = Record<string, unknown>;
const axfer = (id: string, sender: string, receiver: string, amount: number, time: number, round = time): Tx => ({
  id,
  sender,
  "tx-type": "axfer",
  "confirmed-round": round,
  "round-time": time,
  "asset-transfer-transaction": { "asset-id": Number(ASA), amount, receiver },
});
const pay = (id: string, sender: string, receiver: string, time: number): Tx => ({
  id,
  sender,
  "tx-type": "pay",
  "confirmed-round": time,
  "round-time": time,
  "payment-transaction": { amount: 0, receiver },
});

const T0 = Date.parse("2026-09-27T04:30:00Z") / 1000;

function leaderboard(extra: Record<string, unknown>[] = []) {
  return [
    { rank: 1, id: "alice", label: "Alice <b>&</b> \"Co\"", sub: "alice.example", address: ALICE, volume: 100.5, challenge: true, accounts: [
      { network: { network: ALGORAND_MAINNET_CAIP2, testnet: false }, address: ALICE },
      { network: { network: ALGORAND_MAINNET_CAIP2, testnet: false }, address: ALICE2 },
      { network: { network: ALGORAND_TESTNET_CAIP2, testnet: true }, address: ALICE_TEST },
    ] },
    { rank: 2, id: "bob", label: "Bob", address: BOB, volume: 7, challenge: true },
    { rank: 3, id: "own-merchant", label: "vet402", address: PAYTO, volume: 0.15000000000000002, challenge: true },
    ...extra,
  ];
}

/** Default chain: board pays Alice twice (one to her 2nd account), Bob once; payer pays Bob; trial pays Alice
 *  and sends itself a 0-ALGO note; board pays vet402's payTo (self) and an outsider. */
function chain(): Record<string, Tx[]> {
  return {
    [BOARD]: [
      axfer(txid("A", 1), BOARD, ALICE, 10_000, T0 + 10),
      axfer(txid("A", 2), BOARD, ALICE2, 20_000, T0 + 20),
      axfer(txid("A", 3), BOARD, BOB, 5_000, T0 + 30),
      axfer(txid("A", 4), BOARD, PAYTO, 50_000, T0 + 40), // own address: not counted
      axfer(txid("A", 5), BOARD, BOARD, 0, T0 + 1), // opt-in to itself: not counted
      axfer(txid("A", 6), BOARD, OUTSIDER, 1_000, T0 + 50), // not a participant
      axfer(txid("A", 7), BOARD, ALICE_TEST, 3_000, T0 + 55), // TestNet-only address: not Alice on MainNet
      axfer(txid("A", 8), BOB, BOARD, 7_000, T0 + 60), // received from a participant: not a payment by vet402
    ],
    [PAYER]: [axfer(txid("B", 1), PAYER, BOB, 10_000, T0 + 70), axfer(txid("B", 2), PAYER, PAYTO, 50_000, T0 + 65)],
    [TRIAL]: [pay(txid("C", 1), TRIAL, TRIAL, T0 + 80), axfer(txid("C", 2), TRIAL, ALICE, 1_000, T0 + 90)],
    [PAYTO]: [axfer(txid("B", 2), PAYER, PAYTO, 50_000, T0 + 65)],
  };
}

function fakeFetch(o: { items?: Record<string, unknown>[]; txs?: Record<string, Tx[]>; indexerDown?: boolean; lbDown?: boolean; calls?: string[] } = {}): typeof fetch {
  const items = o.items ?? leaderboard();
  const txs = o.txs ?? chain();
  return (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    o.calls?.push(u.toString());
    if (u.toString().startsWith(API)) {
      if (o.lbDown) return new Response("down", { status: 502 });
      const off = Number(u.searchParams.get("offset"));
      const lim = Number(u.searchParams.get("limit"));
      return Response.json({ items: items.slice(off, off + lim), total: items.length });
    }
    if (u.origin === IDX) {
      if (o.indexerDown) return new Response("down", { status: 503 });
      const m = /^\/v2\/accounts\/([A-Z2-7]{58})\/transactions$/.exec(u.pathname);
      if (!m) return new Response("?", { status: 404 });
      assert.equal(u.searchParams.get("asset-id"), ASA);
      return Response.json({ transactions: txs[m[1]] ?? [] });
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
}

function opts(f: typeof fetch, extra: Partial<FairnessOptions> = {}): FairnessOptions {
  return {
    indexerUrl: IDX,
    asaId: ASA,
    payTo: PAYTO,
    wallets: { board: BOARD, payer: PAYER, trial: TRIAL },
    ownMerchantIds: ["own-merchant"],
    leaderboardApi: API,
    fetchImpl: f,
    ...extra,
  };
}

test("self-transfers, zero amounts, ALGO notes and received transfers are not counted", async () => {
  const r = await new FairnessLedger(opts(fakeFetch())).get();
  // board->payTo and payer->payTo are vet402's own; board->board (0) is its own address too.
  assert.equal(r.excluded.selfTransfers, 3);
  assert.equal(r.excluded.zeroAmount, 0);
  // Counted: board 3 (Alice x2, Bob), payer 1 (Bob), trial 1 (Alice). The trial's 0-ALGO note is not a USDC transfer.
  assert.equal(r.totals.payments, 5);
  assert.equal(r.totals.usdc, "0.046000");
  assert.deepEqual(r.totals.byWallet.board, { payments: 3, usdc: "0.035000" });
  assert.deepEqual(r.totals.byWallet.payer, { payments: 1, usdc: "0.010000" });
  assert.deepEqual(r.totals.byWallet.trial, { payments: 1, usdc: "0.001000" });
  assert.ok(!r.rows.some((x) => x.examples.includes(txid("A", 4)) || x.examples.includes(txid("C", 1))));
  // Bob -> board is money in the other direction: listed, not a payment by vet402.
  assert.deepEqual(r.fromParticipants, { payments: 1, usdc: "0.007000", txs: [txid("A", 8)] });
});

test("a zero-USDC transfer to someone else is not a payment", async () => {
  const txs = chain();
  txs[BOARD].push(axfer(txid("D", 1), BOARD, BOB, 0, T0 + 99));
  const r = await new FairnessLedger(opts(fakeFetch({ txs }))).get();
  assert.equal(r.excluded.zeroAmount, 1);
  assert.equal(r.totals.payments, 5);
});

test("join: every MainNet account of a participant, not TestNet ones; vet402's own merchant left out; outsiders apart", async () => {
  const r = await new FairnessLedger(opts(fakeFetch({ items: [...leaderboard(), { rank: 4, id: "x", label: "not tagged", address: OUTSIDER, volume: 1, challenge: false }] }))).get();
  const alice = r.rows.find((x) => x.id === "alice")!;
  assert.deepEqual(alice.addresses, [ALICE, ALICE2]);
  assert.equal(alice.payments, 3); // board 2 (one to ALICE2) + trial 1; the TestNet-only address is not hers here
  assert.equal(alice.usdc, "0.031000");
  assert.equal(alice.first, "2026-09-27T04:30:10Z");
  assert.equal(alice.last, "2026-09-27T04:31:30Z");
  assert.deepEqual(alice.examples, [txid("C", 2), txid("A", 2), txid("A", 1)]);
  assert.equal(alice.volumeUsdc, "100.500000");
  const bob = r.rows.find((x) => x.id === "bob")!;
  assert.equal(bob.payments, 2);
  assert.deepEqual(bob.reasons.map((x) => x.reason).sort(), ["board_run", "check"]);
  assert.ok(!r.rows.some((x) => x.id === "own-merchant"));
  assert.deepEqual(r.vet402, { id: "own-merchant", label: "vet402", rank: 3, volumeUsdc: "0.150000" });
  assert.equal(r.totals.participants, 2);
  assert.equal(r.leaderboard.participants, 2); // untagged item and vet402 are not participants
  // OUTSIDER (untagged) and ALICE_TEST are sellers outside the challenge.
  assert.deepEqual(r.otherSellers, { payments: 2, usdc: "0.004000", addresses: 2 });
  assert.deepEqual(r.rows.map((x) => x.id), ["alice", "bob"]); // most payments first
});

test("vet402's merchant is recognised by its payTo even without the id", async () => {
  const r = await new FairnessLedger(opts(fakeFetch(), { ownMerchantIds: [] })).get();
  assert.equal(r.vet402?.id, "own-merchant");
  assert.ok(!r.rows.some((x) => x.id === "own-merchant"));
});

test("leaderboard: every page is read", async () => {
  const many = Array.from({ length: 70 }, (_, i) => ({ rank: 10 + i, id: `m${i}`, label: `M${i}`, address: addr("F").slice(0, 56) + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26)), volume: 1, challenge: true }));
  const last = many[69].address as string;
  const txs = chain();
  txs[BOARD].push(axfer(txid("E", 1), BOARD, last, 2_000, T0 + 5));
  const calls: string[] = [];
  const r = await new FairnessLedger(opts(fakeFetch({ items: [...leaderboard(), ...many], txs, calls }))).get();
  assert.equal(calls.filter((c) => c.startsWith(API)).length, 2);
  assert.equal(r.leaderboard.merchants, 73);
  assert.ok(r.rows.some((x) => x.id === "m69"));
});

test("reason: census by recorded tx or by run window, daily by its run, otherwise board_run", () => {
  const runs: BoardRunInfo[] = [
    { kind: "census", startedAt: "2026-09-27T04:32:00Z", finishedAt: "2026-09-27T05:00:00Z", txs: [txid("Z", 1)] },
    { kind: "daily", startedAt: "2026-09-27T21:00:00Z", finishedAt: "2026-09-27T21:10:00Z", txs: [] },
  ];
  const at = (s: string) => Date.parse(s) / 1000;
  assert.equal(boardReason({ tx: txid("Z", 1), time: at("2026-09-29T00:00:00Z") }, runs), "census");
  assert.equal(boardReason({ tx: txid("Z", 2), time: at("2026-09-27T04:45:00Z") }, runs), "census");
  assert.equal(boardReason({ tx: txid("Z", 3), time: at("2026-09-27T21:05:00Z") }, runs), "daily");
  assert.equal(boardReason({ tx: txid("Z", 4), time: at("2026-09-27T12:00:00Z") }, runs), "board_run");
  assert.equal(boardReason({ tx: txid("Z", 1), time: 0 }, null), "board_run");
});

test("reasons and listings come from the board files", async () => {
  const census = runInfoOf("census", {
    version: 1, network: ALGORAND_MAINNET_CAIP2, networkName: "mainnet", date: "2026-09-27",
    startedAt: new Date((T0 - 60) * 1000).toISOString(), finishedAt: new Date((T0 + 35) * 1000).toISOString(),
    totals: { rows: 3, allow: 1, refuse: 2, skipped: 0, paidUsdc: "0.01" },
    rows: [
      { at: "", url: "https://a/1", host: "a", method: "GET", payTo: ALICE, verdict: "ALLOW", reason: "delivered", paid: true, tx: txid("A", 1) },
      { at: "", url: "https://a/2", host: "a", method: "GET", payTo: ALICE2, verdict: "REFUSE", reason: "payment_failed", paid: false },
      { at: "", url: "https://a/3", host: "a", method: "GET", payTo: ALICE, verdict: "REFUSE", reason: "not_x402", paid: false },
    ],
  })!;
  const r = await new FairnessLedger(opts(fakeFetch(), { boardRuns: async () => [census] })).get();
  const alice = r.rows.find((x) => x.id === "alice")!;
  assert.equal(alice.listings, 3);
  // The census recorded ALICE2's purchase as not settled, but it reached the chain inside the run window: counted.
  assert.deepEqual(alice.reasons, [{ reason: "census", payments: 2 }, { reason: "try", payments: 1 }]);
  assert.equal(r.totals.byReason.census.payments, 3);
  // A failing board-file read does not stop the page: board payments are then "board_run".
  const r2 = await new FairnessLedger(opts(fakeFetch(), { boardRuns: async () => { throw new Error("no files"); } })).get();
  assert.equal(r2.totals.byReason.board_run.payments, 3);
  assert.equal(r2.rows[0].listings, null);
});

test("HTML escapes every leaderboard string", async () => {
  const evil = [{ rank: 5, id: "evil", label: "<script>alert(1)</script>", sub: "\"><img src=x onerror=alert(2)>", address: addr("G"), volume: 1, challenge: true }];
  const txs = chain();
  txs[BOARD].push(axfer(txid("F", 1), BOARD, addr("G"), 1_000, T0 + 7));
  const html = fairnessHtml(await new FairnessLedger(opts(fakeFetch({ items: [...leaderboard(), ...evil], txs }))).get());
  assert.ok(!html.includes("<script>alert(1)"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("Alice &lt;b&gt;&amp;&lt;/b&gt; &quot;Co&quot;"));
  assert.ok(!/<script[\s>]/i.test(html), "the page has no script at all");
});

test("numbers are not hard-coded: the headline follows the data", async () => {
  const a = await new FairnessLedger(opts(fakeFetch())).get();
  assert.equal(
    headline(a),
    "vet402 bought from every listing the same way, including other teams in this challenge. Those payments can raise their leaderboard volume, not ours: 5 payments, 0.046 USDC to 2 participants, while vet402's own volume is 0.15 USDC.",
  );
  const txs = chain();
  for (let i = 0; i < 1200; i++) txs[BOARD].push(axfer(txid("H", i), BOARD, BOB, 10_000, T0 + 100 + i));
  const items = leaderboard().map((x) => (x.id === "own-merchant" ? { ...x, volume: 2.5 } : x));
  const b = await new FairnessLedger(opts(fakeFetch({ items, txs }))).get();
  assert.match(headline(b), /: 1,205 payments, 12\.046 USDC to 2 participants, while vet402's own volume is 2\.5 USDC\.$/);
  // No total from the real chain is written into the source.
  const src = readFileSync(join(process.cwd(), "src", "fairness.ts"), "utf8");
  for (const n of ["1,105", "1105", "1,069", "32.02", "31.72", "31.98", "0.15 USDC"]) assert.ok(!src.includes(n), `src/fairness.ts contains ${n}`);
});

test("routes: numbers when the chain is readable; 503 and no numbers when it is not; cached 10 min, failures not cached", async () => {
  let now = 1_000_000;
  let down = true;
  const calls: string[] = [];
  const base = fakeFetch({ calls });
  const f = (async (i: string | URL | Request, init?: RequestInit) => (down && String(i).startsWith(IDX) ? new Response("down", { status: 503 }) : base(i, init))) as typeof fetch;
  const ledger = new FairnessLedger(opts(f, { now: () => now }));
  const app = new Hono();
  registerFairness(app, ledger);

  const bad = await app.request("/fairness");
  assert.equal(bad.status, 503);
  assert.equal(bad.headers.get("cache-control"), "no-store");
  const badHtml = await bad.text();
  assert.match(badHtml, /cannot be read now/);
  assert.ok(!/\d+ payments|USDC to \d/.test(badHtml));
  const badJson = await app.request("/fairness.json");
  assert.equal(badJson.status, 503);
  assert.equal(((await badJson.json()) as { error: string }).error, "cannot_read_now");

  down = false; // the failure was not cached: the next request reads again
  const ok = await app.request("/fairness");
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "public, max-age=600, s-maxage=600");
  assert.match(await ok.text(), /5 payments, 0\.046 USDC to 2 participants/);
  const n = calls.length;
  now += FAIRNESS_TTL_MS - 1;
  await app.request("/fairness.json");
  assert.equal(calls.length, n, "served from the 10-minute cache");
  now += 2;
  await app.request("/fairness.json");
  assert.ok(calls.length > n, "read again after 10 minutes");

  const lbDown = new FairnessLedger(opts(fakeFetch({ lbDown: true })));
  await assert.rejects(lbDown.get(), /leaderboard 502/);
});

test("the landing nav and the board link to /fairness", () => {
  assert.match(topNav(), /href="\/fairness"/);
  assert.match(boardHtml(null), /href="\/fairness"/);
});
