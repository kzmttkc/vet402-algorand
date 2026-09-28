/**
 * Census fairness and recording (2026-09-28):
 * - at most 5 purchases per seller host per run (today's earlier attempts count), 60 s apart;
 *   the rest are SKIPPED not_measured_this_run, never contacted, not counted against the seller;
 * - "transaction already in ledger" is looked up on chain (indexer mocked): when vet402's transfer
 *   is in the group, the row is recorded paid with that tx, and payments.csv lists it.
 * Offline: probeOne and the indexer are faked. No key, no payment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PER_HOST_PER_RUN,
  MIN_HOST_GAP_MS,
  NOT_MEASURED,
  attemptsPerHost,
  dayShift,
  interleaveByHost,
  limitPerHost,
  repairSettled,
  rotateWithinHost,
  runSweep,
  totalsOf,
  type Candidate,
} from "../scripts/board-sweep.js";
import { displayClass, paymentsCsv, type BoardFile, type BoardRow } from "../src/board.js";
import { failureMode } from "../src/fix-first.js";
import { alreadyInLedgerTx, findSettledPayment } from "../src/settled.js";
import type { ProbeResult } from "../src/probe.js";

const PAYER = "HVRJUKO2QDZW6UKADE7LYWQFMTT75537OPMYEWOTYIUFO4BB25TFL5IQMQ";
const PAYTO = "LXPC4GQPYH2EZQX2QDYMHCP2I7MXIZMVRPIYTQ3D7R7HXJ4SIHCSYLF5YA";
const FEE_TX = "X4XM7ZJ3BBWNHMYPYC3RX3PY4IAG2NVFYIY3JKJ74QPSJUQ33PUQ"; // the facilitator's fee-payer tx named in the error
const OUR_TX = "BNDAE7VS74VREBS3XJCF5CNOVH77VZEISO6VYXZ7FFWO2IYZIYWQ"; // vet402's USDC transfer in the same group
const GROUP = "DOOFRWjShjxYpOyQ5jYYFZ+0JOnPkUE2hNda07onj3g=";
const ROUND = 65460671;
const RTIME = 1790558721; // 2026-09-28T01:25:21Z
const USDC = "31566704";
const IDX = "https://idx.test";
const ERR = `status 402, Transaction simulation failed: transaction already in ledger: ${FEE_TX}`;

function cand(host: string, i: number, price = 1000n): Candidate {
  const url = `https://${host}/r${i}`;
  return { key: `GET ${url}`, url, host, method: "GET", input: "(none)", priceAtomic: price, payTo: PAYTO };
}

// ---------- per-host limit

test("at most 5 purchases per host per run: 581 listings from one host → 5 probed, 576 SKIPPED not_measured_this_run", async () => {
  assert.equal(MAX_PER_HOST_PER_RUN, 5);
  const cs = interleaveByHost([...Array.from({ length: 581 }, (_, i) => cand("agent402.tools", i)), cand("b.example", 0), cand("c.example", 0)]);
  const probed: Candidate[] = [];
  const rows = await runSweep(cs, {
    concurrency: 3,
    maxPerHost: MAX_PER_HOST_PER_RUN,
    probeOne: async (c) => {
      probed.push(c);
      return { verdict: "ALLOW", reason: "delivered", target: c.url };
    },
  });
  const perHost = new Map<string, number>();
  for (const c of probed) perHost.set(c.host, (perHost.get(c.host) ?? 0) + 1);
  assert.equal(perHost.get("agent402.tools"), 5);
  assert.equal(perHost.get("b.example"), 1);
  assert.equal(perHost.get("c.example"), 1);
  assert.equal(rows.length, cs.length, "every candidate has one row");
  const skipped = rows.filter((r) => r.verdict === "SKIPPED");
  assert.equal(skipped.length, 576);
  assert.ok(skipped.every((r) => r.reason === NOT_MEASURED && r.paid === false && r.host === "agent402.tools"));
  // The 5 bought are the first 5 of that host in list order.
  assert.deepEqual(
    probed.filter((c) => c.host === "agent402.tools").map((c) => c.url),
    cs.filter((c) => c.host === "agent402.tools").slice(0, 5).map((c) => c.url),
  );
});

test("the per-host limit counts today's earlier attempts (resume): 3 already → 2 more", async () => {
  const cs = Array.from({ length: 10 }, (_, i) => cand("a.example", i));
  const done = new Set(cs.slice(0, 3).map((c) => c.key));
  const prior = attemptsPerHost(done);
  assert.equal(prior.get("a.example"), 3);
  const probed: string[] = [];
  const rows = await runSweep(cs, {
    maxPerHost: 5,
    priorPerHost: prior,
    done,
    probeOne: async (c) => {
      probed.push(c.key);
      return { verdict: "ALLOW", reason: "delivered", target: c.url };
    },
  });
  assert.equal(probed.length, 2);
  assert.ok(probed.every((k) => !done.has(k)));
  assert.equal(rows.filter((r) => r.reason === NOT_MEASURED).length, 5);
});

test("limitPerHost keeps list order, so the round-robin stays round-robin", () => {
  const cs = interleaveByHost([...Array.from({ length: 8 }, (_, i) => cand("a.example", i)), ...Array.from({ length: 2 }, (_, i) => cand("b.example", i))]);
  const { take, rest } = limitPerHost(cs, 5);
  assert.deepEqual(
    take.map((c) => c.url),
    ["https://a.example/r0", "https://b.example/r0", "https://a.example/r1", "https://b.example/r1", "https://a.example/r2", "https://a.example/r3", "https://a.example/r4"],
  );
  assert.equal(rest.length, 3);
});

test("the 5 rotate by UTC day and keep each host's slots (a later day reaches the rest)", () => {
  const cs = interleaveByHost([...Array.from({ length: 12 }, (_, i) => cand("a.example", i)), cand("b.example", 0)]);
  const d1 = limitPerHost(rotateWithinHost(cs, dayShift("2026-09-28", 5)), 5).take.filter((c) => c.host === "a.example").map((c) => c.url);
  const d2 = limitPerHost(rotateWithinHost(cs, dayShift("2026-09-29", 5)), 5).take.filter((c) => c.host === "a.example").map((c) => c.url);
  assert.equal(d1.length, 5);
  assert.equal(d2.length, 5);
  assert.equal(d1.filter((u) => d2.includes(u)).length, 0, "consecutive days buy different resources of a host with ≥ 10 listings");
  // Host slots unchanged: position of every b.example entry is the same.
  const rot = rotateWithinHost(cs, dayShift("2026-09-28", 5));
  assert.deepEqual(rot.map((c) => c.host), cs.map((c) => c.host));
  assert.deepEqual([...rot.map((c) => c.key)].sort(), [...cs.map((c) => c.key)].sort());
});

test("SKIPPED not_measured_this_run is not counted against the seller: UNCLEAR, vet402_limit, not REFUSE, not paid", () => {
  const r: BoardRow = { at: "2026-09-28T00:00:00Z", url: "https://a.example/r9", host: "a.example", method: "GET", verdict: "SKIPPED", reason: NOT_MEASURED, paid: false };
  assert.equal(displayClass(r), "UNCLEAR");
  assert.equal(failureMode(r), "vet402_limit");
  const t = totalsOf([r]);
  assert.equal(t.refuse, 0);
  assert.equal(t.skipped, 1);
  assert.equal(t.paidUsdc, "0.000000");
});

// ---------- spacing

test("purchases from one host are at least 60 s apart (end → next start), on a fake clock; other hosts are not held up", async () => {
  let now = 0;
  const timers: { at: number; fire: () => void }[] = [];
  const sleep = (ms: number) =>
    new Promise<void>((res) => {
      timers.push({ at: now + ms, fire: res });
    });
  const cs = interleaveByHost([...Array.from({ length: 7 }, (_, i) => cand("a.example", i)), cand("b.example", 0), cand("c.example", 0)]);
  const log: { host: string; start: number; end: number }[] = [];
  const run = runSweep(cs, {
    concurrency: 3,
    hostGapMs: MIN_HOST_GAP_MS,
    maxPerHost: 5,
    clock: () => now,
    sleep,
    probeOne: async (c) => {
      const start = now;
      now += 1500; // a purchase takes 1.5 s
      log.push({ host: c.host, start, end: now });
      return { verdict: "ALLOW", reason: "delivered", target: c.url };
    },
  });
  // Drive the fake clock: fire the earliest timer until the run finishes.
  let finished = false;
  run.then(() => (finished = true));
  for (let i = 0; i < 1000 && !finished; i++) {
    await new Promise((r) => setImmediate(r));
    timers.sort((p, q) => p.at - q.at);
    const t = timers.shift();
    if (t) {
      now = Math.max(now, t.at);
      t.fire();
    }
  }
  const rows = await run;
  assert.equal(rows.length, 9);
  const a = log.filter((x) => x.host === "a.example").sort((p, q) => p.start - q.start);
  assert.equal(a.length, 5, "5 per host");
  for (let i = 1; i < a.length; i++) assert.ok(a[i].start - a[i - 1].end >= 60_000, `gap ${a[i].start - a[i - 1].end} ms`);
  assert.ok(a[4].start - a[0].start >= 4 * 60_000);
  // b and c start at once, not after a's gap.
  for (const h of ["b.example", "c.example"]) assert.ok(log.find((x) => x.host === h)!.start < 60_000, h);
});

// ---------- "transaction already in ledger"

/** Indexer mock: the fee-payer tx and its group (vet402's transfer + the fee payer). */
function indexerMock(o: { ourAmount?: number; ourReceiver?: string; ourSender?: string; roundTime?: number; missing?: boolean; fail?: boolean } = {}) {
  const calls: string[] = [];
  const fee = { id: FEE_TX, "tx-type": "pay", sender: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA", group: GROUP, "confirmed-round": ROUND, "round-time": o.roundTime ?? RTIME, "payment-transaction": { amount: 0, receiver: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA" } };
  const ours = {
    id: OUR_TX,
    "tx-type": "axfer",
    sender: o.ourSender ?? PAYER,
    group: GROUP,
    "confirmed-round": ROUND,
    "round-time": o.roundTime ?? RTIME,
    "asset-transfer-transaction": { "asset-id": Number(USDC), amount: o.ourAmount ?? 5000, receiver: o.ourReceiver ?? PAYTO },
  };
  const f = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (o.fail) return new Response("down", { status: 503 });
    if (u === `${IDX}/v2/transactions/${FEE_TX}`) return o.missing ? new Response("{}", { status: 404 }) : Response.json({ transaction: fee });
    const p = new URL(u);
    if (p.pathname === "/v2/transactions" && p.searchParams.get("group-id") === GROUP && p.searchParams.get("round") === String(ROUND)) {
      return Response.json({ transactions: [fee, ours] });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

const lookup = (f: typeof fetch, over: Partial<Parameters<typeof findSettledPayment>[0]> = {}) =>
  findSettledPayment({ indexerUrl: IDX, txid: FEE_TX, payer: PAYER, payTo: PAYTO, asaId: USDC, maxAmountAtomic: 5000n, window: { from: RTIME - 60, to: RTIME + 60 }, fetchImpl: f, ...over });

test("alreadyInLedgerTx reads the tx id from the facilitator's error", () => {
  assert.equal(alreadyInLedgerTx(ERR), FEE_TX);
  assert.equal(alreadyInLedgerTx("status 402, subcent_quota_exceeded"), undefined);
  assert.equal(alreadyInLedgerTx("transaction already in ledger: not-a-txid"), undefined);
});

test("findSettledPayment: the error names the fee-payer tx; vet402's transfer is found in its group", async () => {
  const m = indexerMock();
  const s = await lookup(m.f);
  assert.deepEqual(s, { tx: OUR_TX, amountAtomic: 5000n, round: ROUND, roundTime: RTIME });
  assert.equal(m.calls.length, 2);
});

test("findSettledPayment refuses anything that is not vet402's transfer to this seller, in the window, at most the price", async () => {
  assert.equal(await lookup(indexerMock({ ourReceiver: "SOMEONEELSE" }).f), null, "other receiver");
  assert.equal(await lookup(indexerMock({ ourSender: "SOMEONEELSE" }).f), null, "other sender");
  assert.equal(await lookup(indexerMock({ ourAmount: 5001 }).f), null, "more than the approved price");
  assert.equal(await lookup(indexerMock({ roundTime: RTIME - 3600 }).f), null, "outside the purchase window (an older payment)");
  assert.equal(await lookup(indexerMock({ missing: true }).f), null, "unknown tx");
  await assert.rejects(lookup(indexerMock({ fail: true }).f), /indexer 503/);
});

function ledgerProbe(c: Candidate): ProbeResult {
  return {
    verdict: "REFUSE",
    reason: "payment_failed",
    target: c.url,
    price: { amountAtomic: "5000", usdc: "0.005000", payTo: PAYTO, network: "algorand:x", asset: USDC },
    detail: ERR,
  };
}

test("runSweep: an 'already in ledger' answer settled on chain is recorded paid with vet402's tx; payments.csv lists it", async () => {
  const m = indexerMock();
  const c = cand("gateway-x402.vercel.app", 0, 5000n);
  let t = RTIME * 1000;
  const rows = await runSweep([c], {
    clock: () => t,
    probeOne: async (x) => {
      t += 3000;
      return ledgerProbe(x);
    },
    checkSettled: (cc, errorTx, window) =>
      findSettledPayment({ indexerUrl: IDX, txid: errorTx, payer: PAYER, payTo: cc.payTo!, asaId: USDC, maxAmountAtomic: cc.priceAtomic!, window, fetchImpl: m.f }),
  });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.paid, true);
  assert.equal(r.tx, OUR_TX);
  assert.equal(r.priceUsdc, "0.005000");
  assert.equal(r.reason, "payment_failed", "reason stays as recorded");
  assert.match(r.detail!, /settled on chain/);
  assert.ok(r.detail!.includes(OUR_TX) && r.detail!.includes(FEE_TX));
  assert.ok(r.detail!.length <= 300);
  // Paid, but nothing was delivered to compare: UNCLEAR, not MISMATCH.
  assert.equal(displayClass(r), "UNCLEAR");
  assert.equal(totalsOf(rows).paidUsdc, "0.005000");
  const board = { version: 1, network: "algorand:x", networkName: "mainnet", date: "2026-09-28", startedAt: "", finishedAt: "", payer: PAYER, totals: totalsOf(rows), rows } as BoardFile;
  const csv = paymentsCsv([board]).trim().split("\r\n");
  assert.equal(csv.length, 2);
  assert.ok(csv[1].includes(OUR_TX) && csv[1].includes(PAYER) && csv[1].includes(PAYTO) && csv[1].includes("0.005000"));
});

