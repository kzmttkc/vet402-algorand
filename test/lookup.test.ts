/**
 * GET /v1/verdict (paid, 0.001 USDC): vet402's own earlier purchase for a URL, read from the board files.
 * vet402 pays nobody here: the seller fetchers and the spend guard fail the test if touched.
 * Also: GET /board/payments.csv (free), the UNCLEAR note on /board and /seller, the grey UNCLEAR badge.
 * Offline: board files are written to a temp dir; the facilitator is faked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2 } from "@x402/avm";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import type { ProbeDeps } from "../src/probe.js";
import type { SpendGuard } from "../src/spend.js";
import { PAYMENTS_CSV_HEADER, UNCLEAR_NOTE, boardHtml, paymentsCsv, readBoard, type BoardFile, type BoardRow } from "../src/board.js";
import { badgeSvg, sellerHtml, sellerView } from "../src/seller.js";
import { lookupVerdict, normalizeTargetUrl } from "../src/lookup.js";

// Tests read only local files (never GitHub raw).
process.env.BOARD_REMOTE = "off";

const VET402 = "VET402PAYTOVET402PAYTOVET402PAYTOVET402PAYTOVET402PAYTOVET4";
const PAYER = "HVRJUKO2QDZW6UKADE7LYWQFMTT75537OPMYEWOTYIUFO4BB25TFL5IQMQ";
const TX1 = "BALSINECFVZ47IP7QDRJYIRIC6YROXVEEXHU5WESVTWTHDQVTCEA";
const TX2 = "2N24D3GCR4E5SJGXF3J2XCOQVGNLE46HFRW2JWGQ5FSMT3S5OIGA";
const REAL_CENSUS = join(process.cwd(), "board", "census-latest.json");

function file(rows: Partial<BoardRow>[], over: Partial<BoardFile> = {}): BoardFile {
  const full = rows.map((r) => ({ at: "2026-09-27T01:02:03Z", url: "https://s.example/x", host: "s.example", method: "GET", verdict: "ALLOW", reason: "delivered", paid: true, ...r }) as BoardRow);
  return { version: 1, network: ALGORAND_MAINNET_CAIP2, networkName: "mainnet", date: "2026-09-27", startedAt: "", finishedAt: "", payer: PAYER, totals: { rows: full.length, allow: 0, refuse: 0, skipped: 0, paidUsdc: "0" }, rows: full, ...over };
}

type Trace = string[];

function fakeFacilitator(trace: Trace): FacilitatorClient {
  const NET = ALGORAND_TESTNET_CAIP2 as `${string}:${string}`;
  return {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: NET, extra: { feePayer: "FEEPAYER" } }], extensions: [], signers: {} };
    },
    async verify() {
      trace.push("verify");
      return { isValid: true, payer: "CUSTOMER" };
    },
    async settle() {
      trace.push("settle");
      return { success: true, transaction: "CUSTOMER_TX", network: NET, payer: "CUSTOMER" };
    },
  };
}

/** Any touch of a seller or of vet402's spending fails the test. */
const noSeller: ProbeDeps = {
  fetchImpl: async () => assert.fail("seller must not be contacted"),
  paidFetch: async () => assert.fail("seller must not be paid"),
};
const noSpend: SpendGuard = {
  reserve: async () => assert.fail("no spend may be reserved"),
  release: () => assert.fail("no spend may be released"),
  commit: () => assert.fail("no spend may be committed"),
  headroom: async () => assert.fail("no daily cap read"),
};

const DAILY = file(
  [
    { url: "https://s.example/a?q=1", verdict: "ALLOW", reason: "delivered", paid: true, tx: TX1, priceUsdc: "0.010000", payTo: "SELLERPAYTO", at: "2026-09-28T21:00:00Z" },
  ],
  { date: "2026-09-28" },
);
const CENSUS = file([
  { url: "https://s.example/a?q=1", verdict: "REFUSE", reason: "payment_failed", detail: "status 429, no settlement receipt", paid: false, at: "2026-09-27T04:00:00Z" },
  { url: "https://s.example/unclear", verdict: "REFUSE", reason: "payment_failed", detail: "status 402, subcent_quota_exceeded", paid: false, at: "2026-09-27T04:00:00Z" },
  { url: "https://s.example/mis", verdict: "REFUSE", reason: "delivery_missing_keys", paid: true, tx: TX2, priceUsdc: "0.020000", payTo: "=HYPERLINK(1)", at: "2026-09-27T05:00:00Z" },
  { url: "https://s.example/skipped", verdict: "SKIPPED", reason: "daily_cap", paid: false },
]);

