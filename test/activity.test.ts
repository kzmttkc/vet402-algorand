/**
 * Public activity ledger: rows come only from x402 settlements (facilitator
 * fee payer in the group), operator self-tests are flagged, plain deposits
 * are left out, and seller payments pair with the right customer payment.
 * Indexer responses are shaped like MainNet data read on 2026-09-27.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityLedger, activityHtml, shortAddr } from "../src/activity.js";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { SpendLedger } from "../src/caps.js";
import { LocalSpendGuard } from "../src/spend.js";
import type { FacilitatorClient } from "@x402/core/server";
import { ALGORAND_TESTNET_CAIP2 } from "@x402/avm";

const ASA = "31566704";
const PAYTO = "RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q";
const PAYER = "OZ3KMLALTO67BZLYLCZOT7IJBGN7JTO5A3MJHI2267EKQDASFKS52KU6VY";
const LOOKALIKE = "OZ3KLEALAWONQOJDXL7T65AM4FKX7ZLMRYHYDQM5UVQXS4PXVUZPKCYSAY"; // address-poisoning sender seen on MainNet
const FEE = "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA";
const EXCHANGE = "IYU5A6WUEXCHANGEEXCHANGEEXCHANGEEXCHANGEEXCHANGEEXCHANGEAA";
const ALICE = "ALICEALICEALICEALICEALICEALICEALICEALICEALICEALICEALICEALIC";
const BOB = "BOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBO";
const SELLER1 = "K5HIZPOUUUBQ5WJ6I3DT6NGIQUMALYJYSVVBY7CXA3BYBWY6225DNNBDSA";
const SELLER2 = "SELLER2SELLER2SELLER2SELLER2SELLER2SELLER2SELLER2SELLER2SEL";
const T0 = 1790479000;

interface Tx {
  id: string;
  sender: string;
  "tx-type": string;
  fee: number;
  group?: string;
  "confirmed-round": number;
  "round-time": number;
  "intra-round-offset": number;
  "asset-transfer-transaction"?: { "asset-id": number; amount: number; receiver: string; "close-amount": number };
  "payment-transaction"?: { amount: number; receiver: string };
  "inner-txns"?: Omit<Tx, "id" | "confirmed-round" | "round-time" | "intra-round-offset">[];
}

const axfer = (id: string, sender: string, receiver: string, amount: number, round: number, group?: string, asa = ASA): Tx => ({
  id,
  sender,
  "tx-type": "axfer",
  fee: group ? 0 : 1000,
  ...(group ? { group } : {}),
  "confirmed-round": round,
  "round-time": T0 + (round - 100) * 3,
  "intra-round-offset": 1,
  "asset-transfer-transaction": { "asset-id": Number(asa), amount, receiver, "close-amount": 0 },
});
const feePay = (id: string, sender: string, round: number, group: string): Tx => ({
  id,
  sender,
  "tx-type": "pay",
  fee: 2000,
  group,
  "confirmed-round": round,
  "round-time": T0 + (round - 100) * 3,
  "intra-round-offset": 0,
  "payment-transaction": { amount: 0, receiver: sender },
});

/** x402 settlement: [fee payer 0-ALGO self pay, USDC transfer] in one group. */
function x402(id: string, from: string, to: string, amount: number, round: number, feePayer = FEE) {
  const g = `G-${id}`;
  return { txn: axfer(id, from, to, amount, round, g), group: [feePay(`FEE-${id}`, feePayer, round, g), axfer(id, from, to, amount, round, g)] };
}

function mockIndexer(accounts: Record<string, Tx[]>, groups: Record<string, Tx[]>) {
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    const u = new URL(url);
    const m = u.pathname.match(/^\/v2\/accounts\/([A-Z2-7]+)\/transactions$/);
    if (m) {
      assert.equal(u.searchParams.get("asset-id"), ASA);
      assert.equal(u.searchParams.get("tx-type"), "axfer");
      const txs = accounts[m[1]];
      if (!txs) return new Response("not found", { status: 404 });
      return Response.json({ "current-round": 999, transactions: [...txs].sort((a, b) => b["confirmed-round"] - a["confirmed-round"]) });
    }
    if (u.pathname === "/v2/transactions") {
      const g = u.searchParams.get("group-id")!;
      return Response.json({ transactions: groups[g] ?? [] });
    }
    return new Response("?", { status: 400 });
  }) as unknown as typeof fetch;
  return { f, urls };
}

