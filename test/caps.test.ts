import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpendLedger } from "../src/caps.js";
import { usdcToAtomic, atomicToUsdc, loadConfig } from "../src/config.js";

test("usdc conversions", () => {
  assert.equal(usdcToAtomic("0.05"), 50_000n);
  assert.equal(usdcToAtomic("$1"), 1_000_000n);
  assert.equal(atomicToUsdc(5_000n), "0.005000");
  assert.throws(() => usdcToAtomic("0.0000001"));
  assert.throws(() => usdcToAtomic("-1"));
});

test("price_over_cap: per-call cap refuses and records nothing", () => {
  const l = new SpendLedger(40_000n, 1_000_000n);
  const d = l.reserve(500_000n);
  assert.equal(d.ok, false);
  assert.equal(!d.ok && d.reason, "price_over_cap");
  assert.equal(l.spentTodayAtomic(), 0n);
  assert.equal(l.reserve(40_000n).ok, true); // exactly at cap is allowed
});

test("daily_cap_reached after cumulative spend", () => {
  const l = new SpendLedger(40_000n, 100_000n);
  assert.equal(l.reserve(40_000n).ok, true);
  assert.equal(l.reserve(40_000n).ok, true);
  const d = l.reserve(40_000n);
  assert.equal(!d.ok && d.reason, "daily_cap_reached");
  assert.equal(l.spentTodayAtomic(), 80_000n);
});

test("release gives budget back only for unsigned attempts; commit keeps it", () => {
  const l = new SpendLedger(40_000n, 40_000n);
  const a = l.reserve(40_000n);
  assert.ok(a.ok);
  if (a.ok) l.release(a.reservationId);
  assert.equal(l.spentTodayAtomic(), 0n);
  const b = l.reserve(40_000n);
  if (b.ok) l.commit(b.reservationId);
  if (b.ok) l.release(b.reservationId); // no-op after commit
  assert.equal(l.spentTodayAtomic(), 40_000n);
});

test("daily budget resets on a new UTC day", () => {
  let now = new Date("2026-09-27T23:59:00Z");
  const l = new SpendLedger(40_000n, 40_000n, undefined, () => now);
  assert.ok(l.reserve(40_000n).ok);
  assert.equal(l.reserve(1n).ok, false);
  now = new Date("2026-09-28T00:00:01Z");
  assert.ok(l.reserve(40_000n).ok);
});

test("ledger persists across restarts and fails closed on corruption", () => {
  const dir = mkdtempSync(join(tmpdir(), "vet402-ledger-"));
  const f = join(dir, "spend.json");
  const a = new SpendLedger(40_000n, 100_000n, f);
  assert.ok(a.reserve(40_000n).ok);
  const b = new SpendLedger(40_000n, 100_000n, f);
  assert.equal(b.spentTodayAtomic(), 40_000n);
  writeFileSync(f, "{not json");
  const c = new SpendLedger(40_000n, 100_000n, f);
  assert.equal(c.reserve(1n).ok, false);
});

test("config: network defaults, mainnet lock, mainnet payTo and caps", () => {
  assert.throws(() => loadConfig({ PROBE_MAX_PER_CALL_USDC: "2", PROBE_MAX_PER_DAY_USDC: "1" }));
  assert.throws(() => loadConfig({ X402_NETWORK: "mainnet" }), /locked/);
  const c = loadConfig({});
  assert.equal(c.networkName, "testnet");
  assert.equal(c.usdcAsaId, "10458941");
  assert.equal(c.maxPerCallAtomic, 40_000n);
  assert.equal(c.indexerUrl, "https://testnet-idx.algonode.cloud");
  const m = loadConfig({ X402_NETWORK: "mainnet", I_UNDERSTAND_MAINNET_MOVES_REAL_FUNDS: "yes" });
  assert.equal(m.usdcAsaId, "31566704");
  assert.equal(m.payTo, "RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q");
  assert.equal(m.maxPerCallAtomic, 100_000n);
  assert.equal(m.maxPerDayAtomic, 3_000_000n);
  assert.equal(m.checkPriceUsdc, "0.05");
  assert.equal(m.indexerUrl, "https://mainnet-idx.algonode.cloud");
  assert.throws(() => loadConfig({ X402_NETWORK: "mainnet", I_UNDERSTAND_MAINNET_MOVES_REAL_FUNDS: "yes", ALLOW_PRIVATE_TARGETS: "1" }));
  const m2 = loadConfig({ X402_NETWORK: "mainnet", I_UNDERSTAND_MAINNET_MOVES_REAL_FUNDS: "yes", PROBE_MAX_PER_CALL_USDC: "0.2", PROBE_MAX_PER_DAY_USDC: "5", VERCEL: "1" });
  assert.equal(m2.maxPerCallAtomic, 200_000n);
  assert.equal(m2.maxPerDayAtomic, 5_000_000n);
  assert.equal(m2.spendLedgerFile, undefined);
});