function setup(t: { after: (fn: () => void) => void }, daily: BoardFile = DAILY, census: BoardFile = CENSUS) {
  const dir = mkdtempSync(join(tmpdir(), "lookup-"));
  writeFileSync(join(dir, "latest.json"), JSON.stringify(daily));
  writeFileSync(join(dir, "census-latest.json"), JSON.stringify(census));
  const prev = process.env.BOARD_FILE;
  process.env.BOARD_FILE = join(dir, "latest.json");
  t.after(() => {
    if (prev === undefined) delete process.env.BOARD_FILE;
    else process.env.BOARD_FILE = prev;
  });
  const trace: Trace = [];
  const cfg = loadConfig({ ALLOW_PRIVATE_TARGETS: "1" });
  const app = createApp(cfg, { payTo: VET402, probeDeps: noSeller, guard: noSpend, facilitator: fakeFacilitator(trace) });
  return { app, trace, dir };
}

const q = (url: string) => `/v1/verdict?url=${encodeURIComponent(url)}`;

async function signatureFor(app: ReturnType<typeof createApp>, path: string) {
  const first = await app.request(path);
  assert.equal(first.status, 402);
  const pr = JSON.parse(Buffer.from(first.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
  return { pr, sig: Buffer.from(JSON.stringify({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { paymentGroup: [], paymentIndex: 0 } })).toString("base64") };
}

test("unpaid /v1/verdict: 402 at 0.001 USDC with the challenge tag and a Bazaar declaration; the facilitator is not asked to verify", async (t) => {
  const { app, trace } = setup(t);
  const res = await app.request(q("https://s.example/a?q=1"));
  assert.equal(res.status, 402);
  const pr = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
  assert.equal(pr.accepts[0].amount, "1000");
  assert.equal(pr.accepts[0].payTo, VET402);
  assert.equal(pr.accepts[0].extra.tag, "x402-global-challenge");
  const bazaar = pr.extensions?.bazaar;
  assert.ok(bazaar, "Bazaar extension declared");
  assert.deepEqual(bazaar.info.input, { type: "http", queryParams: { url: "https://seller.example/v1/data" }, method: "GET" });
  assert.equal(bazaar.info.output.example.class, "DELIVERED");
  assert.deepEqual(((await res.json()) as { lookup: unknown }).lookup, { found: true, match: "exact", results: 1 });
  assert.deepEqual(trace, []);
});

test("free pre-check: a URL with no result is 404 before any payment (no verify, no settle); SKIPPED rows are not results", async (t) => {
  const { app, trace } = setup(t);
  for (const u of ["https://never.example/x", "https://s.example/skipped"]) {
    const res = await app.request(q(u));
    assert.equal(res.status, 404, u);
    assert.equal(res.headers.get("PAYMENT-REQUIRED"), null);
    assert.equal(((await res.json()) as { error: string }).error, "no_result");
  }
  assert.equal((await app.request("/v1/verdict")).status, 400);
  assert.equal((await app.request(q("ftp://s.example/a"))).status, 400);
  assert.deepEqual(trace, []);
});

test("paid /v1/verdict: settles the customer, then answers from the files; the newest result wins; no seller contact, no spend", async (t) => {
  const { app, trace } = setup(t);
  const path = q("https://s.example/a?q=1");
  const { sig } = await signatureFor(app, path);
  const res = await app.request(path, { headers: { "PAYMENT-SIGNATURE": sig } });
  assert.equal(res.status, 200);
  assert.deepEqual(trace, ["verify", "settle"], "only the customer's payment moves");
  assert.ok(res.headers.get("PAYMENT-RESPONSE"));
  const b = (await res.json()) as Record<string, unknown> & { customerPayment: { transaction: string; amount: string }; results: unknown[] };
  assert.equal(b.class, "DELIVERED");
  assert.equal(b.reason, "delivered");
  assert.equal(b.date, "2026-09-28");
  assert.equal(b.sellerTx, TX1);
  assert.equal(b.sellerTxUrl, `https://allo.info/tx/${TX1}`);
  assert.equal(b.match, "exact");
  assert.equal(b.countedAgainstSeller, true);
  assert.equal(b.customerPayment.transaction, "CUSTOMER_TX");
  assert.equal(b.customerPayment.amount, "1000");
  assert.equal(b.results.length, 1);
});

test("paid /v1/verdict: UNCLEAR says it is not counted against the seller; a URL without the example query matches by path", async (t) => {
  const { app, trace } = setup(t);
  const unclear = q("https://s.example/unclear");
  const r1 = await app.request(unclear, { headers: { "PAYMENT-SIGNATURE": (await signatureFor(app, unclear)).sig } });
  const b1 = (await r1.json()) as Record<string, unknown>;
  assert.equal(b1.class, "UNCLEAR");
  assert.equal(b1.countedAgainstSeller, false);
  assert.equal(b1.unclearNote, UNCLEAR_NOTE);
  assert.equal(b1.sellerTx, undefined);

  const bare = q("https://S.example/a");
  const r2 = await app.request(bare, { headers: { "PAYMENT-SIGNATURE": (await signatureFor(app, bare)).sig } });
  const b2 = (await r2.json()) as { match: string; latest: { url: string } };
  assert.equal(b2.match, "path");
  assert.equal(b2.latest.url, "https://s.example/a?q=1");
  assert.deepEqual(trace, ["verify", "settle", "verify", "settle"]);
});

test("paid /v1/verdict for a URL with no result: 404 after verify and before settle (customer not charged)", async (t) => {
  const { app, trace } = setup(t);
  const { sig } = await signatureFor(app, q("https://s.example/a?q=1"));
  // The signature is for another URL's resource; the route's requirements are the same, so it verifies.
  const res = await app.request(q("https://never.example/x"), { headers: { "PAYMENT-SIGNATURE": sig } });
  assert.equal(res.status, 404);
  assert.ok(!trace.includes("settle"), `settled: ${trace.join(",")}`);
});

test("HEAD /v1/verdict is priced like GET: unpaid HEAD is a 402 and never verifies or settles", async (t) => {
  const { app, trace } = setup(t);
  const res = await app.request(q("https://s.example/a?q=1"), { method: "HEAD" });
  assert.equal(res.status, 402);
  assert.deepEqual(trace, []);
  const none = await app.request(q("https://never.example/x"), { method: "HEAD" });
  assert.equal(none.status, 404);
  assert.deepEqual(trace, []);
});

test("exact path only: /v1/verdict/, /V1/verdict, /v1//verdict with a payment are refused before settlement", async (t) => {
  const { app, trace } = setup(t);
  const { sig } = await signatureFor(app, q("https://s.example/a?q=1"));
  const enc = encodeURIComponent("https://s.example/a?q=1");
  for (const path of [`/v1/verdict/?url=${enc}`, `/V1/verdict?url=${enc}`, `/v1//verdict?url=${enc}`, `/v1/verdict/x?url=${enc}`]) {
    for (const method of ["GET", "HEAD"]) {
      const res = await app.request(path, { method, headers: { "PAYMENT-SIGNATURE": sig } });
      assert.ok([402, 404].includes(res.status), `${method} ${path} -> ${res.status}`);
      assert.ok(!trace.includes("settle"), `${method} ${path} settled the customer's payment (trace ${trace.join(",")})`);
    }
    const unpaid = await app.request(path);
    assert.ok([402, 404].includes(unpaid.status), `${path} -> ${unpaid.status}`);
  }
  assert.ok(!trace.includes("settle"));
});

test("/v1/check keeps its own price and settle-first order with /v1/verdict mounted in front", async (t) => {
  const { app } = setup(t);
  const res = await app.request("/v1/check?url=http://localhost:4031/honest");
  assert.equal(res.status, 402);
  const pr = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
  assert.equal(pr.accepts[0].amount, "50000");
  assert.match(pr.resource.description, /before your first payment to it/);
});

test("lookupVerdict: exact beats path; normalizes host case and drops the fragment", () => {
  const u = normalizeTargetUrl("https://S.EXAMPLE/a?q=1#frag")!;
  const hit = lookupVerdict(u, { daily: DAILY, census: CENSUS })!;
  assert.equal(hit.match, "exact");
  assert.equal(hit.latest.source, "daily");
  assert.equal(lookupVerdict(normalizeTargetUrl("https://s.example/zzz")!, { daily: DAILY, census: CENSUS }), null);
  assert.equal(normalizeTargetUrl("javascript:alert(1)"), null);
  assert.equal(normalizeTargetUrl("x".repeat(3000)), null);
});

test("payments.csv: one line per settled vet402 payment, deduplicated by tx, oldest first; formula cells neutralised", () => {
  const dup = file([{ url: "https://s.example/a?q=1", paid: true, tx: TX1, at: "2026-09-28T21:00:00Z", payTo: "SELLERPAYTO", priceUsdc: "0.010000" }]);
  const csv = paymentsCsv([DAILY, CENSUS, dup, null]);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], PAYMENTS_CSV_HEADER.join(","));
  assert.equal(lines.length, 3, csv);
  assert.equal(lines[1], `2026-09-27T05:00:00Z,${PAYER},'=HYPERLINK(1),s.example,0.020000,${TX2},MISMATCH`);
  assert.equal(lines[2], `2026-09-28T21:00:00Z,${PAYER},SELLERPAYTO,s.example,0.010000,${TX1},DELIVERED`);
});

