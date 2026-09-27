/**
 * "Try vet402 (free, once per person)": vet402 buys one resource from a real seller with a
 * wallet kept only for trials, and shows the visitor what came back.
 *
 * A trial is not a customer payment. The trial wallet is separate from the customer payTo, from
 * the /v1/check payer and from the board's sweep wallet; /activity counts its payments as
 * "trials" and never as customers or customer revenue.
 *
 * Limits (all checked before any signature):
 *   - up to TRY_PER_NETWORK (3) trials per client IP (IPv4 /32, IPv6 /64; keyed hash), so people sharing one network
 *     (carrier NAT, conference or office Wi-Fi) are not refused as if they had tried; and, if the visitor gives one,
 *     one trial per Algorand address. The IP's tries are slots n=1..3: slot 1 is the claim name used before slots
 *     existed ("ip:<key>", same lease), slot n>1 is "ip:<key>#n", so an IP that claimed before counts as slot 1 used;
 *   - at most TRY_MAX_PER_CALL (0.05 USDC) per trial and TRY_MAX_PER_DAY_USDC (default 3.00, never above
 *     10.00: a higher value refuses to start) per UTC day, read from the chain (the trial wallet's USDC sent
 *     today), so every serverless instance agrees;
 *   - at most TRY_PER_SELLER_PER_DAY paid tries per seller host per UTC day: before paying, /try/run takes
 *     slot n (1..3) for (host, date) as a leased 0-ALGO note "vet402-try:v1:s:<host key>:<date>:<n>:<nonce>"; the
 *     chain refuses a second transaction with the same lease, so simultaneous requests cannot share a slot;
 *   - every guard of probe(): private addresses, vet402's own wallets, payTo lock, one payment, caps.
 *
 * Where "once" is remembered: on the chain, as 0-ALGO payments from the trial wallet to itself whose
 * note is "vet402-try:v1:c:<key>:<nonce>" (<key> is "ad:<hash>" or an IP slot "ip:<hash>" / "ip:<hash>#<n>"; older ones have no nonce; the key is an HMAC of the IP or address under a secret derived from
 * the trial key, so the note does not reveal either). The result of each trial is written the same way
 * ("vet402-try:v1:r:{...}") and /try/log reads it back from the indexer. Each note costs 0.001 ALGO.
 *
 * Leases hold only while the leasing transaction is valid, so claims and slots are sent with an explicit
 * TRY_LEASE_ROUNDS (1000, the protocol maximum, ~45 min) window; algokit's own default is 10 rounds (~30 s)
 * off LocalNet. After the window the indexer has long shown the note, and the claim / slot reads see it.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
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
/** TRY_MAX_PER_DAY_USDC above this refuses to start (a typo must not open the trial wallet wide). */
export const TRY_MAX_PER_DAY_CEILING_USDC = "10.00";
/** Validity window of every leased trial note (claims, seller slots): the protocol's maximum. */
export const TRY_LEASE_ROUNDS = 1000;
/**
 * How long a leased note send waits for confirmation. algokit swallows the pool's lease error and would otherwise wait
 * the whole validity window (~47 min). A timeout throws, so nothing is paid; if the note lands later, it only uses up
 * a slot or a claim (pays less, never more).
 */
export const TRY_CONFIRM_ROUNDS = 20;
/** At most this many free tries a UTC day in total (3.00 USDC / 0.05), whatever the IPs or sellers: bounds the ALGO fees too. */
export const TRY_MAX_TRIES_PER_DAY = 60;
/** Free tries pause below this ALGO balance (microALGO), so fees can never empty the trial wallet. */
export const TRY_MIN_ALGO_MICRO = 500_000n;
export const TRY_NOTE_PREFIX = "vet402-try:v1:";
const CLAIM = `${TRY_NOTE_PREFIX}c:`;
const SLOT = `${TRY_NOTE_PREFIX}s:`;
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
  if (perDay > usdcToAtomic(TRY_MAX_PER_DAY_CEILING_USDC)) throw new Error(`TRY_MAX_PER_DAY_USDC must be at most ${TRY_MAX_PER_DAY_CEILING_USDC}`);
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

/** Free tries one IP (IPv4 /32, IPv6 /64) gets in total, one per person behind it. An address still gets one. */
export const TRY_PER_NETWORK = 3;

