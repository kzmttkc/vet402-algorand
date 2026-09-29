/**
 * Fairness page: every payment vet402 made to other teams in the Algorand x402 challenge.
 * GET /fairness (HTML) and GET /fairness.json. Free, read-only, nothing here signs or sends.
 *
 * vet402 buys from every listing by the same public rules (README "Daily delivery board"), and
 * that includes the other teams in the challenge. Those payments settle as x402 payments to them,
 * so they can add to their volume on the challenge leaderboard, not to vet402's. This page lists them.
 *
 * Both sides are read live, never from a file:
 *   - Participants: the challenge-tagged merchants on GoPlausible's leaderboard (`src=x402-global-challenge`,
 *     every page). A participant's addresses are its `address` and every Algorand MainNet address in its
 *     `accounts` (some merchants list more than one). vet402's own merchant is left out.
 *   - Payments: USDC (ASA `asaId`) asset transfers sent by vet402's wallets, from the Algorand indexer.
 *     Only USDC axfers count: ALGO payments (the trial wallet's 0-ALGO notes), zero-amount transfers
 *     (opt-ins) and transfers to vet402's own addresses are left out.
 * Why vet402 paid (per payment): board wallet = the per-listing census when the payment falls in a census
 * run (by tx id or by the run's time window), the daily sweep when it falls in a daily run; trial wallet =
 * a free try; payer wallet = paired with the latest earlier USDC payment into vet402's payTo within
 * PAIR_WINDOW_SEC that still has room (one seller payment each; an audit-sized payment up to AUDIT_ROOM):
 * from an outside address = a customer's check (/v1/check, /v1/audit or /v1/buy), from one of vet402's own
 * wallets = an operator test, none = no customer payment before it (/activity lists it as unmatched).
 * If the indexer or the leaderboard cannot be read, there is no report: the page says so and shows no numbers.
 */
import type { Env, Hono } from "hono";
import { ALGORAND_MAINNET_CAIP2 } from "@x402/avm";
import { atomicToUsdc } from "./config.js";
import { CENSUS_DATES, censusFileFor, esc, isBoardDate, txLink, type BoardFile, type BoardLoader } from "./board.js";
import { BASE_CSS, REPO_URL, topNav } from "./landing.js";

export const LEADERBOARD_API = "https://facilitator.goplausible.xyz/data/leaderboards";
/** The challenge's merchant leaderboard, all time, MainNet. */
export const LEADERBOARD_QUERY: Readonly<Record<string, string>> = {
  range: "all",
  env: "mainnet",
  src: "x402-global-challenge",
  group: "merchant",
  cat: "merchants",
};
export const LEADERBOARD_PAGE = 50;
const LEADERBOARD_MAX_PAGES = 20;
/** Where the page points for the rules that decide what vet402 buys. */
export const METHOD_URL = `${REPO_URL}#daily-delivery-board`;
export const FAIRNESS_README_URL = `${REPO_URL}#fairness-payments-to-other-challenge-teams`;
/** Server cache: 10 minutes. A failed read is not cached. */
export const FAIRNESS_TTL_MS = 10 * 60_000;

/** vet402's MainNet wallets that pay sellers (public addresses; README "MainNet run record"). */
export const MAINNET_WALLETS = {
  payer: "OZ3KMLALTO67BZLYLCZOT7IJBGN7JTO5A3MJHI2267EKQDASFKS52KU6VY",
  board: "HVRJUKO2QDZW6UKADE7LYWQFMTT75537OPMYEWOTYIUFO4BB25TFL5IQMQ",
  trial: "2MSEYNHSCPWU6IJOSZI6R54P4BN2CDFMELTMD3GHIVMSF7SQZIUUF6BJLQ",
} as const;

export type WalletRole = "board" | "payer" | "trial";
export const WALLET_ROLES: readonly WalletRole[] = ["board", "payer", "trial"];
export type PaymentReason = "census" | "daily" | "board_run" | "check" | "operator_test" | "no_customer" | "try";
export const REASONS: readonly PaymentReason[] = ["census", "daily", "board_run", "check", "operator_test", "no_customer", "try"];
export const REASON_TEXT: Record<PaymentReason, string> = {
  census: "per-listing census (every listed resource, once per run)",
  daily: "daily sweep (one resource per seller)",
  board_run: "board run (census or daily sweep)",
  check: "a check a customer paid vet402 for",
  operator_test: "a test check the operator paid for from vet402's own wallet",
  no_customer: "paid with no customer payment before it (listed on /activity as unmatched)",
  try: "a free try",
};

/** A payer-wallet payment pairs with a payment into payTo at most this long before it (as /activity). */
export const PAIR_WINDOW_SEC = 300;
/** A payment into payTo of at least this many atomic USDC is audit-sized: it may pair with up to AUDIT_ROOM seller payments. */
export const AUDIT_MIN_ATOMIC = 500_000n;
export const AUDIT_ROOM = 10;

