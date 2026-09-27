/**
 * trial.ts: the daily cap's ceiling (W4), the explicit 1000-round validity window of every leased trial note (W2),
 * and how the chain store takes a seller slot (W1): skip slots on the chain, move on when a lease is taken, stop on anything else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import algosdk from "algosdk";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { ChainTrialStore, MemoryTrialStore, TRY_LEASE_ROUNDS, TRY_PER_NETWORK, ipSlotKey, isLeaseConflict, leaseOf, loadTrialConfig, slotNote, type TrialConfig } from "../src/trial.js";

const mnemonic = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);
const trialCfg = (env: NodeJS.ProcessEnv = {}) => loadTrialConfig({ TRY_PAYER_MNEMONIC: mnemonic, ...env }, "/nonexistent");

test("W4: TRY_MAX_PER_DAY_USDC above 10 USDC refuses to start; 10 and the default start", () => {
  assert.equal(trialCfg()!.maxPerDayAtomic, 3_000_000n);
  assert.equal(trialCfg({ TRY_MAX_PER_DAY_USDC: "10.00" })!.maxPerDayAtomic, 10_000_000n);
  assert.throws(() => trialCfg({ TRY_MAX_PER_DAY_USDC: "10.01" }), /at most 10\.00/);
  assert.throws(() => trialCfg({ TRY_MAX_PER_DAY_USDC: "300" }), /at most 10\.00/);
});

/** A TestNet client that never calls algod: fixed suggested params. */
function offlineClient(): AlgorandClient {
  return AlgorandClient.testNet().setSuggestedParamsCache(
    {
      consensusVersion: "future",
      fee: 0n,
      minFee: 1000n,
      genesisHash: new Uint8Array(32).fill(1),
      genesisId: "testnet-v1.0",
      flatFee: false,
      firstValid: 60_000_000n,
      lastValid: 60_001_000n,
    },
    new Date(Date.now() + 3_600_000),
  );
}

const chainStore = (cfg: TrialConfig, o: { fetchImpl?: typeof fetch } = {}) =>
  new ChainTrialStore({ networkName: "testnet", indexerUrl: "https://idx.invalid", trial: cfg, algorand: offlineClient(), ...o });

test("W2: the claim transactions and the seller slot transaction are valid for exactly 1000 rounds (lastValid - firstValid), each with a 32-byte lease", async () => {
  const cfg = trialCfg()!;
  const store = chainStore(cfg);
  const claim = await store.claimGroup(["ip:aaaa", "ad:bbbb"]).buildTransactions();
  const slot = await store.slotGroup("seller.example", "2026-09-27", 2).buildTransactions();
  const all = [...claim.transactions, ...slot.transactions];
  assert.equal(all.length, 3);
  for (const t of all) {
    assert.equal(t.lastValid - t.firstValid, BigInt(TRY_LEASE_ROUNDS));
    assert.equal(TRY_LEASE_ROUNDS, 1000);
    assert.equal(t.lease?.length, 32);
    assert.equal(t.sender.toString(), cfg.address);
  }
  const name = slotNote("seller.example", "2026-09-27", 2);
  assert.match(new TextDecoder().decode(slot.transactions[0].note), new RegExp(`^${name}:[0-9a-f]{12}$`));
  assert.deepEqual(slot.transactions[0].lease, leaseOf(name));
});

test("W1: two instances taking the same slot in the same round build different transactions with the same lease (so the chain keeps one)", async () => {
  const cfg = trialCfg()!;
  const [a, b] = await Promise.all([chainStore(cfg).slotGroup("seller.example", "2026-09-27", 1).buildTransactions(), chainStore(cfg).slotGroup("seller.example", "2026-09-27", 1).buildTransactions()]);
  assert.notEqual(a.transactions[0].txId(), b.transactions[0].txId());
  assert.deepEqual(a.transactions[0].lease, b.transactions[0].lease);
  const [c1, c2] = await Promise.all([chainStore(cfg).claimGroup(["ip:aaaa"]).buildTransactions(), chainStore(cfg).claimGroup(["ip:aaaa"]).buildTransactions()]);
  assert.notEqual(c1.transactions[0].txId(), c2.transactions[0].txId());
  assert.deepEqual(c1.transactions[0].lease, leaseOf("vet402-try:v1:c:ip:aaaa")); // the same lease as claims sent before this change
});

