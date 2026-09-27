/**
 * Public activity ledger: every x402 payment vet402 received, next to the
 * payment vet402 then made to the seller. Read live from the Algorand indexer,
 * so anyone can check each row on-chain. Nothing here signs or sends anything.
 *
 * What counts as a customer payment (checked against MainNet data, 2026-09-27):
 *   - a USDC transfer (ASA `asaId`) whose receiver is vet402's `payTo`, and
 *   - it sits in an atomic group that also holds a `pay` transaction sent by
 *     the x402 facilitator's fee payer (GoPlausible: ZMFK2OI7...). Only the
 *     facilitator can sign that transaction, and it only settles verified x402
 *     payments. Plain deposits to `payTo` (exchange withdrawals, transfers
 *     between the owner's wallets) have no such group and are not counted.
 * Customer = the sender of that transfer. If the sender is vet402's own `payTo`
 * or `payer` wallet, the row is an operator test and is not counted as a customer.
 *
 * Seller payments: every USDC transfer sent by the `payer` wallet to an address
 * that is not vet402's own. Each one is matched to the most recent earlier
 * customer payment (within its window) that still has room: a check or a
 * purchase (/v1/buy; one customer payment for one seller payment) has room for 1; a seller audit
 * (amount >= `auditPriceAtomic`) has room for up to `auditMaxTargets`, because one
 * audit buys several of the seller's resources. An audit is still one customer
 * payment: it is one row, with its seller payments listed under it.
 * A seller payment with no such customer payment is listed as unmatched, never hidden.
 *
 * Payments below the check price (`priceAtomic`) are customers only when they can be proven:
 *   - exactly the /v1/verdict price (`verdictPriceAtomic`): a lookup ("verdict"); it pays no
 *     seller, so it never takes a seller payment;
 *   - otherwise a purchase ("buy", /v1/buy = seller price + `buyFeeAtomic`) only if a seller
 *     payment pairs with it and (payment - fee) >= that seller payment. A small deposit with no
 *     such seller payment is listed as below_price, so it cannot inflate the customer count.
 * When several customer payments could take a seller payment: first a purchase whose
 * (payment - fee) is exactly that seller payment, then a check or an audit, then a purchase it only fits.
 */
import { atomicToUsdc, type NetworkName } from "./config.js";
import type { BaseCustomerRead, BaseNotCounted } from "./base.js";

/**
 * Base customer payments (BASE_ACCEPT=on): read by base.ts from a keyless explorer, each proven from
 * its receipt. They are customers like Algorand ones and pair with the Algorand seller payments by time.
 */
export interface BaseActivitySource {
  network: string;
  payTo: string;
  usdc: string;
  explorerUrl: string;
  signers: string[];
  read(): Promise<BaseCustomerRead>;
}

/** Fee payer of the GoPlausible x402 facilitator (from its /supported, `extra.feePayer`). */
export const GOPLAUSIBLE_FEE_PAYERS = ["ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA"];

export interface ActivityOptions {
  networkName: NetworkName;
  indexerUrl: string;
  asaId: string;
  payTo: string;
  payer: string;
  feePayers?: string[];
  /** Price of one check in atomic USDC. Smaller payments count only as a verdict or a paired buy (see above). */
  priceAtomic?: bigint;
  /** /v1/buy fee in atomic USDC. Omitted = payments below the check price are never purchases. */
  buyFeeAtomic?: bigint;
  /** /v1/verdict price in atomic USDC (a payment of exactly this is a lookup). */
  verdictPriceAtomic?: bigint;
  /** Max seconds between a customer payment and the seller payment it pays for. */
  pairWindowSec?: number;
  /** Price of one seller audit in atomic USDC. Customer payments of at least this much are audits. Omitted = no audits. */
  auditPriceAtomic?: bigint;
  /** Most seller payments one audit can account for (default 10). */
  auditMaxTargets?: number;
  /** Max seconds between an audit's customer payment and its last seller payment (default max(pairWindowSec, 900)). */
  auditPairWindowSec?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** BASE_ACCEPT=on: also count customers who paid on Base. Omitted = Algorand only (the report has no `base`). */
  base?: BaseActivitySource;
  /** Free-trial wallet (/try/run). Its payments to sellers are counted as trials, never as customers or customer revenue. */
  trialPayer?: string;
}

