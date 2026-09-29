/**
 * Public copy: the numbers on the landing page come from the census file they name, the fix-first headline
 * counts the way /board does (UNCLEAR is never the seller's), content notes stay on the purchases they are
 * about, and the changed pages carry no we/us/our and no em dash.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { CONTENT_NOTES, countBy, displayClass, hostOf, readBoard, type BoardFile } from "../src/board.js";
import { CHECKER_FIX_URL, FEATURED_CENSUS, demoHtml, landingHtml } from "../src/landing.js";
import { PATH_MODES, failureMode, fixFirst, fixFirstHtml } from "../src/fix-first.js";
import { sellerHtml, sellerView } from "../src/seller.js";

const board = (d: string) => readBoard(join(process.cwd(), "board", `census-${d}.json`))!;
const visible = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

test("landing: every census number is recounted from the file it links to", () => {
  const c = FEATURED_CENSUS;
  const b = board(c.date);
  const cls = countBy(b.rows, displayClass);
  assert.equal(b.rows.length, c.listed);
  assert.equal(new Set(b.rows.map(hostOf)).size, c.sellers);
  assert.deepEqual([cls.DELIVERED, cls.MISMATCH, cls.UNREACHABLE, cls.UNCLEAR], [c.delivered, c.mismatch, c.unreachable, c.unclear]);
  assert.equal(b.rows.filter((r) => r.paid).length, c.paid);
  assert.equal(Number(b.totals.paidUsdc).toFixed(2), c.paidUsdc);
  const unclear = b.rows.filter((r) => displayClass(r) === "UNCLEAR");
  const mode = (k: string) => unclear.filter((r) => failureMode(r) === k).length;
  assert.deepEqual([mode("rate_limited"), mode("facilitator_quota"), mode("vet402_limit")], [c.rateLimited, c.facilitatorQuota, c.overCap]);
  // The first run's MISMATCH rows, and what the rerun recorded for the same method and URL.
  const first = board("2026-09-27");
  const next = new Map(b.rows.map((r) => [`${r.method} ${r.url}`, r]));
  const mm = first.rows.filter((r) => displayClass(r) === "MISMATCH");
  assert.equal(mm.length, c.firstRunMismatch);
  assert.equal(mm.filter((r) => { const n = next.get(`${r.method} ${r.url}`); return n && displayClass(n) === "DELIVERED"; }).length, c.firstRunMismatchDelivered);
});

test("landing and demo: the correction is stated, with the fix commit and the rerun's census", () => {
  const html = landingHtml({ network: "algorand:mainnet", priceUsdc: "0.05", perCallUsdc: "0.100000", perDayUsdc: "3.000000", trial: true });
  const text = visible(html);
  assert.match(text, /On 28 September 2026, vet402 tried to buy 1,840 resources/);
  assert.match(text, /It paid 570 of them from its own wallet, 16\.69 USDC in total\./);
  assert.match(text, /55 of those 80 delivered/);
  assert.match(text, /The chain also shows 10 more payments from this run \(0\.095 USDC\)/);
  assert.match(text, /3 USDC per day across all customers/);
  assert.match(text, /It does not look at whether the content itself is right\./);
  assert.ok(html.includes(CHECKER_FIX_URL));
  assert.ok(html.includes('href="/board?view=census&amp;date=2026-09-28"'));
  assert.doesNotMatch(text, /took the payment and sent back something else|went through all|nobody checks|delivered what the listing promised/);
  const demo = demoHtml();
  assert.match(visible(demo), /recorded on 27 September 2026, and the 80 MISMATCH it shows come from a checker rule that later turned out to be too strict/);
  assert.match(visible(demo), /55 of those 80 delivered/);
  assert.ok(demo.includes('href="/board?view=census&amp;date=2026-09-28"'));
  assert.ok(demo.indexOf("<video") < demo.indexOf('class="fix"'), "the note sits under the video");
});

test("fix-first: the headline counts only MISMATCH and UNREACHABLE as the seller's, and says what it left out", () => {
  const b = board("2026-09-28");
  const f = fixFirst(b);
  assert.equal(f.forSeller, f.byClass.MISMATCH + f.byClass.UNREACHABLE);
  assert.equal(f.forSeller, 442);
  assert.equal(f.unclearFromPath, 524);
  assert.equal(f.unclearFromPath, b.rows.filter((r) => displayClass(r) === "UNCLEAR" && PATH_MODES.has(failureMode(r) ?? "")).length);
  const text = visible(fixFirstHtml(b));
  assert.match(text, /Counted as the seller's to fix: MISMATCH and UNREACHABLE\. Left out: every UNCLEAR row, including rate limits \(429\), the facilitator's sub-cent quota and vet402's own price limit\./);
  assert.match(text, /548 delivered\. 442 are for the seller to fix: 19 answers that did not match the listing and 423 URLs that did not ask for payment\. 850 had no clear result and are not counted against the seller; at least 524 of those came from vet402 or the payment path\./);
  assert.doesNotMatch(text, /did not deliver\. Here/);
});

test("content notes: only on the noted purchases, on /board and on the seller page; the verdict word is unchanged", () => {
  const b = board("2026-09-28");
  const noted = b.rows.filter((r) => r.tx && CONTENT_NOTES[r.tx]);
  assert.equal(noted.length, 2); // tts-1 and gpt-audio-mini on 09-28 (the 09-27 tts-1 row is in the 09-27 file)
  for (const r of noted) {
    assert.equal(r.host, "moltworld.xyz");
    assert.equal(displayClass(r), "DELIVERED");
  }
  assert.equal(board("2026-09-27").rows.filter((r) => r.tx && CONTENT_NOTES[r.tx]).length, 1);
  const v = sellerView("moltworld.xyz", { daily: null, census: b as BoardFile });
  const html = sellerHtml(v);
  assert.equal(html.split("Note added 2026-09-29").length - 1, 2);
  assert.match(visible(html), /the declared keys were present, so the result stays DELIVERED/);
  // Another seller's page carries no note.
  const other = sellerHtml(sellerView("agent402.tools", { daily: null, census: b as BoardFile }));
  assert.ok(!other.includes("Note added 2026-09-29"));
});

test("changed pages: no we/us/our, no em dash, and no promise about the content", () => {
  const b = board("2026-09-28");
  const pages = [
    landingHtml({ network: "algorand:mainnet", priceUsdc: "0.05", perCallUsdc: "0.100000", perDayUsdc: "3.000000", trial: true }),
    demoHtml(),
    fixFirstHtml(b),
    sellerHtml(sellerView("moltworld.xyz", { daily: null, census: b as BoardFile })),
    sellerHtml(sellerView("moltworld.xyz", { daily: null, census: b as BoardFile }), { auditLinkEnabled: true, auditPriceUsdc: "0.50" }),
  ];
  for (const html of pages) {
    assert.ok(!html.includes("—"), "em dash");
    assert.doesNotMatch(visible(html), /(?<![\w.-])(we|us|our|ours)(?![\w.-])/i); // a host such as x.us-west-2.example is seller data
    assert.doesNotMatch(visible(html), /matched the declaration|what the listing promised|what was promised|show it to buyers/i);
  }
});
