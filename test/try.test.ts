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
      response: new Response('{"forecast":"sunny","temperature":21,"city":"Kyoto"}', { status: 200, headers: { "content-type": "application/json" } }),
      settle: { success: true, transaction: "SELLERTXSELLERTXSELLERTXSELLERTXSELLERTXSELLERTXSELL", network: NET },
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
  const j = (await first.json()) as { class: string; verdict: string; because: string; paidBy: string; sellerTxUrl: string; declared: { expectedKeys: string[] }; delivery: { text: string; truncated: boolean; bytes: number; contentType: string } };
  assert.equal(j.class, "DELIVERED");
  assert.equal(j.paidBy, TRIAL);
  assert.match(j.sellerTxUrl, /^https:\/\/lora\.algokit\.io\/testnet\/transaction\//);
  // The listing's promise, what came back (as text), and why, in that order on the page.
  assert.deepEqual(j.declared.expectedKeys, ["forecast", "temperature"]);
  assert.equal(j.delivery.text, JSON.stringify({ forecast: "sunny", temperature: 21, city: "Kyoto" }, null, 2));
  assert.equal(j.delivery.truncated, false);
  assert.equal(j.verdict, "ALLOW");
  assert.equal(j.because, "the answer is JSON and has every field the listing promised (forecast, temperature)");

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

/* ---------- /v1/buy: first purchase at cost ---------- */

import { randomBytes } from "node:crypto";
import { Transaction, TransactionType, encodeTransactionRaw } from "@algorandfoundation/algokit-utils/transact";
import { Address } from "@algorandfoundation/algokit-utils/common";
import { toClientAvmSigner } from "@x402/avm";
import { publicKeyFromSeed, addressFromSeed } from "../src/keys.js";

/** A real signed USDC transfer from a fresh key: what a wallet puts in paymentGroup. */
async function account() {
  const seed = randomBytes(32);
  const address = addressFromSeed(seed);
  const signer = toClientAvmSigner(Buffer.concat([seed, Buffer.from(publicKeyFromSeed(seed))]).toString("base64"));
  const signedTransfer = async (amount: bigint, receiver = BUY_PAYTO) => {
    const txn = new Transaction({
      type: TransactionType.AssetTransfer,
      sender: Address.fromString(address),
      firstValid: 1n,
      lastValid: 1000n,
      genesisId: "testnet-v1.0",
      genesisHash: Buffer.from("SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=", "base64"),
      assetTransfer: { assetId: BigInt(ASA), amount, receiver: Address.fromString(receiver) },
    });
    const [signed] = await signer.signTransactions([encodeTransactionRaw(txn)]);
    return Buffer.from(signed!).toString("base64");
  };
  return { address, signedTransfer };
}

/** A real address as payTo here: the preflight reads the transfer's receiver from the signed transaction. */
const BUY_PAYTO = "RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q";

function buyApp(paid: Set<string>) {
  const cfg = baseCfg();
  const trace: string[] = [];
  const seen: Seen = { looks: [], mainPaid: [], trialPaid: [] };
  const deps = sellerDeps(seen);
  deps.paidFetch = trialPaidFetch(seen); // the seller is paid by vet402's payer here
  const app = createApp(cfg, {
    payTo: BUY_PAYTO,
    probeDeps: deps,
    guard: new LocalSpendGuard(new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic)),
    facilitator: facilitator(trace),
    catalog: { items: async () => [] },
    firstPurchase: async (a) => !paid.has(a),
  });
  return { app, trace, seen };
}

const decode402 = (res: Response) => JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
const sigHeader = (accepted: unknown, resource: unknown, group: string[]) =>
  Buffer.from(JSON.stringify({ x402Version: 2, resource, accepted, payload: { paymentGroup: group, paymentIndex: 0 } })).toString("base64");
const buyUrl = (payer?: string) => `/v1/buy?url=${encodeURIComponent(`${HOST}/honest`)}${payer ? `&payer=${payer}` : ""}`;

test("first purchase at cost: an address that never paid vet402 pays the seller's price only; the second time the fee is back", async () => {
  const paid = new Set<string>();
  const { app, trace, seen } = buyApp(paid);
  const a = await account();
  const first = await app.request(buyUrl(a.address));
  assert.equal(first.status, 402);
  const acc = decode402(first).accepts[0];
  assert.equal(acc.amount, "10000"); // seller 0.01, fee 0
  assert.deepEqual([acc.extra.buyFee, acc.extra.firstPurchase, acc.extra.payer], ["0", true, a.address]);
  assert.equal(((await first.json()) as { buy: { fee: { amountAtomic: string } } }).buy.fee.amountAtomic, "0");
  // Without ?payer= (or with an address that has paid) the normal price.
  assert.equal(decode402(await app.request(buyUrl())).accepts[0].amount, "15000");
  const res = await app.request(buyUrl(a.address), { headers: { "PAYMENT-SIGNATURE": sigHeader(acc, decode402(first).resource, [await a.signedTransfer(10_000n)]) } });
  assert.equal(res.status, 200);
  assert.ok(trace.includes("settle"));
  assert.equal(seen.trialPaid.length, 1);
  // Second time: the same address now has a payment (the indexer, or this instance right after settling).
  const again = await app.request(buyUrl(a.address));
  assert.equal(decode402(again).accepts[0].amount, "15000");
  assert.equal(decode402(again).accepts[0].extra.firstPurchase, undefined);
  paid.add(a.address);
  assert.equal(decode402(await app.request(buyUrl(a.address))).accepts[0].amount, "15000");
});