/** Chain store whose slot sends are scripted: n -> "ok" | "lease" | "down". */
function scripted(cfg: TrialConfig, onChain: number[], outcome: Record<number, "ok" | "lease" | "down">) {
  const sent: number[] = [];
  const indexer = (async (url: string) => {
    const prefix = new URL(url).searchParams.get("note-prefix")!;
    const p = Buffer.from(prefix, "base64").toString("utf8");
    const transactions = onChain.map((n) => ({ id: `S${n}`, sender: cfg.address, "round-time": 1, "tx-type": "pay", note: Buffer.from(`${p}${n}:abcdef012345`).toString("base64"), "payment-transaction": { receiver: cfg.address, amount: 0 } }));
    return Response.json({ transactions });
  }) as unknown as typeof fetch;
  class S extends ChainTrialStore {
    override slotGroup(host: string, date: string, n: number) {
      return {
        send: async () => {
          sent.push(n);
          const o = outcome[n] ?? "ok";
          if (o === "lease") throw new Error("TransactionPool.Remember: transaction XYZ: overlapping lease (sender, lease):(A, B)");
          if (o === "down") throw new Error("algod 503");
          return {};
        },
      } as unknown as ReturnType<ChainTrialStore["slotGroup"]>;
    }
  }
  return { store: new S({ networkName: "testnet", indexerUrl: "https://idx.invalid", trial: cfg, fetchImpl: indexer, algorand: offlineClient() }), sent };
}

test("W1: the chain store skips slots already on the chain, moves on when a slot's lease is taken, and gives null when all 3 are taken", async () => {
  const cfg = trialCfg()!;
  const a = scripted(cfg, [1], { 2: "lease" });
  assert.equal(await a.store.takeSellerSlot("seller.example", "2026-09-27", 3), 3);
  assert.deepEqual(a.sent, [2, 3]);
  // This instance remembers slot 3 even before the indexer shows it.
  assert.equal(await a.store.takeSellerSlot("seller.example", "2026-09-27", 3), null);

  const b = scripted(cfg, [], { 1: "lease", 2: "lease", 3: "lease" });
  assert.equal(await b.store.takeSellerSlot("seller.example", "2026-09-27", 3), null);
  // Paid tries already recorded today (before slots existed) come first: slots start after them.
  const c = scripted(cfg, [], {});
  assert.equal(await c.store.takeSellerSlot("seller.example", "2026-09-27", 3, 2), 3);
  assert.deepEqual(c.sent, [3]);
});

test("W1: any failure other than a taken lease stops the slot take (the caller does not pay)", async () => {
  const cfg = trialCfg()!;
  const { store, sent } = scripted(cfg, [], { 1: "down" });
  await assert.rejects(store.takeSellerSlot("seller.example", "2026-09-27", 3), /algod 503/);
  assert.deepEqual(sent, [1]);
  assert.equal(isLeaseConflict(new Error("overlapping lease")), true);
  assert.equal(isLeaseConflict(new Error("algod 503")), false);
});

test("W1: the memory store gives each slot once, per host and per date", async () => {
  const m = new MemoryTrialStore();
  const got = await Promise.all([1, 2, 3, 4, 5].map(() => m.takeSellerSlot("a.example", "2026-09-27", 3)));
  assert.deepEqual(got, [1, 2, 3, null, null]);
  assert.equal(await m.takeSellerSlot("b.example", "2026-09-27", 3), 1);
  assert.equal(await m.takeSellerSlot("a.example", "2026-09-28", 3), 1);
});

