/**
 * GET|POST /v1/buy?url=<x402 URL> — vet402 buys the resource for the customer and checks it.
 *
 * /v1/check only tells the customer whether a seller delivers; the seller's content stays
 * with vet402, so a customer who wants it pays twice. /v1/buy hands it over:
 *
 *   1. unpaid request (free): vet402 reads the seller's 402 without paying and prices the
 *      purchase: the seller's price (exact / our network / USDC) + BUY_FEE_USDC. A seller
 *      vet402 will not pay (above the per-call cap, not USDC, another network, vet402's own
 *      wallet, a private address, ...) is refused here with a reason. Nothing is charged.
 *      The customer's POST body is never sent in this read (see `quote`).
 *   2. paid request: the seller's 402 is read again and the price computed again. x402 v2
 *      accepts a payment only if what the customer signed (`accepted`: amount and
 *      extra.sellerAmount / extra.sellerPayTo) deep-equals that new computation, and the
 *      facilitator verifies the signed transfer against the exact amount. So a price change
 *      between the two reads is a 402 and nothing settles.
 *   3. preflight reserves the seller's price on the daily cap, then the customer's payment
 *      SETTLES (settle-first.ts), then vet402 pays the seller through probe() with that
 *      reservation (same caps, same payTo lock), at most the seller price the customer paid for.
 *   4. the seller's response body is returned byte for byte with its content-type (any 2xx
 *      as 200, an empty body as empty), plus the verdict and both tx ids in x-vet402-* headers.
 *
 * The customer has paid from step 3 on. If the seller is then not paid (or its body is too
 * large), the answer is 502 with the reason and the customer's tx. There is no refund.
 *
 * First purchase at cost: `?payer=<Algorand address>` asks for the first-purchase price. If that
 * address has never sent USDC to vet402's payTo (read from the indexer, see `neverPaidVet402`), the
 * fee is 0 and the requirements carry extra.firstPurchase = true and extra.payer = that address. The
 * price is still decided by the server and bound into the requirements the customer signs, so a
 * changed amount, a dropped or changed `payer`, or a payer who has paid meanwhile is a 402 and nothing
 * settles; and before settling, the paying transaction's sender must be extra.payer (409 otherwise).
 */
import type { Context, Hono } from "hono";
import { x402HTTPResourceServer, type x402ResourceServer } from "@x402/core/server";
import type { HTTPRequestContext } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402-avm/extensions";
import { atomicToUsdc, type AppConfig } from "./config.js";
import type { SpendGuard } from "./spend.js";
import { MAX_BODY_BYTES, parsePaymentRequired, probeWithBody, readCapped, type ProbeDeps } from "./probe.js";
import { sameNetwork, selectAccept, type AcceptLike } from "./declaration.js";
import { checkTarget } from "./target.js";
import { buildRequest, type Catalog } from "./bazaar.js";
import { settleFirstMiddleware, type CustomerPayment, type SettleFirstEnv } from "./settle-first.js";
import { withBase } from "./base.js";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { decodeSignedTransaction } from "@x402/avm";
import { isValidAddress } from "@algorandfoundation/algokit-utils/common";

export const BUY_PATH = "/v1/buy";
/** Largest customer body vet402 forwards to the seller on POST (read no further than this). */
export const BUY_MAX_REQUEST_BYTES = 64 * 1024;
/** Unpaid seller reads (free prices) per client IP per minute. */
export const BUY_QUOTES_PER_MINUTE = 30;

export interface BuyDeps {
  payTo: string;
  guard: SpendGuard;
  /** ownAddresses must list every vet402 wallet (payTo, payer). */
  probeDeps: ProbeDeps;
  /** Bazaar listings: a POST-only seller is priced from its listed example input. */
  catalog: Catalog;
  /**
   * Has this address never paid vet402's payTo? (first purchase at cost). Omitted = no first-purchase price.
   * Throwing (indexer down) means the normal price.
   */
  firstPurchase?: (address: string) => Promise<boolean>;
  /** Tests: override the per-IP limit and the clock. */
  quotesPerMinute?: number;
  now?: () => number;
}