test("first purchase at cost cannot be forged: a lowered amount, a dropped payer, or another account paying is never settled", async () => {
  const { app, trace, seen } = buyApp(new Set());
  const a = await account();
  const b = await account();
  const first = await app.request(buyUrl(a.address));
  const pr = decode402(first);
  const acc = pr.accepts[0];
  const group = [await a.signedTransfer(10_000n)];

  // 1) The normal-price request signed with the at-cost requirements: they do not match, 402.
  const r1 = await app.request(buyUrl(), { headers: { "PAYMENT-SIGNATURE": sigHeader(acc, pr.resource, group) } });
  assert.equal(r1.status, 402);
  // 2) A lower amount than asked.
  const r2 = await app.request(buyUrl(a.address), { headers: { "PAYMENT-SIGNATURE": sigHeader({ ...acc, amount: "9000" }, pr.resource, group) } });
  assert.equal(r2.status, 402);
  // 3) firstPurchase added by hand to a normal-price request.
  const normal = decode402(await app.request(buyUrl())).accepts[0];
  const r3 = await app.request(buyUrl(), { headers: { "PAYMENT-SIGNATURE": sigHeader({ ...normal, amount: "10000", extra: { ...normal.extra, buyFee: "0", firstPurchase: true, payer: a.address } }, pr.resource, group) } });
  assert.equal(r3.status, 402);
  // 4) The at-cost price for A, paid from B's account: refused before settling.
  const r4 = await app.request(buyUrl(a.address), { headers: { "PAYMENT-SIGNATURE": sigHeader(acc, pr.resource, [await b.signedTransfer(10_000n)]) } });
  assert.equal(r4.status, 409);
  assert.equal(((await r4.json()) as { reason: string; charged: boolean }).reason, "first_purchase_payer_mismatch");
  // 5) A's transfer at paymentIndex, plus B's transfer to payTo elsewhere in the group: refused before settling.
  const r5 = await app.request(buyUrl(a.address), { headers: { "PAYMENT-SIGNATURE": sigHeader(acc, pr.resource, [await a.signedTransfer(10_000n), await b.signedTransfer(10_000n)]) } });
  assert.equal(r5.status, 409);
  // 6) A's transfer to someone else than payTo: no payment to vet402 in the group, refused.
  const r6 = await app.request(buyUrl(a.address), { headers: { "PAYMENT-SIGNATURE": sigHeader(acc, pr.resource, [await a.signedTransfer(10_000n, ALGO_ADDR)]) } });
  assert.equal(r6.status, 409);
  // 7) ?payer= that is not an address: the normal price.
  assert.equal(decode402(await app.request(buyUrl("NOTANADDRESS"))).accepts[0].amount, "15000");
  assert.ok(!trace.includes("settle"), "nothing may settle");
  assert.equal(seen.trialPaid.length, 0);
});

test("neverPaidVet402 reads the address's USDC transfers: any transfer to payTo means it has paid; an unknown account has not", async () => {
  const { neverPaidVet402 } = await import("../src/buy.js");
  const PT = "RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q";
  const mk = (txs: unknown[], status = 200) => (async () => (status === 200 ? Response.json({ transactions: txs }) : new Response("x", { status }))) as unknown as typeof fetch;
  const o = { indexerUrl: "https://idx", asaId: "31566704", payTo: PT, address: ALGO_ADDR };
  assert.equal(await neverPaidVet402({ ...o, fetchImpl: mk([], 404) }), true);
  assert.equal(await neverPaidVet402({ ...o, fetchImpl: mk([{ sender: ALGO_ADDR, "asset-transfer-transaction": { receiver: SELLER, "asset-id": 31566704 } }]) }), true);
  assert.equal(await neverPaidVet402({ ...o, fetchImpl: mk([{ sender: ALGO_ADDR, "asset-transfer-transaction": { receiver: PT, "asset-id": 31566704 } }]) }), false);
  await assert.rejects(neverPaidVet402({ ...o, fetchImpl: mk([], 500) }));
});