test("people on /try/log counts one per claim key, for claim notes written before (no nonce) and after (with nonce) this change, and one per IP slot", async () => {
  const cfg = trialCfg()!;
  const note = (s: string) => Buffer.from(s).toString("base64");
  const tx = (id: string, n: string) => ({ id, sender: cfg.address, "round-time": 1, "tx-type": "pay", note: note(n), "payment-transaction": { receiver: cfg.address, amount: 0 } });
  const f = (async (url: string) => {
    const p = Buffer.from(new URL(url).searchParams.get("note-prefix")!, "base64").toString("utf8");
    const all = [tx("A", "vet402-try:v1:c:ip:aaaa"), tx("B", "vet402-try:v1:c:ip:bbbb:0123456789ab"), tx("C", "vet402-try:v1:c:ip:bbbb:ba9876543210"), tx("D", "vet402-try:v1:c:ip:cccc:0123456789ab"), tx("E", "vet402-try:v1:c:ip:cccc#2:0123456789ab")];
    return Response.json({ transactions: all.filter((t) => Buffer.from(t.note, "base64").toString("utf8").startsWith(p)) });
  }) as unknown as typeof fetch;
  const log = await chainStore(cfg, { fetchImpl: f }).log();
  assert.equal(log.people, 4); // aaaa, bbbb (claimed twice: one key), cccc slot 1, cccc slot 2
  assert.deepEqual(await chainStore(cfg, { fetchImpl: f }).claimState("ip:bbbb", undefined, 3), { addressUsed: false, networkUsed: 1 });
  assert.deepEqual(await chainStore(cfg, { fetchImpl: f }).claimState("ip:cccc", undefined, 3), { addressUsed: false, networkUsed: 2 });
  assert.deepEqual(await chainStore(cfg, { fetchImpl: f }).claimState("ip:dddd", undefined, 3), { addressUsed: false, networkUsed: 0 });
});

/* ---------- IP slots: up to 3 per IP, one per address, slot 1 = the claim written before slots ---------- */

/** Chain store over a scripted indexer (these claim notes) whose claim sends are scripted by the group's first key. */
function claimScripted(cfg: TrialConfig, onChain: string[], outcome: (keys: string[]) => "ok" | "lease" | "down" = () => "ok") {
  const sent: string[][] = [];
  const idx = (async (url: string) => {
    const p = Buffer.from(new URL(url).searchParams.get("note-prefix")!, "base64").toString("utf8");
    const transactions = onChain
      .filter((n) => n.startsWith(p))
      .map((n, i) => ({ id: `C${i}`, sender: cfg.address, "round-time": 1, "tx-type": "pay", note: Buffer.from(n).toString("base64"), "payment-transaction": { receiver: cfg.address, amount: 0 } }));
    return Response.json({ transactions });
  }) as unknown as typeof fetch;
  class S extends ChainTrialStore {
    override claimGroup(keys: string[]) {
      return {
        send: async () => {
          sent.push(keys);
          const o = outcome(keys);
          if (o === "lease") throw new Error("TransactionPool.Remember: transaction XYZ: overlapping lease (sender, lease):(A, B)");
          if (o === "down") throw new Error("algod 503");
          return {};
        },
      } as unknown as ReturnType<ChainTrialStore["claimGroup"]>;
    }
  }
  return { store: new S({ networkName: "testnet", indexerUrl: "https://idx.invalid", trial: cfg, fetchImpl: idx, algorand: offlineClient() }), sent };
}

test("IP slots: slot 1 has the very name and lease of the claims written before slots; slot n>1 is '<ip key>#n'; the claim group is [IP slot, address]", async () => {
  assert.equal(TRY_PER_NETWORK, 3);
  assert.equal(ipSlotKey("ip:aaaa", 1), "ip:aaaa");
  assert.equal(ipSlotKey("ip:aaaa", 2), "ip:aaaa#2");
  const cfg = trialCfg()!;
  const g = await chainStore(cfg).claimGroup([ipSlotKey("ip:aaaa", 1), "ad:bbbb"]).buildTransactions();
  assert.deepEqual(g.transactions[0].lease, leaseOf("vet402-try:v1:c:ip:aaaa"));
  assert.match(new TextDecoder().decode(g.transactions[0].note), /^vet402-try:v1:c:ip:aaaa:[0-9a-f]{12}$/);
  const g2 = await chainStore(cfg).claimGroup([ipSlotKey("ip:aaaa", 2)]).buildTransactions();
  assert.deepEqual(g2.transactions[0].lease, leaseOf("vet402-try:v1:c:ip:aaaa#2"));
  assert.notDeepEqual(g2.transactions[0].lease, g.transactions[0].lease);
});

