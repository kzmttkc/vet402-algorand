/**
 * Delivery certificates: notes round-trip, the page shows only what the indexer confirms,
 * and swapped ids, missing txs or forged anchors never produce a certificate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2, USDC_MAINNET_ASA_ID, USDC_TESTNET_ASA_ID } from "@x402/avm";
import type { FacilitatorClient } from "@x402/core/server";
import { Hono } from "hono";
import {
  CERT_NOTE,
  CERT_NOTE_PREFIX,
  buildCertRecord,
  certBadgeSvg,
  decodeCertNotes,
  encodeCertNotes,
  readCertificate,
  registerCert,
  type CertReaderOptions,
  type CertRecord,
} from "../src/cert.js";
import { GOPLAUSIBLE_FEE_PAYERS } from "../src/activity.js";
import { createApp } from "../src/server.js";
import { loadConfig, MAINNET_DEFAULT_PAY_TO } from "../src/config.js";
import { SpendLedger } from "../src/caps.js";
import { LocalSpendGuard } from "../src/spend.js";
import type { ProbeDeps } from "../src/probe.js";
import type { BazaarItem } from "../src/bazaar.js";
import { MAINNET_PAY_TO, NETWORKS, allowedRequirement, payToLock, DEFAULT_URL } from "../bin/vet402-cert.mjs";

const addr = (c: string) => c.repeat(58).slice(0, 58);
const txid = (c: string) => c.repeat(52).slice(0, 52);
const PAYTO = addr("V");
const PAYER = addr("P");
const SELLER = addr("S");
const CUSTOMER = addr("C");
const ATTACKER = addr("X");
const FEE = GOPLAUSIBLE_FEE_PAYERS[0];
const ASA = "10458941";
const AUDIT_TX = txid("A");
const CHECK_TX = txid("B");
const LONELY_AUDIT_TX = txid("D");
const SELLER_TX1 = txid("E");
const SELLER_TX2 = txid("F");

type T = Record<string, unknown> & { id: string; sender: string; "tx-type": string; "confirmed-round": number; "round-time": number };

const axfer = (id: string, sender: string, receiver: string, amount: number, round: number, group?: string): T => ({
  id,
  sender,
  "tx-type": "axfer",
  "confirmed-round": round,
  "round-time": 1_790_000_000 + round,
  ...(group ? { group } : {}),
  "asset-transfer-transaction": { "asset-id": Number(ASA), amount, receiver, "close-amount": 0 },
});
const feePay = (id: string, round: number, group: string): T => ({
  id,
  sender: FEE,
  "tx-type": "pay",
  "confirmed-round": round,
  "round-time": 1_790_000_000 + round,
  group,
  "payment-transaction": { amount: 0, receiver: FEE },
});
const anchorTxns = (notes: Uint8Array[], round: number, sender = PAYER, receiver = PAYER): T[] =>
  notes.map((n, i) => ({
    id: `K${String.fromCharCode(65 + (round % 26))}${String.fromCharCode(65 + i)}${sender[0]}`.repeat(13),
    sender,
    "tx-type": "pay",
    "confirmed-round": round,
    "round-time": 1_790_000_000 + round,
    "intra-round-offset": i,
    group: `anchor-${round}-${sender.slice(0, 1)}`,
    note: Buffer.from(n).toString("base64"),
    "payment-transaction": { amount: 0, receiver },
  }));

const RECORD: CertRecord = {
  v: 1,
  net: "testnet",
  c: AUDIT_TX,
  s: "seller.example",
  p: [SELLER],
  r: [
    { u: "https://seller.example/honest", m: "GET", v: "ALLOW", k: "delivered", why: "delivered", t: SELLER_TX1 },
    { u: "https://seller.example/liar", m: "GET", v: "REFUSE", k: "mismatch", why: "delivery_missing_keys", d: "missing: forecast", t: SELLER_TX2 },
    { u: "https://seller.example/pricey", m: "GET", v: "REFUSE", k: "unclear", why: "price_over_cap" },
  ],
  n: { found: 3, notChecked: 0 },
};

/** The chain as the indexer shows it. */
function chain(extra: T[] = [], rec: CertRecord = RECORD, customer = CUSTOMER) {
  return [
    axfer(AUDIT_TX, customer, PAYTO, 500_000, 100, "g1"),
    feePay(txid("Q"), 100, "g1"),
    axfer(CHECK_TX, customer, PAYTO, 50_000, 90, "g0"),
    feePay(txid("R"), 90, "g0"),
    axfer(LONELY_AUDIT_TX, customer, PAYTO, 500_000, 95, "g9"),
    feePay(txid("Y"), 95, "g9"),
    axfer(SELLER_TX1, PAYER, SELLER, 10_000, 102),
    axfer(SELLER_TX2, PAYER, SELLER, 10_000, 103),
    ...anchorTxns(encodeCertNotes(rec), 105),
    ...extra,
  ];
}

