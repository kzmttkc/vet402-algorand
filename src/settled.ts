/**
 * "transaction already in ledger": the seller's facilitator refused to settle vet402's payment
 * because the payment group was already on chain. The money moved, but the paid response carried
 * no success receipt, so the row was written paid: false (2026-09-27/28 census: 3 rows a day, all
 * settled on chain).
 *
 * The tx id in that message is not vet402's USDC transfer: it is the facilitator's fee-payer
 * transaction (type pay, 0 ALGO) in the same atomic group. So the check reads that tx from the
 * indexer, then its group, and looks for vet402's own transfer in it:
 *   type axfer · sender = vet402's payer · asset = USDC · receiver = the seller's payTo ·
 *   0 < amount <= the price vet402 approved · confirmed inside the purchase's time window.
 * Only then is the row recorded as paid, with vet402's transfer as its tx.
 *
 * Read-only: no key, no signature, no payment.
 */
export const ALREADY_IN_LEDGER = /transaction already in ledger:\s*([A-Z2-7]{52})\b/;

const TXID = /^[A-Z2-7]{52}$/;

/** The tx id named in a payment_failed detail ("... transaction already in ledger: <txid>"), else undefined. */
export function alreadyInLedgerTx(detail: string | undefined): string | undefined {
  return ALREADY_IN_LEDGER.exec(detail ?? "")?.[1];
}

export interface SettledPayment {
  /** vet402's USDC transfer to the seller (the tx to record). */
  tx: string;
  amountAtomic: bigint;
  round: number;
  /** Unix seconds. */
  roundTime: number;
}

export interface SettledLookup {
  indexerUrl: string;
  /** The tx id from the error message. */
  txid: string;
  /** vet402's paying wallet. */
  payer: string;
  /** The seller's payTo. */
  payTo: string;
  asaId: string;
  /** Upper bound for the transfer (the price vet402 approved). */
  maxAmountAtomic: bigint;
  /** The transfer must be confirmed inside [from, to] (unix seconds). */
  window: { from: number; to: number };
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface IdxTxn {
  id?: string;
  "tx-type"?: string;
  sender?: string;
  group?: string;
  "confirmed-round"?: number;
  "round-time"?: number;
  "asset-transfer-transaction"?: { "asset-id"?: number; amount?: number; receiver?: string };
}

function ours(t: IdxTxn, o: SettledLookup): SettledPayment | null {
  const a = t["asset-transfer-transaction"];
  if (t["tx-type"] !== "axfer" || !a || !t.id || !TXID.test(t.id)) return null;
  if (t.sender !== o.payer || a.receiver !== o.payTo || String(a["asset-id"]) !== String(o.asaId)) return null;
  const amount = BigInt(a.amount ?? 0);
  if (amount <= 0n || amount > o.maxAmountAtomic) return null;
  const round = t["confirmed-round"] ?? 0;
  const time = t["round-time"] ?? 0;
  if (round <= 0 || time < o.window.from || time > o.window.to) return null;
  return { tx: t.id, amountAtomic: amount, round, roundTime: time };
}

async function getJson(f: typeof fetch, url: string, timeoutMs: number): Promise<unknown | null> {
  const res = await f(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`indexer ${res.status}`);
  return res.json();
}

/**
 * vet402's settled transfer in the group of `txid`, or null when the indexer does not show one
 * that matches every condition above. Throws when the indexer cannot be read.
 */
export async function findSettledPayment(o: SettledLookup): Promise<SettledPayment | null> {
  if (!TXID.test(o.txid)) return null;
  const f = o.fetchImpl ?? fetch;
  const ms = o.timeoutMs ?? 8000;
  const one = (await getJson(f, `${o.indexerUrl}/v2/transactions/${o.txid}`, ms)) as { transaction?: IdxTxn } | null;
  const t = one?.transaction;
  if (!t) return null;
  const direct = ours(t, o);
  if (direct) return direct;
  if (!t.group || !t["confirmed-round"]) return null;
  const q = new URLSearchParams({ "group-id": t.group, round: String(t["confirmed-round"]) });
  const grp = (await getJson(f, `${o.indexerUrl}/v2/transactions?${q}`, ms)) as { transactions?: IdxTxn[] } | null;
  if (!grp || !Array.isArray(grp.transactions)) return null;
  // Only a transaction of that same group counts.
  for (const g of grp.transactions) {
    if (g.group !== t.group) continue;
    const s = ours(g, o);
    if (s) return s;
  }
  return null;
}

/** findSettledPayment with a few retries (the indexer can trail the chain by a few seconds). */
export async function findSettledPaymentWithRetry(
  o: SettledLookup,
  opts: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SettledPayment | null> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(opts.delayMs ?? 3000);
    try {
      const s = await findSettledPayment(o);
      if (s) return s;
      lastErr = undefined;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}
