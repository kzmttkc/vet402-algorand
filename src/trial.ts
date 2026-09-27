/**
 * "Try vet402 (free, once per person)": vet402 buys one resource from a real seller with a
 * wallet kept only for trials, and shows the visitor what came back.
 *
 * A trial is not a customer payment. The trial wallet is separate from the customer payTo, from
 * the /v1/check payer and from the board's sweep wallet; /activity counts its payments as
 * "trials" and never as customers or customer revenue.
 *
 * Limits (all checked before any signature):
 *   - one trial per client IP (keyed hash) and, if the visitor gives one, per Algorand address;
 *   - at most TRY_MAX_PER_CALL (0.05 USDC) per trial and TRY_MAX_PER_DAY_USDC (default 3.00) per UTC day,
 *     read from the chain (the trial wallet's USDC sent today), so every serverless instance agrees;
 *   - every guard of probe(): private addresses, vet402's own wallets, payTo lock, one payment, caps.
 *
 * Where "once" is remembered: on the chain, as 0-ALGO payments from the trial wallet to itself whose
 * note is "vet402-try:v1:c:<key>" (the key is an HMAC of the IP or address under a secret derived from
 * the trial key, so the note does not reveal either). The result of each trial is written the same way
 * ("vet402-try:v1:r:{...}") and /try/log reads it back from the indexer. Each note costs 0.001 ALGO.
 */
import { createHash, createHmac } from "node:crypto";
import { config as loadDotenv } from "dotenv";
import { AlgorandClient, microAlgo } from "@algorandfoundation/algokit-utils";
import { seedFromMnemonic } from "@algorandfoundation/algokit-utils/algo25";
import { isValidAddress } from "@algorandfoundation/algokit-utils/common";
import { usdcToAtomic, type NetworkName } from "./config.js";
import { addressFromSeed, secretKeyB64FromMnemonic } from "./keys.js";
import type { DisplayClass } from "./board.js";

/** Most one trial pays a seller (atomic USDC). */
export const TRY_MAX_PER_CALL_ATOMIC = 50_000n;
export const TRY_DEFAULT_PER_DAY_USDC = "3.00";
export const TRY_NOTE_PREFIX = "vet402-try:v1:";
const CLAIM = `${TRY_NOTE_PREFIX}c:`;
const RESULT = `${TRY_NOTE_PREFIX}r:`;
const HANDLE = `${TRY_NOTE_PREFIX}h:`;

/** An X handle as the visitor typed it: optional "@", then 1-15 of A-Z a-z 0-9 _. Returns "@name" or null. */
export function normalizeHandle(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^@?([A-Za-z0-9_]{1,15})$/.exec(v.trim());
  return m ? `@${m[1]}` : null;
}

/** Proof, given only to the visitor whose try made `recordId`, that lets them attach a handle to it. */
export function handleToken(hashKey: Buffer, recordId: string): string {
  return createHmac("sha256", hashKey).update(`handle:${recordId}`).digest("hex").slice(0, 32);
}

export interface TrialConfig {
  chain: "algorand";
  address: string;
  mnemonic: string;
  secretKeyB64: string;
  maxPerCallAtomic: bigint;
  maxPerDayAtomic: bigint;
  /** HMAC key for IP / address keys (derived from the trial key; never leaves the server). */
  hashKey: Buffer;
}

/**
 * Trial settings from env (and `.env.try.local`, gitignored). No TRY_PAYER_MNEMONIC = trials off (null).
 * TRY_CHAIN: only "algorand" today (the network is the server's X402_NETWORK).
 */
export function loadTrialConfig(env: NodeJS.ProcessEnv = process.env, envFile = ".env.try.local"): TrialConfig | null {
  if (env === process.env) loadDotenv({ path: envFile, quiet: true });
  const chain = (env.TRY_CHAIN ?? "algorand").trim().toLowerCase();
  if (chain !== "algorand") throw new Error(`TRY_CHAIN must be algorand, got ${chain}`);
  const mnemonic = env.TRY_PAYER_MNEMONIC?.trim();
  if (!mnemonic) return null;
  const seed = seedFromMnemonic(mnemonic);
  const perDay = usdcToAtomic(env.TRY_MAX_PER_DAY_USDC ?? TRY_DEFAULT_PER_DAY_USDC);
  const perCallEnv = env.TRY_MAX_PER_CALL_USDC ? usdcToAtomic(env.TRY_MAX_PER_CALL_USDC) : TRY_MAX_PER_CALL_ATOMIC;
  // 0.05 is the ceiling; a lower value may be set, never a higher one.
  const perCall = perCallEnv < TRY_MAX_PER_CALL_ATOMIC ? perCallEnv : TRY_MAX_PER_CALL_ATOMIC;
  if (perCall <= 0n || perDay < perCall) throw new Error("TRY_MAX_PER_DAY_USDC must be at least the per-trial cap");
  return {
    chain: "algorand",
    address: addressFromSeed(seed),
    mnemonic,
    secretKeyB64: secretKeyB64FromMnemonic(mnemonic),
    maxPerCallAtomic: perCall,
    maxPerDayAtomic: perDay,
    hashKey: createHash("sha256").update("vet402-try-key:").update(Buffer.from(seed)).digest(),
  };
}