test("payments.csv on the published census: as many lines as the census has paid rows with a tx", { skip: !existsSync(REAL_CENSUS) }, () => {
  const raw = JSON.parse(readFileSync(REAL_CENSUS, "utf8")) as { payer: string; rows: { paid?: boolean; tx?: string }[] };
  const paid = new Set(raw.rows.filter((r) => r.paid === true && typeof r.tx === "string" && /^[A-Z2-7]{52}$/.test(r.tx)).map((r) => r.tx));
  const census = readBoard(REAL_CENSUS)!;
  const lines = paymentsCsv([census, census]).trimEnd().split("\r\n").slice(1);
  assert.equal(lines.length, paid.size);
  assert.ok(lines.every((l) => l.split(",")[1] === raw.payer));
  assert.equal(new Set(lines.map((l) => l.split(",")[5])).size, lines.length);
});

test("GET /board/payments.csv is free, text/csv, daily + census merged", async (t) => {
  const { app, trace } = setup(t);
  const res = await app.request("/board/payments.csv");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("PAYMENT-REQUIRED"), null);
  assert.match(res.headers.get("content-type") ?? "", /^text\/csv/);
  const lines = (await res.text()).trimEnd().split("\r\n");
  assert.equal(lines.length, 3);
  assert.deepEqual(trace, []);
});

test("UNCLEAR rows carry the not-counted note on /board and /seller; the UNCLEAR badge is grey, not red", () => {
  const html = boardHtml(CENSUS, "census");
  assert.ok(html.includes(`<small class="nc">${UNCLEAR_NOTE}</small>`));
  // Three UNCLEAR rows (429, facilitator quota, vet402's own daily cap), plus once in the page script.
  assert.equal(html.split(UNCLEAR_NOTE).length - 1, 3 + 1);
  const v = sellerView("s.example", { daily: null, census: file([{ url: "https://s.example/unclear", verdict: "REFUSE", reason: "payment_failed", detail: "status 429, no settlement receipt", paid: false }]) });
  assert.equal(v.cls, "UNCLEAR");
  assert.ok(sellerHtml(v).includes(UNCLEAR_NOTE));
  const svg = badgeSvg(v);
  assert.ok(svg.includes('fill="#9f9f9f"'));
  assert.ok(!svg.includes("#d73a3a") && !svg.includes("#c98a06"));
  // A DELIVERED seller page has no such note.
  assert.ok(!sellerHtml(sellerView("s.example", { daily: DAILY, census: null })).includes(UNCLEAR_NOTE));
});
