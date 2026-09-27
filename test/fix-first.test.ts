/**
 * What to fix first: every row that did not deliver lands in exactly one group, groups come from the
 * recorded reason/detail, seller strings are escaped, and the routes are free and read-only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { displayClass, readBoard, type BoardFile, type BoardRow } from "../src/board.js";
import { FIX_MODES, failureMode, fixFirst, fixFirstHtml, registerFixFirst } from "../src/fix-first.js";

function row(o: Partial<BoardRow>): BoardRow {
  return { at: "2026-09-27T04:40:00.000Z", url: "https://s.example/r", host: "s.example", method: "GET", verdict: "REFUSE", reason: "not_x402", paid: false, ...o };
}
function board(rows: BoardRow[], date = "2026-09-28"): BoardFile {
  return {
    version: 1,
    network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    networkName: "mainnet",
    date,
    startedAt: `${date}T00:30:00Z`,
    finishedAt: `${date}T01:00:00Z`,
    totals: { rows: rows.length, allow: 0, refuse: 0, skipped: 0, paidUsdc: "0" },
    rows,
  };
}

test("failure mode: the fixed table (status codes, reasons, vet402's own limits, unknown -> other)", () => {
  const m = (o: Partial<BoardRow>) => failureMode(row(o));
  assert.equal(m({ verdict: "ALLOW", reason: "delivered", paid: true }), null);
  assert.equal(m({ detail: "expected 402, got 404" }), "gone");
  assert.equal(m({ detail: "expected 402, got 410" }), "gone");
  assert.equal(m({ reason: "invalid_target", detail: "host does not resolve" }), "gone");
  assert.equal(m({ reason: "invalid_target", detail: "private address" }), "other");
  assert.equal(m({ detail: "expected 402, got 503" }), "down");
  assert.equal(m({ detail: "expected 402, got 530" }), "down");
  assert.equal(m({ detail: "expected 402, got 405" }), "wrong_method");
  assert.equal(m({ detail: "expected 402, got 200" }), "free_200");
  assert.equal(m({ detail: "expected 402, got 401" }), "auth");
  assert.equal(m({ detail: "expected 402, got 400" }), "example_rejected");
  assert.equal(m({ detail: "expected 402, got 302" }), "other");
  assert.equal(m({ detail: "402 without parseable x402 payment requirements" }), "unreadable_402");
  assert.equal(m({ reason: "requirements_body_only", detail: "x402 v2 requirements are in the 402 body only" }), "unreadable_402");
  assert.equal(m({ reason: "no_supported_accept" }), "no_accept");
  const pf = (detail: string) => m({ reason: "payment_failed", detail });
  assert.equal(pf("status 429, no settlement receipt"), "rate_limited");
  assert.equal(pf("status 402, subcent_quota_exceeded"), "facilitator_quota");
  assert.equal(pf("status 402, no settlement receipt"), "payment_refused");
  assert.equal(pf("status 402, Transaction simulation failed: transaction already in ledger: X"), "payment_refused");
  assert.equal(pf("status 400, no settlement receipt"), "example_rejected");
  assert.equal(pf("status 404, no settlement receipt"), "example_rejected");
  assert.equal(pf("status 422, no settlement receipt"), "example_rejected");
  assert.equal(pf("status 401, no settlement receipt"), "auth");
  assert.equal(pf("status 502, no settlement receipt"), "server_error_paid");
  assert.equal(pf("status 200, no settlement receipt"), "no_receipt");
  assert.equal(pf("The operation was aborted due to timeout"), "timeout");
  assert.equal(pf("something else"), "other");
  assert.equal(m({ reason: "probe_error", detail: "fetch failed" }), "timeout");
  assert.equal(m({ reason: "http_error", paid: true, delivery: "502 application/json status 502" }), "server_error_paid");
  assert.equal(m({ reason: "http_error", paid: true, delivery: "400 application/json status 400" }), "example_rejected");
  assert.equal(m({ reason: "not_json", paid: true }), "not_json");
  assert.equal(m({ reason: "empty_body", paid: true }), "not_json");
  assert.equal(m({ reason: "delivery_missing_keys", paid: true }), "missing_keys");
  assert.equal(m({ reason: "placeholder_unfillable" }), "example_placeholder");
  assert.equal(m({ reason: "price_over_cap" }), "vet402_limit");
  assert.equal(m({ verdict: "SKIPPED", reason: "daily_cap" }), "vet402_limit");
  assert.equal(m({ verdict: "SKIPPED", reason: "interrupted" }), "vet402_limit");
  assert.equal(m({ reason: "a_new_reason" }), "other");
  // Every key the table returns has a mode.
  const keys = new Set(FIX_MODES.map((x) => x.key));
  for (const k of ["gone", "down", "wrong_method", "free_200", "auth", "example_rejected", "unreadable_402", "no_accept", "rate_limited", "facilitator_quota", "payment_refused", "server_error_paid", "no_receipt", "timeout", "not_json", "missing_keys", "example_placeholder", "vet402_limit", "other"]) {
    assert.ok(keys.has(k), k);
  }
});

test("census 2026-09-27 on disk: groups add up to the rows that did not deliver, none twice, none unsorted", () => {
  const b = readBoard(join(process.cwd(), "board", "census-2026-09-27.json"));
  if (!b) return; // the file is data, not code; skip when absent
  const f = fixFirst(b);
  const notDelivered = b.rows.filter((r) => displayClass(r) !== "DELIVERED");
  assert.equal(f.rows, 1819);
  assert.equal(f.delivered, 495);
  assert.equal(f.notDelivered, notDelivered.length);
  assert.equal(f.notDelivered, 1324);
  assert.equal(f.groups.reduce((s, g) => s + g.listings, 0), 1324);
  // Each row is in exactly one group: a row's mode is a single key, and the per-group counts match it.
  const perKey = new Map<string, number>();
  for (const r of notDelivered) {
    const k = failureMode(r);
    assert.ok(k, "a row that did not deliver has a mode");
    perKey.set(k!, (perKey.get(k!) ?? 0) + 1);
  }
  for (const g of f.groups) {
    assert.equal(g.listings, perKey.get(g.key), g.key);
    assert.equal(g.hosts, g.sellers.length);
    assert.equal(g.sellers.reduce((s, x) => s + x.listings, 0), g.listings);
    assert.equal(g.byClass.DELIVERED, 0);
  }
  assert.equal(new Set(f.groups.map((g) => g.key)).size, f.groups.length);
  assert.ok(!f.groups.some((g) => g.key === "other"), "every recorded reason/detail has a group");
  // The 422 rows the board shows as UNREACHABLE (no 402 answer) are split across these groups only.
  const unreach = f.groups.filter((g) => g.byClass.UNREACHABLE > 0);
  assert.equal(unreach.reduce((s, g) => s + g.byClass.UNREACHABLE, 0), 422);
  assert.deepEqual(unreach.map((g) => g.key).sort(), ["auth", "down", "free_200", "gone", "wrong_method"]);
  // Seller groups first, most hosts first; vet402's own limits last.
  const seller = f.groups.filter((g) => g.side === "seller");
  for (let i = 1; i < seller.length; i++) {
    const a = seller[i - 1];
    const b2 = seller[i];
    assert.ok(a.hosts > b2.hosts || (a.hosts === b2.hosts && a.effort <= b2.effort), `${a.key} before ${b2.key}`);
  }
  assert.equal(f.groups.at(-1)!.key, "vet402_limit");
  assert.equal(f.groups[0].key, "example_rejected");
});

test("HTML and JSON: every seller-controlled string is escaped; seller links are encoded", () => {
  const evilHost = `x"><script>alert(1)</script>.example`;
  const b = board([
    row({ host: evilHost, url: `https://${evilHost}/`, reason: "payment_failed", detail: `status 402, <img src=x onerror=alert(2)>` }),
    row({ host: "ok.example", reason: `"><svg onload=alert(3)>`, detail: "</code><script>alert(4)</script>" }),
    row({ verdict: "ALLOW", reason: "delivered", paid: true }),
  ]);
  const html = fixFirstHtml(b);
  assert.ok(!html.includes("<script>alert"), "raw script from data");
  assert.ok(!html.includes("<img src=x"), "raw img from data");
  assert.ok(!html.includes("<svg onload"), "raw svg from data");
  assert.ok(html.includes("&lt;img src=x onerror=alert(2)&gt;"));
  assert.ok(html.includes(`href="/seller/${encodeURIComponent(evilHost)}"`));
  assert.ok(!/<script[^>]*>/.test(html), "no script element at all");
  // An unknown reason is kept, counted, and shown as text under "Not grouped yet".
  assert.ok(html.includes("Not grouped yet"));
  assert.ok(html.includes("&quot;&gt;&lt;svg onload=alert(3)&gt;"));
  const f = fixFirst(b);
  assert.equal(f.notDelivered, 2);
  assert.equal(f.groups.reduce((s, g) => s + g.listings, 0), 2);
  assert.equal(f.groups.find((g) => g.key === "payment_refused")!.sellers[0].sellerPage, `/seller/${encodeURIComponent(evilHost)}`);
  // Empty file: says not run yet.
  assert.match(fixFirstHtml(null), /Not run yet/);
});

test("routes: /board/fix-first(.json) read the latest census; ?date= only for a fixed census day", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fixfirst-"));
  writeFileSync(join(dir, "census-latest.json"), JSON.stringify(board([row({ detail: "expected 402, got 404" }), row({ verdict: "ALLOW", reason: "delivered", paid: true })], "2026-09-28")));
  writeFileSync(join(dir, "census-2026-09-27.json"), JSON.stringify(board([row({ detail: "expected 402, got 503" })], "2026-09-27")));
  writeFileSync(join(dir, "census-2026-01-01.json"), JSON.stringify(board([row({ detail: "expected 402, got 405" })], "2026-01-01")));
  const reads: string[] = [];
  const app = new Hono();
  registerFixFirst(app, join(dir, "latest.json"), async (p) => {
    reads.push(p);
    return readBoard(p);
  });
  const j = (await (await app.request("/board/fix-first.json")).json()) as ReturnType<typeof fixFirst>;
  assert.equal(j.date, "2026-09-28");
  assert.deepEqual(j.groups.map((g) => [g.key, g.listings, g.hosts]), [["gone", 1, 1]]);
  const d = (await (await app.request("/board/fix-first.json?date=2026-09-27")).json()) as ReturnType<typeof fixFirst>;
  assert.equal(d.groups[0].key, "down");
  // A day not on the fixed list falls back to the latest census (no arbitrary file names).
  const x = (await (await app.request("/board/fix-first.json?date=2026-01-01")).json()) as ReturnType<typeof fixFirst>;
  assert.equal(x.date, "2026-09-28");
  const h = await app.request("/board/fix-first?date=2026-09-27");
  assert.equal(h.status, 200);
  assert.match(h.headers.get("content-type") ?? "", /text\/html/);
  const text = await h.text();
  assert.ok(text.includes("What to fix first") && text.includes("Server error before payment"));
  assert.ok(reads.every((p) => /census-(latest|2026-09-27)\.json$/.test(p)), reads.join(","));
});