test("#3 chain store: an IP claimed in the old format (no nonce, or with a nonce) is slot 1 used; the next claim takes slot 2, then 3, then none", async () => {
  const cfg = trialCfg()!;
  for (const old of ["vet402-try:v1:c:ip:aaaa", "vet402-try:v1:c:ip:aaaa:0123456789ab"]) {
    const { store, sent } = claimScripted(cfg, [old]);
    assert.deepEqual(await store.claimState("ip:aaaa", "ad:new1", 3), { addressUsed: false, networkUsed: 1 });
    assert.deepEqual(await store.claimTry("ip:aaaa", "ad:new1", 3), { ok: true, slot: 2 });
    assert.deepEqual(await store.claimTry("ip:aaaa", "ad:new2", 3), { ok: true, slot: 3 }); // this instance remembers slot 2
    assert.deepEqual(await store.claimTry("ip:aaaa", "ad:new3", 3), { ok: false, reason: "network_used" });
    assert.deepEqual(sent, [["ip:aaaa#2", "ad:new1"], ["ip:aaaa#3", "ad:new2"]]);
  }
});

test("chain store: an address already on the chain is refused before any send, with address_used, whatever the IP", async () => {
  const cfg = trialCfg()!;
  const { store, sent } = claimScripted(cfg, ["vet402-try:v1:c:ad:used:0123456789ab"]);
  assert.deepEqual(await store.claimState("ip:zzzz", "ad:used", 3), { addressUsed: true, networkUsed: 0 });
  assert.deepEqual(await store.claimTry("ip:zzzz", "ad:used", 3), { ok: false, reason: "address_used" });
  assert.deepEqual(sent, []);
});

test("#4 chain store: a slot another instance holds (lease taken) is skipped, so simultaneous claims from one IP get distinct slots and never more than 3", async () => {
  const cfg = trialCfg()!;
  // Slots 1 and 2 are being taken right now by other instances (not yet on the indexer): this claim gets slot 3.
  const a = claimScripted(cfg, [], (k) => (k[0] === "ip:aaaa" || k[0] === "ip:aaaa#2" ? "lease" : "ok"));
  assert.deepEqual(await a.store.claimTry("ip:aaaa", undefined, 3), { ok: true, slot: 3 });
  assert.deepEqual(a.sent.map((k) => k[0]), ["ip:aaaa", "ip:aaaa#2", "ip:aaaa#3"]);
  // Every slot held elsewhere: no claim, network_used without an address, "busy" with one (the address may be the one in flight).
  const b = claimScripted(cfg, [], () => "lease");
  assert.deepEqual(await b.store.claimTry("ip:aaaa", undefined, 3), { ok: false, reason: "network_used" });
  assert.deepEqual(await b.store.claimTry("ip:aaaa", "ad:x", 3), { ok: false, reason: "busy" });
  // Anything else stops the claim (the caller does not pay).
  const c = claimScripted(cfg, [], () => "down");
  await assert.rejects(c.store.claimTry("ip:aaaa", "ad:x", 3), /algod 503/);
  assert.equal(c.sent.length, 1);
});

test("#4 memory store: five simultaneous claims from one IP get slots 1, 2, 3 and two network_used; an address is claimed once", async () => {
  const m = new MemoryTrialStore();
  const got = await Promise.all([1, 2, 3, 4, 5].map((i) => m.claimTry("ip:aaaa", `ad:${i}`, 3)));
  assert.deepEqual(got, [{ ok: true, slot: 1 }, { ok: true, slot: 2 }, { ok: true, slot: 3 }, { ok: false, reason: "network_used" }, { ok: false, reason: "network_used" }]);
  assert.deepEqual(await m.claimTry("ip:bbbb", "ad:1", 3), { ok: false, reason: "address_used" });
  assert.equal(m.claimed.has("ad:4"), false); // a refused claim holds nothing
  assert.equal((await m.log()).people, 3);
});