/** A purchase vet402 is willing to make, from the seller's 402 read now. */
export interface Quote {
  ok: true;
  target: string;
  method: "GET" | "POST";
  /** The customer's body (POST), forwarded to the seller only after the customer's payment settled. */
  body?: Uint8Array<ArrayBuffer>;
  contentType?: string;
  /** How the price was read: the seller's GET 402, or its Bazaar-listed example input (POST). */
  priceRead: "get" | "listed_example";
  /** The seller's accept vet402 would pay. */
  accept: AcceptLike;
  sellerAtomic: bigint;
  feeAtomic: bigint;
  /** What the customer pays vet402: seller price + fee. */
  customerAtomic: bigint;
}

export interface Refusal {
  ok: false;
  status: 400 | 404 | 405 | 413 | 415 | 422 | 429 | 502;
  body: { verdict: "REFUSE"; reason: string; target?: string; detail: string; charged: false; price?: Record<string, string>; offered?: unknown[] };
}

export type QuoteOutcome = Quote | Refusal;

/** Customer price for a seller price: integer atomic USDC. */
export function buyPriceAtomic(sellerAtomic: bigint, feeAtomic: bigint): bigint {
  return sellerAtomic + feeAtomic;
}

const refuse = (status: Refusal["status"], reason: string, detail: string, extra: Partial<Refusal["body"]> = {}): Refusal => ({
  ok: false,
  status,
  body: { verdict: "REFUSE", reason, detail, charged: false, ...extra },
});

const isJsonType = (ct: string | undefined) => (ct ?? "").split(";")[0].trim().toLowerCase() === "application/json";

/** Read a request body, stopping as soon as it passes `max` bytes (chunked bodies have no content-length). */
export async function readBodyCapped(stream: ReadableStream<Uint8Array> | null, max: number): Promise<{ ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false }> {
  if (!stream) return { ok: true, bytes: new Uint8Array(0) };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return { ok: false };
    }
    chunks.push(value);
  }
  return { ok: true, bytes: new Uint8Array(Buffer.concat(chunks)) };
}

const samePath = (a: string, b: string) => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return false;
  }
};

/**
 * Read the seller's 402 without paying and decide whether (and for how much) vet402 buys.
 * Runs before any customer payment has settled (free 402, paid request's price, preflight), so it
 * never sends the customer's body anywhere: that would make vet402 a free anonymous relay.
 * - GET purchase: a plain GET of the URL.
 * - POST purchase: a plain GET first; if that is not a readable 402 (a POST-only seller), a POST of
 *   the example input the seller published in the Bazaar, only for a URL listed there for POST.
 */