/**
 * The claim key of IP slot n (1..TRY_PER_NETWORK). Slot 1 is the IP key itself, so its name and lease are exactly those of
 * the claims written before slots existed: an IP that already claimed has slot 1 used. Slot n>1 is "<ip key>#<n>".
 */
export function ipSlotKey(ipKey: string, n: number): string {
  return n === 1 ? ipKey : `${ipKey}#${n}`;
}

/** Why a claim was refused: the address has had its try, every slot of the IP is used, or a claim for it is in flight. */
export type ClaimRefusal = "address_used" | "network_used" | "busy";
export type ClaimOutcome = { ok: true; slot: number } | { ok: false; reason: ClaimRefusal };

/** Claim keys for this visitor: the IP always (slot 1's key, see ipSlotKey), the address when given. */
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
  /** Set by the /try views: the operator's own try (?from= "operator…"). Shown, never counted. */
  operatorTest?: boolean;
}

/** The operator's own try: its ?from= tag starts with "operator" (e.g. "operator-test"). Listed, never counted as a visitor. */
export function isOperatorTry(e: { from?: string }): boolean {
  return typeof e.from === "string" && e.from.toLowerCase().startsWith("operator");
}

/** A ?from= tag: letters, digits and "-" only, up to 20. Anything else is dropped. */
export function normalizeFrom(v: unknown): string | undefined {
  return typeof v === "string" && /^[A-Za-z0-9-]{1,20}$/.test(v) ? v.toLowerCase() : undefined;
}

export interface TrialLog {
  /** Newest first. */
  entries: TrialLogEntry[];
  /** Distinct visitors who used their trial (IP slot claims: a second person on the same IP is one more). */
  people: number;
}

/**
 * What /try shows: operator tries stay in `entries` (marked operatorTest) but are left out of `people` and `trials`.
 * Claims carry no ?from= tag, so each operator try (one IP claim each) is taken off the IP-claim count.
 * The operator's one-per-person claim itself stays on the chain.
 */
export function countedLog(log: TrialLog): TrialLog & { trials: number } {
  const entries = log.entries.map((e) => (isOperatorTry(e) ? { ...e, operatorTest: true } : e));
  const operator = entries.filter((e) => e.operatorTest).length;
  return { entries, people: Math.max(0, log.people - operator), trials: entries.length - operator };
}

/** The seller host as it goes into a slot note: a hash, so the note stays short and ASCII. */
export function slotHostKey(host: string): string {
  return createHash("sha256").update(host.toLowerCase()).digest("hex").slice(0, 24);
}

/** Name of seller slot n for (host, UTC date "YYYY-MM-DD"). Its SHA-256 is the lease; the note is the name + ":<nonce>". */
export function slotNote(host: string, date: string, n: number): string {
  return `${SLOT}${slotHostKey(host)}:${date}:${n}`;
}

/** The lease for a claim or slot name. */
export const leaseOf = (name: string) => new Uint8Array(createHash("sha256").update(name).digest()); // algokit wants a plain Uint8Array, not a Buffer

/** algod's answer when a transaction reuses a (sender, lease) that is still valid. */
export function isLeaseConflict(e: unknown): boolean {
  return /overlapping lease/i.test(String((e as Error)?.message ?? e));
}

export interface TrialStore {
  /** What this visitor has left, read before anything is signed: whether the address has had its try, and how many IP slots are used. */
  claimState(ipKey: string, addressKey: string | undefined, max: number): Promise<{ addressUsed: boolean; networkUsed: number }>;
  /**
   * Takes the first free IP slot n (1..max) together with the address claim, in one step: both or neither. Two callers
   * never get the same slot, and one address is never claimed twice (the chain store: one atomic group with a lease each).
   */
  claimTry(ipKey: string, addressKey: string | undefined, max: number): Promise<ClaimOutcome>;
  /**
   * Takes the first free seller slot n for (host, date), from `from` + 1 up to `max`, before any payment.
   * Returns n, or null when every slot is taken. Two callers never get the same n (the chain store: a lease).
   * `from` = paid tries already recorded for this host today (tries made before slots existed count too).
   */
  takeSellerSlot(host: string, date: string, max: number, from?: number): Promise<number | null>;
  /** Writes the result; returns its id (the chain store: the record tx). */
  record(e: TrialLogEntry): Promise<string>;
  /** Attaches the visitor's X handle to their record. "exists" if that record already has one. */
  attachHandle(recordId: string, handle: string): Promise<"ok" | "exists">;
  log(): Promise<TrialLog>;
}

