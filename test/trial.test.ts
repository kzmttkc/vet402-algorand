/**
 * trial.ts: the daily cap's ceiling (W4), the explicit 1000-round validity window of every leased trial note (W2),
 * and how the chain store takes a seller slot (W1): skip slots on the chain, move on when a lease is taken, stop on anything else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import algosdk from "algosdk";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { ChainTrialStore, MemoryTrialStore, TRY_LEASE_ROUNDS, isLeaseConflict, leaseOf, loadTrialConfig, slotNote, type TrialConfig } from "../src/trial.js";

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
