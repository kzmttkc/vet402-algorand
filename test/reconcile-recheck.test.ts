/**
 * Repeating the payment check after the run: later the same UTC day (a completed daily), and on the next
 * UTC day for payments settled after the day's last run. Real data (fixtures/reconcile), offline indexer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPreviousDay, EXIT_PAYMENT_CHECK, recheckCompletedDaily } from "../scripts/board-sweep.js";
import { reconcileRows, type ReconcileResult } from "../src/reconcile.js";
import { boardHtml, parseBoard, type BoardRow } from "../src/board.js";

type Idx = Record<string, unknown> & { id: string; "round-time": number };
const FX = JSON.parse(readFileSync(new URL("./fixtures/reconcile/board-wallet.json", import.meta.url), "utf8")) as {
  daily0929: { payer: string; startedAt: string; finishedAt: string; rowsBefore: BoardRow[]; rowsAfter: BoardRow[]; transfers: Idx[]; groups: Record<string, Idx[]> };
  census0927SameTime: { payer: string; startedAt: string; finishedAt: string; rows: BoardRow[]; transfers: Idx[]; groups: Record<string, Idx[]> };
};
const CFG = { indexerUrl: "https://idx.test", usdcAsaId: "31566704" };
const noSleep = async () => {};

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
const down = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A board file as a run writes it, with the payment check the run made. */
function dayFile(dir: string, name: string, f: { payer: string; startedAt: string; finishedAt: string }, rows: BoardRow[], reconcile: ReconcileResult, date: string): string {
  const file = join(dir, name);
  const paid = rows.filter((r) => r.paid && r.priceUsdc).reduce((s, r) => s + Math.round(Number(r.priceUsdc) * 1e6), 0);
  writeFileSync(
    file,
    JSON.stringify({ version: 1, mode: "daily", network: "algorand:x", networkName: "mainnet", date, startedAt: f.startedAt, finishedAt: f.finishedAt, completedAt: f.finishedAt, payer: f.payer, totals: { rows: rows.length, allow: 0, refuse: 0, skipped: 0, paidUsdc: (paid / 1e6).toFixed(6) }, reconcile, rows }, null, 2),
  );
  return file;
}

async function checkNow(rows: BoardRow[], f: typeof FX.census0927SameTime | typeof FX.daily0929): Promise<ReconcileResult> {
  return reconcileRows({ ...CFG, asaId: CFG.usdcAsaId, payer: f.payer, rows: clone(rows), recorded: new Set(rows.filter((r) => r.tx).map((r) => r.tx!)), from: new Date(Date.parse(f.startedAt) - 120_000), to: new Date(Date.parse(f.finishedAt) + 120_000), fetchImpl: fakeIndexer(f.transfers, f.groups), sleep: noSleep });
}

test("same day, chain unreadable, earlier result had payments on no row: exit 3, the list stays, and the file says this check did not run", async () => {
  const f = FX.census0927SameTime;
  const dir = mkdtempSync(join(tmpdir(), "recheck-"));
  const first = await checkNow(f.rows, f);
  assert.equal(first.unmatched.length, 5);
  const file = dayFile(dir, "2026-09-27.json", f, f.rows, first, "2026-09-27");
  const code = await recheckCompletedDaily(file, CFG, { fetchImpl: down, sleep: noSleep, now: new Date("2026-09-27T18:20:00Z") });
  assert.equal(code, EXIT_PAYMENT_CHECK);
  const after = JSON.parse(readFileSync(file, "utf8")) as { reconcile: ReconcileResult };
  assert.equal(after.reconcile.status, "unmatched");
  assert.deepEqual(after.reconcile.unmatched, first.unmatched);
  assert.equal(after.reconcile.lastAttempt?.status, "unavailable");
  assert.equal(after.reconcile.lastAttempt?.checkedAt.length ? true : false, true);
  const html = boardHtml(parseBoard(readFileSync(file, "utf8")));
  assert.match(html, /Payment check: 5 USDC payments the board wallet made between .* are on chain but on no row/);
  assert.match(html, /The latest check, at .* UTC, could not read the chain/);
});

test("same day, chain unreadable, earlier result ok: exit 3 as well (not treated as fine), and the ok result is kept", async () => {
  const f = FX.daily0929;
  const dir = mkdtempSync(join(tmpdir(), "recheck-"));
  const first = await checkNow(f.rowsAfter, f);
  assert.equal(first.status, "ok");
  const file = dayFile(dir, "2026-09-29.json", f, f.rowsAfter, first, "2026-09-29");
  const code = await recheckCompletedDaily(file, CFG, { fetchImpl: down, sleep: noSleep, now: new Date("2026-09-29T12:20:00Z") });
  assert.equal(code, EXIT_PAYMENT_CHECK);
  const after = JSON.parse(readFileSync(file, "utf8")) as { reconcile: ReconcileResult; rows: BoardRow[] };
  assert.equal(after.reconcile.status, "ok");
  assert.equal(after.reconcile.lastAttempt?.status, "unavailable");
  assert.deepEqual(after.rows, f.rowsAfter);
  // The next check that reads the chain replaces the note.
  const code2 = await recheckCompletedDaily(file, CFG, { fetchImpl: fakeIndexer(f.transfers, f.groups), sleep: noSleep, now: new Date("2026-09-29T18:20:00Z") });
  assert.equal(code2, 0);
  const again = JSON.parse(readFileSync(file, "utf8")) as { reconcile: ReconcileResult };
  assert.equal(again.reconcile.status, "ok");
  assert.equal(again.reconcile.lastAttempt, undefined);
});