/** In-process store (tests, local runs without a funded trial wallet). */
export class MemoryTrialStore implements TrialStore {
  readonly claimed = new Set<string>();
  readonly slots = new Set<string>();
  readonly entries: TrialLogEntry[] = [];
  async claimState(ipKey: string, addressKey: string | undefined, max: number) {
    let networkUsed = 0;
    for (let n = 1; n <= max; n++) if (this.claimed.has(ipSlotKey(ipKey, n))) networkUsed++;
    return { addressUsed: !!addressKey && this.claimed.has(addressKey), networkUsed };
  }
  async claimTry(ipKey: string, addressKey: string | undefined, max: number): Promise<ClaimOutcome> {
    // No await between the checks and the adds: one caller at a time, like the leases on the chain.
    if (addressKey && this.claimed.has(addressKey)) return { ok: false, reason: "address_used" };
    for (let n = 1; n <= max; n++) {
      const k = ipSlotKey(ipKey, n);
      if (this.claimed.has(k)) continue;
      this.claimed.add(k);
      if (addressKey) this.claimed.add(addressKey);
      return { ok: true, slot: n };
    }
    return { ok: false, reason: "network_used" };
  }
  async takeSellerSlot(host: string, date: string, max: number, from = 0) {
    // No await between the check and the add: one caller at a time, like the lease on the chain.
    for (let n = from + 1; n <= max; n++) {
      const note = slotNote(host, date, n);
      if (this.slots.has(note)) continue;
      this.slots.add(note);
      return n;
    }
    return null;
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
    private readonly o: { networkName: NetworkName; indexerUrl: string; trial: TrialConfig; fetchImpl?: typeof fetch; timeoutMs?: number; ttlMs?: number; algorand?: AlgorandClient },
  ) {
    this.f = o.fetchImpl ?? ((u, i) => fetch(u, i));
  }