test("/activity: a first purchase at cost (no fee) pairs with its seller payment and counts as a customer, also at the /v1/verdict price", async () => {
  const ASA_M = "31566704";
  const FEE = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
  const PAYTO = "RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q";
  const MPAYER = "OZ3KMLALTO67BZLYLCZOT7IJBGN7JTO5A3MJHI2267EKQDASFKS52KU6VY";
  const CAROL = "CAROLCAROLCAROLCAROLCAROLCAROLCAROLCAROLCAROLCAROLCAROLCARO";
  const DAVE = "DAVEDAVEDAVEDAVEDAVEDAVEDAVEDAVEDAVEDAVEDAVEDAVEDAVEDAVEDAVE";
  const T0 = 1790479000;
  const axfer = (id: string, sender: string, receiver: string, amount: number, round: number, group?: string) => ({
    id, sender, "tx-type": "axfer", fee: 0, ...(group ? { group } : {}), "confirmed-round": round, "round-time": T0 + round * 3, "intra-round-offset": 1,
    "asset-transfer-transaction": { "asset-id": Number(ASA_M), amount, receiver, "close-amount": 0 },
  });
  const feePay = (round: number, group: string) => ({ id: `FEE-${group}`, sender: FEE, "tx-type": "pay", fee: 2000, group, "confirmed-round": round, "round-time": T0 + round * 3, "intra-round-offset": 0, "payment-transaction": { amount: 0, receiver: FEE } });
  const carol = axfer("CAROL1", CAROL, PAYTO, 3_000, 100, "G1"); // at cost: seller price 0.003, fee 0
  const carolOut = axfer("OUT1", MPAYER, SELLER, 3_000, 101, "G2");
  const dave = axfer("DAVE1", DAVE, PAYTO, 1_000, 200, "G3"); // at cost at 0.001 = the /v1/verdict price
  const daveOut = axfer("OUT2", MPAYER, SELLER, 1_000, 201, "G4");
  const accounts: Record<string, unknown[]> = { [PAYTO]: [carol, dave], [MPAYER]: [carolOut, daveOut] };
  const groups: Record<string, unknown[]> = { G1: [feePay(100, "G1"), carol], G3: [feePay(200, "G3"), dave] };
  const f = (async (url: string) => {
    const u = new URL(url);
    const m = u.pathname.match(/^\/v2\/accounts\/([A-Z2-7]+)\/transactions$/);
    if (m) return accounts[m[1]] ? Response.json({ transactions: accounts[m[1]] }) : new Response("nf", { status: 404 });
    if (u.pathname === "/v2/transactions") return Response.json({ transactions: groups[u.searchParams.get("group-id")!] ?? [] });
    return new Response("?", { status: 400 });
  }) as unknown as typeof fetch;
  const r = await new ActivityLedger({ networkName: "mainnet", indexerUrl: "https://idx", asaId: ASA_M, payTo: PAYTO, payer: MPAYER, fetchImpl: f, priceAtomic: 50_000n, buyFeeAtomic: 5_000n, verdictPriceAtomic: 1_000n }).get();
  assert.equal(r.totals.customers.addresses, 2);
  assert.equal(r.totals.customers.usdc, "0.004000");
  assert.equal(r.totals.sellerPayments.payments, 2);
  assert.equal(r.totals.sellerPayments.unmatched, 0);
  assert.deepEqual(r.rows.map((w) => [w.customerTx, w.kind, w.sellerTx]), [["DAVE1", "buy", "OUT2"], ["CAROL1", "buy", "OUT1"]]);
});

test("/try/wallet.js is the committed build of src/web (fresh), served as JavaScript, and loaded only on demand", async () => {
  const { buildWalletJs, moduleText } = await import("../scripts/build-wallet.js");
  const { readFileSync } = await import("node:fs");
  const committed = readFileSync(new URL("../src/web/wallet-bundle.gen.ts", import.meta.url), "utf8");
  assert.equal(committed, moduleText(await buildWalletJs()), "src/web/wallet-bundle.gen.ts is stale: run npm run build:wallet");
  const { WALLET_JS_SHA } = await import("../src/web/wallet-bundle.gen.js");
  const { app } = setup();
  const js = await app.request(`/try/wallet.js?v=${WALLET_JS_SHA}`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /^text\/javascript/);
  const page = await (await app.request("/try")).text();
  assert.ok(page.includes(`/try/wallet.js?v=${WALLET_JS_SHA}`));
  assert.doesNotMatch(page, /<script[^>]+src=/); // no script tag loads it up front, and nothing from another origin
  assert.doesNotMatch(page, /coming soon/i);
});

