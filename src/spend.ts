/**
 * Stateless daily cap: the source of truth for "how much has the payer wallet
 * sent today" is the chain (Algorand indexer), not a file. This works when every
 * serverless instance starts empty. A local ledger is kept as a backup and the
 * larger of the two is used. If the indexer cannot be read, we do not pay.
 */
import type { CapDecision, SpendLedger } from "./caps.js";

export type GuardDecision = CapDecision | { ok: false; reason: "cap_check_unavailable"; detail: string };

export interface SpendGuard {
  reserve(amountAtomic: bigint): Promise<GuardDecision>;
  release(reservationId: string): void;
  commit(reservationId: string): void;
  /** Can we pay anything at all right now? (used before charging the customer) */
  headroom(): Promise<{ ok: true; remainingAtomic: bigint } | { ok: false; reason: "daily_cap_reached" | "cap_check_unavailable"; detail: string }>;
}

interface IndexerTxn {
  sender: string;
  "tx-type"?: string;
  "asset-transfer-transaction"?: { "asset-id": number; amount: number; receiver: string; "close-amount"?: number };
}

/** Sum of USDC (atomic) sent by `address` to other accounts since 00:00 UTC of `now`. */
export async function usdcSentToday(opts: {
  indexerUrl: string;
  address: string;
  asaId: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<bigint> {
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? new Date();
  const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00Z`;
  let total = 0n;
  let next: string | undefined;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ "asset-id": opts.asaId, "tx-type": "axfer", "after-time": dayStart, limit: "1000" });
    if (next) q.set("next", next);
    const res = await f(`${opts.indexerUrl}/v2/accounts/${opts.address}/transactions?${q}`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (res.status === 404) return total; // account unknown to the indexer = nothing sent
    if (!res.ok) throw new Error(`indexer ${res.status}`);
    const body = (await res.json()) as { transactions?: IndexerTxn[]; "next-token"?: string };
    if (!Array.isArray(body.transactions)) throw new Error("indexer: malformed response");
    for (const t of body.transactions) {
      const a = t["asset-transfer-transaction"];
      if (!a || t.sender !== opts.address) continue;
      if (String(a["asset-id"]) !== String(opts.asaId)) continue;
      if (a.receiver === opts.address) continue; // opt-in / self transfer
      total += BigInt(a.amount) + BigInt(a["close-amount"] ?? 0);
    }
    next = body["next-token"];
    if (!next || body.transactions.length === 0) return total;
  }
  throw new Error("indexer: too many pages");
}

/** Chain-backed guard: max(indexer, local ledger) + price must stay within the daily cap. */
export class IndexedSpendGuard implements SpendGuard {
  constructor(
    private readonly ledger: SpendLedger,
    private readonly readChainSpent: () => Promise<bigint>,
  ) {}

  private async spent(): Promise<{ ok: true; spent: bigint } | { ok: false; detail: string }> {
    try {
      const chain = await this.readChainSpent();
      const local = this.ledger.spentTodayAtomic();
      return { ok: true, spent: chain > local ? chain : local };
    } catch (e) {
      return { ok: false, detail: `cannot read today's spend: ${(e as Error).message}`.slice(0, 200) };
    }
  }

  async headroom() {
    const s = await this.spent();
    if (!s.ok) return { ok: false as const, reason: "cap_check_unavailable" as const, detail: s.detail };
    const remaining = this.ledger.maxPerDayAtomic - s.spent;
    if (remaining <= 0n) return { ok: false as const, reason: "daily_cap_reached" as const, detail: `spent ${s.spent} of ${this.ledger.maxPerDayAtomic}` };
    return { ok: true as const, remainingAtomic: remaining };
  }

  async reserve(amountAtomic: bigint): Promise<GuardDecision> {
    const perCall = this.ledger.checkPerCall(amountAtomic);
    if (perCall) return perCall;
    const s = await this.spent();
    if (!s.ok) return { ok: false, reason: "cap_check_unavailable", detail: s.detail };
    if (s.spent + amountAtomic > this.ledger.maxPerDayAtomic) {
      return { ok: false, reason: "daily_cap_reached", detail: `spent ${s.spent} + price ${amountAtomic} > daily cap ${this.ledger.maxPerDayAtomic} (atomic USDC)` };
    }
    // Local ledger records the reservation (and re-checks its own view synchronously).
    return this.ledger.reserve(amountAtomic);
  }

  release(id: string) {
    this.ledger.release(id);
  }
  commit(id: string) {
    this.ledger.commit(id);
  }
}

/** Local-only guard (tests, offline demos). */
export class LocalSpendGuard implements SpendGuard {
  constructor(private readonly ledger: SpendLedger) {}
  async reserve(a: bigint): Promise<GuardDecision> {
    return this.ledger.reserve(a);
  }
  release(id: string) {
    this.ledger.release(id);
  }
  commit(id: string) {
    this.ledger.commit(id);
  }
  async headroom() {
    const remaining = this.ledger.maxPerDayAtomic - this.ledger.spentTodayAtomic();
    return remaining > 0n
      ? { ok: true as const, remainingAtomic: remaining }
      : { ok: false as const, reason: "daily_cap_reached" as const, detail: "local ledger full" };
  }
}