  private client(): AlgorandClient {
    if (!this.algorand) {
      this.algorand = this.o.algorand ?? (this.o.networkName === "mainnet" ? AlgorandClient.mainNet() : AlgorandClient.testNet());
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

  private async addressUsed(addressKey: string | undefined): Promise<boolean> {
    if (!addressKey) return false;
    return this.local.has(addressKey) || (await this.notes(`${CLAIM}${addressKey}`, 1)).length > 0;
  }

  /**
   * IP slots on the chain (one indexer read: every slot's note starts with "c:<ip key>") and those this instance took.
   * After the IP key: nothing (a claim written before nonces) or ":<nonce>" is slot 1; "#<n>" is slot n.
   */
  private async ipSlotsUsed(ipKey: string, max: number): Promise<Set<number>> {
    const used = new Set<number>();
    const prefix = `${CLAIM}${ipKey}`;
    for (const t of await this.notes(prefix, 1)) {
      const rest = Buffer.from(t.note ?? "", "base64").toString("utf8").slice(prefix.length);
      if (rest === "" || rest.startsWith(":")) used.add(1);
      else {
        const m = /^#(\d+)(?::|$)/.exec(rest);
        if (m) used.add(Number(m[1]));
      }
    }
    for (let n = 1; n <= max; n++) if (this.local.has(ipSlotKey(ipKey, n))) used.add(n);
    return used;
  }

  async claimState(ipKey: string, addressKey: string | undefined, max: number) {
    const [addressUsed, slots] = await Promise.all([this.addressUsed(addressKey), this.ipSlotsUsed(ipKey, max)]);
    return { addressUsed, networkUsed: [...slots].filter((n) => n >= 1 && n <= max).length };
  }

  /**
   * A 0-ALGO self-payment leased by the hash of `name`, valid for TRY_LEASE_ROUNDS rounds. The note is `name:<nonce>`:
   * without the nonce, two instances taking the same name in the same round build the very same transaction (same id,
   * checked on TestNet), which the chain treats as one, and both could see it confirmed. With it, the ids differ, the
   * lease is the same, and the chain lets only one through.
   */
  private leased(name: string) {
    const sender = this.o.trial.address;
    return { sender, receiver: sender, amount: microAlgo(0), note: new TextEncoder().encode(`${name}:${randomBytes(6).toString("hex")}`), lease: leaseOf(name), validityWindow: TRY_LEASE_ROUNDS };
  }

  /** The claim group (not sent). Exposed so a test can read its validity window. */
  claimGroup(keys: string[]) {
    let g = this.client().newGroup();
    // The lease makes a second claim of the same key fail on the chain itself, whatever instance sends it, for as long
    // as this transaction is valid: TRY_LEASE_ROUNDS (1000) rounds, set explicitly (algokit's default is 10 off LocalNet).
    for (const k of keys) g = g.addPayment(this.leased(`${CLAIM}${k}`));
    return g;
  }

  /** The slot transaction (not sent). Exposed so a test can read its validity window. */
  slotGroup(host: string, date: string, n: number) {
    return this.client().newGroup().addPayment(this.leased(slotNote(host, date, n)));
  }

  /**
   * Sends [IP slot n, address] as one atomic group, from the first slot not on the chain. A group whose lease is taken
   * (another instance claiming that slot, or the same address, right now) is refused whole, so nothing is used and the
   * next slot is tried. Any other failure throws: the caller does not pay. When every free slot was refused by a lease
   * while an address was given, the address itself may be the one in flight: "busy", not "network_used".
   */
  async claimTry(ipKey: string, addressKey: string | undefined, max: number): Promise<ClaimOutcome> {
    const [addressUsed, used] = await Promise.all([this.addressUsed(addressKey), this.ipSlotsUsed(ipKey, max)]);
    if (addressUsed) return { ok: false, reason: "address_used" };
    let leaseRefused = false;
    for (let n = 1; n <= max; n++) {
      if (used.has(n)) continue;
      const keys = [ipSlotKey(ipKey, n), ...(addressKey ? [addressKey] : [])];
      try {
        await this.claimGroup(keys).send({ maxRoundsToWaitForConfirmation: TRY_CONFIRM_ROUNDS });
      } catch (e) {
        if (isLeaseConflict(e)) {
          leaseRefused = true;
          continue;
        }
        throw e;
      }
      for (const k of keys) this.local.add(k);
      this.cache = null;
      return { ok: true, slot: n };
    }
    return { ok: false, reason: leaseRefused && addressKey ? "busy" : "network_used" };
  }

  /**
   * Slots already on the chain for (host, date) are skipped; a slot another instance is taking right now (not yet
   * on the indexer) is refused by its lease and the next n is tried. Any other failure throws: the caller does not pay.
   */
  async takeSellerSlot(host: string, date: string, max: number, from = 0): Promise<number | null> {
    const prefix = `${SLOT}${slotHostKey(host)}:${date}:`;
    const used = new Set<number>();
    for (const t of await this.notes(prefix, 1)) {
      const n = Number(Buffer.from(t.note ?? "", "base64").toString("utf8").slice(prefix.length).split(":")[0]);
      if (Number.isInteger(n)) used.add(n);
    }
    for (let n = from + 1; n <= max; n++) {
      const note = slotNote(host, date, n);
      if (used.has(n) || this.local.has(note)) continue;
      try {
        await this.slotGroup(host, date, n).send({ maxRoundsToWaitForConfirmation: TRY_CONFIRM_ROUNDS });
      } catch (e) {
        if (isLeaseConflict(e)) continue;
        throw e;
      }
      this.local.add(note);
      return n;
    }
    return null;
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
      // One person = one IP slot claim key ("ip:<hash>" or "ip:<hash>#<n>"), whether or not the note carries a nonce after it.
      const keyOf = (t: IdxTxn) => Buffer.from(t.note ?? "", "base64").toString("utf8").slice(CLAIM.length).split(":").slice(0, 2).join(":");
      return { entries, people: new Set(claims.map(keyOf)).size };
    })();
    this.cache = { at: now, log };
    log.catch(() => {
      if (this.cache?.log === log) this.cache = null;
    });
    return log;
  }
}