test("runSweep: not found on chain, or the indexer down → stays paid: false (with a note); never the same tx twice", async () => {
  const c = cand("gateway-x402.vercel.app", 0, 5000n);
  const notFound = await runSweep([c], { probeOne: async (x) => ledgerProbe(x), checkSettled: async () => null });
  assert.equal(notFound[0].paid, false);
  assert.match(notFound[0].detail!, /not found settled on chain/);
  const down = await runSweep([c], { probeOne: async (x) => ledgerProbe(x), checkSettled: async () => Promise.reject(new Error("indexer 503")) });
  assert.equal(down[0].paid, false);
  assert.match(down[0].detail!, /on-chain check failed: indexer 503/);
  const dup = await runSweep([c], {
    probeOne: async (x) => ledgerProbe(x),
    knownTx: new Set([OUR_TX]),
    checkSettled: async () => ({ tx: OUR_TX, amountAtomic: 5000n, round: ROUND, roundTime: RTIME }),
  });
  assert.equal(dup[0].paid, false, "a tx already recorded on another row is not recorded again");
});

test("runSweep: other payment_failed answers are not looked up", async () => {
  let asked = 0;
  const rows = await runSweep([cand("a.example", 0)], {
    probeOne: async (c) => ({ verdict: "REFUSE", reason: "payment_failed", target: c.url, detail: "status 402, subcent_quota_exceeded" }),
    checkSettled: async () => {
      asked++;
      return null;
    },
  });
  assert.equal(asked, 0);
  assert.equal(rows[0].paid, false);
});