test("trial content: text up to 2 KB then '(truncated)', markup is only data, images show type and size only", async () => {
  const { contentPreview, TRY_PREVIEW_BYTES } = await import("../src/try.js");
  const big = Buffer.from("x".repeat(5000));
  const t = contentPreview(big, "text/plain");
  assert.equal(Buffer.byteLength(t.text!), TRY_PREVIEW_BYTES);
  assert.equal(t.truncated, true);
  assert.equal(t.bytes, 5000);
  const html = contentPreview(Buffer.from('<script>alert(1)</script><img src=x onerror=alert(2)>'), "text/html; charset=utf-8");
  assert.equal(html.text, '<script>alert(1)</script><img src=x onerror=alert(2)>'); // data, returned inside JSON
  const png = contentPreview(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
  assert.equal(png.text, undefined);
  assert.deepEqual([png.contentType, png.bytes], ["image/png", 4]);
  // Multi-byte text is cut on a character boundary.
  const jp = contentPreview(Buffer.from("あ".repeat(1000)), "text/plain");
  assert.ok(!jp.text!.includes("\uFFFD"));
  // The page puts it in with textContent only: no innerHTML anywhere in /try.
  const { app } = setup();
  const page = await (await app.request("/try")).text();
  assert.doesNotMatch(page, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(page, /pre\.textContent=j\.delivery\.text/);
});

test("trial over HTTP: a seller answering HTML gets its markup back as a JSON string, never as a page", async () => {
  const seen: Seen = { looks: [], mainPaid: [], trialPaid: [] };
  const cfg = baseCfg();
  const app = createApp(cfg, {
    payTo: VET402,
    probeDeps: sellerDeps(seen),
    guard: new LocalSpendGuard(new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic)),
    facilitator: facilitator([]),
    catalog: { items: async () => [] },
    trial: {
      address: TRIAL, maxPerCallAtomic: 50_000n, maxPerDayAtomic: 3_000_000n, hashKey: Buffer.alloc(32), store: new MemoryTrialStore(),
      guard: new LocalSpendGuard(new SpendLedger(50_000n, 3_000_000n)),
      paidFetch: async () => ({ response: new Response("<script>alert(1)</script>", { status: 200, headers: { "content-type": "text/html" } }), settle: { success: true, transaction: "A".repeat(52), network: NET }, signed: true }),
    },
  });
  const r = await run(app, { url: `${HOST}/honest` });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /^application\/json/);
  const j = (await r.json()) as { verdict: string; reason: string; because: string; delivery: { text: string } };
  assert.equal(j.delivery.text, "<script>alert(1)</script>");
  assert.equal(j.reason, "not_json");
  assert.equal(j.because, "the listing promised JSON, and the answer is not JSON");
});

test("first people: only the visitor who ran a try can add an X handle to it, once; bad handles, wrong tokens and hidden handles never show", async () => {
  const { app } = setup();
  const r = await run(app, { url: `${HOST}/honest`, from: "x-reply" });
  const j = (await r.json()) as { record: { id: string; token: string } };
  assert.ok(j.record.id && j.record.token);
  const add = (body: unknown) => app.request("/try/handle", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "198.51.100.1" }, body: JSON.stringify(body) });
  assert.equal((await add({ record: j.record.id, token: "0".repeat(32), handle: "@alice" })).status, 403);
  assert.equal((await add({ record: j.record.id, token: j.record.token, handle: "<script>" })).status, 400);
  assert.equal((await add({ record: j.record.id, token: j.record.token, handle: "@toolonghandle_16" })).status, 400);
  const ok = await add({ record: j.record.id, token: j.record.token, handle: "alice_01" });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { handle: string }).handle, "@alice_01");
  assert.equal((await add({ record: j.record.id, token: j.record.token, handle: "@bob" })).status, 409);
  const log = (await (await app.request("/try/log.json")).json()) as { entries: { handle?: string; from?: string }[] };
  assert.deepEqual([log.entries[0].handle, log.entries[0].from], ["@alice_01", "x-reply"]);
  assert.match(await (await app.request("/try/log")).text(), /https:\/\/x\.com\/alice_01/);
});

test("first people: a handle listed in TRY_HIDDEN_HANDLES is not shown", async () => {
  const seen: Seen = { looks: [], mainPaid: [], trialPaid: [] };
  const cfg = baseCfg();
  const store = new MemoryTrialStore();
  const app = createApp(cfg, {
    payTo: VET402,
    probeDeps: sellerDeps(seen),
    guard: new LocalSpendGuard(new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic)),
    facilitator: facilitator([]),
    catalog: { items: async () => [] },
    trial: { address: TRIAL, maxPerCallAtomic: 50_000n, maxPerDayAtomic: 3_000_000n, hashKey: Buffer.alloc(32, 3), store, guard: new LocalSpendGuard(new SpendLedger(50_000n, 3_000_000n)), paidFetch: trialPaidFetch(seen), hiddenHandles: ["@Alice"] },
  });
  const id = await store.record({ at: "2026-09-27T10:00:00Z", url: `${HOST}/honest`, host: "localhost:4031", class: "DELIVERED", reason: "delivered" });
  await store.attachHandle(id, "@alice");
  const log = (await (await app.request("/try/log.json")).json()) as { entries: { handle?: string }[] };
  assert.equal(log.entries[0].handle, undefined);
  assert.doesNotMatch(await (await app.request("/try/log")).text(), /alice/i);
});