function scenario() {
  // MainNet shape: operator refuse (no seller payment) then operator allow (paid seller 2 rounds later).
  const opRefuse = x402("QU6RPL2CKP", PAYER, PAYTO, 50_000, 121);
  const opAllow = x402("UTFFAINOX5", PAYER, PAYTO, 50_000, 127);
  const alice1 = x402("ALICE1", ALICE, PAYTO, 50_000, 140);
  const alice2 = x402("ALICE2", ALICE, PAYTO, 50_000, 150);
  const bob = x402("BOB1", BOB, PAYTO, 50_000, 160);
  const payout1 = axfer("4GMCTRIGQY", PAYER, SELLER1, 10_000, 130, "G-out1");
  const payoutAlice2 = axfer("PAYALICE2", PAYER, SELLER2, 5_000, 152, "G-out2");
  const payoutBob = axfer("PAYBOB", PAYER, SELLER1, 10_000, 163);
  const strayPayout = axfer("STRAY", PAYER, SELLER2, 7_000, 400); // no customer payment before it within the window
  const exchangeDeposit = axfer("BOL6OSV6ZP", EXCHANGE, PAYTO, 297_130_978, 90); // ChangeNOW-style, not grouped
  // Grouped, fee-less, but no facilitator fee payer in the group: a hand-built group is not x402.
  const handGroup = { txn: axfer("HANDGROUP", LOOKALIKE, PAYTO, 50_000, 170, "G-HAND"), group: [feePay("FAKEFEE", LOOKALIKE, 170, "G-HAND"), axfer("HANDGROUP", LOOKALIKE, PAYTO, 50_000, 170, "G-HAND")] };
  const lookalikeX402 = x402("LOOK1", LOOKALIKE, PAYTO, 50_000, 180); // real x402 payment from a look-alike: a customer, not operator
  const optIn = axfer("3OFD77D6X6", PAYTO, PAYTO, 0, 80);
  const payToOut = axfer("ZMKY3MBKIJ", PAYTO, "EZRVNZFJGOUZC67FUMEC7ZMVP232TPICFTQCVZ6EQEIRRT3TIHSKZULRNI", 10_000_000, 95, "G-swap");
  const otherAsa = axfer("OTHERASA", ALICE, PAYTO, 50_000, 141, undefined, "10458941");
  // MainNet shape (A5JKNWWMZD): an app call whose inner transaction moves USDC.
  const appCall = (id: string, round: number, inner: Tx): Tx => ({ ...axfer(id, PAYTO, PAYTO, 0, round), "tx-type": "appl", "asset-transfer-transaction": undefined, "inner-txns": [inner] });
  const fundPayer = appCall("A5JKNWWMZD", 96, axfer("-", "EZRVNZFJGOUZC67FUMEC7ZMVP232TPICFTQCVZ6EQEIRRT3TIHSKZULRNI", PAYER, 10_000_000, 96));
  const appToPayTo = appCall("APPIN", 97, axfer("-", "EZRVNZFJGOUZC67FUMEC7ZMVP232TPICFTQCVZ6EQEIRRT3TIHSKZULRNI", PAYTO, 50_000, 97));
  const payerViaApp = appCall("APPOUT", 500, axfer("-", PAYER, SELLER2, 3_000, 500));
  const all = [opRefuse, opAllow, alice1, alice2, bob, handGroup, lookalikeX402];
  const accounts = {
    [PAYTO]: [...all.map((x) => x.txn), exchangeDeposit, optIn, payToOut, otherAsa, fundPayer, appToPayTo],
    [PAYER]: [opRefuse.txn, opAllow.txn, payout1, payoutAlice2, payoutBob, strayPayout, axfer("PAYEROPTIN", PAYER, PAYER, 0, 85), fundPayer, payerViaApp],
  };
  const groups: Record<string, Tx[]> = Object.fromEntries(all.map((x) => [x.txn.group!, x.group]));
  return mockIndexer(accounts, groups);
}

const ledgerFor = (f: typeof fetch, now = () => Date.parse("2026-09-27T12:00:00Z")) =>
  new ActivityLedger({ networkName: "mainnet", indexerUrl: "https://idx", asaId: ASA, payTo: PAYTO, payer: PAYER, fetchImpl: f }, 60_000, now);

test("only x402 settlements become rows; plain deposits and hand-built groups are not counted", async () => {
  const r = await ledgerFor(scenario().f).get();
  const txs = r.rows.map((w) => w.customerTx);
  assert.deepEqual(txs, ["LOOK1", "BOB1", "ALICE2", "ALICE1", "UTFFAINOX5", "QU6RPL2CKP"]); // newest first
  assert.deepEqual(
    r.notCounted.map((n) => [n.tx, n.reason]),
    [
      ["HANDGROUP", "no_x402_facilitator_in_group"],
      ["APPIN", "inner_transaction"],
      ["BOL6OSV6ZP", "not_in_a_group"],
    ],
  );
  for (const excluded of ["BOL6OSV6ZP", "HANDGROUP", "3OFD77D6X6", "ZMKY3MBKIJ", "OTHERASA", "A5JKNWWMZD", "APPIN"]) assert.ok(!txs.includes(excluded), excluded);
});

