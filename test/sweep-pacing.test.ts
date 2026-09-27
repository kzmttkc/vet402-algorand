/**
 * Census pacing: round-robin order by host, never two purchases in flight to one host,
 * at least the gap between purchases from one host. Money rules (cap stop, once per key) still hold.
 * Offline: probeOne is faked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ALGORAND_MAINNET_CAIP2, USDC_MAINNET_ASA_ID } from "@x402/avm";
import { hostGapMs, interleaveByHost, MIN_HOST_GAP_MS, runSweep, selectCandidates, type BazaarItem, type Candidate } from "../scripts/board-sweep.js";
import { readBoard } from "../src/board.js";
import { usdcToAtomic } from "../src/config.js";
import type { ProbeResult } from "../src/probe.js";

const NET = ALGORAND_MAINNET_CAIP2;
const USDC = String(USDC_MAINNET_ASA_ID);
const TX1 = "BALSINECFVZ47IP7QDRJYIRIC6YROXVEEXHU5WESVTWTHDQVTCEA";

function cand(host: string, i: number, price = 1000n): Candidate {
  const url = `https://${host}/r${i}`;
  return { key: `GET ${url}`, url, host, method: "GET", input: "(none)", priceAtomic: price };
}

/** The 2026-09-27 census as candidates, in the old order (price, host, url). */
function censusCandidates(): Candidate[] | null {
  const b = readBoard(join(process.cwd(), "board", "census-2026-09-27.json"));
  if (!b) return null;
  const cs = b.rows.map((r) => ({
    key: `${r.method} ${r.url}`,
    url: r.url,
    host: r.host,
    method: r.method as "GET" | "POST",
    input: r.input ?? "",
    priceAtomic: usdcToAtomic(r.priceUsdc ?? "0"),
  }));
  return cs.sort((a, b) => (a.priceAtomic < b.priceAtomic ? -1 : a.priceAtomic > b.priceAtomic ? 1 : a.host.localeCompare(b.host) || a.url.localeCompare(b.url)));
}

/** Index from which only one host remains (the tail). */
function tailStart<T extends { host: string }>(xs: T[]): number {
  let i = xs.length - 1;
  while (i > 0 && xs[i - 1].host === xs[xs.length - 1].host) i--;
  return i;
}

test("round-robin on the 1,819-row census: the same host is next to itself only in the final tail; nothing lost; each host keeps its order", () => {
  const cs = censusCandidates();
  if (!cs) return; // data file absent
  assert.equal(cs.length, 1819);
  const out = interleaveByHost(cs);
  assert.equal(out.length, 1819);
  assert.deepEqual(new Set(out.map((c) => c.key)).size, 1819);
  assert.deepEqual([...out.map((c) => c.key)].sort(), [...cs.map((c) => c.key)].sort());
  const t = tailStart(out);
  let adjacentBeforeTail = 0;
  for (let i = 1; i < t; i++) if (out[i].host === out[i - 1].host) adjacentBeforeTail++;
  assert.equal(adjacentBeforeTail, 0, "no host next to itself before the tail");
  // The tail is the largest host's remainder after every other host ran out.
  const counts = new Map<string, number>();
  for (const c of cs) counts.set(c.host, (counts.get(c.host) ?? 0) + 1);
  const sorted = [...counts.values()].sort((a, b) => b - a);
  assert.equal(out.length - t, sorted[0] - sorted[1], "tail = largest host minus the second largest");
  // Per-host order (cheapest first) is unchanged.
  for (const h of counts.keys()) {
    assert.deepEqual(
      out.filter((c) => c.host === h).map((c) => c.key),
      cs.filter((c) => c.host === h).map((c) => c.key),
    );
  }
  console.log(`  census order: 1819 rows, ${counts.size} hosts, tail ${out.length - t} × ${out[out.length - 1].host}, adjacent before tail 0`);
});

test("selectCandidates: census is round-robin by host; daily is unchanged (one per host)", () => {
  const item = (url: string, amount: string): BazaarItem => ({
    resourceUrl: url,
    accepts: [{ scheme: "exact", network: NET, asset: USDC, amount, payTo: "SELLER" }],
    lastSeen: "2026-09-26T00:00:00Z",
  });
  const items = [item("https://a.example/1", "1000"), item("https://a.example/2", "1000"), item("https://a.example/3", "2000"), item("https://b.example/1", "3000"), item("https://c.example/1", "1500")];
  const o = { network: NET, usdcAsaId: USDC, maxPerCallAtomic: 100_000n, now: new Date("2026-09-27T12:00:00Z"), maxAgeDays: null, ownAddresses: [], allowPrivate: false };
  const census = selectCandidates(items, { ...o, perHost: false }).candidates.map((c) => c.url);
  assert.deepEqual(census, ["https://a.example/1", "https://c.example/1", "https://b.example/1", "https://a.example/2", "https://a.example/3"]);
  const daily = selectCandidates(items, { ...o, perHost: true }).candidates.map((c) => c.url);
  assert.deepEqual(daily, ["https://a.example/1", "https://c.example/1", "https://b.example/1"]);
});