const ALGO_ADDR = /^[A-Z2-7]{58}$/;

/** One board run (a census or daily file), used only to say why the board wallet paid. */
export interface BoardRunInfo {
  kind: "census" | "daily";
  startedAt: string;
  finishedAt: string;
  /** Seller tx ids the run recorded (paid rows). */
  txs: string[];
  /** Listed resources per payTo in this run (all rows, paid or not). */
  listings?: Record<string, number>;
}

export interface FairnessOptions {
  indexerUrl: string;
  asaId: string;
  /** vet402's wallets that pay sellers. A role left out is not read. */
  wallets: Partial<Record<WalletRole, string>>;
  /** vet402's payTo (receives customer payments; never a participant). */
  payTo: string;
  /** Other addresses of vet402's own (never a participant, never a payment). */
  ownAddresses?: string[];
  /** Leaderboard item ids that are vet402's own merchant. */
  ownMerchantIds?: string[];
  leaderboardApi?: string;
  /** Board runs (census and daily files). Omitted or failing = board payments are "board_run". */
  boardRuns?: () => Promise<BoardRunInfo[]>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export interface LeaderboardItem {
  id: string;
  label: string;
  sub?: string;
  rank: number;
  address: string;
  volume: number;
  challenge?: boolean;
  accounts?: { network?: { network?: string; testnet?: boolean }; address?: string }[];
}

export interface Participant {
  id: string;
  label: string;
  sub?: string;
  rank: number;
  volumeUsdc: string;
  addresses: string[];
}

export interface ParticipantRow extends Participant {
  payments: number;
  usdc: string;
  first: string;
  last: string;
  /** Up to 3 tx ids, newest first. */
  examples: string[];
  reasons: { reason: PaymentReason; payments: number }[];
  /** Listed resources in the latest census run (null when that run could not be read). */
  listings: number | null;
}

type Sum = { payments: number; usdc: string };

export interface FairnessReport {
  generatedAt: string;
  network: string;
  asaId: string;
  indexer: string;
  leaderboard: { source: string; merchants: number; participants: number };
  wallets: { role: WalletRole; address: string }[];
  /** vet402's own merchant on the leaderboard (null when it is not listed). */
  vet402: { id: string; label: string; rank: number; volumeUsdc: string } | null;
  totals: Sum & {
    participants: number;
    byWallet: Record<WalletRole, Sum>;
    byReason: Record<PaymentReason, Sum>;
  };
  /** USDC vet402 paid to sellers that are not challenge participants (context; not in the totals). */
  otherSellers: Sum & { addresses: number };
  /** Transfers left out: to vet402's own addresses, or of zero USDC. */
  excluded: { selfTransfers: number; zeroAmount: number };
  /** USDC sent from a participant address to one of vet402's addresses, each with its on-chain note. */
  fromParticipants: Sum & {
    txs: string[];
    items: { tx: string; from: string; usdc: string; note?: string; refund: boolean }[];
  };
  /**
   * USDC paid into vet402's payTo, split by sender: vet402's own wallets (self-payments) or any other address.
   * fromOthers includes plain deposits (for example funding from an exchange): customers are told apart only on /activity.
   */
  toPayTo: {
    fromOwnWallets: Sum & { first?: string; last?: string };
    fromOthers: Sum;
  };
  /** Most payments first. */
  rows: ParticipantRow[];
  method: string[];
}

interface IndexerTxn {
  id: string;
  sender: string;
  "tx-type"?: string;
  "confirmed-round": number;
  "round-time": number;
  "intra-round-offset"?: number;
  note?: string;
  "asset-transfer-transaction"?: { "asset-id": number; amount: number; receiver: string; "close-amount"?: number };
  "inner-txns"?: IndexerTxn[];
}

export interface UsdcTransfer {
  tx: string;
  sender: string;
  receiver: string;
  amount: bigint;
  round: number;
  offset: number;
  time: number;
  /** The transfer's note as UTF-8 text (sender-controlled: escape before showing). */
  note?: string;
}

/** An indexer note (base64) as printable text, at most 120 characters; undefined when empty or unreadable. */
export function noteText(b64: string | undefined): string | undefined {
  if (!b64) return undefined;
  try {
    const s = Buffer.from(b64, "base64").toString("utf8").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩�]/g, " ").replace(/\s+/g, " ").trim();
    return s ? s.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(".000Z", "Z");

async function getJson(f: typeof fetch, url: string, timeoutMs: number, what: string): Promise<unknown> {
  const res = await f(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${what} ${res.status}`);
  return res.json();
}

/** Every USDC asset transfer touching `address` (both directions, every page). 404 = unknown account = none. */
export async function usdcTransfersOf(
  f: typeof fetch,
  o: { indexerUrl: string; asaId: string; address: string; timeoutMs: number },
): Promise<UsdcTransfer[]> {
  const out: UsdcTransfer[] = [];
  let next: string | undefined;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ "asset-id": o.asaId, "tx-type": "axfer", limit: "1000" });
    if (next) q.set("next", next);
    const res = await f(`${o.indexerUrl}/v2/accounts/${o.address}/transactions?${q}`, { signal: AbortSignal.timeout(o.timeoutMs) });
    if (res.status === 404) return out;
    if (!res.ok) throw new Error(`indexer ${res.status}`);
    const body = (await res.json()) as { transactions?: IndexerTxn[]; "next-token"?: string };
    if (!Array.isArray(body.transactions)) throw new Error("indexer: malformed response");
    for (const root of body.transactions) {
      const walk = (t: IndexerTxn) => {
        const a = t["asset-transfer-transaction"];
        // Only USDC asset transfers: an ALGO payment (for example a 0-ALGO note) has no asset-transfer part.
        if (t["tx-type"] === "axfer" && a && String(a["asset-id"]) === String(o.asaId)) {
          out.push({
            tx: root.id,
            sender: t.sender,
            receiver: a.receiver,
            amount: BigInt(a.amount) + BigInt(a["close-amount"] ?? 0),
            round: root["confirmed-round"],
            offset: root["intra-round-offset"] ?? 0,
            time: root["round-time"],
            ...(noteText(t.note) ? { note: noteText(t.note) } : {}),
          });
        }
        for (const i of t["inner-txns"] ?? []) walk(i);
      };
      walk(root);
    }
    next = body["next-token"];
    if (!next || body.transactions.length === 0) return out;
  }
  throw new Error("indexer: too many pages");
}

/** Every challenge merchant on the leaderboard (all pages). Throws when a page cannot be read. */
export async function fetchLeaderboard(f: typeof fetch, api: string, timeoutMs: number): Promise<LeaderboardItem[]> {
  const items: LeaderboardItem[] = [];
  for (let page = 0; page < LEADERBOARD_MAX_PAGES; page++) {
    const q = new URLSearchParams({ ...LEADERBOARD_QUERY, limit: String(LEADERBOARD_PAGE), offset: String(page * LEADERBOARD_PAGE) });
    const body = (await getJson(f, `${api}?${q}`, timeoutMs, "leaderboard")) as { items?: unknown; total?: unknown };
    if (!Array.isArray(body.items)) throw new Error("leaderboard: malformed response");
    for (const it of body.items as Record<string, unknown>[]) {
      if (!it || typeof it !== "object" || typeof it.id !== "string" || typeof it.address !== "string") continue;
      items.push({
        id: it.id,
        label: typeof it.label === "string" && it.label ? it.label : it.id,
        sub: typeof it.sub === "string" ? it.sub : undefined,
        rank: typeof it.rank === "number" ? it.rank : 0,
        address: it.address,
        volume: typeof it.volume === "number" && Number.isFinite(it.volume) ? it.volume : 0,
        challenge: it.challenge === true,
        accounts: Array.isArray(it.accounts) ? (it.accounts as LeaderboardItem["accounts"]) : undefined,
      });
    }
    const total = typeof body.total === "number" ? body.total : undefined;
    if (body.items.length < LEADERBOARD_PAGE || (total !== undefined && (page + 1) * LEADERBOARD_PAGE >= total)) return items;
  }
  throw new Error("leaderboard: too many pages");
}

/** A leaderboard item's Algorand MainNet addresses: `address` plus every MainNet account it lists. */
export function mainnetAddresses(it: LeaderboardItem): string[] {
  const out = new Set<string>();
  if (ALGO_ADDR.test(it.address)) out.add(it.address);
  for (const a of it.accounts ?? []) {
    if (a?.network?.network === ALGORAND_MAINNET_CAIP2 && a.network.testnet !== true && typeof a.address === "string" && ALGO_ADDR.test(a.address)) out.add(a.address);
  }
  return [...out];
}

/** Leaderboard volume as USDC text (the API sends a float such as 0.15000000000000002). */
export function volumeText(v: number): string {
  return atomicToUsdc(BigInt(Math.round(v * 1e6)));
}

/** "12.345600" -> "12.3456"; "0.500000" -> "0.5"; "3.000000" -> "3". */
export function trimUsdc(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/**
 * Split the leaderboard into participants and vet402's own merchant.
 * A participant is a challenge merchant none of whose addresses is vet402's and whose id is not vet402's.
 * An address listed by two merchants goes to the better-ranked one.
 */
export function participantsOf(items: LeaderboardItem[], own: Set<string>, ownIds: Set<string>) {
  const participants: Participant[] = [];
  let vet402: FairnessReport["vet402"] = null;
  const taken = new Set<string>();
  for (const it of [...items].sort((a, b) => a.rank - b.rank)) {
    if (!it.challenge) continue;
    const addrs = mainnetAddresses(it);
    if (ownIds.has(it.id) || addrs.some((a) => own.has(a))) {
      vet402 ??= { id: it.id, label: it.label, rank: it.rank, volumeUsdc: volumeText(it.volume) };
      continue;
    }
    const mine = addrs.filter((a) => !taken.has(a));
    for (const a of mine) taken.add(a);
    participants.push({ id: it.id, label: it.label, sub: it.sub, rank: it.rank, volumeUsdc: volumeText(it.volume), addresses: mine });
  }
  return { participants, vet402, merchants: items.length };
}

/** Why the board wallet made a payment: a census or daily run that recorded its tx id, or whose run window holds it. */
export function boardReason(t: Pick<UsdcTransfer, "tx" | "time">, runs: BoardRunInfo[] | null): PaymentReason {
  if (!runs) return "board_run";
  for (const r of runs) if (r.txs.includes(t.tx)) return r.kind;
  const ms = t.time * 1000;
  const SLACK = 60_000;
  for (const r of runs) {
    const a = Date.parse(r.startedAt);
    const b = Date.parse(r.finishedAt);
    if (Number.isFinite(a) && Number.isFinite(b) && ms >= a - SLACK && ms <= b + SLACK) return r.kind;
  }
  return "board_run";
}

/** A board file as run info (null for a missing file or one without a run window). */
export function runInfoOf(kind: BoardRunInfo["kind"], b: BoardFile | null): BoardRunInfo | null {
  if (!b || !b.startedAt || !b.finishedAt) return null;
  const listings: Record<string, number> = {};
  for (const r of b.rows) if (r.payTo) listings[r.payTo] = (listings[r.payTo] ?? 0) + 1;
  return { kind, startedAt: b.startedAt, finishedAt: b.finishedAt, txs: b.rows.filter((r) => r.paid && r.tx).map((r) => r.tx!), listings };
}

/** Every census day on the fixed list, the latest census and the daily file, as run info (same files as /board/payments.csv). */
export async function boardRunsFrom(file: string, load: BoardLoader): Promise<BoardRunInfo[]> {
  const names: [BoardRunInfo["kind"], string][] = [
    ["daily", file],
    ["census", censusFileFor(file)],
    ...CENSUS_DATES.filter(isBoardDate).map((d): [BoardRunInfo["kind"], string] => ["census", censusFileFor(file, d)]),
  ];
  const got = await Promise.all(names.map(async ([kind, n]) => runInfoOf(kind, await load(n).catch(() => null))));
  return got.filter((x): x is BoardRunInfo => x !== null);
}

const zeroSum = ():{ payments: number; atomic: bigint } => ({ payments: 0, atomic: 0n });
const toSum = (s: { payments: number; atomic: bigint }): Sum => ({ payments: s.payments, usdc: atomicToUsdc(s.atomic) });

/** Build the report from what was read. Pure: no I/O. */
export function buildFairnessReport(input: {
  items: LeaderboardItem[];
  transfers: Record<WalletRole, UsdcTransfer[]>;
  payToTransfers: UsdcTransfer[];
  runs: BoardRunInfo[] | null;
  o: Pick<FairnessOptions, "indexerUrl" | "asaId" | "wallets" | "payTo" | "ownAddresses" | "ownMerchantIds" | "leaderboardApi">;
  generatedAt: string;
}): FairnessReport {
  const { o } = input;
  const wallets = WALLET_ROLES.filter((r) => o.wallets[r]).map((role) => ({ role, address: o.wallets[role]! }));
  const own = new Set<string>([o.payTo, ...wallets.map((w) => w.address), ...(o.ownAddresses ?? [])]);
  const { participants, vet402, merchants } = participantsOf(input.items, own, new Set(o.ownMerchantIds ?? []));
  const byAddr = new Map<string, Participant>();
  for (const p of participants) for (const a of p.addresses) byAddr.set(a, p);

  // Listed resources per participant, from the latest census run that could be read.
  const census = (input.runs ?? []).filter((r) => r.kind === "census" && r.listings).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];

  const per = new Map<string, { ts: (UsdcTransfer & { reason: PaymentReason })[]; atomic: bigint }>();
  const byWallet = Object.fromEntries(WALLET_ROLES.map((r) => [r, zeroSum()])) as Record<WalletRole, ReturnType<typeof zeroSum>>;
  const byReason = Object.fromEntries(REASONS.map((r) => [r, zeroSum()])) as Record<PaymentReason, ReturnType<typeof zeroSum>>;
  const other = zeroSum();
  const otherAddrs = new Set<string>();
  const excluded = { selfTransfers: 0, zeroAmount: 0 };
  const seen = new Set<string>();
  const tkey = (t: UsdcTransfer) => `${t.tx}:${t.sender}:${t.receiver}:${t.amount}`;
  const earlier = (a: UsdcTransfer, b: UsdcTransfer) => a.round < b.round || (a.round === b.round && a.offset < b.offset);

  // Payments into payTo (never payTo to itself), oldest first, once each.
  const intoPayTo: UsdcTransfer[] = [];
  {
    const s = new Set<string>();
    for (const t of input.payToTransfers) {
      if (t.receiver !== o.payTo || t.sender === o.payTo || t.amount <= 0n || s.has(tkey(t))) continue;
      s.add(tkey(t));
      intoPayTo.push(t);
    }
    intoPayTo.sort((a, b) => (earlier(a, b) ? -1 : earlier(b, a) ? 1 : 0));
  }
  // Why the payer wallet paid: pair each of its seller payments (oldest first) with the latest earlier payment into
  // payTo within PAIR_WINDOW_SEC that still has room.
  const payerReason = new Map<string, PaymentReason>();
  if (o.wallets.payer) {
    const payer = o.wallets.payer;
    const used = new Map<string, number>();
    const outs = (input.transfers.payer ?? [])
      .filter((t) => t.sender === payer && !own.has(t.receiver) && t.amount > 0n)
      .sort((a, b) => (earlier(a, b) ? -1 : earlier(b, a) ? 1 : 0));
    for (const p of outs) {
      if (payerReason.has(tkey(p))) continue;
      let pick: UsdcTransfer | undefined;
      for (const c of intoPayTo) {
        if (!earlier(c, p) || p.time - c.time > PAIR_WINDOW_SEC) continue;
        if ((used.get(tkey(c)) ?? 0) >= (c.amount >= AUDIT_MIN_ATOMIC ? AUDIT_ROOM : 1)) continue;
        pick = c; // the latest one
      }
      if (pick) used.set(tkey(pick), (used.get(tkey(pick)) ?? 0) + 1);
      payerReason.set(tkey(p), !pick ? "no_customer" : own.has(pick.sender) ? "operator_test" : "check");
    }
  }
  const ownIn = zeroSum();
  const othersIn = zeroSum();
  const ownInTimes: number[] = [];
  for (const t of intoPayTo) {
    if (own.has(t.sender)) {
      ownIn.payments++;
      ownIn.atomic += t.amount;
      ownInTimes.push(t.time);
    } else {
      othersIn.payments++;
      othersIn.atomic += t.amount;
    }
  }

  for (const w of wallets) {
    for (const t of input.transfers[w.role] ?? []) {
      if (t.sender !== w.address) continue; // received, not sent
      const key = `${t.tx}:${t.sender}:${t.receiver}:${t.amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (own.has(t.receiver)) {
        excluded.selfTransfers++;
        continue;
      }
      if (t.amount <= 0n) {
        excluded.zeroAmount++;
        continue;
      }
      const p = byAddr.get(t.receiver);
      if (!p) {
        other.payments++;
        other.atomic += t.amount;
        otherAddrs.add(t.receiver);
        continue;
      }
      const reason: PaymentReason = w.role === "trial" ? "try" : w.role === "payer" ? (payerReason.get(key) ?? "no_customer") : boardReason(t, input.runs);
      const e = per.get(p.id) ?? { ts: [], atomic: 0n };
      e.ts.push({ ...t, reason });
      e.atomic += t.amount;
      per.set(p.id, e);
      byWallet[w.role].payments++;
      byWallet[w.role].atomic += t.amount;
      byReason[reason].payments++;
      byReason[reason].atomic += t.amount;
    }
  }

  // Money in the other direction: participant address -> any of vet402's addresses.
  const inbound = zeroSum();
  const inboundTxs: string[] = [];
  const inboundItems: FairnessReport["fromParticipants"]["items"] = [];
  const inSeen = new Set<string>();
  for (const t of [...input.payToTransfers, ...WALLET_ROLES.flatMap((r) => input.transfers[r] ?? [])]) {
    if (!own.has(t.receiver) || !byAddr.has(t.sender) || t.amount <= 0n) continue;
    const key = `${t.tx}:${t.sender}:${t.receiver}:${t.amount}`;
    if (inSeen.has(key)) continue;
    inSeen.add(key);
    inbound.payments++;
    inbound.atomic += t.amount;
    inboundTxs.push(t.tx);
    inboundItems.push({ tx: t.tx, from: byAddr.get(t.sender)!.label, usdc: atomicToUsdc(t.amount), ...(t.note ? { note: t.note } : {}), refund: /\brefund/i.test(t.note ?? "") });
  }

  const rows: ParticipantRow[] = participants
    .filter((p) => per.has(p.id))
    .map((p) => {
      const e = per.get(p.id)!;
      const ts = [...e.ts].sort((a, b) => a.round - b.round || a.offset - b.offset);
      const reasons = REASONS.map((reason) => ({ reason, payments: ts.filter((t) => t.reason === reason).length })).filter((r) => r.payments > 0);
      const listings = census?.listings ? p.addresses.reduce((n, a) => n + (census.listings![a] ?? 0), 0) : null;
      return {
        ...p,
        payments: ts.length,
        usdc: atomicToUsdc(e.atomic),
        first: iso(ts[0].time),
        last: iso(ts[ts.length - 1].time),
        examples: [...new Set(ts.slice().reverse().map((t) => t.tx))].slice(0, 3),
        reasons,
        listings,
      };
    })
    .sort((a, b) => b.payments - a.payments || a.rank - b.rank);

  const total = rows.reduce((s, r) => ({ payments: s.payments + r.payments, atomic: s.atomic + per.get(r.id)!.atomic }), zeroSum());
  return {
    generatedAt: input.generatedAt,
    network: ALGORAND_MAINNET_CAIP2,
    asaId: o.asaId,
    indexer: o.indexerUrl,
    leaderboard: { source: `${o.leaderboardApi ?? LEADERBOARD_API}?${new URLSearchParams(LEADERBOARD_QUERY)}`, merchants, participants: participants.length },
    wallets,
    vet402,
    totals: {
      participants: rows.length,
      ...toSum(total),
      byWallet: Object.fromEntries(WALLET_ROLES.map((r) => [r, toSum(byWallet[r])])) as Record<WalletRole, Sum>,
      byReason: Object.fromEntries(REASONS.map((r) => [r, toSum(byReason[r])])) as Record<PaymentReason, Sum>,
    },
    otherSellers: { ...toSum(other), addresses: otherAddrs.size },
    excluded,
    fromParticipants: { ...toSum(inbound), txs: inboundTxs, items: inboundItems },
    toPayTo: {
      fromOwnWallets: {
        ...toSum(ownIn),
        ...(ownInTimes.length ? { first: iso(Math.min(...ownInTimes)), last: iso(Math.max(...ownInTimes)) } : {}),
      },
      fromOthers: toSum(othersIn),
    },
    rows,
    method: [
      "Participants: every challenge-tagged merchant on GoPlausible's leaderboard (all pages), except vet402's own. A participant's addresses are its `address` and every Algorand MainNet address listed in its `accounts`.",
      `Payments: USDC (ASA ${o.asaId}) asset transfers sent by vet402's wallets (${wallets.map((w) => w.role).join(", ")}) to a participant address, read from the Algorand indexer. ALGO payments, zero-amount transfers and transfers to vet402's own addresses are not counted.`,
      `Reason: board wallet = census or daily sweep (matched by the run's recorded tx id, or by the run's time window); trial wallet = a free try; payer wallet = paired with the latest earlier USDC payment into vet402's payTo within ${PAIR_WINDOW_SEC} s that still has room: from an outside address it is a customer's check, from one of vet402's own wallets it is an operator test, and with none it had no customer payment before it.`,
      "Payments into vet402's payTo are split by sender: vet402's own wallets (the operator's tests, which are self-payments) or any other address (plain deposits included; /activity tells customers apart).",
      "A payment the census recorded as not settled but that reached the chain is counted: the chain is the record.",
      `Cached for ${FAIRNESS_TTL_MS / 60_000} minutes. If the indexer or the leaderboard cannot be read, there are no numbers.`,
    ],
  };
}

export class FairnessLedger {
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private cache: { at: number; report: Promise<FairnessReport> } | null = null;

