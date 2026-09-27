import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type CapDecision =
  | { ok: true; reservationId: string }
  | { ok: false; reason: "price_over_cap" | "daily_cap_reached"; detail: string };

interface LedgerState {
  day: string; // UTC YYYY-MM-DD
  spentAtomic: string; // bigint as string
}

/**
 * Per-call and per-UTC-day spend caps for payments vet402 makes to sellers.
 *
 * `reserve` is synchronous so two concurrent checks cannot both pass the daily
 * cap (Node runs it without interleaving). A reservation counts as spent the
 * moment it is made: a payment that might have settled is never "refunded" to
 * the budget. Only `release` (called when we are sure no signature left the
 * process) gives it back.
 */
export class SpendLedger {
  private state: LedgerState;
  private readonly open = new Map<string, bigint>();
  private seq = 0;

  constructor(
    readonly maxPerCallAtomic: bigint,
    readonly maxPerDayAtomic: bigint,
    private readonly file?: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.state = this.load();
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private load(): LedgerState {
    if (this.file && existsSync(this.file)) {
      try {
        const s = JSON.parse(readFileSync(this.file, "utf8")) as LedgerState;
        if (typeof s.day === "string" && /^\d+$/.test(s.spentAtomic)) return s;
      } catch {
        /* corrupted ledger: fall through, but fail closed below */
        return { day: this.today(), spentAtomic: this.maxPerDayAtomic.toString() };
      }
    }
    return { day: this.today(), spentAtomic: "0" };
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state) + "\n");
    renameSync(tmp, this.file);
  }

  private roll(): void {
    const d = this.today();
    if (this.state.day !== d) this.state = { day: d, spentAtomic: "0" };
  }

  spentTodayAtomic(): bigint {
    this.roll();
    return BigInt(this.state.spentAtomic);
  }

  /** Pure check against the per-call cap only (no state change). */
  checkPerCall(amountAtomic: bigint): CapDecision | null {
    if (amountAtomic > this.maxPerCallAtomic) {
      return {
        ok: false,
        reason: "price_over_cap",
        detail: `price ${amountAtomic} > per-call cap ${this.maxPerCallAtomic} (atomic USDC)`,
      };
    }
    return null;
  }

  reserve(amountAtomic: bigint): CapDecision {
    if (amountAtomic < 0n) throw new Error("negative amount");
    const perCall = this.checkPerCall(amountAtomic);
    if (perCall) return perCall;
    this.roll();
    const spent = BigInt(this.state.spentAtomic);
    if (spent + amountAtomic > this.maxPerDayAtomic) {
      return {
        ok: false,
        reason: "daily_cap_reached",
        detail: `spent ${spent} + price ${amountAtomic} > daily cap ${this.maxPerDayAtomic} (atomic USDC)`,
      };
    }
    this.state.spentAtomic = (spent + amountAtomic).toString();
    this.persist();
    const id = `r${++this.seq}`;
    this.open.set(id, amountAtomic);
    return { ok: true, reservationId: id };
  }

  /** Give a reservation back. Only call when no payment signature was sent. */
  release(reservationId: string): void {
    const amt = this.open.get(reservationId);
    if (amt === undefined) return;
    this.open.delete(reservationId);
    this.roll();
    const spent = BigInt(this.state.spentAtomic) - amt;
    this.state.spentAtomic = (spent < 0n ? 0n : spent).toString();
    this.persist();
  }

  /** Mark a reservation as final (payment may have been sent). */
  commit(reservationId: string): void {
    this.open.delete(reservationId);
  }
}
