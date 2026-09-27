/**
 * GET /board/verdicts.json (free): vet402's own settled purchases as JSON, from the same files as payments.csv.
 * Offline: board files are written to a temp dir; the facilitator is faked and never asked to verify or settle.
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
import { RECEIPT_BASE, paymentsCsv, readBoard, verdictsFeed, type BoardFile, type BoardRow, type VerdictFeedItem } from "../src/board.js";

// Tests read only local files (never GitHub raw).
process.env.BOARD_REMOTE = "off";

const PAYER = "HVRJUKO2QDZW6UKADE7LYWQFMTT75537OPMYEWOTYIUFO4BB25TFL5IQMQ";
const TX1 = "BALSINECFVZ47IP7QDRJYIRIC6YROXVEEXHU5WESVTWTHDQVTCEA";
const TX2 = "2N24D3GCR4E5SJGXF3J2XCOQVGNLE46HFRW2JWGQ5FSMT3S5OIGA";
const REAL_CENSUS = join(process.cwd(), "board", "census-latest.json");

function file(rows: Partial<BoardRow>[], over: Partial<BoardFile> = {}): BoardFile {
  const full = rows.map((r) => ({ at: "2026-09-27T01:02:03Z", url: "https://s.example/x", host: "s.example", method: "GET", verdict: "ALLOW", reason: "delivered", paid: true, ...r }) as BoardRow);
  return { version: 1, network: ALGORAND_MAINNET_CAIP2, networkName: "mainnet", date: "2026-09-27", startedAt: "", finishedAt: "", payer: PAYER, totals: { rows: full.length, allow: 0, refuse: 0, skipped: 0, paidUsdc: "0" }, rows: full, ...over };
}

const DAILY = file([{ url: "https://s.example/a?q=1", paid: true, tx: TX1, priceUsdc: "0.010000", payTo: "SELLERPAYTO", at: "2026-09-28T21:00:00Z" }], { date: "2026-09-28" });
const CENSUS = file([
  // Strings a naive HTML/JS escaper would mangle: they must come back byte for byte.
  { url: 'https://s.example/mis?a=1&b=<x>"\'', host: "s.example", verdict: "REFUSE", reason: "delivery_missing_keys", paid: true, tx: TX2, priceUsdc: "0.020000", payTo: "=HYPERLINK(1)", at: "2026-09-27T05:00:00Z" },
  { url: "https://s.example/a?q=1", verdict: "REFUSE", reason: "payment_failed", detail: "status 429, no settlement receipt", paid: false, at: "2026-09-27T04:00:00Z" },
  { url: "https://s.example/notx", verdict: "ALLOW", reason: "delivered", paid: true, at: "2026-09-27T04:10:00Z" },
  { url: "https://s.example/badtx", verdict: "ALLOW", reason: "delivered", paid: true, tx: "not-a-tx", at: "2026-09-27T04:20:00Z" },
  { url: "https://s.example/unreach", verdict: "REFUSE", reason: "not_x402", detail: "expected 402, got 404", paid: false, at: "2026-09-27T04:30:00Z" },
]);

test("verdictsFeed: only settled purchases with a tx; every field; oldest first; census/daily file named by its day", () => {
  const feed = verdictsFeed([
    { kind: "daily", board: DAILY },
    { kind: "census", board: CENSUS },
    { kind: "census", board: CENSUS }, // the same census twice (latest + dated copy): each tx once
    { kind: "census", board: null },
  ]);
  assert.equal(feed.count, 2);
  assert.equal(feed.verdicts.length, 2);
  assert.deepEqual(feed.verdicts[0], {
    purchaseTx: TX2,
    network: ALGORAND_MAINNET_CAIP2,
    payer: PAYER,
    payTo: "=HYPERLINK(1)",
    host: "s.example",
    resource: 'https://s.example/mis?a=1&b=<x>"\'',
    amountUsdc: "0.020000",
    class: "MISMATCH",
    reason: "delivery_missing_keys",
    checkedAt: "2026-09-27T05:00:00Z",
    receiptUrl: `${RECEIPT_BASE}${TX2}`,
    sourceFile: "census-2026-09-27.json",
  } satisfies VerdictFeedItem);
  assert.equal(feed.verdicts[1].purchaseTx, TX1);
  assert.equal(feed.verdicts[1].class, "DELIVERED");
  assert.equal(feed.verdicts[1].sourceFile, "2026-09-28.json");
  assert.equal(feed.verdicts[1].receiptUrl, `https://facilitator.goplausible.xyz/api/receipt/${TX1}`);
  assert.ok(feed.verdicts.every((v) => /^[A-Z2-7]{52}$/.test(v.purchaseTx)), "no row without a valid tx");
});

test("verdicts.json and payments.csv list the same purchases", () => {
  const sources = [{ kind: "daily" as const, board: DAILY }, { kind: "census" as const, board: CENSUS }];
  const csvTx = paymentsCsv([DAILY, CENSUS]).trimEnd().split("\r\n").slice(1).map((l) => l.split(",").at(-2));
  assert.deepEqual(verdictsFeed(sources).verdicts.map((v) => v.purchaseTx), csvTx);
});

test("on the published census: as many items as paid rows with a tx, none without one", { skip: !existsSync(REAL_CENSUS) }, () => {
  const raw = JSON.parse(readFileSync(REAL_CENSUS, "utf8")) as { rows: { paid?: boolean; tx?: string }[] };
  const paid = new Set(raw.rows.filter((r) => r.paid === true && typeof r.tx === "string" && /^[A-Z2-7]{52}$/.test(r.tx)).map((r) => r.tx));
  const census = readBoard(REAL_CENSUS)!;
  const feed = verdictsFeed([{ kind: "census", board: census }, { kind: "census", board: census }]);
  assert.equal(feed.count, paid.size);
  assert.ok(feed.verdicts.every((v) => paid.has(v.purchaseTx)));
  assert.equal(new Set(feed.verdicts.map((v) => v.purchaseTx)).size, feed.count);
});

test("GET /board/verdicts.json is free, plain JSON (no HTML escaping), and matches the files", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "feed-"));
  writeFileSync(join(dir, "latest.json"), JSON.stringify(DAILY));
  writeFileSync(join(dir, "census-latest.json"), JSON.stringify(CENSUS));
  writeFileSync(join(dir, "census-2026-09-27.json"), JSON.stringify(CENSUS));
  const prev = process.env.BOARD_FILE;
  process.env.BOARD_FILE = join(dir, "latest.json");
  t.after(() => {
    if (prev === undefined) delete process.env.BOARD_FILE;
    else process.env.BOARD_FILE = prev;
  });
  const calls: string[] = [];
  const NET = ALGORAND_TESTNET_CAIP2 as `${string}:${string}`;
  const facilitator: FacilitatorClient = {
    // createApp reads /supported once at start (shareInitialize); only verify/settle would mean a payment.
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NET, extra: { feePayer: "F" } }], extensions: [], signers: {} }),
    verify: async () => (calls.push("verify"), assert.fail("never verify")),
    settle: async () => (calls.push("settle"), assert.fail("never settle")),
  };
  const noSeller: ProbeDeps = { fetchImpl: async () => assert.fail("no seller"), paidFetch: async () => assert.fail("no seller") };
  const noSpend = { reserve: async () => assert.fail("no spend"), release: () => {}, commit: () => {}, headroom: async () => assert.fail("no spend") } as unknown as SpendGuard;
  const app = createApp(loadConfig({ ALLOW_PRIVATE_TARGETS: "1" }), { payTo: "VET402PAYTO", probeDeps: noSeller, guard: noSpend, facilitator });

  const res = await app.request("/board/verdicts.json");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("PAYMENT-REQUIRED"), null);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  const text = await res.text();
  assert.ok(!/&(amp|lt|gt|quot|#39);/.test(text), "no HTML entities in the JSON");
  const body = JSON.parse(text) as { count: number; verdicts: VerdictFeedItem[] };
  assert.equal(body.count, 2);
  assert.equal(body.verdicts[0].resource, 'https://s.example/mis?a=1&b=<x>"\'');
  assert.ok(body.verdicts.every((v) => v.purchaseTx && v.receiptUrl.endsWith(v.purchaseTx)));
  assert.deepEqual(calls, [], "no verify, no settle");
});