export async function quote(
  req: { method: string; path: string; url: string | undefined; contentType?: string; contentLength?: string; body: () => ReadableStream<Uint8Array> | null },
  cfg: AppConfig,
  deps: Pick<BuyDeps, "probeDeps" | "catalog">,
): Promise<QuoteOutcome> {
  if (req.path !== BUY_PATH) return refuse(404, "not_found", `only ${BUY_PATH} is served (got ${req.path})`);
  if (req.method !== "GET" && req.method !== "POST") {
    return refuse(405, "method_not_allowed", "use GET or POST: a HEAD purchase would deliver no body");
  }
  const target = req.url;
  if (!target) return refuse(400, "missing_url", "missing url query parameter");
  const t = await checkTarget(target, cfg.allowPrivateTargets, deps.probeDeps.resolveHost);
  if (!t.ok) return refuse(400, "invalid_target", t.detail, { target });
  const url = t.url.toString();

  let body: Uint8Array<ArrayBuffer> | undefined;
  let contentType: string | undefined;
  if (req.method === "POST") {
    if (!isJsonType(req.contentType)) return refuse(415, "unsupported_media_type", "POST body must be application/json", { target: url });
    const tooLarge = () => refuse(413, "request_too_large", `POST body above ${BUY_MAX_REQUEST_BYTES} bytes`, { target: url });
    if (Number(req.contentLength ?? 0) > BUY_MAX_REQUEST_BYTES) return tooLarge();
    const read = await readBodyCapped(req.body(), BUY_MAX_REQUEST_BYTES);
    if (!read.ok) return tooLarge();
    try {
      if (read.bytes.byteLength) JSON.parse(Buffer.from(read.bytes).toString("utf8"));
    } catch {
      return refuse(400, "invalid_json", "POST body is not valid JSON", { target: url });
    }
    body = read.bytes;
    contentType = "application/json";
  }
  const method = req.method as "GET" | "POST";

  const look = async (init: RequestInit) => {
    const res = await deps.probeDeps.fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(cfg.probeTimeoutMs), ...init });
    const text = await readCapped(res);
    return { res, parsed: res.status === 402 ? parsePaymentRequired(res, text) : null };
  };
  let seen: Awaited<ReturnType<typeof look>>;
  let priceRead: Quote["priceRead"] = "get";
  try {
    seen = await look({ method: "GET" });
    if (method === "POST" && !seen.parsed) {
      let items;
      try {
        items = await deps.catalog.items();
      } catch (e) {
        return refuse(502, "bazaar_unavailable", `cannot read the Bazaar to price a POST-only seller: ${String((e as Error).message ?? e).slice(0, 150)}`, { target: url });
      }
      const listed = items.find((i) => samePath(i.resourceUrl, url) && String(i.discoveryInfo?.input?.method ?? i.method ?? "GET").toUpperCase() === "POST");
      const built = listed ? buildRequest(listed) : null;
      if (!built || !built.ok || built.method !== "POST") {
        return refuse(422, "not_listed", "this URL does not answer a plain GET with a 402, and it is not listed in the Bazaar for POST: vet402 prices a POST-only seller from its listed example input and never sends your body before you have paid", { target: url });
      }
      seen = await look({ method: "POST", ...(built.body !== undefined ? { body: built.body, headers: { "content-type": built.contentType ?? "application/json" } } : {}) });
      priceRead = "listed_example";
    }
  } catch (e) {
    return refuse(502, "probe_error", String((e as Error).message ?? e).slice(0, 200), { target: url });
  }
  if (seen.res.status !== 402) return refuse(422, "not_x402", `expected 402, got ${seen.res.status}`, { target: url });
  const parsed = seen.parsed;
  if (!parsed || !Array.isArray(parsed.pr.accepts)) return refuse(422, "not_x402", "402 without parseable x402 payment requirements", { target: url });
  const offered = parsed.pr.accepts.map((a) => ({ scheme: a.scheme, network: a.network, asset: String(a.asset), amount: String(a.amount), payTo: a.payTo }));
  const accept = selectAccept(parsed.pr.accepts, cfg.network, cfg.usdcAsaId);
  if (!accept) {
    const onNet = parsed.pr.accepts.some((a) => sameNetwork(a.network, cfg.network));
    const why = onNet ? `no exact USDC (ASA ${cfg.usdcAsaId}) accept on ${cfg.network}` : `the seller is not paid on ${cfg.network}`;
    return refuse(422, "no_supported_accept", why, { target: url, offered });
  }
  const sellerAtomic = BigInt(accept.amount);
  const price = { amountAtomic: accept.amount, usdc: atomicToUsdc(sellerAtomic), payTo: accept.payTo };
  if (sellerAtomic <= 0n) return refuse(422, "not_x402", "the seller's price is 0: nothing to buy", { target: url, price });
  if ((deps.probeDeps.ownAddresses ?? []).includes(accept.payTo)) {
    return refuse(422, "self_dealing", "seller payTo is a vet402 wallet; vet402 never pays itself", { target: url, price });
  }
  if (sellerAtomic > cfg.maxPerCallAtomic) {
    return refuse(422, "price_over_cap", `seller price ${price.usdc} USDC is above vet402's per-call cap ${atomicToUsdc(cfg.maxPerCallAtomic)} USDC`, { target: url, price });
  }
  if (parsed.source === "body") {
    return refuse(422, "requirements_body_only", "x402 v2 requirements are in the 402 body only (no PAYMENT-REQUIRED header); the x402 paying client cannot pay this", { target: url, price });
  }
  const feeAtomic = cfg.buyFeeAtomic;
  return { ok: true, target: url, method, body, contentType, priceRead, accept, sellerAtomic, feeAtomic, customerAtomic: buyPriceAtomic(sellerAtomic, feeAtomic) };
}

