/**
 * Seller audit: `GET /v1/audit?seller=<host or payTo address>`.
 *
 * A seller pays once and vet402 buys each of the seller's listed resources with
 * its own wallet (a stranger's wallet, from the seller's point of view), then
 * judges every delivery against what that resource declared.
 *
 *   planAudit  free, before any payment: list the seller's resources from the
 *              Bazaar, decide exactly which ones will be bought and which not
 *              (and why), within the audit budget and target limit.
 *   runAudit   after the customer's payment has settled: buy the planned targets
 *              one by one through the normal probe(). Every guard of probe()
 *              applies (per-call cap before any signature, daily cap from the
 *              chain, self-dealing, private addresses). When the audit budget or
 *              the daily cap is hit, the rest is not paid and is reported as SKIPPED.
 *
 * Never more payments than the plan: a target planned as "read the price only"
 * (listed above the per-call cap) gets a guard that refuses every reservation, a
 * target whose live payTo differs from the planned one is refused before signing
 * (payto_changed), and the number of paid targets never exceeds `maxPayments`
 * (the `paying` the buyer was shown before paying).
 */
import { atomicToUsdc, usdcToAtomic, type AppConfig } from "./config.js";
import { selectAccept, type AcceptLike } from "./declaration.js";
import { buildRequest, isOwnHost, withInput, OWN_HOSTS, type BazaarItem } from "./bazaar.js";
import { checkTarget } from "./target.js";
import { probe, type ProbeDeps, type ProbeResult } from "./probe.js";
import type { GuardDecision, SpendGuard } from "./spend.js";
import { displayClass } from "./board.js";

export type SellerRef = { kind: "host"; host: string; raw: string } | { kind: "payTo"; address: string; raw: string };

const ALGORAND_ADDRESS = /^[A-Z2-7]{58}$/;

/** `seller` is an Algorand address (payTo) or a host ("api.example.com", "localhost:4031", or a URL). */
export function parseSeller(raw: string | undefined): SellerRef | null {
  const s = (raw ?? "").trim();
  if (!s || s.length > 300) return null;
  if (ALGORAND_ADDRESS.test(s)) return { kind: "payTo", address: s, raw: s };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.username || u.password || !u.hostname) return null;
  return { kind: "host", host: u.host.toLowerCase(), raw: s };
}

/** Accepts of `item` that belong to the seller and that vet402 can pay (exact, our network, our USDC). */
function sellerAccept(item: BazaarItem, ref: SellerRef, cfg: AppConfig): AcceptLike | undefined {
  if (!item || typeof item.resourceUrl !== "string" || !Array.isArray(item.accepts)) return undefined;
  if (ref.kind === "host") {
    let u: URL;
    try {
      u = new URL(item.resourceUrl);
    } catch {
      return undefined;
    }
    const host = u.host.toLowerCase();
    if (host !== ref.host && u.hostname.toLowerCase() !== ref.host) return undefined;
    return selectAccept(item.accepts, cfg.network, cfg.usdcAsaId);
  }
  return selectAccept(
    item.accepts.filter((a) => a && a.payTo === ref.address),
    cfg.network,
    cfg.usdcAsaId,
  );
}

export interface AuditTarget {
  resourceUrl: string;
  /** The request vet402 sends: the seller's own example input from the Bazaar. */
  url: string;
  method: "GET" | "POST";
  body?: string;
  contentType?: string;
  input: string;
  payTo: string;
  listedPriceUsdc: string;
  description?: string;
  /** false = listed price is above vet402's per-call cap: vet402 reads the 402 and refuses without paying. */
  willPay: boolean;
}

export type NotCheckedReason =
  | "method_not_probed"
  | "path_params"
  | "body_not_json"
  | "body_too_large"
  | "bad_url"
  | "invalid_target"
  | "own_host"
  | "own_wallet"
  | "duplicate"
  | "over_target_limit"
  | "over_audit_budget"
  | "over_daily_headroom";

export interface NotChecked {
  resourceUrl: string;
  method: string;
  reason: NotCheckedReason;
  listedPriceUsdc?: string;
  detail?: string;
}

export interface AuditPlan {
  seller: string;
  network: string;
  /** Resources the Bazaar lists for this seller on this network in USDC. */
  found: number;
  /** Resources vet402 will look at after payment (willPay + over-cap). */
  checking: number;
  /** Of those, how many vet402 expects to pay for. */
  paying: number;
  /** Sum of listed prices of the targets vet402 expects to pay for. */
  plannedSpendUsdc: string;
  auditBudgetUsdc: string;
  maxTargets: number;
  priceUsdc: string;
  targets: AuditTarget[];
  notChecked: { total: number; counts: Partial<Record<NotCheckedReason, number>>; items: NotChecked[] };
  note: string;
}