export interface SellerPayment {
  seller: string;
  tx: string;
  round: number;
  amountUsdc: string;
}

export interface ActivityRow {
  /**
   * "check" = one customer payment (at least the check price) for one seller payment;
   * "buy" = a /v1/buy below the check price, paired with its seller payment;
   * "verdict" = a /v1/verdict lookup (no seller payment); "audit" = one customer payment for several.
   */
  kind: "check" | "audit" | "buy" | "verdict";
  /** Set only for a customer payment made on Base (round = Base block). Seller payments are always on Algorand. */
  network?: string;
  time: string;
  round: number;
  customer: string;
  customerTx: string;
  amountUsdc: string;
  operatorTest: boolean;
  seller: string | null;
  sellerTx: string | null;
  sellerRound: number | null;
  sellerAmountUsdc: string | null;
  /** Every seller payment matched to this customer payment (the fields above repeat the first one). */
  sellerPayments: SellerPayment[];
}

export interface Payout {
  time: string;
  round: number;
  seller: string;
  tx: string;
  amountUsdc: string;
}

export interface NotCounted {
  tx: string;
  round: number;
  reason: "not_in_a_group" | "no_x402_facilitator_in_group" | "inner_transaction" | "below_price" | BaseNotCounted["reason"];
  /** Set only for a Base deposit (round = Base block). */
  network?: string;
}

/** The Base side of the report (only when BASE_ACCEPT=on). */
export type BaseActivity =
  | { status: "counted"; network: string; payTo: string; usdc: string; explorer: string; facilitatorSigners: string[]; customers: { addresses: number; payments: number; usdc: string } }
  | { status: "not_counted"; network: string; payTo: string; explorer: string; detail: string };

export interface ActivityReport {
  network: NetworkName;
  asaId: string;
  payTo: string;
  payer: string;
  feePayers: string[];
  indexer: string;
  generatedAt: string;
  totals: {
    customers: { addresses: number; payments: number; usdc: string };
    operatorTests: { payments: number; usdc: string; sellerPayments: number; sellerUsdc: string };
    sellerPayments: { payments: number; usdc: string; unmatched: number; unmatchedUsdc: string };
    /** Paying customers' audits (operator tests excluded): included in customers and sellerPayments above. */
    audits: { payments: number; sellerPayments: number; sellerUsdc: string };
    /** Free trials: vet402 paid a seller from its trial wallet. Not customers, not in the totals above. */
    trials?: { payments: number; usdc: string; wallet: string };
  };
  /** BASE_ACCEPT=on only. "not_counted": the Base explorer or RPC could not be read; Base payments are then missing from every total. */
  base?: BaseActivity;
  /** Newest first. */
  rows: ActivityRow[];
  unmatchedPayouts: Payout[];
  /** USDC received by payTo that is not an x402 settlement (not listed as rows). */
  notCounted: NotCounted[];
  method: string[];
}

interface IndexerTxn {
  id: string;
  sender: string;
  "tx-type"?: string;
  group?: string;
  fee?: number;
  "confirmed-round": number;
  "round-time": number;
  "intra-round-offset"?: number;
  "asset-transfer-transaction"?: { "asset-id": number; amount: number; receiver: string; "close-amount"?: number };
  "payment-transaction"?: { amount: number; receiver: string };
  "inner-txns"?: IndexerTxn[];
}

interface Transfer {
  tx: string;
  sender: string;
  receiver: string;
  amount: bigint;
  round: number;
  offset: number;
  time: number;
  group?: string;
  /** Moved by an app call (inner transaction); `tx` is the top-level app call. */
  inner?: boolean;
  /** "base" for a Base customer payment (round = block, offset = log index). */
  chain?: "base";
}

const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(".000Z", "Z");
/** Same chain: by round (block) and offset. Across chains only the clock can order them: a Base payment in the same second counts as earlier. */
const before = (a: Transfer, b: Transfer) =>
  a.chain === b.chain
    ? a.round < b.round || (a.round === b.round && a.offset < b.offset)
    : a.time < b.time || (a.time === b.time && a.chain === "base");

export function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a;
}

async function getJson(f: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  const res = await f(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`indexer ${res.status}`);
  return res.json();
}