test("next day: payments that settled after the day's last check are written to the previous day's file (rows, totals, latest.json), once", async () => {
  const f = FX.daily0929;
  const dir = mkdtempSync(join(tmpdir(), "nextday-"));
  // The run's own check saw only the transfers already on rows (the 2 late ones were not on chain yet).
  const onRows = new Set(f.rowsBefore.filter((r) => r.tx).map((r) => r.tx!));
  const early = await reconcileRows({ ...CFG, asaId: CFG.usdcAsaId, payer: f.payer, rows: clone(f.rowsBefore), recorded: new Set(onRows), from: new Date(Date.parse(f.startedAt) - 120_000), to: new Date(Date.parse(f.finishedAt)), fetchImpl: fakeIndexer(f.transfers.filter((t) => onRows.has(t.id)), f.groups), sleep: noSleep });
  assert.equal(early.status, "ok");
  const file = dayFile(dir, "2026-09-29.json", f, f.rowsBefore, early, "2026-09-29");
  writeFileSync(join(dir, "latest.json"), readFileSync(file));
  const calls: string[] = [];
  const code = await checkPreviousDay(dir, "2026-09-30", CFG, { fetchImpl: fakeIndexer(f.transfers, f.groups, calls), sleep: noSleep, now: new Date("2026-09-30T06:17:00Z") });
  assert.equal(code, 0);
  const after = JSON.parse(readFileSync(file, "utf8")) as { reconcile: ReconcileResult; rows: BoardRow[]; totals: { paidUsdc: string } };
  assert.deepEqual(after.rows, f.rowsAfter);
  assert.equal(after.totals.paidUsdc, "0.972100");
  assert.equal(after.reconcile.recorded.length, 2);
  assert.ok(after.reconcile.nextDayCheckedAt);
  // The window ends 2 hours after the file's end, not at the time of the check.
  assert.equal(after.reconcile.window.to, new Date(Date.parse(f.finishedAt) + 2 * 3_600_000).toISOString());
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")), after);
  // Once: a later run that day does not read the chain for the previous day again.
  const n = calls.length;
  assert.equal(await checkPreviousDay(dir, "2026-09-30", CFG, { fetchImpl: fakeIndexer(f.transfers, f.groups, calls), sleep: noSleep }), 0);
  assert.equal(calls.length, n);
});

test("next day: a payment on no row that the file did not list fails the run; one already listed does not fail it again; chain unreadable is retried", async () => {
  const f = FX.census0927SameTime;
  const dir = mkdtempSync(join(tmpdir(), "nextday-"));
  const listed = await checkNow(f.rows, f);
  const known = dayFile(dir, "census-2026-09-26.json", f, f.rows, listed, "2026-09-26");
  assert.equal(await checkPreviousDay(dir, "2026-09-27", CFG, { fetchImpl: fakeIndexer(f.transfers, f.groups), sleep: noSleep, now: new Date("2026-09-27T06:17:00Z") }), 0);
  assert.ok((JSON.parse(readFileSync(known, "utf8")) as { reconcile: ReconcileResult }).reconcile.nextDayCheckedAt);

  const dir2 = mkdtempSync(join(tmpdir(), "nextday-"));
  const okBefore: ReconcileResult = { ...listed, status: "ok", unmatched: [] };
  const file = dayFile(dir2, "census-2026-09-26.json", f, f.rows, okBefore, "2026-09-26");
  // Chain unreadable: exit 3, not marked as checked, so the next run tries again.
  assert.equal(await checkPreviousDay(dir2, "2026-09-27", CFG, { fetchImpl: down, sleep: noSleep, now: new Date("2026-09-27T06:17:00Z") }), EXIT_PAYMENT_CHECK);
  const mid = JSON.parse(readFileSync(file, "utf8")) as { reconcile: ReconcileResult };
  assert.equal(mid.reconcile.nextDayCheckedAt, undefined);
  assert.equal(mid.reconcile.lastAttempt?.status, "unavailable");
  // Readable: the 5 are new to this file, so the run fails, and they are listed.
  assert.equal(await checkPreviousDay(dir2, "2026-09-27", CFG, { fetchImpl: fakeIndexer(f.transfers, f.groups), sleep: noSleep, now: new Date("2026-09-27T12:17:00Z") }), EXIT_PAYMENT_CHECK);
  const end = JSON.parse(readFileSync(file, "utf8")) as { reconcile: ReconcileResult };
  assert.equal(end.reconcile.unmatched.length, 5);
  assert.ok(end.reconcile.nextDayCheckedAt);
  assert.equal(end.reconcile.lastAttempt, undefined);
});