export type PlanOutcome = { ok: true; plan: AuditPlan } | { ok: false; status: 400 | 404 | 422; body: Record<string, unknown> };

export interface PlanOptions {
  cfg: AppConfig;
  ownAddresses: string[];
  ownHosts?: string[];
  resolveHost?: (host: string) => Promise<string[]>;
  /** Today's remaining daily cap (atomic USDC). Planned spend never exceeds it. */
  headroomAtomic?: bigint;
}

const LISTED_NOT_CHECKED = 50;

/** Free: which of the seller's resources one audit will buy, and which it will not (with the reason). */
export async function planAudit(sellerRaw: string | undefined, items: BazaarItem[], o: PlanOptions): Promise<PlanOutcome> {
  const { cfg } = o;
  const ref = parseSeller(sellerRaw);
  if (!ref) {
    return { ok: false, status: 400, body: { error: "invalid_seller", detail: "seller must be a host (api.example.com) or an Algorand payTo address" } };
  }
  const own = new Set(o.ownAddresses.filter(Boolean));
  const ownHosts = o.ownHosts ?? OWN_HOSTS;
  if (ref.kind === "payTo" && own.has(ref.address)) {
    return { ok: false, status: 400, body: { error: "self_dealing", seller: ref.raw, detail: "this is a vet402 wallet; vet402 never pays itself" } };
  }
  if (ref.kind === "host" && isOwnHost(ref.host.replace(/:\d+$/, ""), ownHosts)) {
    return { ok: false, status: 400, body: { error: "self_dealing", seller: ref.raw, detail: "this is a vet402 host; vet402 never pays itself" } };
  }

  const matched: { item: BazaarItem; accept: AcceptLike }[] = [];
  for (const item of items) {
    const accept = sellerAccept(item, ref, cfg);
    if (accept) matched.push({ item, accept });
  }
  if (matched.length === 0) {
    return {
      ok: false,
      status: 404,
      body: {
        error: "seller_not_found",
        seller: ref.raw,
        network: cfg.network,
        detail: `the Bazaar lists no resource of this seller that is paid in USDC (ASA ${cfg.usdcAsaId}) on ${cfg.network}. Nothing was charged.`,
      },
    };
  }

  // Most-bought first (what buyers actually use), then cheapest, then by URL: deterministic.
  matched.sort(
    (a, b) =>
      (b.item.settleCount ?? 0) - (a.item.settleCount ?? 0) ||
      (BigInt(a.accept.amount) < BigInt(b.accept.amount) ? -1 : BigInt(a.accept.amount) > BigInt(b.accept.amount) ? 1 : 0) ||
      a.item.resourceUrl.localeCompare(b.item.resourceUrl),
  );

  const budget = cfg.auditMaxSpendAtomic;
  const limit = o.headroomAtomic !== undefined && o.headroomAtomic < budget ? o.headroomAtomic : budget;
  const dns = new Map<string, Promise<string[]>>();
  const resolve = o.resolveHost ? (h: string) => dns.get(h) ?? (dns.set(h, o.resolveHost!(h)), dns.get(h)!) : undefined;
  const targets: AuditTarget[] = [];
  const notChecked: NotChecked[] = [];
  const seen = new Set<string>();
  let planned = 0n;

  for (const { item, accept } of matched) {
    const price = BigInt(accept.amount);
    const listedPriceUsdc = atomicToUsdc(price);
    const method = String(item.discoveryInfo?.input?.method ?? item.method ?? "GET").toUpperCase();
    const skip = (reason: NotCheckedReason, detail?: string) =>
      notChecked.push({ resourceUrl: item.resourceUrl, method, reason, listedPriceUsdc, ...(detail ? { detail } : {}) });

    const b = buildRequest(item);
    if (!b.ok) {
      skip(b.reason as NotCheckedReason);
      continue;
    }
    if (own.has(accept.payTo)) {
      skip("own_wallet");
      continue;
    }
    if (isOwnHost(new URL(b.url).hostname, ownHosts)) {
      skip("own_host");
      continue;
    }
    const key = `${b.method} ${b.url}`;
    if (seen.has(key)) {
      skip("duplicate");
      continue;
    }
    seen.add(key);
    if (targets.length >= cfg.auditMaxTargets) {
      skip("over_target_limit", `one audit checks at most ${cfg.auditMaxTargets} resources`);
      continue;
    }
    const t = await checkTarget(b.url, cfg.allowPrivateTargets, resolve);
    if (!t.ok) {
      skip("invalid_target", t.detail);
      continue;
    }
    const target: AuditTarget = {
      resourceUrl: item.resourceUrl,
      url: b.url,
      method: b.method,
      ...(b.body !== undefined ? { body: b.body, contentType: b.contentType } : {}),
      input: b.input,
      payTo: accept.payTo,
      listedPriceUsdc,
      ...(item.description ? { description: item.description.slice(0, 200) } : {}),
      willPay: true,
    };
    if (price > cfg.maxPerCallAtomic) {
      // Still worth a look: vet402 reads the 402 and refuses before any signature (price_over_cap).
      targets.push({ ...target, willPay: false });
      continue;
    }
    if (planned + price > limit) {
      skip(
        limit < budget && planned + price <= budget ? "over_daily_headroom" : "over_audit_budget",
        `planned ${atomicToUsdc(planned)} + ${listedPriceUsdc} USDC > ${atomicToUsdc(limit)} USDC`,
      );
      continue;
    }
    planned += price;
    targets.push(target);
  }

  const counts: Partial<Record<NotCheckedReason, number>> = {};
  for (const n of notChecked) counts[n.reason] = (counts[n.reason] ?? 0) + 1;
  const paying = targets.filter((t) => t.willPay).length;
  const plan: AuditPlan = {
    seller: ref.raw,
    network: cfg.network,
    found: matched.length,
    checking: targets.length,
    paying,
    plannedSpendUsdc: atomicToUsdc(planned),
    auditBudgetUsdc: atomicToUsdc(budget),
    maxTargets: cfg.auditMaxTargets,
    priceUsdc: cfg.auditPriceUsdc,
    targets,
    notChecked: { total: notChecked.length, counts, items: notChecked.slice(0, LISTED_NOT_CHECKED) },
    note:
      `vet402 will check ${targets.length} of ${matched.length} listed resource(s) and expects to pay for ${paying} of them ` +
      `(${atomicToUsdc(planned)} USDC of listed prices, at most ${atomicToUsdc(budget)} USDC per audit). ` +
      `If a seller's live price differs, or the daily cap is reached, the rest is not paid and is reported as SKIPPED.`,
  };
  if (paying === 0) {
    return {
      ok: false,
      status: 422,
      body: {
        error: "nothing_to_audit",
        detail: "none of this seller's listed resources can be bought within vet402's caps and request rules. Nothing was charged.",
        ...plan,
      },
    };
  }
  return { ok: true, plan };
}