/** All USDC transfers touching `address` (every page). 404 = unknown account = none. */
async function usdcTransfers(o: Required<Pick<ActivityOptions, "indexerUrl" | "asaId" | "timeoutMs">> & { f: typeof fetch; address: string }): Promise<Transfer[]> {
  const out: Transfer[] = [];
  let next: string | undefined;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ "asset-id": o.asaId, "tx-type": "axfer", limit: "1000" });
    if (next) q.set("next", next);
    const res = await o.f(`${o.indexerUrl}/v2/accounts/${o.address}/transactions?${q}`, { signal: AbortSignal.timeout(o.timeoutMs) });
    if (res.status === 404) return out;
    if (!res.ok) throw new Error(`indexer ${res.status}`);
    const body = (await res.json()) as { transactions?: IndexerTxn[]; "next-token"?: string };
    if (!Array.isArray(body.transactions)) throw new Error("indexer: malformed response");
    for (const root of body.transactions) {
      // The indexer returns the top-level transaction when a match is an inner one (app calls).
      const walk = (t: IndexerTxn, inner: boolean) => {
        const a = t["asset-transfer-transaction"];
        if (a && String(a["asset-id"]) === String(o.asaId)) {
          out.push({
            tx: root.id,
            sender: t.sender,
            receiver: a.receiver,
            amount: BigInt(a.amount) + BigInt(a["close-amount"] ?? 0),
            round: root["confirmed-round"],
            offset: root["intra-round-offset"] ?? 0,
            time: root["round-time"],
            group: inner ? undefined : root.group || undefined,
            inner,
          });
        }
        for (const i of t["inner-txns"] ?? []) walk(i, true);
      };
      walk(root, false);
    }
    next = body["next-token"];
    if (!next || body.transactions.length === 0) return out;
  }
  throw new Error("indexer: too many pages");
}

export class ActivityLedger {
  private readonly f: typeof fetch;
  private readonly feePayers: string[];
  private readonly windowSec: number;
  private readonly auditWindowSec: number;
  private readonly timeoutMs: number;
  /** Confirmed groups never change: remember the answer for good. */
  private readonly groupIsX402 = new Map<string, boolean>();
  private cache: { at: number; report: Promise<ActivityReport> } | null = null;

  constructor(private readonly o: ActivityOptions, private readonly ttlMs = 60_000, private readonly now: () => number = Date.now) {
    this.f = o.fetchImpl ?? fetch;
    this.feePayers = o.feePayers ?? GOPLAUSIBLE_FEE_PAYERS;
    this.windowSec = o.pairWindowSec ?? 300;
    this.auditWindowSec = o.auditPairWindowSec ?? Math.max(this.windowSec, 900);
    this.timeoutMs = o.timeoutMs ?? 8000;
  }

  /** Cached for `ttlMs`; a failed read is not cached. */
  get(): Promise<ActivityReport> {
    const t = this.now();
    if (this.cache && t - this.cache.at < this.ttlMs) return this.cache.report;
    const report = this.build();
    this.cache = { at: t, report };
    report.catch(() => {
      if (this.cache?.report === report) this.cache = null;
    });
    return report;
  }

  private isVerdict(t: Transfer): boolean {
    return this.o.verdictPriceAtomic !== undefined && t.amount === this.o.verdictPriceAtomic;
  }

  /** Could be a /v1/buy (seller price + fee, or the seller price alone for a first purchase at cost); decided after pairing. */
  private mayBeBuy(t: Transfer): boolean {
    return this.o.buyFeeAtomic !== undefined && t.amount > 0n;
  }

  private async isX402Group(t: Transfer): Promise<boolean> {
    const key = `${t.round}:${t.group}`;
    const known = this.groupIsX402.get(key);
    if (known !== undefined) return known;
    const q = new URLSearchParams({ "group-id": t.group!, round: String(t.round) });
    const body = (await getJson(this.f, `${this.o.indexerUrl}/v2/transactions?${q}`, this.timeoutMs)) as { transactions?: IndexerTxn[] };
    if (!Array.isArray(body.transactions)) throw new Error("indexer: malformed group response");
    const ok =
      body.transactions.some((x) => x.id === t.tx) &&
      body.transactions.some((x) => x["tx-type"] === "pay" && this.feePayers.includes(x.sender));
    this.groupIsX402.set(key, ok);
    return ok;
  }