test("operator self-tests are flagged and excluded from customer totals (exact address match, not prefix)", async () => {
  const r = await ledgerFor(scenario().f).get();
  const by = Object.fromEntries(r.rows.map((w) => [w.customerTx, w]));
  assert.equal(by.UTFFAINOX5.operatorTest, true);
  assert.equal(by.QU6RPL2CKP.operatorTest, true);
  assert.equal(by.ALICE1.operatorTest, false);
  assert.equal(by.LOOK1.operatorTest, false); // shares the payer's first 4 chars, still not ours
  assert.deepEqual(r.totals.customers, { addresses: 3, payments: 4, usdc: "0.200000" });
  assert.deepEqual(r.totals.operatorTests, { payments: 2, usdc: "0.100000" });
  // Payer's own funding (inner, incoming) is not a seller payment; an outgoing one via an app is, and is shown unmatched.
  assert.deepEqual(r.totals.sellerPayments, { payments: 5, usdc: "0.035000", unmatched: 2 });
});

test("each seller payment pairs with the most recent earlier unpaired customer payment", async () => {
  const r = await ledgerFor(scenario().f).get();
  const by = Object.fromEntries(r.rows.map((w) => [w.customerTx, w]));
  // Refused check (no seller payment) must not steal the next check's payout.
  assert.equal(by.QU6RPL2CKP.sellerTx, null);
  assert.equal(by.UTFFAINOX5.sellerTx, "4GMCTRIGQY");
  assert.equal(by.UTFFAINOX5.seller, SELLER1);
  assert.equal(by.UTFFAINOX5.sellerAmountUsdc, "0.010000");
  assert.equal(by.UTFFAINOX5.time, "2026-09-27T03:18:01Z");
  assert.equal(by.ALICE1.sellerTx, null);
  assert.equal(by.ALICE2.sellerTx, "PAYALICE2");
  assert.equal(by.BOB1.sellerTx, "PAYBOB");
  assert.equal(by.LOOK1.sellerTx, null);
  assert.deepEqual(r.unmatchedPayouts.map((p) => p.tx), ["APPOUT", "STRAY"]);
});

test("reads are cached for the TTL; indexer failure is an error, not an empty ledger", async () => {
  const { f, urls } = scenario();
  let now = 0;
  const l = ledgerFor(f, () => now);
  await l.get();
  const n = urls.length;
  now = 59_000;
  await l.get();
  assert.equal(urls.length, n);
  now = 61_000;
  await l.get();
  assert.ok(urls.length > n);

  const down = (async () => new Response("err", { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(ledgerFor(down).get(), /indexer 503/);
});

test("HTML escapes values, links every tx, and says 'operator test'", async () => {
  const r = await ledgerFor(scenario().f).get();
  const html = activityHtml(r);
  assert.match(html, /operator test/);
  assert.match(html, /https:\/\/allo\.info\/tx\/UTFFAINOX5/);
  assert.match(html, /https:\/\/allo\.info\/tx\/4GMCTRIGQY/);
  assert.doesNotMatch(html, /<script/i);
  assert.equal(shortAddr(PAYER), "OZ3KML…2KU6VY");
  const evil = activityHtml({ ...r, rows: [{ ...r.rows[0], amountUsdc: "<script>x</script>" }] });
  assert.doesNotMatch(evil, /<script>x/);
});

function fakeFacilitator(): FacilitatorClient {
  const NET = ALGORAND_TESTNET_CAIP2 as `${string}:${string}`;
  return {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: NET, extra: { feePayer: "FEEPAYER" } }], extensions: [], signers: {} };
    },
    async verify() {
      throw new Error("not expected");
    },
    async settle() {
      throw new Error("not expected");
    },
  };
}

test("GET /activity and /activity.json are free and cached; /v1/check still asks for payment", async () => {
  const cfg = loadConfig({});
  let calls = 0;
  const app = createApp(cfg, {
    payTo: PAYTO,
    probeDeps: { fetchImpl: fetch, paidFetch: async () => assert.fail("must not pay") },
    guard: new LocalSpendGuard(new SpendLedger(40_000n, 1_000_000n)),
    facilitator: fakeFacilitator(),
    activity: ledgerFor(scenario().f),
  });
  const j = await app.request("/activity.json");
  assert.equal(j.status, 200);
  assert.equal(j.headers.get("cache-control"), "public, max-age=60, s-maxage=60");
  assert.equal(j.headers.get("payment-required"), null);
  assert.equal((await j.json()).totals.customers.addresses, 3);
  const h = await app.request("/activity");
  assert.equal(h.status, 200);
  assert.match(h.headers.get("content-type") ?? "", /text\/html/);
  const chk = await app.request("/v1/check?url=https%3A%2F%2Fexample.com");
  assert.equal(chk.status, 402);
  assert.ok(chk.headers.get("payment-required"));

  const broken = createApp(cfg, {
    payTo: PAYTO,
    probeDeps: { fetchImpl: fetch, paidFetch: async () => assert.fail("must not pay") },
    guard: new LocalSpendGuard(new SpendLedger(40_000n, 1_000_000n)),
    facilitator: fakeFacilitator(),
    activity: { get: async () => { calls++; throw new Error("indexer 503"); } },
  });
  const b = await broken.request("/activity.json");
  assert.equal(b.status, 503);
  assert.equal(b.headers.get("cache-control"), "no-store");
  assert.equal(calls, 1);
});