/**
 * Trim a plan to today's remaining daily cap (read only for a paid request):
 * willPay targets past the headroom move to notChecked as over_daily_headroom.
 * Only ever removes targets.
 */
export function applyHeadroom(plan: AuditPlan, headroomAtomic: bigint): AuditPlan {
  let sum = 0n;
  const targets: AuditTarget[] = [];
  const moved: NotChecked[] = [];
  for (const t of plan.targets) {
    if (!t.willPay) {
      targets.push(t);
      continue;
    }
    const price = usdcToAtomic(t.listedPriceUsdc);
    if (sum + price > headroomAtomic) {
      moved.push({ resourceUrl: t.resourceUrl, method: t.method, reason: "over_daily_headroom", listedPriceUsdc: t.listedPriceUsdc, detail: `today's remaining cap is ${atomicToUsdc(headroomAtomic)} USDC` });
      continue;
    }
    sum += price;
    targets.push(t);
  }
  if (moved.length === 0) return plan;
  const counts = { ...plan.notChecked.counts, over_daily_headroom: (plan.notChecked.counts.over_daily_headroom ?? 0) + moved.length };
  return {
    ...plan,
    targets,
    checking: targets.length,
    paying: targets.filter((t) => t.willPay).length,
    plannedSpendUsdc: atomicToUsdc(sum),
    notChecked: { total: plan.notChecked.total + moved.length, counts, items: [...moved, ...plan.notChecked.items].slice(0, LISTED_NOT_CHECKED) },
  };
}

/** For a target planned as "read the price only": every reservation is refused, so probe() never signs. */
export class ReadPriceOnlyGuard implements SpendGuard {
  async reserve(): Promise<GuardDecision> {
    return { ok: false, reason: "price_over_cap", detail: "listed above vet402's per-call cap: the audit reads the price only and never pays this one" };
  }
  release(): void {}
  commit(): void {}
  headroom() {
    return Promise.resolve({ ok: true as const, remainingAtomic: 0n });
  }
}