test("?from= is kept only as a short tag: on the trial record, per day in /try/stats.json, and on the landing page's /try links", async () => {
  const { app } = setup();
  await run(app, { url: `${HOST}/honest`, from: "github" }, "203.0.113.20");
  await run(app, { url: `${HOST}/honest`, from: "<bad tag>" }, "203.0.113.21");
  await run(app, { url: `${HOST}/honest` }, "203.0.113.22");
  const st = (await (await app.request("/try/stats.json")).json()) as { triedToday: number; byDay: { date: string; tried: number; from: Record<string, number>; paid: number | null }[] };
  assert.equal(st.triedToday, 3);
  assert.equal(st.byDay.length, 14);
  assert.deepEqual(st.byDay[0].from, { github: 1, direct: 2 });
  const log = (await (await app.request("/try/log.json")).json()) as { entries: { from?: string }[] };
  assert.deepEqual(log.entries.map((e) => e.from ?? null).sort(), ["github", null, null].sort());
  const home = await (await app.request("/?from=sen-x", { headers: { accept: "text/html" } })).text();
  assert.match(home, /href="\/try\?from=sen-x"/);
  const bad = await (await app.request("/?from=%22%3E%3Cscript%3E", { headers: { accept: "text/html" } })).text();
  assert.doesNotMatch(bad, /<script/);
});

test("/activity: an audit paid between a first purchase at cost and its seller payment does not take that seller payment", async () => {
  const ASA_M = "31566704";
  const FEE = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
  const PAYTO = "RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q";
  const MPAYER = "OZ3KMLALTO67BZLYLCZOT7IJBGN7JTO5A3MJHI2267EKQDASFKS52KU6VY";
  const CAROL = "CAROLCAROLCAROLCAROLCAROLCAROLCAROLCAROLCAROLCAROLCAROLCARO";
  const EVE = "EVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEV";
  const T0 = 1790479000;
  const axfer = (id: string, sender: string, receiver: string, amount: number, round: number, group?: string) => ({
    id, sender, "tx-type": "axfer", fee: 0, ...(group ? { group } : {}), "confirmed-round": round, "round-time": T0 + round * 3, "intra-round-offset": 1,
    "asset-transfer-transaction": { "asset-id": Number(ASA_M), amount, receiver, "close-amount": 0 },
  });
  const feePay = (round: number, group: string) => ({ id: `FEE-${group}`, sender: FEE, "tx-type": "pay", fee: 2000, group, "confirmed-round": round, "round-time": T0 + round * 3, "intra-round-offset": 0, "payment-transaction": { amount: 0, receiver: FEE } });
  const carol = axfer("CAROL1", CAROL, PAYTO, 10_000, 100, "G1");
  const audit = axfer("EVEAUDIT", EVE, PAYTO, 500_000, 101, "G2");
  const carolOut = axfer("OUT1", MPAYER, SELLER, 10_000, 102, "G3");
  const accounts: Record<string, unknown[]> = { [PAYTO]: [carol, audit], [MPAYER]: [carolOut] };
  const groups: Record<string, unknown[]> = { G1: [feePay(100, "G1"), carol], G2: [feePay(101, "G2"), audit] };
  const f = (async (url: string) => {
    const u = new URL(url);
    const m = u.pathname.match(/^\/v2\/accounts\/([A-Z2-7]+)\/transactions$/);
    if (m) return accounts[m[1]] ? Response.json({ transactions: accounts[m[1]] }) : new Response("nf", { status: 404 });
    if (u.pathname === "/v2/transactions") return Response.json({ transactions: groups[u.searchParams.get("group-id")!] ?? [] });
    return new Response("?", { status: 400 });
  }) as unknown as typeof fetch;
  const r = await new ActivityLedger({ networkName: "mainnet", indexerUrl: "https://idx", asaId: ASA_M, payTo: PAYTO, payer: MPAYER, fetchImpl: f, priceAtomic: 50_000n, buyFeeAtomic: 5_000n, verdictPriceAtomic: 1_000n, auditPriceAtomic: 500_000n }).get();
  const byTx = Object.fromEntries(r.rows.map((w) => [w.customerTx, w]));
  assert.equal(byTx.CAROL1.kind, "buy");
  assert.equal(byTx.CAROL1.sellerTx, "OUT1");
  assert.deepEqual(byTx.EVEAUDIT.sellerPayments, []);
});