test("next day: files written before the payment check existed are left alone", async () => {
  const f = FX.daily0929;
  const dir = mkdtempSync(join(tmpdir(), "nextday-"));
  const file = join(dir, "2026-09-29.json");
  const text = JSON.stringify({ version: 1, date: "2026-09-29", startedAt: f.startedAt, finishedAt: f.finishedAt, payer: f.payer, totals: { paidUsdc: "0.961100" }, rows: f.rowsBefore });
  writeFileSync(file, text);
  const calls: string[] = [];
  assert.equal(await checkPreviousDay(dir, "2026-09-30", CFG, { fetchImpl: fakeIndexer(f.transfers, f.groups, calls), sleep: noSleep }), 0);
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(file, "utf8"), text);
});

test("next day: a previous-day file that does not parse does not stop the run; the other file is still checked, and the run ends with exit 3", async () => {
  const f = FX.daily0929;
  const dir = mkdtempSync(join(tmpdir(), "nextday-"));
  writeFileSync(join(dir, "2026-09-29.json"), '{"rows": [ broken');
  const first = await checkNow(f.rowsAfter, f);
  const census = dayFile(dir, "census-2026-09-29.json", f, f.rowsAfter, first, "2026-09-29");
  const code = await checkPreviousDay(dir, "2026-09-30", CFG, { fetchImpl: fakeIndexer(f.transfers, f.groups), sleep: noSleep, now: new Date("2026-09-30T06:17:00Z") });
  assert.equal(code, EXIT_PAYMENT_CHECK);
  assert.ok((JSON.parse(readFileSync(census, "utf8")) as { reconcile: ReconcileResult }).reconcile.nextDayCheckedAt);
});

test("main: a broken previous-day file does not throw out of the run; the run goes on and exits 3", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nextday-main-"));
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  writeFileSync(join(dir, `${yesterday}.json`), "not json");
  const ok: ReconcileResult = { checkedAt: `${today}T06:20:00.000Z`, status: "ok", window: { from: "", to: "" }, transfers: 0, onRows: 0, recorded: [], unmatched: [] };
  writeFileSync(join(dir, `${today}.json`), JSON.stringify({ version: 1, date: today, startedAt: `${today}T06:17:00.000Z`, finishedAt: `${today}T06:20:00.000Z`, completedAt: `${today}T06:20:00.000Z`, payer: "BOARDPAYER", totals: { paidUsdc: "0.000000" }, reconcile: ok, rows: [] }));
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    if (u.pathname.includes("/v2/accounts/")) return Response.json({ transactions: [] });
    throw new Error(`unexpected request ${u.href}`);
  }) as typeof fetch;
  try {
    process.env.X402_NETWORK = "testnet";
    const { main } = await import("../scripts/board-sweep.js");
    assert.equal(await main(["--out", dir]), EXIT_PAYMENT_CHECK);
  } finally {
    globalThis.fetch = realFetch;
    process.env = env;
  }
});

test("a narrower window keeps the earlier list: payments listed as on no row stay listed unless a check wrote them to a row", async () => {
  const f = FX.census0927SameTime;
  const dir = mkdtempSync(join(tmpdir(), "nextday-"));
  const listed = await checkNow(f.rows, f);
  assert.equal(listed.unmatched.length, 5);
  // The next-day window starts after the 5 transfers (as if the check read a later part of the day).
  const later = { ...f, startedAt: "2026-09-27T05:00:00.000Z" };
  const file = dayFile(dir, "census-2026-09-26.json", later, f.rows, listed, "2026-09-26");
  const code = await checkPreviousDay(dir, "2026-09-27", CFG, { fetchImpl: fakeIndexer(f.transfers, f.groups), sleep: noSleep, now: new Date("2026-09-27T06:17:00Z") });
  assert.equal(code, 0);
  const after = JSON.parse(readFileSync(file, "utf8")) as { reconcile: ReconcileResult };
  assert.equal(after.reconcile.status, "unmatched");
  assert.deepEqual(after.reconcile.unmatched.map((u) => u.tx).sort(), listed.unmatched.map((u) => u.tx).sort());
  assert.ok(after.reconcile.nextDayCheckedAt);

  // One of them is on a row by the time of the next check: only that one leaves the list.
  const dir2 = mkdtempSync(join(tmpdir(), "nextday-"));
  const gone = listed.unmatched[0].tx;
  const rows = clone(f.rows);
  const i = rows.findIndex((r) => !r.paid && r.payTo === listed.unmatched[0].payTo);
  rows[i] = { ...rows[i], paid: true, tx: gone };
  const file2 = dayFile(dir2, "census-2026-09-26.json", later, rows, listed, "2026-09-26");
  await checkPreviousDay(dir2, "2026-09-27", CFG, { fetchImpl: fakeIndexer(f.transfers, f.groups), sleep: noSleep, now: new Date("2026-09-27T06:17:00Z") });
  const after2 = JSON.parse(readFileSync(file2, "utf8")) as { reconcile: ReconcileResult };
  assert.equal(after2.reconcile.unmatched.length, 4);
  assert.ok(!after2.reconcile.unmatched.some((u) => u.tx === gone));
});