/**
 * Audit budget on top of the normal guard: the sum of this audit's reservations
 * never exceeds `budgetAtomic`. A price above the per-call cap is passed through
 * so probe() reports it as price_over_cap (never paid) and the audit continues.
 */
export class AuditBudgetGuard implements SpendGuard {
  private spent = 0n;
  private readonly open = new Map<string, bigint>();
  stopped: { reason: "audit_budget"; detail: string } | null = null;

  constructor(
    private readonly inner: SpendGuard,
    private readonly maxPerCallAtomic: bigint,
    private readonly budgetAtomic: bigint,
  ) {}

  get spentAtomic(): bigint {
    return this.spent;
  }
  /** Reservations that may have led to a payment (released ones are not counted). */
  reservations = 0;

  async reserve(amountAtomic: bigint): Promise<GuardDecision> {
    if (amountAtomic <= this.maxPerCallAtomic && this.spent + amountAtomic > this.budgetAtomic) {
      const detail = `audit spent ${atomicToUsdc(this.spent)} + price ${atomicToUsdc(amountAtomic)} > audit budget ${atomicToUsdc(this.budgetAtomic)} USDC`;
      this.stopped = { reason: "audit_budget", detail };
      // probe() stops before any signature on a refused reservation; the audit reports it as SKIPPED.
      return { ok: false, reason: "daily_cap_reached", detail };
    }
    const d = await this.inner.reserve(amountAtomic);
    if (d.ok) {
      this.open.set(d.reservationId, amountAtomic);
      this.spent += amountAtomic;
      this.reservations += 1;
    }
    return d;
  }
  release(id: string): void {
    this.inner.release(id);
    const a = this.open.get(id);
    if (a !== undefined) {
      this.open.delete(id);
      this.spent -= a;
      this.reservations -= 1;
    }
  }
  commit(id: string): void {
    this.inner.commit(id);
    this.open.delete(id);
  }
  headroom() {
    return this.inner.headroom();
  }
}

export type AuditClass = "delivered" | "mismatch" | "unreachable" | "unclear" | "skipped";

export interface AuditResult {
  resourceUrl: string;
  url: string;
  method: string;
  input: string;
  verdict: "ALLOW" | "REFUSE" | "SKIPPED";
  reason: string;
  class: AuditClass;
  detail?: string;
  listedPriceUsdc: string;
  price?: ProbeResult["price"];
  declared?: ProbeResult["declared"];
  delivery?: ProbeResult["delivery"];
  /** vet402 -> seller. */
  downstreamPayment?: ProbeResult["downstreamPayment"];
  /** customer -> vet402 (the one payment this audit was bought with). */
  customerTx?: string;
}

export interface AuditRun {
  results: AuditResult[];
  summary: {
    checked: number;
    delivered: number;
    mismatch: number;
    unreachable: number;
    unclear: number;
    skipped: number;
    /** Seller payments that settled in this audit. */
    sellerPayments: number;
    spentUsdc: string;
    stoppedBy?: string;
  };
}

export interface RunOptions {
  cfg: AppConfig;
  guard: SpendGuard;
  probeDeps: ProbeDeps;
  customerTx?: string;
  /** Most targets that may be paid (the `paying` shown before payment). Beyond it: SKIPPED plan_changed. */
  maxPayments?: number;
  /** Wall-clock limit for the whole audit: no target is started unless it can finish before it (SKIPPED time_limit). */
  deadlineMs?: number;
  now?: () => number;
}

const CAP_STOP: Record<string, string> = { daily_cap_reached: "daily_cap", cap_check_unavailable: "cap_check_unavailable" };