function indexer(txs: T[], calls: string[] = [], status = 200): typeof fetch {
  return (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    calls.push(u.pathname + u.search);
    if (status !== 200) return new Response("down", { status });
    const one = /^\/v2\/transactions\/([A-Z2-7]+)$/.exec(u.pathname);
    if (one) {
      const t = txs.find((x) => x.id === one[1]);
      return t ? Response.json({ transaction: t }) : new Response("no", { status: 404 });
    }
    if (u.pathname === "/v2/transactions") {
      const g = u.searchParams.get("group-id");
      return Response.json({ transactions: txs.filter((x) => x.group === g) });
    }
    const acct = /^\/v2\/accounts\/([A-Z2-7]+)\/transactions$/.exec(u.pathname);
    if (acct) {
      const a = acct[1];
      const prefix = Buffer.from(u.searchParams.get("note-prefix") ?? "", "base64");
      const type = u.searchParams.get("tx-type");
      const min = Number(u.searchParams.get("min-round") ?? 0);
      const rx = (x: T) => (x["payment-transaction"] as { receiver?: string } | undefined)?.receiver ?? (x["asset-transfer-transaction"] as { receiver?: string } | undefined)?.receiver;
      return Response.json({
        transactions: txs.filter(
          (x) =>
            (x.sender === a || rx(x) === a) &&
            (!type || x["tx-type"] === type) &&
            x["confirmed-round"] >= min &&
            (prefix.length === 0 || (typeof x.note === "string" && Buffer.from(x.note, "base64").subarray(0, prefix.length).equals(prefix))),
        ),
      });
    }
    return new Response("unknown", { status: 404 });
  }) as typeof fetch;
}

const opts = (txs: T[], o: Partial<CertReaderOptions> = {}): CertReaderOptions => ({
  networkName: "testnet",
  indexerUrl: "https://idx.test",
  asaId: ASA,
  payTo: PAYTO,
  payer: PAYER,
  auditPriceAtomic: 500_000n,
  fetchImpl: indexer(txs),
  ...o,
});

test("notes: one group of at most 16 notes of at most 1024 bytes; round-trips; wrong id or a missing part is refused", () => {
  const notes = encodeCertNotes(RECORD);
  for (const n of notes) {
    assert.ok(n.length <= 1024);
    assert.ok(Buffer.from(n).toString("latin1").startsWith(`${CERT_NOTE_PREFIX}${AUDIT_TX}:`));
  }
  assert.deepEqual(decodeCertNotes(notes, AUDIT_TX), RECORD);
  assert.equal(decodeCertNotes(notes, CHECK_TX), null, "another id");
  const big: CertRecord = {
    ...RECORD,
    r: Array.from({ length: 10 }, (_, i) => ({ u: `https://seller.example/${"x".repeat(280)}${i}`, m: "POST", v: "REFUSE" as const, k: "mismatch" as const, why: "delivery_missing_keys", d: "d".repeat(160), t: SELLER_TX1 })),
  };
  const bigNotes = encodeCertNotes(big);
  assert.ok(bigNotes.length > 1 && bigNotes.length <= 16);
  assert.ok(bigNotes.every((n) => n.length <= 1024));
  assert.deepEqual(decodeCertNotes(bigNotes, AUDIT_TX), big);
  assert.equal(decodeCertNotes(bigNotes.slice(1), AUDIT_TX), null, "a missing part");
  assert.equal(decodeCertNotes([...bigNotes, bigNotes[0]], AUDIT_TX), null, "a duplicated part");
});