/**
 * true when `address` has never sent USDC (ASA `asaId`) to `payTo`, read from the indexer (the address's
 * own USDC transfers, up to `maxPages` pages; more than that counts as "has paid", i.e. no first-purchase price).
 */
export async function neverPaidVet402(o: { indexerUrl: string; asaId: string; payTo: string; address: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxPages?: number }): Promise<boolean> {
  const f = o.fetchImpl ?? fetch;
  let next: string | undefined;
  for (let page = 0; page < (o.maxPages ?? 5); page++) {
    const q = new URLSearchParams({ "asset-id": o.asaId, "tx-type": "axfer", limit: "1000" });
    if (next) q.set("next", next);
    const res = await f(`${o.indexerUrl}/v2/accounts/${o.address}/transactions?${q}`, { signal: AbortSignal.timeout(o.timeoutMs ?? 6000) });
    if (res.status === 404) return true;
    if (!res.ok) throw new Error(`indexer ${res.status}`);
    const body = (await res.json()) as { transactions?: { sender: string; "asset-transfer-transaction"?: { receiver: string; "asset-id": number } }[]; "next-token"?: string };
    if (!Array.isArray(body.transactions)) throw new Error("indexer: malformed response");
    for (const t of body.transactions) {
      const a = t["asset-transfer-transaction"];
      if (a && t.sender === o.address && a.receiver === o.payTo && String(a["asset-id"]) === String(o.asaId)) return false;
    }
    next = body["next-token"];
    if (!next || body.transactions.length === 0) return true;
  }
  return false;
}

/**
 * Sender of the payment to `payTo` in an x402 AVM PAYMENT-SIGNATURE header, or null.
 * Not only the transaction at paymentIndex: the group must hold exactly one asset transfer to `payTo`,
 * at paymentIndex, so no other transaction in the group can be the one that actually pays.
 */
export function paymentSender(header: string | undefined, payTo?: string): string | null {
  if (!header) return null;
  try {
    const p = decodePaymentSignatureHeader(header) as { payload?: { paymentGroup?: string[]; paymentIndex?: number } };
    const g = p.payload?.paymentGroup;
    const i = p.payload?.paymentIndex ?? 0;
    if (!Array.isArray(g) || typeof g[i] !== "string") return null;
    const txns = g.map((b) => decodeSignedTransaction(b).txn);
    if (payTo !== undefined) {
      const toPayTo = txns.map((t, k) => (t.assetTransfer?.receiver?.toString() === payTo ? k : -1)).filter((k) => k >= 0);
      if (toPayTo.length !== 1 || toPayTo[0] !== i) return null;
    }
    return txns[i].sender.toString();
  } catch {
    return null;
  }
}

/** Per-IP fixed-window counter, in memory (per instance). */
export class QuoteLimiter {
  private readonly seen = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}
  take(key: string): boolean {
    const t = this.now();
    const w = this.seen.get(key);
    if (!w || t - w.start >= 60_000) {
      this.seen.delete(key);
      this.seen.set(key, { start: t, count: 1 });
      if (this.seen.size > 10_000) this.seen.delete(this.seen.keys().next().value!);
      return true;
    }
    w.count += 1;
    return w.count <= this.perMinute;
  }
}

/** Client IP as the platform reports it (Vercel sets x-real-ip / x-forwarded-for). */
function clientIp(c: Context<SettleFirstEnv>): string {
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real;
  const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || "local";
}

/** Headers of a /v1/buy answer after the customer has paid. */
function paidHeaders(verdict: string, reason: string, customer: CustomerPayment, sellerTx?: string, extra: Record<string, string> = {}) {
  return {
    "x-vet402-verdict": verdict,
    "x-vet402-reason": reason,
    "x-vet402-customer-tx": customer.transaction,
    ...(sellerTx ? { "x-vet402-seller-tx": sellerTx } : {}),
    "cache-control": "no-store",
    ...extra,
  };
}

/**
 * Mounts GET|POST /v1/buy on `app` with its own settle-first payment middleware on the shared
 * resource server (whose initialize() is shared, see shareInitialize). Passes every other request through.
 */
