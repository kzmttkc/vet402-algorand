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
 * customer payment (within `pairWindowSec`) that has no seller payment yet.
 * A seller payment with no such customer payment is listed as unmatched, never hidden.
 */
import { atomicToUsdc, type NetworkName } from "./config.js";

/** Fee payer of the GoPlausible x402 facilitator (from its /supported, `extra.feePayer`). */
export const GOPLAUSIBLE_FEE_PAYERS = ["ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA"];

export interface ActivityOptions {
  networkName: NetworkName;
  indexerUrl: string;
  asaId: string;
  payTo: string;
  payer: string;
  feePayers?: string[];
  /** Max seconds between a customer payment and the seller payment it pays for. */
  pairWindowSec?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ActivityRow {
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
  reason: "not_in_a_group" | "no_x402_facilitator_in_group" | "inner_transaction";
}

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
    operatorTests: { payments: number; usdc: string };
    sellerPayments: { payments: number; usdc: string; unmatched: number };
  };
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
}

const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(".000Z", "Z");
const before = (a: Transfer, b: Transfer) => a.round < b.round || (a.round === b.round && a.offset < b.offset);

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
  private readonly timeoutMs: number;
  /** Confirmed groups never change: remember the answer for good. */
  private readonly groupIsX402 = new Map<string, boolean>();
  private cache: { at: number; report: Promise<ActivityReport> } | null = null;

  constructor(private readonly o: ActivityOptions, private readonly ttlMs = 60_000, private readonly now: () => number = Date.now) {
    this.f = o.fetchImpl ?? fetch;
    this.feePayers = o.feePayers ?? GOPLAUSIBLE_FEE_PAYERS;
    this.windowSec = o.pairWindowSec ?? 300;
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
    const own = new Set([payTo, payer]);
    const base = { indexerUrl, asaId, timeoutMs: this.timeoutMs, f: this.f };
    const [incoming, outgoing] = await Promise.all([
      usdcTransfers({ ...base, address: payTo }),
      usdcTransfers({ ...base, address: payer }),
    ]);

    const customers: Transfer[] = [];
    const notCounted: NotCounted[] = [];
    for (const t of incoming) {
      if (t.receiver !== payTo || t.amount <= 0n) continue; // outgoing, or a 0-amount opt-in
      if (t.inner) {
        notCounted.push({ tx: t.tx, round: t.round, reason: "inner_transaction" });
      } else if (!t.group) {
        notCounted.push({ tx: t.tx, round: t.round, reason: "not_in_a_group" });
      } else if (await this.isX402Group(t)) {
        customers.push(t);
      } else {
        notCounted.push({ tx: t.tx, round: t.round, reason: "no_x402_facilitator_in_group" });
      }
    }
    const payouts = outgoing.filter((t) => t.sender === payer && !own.has(t.receiver) && t.amount > 0n);

    customers.sort((a, b) => (before(a, b) ? -1 : 1));
    payouts.sort((a, b) => (before(a, b) ? -1 : 1));
    const pairedWith = new Map<string, Transfer>();
    const unmatched: Transfer[] = [];
    for (const p of payouts) {
      let pick: Transfer | undefined;
      for (const c of customers) {
        if (!before(c, p)) break;
        if (p.time - c.time > this.windowSec || pairedWith.has(c.tx)) continue;
        pick = c; // keep the latest eligible one
      }
      if (pick) pairedWith.set(pick.tx, p);
      else unmatched.push(p);
    }

    const rows: ActivityRow[] = customers
      .map((c) => {
        const p = pairedWith.get(c.tx);
        return {
          time: iso(c.time),
          round: c.round,
          customer: c.sender,
          customerTx: c.tx,
          amountUsdc: atomicToUsdc(c.amount),
          operatorTest: own.has(c.sender),
          seller: p?.receiver ?? null,
          sellerTx: p?.tx ?? null,
          sellerRound: p?.round ?? null,
          sellerAmountUsdc: p ? atomicToUsdc(p.amount) : null,
        };
      })
      .reverse();

    const real = customers.filter((c) => !own.has(c.sender));
    const ops = customers.filter((c) => own.has(c.sender));
    const sum = (ts: Transfer[]) => atomicToUsdc(ts.reduce((s, t) => s + t.amount, 0n));
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
        operatorTests: { payments: ops.length, usdc: sum(ops) },
        sellerPayments: { payments: payouts.length, usdc: sum(payouts), unmatched: unmatched.length },
      },
      rows,
      unmatchedPayouts: unmatched.reverse().map((p) => ({ time: iso(p.time), round: p.round, seller: p.receiver, tx: p.tx, amountUsdc: atomicToUsdc(p.amount) })),
      notCounted: notCounted.sort((a, b) => b.round - a.round),
      method: [
        `Customer payment = USDC (ASA ${asaId}) sent to payTo inside an atomic group that also holds a transaction from the x402 facilitator fee payer (${this.feePayers.join(", ")}). Other deposits to payTo are not counted.`,
        "Operator test = the customer is vet402's own payTo or payer wallet. Not counted as a customer.",
        `Seller payment = USDC sent by the payer wallet to any address that is not vet402's own. It is matched to the most recent earlier customer payment (within ${this.windowSec} s) that has no seller payment yet; otherwise it is listed as unmatched.`,
        "A customer payment with no seller payment means vet402 refused before paying the seller (for example price over cap or payment failure at the seller).",
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
  const rows = r.rows
    .map(
      (w) => `<tr${w.operatorTest ? ' class="op"' : ""}><td>${esc(w.time.replace("T", " ").replace("Z", ""))}</td><td>${addr(w.customer)}${w.operatorTest ? ' <span class="tag">operator test</span>' : ""}</td><td>${tx(w.customerTx)}</td><td class="n">${esc(w.amountUsdc)}</td><td>${w.seller ? addr(w.seller) : '<span class="muted">not paid</span>'}</td><td>${w.sellerTx ? tx(w.sellerTx) : "—"}</td><td class="n">${w.sellerAmountUsdc ? esc(w.sellerAmountUsdc) : "—"}</td></tr>`,
    )
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
tr.op td{background:var(--op)}.tag{font-size:12px;border:1px solid var(--muted);border-radius:3px;padding:0 4px;color:var(--muted)}
.muted,small{color:var(--muted)}ul{padding-left:20px}
.stats{display:flex;gap:24px;flex-wrap:wrap;margin:16px 0}.stats div{min-width:150px}.stats b{display:block;font-size:22px}
</style></head><body>
<h1>vet402 activity</h1>
<p>Every x402 payment vet402 received on Algorand ${esc(r.network)}, next to the payment vet402 then made to the seller. Read live from the Algorand indexer; each tx id links to an explorer so you can check it on-chain.</p>
<div class="stats">
<div><b>${t.customers.addresses}</b>paying customers<br><small>distinct addresses, operator excluded</small></div>
<div><b>${t.customers.payments}</b>customer payments<br><small>${esc(t.customers.usdc)} USDC</small></div>
<div><b>${t.sellerPayments.payments}</b>payments to sellers<br><small>${esc(t.sellerPayments.usdc)} USDC</small></div>
<div><b>${t.operatorTests.payments}</b>operator tests<br><small>${esc(t.operatorTests.usdc)} USDC, not counted</small></div>
</div>
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
