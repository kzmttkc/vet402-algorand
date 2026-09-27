/**
 * Delivery board: candidate selection, cap stop, resume, HTML escaping, free routes.
 * Offline: every seller, facilitator and indexer is faked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2, USDC_MAINNET_ASA_ID } from "@x402/avm";
import type { FacilitatorClient } from "@x402/core/server";
import {
  buildRequest,
  resumeState,
  runSweep,
  selectCandidates,
  totalsOf,
  withInput,
  type BazaarItem,
  type Candidate,
  type SelectOptions,
} from "../scripts/board-sweep.js";
import { boardHtml, parseBoard, type BoardFile, type BoardRow } from "../src/board.js";
import { probe, type ProbeDeps, type ProbeResult } from "../src/probe.js";
import { SpendLedger } from "../src/caps.js";
import { LocalSpendGuard } from "../src/spend.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";

const NET = ALGORAND_MAINNET_CAIP2;
const USDC = String(USDC_MAINNET_ASA_ID);
const OWN_PAYTO = "RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q";
const OWN_PAYER = "OZ3KMLALTO67BZLYLCZOT7IJBGN7JTO5A3MJHI2267EKQDASFKS52KU6VY";
const NOW = new Date("2026-09-27T12:00:00Z");
const TX1 = "BALSINECFVZ47IP7QDRJYIRIC6YROXVEEXHU5WESVTWTHDQVTCEA";

function item(url: string, amount: string, o: Partial<BazaarItem> & { payTo?: string; network?: string } = {}): BazaarItem {
  return {
    resourceUrl: url,
    method: o.method ?? "GET",
    accepts: [{ scheme: "exact", network: o.network ?? NET, asset: USDC, amount, payTo: o.payTo ?? "SELLER" }],
    lastSeen: o.lastSeen ?? "2026-09-26T00:00:00Z",
    discoveryInfo: o.discoveryInfo,
    settleCount: o.settleCount,
    description: o.description,
  };
}

const opts = (over: Partial<SelectOptions> = {}): SelectOptions => ({
  network: NET,
  usdcAsaId: USDC,
  maxPerCallAtomic: 100_000n,
  now: NOW,
  maxAgeDays: 7,
  ownAddresses: [OWN_PAYTO, OWN_PAYER],
  allowPrivate: false,
  perHost: true,
  ...over,
});

test("selection: one per host (the cheapest), own host/address, price cap, stale, http excluded", () => {
  const items = [
    item("https://a.example/one", "20000"),
    item("https://a.example/two", "5000"),
    item("https://b.example/x", "10000"),
    item("https://vet402-algorand.vercel.app/v1/check", "50000", { payTo: "SOMEONE" }),
    item("https://api.vet402.com/v1/check", "1000", { payTo: "SOMEONE" }),
    item("https://c.example/pays-us", "1000", { payTo: OWN_PAYER }),
    item("https://d.example/pricey", "100001"),
    item("https://e.example/old", "1000", { lastSeen: "2026-09-19T11:59:00Z" }),
    item("https://e2.example/no-lastseen", "1000", { lastSeen: "" }),
    item("http://f.example/plain", "1000"),
    item("https://g.example/testnet", "1000", { network: ALGORAND_TESTNET_CAIP2 }),
  ];
  const { candidates, excluded } = selectCandidates(items, opts());
  assert.deepEqual(
    candidates.map((c) => c.url),
    ["https://a.example/two", "https://b.example/x"],
  );
  assert.equal(excluded.own_host, 2);
  assert.equal(excluded.own_address, 1);
  assert.equal(excluded.price_over_cap, 1);
  assert.equal(excluded.stale, 2);
  assert.equal(excluded.not_https, 1);
  assert.equal(excluded.other_network_or_asset, 1);
  assert.equal(excluded.not_cheapest_on_host, 1);
  for (const c of candidates) {
    assert.ok(!c.host.includes("vet402"));
    assert.ok(c.payTo !== OWN_PAYER && c.payTo !== OWN_PAYTO);
  }
});

test("selection: price exactly at the cap is kept; census keeps every resource and ignores lastSeen", () => {
  const items = [item("https://a.example/one", "100000"), item("https://a.example/two", "5000", { lastSeen: "2026-01-01T00:00:00Z" })];
  assert.equal(selectCandidates(items, opts({ perHost: true, maxAgeDays: 7 })).candidates.length, 1);
  const census = selectCandidates(items, opts({ perHost: false, maxAgeDays: null }));
  assert.deepEqual(
    census.candidates.map((c) => c.url),
    ["https://a.example/two", "https://a.example/one"],
  );
});

test("selection: the same URL is bought once", () => {
  const items = [item("https://a.example/x", "1000"), item("https://a.example/x", "1000")];
  const r = selectCandidates(items, opts({ perHost: false }));
  assert.equal(r.candidates.length, 1);
  assert.equal(r.excluded.duplicate_url, 1);
});

test("request: seller's own example input (query, JSON body); PUT and path templates are not probed", () => {
  const q = buildRequest(item("https://a.example/p", "1", { discoveryInfo: { input: { method: "GET", queryParams: { pair: "BTC-USDC", n: 2, o: { nested: 1 } } } } }));
  assert.ok(q.ok && q.url === "https://a.example/p?pair=BTC-USDC&n=2");
  const nested = buildRequest(
    item("https://a.example/n", "1", { discoveryInfo: { input: { queryParams: { type: "http", method: "GET", queryParams: { period: { type: "string", example: "daily" } } } } } }),
  );
  assert.ok(nested.ok && nested.url === "https://a.example/n?period=daily");
  const p = buildRequest(item("https://a.example/post", "1", { method: "POST", discoveryInfo: { input: { method: "POST", bodyType: "json", body: { text: "hi" } } } }));
  assert.ok(p.ok && p.method === "POST" && p.body === '{"text":"hi"}' && p.contentType === "application/json");
  assert.deepEqual(buildRequest(item("https://a.example/put", "1", { method: "PUT", discoveryInfo: { input: { method: "PUT" } } })), { ok: false, reason: "method_not_probed" });
  assert.deepEqual(buildRequest(item("https://a.example/u/{id}", "1")), { ok: false, reason: "path_params" });
  assert.deepEqual(buildRequest(item("https://a.example/f", "1", { discoveryInfo: { input: { method: "POST", bodyType: "form-data", body: {} } } })), { ok: false, reason: "body_not_json" });
});

test("withInput: method and body reach both the unpaid look and the paid request", async () => {
  const seen: RequestInit[] = [];
  const deps: ProbeDeps = {
    fetchImpl: async (_u, init) => {
      seen.push(init);
      return new Response("", { status: 402 });
    },
    paidFetch: async (_u, _a, init) => {
      seen.push(init);
      return { response: new Response("{}"), settle: null, signed: false };
    },
  };
  const c: Candidate = { key: "POST https://a.example/p", url: "https://a.example/p", host: "a.example", method: "POST", body: '{"a":1}', contentType: "application/json", input: "" };
  const w = withInput(deps, c);
  await w.fetchImpl(c.url, { method: "GET", redirect: "manual" });
  await w.paidFetch(c.url, { scheme: "exact", network: NET, asset: USDC, amount: "1", payTo: "S" }, { method: "GET", redirect: "manual" });
  for (const i of seen) {
    assert.equal(i.method, "POST");
    assert.equal(i.body, '{"a":1}');
    assert.equal(i.redirect, "manual");
  }
});

const cand = (n: number, price = 10_000n): Candidate => ({
  key: `GET https://s${n}.example/x`,
  url: `https://s${n}.example/x`,
  host: `s${n}.example`,
  method: "GET",
  input: "(none)",
  priceAtomic: price,
});

test("runSweep: stops at the first cap refusal; that one and the rest are SKIPPED daily_cap", async () => {
  let calls = 0;
  const results: ProbeResult[] = [
    { verdict: "ALLOW", reason: "delivered", target: "x", downstreamPayment: { success: true, transaction: TX1 }, price: { amountAtomic: "10000", usdc: "0.010000", payTo: "S", network: NET, asset: USDC } },
    { verdict: "REFUSE", reason: "daily_cap_reached", target: "x", detail: "spent 10000 + price 10000 > daily cap 15000" },
  ];
  const rows = await runSweep([cand(1), cand(2), cand(3), cand(4)], { probeOne: async () => results[calls++] });
  assert.equal(calls, 2, "no seller is contacted after the cap is hit");
  assert.deepEqual(
    rows.map((r) => [r.verdict, r.reason]),
    [
      ["ALLOW", "delivered"],
      ["SKIPPED", "daily_cap"],
      ["SKIPPED", "daily_cap"],
      ["SKIPPED", "daily_cap"],
    ],
  );
  assert.equal(rows[0].tx, TX1);
  assert.equal(rows[0].paid, true);
  assert.equal(totalsOf(rows).paidUsdc, "0.010000");
});

test("runSweep + real probe(): the daily cap in caps.ts stops the sweep before a second payment", async () => {
  const cfg = loadConfig({});
  const pr = (payTo: string) => ({
    x402Version: 2,
    resource: { url: "https://s.example/x", description: "forecast", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: cfg.network, asset: cfg.usdcAsaId, amount: "10000", payTo, maxTimeoutSeconds: 60, extra: {} }],
    extensions: { bazaar: { info: { output: { type: "json", example: { forecast: "sunny" } } } } },
  });
  let looks = 0;
  let pays = 0;
  const deps: ProbeDeps = {
    fetchImpl: async () => {
      looks++;
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr("SELLER"))).toString("base64") } });
    },
    paidFetch: async () => {
      pays++;
      return {
        response: new Response(JSON.stringify({ forecast: "sunny" }), { status: 200, headers: { "content-type": "application/json" } }),
        settle: { success: true, transaction: TX1, network: cfg.network },
        signed: true,
      };
    },
    resolveHost: async () => ["93.184.216.34"],
  };
  const guard = new LocalSpendGuard(new SpendLedger(10_000n, 15_000n));
  const rows = await runSweep([cand(1), cand(2), cand(3)], { probeOne: (c) => probe(c.url, cfg, guard, deps), headroom: async () => ({ ok: true }) });
  assert.equal(pays, 1);
  assert.equal(looks, 2);
  assert.deepEqual(
    rows.map((r) => `${r.verdict}:${r.reason}`),
    ["ALLOW:delivered", "SKIPPED:daily_cap", "SKIPPED:daily_cap"],
  );
});

test("runSweep: no headroom at start = nothing is probed", async () => {
  let calls = 0;
  const rows = await runSweep([cand(1), cand(2)], {
    probeOne: async () => {
      calls++;
      throw new Error("must not be called");
    },
    headroom: async () => ({ ok: false, reason: "cap_check_unavailable", detail: "indexer 503" }),
  });
  assert.equal(calls, 0);
  assert.deepEqual(
    rows.map((r) => r.reason),
    ["cap_check_unavailable", "cap_check_unavailable"],
  );
});

test("runSweep with concurrency never probes the same candidate twice and skips done keys", async () => {
  const seen: string[] = [];
  const cs = Array.from({ length: 10 }, (_, i) => cand(i));
  const rows = await runSweep(cs, {
    concurrency: 3,
    done: new Set([cs[0].key, cs[5].key]),
    probeOne: async (c) => {
      seen.push(c.key);
      await new Promise((r) => setTimeout(r, 1));
      return { verdict: "REFUSE", reason: "not_x402", target: c.url };
    },
  });
  assert.equal(seen.length, 8);
  assert.equal(new Set(seen).size, 8);
  assert.ok(!seen.includes(cs[0].key) && !seen.includes(cs[5].key));
  assert.equal(rows.length, 8);
});

test("resume: bought rows are not bought again; cap-skipped rows are retried; a crash mid-purchase is not retried", () => {
  const row = (url: string, verdict: BoardRow["verdict"], reason: string): BoardRow => ({ at: "", url, host: "", method: "GET", verdict, reason, paid: verdict !== "SKIPPED" });
  const r = resumeState({
    rows: [row("https://a/x", "ALLOW", "delivered"), row("https://b/x", "SKIPPED", "daily_cap")],
    attempts: ["GET https://a/x", "GET https://b/x", "GET https://c/x"],
  });
  assert.ok(r.done.has("GET https://a/x"));
  assert.ok(!r.done.has("GET https://b/x"));
  assert.ok(r.done.has("GET https://c/x"));
  assert.deepEqual(r.interrupted, ["GET https://c/x"]);
});

function board(rows: Partial<BoardRow>[], over: Partial<BoardFile> = {}): BoardFile {
  const full = rows.map((r) => ({ at: "2026-09-27T01:02:03Z", url: "https://s.example/x", host: "s.example", method: "GET", verdict: "ALLOW", reason: "delivered", paid: true, ...r }) as BoardRow);
  return { version: 1, network: NET, networkName: "mainnet", date: "2026-09-27", startedAt: "", finishedAt: "", totals: totalsOf(full), rows: full, ...over };
}

test("HTML: every seller-controlled string is escaped; tx links only for real tx ids", () => {
  const evil = `https://s.example/x?q=<script>alert(1)</script>&"'`;
  const html = boardHtml(
    board([
      { url: evil, reason: `"><img src=x onerror=alert(1)>`, detail: "</script><script>alert(2)</script>", tx: TX1, declared: { description: "<b>bold</b>" } },
      { verdict: "REFUSE", reason: "delivery_missing_keys", tx: "javascript:alert(1)", paid: false },
    ]),
  );
  assert.ok(!html.includes("<script>alert"), "raw script from data");
  assert.ok(!html.includes("<img src=x"), "raw img from data");
  assert.ok(!html.includes("<b>bold</b>"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes(`https://allo.info/tx/${TX1}`));
  assert.ok(!html.includes("javascript:alert"));
  // The embedded JSON cannot close its <script> element.
  const json = html.slice(html.indexOf('id="rows">') + 10, html.indexOf("</script>", html.indexOf('id="rows">')));
  assert.ok(!json.includes("<"));
  assert.equal(JSON.parse(json)[0].detail, "</script><script>alert(2)</script>");
  // Method paragraph, no external scripts.
  assert.ok(html.includes("with its own money"));
  assert.ok(html.includes("One result does not rate a seller"));
  assert.ok(html.includes("github.com/kzmttkc/vet402-algorand/issues"));
  assert.ok(!/<script[^>]+src=/.test(html));
});

test("HTML: three colors for ALLOW / REFUSE / SKIPPED; a light only for paid rows; empty board says not run yet", () => {
  const html = boardHtml(
    board([
      { verdict: "ALLOW", reason: "delivered", tx: TX1, paid: true },
      { verdict: "REFUSE", reason: "delivery_missing_keys", tx: TX1, paid: true },
      { verdict: "SKIPPED", reason: "daily_cap", paid: false },
    ]),
  );
  assert.ok(html.includes("fill:var(--allow)") && html.includes("fill:var(--refuse)") && html.includes("fill:var(--skip)"));
  assert.equal((html.match(/class="pulse"/g) ?? []).length, 2);
  assert.ok(html.includes("prefers-reduced-motion"));
  const empty = boardHtml(null);
  assert.ok(empty.includes("Not run yet"));
  assert.ok(!empty.includes('class="node"'));
  assert.equal(parseBoard("not json"), null);
});

function fakeFacilitator(calls: string[]): FacilitatorClient {
  const N = ALGORAND_TESTNET_CAIP2 as `${string}:${string}`;
  return {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: N, extra: { feePayer: "FEEPAYER" } }], extensions: [], signers: {} };
    },
    async verify() {
      calls.push("verify");
      return { isValid: true, payer: "C" };
    },
    async settle() {
      calls.push("settle");
      return { success: true, transaction: "T", network: N, payer: "C" };
    },
  };
}

test("routes: /board, /board.json and the census view are free (no 402, facilitator never called)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "board-"));
  writeFileSync(join(dir, "latest.json"), JSON.stringify(board([{ verdict: "ALLOW", tx: TX1 }])));
  writeFileSync(join(dir, "census-latest.json"), JSON.stringify(board([{ verdict: "REFUSE", reason: "not_json" }, { verdict: "SKIPPED", reason: "daily_cap", paid: false }])));
  const prev = process.env.BOARD_FILE;
  process.env.BOARD_FILE = join(dir, "latest.json");
  try {
    const calls: string[] = [];
    const cfg = loadConfig({ ALLOW_PRIVATE_TARGETS: "1" });
    const guard = new LocalSpendGuard(new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic));
    const probeDeps: ProbeDeps = {
      fetchImpl: async () => assert.fail("seller must not be contacted"),
      paidFetch: async () => assert.fail("seller must not be paid"),
    };
    const app = createApp(cfg, { payTo: "VET402PAYTO", probeDeps, guard, facilitator: fakeFacilitator(calls) });

    const h = await app.request("/board");
    assert.equal(h.status, 200);
    assert.equal(h.headers.get("PAYMENT-REQUIRED"), null);
    assert.match(h.headers.get("content-type") ?? "", /text\/html/);
    assert.ok((await h.text()).includes("1 ALLOW"));

    const j = await app.request("/board.json");
    assert.equal(j.status, 200);
    assert.equal(((await j.json()) as BoardFile).rows[0].tx, TX1);

    const cj = await app.request("/board.json?view=census");
    assert.equal(((await cj.json()) as BoardFile).rows.length, 2);
    const ch = await (await app.request("/board?view=census")).text();
    assert.ok(ch.includes("1 REFUSE") && ch.includes("1 skipped"));

    assert.deepEqual(calls, []);
    // The paid route is still paid.
    assert.equal((await app.request("/v1/check?url=http://localhost:4031/honest")).status, 402);
  } finally {
    if (prev === undefined) delete process.env.BOARD_FILE;
    else process.env.BOARD_FILE = prev;
  }
});
