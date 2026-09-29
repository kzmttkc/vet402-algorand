/**
 * After a run: is every USDC payment the board wallet made during the run on a row?
 *
 * 2026-09-27 to 09-29: 20 paid purchases were written paid: false (a timeout, or a 200 with no
 * settlement receipt) while the payment had settled on chain. They were found by hand and corrected
 * (README "Corrections"). This check does the same after every run, read-only (no key, no payment):
 *
 * 1. Read from the indexer every USDC transfer the board wallet sent during the run.
 * 2. A transfer whose tx is on a row of any board file is accounted for.
 * 3. Any other transfer is written to a row only when the pairing is one to one under all of:
 *    board wallet -> the row's payTo · amount = the row's price · an x402 settlement group (vet402's
 *    transfer has fee 0; another sender's 0-ALGO pay with a fee is in the group: the facilitator's fee
 *    payer) · on no other row · signed while the row's paid request was open. The signing time is the
 *    one vet402's client writes into the transfer's note (x402-payment-v2-<Date.now()>), on the same
 *    clock as row.at (the time the answer came back): it must fall in [at - 30 s, at + 1 s].
 *    The row keeps its verdict and reason (so its class and how it counts for the seller do not change);
 *    it gets paid: true, the tx, and a note in detail.
 * 4. Everything else is unmatched: kept in the result, shown on /board, and the run fails.
 *    When the indexer cannot be read, the result says the check could not run, and the run fails.
 */
import type { BoardRow } from "./board.js";
import { atomicToUsdc, usdcToAtomic } from "./config.js";

/** Signing time window around row.at (ms). Calibrated on 1,161 paid rows: at - signed = 3.1 to 26.7 s. */
export const SIGNED_BEFORE_MS = 30_000;
export const SIGNED_AFTER_MS = 1_000;
/** The indexer window starts this long before the file's startedAt. */
export const WINDOW_LEAD_MS = 120_000;

const TXID = /^[A-Z2-7]{52}$/;

/** A USDC transfer sent by the board wallet, as read from the indexer. */
export interface OutTransfer {
  tx: string;
  receiver: string;
  amountAtomic: bigint;
  fee: number;
  round: number;
  /** Unix seconds. */
  roundTime: number;
  group?: string;
  /** From the note x402-payment-v2-<ms>; undefined when the note has none. */
  signedAtMs?: number;
  /** Set for transfers on no row: true when the group is an x402 settlement group. */
  x402Group?: boolean;
}

export interface Unmatched {
  tx: string;
  round: number;
  /** Round time (ISO). */
  at: string;
  signedAt?: string;
  amountUsdc: string;
  payTo: string;
  why: string;
  /** Rows that could have been this payment (url), when more than one. */
  rows?: string[];
}

export interface ReconcileResult {
  checkedAt: string;
  /** ok: every transfer is on a row. unmatched: some are not. unavailable: the chain could not be read. */
  status: "ok" | "unmatched" | "unavailable";
  window: { from: string; to: string };
  /** USDC transfers from the board wallet in the window. */
  transfers: number;
  /** Of those, already on a row before this check. */
  onRows: number;
  /** Written to a row by this check (paid: true, tx). */
  recorded: { tx: string; url: string }[];
  unmatched: Unmatched[];
  error?: string;
  /**
   * A later check that could not read the chain. The result above (and its list of payments on no
   * row) is kept as it was; this says the latest attempt did not run.
   */
  lastAttempt?: { checkedAt: string; status: "unavailable"; window: { from: string; to: string }; error?: string };
  /** Set by the next UTC day's first run, which checks the day again for payments settled after its last run. */
  nextDayCheckedAt?: string;
}