  constructor(private readonly o: FairnessOptions, private readonly ttlMs = FAIRNESS_TTL_MS) {
    this.f = o.fetchImpl ?? ((u, i) => fetch(u, i));
    this.timeoutMs = o.timeoutMs ?? 10_000;
    this.now = o.now ?? Date.now;
  }

  /** Cached for `ttlMs` (10 min); a failed read is not cached and never replaced by an old one. */
  get(): Promise<FairnessReport> {
    const t = this.now();
    if (this.cache && t - this.cache.at < this.ttlMs) return this.cache.report;
    const report = this.build();
    this.cache = { at: t, report };
    report.catch(() => {
      if (this.cache?.report === report) this.cache = null;
    });
    return report;
  }

  private async build(): Promise<FairnessReport> {
    const read = (address: string) => usdcTransfersOf(this.f, { indexerUrl: this.o.indexerUrl, asaId: this.o.asaId, address, timeoutMs: this.timeoutMs });
    const roles = WALLET_ROLES.filter((r) => this.o.wallets[r]);
    const [items, payToTransfers, runs, ...perWallet] = await Promise.all([
      fetchLeaderboard(this.f, this.o.leaderboardApi ?? LEADERBOARD_API, this.timeoutMs),
      read(this.o.payTo),
      this.o.boardRuns ? this.o.boardRuns().catch(() => null) : Promise.resolve(null),
      ...roles.map((r) => read(this.o.wallets[r]!)),
    ]);
    const transfers = { board: [], payer: [], trial: [] } as Record<WalletRole, UsdcTransfer[]>;
    roles.forEach((r, i) => (transfers[r] = perWallet[i]));
    return buildFairnessReport({ items, transfers, payToTransfers, runs: runs && runs.length ? runs : null, o: this.o, generatedAt: new Date(this.now()).toISOString() });
  }
}

/** The one plain line at the top. Every number comes from the report. */
export function headline(r: FairnessReport): string {
  const t = r.totals;
  return (
    "vet402 bought from every listing the same way, including other teams in this challenge. " +
    `Those payments can raise their leaderboard volume, not vet402's: ${t.payments.toLocaleString("en-US")} payments, ` +
    `${trimUsdc(t.usdc)} USDC to ${t.participants} participants.` +
    (r.vet402 ? ` ${ownVolumeLine(r)}` : "")
  );
}

/** What vet402's own leaderboard volume is made of: self-payments are named as such. Every number comes from the report. */
export function ownVolumeLine(r: FairnessReport): string {
  if (!r.vet402) return "";
  const self = r.toPayTo.fromOwnWallets;
  let s = `vet402's own leaderboard volume is ${trimUsdc(r.vet402.volumeUsdc)} USDC.`;
  if (self.payments > 0) {
    const day = (x?: string) => (x ?? "").slice(0, 10);
    const when = !self.first ? "" : day(self.first) === day(self.last) ? ` on ${day(self.first)}` : ` between ${day(self.first)} and ${day(self.last)}`;
    // The leaderboard counts only settled x402 payments; a plain deposit to payTo is not in it, so only the sums are compared.
    const all = self.usdc === r.vet402.volumeUsdc;
    s +=
      ` ${all ? "All of it is" : "It includes"} ${self.payments} test ${self.payments === 1 ? "payment" : "payments"} (${trimUsdc(self.usdc)} USDC) ` +
      `the operator made from vet402's own wallet to vet402${when}, to check the live deployment. ` +
      "Those are self-payments, and the challenge rules exclude repeated self-payments when the final ranking is reviewed.";
  }
  return `${s} Every customer payment, and how many customers there are, is on /activity.`;
}

function walletLine(r: FairnessReport): string {
  return r.wallets
    .map((w) => `${w.role} <code title="${esc(w.address)}">${esc(w.address.slice(0, 6))}…</code> ${r.totals.byWallet[w.role].payments.toLocaleString("en-US")} payments, ${esc(trimUsdc(r.totals.byWallet[w.role].usdc))} USDC`)
    .join(" · ");
}

const FAIRNESS_CSS = `main{max-width:1100px;margin:0 auto;padding:8px 16px 32px}
h1{font-size:26px;line-height:1.25;margin:8px 0 12px}
.lead{font-size:19px;line-height:1.5;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:0 0 16px}
.rules{background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:12px 18px;margin:0 0 16px}
.rules li{margin:4px 0}
.muted,small{color:var(--mut)}
.wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;min-width:900px;font-size:14px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{font-weight:600;color:var(--mut);white-space:nowrap}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.d{white-space:nowrap}
td a{margin-right:6px}`;

/** GET /fairness. All strings escaped; no script. */
export function fairnessHtml(r: FairnessReport): string {
  const t = r.totals;
  const when = (s: string) => esc(s.replace("T", " ").replace("Z", ""));
  const tx = (id: string) => {
    const href = txLink(id, "mainnet");
    return href ? `<a href="${esc(href)}" rel="noopener" title="${esc(id)}"><code>${esc(id.slice(0, 6))}</code></a>` : "";
  };
  const reasons = (row: ParticipantRow) => row.reasons.map((x) => `${esc(REASON_TEXT[x.reason])}: ${x.payments}`).join("<br>");
  const rows = r.rows
    .map(
      (row) =>
        `<tr><td><b>${esc(row.label)}</b>${row.sub && row.sub !== row.label ? `<br><small>${esc(row.sub)}</small>` : ""}</td>` +
        `<td class="n">${esc(row.rank)}</td><td class="n">${esc(row.listings ?? "n/a")}</td><td class="n">${row.payments.toLocaleString("en-US")}</td><td class="n">${esc(trimUsdc(row.usdc))}</td>` +
        `<td class="d">${when(row.first)}<br>${when(row.last)}</td><td>${row.examples.map(tx).join("")}</td><td>${reasons(row)}</td></tr>`,
    )
    .join("\n");
  const fp = r.fromParticipants;
  const inbound =
    fp.payments === 0
      ? "On chain now: no USDC from any participant address to vet402's addresses."
      : `On chain now: ${fp.payments} USDC ${fp.payments === 1 ? "transfer" : "transfers"} from participant addresses to vet402's addresses, ${esc(trimUsdc(fp.usdc))} USDC in total. Each one with the note it carries on chain: ` +
        fp.items
          .slice(0, 10)
          .map((i) => `${esc(i.from)}, ${esc(trimUsdc(i.usdc))} USDC${i.refund ? " (a refund, per its note)" : ""}${i.note ? `, note "${esc(i.note)}"` : ""} ${tx(i.tx)}`)
          .join("; ");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>vet402 fairness</title>
<meta name="description" content="Every payment vet402 made to other teams in the Algorand Foundation Global x402 Challenge, read live from the chain.">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<style>${BASE_CSS}
${FAIRNESS_CSS}</style></head><body>
${topNav()}
<main>
<h1>vet402 paid the other teams too</h1>
<p class="lead" id="headline">${esc(headline(r))}</p>
<ul class="rules">
<li>vet402 takes no money from any team in exchange for buying from them. A seller can pay vet402 for a checkup of its own API (<code>/v1/audit</code>): the result comes only from vet402's own purchases, the certificate says "self-purchased", and any payment from a team shows on the last line of this list.</li>
<li>There is no arrangement to buy from each other.</li>
<li>What vet402 buys is set by public rules: <a href="${esc(METHOD_URL)}" rel="noopener">the method in the README</a>. The census buys every listed resource once per run; the daily sweep buys one per seller.</li>
<li>${inbound}</li>
</ul>
<p>Why some teams got many payments: the census buys each listed resource once per run, so a team with many listings gets many purchases in every run. The <b>listings</b> column is the number of that team's resources in the latest census.</p>
<p class="muted">By wallet: ${walletLine(r)}. Also paid to sellers outside the challenge: ${r.otherSellers.payments.toLocaleString("en-US")} payments, ${esc(trimUsdc(r.otherSellers.usdc))} USDC (not in the numbers above). Not counted: ${r.excluded.selfTransfers} transfer(s) between vet402's own addresses, ${r.excluded.zeroAmount} of zero USDC.</p>
<div class="wrap"><table>
<thead><tr><th>team (leaderboard name)</th><th class="n">rank</th><th class="n">listings</th><th class="n">payments</th><th class="n">USDC</th><th>first / last (UTC)</th><th>example tx</th><th>why vet402 paid</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="8" class="muted">No payments to participants found.</td></tr>'}
</tbody></table></div>
<p><small>Read live: leaderboard <a href="${esc(r.leaderboard.source)}" rel="noopener">GoPlausible</a> (${r.leaderboard.participants} participants besides vet402), payments from the Algorand indexer (USDC ASA ${esc(r.asaId)}). Updated ${when(r.generatedAt)} UTC, cached for 10 minutes. <a href="/fairness.json">fairness.json</a> · <a href="${esc(FAIRNESS_README_URL)}" rel="noopener">how this is counted</a> · <a href="/board">Board</a> · <a href="/activity">Activity</a></small></p>
</main>
</body></html>`;
}

/** Shown instead of the page when the chain or the leaderboard cannot be read: no numbers at all. */
export function fairnessUnavailableHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>vet402 fairness</title><link rel="icon" href="/favicon.ico" sizes="32x32">
<style>${BASE_CSS}
${FAIRNESS_CSS}</style></head><body>
${topNav()}
<main>
<h1>vet402 paid the other teams too</h1>
<p class="lead">vet402 bought from every listing the same way, including other teams in this challenge. The numbers are read live from the Algorand chain and the leaderboard, and they cannot be read now. Please try again in a few minutes.</p>
<p><a href="${esc(FAIRNESS_README_URL)}" rel="noopener">How this is counted</a> · <a href="/board">Board</a></p>
</main>
</body></html>`;
}

/** Register the free routes. Call before the payment middleware. */
export function registerFairness<E extends Env>(app: Hono<E>, ledger: { get(): Promise<FairnessReport> }): void {
  const cacheControl = `public, max-age=${FAIRNESS_TTL_MS / 1000}, s-maxage=${FAIRNESS_TTL_MS / 1000}`;
  const detail = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);
  app.get("/fairness.json", async (c) => {
    try {
      return c.json(await ledger.get(), 200, { "cache-control": cacheControl });
    } catch (e) {
      return c.json({ error: "cannot_read_now", detail: detail(e) }, 503, { "cache-control": "no-store" });
    }
  });
  app.get("/fairness", async (c) => {
    try {
      return c.html(fairnessHtml(await ledger.get()), 200, { "cache-control": cacheControl });
    } catch {
      return c.html(fairnessUnavailableHtml(), 503, { "cache-control": "no-store" });
    }
  });
}