  private async build(): Promise<ActivityReport> {
    const { payTo, payer, asaId, indexerUrl } = this.o;
    const trialPayer = this.o.trialPayer;
    const own = new Set([payTo, payer, ...(trialPayer ? [trialPayer] : [])]);
    const base = { indexerUrl, asaId, timeoutMs: this.timeoutMs, f: this.f };
    const [incoming, outgoing, baseRead, trialOut] = await Promise.all([
      usdcTransfers({ ...base, address: payTo }),
      usdcTransfers({ ...base, address: payer }),
      this.o.base ? this.o.base.read().then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, detail: String((e as Error).message ?? e).slice(0, 200) })) : undefined,
      trialPayer ? usdcTransfers({ ...base, address: trialPayer }) : Promise.resolve([] as Transfer[]),
    ]);
    const b = this.o.base;
    const baseOwn = new Set(b ? [b.payTo.toLowerCase()] : []);
    const isOwn = (t: Transfer) => (t.chain === "base" ? baseOwn.has(t.sender.toLowerCase()) : own.has(t.sender));
    const trials = trialOut.filter((t) => t.sender === trialPayer && !own.has(t.receiver) && t.amount > 0n);

    let customers: Transfer[] = [];
    const notCounted: NotCounted[] = [];
    for (const t of incoming) {
      if (t.receiver !== payTo || t.amount <= 0n) continue; // outgoing, or a 0-amount opt-in
      if (this.o.priceAtomic !== undefined && t.amount < this.o.priceAtomic && !this.isVerdict(t) && !this.mayBeBuy(t)) {
        notCounted.push({ tx: t.tx, round: t.round, reason: "below_price" });
      } else if (t.inner) {
        notCounted.push({ tx: t.tx, round: t.round, reason: "inner_transaction" });
      } else if (!t.group) {
        notCounted.push({ tx: t.tx, round: t.round, reason: "not_in_a_group" });
      } else if (await this.isX402Group(t)) {
        customers.push(t);
      } else {
        notCounted.push({ tx: t.tx, round: t.round, reason: "no_x402_facilitator_in_group" });
      }
    }
    if (b && baseRead?.ok) {
      for (const n of baseRead.r.notCounted) notCounted.push({ tx: n.tx, round: n.block, reason: n.reason, network: b.network });
      for (const p of baseRead.r.payments) {
        const t: Transfer = { tx: p.tx, sender: p.customer, receiver: b.payTo, amount: p.amount, round: p.block, offset: p.logIndex, time: p.time, chain: "base" };
        if (this.o.priceAtomic !== undefined && t.amount < this.o.priceAtomic && !this.isVerdict(t) && !this.mayBeBuy(t)) {
          notCounted.push({ tx: t.tx, round: t.round, reason: "below_price", network: b.network });
        } else customers.push(t);
      }
    }
    const payouts = outgoing.filter((t) => t.sender === payer && !own.has(t.receiver) && t.amount > 0n);

    customers.sort((a, b) => (before(a, b) ? -1 : 1));
    payouts.sort((a, b) => (before(a, b) ? -1 : 1));
    const kindOf = (c: Transfer): ActivityRow["kind"] => {
      if (this.o.priceAtomic !== undefined && c.amount < this.o.priceAtomic) return this.isVerdict(c) ? "verdict" : "buy";
      return this.o.auditPriceAtomic !== undefined && c.amount >= this.o.auditPriceAtomic ? "audit" : "check";
    };
    const isAudit = (c: Transfer) => kindOf(c) === "audit";
    const room = (c: Transfer) => ({ audit: this.o.auditMaxTargets ?? 10, check: 1, buy: 1, verdict: 0 })[kindOf(c)];
    const windowOf = (c: Transfer) => (isAudit(c) ? this.auditWindowSec : this.windowSec);
    // A purchase below the check price paid the seller's price + fee: its seller payment is at most (payment - fee).
    // A first purchase at cost (no fee) paid exactly the seller's price: its seller payment equals the payment.
    const atCost = (c: Transfer, p: Transfer) => this.o.buyFeeAtomic !== undefined && c.amount === p.amount;
    const fits = (c: Transfer, p: Transfer) => kindOf(c) !== "buy" || c.amount - (this.o.buyFeeAtomic ?? 0n) >= p.amount || atCost(c, p);
    // A payment of exactly the /v1/verdict price is a lookup, unless a seller payment of the same amount pairs with it:
    // then it was a first purchase at cost of a seller priced like a lookup.
    const roomFor = (c: Transfer, p: Transfer) => (kindOf(c) === "verdict" && atCost(c, p) ? 1 : room(c));
    const pairedWith = new Map<string, Transfer[]>();
    const unmatched: Transfer[] = [];
    // Among the eligible customer payments (earlier, in the window, with room), the latest one of the
    // best rank: a purchase whose (payment - fee) is exactly this seller payment (that is what /v1/buy
    // pays), or a first purchase at cost whose payment is exactly it (no fee), then a check or an audit,
    // then any other purchase it fits (and a /v1/verdict-priced payment at cost). So a check's seller payment is
    // not taken by a purchase that does not match it exactly, and a purchase's own seller payment is not
    // taken by an earlier check that still has room.
    const rank = (c: Transfer, p: Transfer) => {
      const k = kindOf(c);
      if (k === "buy" && (c.amount - (this.o.buyFeeAtomic ?? 0n) === p.amount || atCost(c, p))) return 0;
      return k === "check" || k === "audit" ? 1 : 2;
    };
    for (const p of payouts) {
      let pick: Transfer | undefined;
      let best = Infinity;
      for (const c of customers) {
        if (!before(c, p)) continue; // sorted, but Base and Algorand payments are ordered by different clocks
        if (p.time - c.time > windowOf(c) || (pairedWith.get(c.tx)?.length ?? 0) >= roomFor(c, p) || !fits(c, p)) continue;
        const r = rank(c, p);
        if (r <= best) {
          best = r;
          pick = c; // the latest of the best rank
        }
      }
      if (pick) pairedWith.set(pick.tx, [...(pairedWith.get(pick.tx) ?? []), p]);
      else unmatched.push(p);
    }
    // A payment below the check price that no seller payment proves to be a purchase is not a customer.
    customers = customers.filter((c) => {
      if (kindOf(c) !== "buy" || pairedWith.has(c.tx)) return true;
      notCounted.push({ tx: c.tx, round: c.round, reason: "below_price", ...(c.chain === "base" && b ? { network: b.network } : {}) });
      return false;
    });
    const sp = (p: Transfer): SellerPayment => ({ seller: p.receiver, tx: p.tx, round: p.round, amountUsdc: atomicToUsdc(p.amount) });

    const rows: ActivityRow[] = customers
      .map((c) => {
        const ps = pairedWith.get(c.tx) ?? [];
        const p = ps[0];
        return {
          kind: kindOf(c) === "verdict" && ps.length ? ("buy" as const) : kindOf(c),
          ...(c.chain === "base" && b ? { network: b.network } : {}),
          time: iso(c.time),
          round: c.round,
          customer: c.sender,
          customerTx: c.tx,
          amountUsdc: atomicToUsdc(c.amount),
          operatorTest: isOwn(c),
          seller: p?.receiver ?? null,
          sellerTx: p?.tx ?? null,
          sellerRound: p?.round ?? null,
          sellerAmountUsdc: p ? atomicToUsdc(p.amount) : null,
          sellerPayments: ps.map(sp),
        };
      })
      .reverse();

    const real = customers.filter((c) => !isOwn(c));
    const ops = customers.filter((c) => isOwn(c));
    // Headline: seller payments made for paying customers only; operator tests are reported with operatorTests.
    const matched = real.flatMap((c) => pairedWith.get(c.tx) ?? []);
    const opPayouts = ops.flatMap((c) => pairedWith.get(c.tx) ?? []);
    const realAudits = real.filter(isAudit);
    const auditPayouts = realAudits.flatMap((c) => pairedWith.get(c.tx) ?? []);
    const sum = (ts: Transfer[]) => atomicToUsdc(ts.reduce((s, t) => s + t.amount, 0n));
    const realBase = real.filter((c) => c.chain === "base");
    const baseSide: BaseActivity | undefined = !b
      ? undefined
      : baseRead?.ok
        ? {
            status: "counted",
            network: b.network,
            payTo: b.payTo,
            usdc: b.usdc,
            explorer: b.explorerUrl,
            facilitatorSigners: b.signers,
            customers: { addresses: new Set(realBase.map((c) => c.sender)).size, payments: realBase.length, usdc: sum(realBase) },
          }
        : { status: "not_counted", network: b.network, payTo: b.payTo, explorer: b.explorerUrl, detail: baseRead && !baseRead.ok ? baseRead.detail : "not read" };
    const baseMethod = !b
      ? []
      : [
          `Base (${b.network}) customer payment = USDC (${b.usdc}) sent to ${b.payTo} by a transaction that the x402 facilitator's EVM signer (${b.signers.join(", ")}) sent to the USDC contract, with USDC's AuthorizationUsed (EIP-3009) for the same payer. Proven from each receipt on a public RPC; plain transfers to that address are not counted. Such a customer is paired with the Algorand seller payment by time.`,
          ...(baseSide?.status === "not_counted" ? [`Base payments are NOT counted in this report (the Base explorer or RPC could not be read: ${baseSide.detail}). Seller payments made for Base customers may show as unmatched.`] : []),
        ];
    return {
      network: this.o.networkName,
      asaId,
      payTo,
      payer,
      feePayers: this.feePayers,
      indexer: indexerUrl,
      generatedAt: new Date(this.now()).toISOString(),
      totals: {
        customers: { addresses: new Set(real.map((c) => c.sender)).size, payments: real.length, usdc: sum(real) },
        operatorTests: { payments: ops.length, usdc: sum(ops), sellerPayments: opPayouts.length, sellerUsdc: sum(opPayouts) },
        sellerPayments: { payments: matched.length, usdc: sum(matched), unmatched: unmatched.length, unmatchedUsdc: sum(unmatched) },
        audits: { payments: realAudits.length, sellerPayments: auditPayouts.length, sellerUsdc: sum(auditPayouts) },
        ...(trialPayer ? { trials: { payments: trials.length, usdc: sum(trials), wallet: trialPayer } } : {}),
      },
      ...(baseSide ? { base: baseSide } : {}),
      rows,
      unmatchedPayouts: [...unmatched].reverse().map((p) => ({ time: iso(p.time), round: p.round, seller: p.receiver, tx: p.tx, amountUsdc: atomicToUsdc(p.amount) })),
      notCounted: notCounted.sort((a, b) => b.round - a.round),
      method: [
        `Customer payment = USDC (ASA ${asaId}) sent to payTo inside an atomic group that also holds a transaction from the x402 facilitator fee payer (${this.feePayers.join(", ")}). Other deposits to payTo are not counted.`,
        "Operator test = the customer is vet402's own payTo or payer wallet. Not counted as a customer.",
        `A payment smaller than the check price${this.o.priceAtomic !== undefined ? ` (${atomicToUsdc(this.o.priceAtomic)} USDC)` : ""} counts only as a /v1/verdict lookup (exactly ${this.o.verdictPriceAtomic !== undefined ? atomicToUsdc(this.o.verdictPriceAtomic) : "its"} USDC; it takes no seller payment) or as a /v1/buy purchase that is paired with a seller payment of at most (payment - ${this.o.buyFeeAtomic !== undefined ? atomicToUsdc(this.o.buyFeeAtomic) : "fee"} USDC fee), or of exactly the payment (a first purchase at cost, no fee; this includes a payment of the /v1/verdict price that pairs with a seller payment of the same amount). Any other small payment is listed as below_price and is not counted. When several customer payments could take a seller payment, a purchase whose payment minus the fee equals the seller payment, or a purchase at cost whose payment equals it, comes first, then a check or an audit, then a purchase the seller payment merely fits (a /v1/verdict-priced payment at cost comes last).`,
        `Seller payment = USDC sent by the payer wallet to any address that is not vet402's own. It is matched to the most recent earlier customer payment that still has room: a check or a purchase (/v1/buy, whose price is the seller's price + vet402's fee) has room for one seller payment (within ${this.windowSec} s)${
          this.o.auditPriceAtomic !== undefined
            ? `; a seller audit (a customer payment of at least ${atomicToUsdc(this.o.auditPriceAtomic)} USDC) has room for up to ${this.o.auditMaxTargets ?? 10} (within ${this.auditWindowSec} s), because one audit buys several of the seller's resources`
            : ""
        }. Otherwise it is listed as unmatched.`,
        "An audit is one customer payment and one row; its seller payments are listed under it. Customer counts never include them twice.",
        "A customer payment with no seller payment means vet402 refused before paying the seller (for example price over cap or payment failure at the seller).",
        ...baseMethod,
        ...(trialPayer ? [`Free trials (/try) are paid from a separate trial wallet (${trialPayer}). They are listed as trials only: never as customers, customer payments or seller payments above.`] : []),
      ],
    };
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export function explorer(network: NetworkName) {
  return network === "mainnet"
    ? { tx: (id: string) => `https://allo.info/tx/${id}`, addr: (a: string) => `https://allo.info/account/${a}` }
    : { tx: (id: string) => `https://lora.algokit.io/testnet/transaction/${id}`, addr: (a: string) => `https://lora.algokit.io/testnet/account/${a}` };
}

