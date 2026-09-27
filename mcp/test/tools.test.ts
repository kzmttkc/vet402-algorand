import { test } from "node:test";
import assert from "node:assert/strict";
import { algorandEndpoints, fetchAllResources, type BazaarItem } from "../src/bazaar.js";
import { runCheck, runEndpoints } from "../src/tools.js";

const MAIN = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const TEST = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";

const ITEMS: BazaarItem[] = [
  { resourceUrl: "https://vet402-algorand.vercel.app/v1/check", method: "GET", description: "vet402 pays the x402 endpoint you name", accepts: [{ network: MAIN, amount: "50000", asset: "31566704", payTo: "P1" }], settleCount: 2 },
  { resourceUrl: "https://base.example/x", description: "base only", accepts: [{ network: "eip155:8453", amount: "1000", asset: "0xusdc" }], settleCount: 99 },
  { resourceUrl: "https://testnet.example/weather", description: "Weather", accepts: [{ network: TEST, amount: "10000", asset: "10458941" }], settleCount: 5 },
  { resourceUrl: "https://short.example/y", description: "Truncated CAIP-2", accepts: [{ network: MAIN.slice(0, "algorand:".length + 32), amount: "1", asset: "31566704" }], settleCount: 7 },
  { resourceUrl: "https://multi.example/z", description: "Base first, Algorand second", accepts: [{ network: "eip155:8453", amount: "1" }, { network: MAIN, amount: "1230000", asset: "31566704" }] },
];

test("keeps only Algorand resources, most-settled first, with USDC price", () => {
  const r = algorandEndpoints(ITEMS);
  assert.deepEqual(r.map((e) => e.url), ["https://short.example/y", "https://testnet.example/weather", "https://vet402-algorand.vercel.app/v1/check", "https://multi.example/z"]);
  const vet = r.find((e) => e.url.includes("vet402"))!;
  assert.equal(vet.price, "0.05 USDC");
  assert.equal(vet.network, "mainnet");
  assert.equal(r.find((e) => e.url.includes("multi"))!.price, "1.23 USDC");
  assert.equal(r.find((e) => e.url.includes("short"))!.network, "mainnet");
});

test("query matches URL or description, case-insensitive; network filter", () => {
  assert.deepEqual(algorandEndpoints(ITEMS, { query: "VET402" }).map((e) => e.url), ["https://vet402-algorand.vercel.app/v1/check"]);
  assert.deepEqual(algorandEndpoints(ITEMS, { query: "weather" }).map((e) => e.url), ["https://testnet.example/weather"]);
  assert.deepEqual(algorandEndpoints(ITEMS, { network: "testnet" }).map((e) => e.url), ["https://testnet.example/weather"]);
  assert.equal(algorandEndpoints(ITEMS, { query: "base only" }).length, 0);
});

test("reads every page of the feed, not just the first 200", async () => {
  const total = 450;
  const all: BazaarItem[] = Array.from({ length: total }, (_, i) => ({ resourceUrl: `https://s${i}.example/`, accepts: [{ network: MAIN, amount: "1", asset: "31566704" }] }));
  const seen: string[] = [];
  const fetchImpl = (async (u: string | URL) => {
    const url = new URL(String(u));
    seen.push(url.search);
    const off = Number(url.searchParams.get("offset"));
    const lim = Number(url.searchParams.get("limit"));
    return new Response(JSON.stringify({ items: all.slice(off, off + lim), pagination: { limit: lim, offset: off, total } }), { status: 200 });
  }) as typeof fetch;
  const items = await fetchAllResources("https://feed.test/discovery/resources", fetchImpl);
  assert.equal(items.length, total);
  assert.equal(seen.length, 3);
  assert.ok(items.some((i) => i.resourceUrl === "https://s449.example/"));
});

test("algorand_x402_endpoints tool: returns matches as JSON text", async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ items: ITEMS, pagination: { total: ITEMS.length } }), { status: 200 })) as typeof fetch;
  const r = await runEndpoints({ query: "vet402" }, { fetchImpl, bazaarUrl: "https://feed-a.test/r" });
  assert.equal(r.isError, undefined);
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.matched, 1);
  assert.equal(body.endpoints[0].url, "https://vet402-algorand.vercel.app/v1/check");
});

test("algorand_x402_endpoints tool: feed error is an isError result", async () => {
  const fetchImpl = (async () => new Response("down", { status: 503 })) as typeof fetch;
  const r = await runEndpoints({}, { fetchImpl, bazaarUrl: "https://feed-b.test/r" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /HTTP 503/);
});

const neverFetch = (async () => {
  throw new Error("must not be called");
}) as typeof fetch;

test("vet402_check without ALGORAND_MNEMONIC: isError, nothing requested", async () => {
  const r = await runCheck({ url: "https://seller.example/x" }, {}, { fetchImpl: neverFetch });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /ALGORAND_MNEMONIC is not set/);
  assert.match(r.content[0].text, /Nothing was paid/);
});

test("vet402_check with a bad network or undecodable mnemonic: isError, mnemonic not echoed", async () => {
  const bad = await runCheck({ url: "https://seller.example/x" }, { ALGORAND_MNEMONIC: "abandon ".repeat(25).trim(), VET402_NETWORK: "betanet" }, { fetchImpl: neverFetch });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /VET402_NETWORK/);
  const words = "zebra ".repeat(25).trim();
  const r = await runCheck({ url: "https://seller.example/x" }, { ALGORAND_MNEMONIC: words }, { fetchImpl: neverFetch });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /could not be decoded/);
  assert.ok(!r.content[0].text.includes("zebra"));
});
