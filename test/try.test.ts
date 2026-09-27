/**
 * /try: the landing page's first line, the free preview (never charges, never pays, never sends a
 * customer body, 30 per minute per IP), and "Try vet402 (free, once per person)": one trial per IP /
 * address, the trial wallet's daily cap, every probe guard, and /activity counting trials apart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALGORAND_TESTNET_CAIP2 } from "@x402/avm";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/server.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { SpendLedger } from "../src/caps.js";
import { LocalSpendGuard } from "../src/spend.js";
import type { ProbeDeps } from "../src/probe.js";
import type { BoardFile, BoardRow } from "../src/board.js";
import { MemoryTrialStore, claimKeys } from "../src/trial.js";
import type { TrialDeps } from "../src/try.js";
import { sellerOptions } from "../src/try.js";
import { ActivityLedger } from "../src/activity.js";
import { landingHtml } from "../src/landing.js";

const NET = ALGORAND_TESTNET_CAIP2;
const ASA = "10458941";
const VET402 = "VETPAYTOVETPAYTOVETPAYTOVETPAYTOVETPAYTOVETPAYTOVETPAYTOVE";
const PAYER = "VETPAYERVETPAYERVETPAYERVETPAYERVETPAYERVETPAYERVETPAYERVE";
const TRIAL = "TRIALTRIALTRIALTRIALTRIALTRIALTRIALTRIALTRIALTRIALTRIALTRI";
const SELLER = "SELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELL";
const HOST = "http://localhost:4031";
const ALGO_ADDR = "JJCAA6JLV5XWPQRGNHVWGRUS5KM4JHTAFHQL7XGMAIHQPY6BX63CCHWCH4";

function facilitator(trace: string[]): FacilitatorClient {
  const N = NET as `${string}:${string}`;
  return {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: N, extra: { feePayer: "FEEPAYER" } }], extensions: [], signers: {} };
    },
    async verify() {
      trace.push("verify");
      return { isValid: true, payer: "CUSTOMER" };
    },
    async settle() {
      trace.push("settle");
      return { success: true, transaction: "CUSTOMER_TX", network: N, payer: "CUSTOMER" };
    },
  };
}

interface Seen {
  looks: { url: string; init: RequestInit }[];
  mainPaid: string[];
  trialPaid: string[];
}

function sellerDeps(seen: Seen, o: { amount?: (path: string) => string; payTo?: string } = {}): ProbeDeps {
  const pr = (path: string) => ({
    x402Version: 2,
    resource: { url: `${HOST}${path}`, description: "Tokyo forecast", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: NET, asset: ASA, amount: o.amount?.(path) ?? "10000", payTo: o.payTo ?? SELLER, maxTimeoutSeconds: 60, extra: {} }],
    extensions: {
      bazaar: {
        info: { output: { type: "json", example: { forecast: "sunny", temperature: 21 } } },
        schema: { properties: { output: { properties: { example: { type: "object", required: ["forecast", "temperature"] } } } } },
      },
    },
  });
  return {
    ownAddresses: [VET402, PAYER],
    fetchImpl: async (url, init) => {
      seen.looks.push({ url, init });
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr(new URL(url).pathname))).toString("base64") } });
    },
    paidFetch: async (url) => {
      seen.mainPaid.push(url);
      throw new Error("the main payer must not pay in /try");
    },
  };
}

function trialPaidFetch(seen: Seen): ProbeDeps["paidFetch"] {
  return async (url) => {
    seen.trialPaid.push(url);
    return {
      response: new Response('{"forecast":"sunny","temperature":21,"city":"Tokyo"}', { status: 200, headers: { "content-type": "application/json" } }),
      settle: { success: true, transaction: "SELLERTXSELLERTXSELLERTXSELLERTXSELLERTXSELLERTXSELLE", network: NET },
      signed: true,
    };
  };
}

const row = (url: string, extra: Partial<BoardRow> = {}): BoardRow => ({
  at: "2026-09-27T04:40:00.000Z",
  url,
  host: new URL(url).host,
  method: "GET",
  priceUsdc: "0.010000",
  verdict: "ALLOW",
  reason: "delivered",
  paid: true,
  tx: "OVX5XV6MZ2MEWUTQIOB7RVRUVFRIE6O5XOCQ4ZNJ7ELMTMA6JFSQ",
  ...extra,
});
const board = (rows: BoardRow[]): BoardFile => ({
  version: 1,
  network: "algorand:mainnet",
  networkName: "mainnet",
  date: "2026-09-27",
  startedAt: "",
  finishedAt: "",
  totals: { rows: rows.length, allow: 0, refuse: 0, skipped: 0, paidUsdc: "0" },
  rows,
});

const baseCfg = (env: NodeJS.ProcessEnv = {}): AppConfig => loadConfig({ ALLOW_PRIVATE_TARGETS: "1", ...env });

function setup(o: { trial?: boolean; perDay?: bigint; amount?: (path: string) => string; payTo?: string; census?: BoardRow[] } = {}) {
  const cfg = baseCfg();
  const trace: string[] = [];
  const seen: Seen = { looks: [], mainPaid: [], trialPaid: [] };
  const store = new MemoryTrialStore();
  const hashKey = Buffer.alloc(32, 7);
  const trial: TrialDeps | undefined =
    o.trial === false
      ? undefined
      : {
          address: TRIAL,
          maxPerCallAtomic: 50_000n,
          maxPerDayAtomic: o.perDay ?? 3_000_000n,
          hashKey,
          store,
          guard: new LocalSpendGuard(new SpendLedger(50_000n, o.perDay ?? 3_000_000n)),
          paidFetch: trialPaidFetch(seen),
        };
  const census = board(o.census ?? [row(`${HOST}/honest`)]);
  // /try reads the board through the shared loader: point it at in-memory files.
  const app = createApp(cfg, {
    payTo: VET402,
    probeDeps: sellerDeps(seen, { amount: o.amount, payTo: o.payTo }),
    guard: new LocalSpendGuard(new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic)),
    facilitator: facilitator(trace),
    catalog: { items: async () => [] },
    trial,
    tryBoard: { load: async (f: string) => (f.endsWith("census-latest.json") ? census : null), file: "/nonexistent/latest.json" },
  });
  return { app, trace, seen, store, hashKey, cfg };
}

const preview = (app: ReturnType<typeof createApp>, url: string, ip = "203.0.113.1") =>
  app.request(`/try/preview?url=${encodeURIComponent(url)}`, { headers: { "x-real-ip": ip } });
const run = (app: ReturnType<typeof createApp>, body: unknown, ip = "203.0.113.1") =>
  app.request("/try/run", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) });

test("landing: the first sentence says what you get in plain words; title and og tags are unchanged", async () => {
  const html = landingHtml({ network: NET, priceUsdc: "0.05", perCallUsdc: "0.100000", perDayUsdc: "3.000000", trial: true });
  const h1 = /<h1>([^<]*)<\/h1>/.exec(html)?.[1] ?? "";
  assert.equal(h1, "Before your AI agent pays for an API, vet402 buys it with its own wallet and tells you if it actually delivered.");
  assert.doesNotMatch(h1, /x402|Algorand|USDC|ALLOW|REFUSE|endpoint/);
  assert.match(html, /<title>vet402<\/title>/);
  for (const tag of [
    '<meta property="og:site_name" content="vet402">',
    '<meta property="og:title" content="vet402 — pays the x402 endpoint you name and checks the delivery">',
    '<meta property="og:description" content="vet402 pays the x402 endpoint you name on Algorand, checks the delivery against what the seller declared, and returns ALLOW or REFUSE with both payment tx ids.">',
    '<meta property="og:image" content="https://vet402.com/icon.png">',
  ])
    assert.ok(html.includes(tag), tag);
  assert.match(html, /Try it in 3 steps/);
  for (const p of ["/v1/check", "/v1/buy", "/v1/verdict", "/v1/audit", "MCP", 'href="/board', 'href="/activity"', 'href="/demo"', "github.com/kzmttkc/vet402-algorand"]) assert.ok(html.includes(p), p);
  assert.doesNotMatch(html, /<script/); // no JS at all on the landing page
});

test("/try/preview is free: no 402, no payment, last result + today's price, and the seller only gets a plain GET", async () => {
  const { app, trace, seen } = setup();
  const res = await preview(app, `${HOST}/honest`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("PAYMENT-REQUIRED"), null);
  const j = (await res.json()) as { charged: boolean; last: { class: string; date: string; priceUsdc: string; sellerTxUrl: string }; buy: { ok: boolean; sellerPrice: { usdc: string }; fee: { usdc: string }; total: { amountAtomic: string; usdc: string } }; trial: { available: boolean } };
  assert.equal(j.charged, false);
  assert.equal(j.last.class, "DELIVERED");
  assert.equal(j.last.date, "2026-09-27");
  assert.equal(j.last.priceUsdc, "0.01");
  assert.match(j.last.sellerTxUrl, /^https:\/\/allo\.info\/tx\//);
  assert.equal(j.buy.ok, true);
  assert.equal(j.buy.total.amountAtomic, "15000"); // 0.01 + 0.005 fee: the same price as the unpaid /v1/buy 402
  assert.equal(j.trial.available, true);
  // The same price the unpaid /v1/buy asks.
  const b = await app.request(`/v1/buy?url=${encodeURIComponent(`${HOST}/honest`)}`);
  assert.equal(b.status, 402);
  assert.equal(JSON.parse(Buffer.from(b.headers.get("PAYMENT-REQUIRED")!, "base64").toString()).accepts[0].amount, "15000");
  assert.deepEqual(trace, []); // nothing verified, nothing settled
  assert.deepEqual([seen.mainPaid, seen.trialPaid], [[], []]);
  for (const l of seen.looks) {
    assert.equal(l.init.method, "GET");
    assert.equal(l.init.body, undefined);
  }
});

test("/try/preview for a URL vet402 never bought: no last result, still the price", async () => {
  const { app } = setup();
  const j = (await (await preview(app, `${HOST}/new-seller`)).json()) as { last: unknown; buy: { ok: boolean; total: { usdc: string } } };
  assert.equal(j.last, null);
  assert.equal(j.buy.ok, true);
  assert.equal(j.buy.total.usdc, "0.015000");
});

test("/try/preview: the 31st read in a minute from one IP is 429 (another IP is not affected)", async () => {
  const { app } = setup();
  for (let i = 1; i <= 30; i++) assert.equal((await preview(app, `${HOST}/honest`)).status, 200, `read ${i}`);
  const r31 = await preview(app, `${HOST}/honest`);
  assert.equal(r31.status, 429);
  assert.equal(((await r31.json()) as { charged: boolean }).charged, false);
  assert.equal((await preview(app, `${HOST}/honest`, "198.51.100.9")).status, 200);
});

test("/try and /try/sellers.json are free pages; the list puts DELIVERED first, cheapest first, and leaves out UNREACHABLE", async () => {
  const { app } = setup();
  const page = await app.request("/try");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Try it free/);
  const list = sellerOptions([
    board([
      row("https://a.example/x", { priceUsdc: "0.02" }),
      row("https://b.example/y", { priceUsdc: "0.001" }),
      row("https://c.example/z", { verdict: "REFUSE", reason: "delivery_missing_keys", paid: true, priceUsdc: "0.0001" }),
      row("https://d.example/gone", { verdict: "REFUSE", reason: "not_x402", detail: "expected 402, got 404", paid: false }),
    ]),
  ]);
  assert.deepEqual(
    list.map((s) => [s.u, s.c]),
    [
      ["https://b.example/y", "DELIVERED"],
      ["https://a.example/x", "DELIVERED"],
      ["https://c.example/z", "MISMATCH"],
    ],
  );
});

test("trial: vet402 pays once from the trial wallet; the same IP a second time is not paid", async () => {
  const { app, seen, trace } = setup();
  const first = await run(app, { url: `${HOST}/honest` });
  assert.equal(first.status, 200);
  const j = (await first.json()) as { class: string; paidBy: string; sellerTx: string; delivery: { summary: string }; bodyPreview: string };
  assert.equal(j.class, "DELIVERED");
  assert.equal(j.paidBy, TRIAL);
  assert.match(j.delivery.summary, /forecast/);
  assert.match(j.bodyPreview, /Tokyo/);
  assert.equal(seen.trialPaid.length, 1);
  assert.deepEqual(seen.mainPaid, []);
  assert.deepEqual(trace, []); // no customer payment exists in a trial

  const again = await run(app, { url: `${HOST}/honest` });
  assert.equal(again.status, 403);
  assert.equal(((await again.json()) as { error: string }).error, "already_tried");
  assert.equal(seen.trialPaid.length, 1);

  const log = (await (await app.request("/try/log.json")).json()) as { people: number; entries: { host: string; class: string }[] };
  assert.equal(log.people, 1);
  assert.deepEqual(log.entries.map((e) => [e.host, e.class]), [["localhost:4031", "DELIVERED"]]);
  const html = await (await app.request("/try/log")).text();
  assert.doesNotMatch(html, /203\.0\.113\.1|ip:/); // no IP and no hash on the public log
});

test("trial: an address already used counts as used from another IP too", async () => {
  const { app, seen } = setup();
  assert.equal((await run(app, { url: `${HOST}/honest`, address: ALGO_ADDR }, "203.0.113.5")).status, 200);
  const r = await run(app, { url: `${HOST}/honest`, address: ALGO_ADDR }, "203.0.113.6");
  assert.equal(r.status, 403);
  assert.equal(seen.trialPaid.length, 1);
  assert.equal((await run(app, { url: `${HOST}/honest`, address: "not-an-address" }, "203.0.113.7")).status, 400);
});

test("trial: the daily cap stops payment ('come back tomorrow'), and nothing is paid", async () => {
  const { app, seen } = setup({ perDay: 10_000n }); // exactly one 0.01 try per day
  assert.equal((await run(app, { url: `${HOST}/honest` }, "203.0.113.10")).status, 200);
  const r = await run(app, { url: `${HOST}/honest` }, "203.0.113.11");
  assert.equal(r.status, 503);
  const j = (await r.json()) as { error: string; detail: string };
  assert.equal(j.error, "daily_cap_reached");
  assert.match(j.detail, /Come back tomorrow/);
  assert.equal(seen.trialPaid.length, 1);
});

test("trial: a seller above 0.05, or one paying into a vet402 wallet, is refused before paying and the try is not used", async () => {
  const over = setup({ amount: (p) => (p === "/pricey" ? "60000" : "10000") });
  const r = await run(over.app, { url: `${HOST}/pricey` });
  assert.equal(r.status, 422);
  assert.equal(((await r.json()) as { reason: string }).reason, "price_over_cap");
  assert.equal(over.seen.trialPaid.length, 0);
  assert.equal((await run(over.app, { url: `${HOST}/honest` })).status, 200); // same IP: the refused one did not use the try

  for (const payTo of [VET402, PAYER, TRIAL]) {
    const self = setup({ payTo });
    const s = await run(self.app, { url: `${HOST}/honest` });
    assert.equal(s.status, 422, payTo);
    assert.equal(((await s.json()) as { reason: string }).reason, "self_dealing", payTo);
    assert.equal(self.seen.trialPaid.length, 0);
  }
});

test("trial: private targets are refused when not allowed, only POST /try/run with JSON runs a trial", async () => {
  const cfg = loadConfig({}); // private addresses not allowed
  const seen: Seen = { looks: [], mainPaid: [], trialPaid: [] };
  const app = createApp(cfg, {
    payTo: VET402,
    probeDeps: sellerDeps(seen),
    guard: new LocalSpendGuard(new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic)),
    facilitator: facilitator([]),
    catalog: { items: async () => [] },
    trial: { address: TRIAL, maxPerCallAtomic: 50_000n, maxPerDayAtomic: 3_000_000n, hashKey: Buffer.alloc(32), store: new MemoryTrialStore(), guard: new LocalSpendGuard(new SpendLedger(50_000n, 3_000_000n)), paidFetch: trialPaidFetch(seen) },
  });
  assert.equal((await run(app, { url: `${HOST}/honest` })).status, 400);
  const { app: a2, seen: s2 } = setup();
  assert.notEqual((await a2.request("/try/run", { method: "GET" })).status, 200);
  assert.notEqual((await a2.request("/try/run/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: `${HOST}/honest` }) })).status, 200);
  assert.equal((await a2.request("/try/run", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ url: `${HOST}/honest` }) })).status, 415);
  assert.equal(s2.trialPaid.length, 0);
  assert.equal(seen.trialPaid.length, 0);
});

test("trial wallet must be separate from vet402's payTo and payer", () => {
  const cfg = baseCfg();
  for (const address of [VET402, PAYER]) {
    assert.throws(() =>
      createApp(cfg, {
        payTo: VET402,
        probeDeps: sellerDeps({ looks: [], mainPaid: [], trialPaid: [] }),
        guard: new LocalSpendGuard(new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic)),
        facilitator: facilitator([]),
        trial: { address, maxPerCallAtomic: 50_000n, maxPerDayAtomic: 3_000_000n, hashKey: Buffer.alloc(32), store: new MemoryTrialStore(), guard: new LocalSpendGuard(new SpendLedger(50_000n, 3_000_000n)), paidFetch: trialPaidFetch({ looks: [], mainPaid: [], trialPaid: [] }) },
      }),
    );
  }
});

test("claim keys are keyed hashes: no IP or address in them, stable per visitor", () => {
  const k = Buffer.alloc(32, 1);
  const a = claimKeys(k, "203.0.113.1", ALGO_ADDR);
  assert.equal(a.length, 2);
  assert.ok(a[0].startsWith("ip:") && a[1].startsWith("ad:"));
  assert.ok(!a.join().includes("203.0.113.1") && !a.join().includes(ALGO_ADDR));
  assert.deepEqual(claimKeys(k, "203.0.113.1"), [a[0]]);
  assert.notDeepEqual(claimKeys(Buffer.alloc(32, 2), "203.0.113.1"), [a[0]]);
});

test("/activity: trial payments are counted as trials, never as customers or customer revenue", async () => {
  const ASA_M = "31566704";
  const FEE = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
  const PAYTO = "RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q";
  const MPAYER = "OZ3KMLALTO67BZLYLCZOT7IJBGN7JTO5A3MJHI2267EKQDASFKS52KU6VY";
  const ALICE = "ALICEALICEALICEALICEALICEALICEALICEALICEALICEALICEALICEALIC";
  const T0 = 1790479000;
  const axfer = (id: string, sender: string, receiver: string, amount: number, round: number, group?: string) => ({
    id,
    sender,
    "tx-type": "axfer",
    fee: 0,
    ...(group ? { group } : {}),
    "confirmed-round": round,
    "round-time": T0 + round * 3,
    "intra-round-offset": 1,
    "asset-transfer-transaction": { "asset-id": Number(ASA_M), amount, receiver, "close-amount": 0 },
  });
  const feePay = (round: number, group: string) => ({ id: `FEE-${group}`, sender: FEE, "tx-type": "pay", fee: 2000, group, "confirmed-round": round, "round-time": T0 + round * 3, "intra-round-offset": 0, "payment-transaction": { amount: 0, receiver: FEE } });
  const alice = axfer("ALICE1", ALICE, PAYTO, 50_000, 100, "G1");
  const payout = axfer("PAYOUT1", MPAYER, SELLER, 10_000, 102, "G2");
  const trial1 = axfer("TRIAL1", TRIAL, SELLER, 10_000, 110, "G3");
  const trial2 = axfer("TRIAL2", TRIAL, SELLER, 1_000, 111, "G4");
  const trialIntoPayTo = axfer("TRIAL3", TRIAL, PAYTO, 50_000, 112, "G5"); // even an x402 payment from the trial wallet to vet402 is not a customer
  const accounts: Record<string, unknown[]> = { [PAYTO]: [alice, trialIntoPayTo], [MPAYER]: [payout], [TRIAL]: [trial1, trial2, trialIntoPayTo] };
  const groups: Record<string, unknown[]> = { G1: [feePay(100, "G1"), alice], G5: [feePay(112, "G5"), trialIntoPayTo] };
  const f = (async (url: string) => {
    const u = new URL(url);
    const m = u.pathname.match(/^\/v2\/accounts\/([A-Z2-7]+)\/transactions$/);
    if (m) return accounts[m[1]] ? Response.json({ transactions: accounts[m[1]] }) : new Response("nf", { status: 404 });
    if (u.pathname === "/v2/transactions") return Response.json({ transactions: groups[u.searchParams.get("group-id")!] ?? [] });
    return new Response("?", { status: 400 });
  }) as unknown as typeof fetch;
  const r = await new ActivityLedger({ networkName: "mainnet", indexerUrl: "https://idx", asaId: ASA_M, payTo: PAYTO, payer: MPAYER, trialPayer: TRIAL, fetchImpl: f, priceAtomic: 50_000n }).get();
  assert.equal(r.totals.customers.addresses, 1);
  assert.equal(r.totals.customers.payments, 1);
  assert.equal(r.totals.customers.usdc, "0.050000");
  assert.equal(r.totals.sellerPayments.payments, 1);
  assert.deepEqual(r.totals.trials, { payments: 2, usdc: "0.011000", wallet: TRIAL });
  assert.ok(r.rows.find((w) => w.customerTx === "TRIAL3")?.operatorTest);
});
