/**
 * Placeholders in a seller's example input (GitHub issue #1, hashlock.pronodealgo.xyz):
 * fresh random values where vet402 can make one, no purchase where it must not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2, USDC_MAINNET_ASA_ID, USDC_TESTNET_ASA_ID } from "@x402/avm";
import { fillPlaceholder, fillPlaceholders, isPlaceholder, placeholderHint } from "../src/placeholder.js";
import { buildPaidRequest, buildRequest, withInput, type BazaarItem } from "../src/bazaar.js";
import { runSweep, selectCandidates, type Candidate, type SelectOptions } from "../scripts/board-sweep.js";
import { boardHtml, displayClass, parseBoard, type BoardFile } from "../src/board.js";
import { planAudit } from "../src/audit.js";
import { probe, type ProbeDeps, type ProbeResult } from "../src/probe.js";
import { SpendLedger } from "../src/caps.js";
import { LocalSpendGuard } from "../src/spend.js";
import { loadConfig } from "../src/config.js";

const HEX64 = /^[0-9a-f]{64}$/;
const NET = ALGORAND_MAINNET_CAIP2;
const USDC = String(USDC_MAINNET_ASA_ID);
const NOW = new Date("2026-09-28T00:30:00Z");

/** Hashlock's two listings, as published in the Bazaar on 2026-09-28. */
const HASHLOCK_BODY = { hash: "<sha256-hex-64-chars>", filename: "document.pdf", source: "agent" };
const HASHLOCK_BATCH_BODY = { files: [{ hash: "<sha256-hex-64-chars>", filename: "a.pdf" }, { hash: "<sha256-hex-64-chars>" }], source: "agent" };

function post(url: string, body: unknown, o: { amount?: string; network?: string; asset?: string; payTo?: string; settleCount?: number } = {}): BazaarItem {
  return {
    resourceUrl: url,
    method: "POST",
    accepts: [{ scheme: "exact", network: o.network ?? NET, asset: o.asset ?? USDC, amount: o.amount ?? "5000", payTo: o.payTo ?? "SELLER" }],
    lastSeen: "2026-09-27T00:00:00Z",
    settleCount: o.settleCount,
    discoveryInfo: { input: { method: "POST", bodyType: "json", body } },
  };
}

const opts = (over: Partial<SelectOptions> = {}): SelectOptions => ({
  network: NET,
  usdcAsaId: USDC,
  maxPerCallAtomic: 100_000n,
  now: NOW,
  maxAgeDays: null,
  ownAddresses: [],
  allowPrivate: false,
  perHost: false,
  ...over,
});

// --- 1. Hashlock: 64 fresh hex characters, a different value each run

test("Hashlock example: <sha256-hex-64-chars> becomes 64 random hex characters, different on every run", () => {
  const item = post("https://hashlock.pronodealgo.xyz/hashlock-algo-mainnet/api/timestamp", HASHLOCK_BODY);
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const b = buildRequest(item);
    assert.equal(b.ok, true);
    if (!b.ok) return;
    const sent = JSON.parse(b.body!);
    assert.match(sent.hash, HEX64);
    assert.equal(sent.filename, "document.pdf");
    assert.equal(sent.source, "agent");
    assert.deepEqual(b.filled, ["hash"]);
    assert.equal(b.unfillable, undefined);
    assert.ok(b.input.includes(sent.hash.slice(0, 20)), "the board shows the value actually sent");
    seen.add(sent.hash);
  }
  assert.equal(seen.size, 20, "never the same hash twice (the seller answers 409 for a hash it already timestamped)");
});

test("Hashlock batch example: each placeholder gets its own value; paths are recorded", () => {
  const b = buildRequest(post("https://hashlock.pronodealgo.xyz/hashlock-algo-mainnet/api/timestamp-batch", HASHLOCK_BATCH_BODY, { amount: "100000" }));
  assert.equal(b.ok, true);
  if (!b.ok) return;
  const sent = JSON.parse(b.body!);
  assert.match(sent.files[0].hash, HEX64);
  assert.match(sent.files[1].hash, HEX64);
  assert.notEqual(sent.files[0].hash, sent.files[1].hash);
  assert.equal(sent.files[0].filename, "a.pdf");
  assert.deepEqual(b.filled, ["files[0].hash", "files[1].hash"]);
});

