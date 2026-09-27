/**
 * Seller page and badge: strict host check, latest result per resource, escaping, free routes.
 * Offline: board files are written to a temp dir; the facilitator and sellers are faked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2 } from "@x402/avm";
import type { FacilitatorClient } from "@x402/core/server";
import { boardHtml, type BoardFile, type BoardRow } from "../src/board.js";
import { badgeMarkdown, badgeSvg, parseHost, sellerHtml, sellerView } from "../src/seller.js";
import { SpendLedger } from "../src/caps.js";
import { LocalSpendGuard } from "../src/spend.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import type { ProbeDeps } from "../src/probe.js";

// Tests read only local files (never GitHub raw).
process.env.BOARD_REMOTE = "off";

const TX1 = "BALSINECFVZ47IP7QDRJYIRIC6YROXVEEXHU5WESVTWTHDQVTCEA";
const CENSUS = join(process.cwd(), "board", "census-2026-09-27.json");

function file(rows: Partial<BoardRow>[], over: Partial<BoardFile> = {}): BoardFile {
  const full = rows.map((r) => ({ at: "2026-09-27T01:02:03Z", url: "https://s.example/x", host: "s.example", method: "GET", verdict: "ALLOW", reason: "delivered", paid: true, ...r }) as BoardRow);
  return { version: 1, network: ALGORAND_MAINNET_CAIP2, networkName: "mainnet", date: "2026-09-27", startedAt: "", finishedAt: "", totals: { rows: full.length, allow: 0, refuse: 0, skipped: 0, paidUsdc: "0" }, rows: full, ...over };
}

test("host check: DNS names only (lowercased); paths, ports, IPs, markup and junk are refused", () => {
  assert.equal(parseHost("agent402.tools"), "agent402.tools");
  assert.equal(parseHost("Agent402.TOOLS"), "agent402.tools");
  assert.equal(parseHost("algorand.ottoai.services"), "algorand.ottoai.services");
  assert.equal(parseHost("agenthub-production-8c75.up.railway.app"), "agenthub-production-8c75.up.railway.app");
  for (const bad of ["", "localhost", "1.2.3.4", "x.com:80", "x.com/a", "../etc/passwd", "a..b.com", "-a.com", "a-.com", "a b.com", "<script>.com", "x.com\n", "x.com.", `${"a".repeat(64)}.com`, `${"a.".repeat(130)}com`, "xn--.com", undefined]) {
    assert.equal(parseHost(bad), null, JSON.stringify(bad));
  }
});

test("seller view: latest row per resource across daily and census; delivered wins; skipped-only is not checked", () => {
  const census = file([
    { url: "https://s.example/a", verdict: "REFUSE", reason: "payment_failed", detail: "status 429, no settlement receipt", paid: false, at: "2026-09-27T04:00:00Z" },
    { url: "https://s.example/b", verdict: "REFUSE", reason: "not_x402", detail: "expected 402, got 404", paid: false, at: "2026-09-27T04:00:00Z" },
    { url: "https://other.example/a", host: "other.example" },
  ]);
  const daily = file([{ url: "https://s.example/a", verdict: "ALLOW", reason: "delivered", paid: true, tx: TX1, at: "2026-09-28T21:00:00Z" }], { date: "2026-09-28" });
  const v = sellerView("s.example", { daily, census });
  assert.equal(v.rows.length, 2);
  assert.equal(v.cls, "DELIVERED");
  assert.equal(v.deliveredDay, "2026-09-28");
  assert.deepEqual(v.counts, { DELIVERED: 1, MISMATCH: 0, UNREACHABLE: 1, UNCLEAR: 0 });
  assert.equal(v.rows[0].source, "daily");
  assert.equal(badgeSvg(v).includes("delivered 2026-09-28"), true);

  const skipped = sellerView("s.example", { daily: null, census: file([{ verdict: "SKIPPED", reason: "daily_cap", paid: false }]) });
  assert.equal(skipped.cls, null);
  assert.ok(badgeSvg(skipped).includes(">not checked<"));
  assert.ok(badgeSvg(sellerView("none.example", { daily: null, census: null })).includes(">not checked<"));

  const words: [Partial<BoardRow>, string, string][] = [
    [{ verdict: "REFUSE", reason: "delivery_missing_keys", paid: true }, "mismatch", "#d73a3a"],
    [{ verdict: "REFUSE", reason: "not_x402", detail: "expected 402, got 410", paid: false }, "unreachable", "#8a8f98"],
    [{ verdict: "REFUSE", reason: "payment_failed", detail: "status 402, subcent_quota_exceeded", paid: false }, "unclear", "#c98a06"],
  ];
  for (const [r, word, color] of words) {
    const svg = badgeSvg(sellerView("s.example", { daily: null, census: file([r]) }));
    assert.ok(svg.includes(`>${word}<`) && svg.includes(color), word);
  }
});

test("seller page and badge: every string from a file is escaped; no external script; fair method paragraph", () => {
  const v = sellerView("s.example", {
    daily: null,
    census: file([
      { url: `https://s.example/x?q=<script>alert(1)</script>`, reason: `"><img src=x onerror=alert(1)>`, detail: "</li><script>alert(2)</script>", tx: TX1, declared: { description: "<b>bold</b>" } },
      { url: "https://s.example/y", verdict: "REFUSE", reason: "delivery_missing_keys", tx: "javascript:alert(1)", paid: true, at: "<svg onload=alert(3)>" },
    ]),
  });
  const html = sellerHtml(v);
  assert.ok(!html.includes("<script>alert") && !html.includes("<img src=x") && !html.includes("<b>bold</b>") && !html.includes("<svg onload"));
  assert.ok(!html.includes("javascript:alert"));
  assert.ok(html.includes(`https://allo.info/tx/${TX1}`));
  assert.ok(!/<script/i.test(html), "no script at all");
  assert.ok(html.includes("/v1/audit?seller=s.example") && html.includes("0.50 USDC") && html.includes("Your payment settles first"));
  assert.ok(html.includes("https://perawallet.app"));
  assert.ok(html.includes(badgeMarkdown("s.example").replace(/"/g, "&quot;")));
  assert.ok(html.includes("bought the resource once") && html.includes("github.com/kzmttkc/vet402-algorand/issues"));
  assert.ok(html.includes("this is not a rating"));
  // A bad day never reaches the badge.
  const svg = badgeSvg({ cls: "DELIVERED", deliveredDay: "<x>" });
  assert.ok(svg.includes(">delivered<") && !svg.includes("<x>"));
  assert.equal(badgeMarkdown("agent402.tools"), "[![vet402](https://vet402-algorand.vercel.app/badge/agent402.tools.svg)](https://vet402-algorand.vercel.app/seller/agent402.tools)");
});

test("board links each row and each dot to /seller/<host>", () => {
  const html = boardHtml(file([{ host: "a.example", url: "https://a.example/x" }, { host: "b.example", url: "https://b.example/y" }]), "census", { date: "2026-09-27" });
  assert.ok(html.includes('href="/seller/a.example"') && html.includes('href="/seller/b.example"'));
  assert.ok(html.includes("'/seller/'+encodeURIComponent(h)"), "the dot's detail links to the seller page");
  assert.ok(html.includes('href="/board?view=census&amp;date=2026-09-27" aria-current="page"'));
  assert.ok(html.includes('href="/board?view=census&amp;date=2026-09-28"'));
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

test("routes: /seller/<host> and /badge/<host>.svg are free, read the census, cache the badge 1 h; a bad host is 400", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seller-"));
  const real = existsSync(CENSUS);
  if (real) {
    copyFileSync(CENSUS, join(dir, "census-latest.json"));
    copyFileSync(CENSUS, join(dir, "census-2026-09-27.json"));
  } else {
    const f = JSON.stringify(file([{ host: "agent402.tools", url: "https://agent402.tools/api/age", tx: TX1 }]));
    writeFileSync(join(dir, "census-latest.json"), f);
    writeFileSync(join(dir, "census-2026-09-27.json"), f);
  }
  writeFileSync(join(dir, "latest.json"), JSON.stringify(file([])));
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

    const p = await app.request("/seller/agent402.tools");
    assert.equal(p.status, 200);
    assert.equal(p.headers.get("PAYMENT-REQUIRED"), null);
    const html = await p.text();
    assert.ok(html.includes("<h1>agent402.tools</h1>"));
    assert.ok(html.includes("https://allo.info/tx/"));
    if (real) {
      assert.equal((html.match(/<li class="card">/g) ?? []).length, 581);
      assert.ok(html.includes("delivered 2026-09-27"));
    }

    const b = await app.request("/badge/agent402.tools.svg");
    assert.equal(b.status, 200);
    assert.match(b.headers.get("content-type") ?? "", /^image\/svg\+xml/);
    assert.equal(b.headers.get("cache-control"), "public, max-age=3600");
    assert.ok((await b.text()).includes("delivered 2026-09-27"));

    const none = await (await app.request("/badge/never-listed.example.svg")).text();
    assert.ok(none.includes(">not checked<"));

    for (const bad of ["/seller/localhost", "/seller/a..b.com", "/seller/%3Cscript%3E.com", "/seller/1.2.3.4", "/badge/agent402.tools.png", "/badge/localhost.svg", "/badge/x.com%2F..svg"]) {
      assert.equal((await app.request(bad)).status, 400, bad);
    }

    // Census day tabs read the dated file.
    const d = await (await app.request("/board?view=census&date=2026-09-27")).text();
    assert.ok(d.includes('aria-current="page">2026-09-27<'));
    assert.ok(d.includes('href="/seller/agent402.tools"'));
    const missing = await (await app.request("/board?view=census&date=2026-09-26")).text();
    assert.ok(missing.includes("Not run yet for 2026-09-26"));
    const junk = await (await app.request("/board?view=census&date=../../etc")).text();
    assert.ok(junk.includes('aria-current="page">latest<'), "a bad date falls back to the latest census");

    assert.deepEqual(calls, [], "facilitator never called");
  } finally {
    if (prev === undefined) delete process.env.BOARD_FILE;
    else process.env.BOARD_FILE = prev;
  }
});