/** The ms timestamp in an x402 payment note ("x402-payment-v2-1759..."), from the indexer's base64 note. */
export function signedAtFromNote(noteB64: string | undefined): number | undefined {
  if (!noteB64) return undefined;
  let s: string;
  try {
    s = Buffer.from(noteB64, "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const m = /^x402-payment-v\d+-(\d{12,14})$/.exec(s);
  return m ? Number(m[1]) : undefined;
}

function clockOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(11, 19);
}

/** Rows a settled payment can belong to: sent, not recorded paid, with a payTo and a price. */
export function openRow(r: BoardRow): boolean {
  if (r.paid || !r.payTo || !r.priceUsdc || !Number.isFinite(Date.parse(r.at))) return false;
  // SKIPPED rows were not bought (cap, per-host limit, interrupted before a row), unfillable ones were never sent.
  if (r.verdict === "SKIPPED" || r.reason === "placeholder_unfillable") return false;
  try {
    usdcToAtomic(r.priceUsdc);
  } catch {
    return false;
  }
  return true;
}

export interface Plan {
  onRows: number;
  pairs: { row: number; t: OutTransfer }[];
  unmatched: Unmatched[];
}

/**
 * Pure: pair the transfers on no row with the file's open rows. `recorded` = tx ids on any row of any
 * board file. Only a transfer with exactly one candidate row, whose row has exactly one candidate
 * transfer, in an x402 settlement group, is paired.
 */
export function planReconcile(rows: BoardRow[], transfers: OutTransfer[], recorded: Set<string>): Plan {
  const orphans = transfers.filter((t) => !recorded.has(t.tx));
  const open = rows.map((r, i) => ({ r, i })).filter(({ r }) => openRow(r));
  const byTx = new Map<string, number[]>();
  const byRow = new Map<number, string[]>();
  for (const t of orphans) {
    if (t.signedAtMs === undefined) continue;
    for (const { r, i } of open) {
      if (r.payTo !== t.receiver || usdcToAtomic(r.priceUsdc!) !== t.amountAtomic) continue;
      const at = Date.parse(r.at);
      if (t.signedAtMs < at - SIGNED_BEFORE_MS || t.signedAtMs > at + SIGNED_AFTER_MS) continue;
      byTx.set(t.tx, [...(byTx.get(t.tx) ?? []), i]);
      byRow.set(i, [...(byRow.get(i) ?? []), t.tx]);
    }
  }
  const pairs: Plan["pairs"] = [];
  const unmatched: Unmatched[] = [];
  for (const t of orphans) {
    const cand = byTx.get(t.tx) ?? [];
    let why = "";
    if (t.signedAtMs === undefined) why = "no x402 signing time in the transfer's note";
    else if (cand.length === 0) why = "no open row with this payTo and price was waiting for an answer when it was signed";
    else if (cand.length > 1) why = `${cand.length} open rows with this payTo and price were waiting for an answer when it was signed`;
    else if ((byRow.get(cand[0])?.length ?? 0) > 1) why = `its row has ${byRow.get(cand[0])!.length} candidate transfers`;
    else if (t.x402Group !== true) why = "not an x402 settlement group";
    if (!why) {
      pairs.push({ row: cand[0], t });
      continue;
    }
    unmatched.push({
      tx: t.tx,
      round: t.round,
      at: new Date(t.roundTime * 1000).toISOString(),
      ...(t.signedAtMs !== undefined ? { signedAt: new Date(t.signedAtMs).toISOString() } : {}),
      amountUsdc: atomicToUsdc(t.amountAtomic),
      payTo: t.receiver,
      why,
      ...(cand.length > 1 ? { rows: cand.map((i) => rows[i].url) } : {}),
    });
  }
  return { onRows: transfers.length - orphans.length, pairs, unmatched };
}

/** The row with the settled payment written in: paid, the tx, and a note in detail (at most 300 characters). */
export function recordSettledRow(r: BoardRow, t: OutTransfer): BoardRow {
  const note = ` · settled on chain: vet402's transfer ${t.tx} (to this payTo, round ${t.round}, ${clockOf(t.roundTime)} UTC); no delivery`;
  const old = r.detail ?? "";
  const room = 300 - note.length;
  const detail = old.length <= room ? old + note : old.slice(0, Math.max(0, room - 1)) + "…" + note;
  return { ...r, paid: true, tx: t.tx, detail };
}

// ---- indexer

interface IdxTxn {
  id?: string;
  "tx-type"?: string;
  sender?: string;
  fee?: number;
  group?: string;
  note?: string;
  "confirmed-round"?: number;
  "round-time"?: number;
  "asset-transfer-transaction"?: { "asset-id"?: number; amount?: number; receiver?: string };
  "payment-transaction"?: { amount?: number; receiver?: string };
}

export interface IndexerOptions {
  indexerUrl: string;
  payer: string;
  asaId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

async function getJson(o: IndexerOptions, url: string): Promise<unknown> {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, o.attempts ?? 4);
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(1000 * 2 ** i);
    try {
      const res = await f(url, { signal: AbortSignal.timeout(o.timeoutMs ?? 20_000) });
      if (!res.ok) throw new Error(`indexer ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** Every USDC transfer (amount > 0) sent by the payer, confirmed in [from, to]. Throws when the indexer cannot be read. */
export async function fetchPayerTransfers(o: IndexerOptions, from: Date, to: Date): Promise<OutTransfer[]> {
  const out: OutTransfer[] = [];
  const seen = new Set<string>();
  let next: string | undefined;
  for (let page = 0; page < 200; page++) {
    const q = new URLSearchParams({ "asset-id": String(o.asaId), "after-time": from.toISOString(), "before-time": to.toISOString(), limit: "1000" });
    if (next) q.set("next", next);
    const d = (await getJson(o, `${o.indexerUrl}/v2/accounts/${o.payer}/transactions?${q}`)) as { transactions?: IdxTxn[]; "next-token"?: string };
    if (!d || !Array.isArray(d.transactions)) throw new Error("indexer: no transactions array");
    for (const t of d.transactions) {
      const a = t["asset-transfer-transaction"];
      if (t["tx-type"] !== "axfer" || !a || t.sender !== o.payer || String(a["asset-id"]) !== String(o.asaId)) continue;
      if (!t.id || !TXID.test(t.id) || seen.has(t.id) || !a.receiver || !(Number(a.amount) > 0)) continue;
      seen.add(t.id);
      out.push({
        tx: t.id,
        receiver: a.receiver,
        amountAtomic: BigInt(a.amount!),
        fee: Number(t.fee ?? 0),
        round: Number(t["confirmed-round"] ?? 0),
        roundTime: Number(t["round-time"] ?? 0),
        group: t.group,
        signedAtMs: signedAtFromNote(t.note),
      });
    }
    next = d["next-token"];
    if (!next || d.transactions.length === 0) return out;
  }
  throw new Error("indexer: too many pages");
}

/**
 * An x402 settlement group: vet402's transfer pays no fee, and another sender's 0-ALGO pay with a fee
 * (the facilitator's fee payer) is in the same group. Throws when the indexer cannot be read.
 */
export async function isX402Group(o: IndexerOptions, t: OutTransfer): Promise<boolean> {
  if (!t.group || t.fee !== 0 || !t.round) return false;
  const q = new URLSearchParams({ "group-id": t.group, "min-round": String(t.round), "max-round": String(t.round) });
  const d = (await getJson(o, `${o.indexerUrl}/v2/transactions?${q}`)) as { transactions?: IdxTxn[] };
  if (!d || !Array.isArray(d.transactions)) throw new Error("indexer: no transactions array");
  return d.transactions.some(
    (m) => m.group === t.group && m["tx-type"] === "pay" && m.sender !== o.payer && Number(m["payment-transaction"]?.amount ?? -1) === 0 && Number(m.fee ?? 0) > 0,
  );
}

export interface ReconcileInput extends IndexerOptions {
  /** The file's rows; paired rows are replaced in place. */
  rows: BoardRow[];
  /** tx ids on any row of any board file (this file's included). */
  recorded: Set<string>;
  from: Date;
  to: Date;
  now?: () => Date;
}

/** Read the chain, pair what can be paired 1:1 (rows are updated in place), and report the rest. */
export async function reconcileRows(o: ReconcileInput): Promise<ReconcileResult> {
  const now = o.now ?? (() => new Date());
  const window = { from: o.from.toISOString(), to: o.to.toISOString() };
  let transfers: OutTransfer[];
  try {
    transfers = await fetchPayerTransfers(o, o.from, o.to);
    for (const t of transfers) if (!o.recorded.has(t.tx)) t.x402Group = await isX402Group(o, t);
  } catch (e) {
    return {
      checkedAt: now().toISOString(),
      status: "unavailable",
      window,
      transfers: 0,
      onRows: 0,
      recorded: [],
      unmatched: [],
      error: `the indexer could not be read, so it is not confirmed that every payment is on a row: ${String((e as Error).message ?? e).slice(0, 160)}`,
    };
  }
  const plan = planReconcile(o.rows, transfers, o.recorded);
  const recorded: ReconcileResult["recorded"] = [];
  for (const { row, t } of plan.pairs) {
    o.rows[row] = recordSettledRow(o.rows[row], t);
    o.recorded.add(t.tx);
    recorded.push({ tx: t.tx, url: o.rows[row].url });
  }
  return {
    checkedAt: now().toISOString(),
    status: plan.unmatched.length ? "unmatched" : "ok",
    window,
    transfers: transfers.length,
    onRows: plan.onRows,
    recorded,
    unmatched: plan.unmatched,
  };
}

/** One line for the log and the workflow. */
export function reconcileLine(r: ReconcileResult): string {
  if (r.status === "unavailable") return `payment check: NOT CHECKED (${r.error})`;
  return (
    `payment check: ${r.transfers} board-wallet USDC transfer(s) ${r.window.from} to ${r.window.to} · ${r.onRows} already on a row · ` +
    `${r.recorded.length} recorded now · ${r.unmatched.length} on no row`
  );
}