test("runSweep on the 1,819-row census with concurrency 3: every row probed once, never two in flight to one host", async () => {
  const cs = censusCandidates();
  if (!cs) return;
  const order = interleaveByHost(cs);
  const inflight = new Map<string, number>();
  let maxSameHost = 0;
  let maxTotal = 0;
  let total = 0;
  const seen = new Set<string>();
  const rows = await runSweep(order, {
    concurrency: 3,
    probeOne: async (c) => {
      assert.ok(!seen.has(c.key), "never twice");
      seen.add(c.key);
      const n = (inflight.get(c.host) ?? 0) + 1;
      inflight.set(c.host, n);
      total++;
      maxSameHost = Math.max(maxSameHost, n);
      maxTotal = Math.max(maxTotal, total);
      await new Promise((r) => setImmediate(r));
      inflight.set(c.host, n - 1);
      total--;
      return { verdict: "REFUSE", reason: "not_x402", target: c.url, detail: "expected 402, got 404" };
    },
  });
  assert.equal(rows.length, 1819);
  assert.equal(seen.size, 1819);
  assert.equal(maxSameHost, 1, "same-host concurrency is 0 (at most one in flight per host)");
  assert.equal(maxTotal, 3, "different hosts still run in parallel");
});

test("runSweep: purchases from one host are at least the gap apart (end → next start); other hosts are not held up", async () => {
  const gap = 40;
  const cs = interleaveByHost([cand("a.example", 1), cand("a.example", 2), cand("a.example", 3), cand("b.example", 1), cand("b.example", 2), cand("c.example", 1)]);
  const log: { host: string; start: number; end: number }[] = [];
  const t0 = Date.now();
  await runSweep(cs, {
    concurrency: 3,
    hostGapMs: gap,
    probeOne: async (c) => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 5));
      log.push({ host: c.host, start, end: Date.now() });
      return { verdict: "REFUSE", reason: "not_x402", target: c.url };
    },
  });
  assert.equal(log.length, 6);
  for (const h of ["a.example", "b.example"]) {
    const xs = log.filter((x) => x.host === h).sort((p, q) => p.start - q.start);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i].start - xs[i - 1].end >= gap - 1, `${h}: ${xs[i].start - xs[i - 1].end} ms < ${gap}`);
  }
  // c.example has one purchase and starts right away, not after a's gap.
  assert.ok(log.find((x) => x.host === "c.example")!.start - t0 < gap);
});

test("runSweep with pacing: the cap stop still stops everything; the rest are SKIPPED daily_cap and nothing is bought twice", async () => {
  const cs = interleaveByHost([
    ...Array.from({ length: 5 }, (_, i) => cand("a.example", i)),
    ...Array.from({ length: 3 }, (_, i) => cand("b.example", i)),
    cand("c.example", 0),
  ]);
  const probed: string[] = [];
  const rows = await runSweep(cs, {
    concurrency: 3,
    hostGapMs: 10,
    done: new Set([cs[0].key]),
    probeOne: async (c): Promise<ProbeResult> => {
      probed.push(c.key);
      if (probed.length === 1) return { verdict: "ALLOW", reason: "delivered", target: c.url, downstreamPayment: { success: true, transaction: TX1 } };
      return { verdict: "REFUSE", reason: "daily_cap_reached", target: c.url, detail: "spent + price > cap" };
    },
  });
  assert.equal(new Set(probed).size, probed.length, "never twice");
  assert.ok(!probed.includes(cs[0].key), "done keys are not bought again");
  assert.ok(probed.length <= 3, `after the cap refusal no new purchase starts (probed ${probed.length})`);
  assert.equal(rows.length, cs.length - 1, "one row per pending candidate");
  assert.equal(rows.filter((r) => r.verdict === "ALLOW").length, 1);
  assert.ok(rows.filter((r) => r.verdict === "SKIPPED").every((r) => r.reason === "daily_cap"));
  assert.equal(rows.filter((r) => r.verdict === "SKIPPED").length, cs.length - 2);
});

test("--host-gap-ms: at least 2 s; a larger value is kept; junk falls back to 2 s", () => {
  assert.equal(MIN_HOST_GAP_MS, 2000);
  assert.equal(hostGapMs([]), 2000);
  assert.equal(hostGapMs(["--host-gap-ms", "500"]), 2000);
  assert.equal(hostGapMs(["--host-gap-ms", "5000"]), 5000);
  assert.equal(hostGapMs(["--host-gap-ms", "abc"]), 2000);
});