export function isAlgorandAddress(v: unknown): v is string {
  return typeof v === "string" && v.length === 58 && isValidAddress(v);
}

/** Claim keys for this visitor: the IP always, the address when given. */
export function claimKeys(hashKey: Buffer, ip: string, address?: string): string[] {
  const h = (kind: string, v: string) => `${kind}:${createHmac("sha256", hashKey).update(`${kind}:${v}`).digest("hex").slice(0, 32)}`;
  return [h("ip", ip), ...(address ? [h("ad", address)] : [])];
}

export interface TrialLogEntry {
  at: string;
  url: string;
  host: string;
  class: DisplayClass;
  reason: string;
  priceUsdc?: string;
  sellerTx?: string;
  /** The tx that carries this record (chain store). */
  recordTx?: string;
  /** X handle the visitor chose to add (only when they typed one). */
  handle?: string;
  /** Where the visitor came from (?from= on /try or /): a short campaign tag, never personal data. */
  from?: string;
}

/** A ?from= tag: letters, digits and "-" only, up to 20. Anything else is dropped. */
export function normalizeFrom(v: unknown): string | undefined {
  return typeof v === "string" && /^[A-Za-z0-9-]{1,20}$/.test(v) ? v.toLowerCase() : undefined;
}

export interface TrialLog {
  /** Newest first. */
  entries: TrialLogEntry[];
  /** Distinct visitors who used their trial (IP claims). */
  people: number;
}

export interface TrialStore {
  isClaimed(keys: string[]): Promise<boolean>;
  claim(keys: string[]): Promise<void>;
  /** Writes the result; returns its id (the chain store: the record tx). */
  record(e: TrialLogEntry): Promise<string>;
  /** Attaches the visitor's X handle to their record. "exists" if that record already has one. */
  attachHandle(recordId: string, handle: string): Promise<"ok" | "exists">;
  log(): Promise<TrialLog>;
}

/** In-process store (tests, local runs without a funded trial wallet). */
export class MemoryTrialStore implements TrialStore {
  readonly claimed = new Set<string>();
  readonly entries: TrialLogEntry[] = [];
  async isClaimed(keys: string[]) {
    return keys.some((k) => this.claimed.has(k));
  }
  async claim(keys: string[]) {
    for (const k of keys) this.claimed.add(k);
  }
  async record(e: TrialLogEntry) {
    const id = `MEM${this.entries.length + 1}`;
    this.entries.unshift({ ...e, recordTx: id });
    return id;
  }
  async attachHandle(recordId: string, handle: string): Promise<"ok" | "exists"> {
    const e = this.entries.find((x) => x.recordTx === recordId);
    if (!e) throw new Error("no such record");
    if (e.handle) return "exists";
    e.handle = handle;
    return "ok";
  }
  async log(): Promise<TrialLog> {
    return { entries: this.entries.map((e) => ({ ...e })), people: [...this.claimed].filter((k) => k.startsWith("ip:")).length };
  }
}

interface IdxTxn {
  id: string;
  sender: string;
  note?: string;
  "round-time": number;
  "tx-type"?: string;
  "payment-transaction"?: { receiver: string; amount: number };
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(".000Z", "Z");

/** Store on the chain: 0-ALGO self-payments from the trial wallet with a note (see the file comment). */
export class ChainTrialStore implements TrialStore {
  private readonly f: typeof fetch;
  private readonly local = new Set<string>(); // claims this instance made (the indexer lags a few seconds)
  private readonly handled = new Set<string>(); // records this instance attached a handle to
  private cache: { at: number; log: Promise<TrialLog> } | null = null;
  private algorand: AlgorandClient | null = null;

  constructor(
    private readonly o: { networkName: NetworkName; indexerUrl: string; trial: TrialConfig; fetchImpl?: typeof fetch; timeoutMs?: number; ttlMs?: number },
  ) {
    this.f = o.fetchImpl ?? ((u, i) => fetch(u, i));
  }

  private client(): AlgorandClient {
    if (!this.algorand) {
      this.algorand = this.o.networkName === "mainnet" ? AlgorandClient.mainNet() : AlgorandClient.testNet();
      this.algorand.account.fromMnemonic(this.o.trial.mnemonic);
    }
    return this.algorand;
  }