test("repairSettled: a written file's 'already in ledger' rows become paid with vet402's tx; totals and payments.csv follow", async () => {
  const m = indexerMock();
  const row: BoardRow = {
    at: "2026-09-28T01:25:23.975Z",
    url: "https://gateway-x402.vercel.app/discover",
    host: "gateway-x402.vercel.app",
    method: "GET",
    payTo: PAYTO,
    priceUsdc: "0.005000",
    verdict: "REFUSE",
    reason: "payment_failed",
    detail: ERR,
    paid: false,
  };
  const other: BoardRow = { ...row, url: "https://b.example/x", host: "b.example", detail: "status 402, subcent_quota_exceeded" };
  const board = { version: 1, network: "algorand:x", networkName: "mainnet", date: "2026-09-28", startedAt: "", finishedAt: "", payer: PAYER, totals: totalsOf([row, other]), rows: [row, other] } as BoardFile;
  assert.equal(paymentsCsv([board]).trim().split("\r\n").length, 1, "before: no payment line");
  const { changed, notFound } = await repairSettled(board, (c, errorTx, window) =>
    findSettledPayment({ indexerUrl: IDX, txid: errorTx, payer: PAYER, payTo: c.payTo!, asaId: USDC, maxAmountAtomic: c.priceAtomic!, window, fetchImpl: m.f }),
  );
  assert.equal(changed.length, 1);
  assert.equal(notFound.length, 0);
  assert.equal(board.rows[0].paid, true);
  assert.equal(board.rows[0].tx, OUR_TX);
  assert.equal(board.rows[1].paid, false, "other failures untouched");
  assert.equal(board.totals.paidUsdc, "0.005000");
  const csv = paymentsCsv([board]).trim().split("\r\n");
  assert.equal(csv.length, 2);
  assert.ok(csv[1].includes(OUR_TX));
  // A second repair changes nothing (idempotent).
  const again = await repairSettled(board, async () => ({ tx: OUR_TX, amountAtomic: 5000n, round: ROUND, roundTime: RTIME }));
  assert.equal(again.changed.length, 0);
});
