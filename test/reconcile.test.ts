/**
 * Payment check after a run (src/reconcile.ts) on real data: board-wallet USDC transfers and their
 * groups as the MainNet indexer returned them, and board rows before and after the hand corrections
 * of 2026-09-29 (README "Corrections"). Offline: the indexer is served from the fixture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planReconcile, reconcileRows, signedAtFromNote, type OutTransfer } from "../src/reconcile.js";
import { reconcileFile } from "../scripts/board-sweep.js";
import { boardHtml, parseBoard, type BoardRow } from "../src/board.js";

const FX = JSON.parse(readFileSync(new URL("./fixtures/reconcile/board-wallet.json", import.meta.url), "utf8")) as {
  daily0929: { payer: string; startedAt: string; finishedAt: string; rowsBefore: BoardRow[]; rowsAfter: BoardRow[]; transfers: Idx[]; groups: Record<string, Idx[]> };
  census0927SameTime: { payer: string; startedAt: string; finishedAt: string; rows: BoardRow[]; transfers: Idx[]; groups: Record<string, Idx[]> };
};
type Idx = Record<string, unknown> & { id: string; group?: string; "round-time": number };

const INDEXER = "https://idx.test";
const USDC = "31566704";

/** Serves the fixture like the indexer: account transactions by time window, and group lookups. */
function fakeIndexer(transfers: Idx[], groups: Record<string, Idx[]>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    calls.push(u.pathname);
    if (u.pathname.includes("/v2/accounts/")) {
      const from = Date.parse(u.searchParams.get("after-time")!) / 1000;
      const to = Date.parse(u.searchParams.get("before-time")!) / 1000;
      return Response.json({ transactions: transfers.filter((t) => t["round-time"] >= from && t["round-time"] <= to) });
    }
    if (u.pathname === "/v2/transactions") return Response.json({ transactions: groups[u.searchParams.get("group-id")!] ?? [] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const txOn = (rows: BoardRow[]) => new Set(rows.filter((r) => r.tx).map((r) => r.tx!));
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function run(rows: BoardRow[], f: typeof FX.daily0929 | typeof FX.census0927SameTime, fetchImpl: typeof fetch) {
  return reconcileRows({
    indexerUrl: INDEXER,
    payer: f.payer,
    asaId: USDC,
    rows,
    recorded: txOn(rows),
    from: new Date(Date.parse(f.startedAt) - 120_000),
    to: new Date(Date.parse(f.finishedAt) + 120_000),
    fetchImpl,
    sleep: async () => {},
  });
}

test("1:1: the daily 09-29 file before the hand correction gets the same 2 rows, the same tx and the same detail", async () => {
  const f = FX.daily0929;
  const rows = clone(f.rowsBefore);
  const r = await run(rows, f, fakeIndexer(f.transfers, f.groups));
  assert.equal(r.status, "ok");
  assert.equal(r.transfers, 56);
  assert.equal(r.onRows, 54);
  assert.deepEqual(
    r.recorded.map((x) => x.tx).sort(),
    ["522EQ5HAVMRI4P37F2WCLXNSZ7L22V7FL2WF4Q6QN3GWIZTBFYYA", "MH6I6JKDXUKAR4R4OA6NDGFMMDVVOJVMTMAS2WZEP5VA2JBA22BA"],
  );
  assert.deepEqual(r.unmatched, []);
  // Every row equals the hand-corrected file (bbf5b13), detail included; verdict and reason unchanged.
  assert.deepEqual(rows, f.rowsAfter);
  for (const x of r.recorded) {
    const row = rows.find((y) => y.tx === x.tx)!;
    assert.equal(row.paid, true);
    assert.equal(row.reason, "payment_failed");
    assert.match(row.detail!, /settled on chain: vet402's transfer [A-Z2-7]{52} \(to this payTo, round \d+, \d\d:\d\d:\d\d UTC\); no delivery$/);
  }
});

test("all on rows: the corrected daily 09-29 file is ok and nothing changes", async () => {
  const f = FX.daily0929;
  const rows = clone(f.rowsAfter);
  const r = await run(rows, f, fakeIndexer(f.transfers, f.groups));
  assert.equal(r.status, "ok");
  assert.equal(r.onRows, 56);
  assert.deepEqual(r.recorded, []);
  assert.deepEqual(rows, f.rowsAfter);
});

test("same time: the 5 census 09-27 transfers with several open rows stay unmatched, and no row changes", async () => {
  const f = FX.census0927SameTime;
  const rows = clone(f.rows);
  const r = await run(rows, f, fakeIndexer(f.transfers, f.groups));
  assert.equal(r.status, "unmatched");
  assert.deepEqual(r.recorded, []);
  assert.deepEqual(
    r.unmatched.map((u) => u.tx).sort(),
    [
      "3QDAONYNX2US3TLE3UUNT5VTEFJVLMMXYKB65LKM7DZZ3D57HYZQ",
      "QBSI7KUAUD77HFQEVGSGOZLOMSEEZWGZ4JTSHLZHCELXELPFGTAA",
      "VBZIK2DBXYYHMYFVYOS6MOSJYXAW6BGFCJYXODK7OPO7TNHQWAQQ",
      "VVLQU7XJMW3REBT7WFFADNDCA7KR2HXPN23YSDRVR4TVYGGTYETQ",
      "XED7NSAI7ZXOA4MRRVEGDSWMY7OVTM6GKF4OKL4SGW4YBKGPHQBA",
    ],
  );
  for (const u of r.unmatched) {
    assert.equal(u.amountUsdc, "0.001000");
    assert.match(u.why, /^[23] open rows with this payTo and price were waiting for an answer when it was signed$/);
    assert.ok((u.rows?.length ?? 0) >= 2);
  }
  assert.deepEqual(rows, f.rows);
});

test("not an x402 settlement group: without the facilitator's fee payer in the group, the transfer is not written to a row", async () => {
  const f = FX.daily0929;
  const rows = clone(f.rowsBefore);
  const groups = Object.fromEntries(Object.entries(f.groups).map(([g, m]) => [g, m.filter((t) => t["tx-type"] !== "pay")]));
  const r = await run(rows, f, fakeIndexer(f.transfers, groups));
  assert.equal(r.status, "unmatched");
  assert.equal(r.unmatched.length, 2);
  for (const u of r.unmatched) assert.equal(u.why, "not an x402 settlement group");
  assert.deepEqual(rows, f.rowsBefore);
});

test("indexer down: the check says it could not run, and no row changes", async () => {
  const f = FX.daily0929;
  const rows = clone(f.rowsBefore);
  const down = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
  const r = await run(rows, f, down);
  assert.equal(r.status, "unavailable");
  assert.match(r.error!, /not confirmed that every payment is on a row/);
  assert.deepEqual(rows, f.rowsBefore);
});

test("a row gets at most one transfer: two transfers for one open row are both left unmatched", () => {
  const row: BoardRow = { at: "2026-09-29T05:35:41.000Z", url: "https://s.test/a", host: "s.test", method: "GET", priceUsdc: "0.001000", payTo: "P", verdict: "REFUSE", reason: "payment_failed", paid: false };
  const t = (tx: string, ms: number): OutTransfer => ({ tx, receiver: "P", amountAtomic: 1000n, fee: 0, round: 1, roundTime: 1, signedAtMs: ms, x402Group: true });
  const at = Date.parse(row.at);
  const p = planReconcile([row], [t("A".repeat(52), at - 5000), t("B".repeat(52), at - 4000)], new Set());
  assert.deepEqual(p.pairs, []);
  assert.deepEqual(p.unmatched.map((u) => u.why), ["its row has 2 candidate transfers", "its row has 2 candidate transfers"]);
  // SKIPPED rows were never bought: a transfer is never written to one.
  const skipped = planReconcile([{ ...row, verdict: "SKIPPED", reason: "daily_cap" }], [t("A".repeat(52), at - 5000)], new Set());
  assert.deepEqual(skipped.pairs, []);
});

test("signing time from the note vet402's client writes", () => {
  assert.equal(signedAtFromNote(Buffer.from("x402-payment-v2-1759124141123").toString("base64")), 1759124141123);
  assert.equal(signedAtFromNote(Buffer.from("hello").toString("base64")), undefined);
  assert.equal(signedAtFromNote(undefined), undefined);
});

test("reconcileFile: reads every board file in the directory as recorded, and totals.paidUsdc follows", async () => {
  const f = FX.daily0929;
  const dir = mkdtempSync(join(tmpdir(), "reconcile-"));
  const board = { payer: f.payer, startedAt: f.startedAt, finishedAt: f.finishedAt, totals: { rows: 76, allow: 0, refuse: 0, skipped: 0, paidUsdc: "0.961100" }, rows: clone(f.rowsBefore) };
  writeFileSync(join(dir, "2026-09-29.json"), JSON.stringify(board));
  writeFileSync(join(dir, "spend-mainnet.json"), JSON.stringify({ day: "2026-09-29" }));
  const r = await reconcileFile(board, dir, { indexerUrl: INDEXER, usdcAsaId: USDC }, new Date(Date.parse(f.finishedAt) + 120_000), fakeIndexer(f.transfers, f.groups));
  assert.equal(r.status, "ok");
  assert.equal(r.recorded.length, 2);
  assert.equal(board.totals.paidUsdc, "0.972100");
});

test("/board shows how many payments are on no row, or that the check could not run; nothing when all are on a row", () => {
  const base = { version: 1, network: "algorand:x", networkName: "mainnet", date: "2026-09-27", startedAt: "", finishedAt: "", totals: {}, rows: FX.census0927SameTime.rows.slice(0, 3) };
  const unmatched = parseBoard(JSON.stringify({ ...base, reconcile: { status: "unmatched", checkedAt: "2026-09-27T05:03:00Z", transfers: 63, onRows: 58, recorded: [], unmatched: [{ tx: "3QDAONYNX2US3TLE3UUNT5VTEFJVLMMXYKB65LKM7DZZ3D57HYZQ", amountUsdc: "0.001000", payTo: "6L4N", why: "3 open rows" }, {}, {}, {}, {}] } }))!;
  assert.equal(unmatched.reconcile?.unmatched, 5);
  assert.equal(unmatched.reconcile?.unmatchedTx?.length, 1);
  assert.match(boardHtml(unmatched), /Payment check: 5 USDC payments the board wallet made during this run are on chain but on no row/);
  const down = parseBoard(JSON.stringify({ ...base, reconcile: { status: "unavailable", checkedAt: "x", error: "indexer 502" } }))!;
  assert.match(boardHtml(down), /Payment check not done: after this run the chain could not be read/);
  const ok = parseBoard(JSON.stringify({ ...base, reconcile: { status: "ok", checkedAt: "x", transfers: 3, onRows: 3, recorded: [], unmatched: [] } }))!;
  assert.doesNotMatch(boardHtml(ok), /Payment check/);
  assert.doesNotMatch(boardHtml(parseBoard(JSON.stringify(base))), /Payment check/);
});