export function registerBuy(app: Hono<SettleFirstEnv>, cfg: AppConfig, resourceServer: x402ResourceServer, deps: BuyDeps): void {
  const limiter = new QuoteLimiter(deps.quotesPerMinute ?? BUY_QUOTES_PER_MINUTE, deps.now);

  /** One seller read per request object: the 402, the price and the preflight see the same quote. */
  const quotes = new WeakMap<Request, Promise<QuoteOutcome>>();
  const quoteFor = (c: Context<SettleFirstEnv>): Promise<QuoteOutcome> => {
    const hit = quotes.get(c.req.raw);
    if (hit) return hit;
    const q: Promise<QuoteOutcome> =
      c.req.path === BUY_PATH && !limiter.take(clientIp(c))
        ? Promise.resolve(refuse(429, "rate_limited", `at most ${deps.quotesPerMinute ?? BUY_QUOTES_PER_MINUTE} price reads per minute per client; nothing was charged`))
        : quote(
            {
              method: c.req.method,
              path: c.req.path,
              url: c.req.query("url"),
              contentType: c.req.header("content-type"),
              contentLength: c.req.header("content-length"),
              body: () => c.req.raw.body,
            },
            cfg,
            deps,
          );
    quotes.set(c.req.raw, q);
    return q;
  };
  /** What the paid request settled for and the daily-cap reservation it holds, per request object. */
  const approved = new WeakMap<Request, { q: Quote; reservationId: string; firstFor?: string }>();
  /** Addresses whose at-cost first purchase settled on this instance (the indexer shows it a few seconds later). */
  const paidOnce = new Set<string>();
  const own = new Set(deps.probeDeps.ownAddresses ?? []);

  /** Fee and total for this request: 0 fee for a first purchase (?payer= that never paid payTo). One read per request object. */
  const pricings = new WeakMap<Request, Promise<{ feeAtomic: bigint; customerAtomic: bigint; firstFor?: string }>>();
  const pricingFor = (c: Context<SettleFirstEnv>, q: Quote) => {
    const hit = pricings.get(c.req.raw);
    if (hit) return hit;
    const p = (async () => {
      const payer = c.req.query("payer")?.trim();
      let first = false;
      if (payer && deps.firstPurchase && payer.length === 58 && isValidAddress(payer) && !own.has(payer) && !paidOnce.has(payer)) {
        try {
          first = await deps.firstPurchase(payer);
        } catch {
          first = false; // cannot tell: the normal price
        }
      }
      const feeAtomic = first ? 0n : q.feeAtomic;
      return { feeAtomic, customerAtomic: buyPriceAtomic(q.sellerAtomic, feeAtomic), ...(first ? { firstFor: payer } : {}) };
    })();
    pricings.set(c.req.raw, p);
    return p;
  };

  /** The amount and extra of this request's price: the same on every accept (Algorand USDC, and Base USDC when on). */
  const priceOf = async (ctx: HTTPRequestContext) => {
    const c = (ctx.adapter as unknown as { c: Context<SettleFirstEnv> }).c;
    const q = await quoteFor(c);
    // A refused purchase has no payable price: amount 0 matches no signed payment, and the preflight refuses it anyway.
    if (!q.ok) return { amount: "0", extra: { refused: q.body.reason } as Record<string, unknown> };
    return {
      amount: q.customerAtomic.toString(),
      extra: { sellerAmount: q.accept.amount, sellerPayTo: q.accept.payTo, buyFee: q.feeAtomic.toString() } as Record<string, unknown>,
    };
  };
  // The Algorand accept may carry the first-purchase price (?payer= is an Algorand address that never paid payTo).
  // The Base accept (priceOf) always carries the normal price: a first purchase at cost is paid on Algorand only.
  const price = async (ctx: HTTPRequestContext) => {
    const c = (ctx.adapter as unknown as { c: Context<SettleFirstEnv> }).c;
    const q = await quoteFor(c);
    if (!q.ok) return { ...(await priceOf(ctx)), asset: cfg.usdcAsaId };
    const pr = await pricingFor(c, q);
    return {
      amount: pr.customerAtomic.toString(),
      asset: cfg.usdcAsaId,
      extra: {
        sellerAmount: q.accept.amount,
        sellerPayTo: q.accept.payTo,
        buyFee: pr.feeAtomic.toString(),
        ...(pr.firstFor ? { firstPurchase: true, payer: pr.firstFor } : {}),
      } as Record<string, unknown>,
    };
  };
  const accepts = withBase(
    cfg,
    {
      scheme: "exact",
      price,
      network: cfg.network as `${string}:${string}`,
      payTo: deps.payTo,
      extra: { asset: cfg.usdcAsaId, tag: cfg.challengeTag },
    },
    priceOf,
  );
  const description = `vet402 buys the x402 resource you name for you: you pay the seller's price + ${atomicToUsdc(cfg.buyFeeAtomic)} USDC; after your payment settles vet402 pays the seller (per-call cap ${atomicToUsdc(cfg.maxPerCallAtomic)} USDC), returns the seller's response body as-is, and adds its verdict (ALLOW/REFUSE) and both tx ids in x-vet402-* headers. The unpaid request is free and shows the price. No refunds.`;
  const discovery = declareDiscoveryExtension({
    input: { url: "https://seller.example/v1/data" },
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "x402 endpoint for vet402 to buy (and check) for you" } },
      required: ["url"],
    },
    output: { example: { forecast: "sunny", temperature: 21 } },
  });
  const httpServer = new x402HTTPResourceServer(resourceServer, {
    [`GET ${BUY_PATH}`]: { accepts, description, mimeType: "application/octet-stream", extensions: discovery },
    [`POST ${BUY_PATH}`]: { accepts, description, mimeType: "application/octet-stream" },
  });

  app.use(
    settleFirstMiddleware(httpServer, {
      // Free: refuse before the 402 what vet402 would not buy (nothing to sign, nothing charged).
      beforeChallenge: async (c) => {
        const q = await quoteFor(c);
        if (!q.ok) return { stop: c.json(q.body, q.status) };
        const pr = await pricingFor(c, q);
        return {
          info: {
            buy: {
              target: q.target,
              method: q.method,
              priceRead: q.priceRead,
              sellerPrice: { amountAtomic: q.accept.amount, usdc: atomicToUsdc(q.sellerAtomic), payTo: q.accept.payTo },
              fee: { amountAtomic: pr.feeAtomic.toString(), usdc: atomicToUsdc(pr.feeAtomic) },
              total: { amountAtomic: pr.customerAtomic.toString(), usdc: atomicToUsdc(pr.customerAtomic) },
              ...(pr.firstFor ? { firstPurchase: { payer: pr.firstFor, note: "first purchase from this address: no vet402 fee" } } : {}),
              refund: "none",
            },
          },
        };
      },
      // Paid and verified, not yet settled: every refusal here costs the customer nothing.
      preflight: async (c) => {
        // x402 v1 payloads are matched by scheme and network only (no deep equality of `accepted`): v2 only.
        if (c.get("x402Version") !== 2) {
          return c.json({ verdict: "REFUSE", reason: "unsupported_x402_version", charged: false, detail: "/v1/buy accepts x402 v2 payments only" }, 400);
        }
        // Same quote object the price was computed from. `paidRequirements` is one of the server's own
        // requirements, so comparing them here would always match; what protects the amount is x402 v2's
        // deep equality of the signed `accepted` with these requirements and the facilitator's exact-amount check.
        const q = await quoteFor(c);
        if (!q.ok) return c.json(q.body, q.status);
        // A first-purchase price is bound to extra.payer (deep-equal checked by x402): the paying account must be that address.
        const extra = c.get("paidRequirements")?.extra ?? {};
        let firstFor: string | undefined;
        if (extra.firstPurchase === true) {
          const sender = paymentSender(c.req.header("payment-signature") || c.req.header("x-payment"), deps.payTo);
          if (typeof extra.payer !== "string" || sender !== extra.payer || paidOnce.has(extra.payer)) {
            return c.json({ verdict: "REFUSE", reason: "first_purchase_payer_mismatch", target: q.target, charged: false, detail: "the first-purchase price is for the address in ?payer=; this payment comes from another account. Nothing was charged." }, 409);
          }
          firstFor = extra.payer;
          paidOnce.add(firstFor); // held from here: a second at-cost payment from this address on this instance is refused (released if not settled)
        }
        // Hold the seller's price on the daily cap now, so a concurrent purchase cannot take it after this customer paid.
        const r = await deps.guard.reserve(q.sellerAtomic);
        if (!r.ok) {
          if (firstFor) paidOnce.delete(firstFor);
          return c.json({ verdict: "REFUSE", reason: r.reason, target: q.target, charged: false, detail: r.detail }, r.reason === "price_over_cap" ? 422 : 503);
        }
        approved.set(c.req.raw, { q, reservationId: r.reservationId, firstFor });
        return null;
      },
      onNotSettled: (c) => {
        const a = approved.get(c.req.raw);
        if (!a) return;
        approved.delete(c.req.raw);
        deps.guard.release(a.reservationId);
        if (a.firstFor) paidOnce.delete(a.firstFor);
      },
    }),
  );

  const handler = async (c: Context<SettleFirstEnv>) => {
    const customerPayment = c.get("customerPayment");
    // Defence in depth: never pay a seller unless this request's own payment has settled.
    if (!customerPayment) return c.json({ error: "payment_required" }, 402);
    const a = approved.get(c.req.raw);
    if (!a) return c.json({ verdict: "REFUSE", reason: "probe_error", detail: "purchase not approved in preflight", customerPayment, refund: "none" }, 500, paidHeaders("REFUSE", "probe_error", customerPayment));
    const { q, reservationId } = a; // an at-cost payer stays in paidOnce: the next purchase from it is at the normal price
    let out: Awaited<ReturnType<typeof probeWithBody>>;
    try {
      out = await probeWithBody(q.target, cfg, deps.guard, deps.probeDeps, {
        method: q.method,
        body: q.body,
        contentType: q.contentType,
        expect: q.accept,
        reservation: { id: reservationId, amountAtomic: q.sellerAtomic },
      });
    } catch (e) {
      const detail = String((e as Error).message ?? e).slice(0, 200);
      return c.json({ verdict: "REFUSE", reason: "probe_error", target: q.target, detail, customerPayment, refund: "none" }, 502, paidHeaders("REFUSE", "probe_error", customerPayment));
    }
    const { result: r, delivered } = out;
    const sellerTx = r.downstreamPayment?.success ? r.downstreamPayment.transaction : undefined;
    if (!delivered || !sellerTx) {
      // The customer paid; the seller was not (or not verifiably) paid, so there is no body to hand over.
      return c.json(
        { error: "seller_not_paid", verdict: r.verdict, reason: r.reason, target: q.target, detail: r.detail, customerPayment, downstreamPayment: r.downstreamPayment, refund: "none" },
        502,
        paidHeaders(r.verdict, r.reason, customerPayment, r.downstreamPayment?.transaction),
      );
    }
    if (delivered.truncated) {
      return c.json(
        { error: "response_too_large", verdict: r.verdict, reason: r.reason, target: q.target, detail: `the seller's body is above ${MAX_BODY_BYTES} bytes; vet402 does not forward a partial body`, customerPayment, downstreamPayment: r.downstreamPayment, refund: "none" },
        502,
        paidHeaders(r.verdict, r.reason, customerPayment, sellerTx),
      );
    }
    // Any 2xx (also 204/205, which may carry no body) is answered as 200 with the body as delivered, possibly empty.
    const status = delivered.status >= 200 && delivered.status < 300 ? 200 : 502;
    return c.body(new Uint8Array(delivered.bytes), status, {
      "content-type": delivered.contentType ?? "application/octet-stream",
      // The seller's content is served from vet402's origin: never let it run or be sniffed as something else.
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      ...paidHeaders(r.verdict, r.reason, customerPayment, sellerTx, {
        "x-vet402-seller-status": String(delivered.status),
        "x-vet402-seller-price": r.price?.amountAtomic ?? q.accept.amount,
      }),
    });
  };
  app.get(BUY_PATH, handler);
  app.post(BUY_PATH, handler);
}
