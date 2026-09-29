/**
 * Once a day: several schedules a day (board.yml), and only the first run that finishes the daily buys.
 * A later run the same UTC day finds completedAt in today's file, buys nothing, and only repeats the
 * payment check (read-only). Offline: every network call is faked and counted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dailyComplete, main, resumeState, runSweep, type Candidate } from "../scripts/board-sweep.js";
import type { ProbeResult } from "../src/probe.js";

test("dailyComplete: only a file with completedAt is done; a file a run left behind mid-way is not", () => {
  assert.equal(dailyComplete({ completedAt: "2026-09-30T06:20:11.000Z" }), true);
  assert.equal(dailyComplete({ attempts: ["GET https://s.test/a"] } as { completedAt?: unknown }), false);
  assert.equal(dailyComplete({ completedAt: "" }), false);
  assert.equal(dailyComplete(null), false);
});

test("a second daily run on the same UTC day buys nothing: no Bazaar read, no seller contacted, no signature; only the indexer is read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "daily-once-"));
  const today = new Date().toISOString().slice(0, 10);
  const row = { at: `${today}T06:18:00.000Z`, url: "https://s.test/a", host: "s.test", method: "GET", priceUsdc: "0.001000", payTo: "P", verdict: "ALLOW", reason: "delivered", paid: true, tx: "A".repeat(52) };
  const done = {
    version: 1,
    mode: "daily",
    network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
    networkName: "testnet",
    date: today,
    startedAt: `${today}T06:17:30.000Z`,
    finishedAt: `${today}T06:20:11.000Z`,
    completedAt: `${today}T06:20:11.000Z`,
    payer: "BOARDPAYER",
    totals: { rows: 1, allow: 1, refuse: 0, skipped: 0, unclear: 0, paidUsdc: "0.001000" },
    reconcile: { checkedAt: `${today}T06:20:30.000Z`, status: "ok", window: { from: "", to: "" }, transfers: 1, onRows: 1, recorded: [], unmatched: [] },
    rows: [row],
    attempts: ["GET https://s.test/a"],
  };
  const file = join(dir, `${today}.json`);
  writeFileSync(file, JSON.stringify(done, null, 2) + "\n");
  const before = readFileSync(file, "utf8");

  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    calls.push(u.href);
    // The board wallet's only transfer today is the one on the row.
    if (u.pathname.includes("/v2/accounts/")) return Response.json({ transactions: [{ id: row.tx, "tx-type": "axfer", sender: "BOARDPAYER", fee: 0, "confirmed-round": 5, "round-time": Math.floor(Date.parse(row.at) / 1000), "asset-transfer-transaction": { "asset-id": 10458941, amount: 1000, receiver: "P" } }] });
    throw new Error(`unexpected request ${u.href}`);
  }) as typeof fetch;
  try {
    process.env.X402_NETWORK = "testnet";
    delete process.env.BOARD_PAYER_MNEMONIC;
    delete process.env.PAYER_MNEMONIC;
    const code = await main(["--out", dir]);
    assert.equal(code, 0);
  } finally {
    globalThis.fetch = realFetch;
    process.env = env;
  }
  assert.ok(calls.length > 0);
  for (const c of calls) assert.match(c, /\/v2\/accounts\/BOARDPAYER\/transactions\?/, `only the indexer is read: ${c}`);
  // Nothing bought, nothing new written: the file is byte for byte the same.
  assert.equal(readFileSync(file, "utf8"), before);
});

test("a run that stopped mid-way is resumed, and what it already attempted today is not bought again", async () => {
  const cands: Candidate[] = ["a", "b", "c"].map((p) => ({ key: `GET https://${p}.test/x`, url: `https://${p}.test/x`, host: `${p}.test`, method: "GET", input: "(none)", priceAtomic: 1000n, payTo: "P" }));
  const partial = {
    rows: [{ at: "2026-09-30T06:18:00.000Z", url: "https://a.test/x", host: "a.test", method: "GET", verdict: "ALLOW" as const, reason: "delivered", paid: true, tx: "A".repeat(52) }],
    attempts: ["GET https://a.test/x", "GET https://b.test/x"],
  };
  const { done, interrupted } = resumeState(partial);
  assert.deepEqual(interrupted, ["GET https://b.test/x"]);
  const bought: string[] = [];
  await runSweep(cands, {
    done,
    probeOne: async (c): Promise<ProbeResult> => {
      bought.push(c.url);
      return { verdict: "ALLOW", reason: "delivered", target: c.url };
    },
  });
  assert.deepEqual(bought, ["https://c.test/x"]);
});