test("/try next steps: sellers are sent to /seller/<host> (where the certificate is offered), not a /cert/<host> path", async () => {
  const { app } = setup();
  const page = await (await app.request("/try")).text();
  assert.match(page, /'\/seller\/'\+encodeURIComponent\(c\.h/);
  assert.doesNotMatch(page, /\/cert\//);
});

/* ---------- second review: the trial wallet cannot be pointed at a new seller; per-seller cap; IPv6 /64 ---------- */

const PUB = "https://seller.example";
function pubSetup(o: { censusPayTo?: string; acceptPayTo?: string } = {}) {
  const cfg = baseCfg();
  const seen: Seen = { looks: [], mainPaid: [], trialPaid: [] };
  const deps = sellerDeps(seen, { payTo: o.acceptPayTo ?? SELLER });
  deps.resolveHost = async () => ["93.184.216.34"];
  const census = board([row(`${PUB}/listed`, { payTo: o.censusPayTo ?? SELLER }), row(`${PUB}/other`, { payTo: SELLER })]);
  const app = createApp(cfg, {
    payTo: VET402,
    probeDeps: deps,
    guard: new LocalSpendGuard(new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic)),
    facilitator: facilitator([]),
    catalog: { items: async () => [] },
    trial: { address: TRIAL, maxPerCallAtomic: 50_000n, maxPerDayAtomic: 3_000_000n, hashKey: Buffer.alloc(32, 9), store: new MemoryTrialStore(), guard: new LocalSpendGuard(new SpendLedger(50_000n, 3_000_000n)), paidFetch: trialPaidFetch(seen) },
    tryBoard: { load: async (f: string) => (f.endsWith("census-latest.json") ? census : null), file: "/nonexistent/latest.json" },
  });
  return { app, seen };
}

test("trial: only a listed URL, paid to the payTo vet402 recorded for it", async () => {
  const a = pubSetup();
  const r1 = await run(a.app, { url: `${PUB}/not-in-the-list` }, "203.0.113.30");
  assert.equal(r1.status, 422);
  assert.equal(((await r1.json()) as { error: string }).error, "not_listed");
  assert.equal((await run(a.app, { url: `${PUB}/listed` }, "203.0.113.31")).status, 200);
  const b = pubSetup({ acceptPayTo: ALGO_ADDR }); // the seller now points its payTo elsewhere
  const r2 = await run(b.app, { url: `${PUB}/listed` }, "203.0.113.32");
  assert.equal(r2.status, 422);
  assert.equal(((await r2.json()) as { reason: string }).reason, "payto_changed");
  assert.deepEqual([a.seen.trialPaid.length, b.seen.trialPaid.length], [1, 0]);
});

test("trial: at most 3 free tries per seller host per day, whatever the IPs", async () => {
  const { app, seen } = pubSetup();
  for (let i = 0; i < 3; i++) assert.equal((await run(app, { url: `${PUB}/listed` }, `203.0.113.${40 + i}`)).status, 200);
  const r = await run(app, { url: `${PUB}/other` }, "203.0.113.50");
  assert.equal(r.status, 429);
  assert.equal(((await r.json()) as { error: string }).error, "seller_tried_enough");
  assert.equal(seen.trialPaid.length, 3);
});

test("trial: IPv6 addresses count per /64", async () => {
  const { personKey } = await import("../src/try.js");
  assert.equal(personKey("2001:db8:1:2:aaaa::1"), personKey("2001:0db8:0001:0002:ffff:1:2:3"));
  assert.notEqual(personKey("2001:db8:1:2::1"), personKey("2001:db8:1:3::1"));
  assert.equal(personKey("203.0.113.9"), "203.0.113.9");
  const { app, seen } = pubSetup();
  assert.equal((await run(app, { url: `${PUB}/listed` }, "2001:db8:1:2::1")).status, 200);
  assert.equal((await run(app, { url: `${PUB}/listed` }, "2001:db8:1:2:dead:beef:0:9")).status, 403);
  assert.equal(seen.trialPaid.length, 1);
});

test("/activity: a /v1/verdict lookup paid between a purchase (or a check) and its 0.001 seller payment does not take it", async () => {
  const ASA_M = "31566704";
  const FEE = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
  const PAYTO = "RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q";
  const MPAYER = "OZ3KMLALTO67BZLYLCZOT7IJBGN7JTO5A3MJHI2267EKQDASFKS52KU6VY";
  const A = "CAROLCAROLCAROLCAROLCAROLCAROLCAROLCAROLCAROLCAROLCAROLCARO";
  const V = "EVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEVEEV";
  const T0 = 1790479000;
  const ax = (id: string, sender: string, receiver: string, amount: number, round: number, group?: string) => ({
    id, sender, "tx-type": "axfer", fee: 0, ...(group ? { group } : {}), "confirmed-round": round, "round-time": T0 + round * 3, "intra-round-offset": 1,
    "asset-transfer-transaction": { "asset-id": Number(ASA_M), amount, receiver, "close-amount": 0 },
  });
  const feePay = (round: number, group: string) => ({ id: `FEE-${group}`, sender: FEE, "tx-type": "pay", fee: 2000, group, "confirmed-round": round, "round-time": T0 + round * 3, "intra-round-offset": 0, "payment-transaction": { amount: 0, receiver: FEE } });
  for (const [first, amount, kind] of [["BUY1", 6_000, "buy"], ["CHECK1", 50_000, "check"]] as const) {
    const c1 = ax(first, A, PAYTO, amount, 100, "G1");
    const v = ax("VERDICT1", V, PAYTO, 1_000, 101, "G2");
    const out = ax("OUT1", MPAYER, SELLER, 1_000, 102, "G3");
    const accounts: Record<string, unknown[]> = { [PAYTO]: [c1, v], [MPAYER]: [out] };
    const groups: Record<string, unknown[]> = { G1: [feePay(100, "G1"), c1], G2: [feePay(101, "G2"), v] };
    const f = (async (url: string) => {
      const u = new URL(url);
      const m = u.pathname.match(/^\/v2\/accounts\/([A-Z2-7]+)\/transactions$/);
      if (m) return accounts[m[1]] ? Response.json({ transactions: accounts[m[1]] }) : new Response("nf", { status: 404 });
      if (u.pathname === "/v2/transactions") return Response.json({ transactions: groups[u.searchParams.get("group-id")!] ?? [] });
      return new Response("?", { status: 400 });
    }) as unknown as typeof fetch;
    const r = await new ActivityLedger({ networkName: "mainnet", indexerUrl: "https://idx", asaId: ASA_M, payTo: PAYTO, payer: MPAYER, fetchImpl: f, priceAtomic: 50_000n, buyFeeAtomic: 5_000n, verdictPriceAtomic: 1_000n, auditPriceAtomic: 500_000n }).get();
    const byTx = Object.fromEntries(r.rows.map((w) => [w.customerTx, w]));
    assert.equal(byTx[first].kind, kind, first);
    assert.equal(byTx[first].sellerTx, "OUT1", first);
    assert.equal(byTx.VERDICT1.kind, "verdict", first);
    assert.equal(r.totals.customers.payments, 2, first);
  }
});

/* ---------- with BASE_ACCEPT on (main 919f91e) ---------- */

import { snapFacilitator } from "./x402-snapshot.js";

const BASE_PAY_TO_T = "0x1111111111111111111111111111111111111111";

test("BASE_ACCEPT on: the first purchase at cost is on the Algorand accept only; the Base accept keeps the normal price and cannot be made free", async () => {
  const cfg = loadConfig({ ALLOW_PRIVATE_TARGETS: "1", BASE_ACCEPT: "on", BASE_PAY_TO: BASE_PAY_TO_T });
  const trace: string[] = [];
  const seen: Seen = { looks: [], mainPaid: [], trialPaid: [] };
  const deps = sellerDeps(seen);
  deps.paidFetch = trialPaidFetch(seen);
  const app = createApp(cfg, {
    payTo: BUY_PAYTO,
    probeDeps: deps,
    guard: new LocalSpendGuard(new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic)),
    facilitator: snapFacilitator(trace),
    catalog: { items: async () => [] },
    firstPurchase: async () => true,
  });
  const a = await account();
  const first = await app.request(buyUrl(a.address));
  assert.equal(first.status, 402);
  const pr = decode402(first);
  assert.equal(pr.accepts.length, 2);
  assert.deepEqual([pr.accepts[0].amount, pr.accepts[0].extra.firstPurchase, pr.accepts[0].extra.payer], ["10000", true, a.address]);
  assert.equal(pr.accepts[1].network, "eip155:84532");
  assert.equal(pr.accepts[1].amount, "15000");
  assert.equal(pr.accepts[1].extra.firstPurchase, undefined);
  assert.equal(pr.accepts[1].extra.buyFee, "5000");
  // A Base payment with the first-purchase terms copied onto the Base accept is not accepted.
  const forged = { ...pr.accepts[1], amount: "10000", extra: { ...pr.accepts[1].extra, buyFee: "0", firstPurchase: true, payer: a.address } };
  const evmSig = (accepted: unknown) => Buffer.from(JSON.stringify({ x402Version: 2, resource: pr.resource, accepted, payload: { signature: "0xSIG", authorization: {} } })).toString("base64");
  assert.equal((await app.request(buyUrl(a.address), { headers: { "PAYMENT-SIGNATURE": evmSig(forged) } })).status, 402);
  assert.ok(!trace.some((t) => t.startsWith("settle")));
  // The Base accept as offered settles at the normal price, on Base.
  const paid = await app.request(buyUrl(a.address), { headers: { "PAYMENT-SIGNATURE": evmSig(pr.accepts[1]) } });
  assert.equal(paid.status, 200);
  assert.ok(trace.includes(`settle eip155:84532 15000 ${BASE_PAY_TO_T}`), trace.join(" | "));
});