export function activityHtml(r: ActivityReport): string {
  const x = explorer(r.network);
  const addr = (a: string) => `<a href="${esc(x.addr(a))}" title="${esc(a)}"><code>${esc(shortAddr(a))}</code></a>`;
  const tx = (id: string) => `<a href="${esc(x.tx(id))}" title="${esc(id)}"><code>${esc(id.slice(0, 10))}…</code></a>`;
  const bx = r.base?.explorer;
  const baseAddr = (a: string) => (bx ? `<a href="${esc(`${bx}/address/${a}`)}" title="${esc(a)}"><code>${esc(shortAddr(a))}</code></a>` : `<code>${esc(shortAddr(a))}</code>`);
  const baseTx = (id: string) => (bx ? `<a href="${esc(`${bx}/tx/${id}`)}" title="${esc(id)}"><code>${esc(id.slice(0, 10))}…</code></a>` : `<code>${esc(id.slice(0, 10))}…</code>`);
  const when = (t: string) => esc(t.replace("T", " ").replace("Z", ""));
  const rows = r.rows
    .map((w) => {
      const cls = w.operatorTest ? ' class="op"' : "";
      const onBase = w.network !== undefined;
      const who = `<td>${onBase ? baseAddr(w.customer) : addr(w.customer)}${w.operatorTest ? ' <span class="tag">operator test</span>' : ""}${w.kind !== "check" ? ` <span class="tag">${w.kind}</span>` : ""}${onBase ? ' <span class="tag">paid on Base</span>' : ""}</td>`;
      const head = `<tr${cls}><td>${when(w.time)}</td>${who}<td>${onBase ? baseTx(w.customerTx) : tx(w.customerTx)}</td><td class="n">${esc(w.amountUsdc)}</td>`;
      const ps = w.sellerPayments ?? [];
      if (w.kind !== "audit" || ps.length === 0) {
        return `${head}<td>${w.seller ? addr(w.seller) : `<span class="muted">${w.kind === "verdict" ? "none (lookup)" : "not paid"}</span>`}</td><td>${w.sellerTx ? tx(w.sellerTx) : "—"}</td><td class="n">${w.sellerAmountUsdc ? esc(w.sellerAmountUsdc) : "—"}</td></tr>`;
      }
      // One customer payment, several seller payments: one row for the audit, one indented line per seller payment.
      const sub = ps
        .map((p) => `<tr class="sub${w.operatorTest ? " op" : ""}"><td></td><td colspan="3" class="muted">↳ same audit</td><td>${addr(p.seller)}</td><td>${tx(p.tx)}</td><td class="n">${esc(p.amountUsdc)}</td></tr>`)
        .join("");
      return `${head}<td colspan="3" class="muted">${ps.length} seller payment(s) for this one audit ↓</td></tr>${sub}`;
    })
    .join("\n");
  const unmatched = r.unmatchedPayouts.length
    ? `<h2>Seller payments with no matching customer payment</h2><table><thead><tr><th>time (UTC)</th><th>seller</th><th>tx</th><th class="n">USDC</th></tr></thead><tbody>${r.unmatchedPayouts
        .map((p) => `<tr><td>${esc(p.time.replace("T", " ").replace("Z", ""))}</td><td>${addr(p.seller)}</td><td>${tx(p.tx)}</td><td class="n">${esc(p.amountUsdc)}</td></tr>`)
        .join("")}</tbody></table>`
    : "";
  const t = r.totals;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>vet402 activity</title>
<meta name="description" content="Every x402 payment vet402 received on Algorand and the payment it then made to the seller, read live from the indexer.">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<style>
:root{--fg:#111;--bg:#fff;--muted:#666;--line:#ddd;--op:#f6f6f6;--code:#f3f3f3;--a:#0645ad}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#111;--muted:#999;--line:#333;--op:#1b1b1b;--code:#222;--a:#8ab4f8}}
body{font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 16px;color:var(--fg);background:var(--bg)}
a{color:var(--a)}code{background:var(--code);padding:1px 4px;border-radius:3px;font-size:13px}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:760px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;white-space:nowrap}
th{font-weight:600}.n{text-align:right;font-variant-numeric:tabular-nums}
tr.op td{background:var(--op)}tr.sub td{border-bottom-style:dotted;font-size:14px}.tag{font-size:12px;border:1px solid var(--muted);border-radius:3px;padding:0 4px;color:var(--muted)}
.muted,small{color:var(--muted)}ul{padding-left:20px}
.stats{display:flex;gap:24px;flex-wrap:wrap;margin:16px 0}.stats div{min-width:150px}.stats b{display:block;font-size:22px}
</style></head><body>
<h1>vet402 activity</h1>
<p>Every x402 payment vet402 received on Algorand ${esc(r.network)}, next to the payment vet402 then made to the seller. Read live from the Algorand indexer; each tx id links to an explorer so you can check it on-chain.</p>
<div class="stats">
<div><b>${t.customers.addresses}</b>paying customers<br><small>distinct addresses, operator excluded</small></div>
<div><b>${t.customers.payments}</b>customer payments<br><small>${esc(t.customers.usdc)} USDC</small></div>
<div><b>${t.sellerPayments.payments}</b>payments to sellers<br><small>${esc(t.sellerPayments.usdc)} USDC${t.audits.payments ? `; ${t.audits.sellerPayments} of them inside ${t.audits.payments} audit(s)` : ""}</small></div>
<div><b>${t.operatorTests.payments}</b>operator tests<br><small>${esc(t.operatorTests.usdc)} USDC, not counted</small></div>
${r.base?.status === "counted" ? `<div><b>${r.base.customers.payments}</b>of them paid on Base<br><small>${esc(r.base.customers.usdc)} USDC to ${baseAddr(r.base.payTo)}</small></div>` : ""}
${t.trials ? `<div><b>${t.trials.payments}</b>free trials<br><small>${esc(t.trials.usdc)} USDC paid by vet402 (<a href="/try/log">log</a>), not customers</small></div>` : ""}
</div>
${r.base?.status === "not_counted" ? `<p><b>Base payments: not counted.</b> Customers may also pay vet402 in USDC on Base (${esc(r.base.network)}), but the Base explorer or RPC could not be read just now (${esc(r.base.detail)}), so those payments are missing from every number on this page. Payments to sellers made for them may show as unmatched.</p>` : ""}
<div class="wrap"><table>
<thead><tr><th>time (UTC)</th><th>customer</th><th>customer tx</th><th class="n">USDC</th><th>seller</th><th>seller tx</th><th class="n">USDC</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="7" class="muted">No x402 payments yet.</td></tr>'}
</tbody></table></div>
${unmatched}
<h2>How rows are counted</h2>
<ul>${r.method.map((m) => `<li>${esc(m)}</li>`).join("")}<li>${r.notCounted.length} other USDC deposit(s) to payTo are not x402 settlements and are not listed (tx ids in <a href="/activity.json">/activity.json</a>).</li></ul>
<p class="muted">payTo ${addr(r.payTo)} · payer ${addr(r.payer)} · USDC ASA ${esc(r.asaId)} · indexer <code>${esc(r.indexer)}</code> · generated ${esc(r.generatedAt)} (cached up to 60 s) · <a href="/activity.json">JSON</a> · <a href="/">vet402</a></p>
</body></html>`;
}