test("certificate: every fact read back from the chain; stranger's purchase is not self-purchased", async () => {
  const out = await readCertificate(AUDIT_TX, opts(chain()));
  assert.ok(out.ok);
  const c = out.cert;
  assert.equal(c.seller, "seller.example");
  assert.equal(c.customer.address, CUSTOMER);
  assert.equal(c.customer.amountUsdc, "0.500000");
  assert.equal(c.selfPurchased, null);
  assert.equal(c.allPaymentsVerified, true);
  assert.equal(c.counts.paid, 2);
  assert.deepEqual(
    c.rows.map((r) => [r.k, r.why, r.payment?.verified ?? null, r.payment?.seller ?? null]),
    [
      ["delivered", "delivered", true, SELLER],
      ["mismatch", "delivery_missing_keys", true, SELLER],
      ["unclear", "price_over_cap", null, null],
    ],
  );
  assert.ok(certBadgeSvg(c).includes("delivered 1/2"), "only paid resources count as deliveries");
});

test("tamper: bad id, missing tx, swapped id (check payment, audit without anchor) and forged anchors give no certificate", async () => {
  const txs = chain();
  assert.equal((await readCertificate("not-a-tx", opts(txs))).ok, false);
  assert.deepEqual(await readCertificate("not-a-tx", opts(txs)).then((o) => !o.ok && o.status), 400);
  const missing = await readCertificate(txid("M"), opts(txs));
  assert.ok(!missing.ok && missing.status === 404 && missing.error === "not_found");
  const check = await readCertificate(CHECK_TX, opts(txs));
  assert.ok(!check.ok && check.error === "not_an_audit_payment", "a 0.05 check payment is not an audit");
  const lonely = await readCertificate(LONELY_AUDIT_TX, opts(txs));
  assert.ok(!lonely.ok && lonely.error === "no_certificate", "an audit payment vet402 wrote nothing for");
  const sellerTx = await readCertificate(SELLER_TX1, opts(txs));
  assert.ok(!sellerTx.ok && sellerTx.error === "not_an_audit_payment", "vet402's own payment to a seller is not a certificate id");

  // Anyone can send the payer a note with the right prefix: it is ignored.
  const forgedRec: CertRecord = { ...RECORD, c: LONELY_AUDIT_TX, s: "evil.example", r: [{ u: "https://evil.example/x", m: "GET", v: "ALLOW", k: "delivered", why: "delivered" }] };
  const forged = [...txs, ...anchorTxns(encodeCertNotes(forgedRec), 110, ATTACKER, PAYER)];
  const f = await readCertificate(LONELY_AUDIT_TX, opts(forged));
  assert.ok(!f.ok && f.error === "no_certificate");
  // The payer paying someone else with the note (not a self-payment) does not count either.
  const f2 = await readCertificate(LONELY_AUDIT_TX, opts([...txs, ...anchorTxns(encodeCertNotes(forgedRec), 111, PAYER, ATTACKER)]));
  assert.ok(!f2.ok && f2.error === "no_certificate");

  // An x402-looking payment to payTo without the facilitator in its group is not an audit payment.
  const noFac = chain().filter((t) => t.id !== txid("Q"));
  const nf = await readCertificate(AUDIT_TX, opts(noFac));
  assert.ok(!nf.ok && nf.error === "not_an_audit_payment");

  // The same anchor read on another network, or for another payTo, is refused.
  assert.equal((await readCertificate(AUDIT_TX, opts(txs, { networkName: "mainnet" }))).ok, false);
  assert.equal((await readCertificate(AUDIT_TX, opts(txs, { payTo: addr("Z") }))).ok, false);
});

test("tamper: a seller payment that is not what the record says is marked not verified, never shown as a payment", async () => {
  const rec: CertRecord = { ...RECORD, r: [{ ...RECORD.r[0], t: txid("G") }, { ...RECORD.r[1], t: txid("H") }, { ...RECORD.r[0], u: "https://seller.example/early", t: txid("J") }] };
  const txs = [
    ...chain([], rec),
    axfer(txid("G"), ATTACKER, SELLER, 10_000, 102), // not from the payer
    axfer(txid("J"), PAYER, SELLER, 10_000, 99), // before the customer's payment
  ];
  const out = await readCertificate(AUDIT_TX, opts(txs));
  assert.ok(out.ok);
  assert.equal(out.cert.allPaymentsVerified, false);
  assert.deepEqual(
    out.cert.rows.map((r) => [r.payment?.verified, r.payment?.problem]),
    [
      [false, "not sent by vet402's payer wallet"],
      [false, "not found on-chain"],
      [false, "made before the customer's payment"],
    ],
  );
  assert.equal(out.cert.counts.paid, 0);
  assert.ok(certBadgeSvg(out.cert).includes("(unverified)"));
});