test("/activity with Base and trials: a Base customer pairs with the Algorand seller payment after it; trial payments are never customers", async () => {
  const ASA_M = "10458941";
  const PAYTO = "RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q";
  const MPAYER = "OZ3KMLALTO67BZLYLCZOT7IJBGN7JTO5A3MJHI2267EKQDASFKS52KU6VY";
  const T0 = 1790479000;
  const ax = (id: string, sender: string, receiver: string, amount: number, time: number, round: number) => ({
    id, sender, "tx-type": "axfer", fee: 0, group: `G-${id}`, "confirmed-round": round, "round-time": time, "intra-round-offset": 1,
    "asset-transfer-transaction": { "asset-id": Number(ASA_M), amount, receiver, "close-amount": 0 },
  });
  const accounts: Record<string, unknown[]> = {
    [PAYTO]: [],
    [MPAYER]: [ax("OUT_BASE", MPAYER, SELLER, 10_000, T0 + 4, 200)],
    [TRIAL]: [ax("TRIAL1", TRIAL, SELLER, 10_000, T0 + 5, 201)],
  };
  const f = (async (url: string) => {
    const m = new URL(url).pathname.match(/^\/v2\/accounts\/([A-Z2-7]+)\/transactions$/);
    if (m) return accounts[m[1]] ? Response.json({ transactions: accounts[m[1]] }) : new Response("nf", { status: 404 });
    return new Response("?", { status: 400 });
  }) as unknown as typeof fetch;
  const base = {
    network: "eip155:84532", payTo: BASE_PAY_TO_T, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", explorerUrl: "https://sepolia.basescan.org", signers: ["0x136008978ad053942dCDBE759A0903f5d84966fa"],
    read: async () => ({ payments: [{ tx: "0xaaa", block: 10, logIndex: 1, time: T0, customer: "0x2222222222222222222222222222222222222222", amount: 50_000n }], notCounted: [] }),
  };
  const r = await new ActivityLedger({ networkName: "testnet", indexerUrl: "https://idx", asaId: ASA_M, payTo: PAYTO, payer: MPAYER, trialPayer: TRIAL, fetchImpl: f, priceAtomic: 50_000n, buyFeeAtomic: 5_000n, verdictPriceAtomic: 1_000n, auditPriceAtomic: 500_000n, base }).get();
  assert.equal(r.totals.customers.payments, 1);
  assert.equal(r.rows[0].network, "eip155:84532");
  assert.equal(r.rows[0].sellerTx, "OUT_BASE");
  assert.equal(r.totals.sellerPayments.unmatched, 0);
  assert.deepEqual(r.totals.trials, { payments: 1, usdc: "0.010000", wallet: TRIAL });
  assert.equal(r.base?.status === "counted" && r.base.customers.payments, 1);
});