/** After the customer's payment has settled: buy each planned target once, in order. */
export async function runAudit(plan: AuditPlan, o: RunOptions): Promise<AuditRun> {
  const now = o.now ?? Date.now;
  const start = now();
  const guard = new AuditBudgetGuard(o.guard, o.cfg.maxPerCallAtomic, o.cfg.auditMaxSpendAtomic);
  const results: AuditResult[] = [];
  let stop: { reason: string; detail?: string } | null = null;
  const base = (t: AuditTarget) => ({
    resourceUrl: t.resourceUrl,
    url: t.url,
    method: t.method,
    input: t.input,
    listedPriceUsdc: t.listedPriceUsdc,
    ...(o.customerTx ? { customerTx: o.customerTx } : {}),
  });
  const skipped = (t: AuditTarget, reason: string, detail?: string): AuditResult => ({
    ...base(t),
    verdict: "SKIPPED",
    reason,
    class: "skipped",
    ...(detail ? { detail } : {}),
  });

  for (const t of plan.targets) {
    if (stop) {
      results.push(skipped(t, stop.reason));
      continue;
    }
    // Worst case of one target: unpaid look + paid request (each capped by probeTimeoutMs) + indexer read.
    const worstMs = 2 * o.cfg.probeTimeoutMs + 10_000;
    if (o.deadlineMs !== undefined && now() - start + worstMs > o.deadlineMs) {
      stop = { reason: "time_limit", detail: `audit ran longer than ${o.deadlineMs} ms` };
      results.push(skipped(t, stop.reason, stop.detail));
      continue;
    }
    if (t.willPay && o.maxPayments !== undefined && guard.reservations >= o.maxPayments) {
      results.push(skipped(t, "plan_changed", `the plan shown before payment paid for ${o.maxPayments} resource(s); this one is beyond it`));
      continue;
    }
    // Lock the payment to the planned payTo: a different payTo is refused before any signature.
    let payToChanged: string | null = null;
    const deps = withInput(o.probeDeps, t);
    const locked: ProbeDeps = {
      ...deps,
      paidFetch: async (url, approved, init) => {
        if (approved.payTo !== t.payTo) {
          payToChanged = approved.payTo;
          throw Object.assign(new Error("payTo changed since the plan"), { signed: false });
        }
        return deps.paidFetch(url, approved, init);
      },
    };
    let r: ProbeResult;
    try {
      r = await probe(t.url, o.cfg, t.willPay ? guard : new ReadPriceOnlyGuard(), locked);
    } catch (e) {
      r = { verdict: "REFUSE", reason: "probe_error", target: t.url, detail: String((e as Error).message ?? e).slice(0, 200) };
    }
    if (payToChanged) {
      results.push({
        ...base(t),
        verdict: "REFUSE",
        reason: "payto_changed",
        class: "unclear",
        detail: `planned payTo ${t.payTo}, the live 402 asks for ${payToChanged}: not paid`,
        ...(r.price ? { price: r.price } : {}),
        ...(r.declared ? { declared: r.declared } : {}),
      });
      continue;
    }
    if (!t.willPay && r.reason === "price_over_cap" && r.price && BigInt(r.price.amountAtomic) <= o.cfg.maxPerCallAtomic) {
      // Listed above the cap, now within it: not in the paid plan, so still not paid.
      results.push({ ...skipped(t, "plan_changed", `listed at ${t.listedPriceUsdc} USDC (above the per-call cap), now ${r.price.usdc}: not in the paid plan`), price: r.price });
      continue;
    }
    if (guard.stopped) {
      stop = guard.stopped;
      results.push({ ...skipped(t, stop.reason, stop.detail), ...(r.price ? { price: r.price } : {}) });
      continue;
    }
    const capStop = CAP_STOP[r.reason];
    if (capStop) {
      stop = { reason: capStop, detail: r.detail };
      results.push({ ...skipped(t, capStop, r.detail), ...(r.price ? { price: r.price } : {}) });
      continue;
    }
    const paid = r.downstreamPayment?.success === true;
    results.push({
      ...base(t),
      verdict: r.verdict,
      reason: r.reason,
      class: displayClass({ verdict: r.verdict, reason: r.reason, detail: r.detail, paid }).toLowerCase() as AuditClass,
      ...(r.detail ? { detail: r.detail } : {}),
      ...(r.price ? { price: r.price } : {}),
      ...(r.declared ? { declared: r.declared } : {}),
      ...(r.delivery ? { delivery: r.delivery } : {}),
      ...(r.downstreamPayment ? { downstreamPayment: r.downstreamPayment } : {}),
    });
  }

  const n = (c: AuditClass) => results.filter((r) => r.class === c).length;
  const settled = results.filter((r) => r.downstreamPayment?.success === true);
  let spent = 0n;
  for (const r of settled) spent += BigInt(r.price?.amountAtomic ?? "0");
  return {
    results,
    summary: {
      checked: results.length - n("skipped"),
      delivered: n("delivered"),
      mismatch: n("mismatch"),
      unreachable: n("unreachable"),
      unclear: n("unclear"),
      skipped: n("skipped"),
      sellerPayments: settled.length,
      spentUsdc: atomicToUsdc(spent),
      ...(stop ? { stoppedBy: stop.reason } : {}),
    },
  };
}