test("self-purchase is stated: customer is vet402's wallet or the seller's payTo", async () => {
  const byPayer = await readCertificate(AUDIT_TX, opts(chain([], RECORD, PAYER)));
  assert.ok(byPayer.ok && byPayer.cert.selfPurchased === "vet402");
  const bySeller = await readCertificate(AUDIT_TX, opts(chain([], RECORD, SELLER)));
  assert.ok(bySeller.ok && bySeller.cert.selfPurchased === "seller");
  assert.ok(certBadgeSvg(bySeller.cert).includes("self-purchased"));
  const app = new Hono();
  registerCert(app, opts(chain([], RECORD, SELLER)), "https://vet402.example");
  const html = await (await app.request(`/cert/${AUDIT_TX}`)).text();
  assert.ok(html.includes("<b>self-purchased</b>"));
});

test("GET /cert/:id and badge: 200 with the facts, the fixed note and the Markdown; 404/400/503 otherwise", async () => {
  const calls: string[] = [];
  const app = new Hono();
  registerCert(app, opts(chain(), { fetchImpl: indexer(chain(), calls) }), "https://vet402.example");
  const res = await app.request(`/cert/${AUDIT_TX}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const s of [
    "Delivery certificate: seller.example",
    `https://lora.algokit.io/testnet/transaction/${SELLER_TX1}`,
    `https://lora.algokit.io/testnet/transaction/${AUDIT_TX}`,
    "delivery_missing_keys",
    CERT_NOTE.replace(/'/g, "&#39;"),
    `[![vet402 delivery certificate](https://vet402.example/cert/${AUDIT_TX}/badge.svg)](https://vet402.example/cert/${AUDIT_TX})`,
  ]) {
    assert.ok(html.includes(s), s);
  }
  assert.ok(html.includes("CCCCCC…CCCCCC"), "the customer's address is shown short");
  const n = calls.length;
  const badge = await app.request(`/cert/${AUDIT_TX}/badge.svg`);
  assert.equal(badge.status, 200);
  assert.equal(badge.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.equal(calls.length, n, "a found certificate is kept: no second indexer read");
  assert.equal((await app.request(`/cert/${CHECK_TX}`)).status, 404);
  assert.equal((await app.request(`/cert/${CHECK_TX}/badge.svg`)).status, 404);
  assert.equal((await app.request("/cert/..%2F..%2Fetc")).status, 400);
  const down = new Hono();
  registerCert(down, opts([], { fetchImpl: indexer([], [], 500) }));
  assert.equal((await down.request(`/cert/${AUDIT_TX}`)).status, 503);
});

// ---------------------------------------------------------------- /v1/audit issues the certificate

const NET = ALGORAND_TESTNET_CAIP2;
const HOST = "http://localhost:4031";
function fakeFacilitator(tx: string): FacilitatorClient {
  const N = NET as `${string}:${string}`;
  return {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: N, extra: { feePayer: "FEEPAYER" } }], extensions: [], signers: {} };
    },
    async verify() {
      return { isValid: true, payer: CUSTOMER };
    },
    async settle() {
      return { success: true, transaction: tx, network: N, payer: CUSTOMER };
    },
  };
}
const accept = (amount: string) => ({ scheme: "exact", network: NET, asset: ASA, amount, payTo: SELLER, maxTimeoutSeconds: 60, extra: {} });
const ITEMS: BazaarItem[] = [{ resourceUrl: `${HOST}/honest`, method: "GET", accepts: [accept("10000")] }];
const sellerDeps: ProbeDeps = {
  fetchImpl: async (url) =>
    new Response("{}", {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": Buffer.from(
          JSON.stringify({ x402Version: 2, resource: { url, description: "d", mimeType: "application/json" }, accepts: [accept("10000")], extensions: { bazaar: { info: { output: { type: "json", example: { a: 1 } } } } } }),
        ).toString("base64"),
      },
    }),
  paidFetch: async () => ({
    response: new Response(JSON.stringify({ a: 1 }), { status: 200, headers: { "content-type": "application/json" } }),
    settle: { success: true, transaction: SELLER_TX1, network: NET },
    signed: true,
  }),
};