  /** Every transaction the trial wallet sent to itself whose note starts with `prefix`. */
  private async notes(prefix: string, maxPages = 20): Promise<IdxTxn[]> {
    const addr = this.o.trial.address;
    const out: IdxTxn[] = [];
    let next: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({ "note-prefix": b64(prefix), "tx-type": "pay", limit: "1000" });
      if (next) q.set("next", next);
      const res = await this.f(`${this.o.indexerUrl}/v2/accounts/${addr}/transactions?${q}`, { signal: AbortSignal.timeout(this.o.timeoutMs ?? 8000) });
      if (res.status === 404) return out;
      if (!res.ok) throw new Error(`indexer ${res.status}`);
      const body = (await res.json()) as { transactions?: IdxTxn[]; "next-token"?: string };
      if (!Array.isArray(body.transactions)) throw new Error("indexer: malformed response");
      // Only notes the trial wallet wrote to itself count (anyone can send it a transaction with any note).
      for (const t of body.transactions) if (t.sender === addr && t["payment-transaction"]?.receiver === addr) out.push(t);
      next = body["next-token"];
      if (!next || body.transactions.length === 0) return out;
    }
    return out;
  }

  async isClaimed(keys: string[]): Promise<boolean> {
    if (keys.some((k) => this.local.has(k))) return true;
    for (const k of keys) if ((await this.notes(`${CLAIM}${k}`, 1)).length) return true;
    return false;
  }

  async claim(keys: string[]): Promise<void> {
    const algorand = this.client();
    const sender = this.o.trial.address;
    let g = algorand.newGroup();
    // The lease makes a second claim of the same key within ~1000 rounds fail on the chain itself, whatever instance sends it.
    for (const k of keys) g = g.addPayment({ sender, receiver: sender, amount: microAlgo(0), note: new TextEncoder().encode(`${CLAIM}${k}`), lease: createHash("sha256").update(`${CLAIM}${k}`).digest() });
    await g.send();
    for (const k of keys) this.local.add(k);
    this.cache = null;
  }

  async record(e: TrialLogEntry): Promise<string> {
    const rec = { u: e.url.slice(0, 600), h: e.host.slice(0, 120), c: e.class, r: e.reason.slice(0, 60), p: e.priceUsdc, s: e.sellerTx, ...(e.from ? { f: e.from } : {}) };
    let note = `${RESULT}${JSON.stringify(rec)}`;
    if (Buffer.byteLength(note) > 1000) note = `${RESULT}${JSON.stringify({ ...rec, u: rec.u.slice(0, 200) })}`;
    const sent = await this.client().send.payment({ sender: this.o.trial.address, receiver: this.o.trial.address, amount: microAlgo(0), note: new TextEncoder().encode(note) });
    this.cache = null;
    return sent.txIds[0];
  }

  /** Handle note: "vet402-try:v1:h:<record tx>:@name" (public and permanent on the chain; /try shows it unless hidden). */
  async attachHandle(recordId: string, handle: string): Promise<"ok" | "exists"> {
    if (this.handled.has(recordId) || (await this.notes(`${HANDLE}${recordId}:`, 1)).length) return "exists";
    await this.client().send.payment({ sender: this.o.trial.address, receiver: this.o.trial.address, amount: microAlgo(0), note: new TextEncoder().encode(`${HANDLE}${recordId}:${handle}`) });
    this.handled.add(recordId);
    this.cache = null;
    return "ok";
  }

  log(): Promise<TrialLog> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < (this.o.ttlMs ?? 60_000)) return this.cache.log;
    const log = (async () => {
      const [claims, results, handles] = await Promise.all([this.notes(`${CLAIM}ip:`), this.notes(RESULT), this.notes(HANDLE)]);
      const handleOf = new Map<string, string>();
      for (const t of [...handles].sort((a, b) => a["round-time"] - b["round-time"])) {
        const m = /^([A-Z2-7]{52}):(@[A-Za-z0-9_]{1,15})$/.exec(Buffer.from(t.note ?? "", "base64").toString("utf8").slice(HANDLE.length));
        if (m && !handleOf.has(m[1])) handleOf.set(m[1], m[2]); // the first handle for a record wins
      }
      const entries: TrialLogEntry[] = [];
      for (const t of results) {
        try {
          const r = JSON.parse(Buffer.from(t.note ?? "", "base64").toString("utf8").slice(RESULT.length)) as Record<string, unknown>;
          entries.push({
            at: iso(t["round-time"]),
            url: String(r.u ?? ""),
            host: String(r.h ?? ""),
            class: (["DELIVERED", "MISMATCH", "UNREACHABLE", "UNCLEAR"].includes(String(r.c)) ? r.c : "UNCLEAR") as DisplayClass,
            reason: String(r.r ?? ""),
            ...(typeof r.p === "string" ? { priceUsdc: r.p } : {}),
            ...(typeof r.s === "string" ? { sellerTx: r.s } : {}),
            ...(normalizeFrom(r.f) ? { from: normalizeFrom(r.f) } : {}),
            recordTx: t.id,
            ...(handleOf.has(t.id) ? { handle: handleOf.get(t.id) } : {}),
          });
        } catch {
          /* not a record this version wrote */
        }
      }
      entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      return { entries, people: new Set(claims.map((t) => t.note)).size };
    })();
    this.cache = { at: now, log };
    log.catch(() => {
      if (this.cache?.log === log) this.cache = null;
    });
    return log;
  }
}