/* ---------- W6: the operator's own tries are listed but never counted ---------- */

test("W6: an operator-test try stays in the log (marked) but is not counted: one operator-test + one normal try = people 1, trials 1", async () => {
  const { app } = setup();
  assert.equal((await run(app, { url: `${HOST}/honest`, from: "operator-test" }, "203.0.113.40")).status, 200);
  assert.equal((await run(app, { url: `${HOST}/honest`, from: "github" }, "203.0.113.41")).status, 200);
  const log = (await (await app.request("/try/log.json")).json()) as { people: number; trials: number; entries: { from?: string; operatorTest?: boolean }[] };
  assert.deepEqual([log.people, log.trials, log.entries.length], [1, 1, 2]);
  assert.deepEqual(log.entries.filter((e) => e.operatorTest).map((e) => e.from), ["operator-test"]);
  const st = (await (await app.request("/try/stats.json")).json()) as { triedToday: number; triedTotal: number; byDay: { from: Record<string, number> }[] };
  assert.deepEqual([st.triedToday, st.triedTotal], [1, 1]);
  assert.deepEqual(st.byDay[0].from, { github: 1 });
  const html = await (await app.request("/try/log")).text();
  assert.match(html, /<b>1<\/b> person has tried vet402 · <b>1<\/b> purchase \(plus 1 operator test, not counted\)/);
  assert.match(html, /operator test \(not counted\)/);
  // The operator's one-per-person claim for that IP stays.
  assert.equal((await run(app, { url: `${HOST}/honest` }, "203.0.113.40")).status, 403);
});

test("W6: any ?from= starting with operator is an operator try; other tags are not", async () => {
  const { isOperatorTry, countedLog } = await import("../src/trial.js");
  assert.equal(isOperatorTry({ from: "operator-test" }), true);
  assert.equal(isOperatorTry({ from: "operator" }), true);
  assert.equal(isOperatorTry({ from: "op" }), false);
  assert.equal(isOperatorTry({}), false);
  const e = (from?: string) => ({ at: "2026-09-27T00:00:00Z", url: "u", host: "h", class: "DELIVERED" as const, reason: "delivered", ...(from ? { from } : {}) });
  assert.deepEqual(
    (({ people, trials }) => ({ people, trials }))(countedLog({ people: 3, entries: [e("operator-a"), e("operator-b"), e()] })),
    { people: 1, trials: 1 },
  );
  assert.equal(countedLog({ people: 0, entries: [e("operator-test")] }).people, 0); // never below 0
});