async function paidAudit(anchor: (n: Uint8Array[]) => Promise<{ txIds: string[] }>, customerTx = AUDIT_TX) {
  const cfg = loadConfig({ ALLOW_PRIVATE_TARGETS: "1" });
  const app = createApp(cfg, {
    payTo: PAYTO,
    probeDeps: sellerDeps,
    guard: new LocalSpendGuard(new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic)),
    facilitator: fakeFacilitator(customerTx),
    catalog: { items: async () => ITEMS },
    cert: { anchor, reader: opts([]) },
  });
  const path = `/v1/audit?seller=${SELLER}`;
  const first = await app.request(path);
  assert.equal(first.status, 402);
  const pr = JSON.parse(Buffer.from(first.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
  const payload = { x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { paymentGroup: [], paymentIndex: 0 } };
  const paid = await app.request(`https://vet402.example${path}`, { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify(payload)).toString("base64") } });
  return { app, paid };
}

test("/v1/audit: after the audit, the record is anchored and the answer carries certificateUrl", async () => {
  let written: Uint8Array[] = [];
  const { paid } = await paidAudit(async (notes) => {
    written = notes;
    return { txIds: [txid("N")] };
  });
  assert.equal(paid.status, 200);
  const b = (await paid.json()) as { certificateUrl?: string; certificateTx?: string };
  assert.equal(b.certificateUrl, `https://vet402.example/cert/${AUDIT_TX}`);
  assert.equal(b.certificateTx, txid("N"));
  const rec = decodeCertNotes(written, AUDIT_TX);
  assert.ok(rec);
  assert.equal(rec.c, AUDIT_TX);
  assert.deepEqual(rec.p, [SELLER]);
  assert.deepEqual(rec.r.map((r) => [r.v, r.why, r.t]), [["ALLOW", "delivered", SELLER_TX1]]);
});

test("/v1/audit: anchor failure still answers 200 with certificateError; the customer's result is not lost", async () => {
  const { paid } = await paidAudit(async () => {
    throw new Error("algod down");
  });
  assert.equal(paid.status, 200);
  const b = (await paid.json()) as { certificateUrl?: string; certificateError?: string; results: unknown[] };
  assert.equal(b.certificateUrl, undefined);
  assert.match(b.certificateError!, /algod down/);
  assert.equal(b.results.length, 1);
  const bad = await paidAudit(async () => ({ txIds: [] }), "NOT_A_TX");
  assert.match(((await bad.paid.json()) as { certificateError: string }).certificateError, /no Algorand tx id/);
});

test("buildCertRecord: seller tx only when the payment settled", () => {
  const rec = buildCertRecord(
    "testnet",
    { seller: "s.example", targets: [{ payTo: SELLER } as never], found: 2, notChecked: { total: 1, counts: {}, items: [] } },
    {
      results: [
        { resourceUrl: "u1", url: "u1", method: "GET", input: "", listedPriceUsdc: "0.01", verdict: "REFUSE", reason: "payment_failed", class: "unclear", downstreamPayment: { success: false, transaction: SELLER_TX1, network: NET } as never },
      ],
    },
    AUDIT_TX,
  );
  assert.equal(rec.r[0].t, undefined);
  assert.deepEqual(rec.n, { found: 2, notChecked: 1 });
});

test("CLI: pays only vet402's audit price, in USDC, to vet402's MainNet address with the public URL", () => {
  assert.equal(MAINNET_PAY_TO, MAINNET_DEFAULT_PAY_TO);
  assert.equal(NETWORKS.mainnet.caip2, ALGORAND_MAINNET_CAIP2);
  assert.equal(NETWORKS.testnet.caip2, ALGORAND_TESTNET_CAIP2);
  assert.equal(NETWORKS.mainnet.usdc, String(USDC_MAINNET_ASA_ID));
  assert.equal(NETWORKS.testnet.usdc, String(USDC_TESTNET_ASA_ID));
  const lock = { network: "mainnet", maxAtomic: 500_000n, payTo: payToLock(DEFAULT_URL, "mainnet") };
  const r = { scheme: "exact", network: ALGORAND_MAINNET_CAIP2, asset: String(USDC_MAINNET_ASA_ID), amount: "500000", payTo: MAINNET_PAY_TO };
  assert.equal(allowedRequirement(r, lock), true);
  assert.equal(allowedRequirement({ ...r, payTo: SELLER }, lock), false);
  assert.equal(allowedRequirement({ ...r, amount: "500001" }, lock), false);
  assert.equal(allowedRequirement({ ...r, asset: "1" }, lock), false);
  assert.equal(allowedRequirement({ ...r, network: ALGORAND_TESTNET_CAIP2 }, lock), false);
  assert.equal(payToLock("http://localhost:4021", "testnet"), undefined);
});