test("hints: length from the hint, hash names, uuid, {{...}}", () => {
  const val = (h: string) => {
    const f = fillPlaceholder(h);
    assert.equal(f.ok, true, h);
    return f.ok ? f.value : "";
  };
  assert.match(val("sha256-hex-64-chars"), HEX64);
  assert.match(val("64-hex-sha256"), HEX64);
  assert.match(val("64 hex chars: sha256 Merkle root of the item records"), HEX64);
  assert.match(val("merkle-root-hex"), HEX64);
  assert.match(val("sha-256 hex"), HEX64, "the 256 of sha-256 is not a length");
  assert.match(val("32-hex-nonce"), /^[0-9a-f]{32}$/);
  assert.match(val("md5"), /^[0-9a-f]{32}$/);
  assert.match(val("uuid"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const r = fillPlaceholders({ id: "{{uuid}}", n: 1 });
  assert.deepEqual(r.filled, ["id"]);
  assert.notEqual(r.value.id, "{{uuid}}");
});

test("schema-style query params: format, pattern and length are respected", () => {
  const b = buildRequest({
    resourceUrl: "https://s.example/q",
    method: "GET",
    accepts: [],
    discoveryInfo: {
      input: {
        method: "GET",
        queryParams: {
          digest: { type: "string", pattern: "^[a-f0-9]{40}$", example: "<hex digest>" },
          req: { type: "string", format: "uuid", example: "<request id>" },
          plain: "hello",
        },
      },
    },
  });
  assert.equal(b.ok, true);
  if (!b.ok) return;
  const u = new URL(b.url);
  assert.match(u.searchParams.get("digest")!, /^[a-f0-9]{40}$/);
  assert.match(u.searchParams.get("req")!, /^[0-9a-f-]{36}$/);
  assert.equal(u.searchParams.get("plain"), "hello");
  assert.deepEqual(b.filled, ["?digest", "?req"]);
  // A pattern the generated value cannot meet: not filled (and not paid).
  assert.equal(fillPlaceholder("hex", { pattern: "^[A-F]{10}$" }).ok, false);
  const f70 = fillPlaceholder("hex", { minLength: 70, maxLength: 80 });
  assert.ok(f70.ok && /^[0-9a-f]{70}$/.test(f70.value), "no length in the hint: the default 64 moves into the schema's range");
  assert.equal(fillPlaceholder("64-hex", { minLength: 70 }).ok, false, "the hint and the schema disagree: not filled");
  assert.equal(fillPlaceholder("sha256", { type: "integer" }).ok, false);
});

// --- 2. Everything that is not a placeholder is left exactly as published

test("non-placeholders are never changed: plain strings, HTML examples, numbers, booleans, nested objects", () => {
  const body = {
    text: "<a href=\"x\">",
    html: "<a href=\"/about\">About</a>",
    tag: "<br>",
    close: "</p>",
    nav: "<nav>Home About</nav><h1>Welcome</h1>",
    cmp: "a < b > c",
    tmpl: "Hello {{name}}!",
    your: "your_value",
    n: 42,
    f: 0.06,
    ok: true,
    nul: null,
    nested: { deep: [1, "two", { three: "3" }] },
  };
  const r = fillPlaceholders(body);
  assert.deepEqual(r.value, body);
  assert.deepEqual(r.filled, []);
  assert.deepEqual(r.unfillable, []);
  for (const s of Object.values(body)) if (typeof s === "string") assert.equal(isPlaceholder(s), false, s);
  const b = buildRequest(post("https://agent402.tools/api/html", body));
  assert.equal(b.ok, true);
  if (b.ok) {
    assert.equal(b.body, JSON.stringify(body), "byte-for-byte the seller's example");
    assert.equal(b.filled, undefined);
  }
});

test("placeholder forms that are recognised", () => {
  assert.equal(placeholderHint("<sha256-hex-64-chars>"), "sha256-hex-64-chars");
  assert.equal(placeholderHint("  <uuid>  "), "uuid");
  assert.equal(placeholderHint("{{ order_id }}"), "order_id");
  assert.equal(placeholderHint("YOUR_API_KEY"), "API KEY");
});

// --- 3. A placeholder vet402 must not make up: UNCLEAR placeholder_unfillable, no payment

test("addresses, emails, keys, base64 payloads are not made up", () => {
  for (const h of ["algorand-address", "sender address", "email", "your-email@example", "API KEY", "wallet", "txid", "standard base64 of the bytes to notarize", "text", "callback url"]) {
    assert.equal(fillPlaceholder(h).ok, false, h);
  }
  const r = fillPlaceholders({ to: "<algorand-address>", hash: "<sha256>", contact: "{{email}}" });
  assert.deepEqual(r.filled, ["hash"]);
  assert.deepEqual(r.unfillable, ["to", "contact"]);
  assert.equal(r.value.to, "<algorand-address>", "left as published");
});

test("census: an unfillable placeholder is recorded as UNCLEAR placeholder_unfillable and probeOne (the paid path) is never called", async () => {
  const items = [
    post("https://w.example/send", { to: "<recipient-address>", hash: "<sha256-hex-64-chars>" }),
    post("https://hashlock.pronodealgo.xyz/hashlock-algo-mainnet/api/timestamp", HASHLOCK_BODY),
  ];
  assert.equal(buildPaidRequest(items[0]).ok, false);
  assert.equal((buildPaidRequest(items[0]) as { reason: string }).reason, "placeholder_unfillable");
  const { candidates, excluded } = selectCandidates(items, opts());
  assert.deepEqual(excluded, {});
  assert.equal(candidates.length, 2);
  const probed: Candidate[] = [];
  const rows = await runSweep(candidates, {
    probeOne: async (c): Promise<ProbeResult> => {
      probed.push(c);
      return { verdict: "REFUSE", reason: "payment_failed", target: c.url, detail: "status 409, no settlement receipt" };
    },
    now: () => NOW,
  });
  assert.deepEqual(
    probed.map((c) => c.host),
    ["hashlock.pronodealgo.xyz"],
    "only the fillable one reaches the paid path",
  );
  const w = rows.find((r) => r.host === "w.example")!;
  assert.equal(w.verdict, "REFUSE");
  assert.equal(w.reason, "placeholder_unfillable");
  assert.equal(w.paid, false);
  assert.equal(w.tx, undefined);
  assert.deepEqual(w.unfillable, ["to"]);
  assert.equal(displayClass(w), "UNCLEAR");
  const h = rows.find((r) => r.host === "hashlock.pronodealgo.xyz")!;
  assert.deepEqual(h.filled, ["hash"]);
  assert.equal(displayClass(h), "UNCLEAR", "a 409 without settlement is not counted against the seller");
});

test("daily board: a host's representative is one vet402 can send, even if an unfillable one is cheaper", () => {
  const items = [
    post("https://w.example/cheap", { to: "<recipient-address>" }, { amount: "1000" }),
    post("https://w.example/stamp", HASHLOCK_BODY, { amount: "5000" }),
  ];
  const { candidates } = selectCandidates(items, opts({ perHost: true }));
  assert.deepEqual(
    candidates.map((c) => c.url),
    ["https://w.example/stamp"],
  );
});

test("seller audit: an unfillable example is listed as not checked (placeholder_unfillable) and is not in the paid plan", async () => {
  const cfg = loadConfig({ ALLOW_PRIVATE_TARGETS: "1" });
  const net = ALGORAND_TESTNET_CAIP2;
  const asset = String(USDC_TESTNET_ASA_ID);
  const items = [
    post("http://localhost:4031/send", { to: "<recipient-address>" }, { network: net, asset, amount: "10000", payTo: "SELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELL" }),
    post("http://localhost:4031/stamp", HASHLOCK_BODY, { network: net, asset, amount: "10000", payTo: "SELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELL" }),
  ];
  const out = await planAudit("localhost:4031", items, { cfg, ownAddresses: [], resolveHost: async () => ["127.0.0.1"] });
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(
    out.plan.targets.map((t) => t.url),
    ["http://localhost:4031/stamp"],
  );
  assert.deepEqual(out.plan.targets[0].filled, ["hash"]);
  assert.equal(out.plan.paying, 1);
  assert.equal(out.plan.notChecked.counts.placeholder_unfillable, 1);
});

// --- 4. After filling, a 400 or 409 from the seller stays UNCLEAR (never against the seller)

test("probe with the filled body: the unpaid look and the paid request carry the same fresh hash; a 409 without settlement is payment_failed / UNCLEAR", async () => {
  const cfg = loadConfig({ ALLOW_PRIVATE_TARGETS: "1" });
  const pr = {
    x402Version: 2,
    resource: { url: "http://localhost:4031/stamp", description: "Proof of existence timestamp", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: ALGORAND_TESTNET_CAIP2, asset: String(USDC_TESTNET_ASA_ID), amount: "5000", payTo: "SELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELLERSELL", maxTimeoutSeconds: 60, extra: {} }],
  };
  const bodies: string[] = [];
  const deps: ProbeDeps = {
    resolveHost: async () => ["127.0.0.1"],
    fetchImpl: async (_u, init) => {
      bodies.push(String(init?.body));
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64"), "content-type": "application/json" } });
    },
    paidFetch: async (_u, _a, init) => {
      bodies.push(String(init?.body));
      return { response: new Response(JSON.stringify({ error: "already timestamped" }), { status: 409 }), settle: null, signed: true };
    },
  };
  const b = buildRequest(post("http://localhost:4031/stamp", HASHLOCK_BODY, { network: ALGORAND_TESTNET_CAIP2, asset: String(USDC_TESTNET_ASA_ID) }));
  assert.equal(b.ok, true);
  if (!b.ok) return;
  const guard = new LocalSpendGuard(new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic));
  const r = await probe(b.url, cfg, guard, withInput(deps, b));
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1], "the paid request sends exactly what was priced");
  assert.match(JSON.parse(bodies[1]).hash, HEX64);
  assert.equal(r.verdict, "REFUSE");
  assert.equal(r.reason, "payment_failed");
  assert.equal(r.downstreamPayment?.success === true, false);
  assert.equal(displayClass({ verdict: r.verdict, reason: r.reason, detail: r.detail, paid: false }), "UNCLEAR");
});

// --- 5. The board and the seller page keep and show which fields were filled

test("board file keeps filled/unfillable and the board shows the note", () => {
  const file: BoardFile = {
    version: 1,
    network: NET,
    networkName: "mainnet",
    date: "2026-09-28",
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
    totals: { rows: 1, allow: 0, refuse: 1, skipped: 0, paidUsdc: "0.000000" },
    rows: [
      {
        at: NOW.toISOString(),
        url: "https://hashlock.pronodealgo.xyz/api/timestamp",
        host: "hashlock.pronodealgo.xyz",
        method: "POST",
        input: 'body {"hash":"ab…"}',
        filled: ["hash"],
        verdict: "REFUSE",
        reason: "payment_failed",
        detail: "status 400, no settlement receipt",
        paid: false,
      },
    ],
  };
  const parsed = parseBoard(JSON.stringify(file))!;
  assert.deepEqual(parsed.rows[0].filled, ["hash"]);
  assert.match(boardHtml(parsed), /vet402 filled hash with a fresh random value/);
});
