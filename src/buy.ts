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
 *   2. paid request: the seller's 402 is read again and the price computed again. x402 accepts
 *      a payment only if what the customer signed (amount, and extra.sellerAmount /
 *      extra.sellerPayTo) equals that new computation, so a price change between the two reads
 *      is a 402 and nothing settles.
 *   3. the customer's payment SETTLES (settle-first.ts), then vet402 pays the seller through
 *      probe() (same caps, same payTo lock), locked to the seller price the customer paid for.
 *   4. the seller's response body is returned byte for byte with its content-type, plus the
 *      verdict and both tx ids in headers (x-vet402-*).
 *
 * The customer has paid from step 3 on. If the seller is then not paid (or its body is too
 * large), the answer is 502 with the reason and the customer's tx. There is no refund.
 */
import type { Context, Hono } from "hono";
import { x402HTTPResourceServer, x402ResourceServer } from "@x402/hono";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import type { HTTPRequestContext } from "@x402/core/server";
import type { ResourceServerExtension } from "@x402/core/types";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402-avm/extensions";
import { atomicToUsdc, type AppConfig } from "./config.js";
import type { SpendGuard } from "./spend.js";
import { MAX_BODY_BYTES, parsePaymentRequired, probeWithBody, readCapped, type ProbeDeps } from "./probe.js";
import { sameNetwork, selectAccept, type AcceptLike } from "./declaration.js";
import { checkTarget } from "./target.js";
import { settleFirstMiddleware, type CustomerPayment, type SettleFirstEnv } from "./settle-first.js";

type FacilitatorLike = ConstructorParameters<typeof x402ResourceServer>[0];

export const BUY_PATH = "/v1/buy";
/** Largest customer body vet402 forwards to the seller on POST. */
export const BUY_MAX_REQUEST_BYTES = 64 * 1024;

export interface BuyDeps {
  payTo: string;
  facilitator: FacilitatorLike;
  guard: SpendGuard;
  /** ownAddresses must list every vet402 wallet (payTo, payer). */
  probeDeps: ProbeDeps;
}

/** A purchase vet402 is willing to make, from the seller's 402 read now. */
export interface Quote {
  ok: true;
  target: string;
  method: "GET" | "POST";
  body?: Uint8Array<ArrayBuffer>;
  contentType?: string;
  /** The seller's accept vet402 would pay. */
  accept: AcceptLike;
  sellerAtomic: bigint;
  feeAtomic: bigint;
  /** What the customer pays vet402: seller price + fee. */
  customerAtomic: bigint;
}

export interface Refusal {
  ok: false;
  status: 400 | 404 | 405 | 413 | 415 | 422 | 502;
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

/**
 * Read the seller's 402 without paying and decide whether (and for how much) vet402 buys.
 * Pure of the customer's payment: used for the free 402, the paid request's price, and the preflight.
 */
export async function quote(
  req: { method: string; path: string; url: string | undefined; contentType?: string; contentLength?: string; readBody: () => Promise<ArrayBuffer> },
  cfg: AppConfig,
  deps: Pick<BuyDeps, "probeDeps">,
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
    if (Number(req.contentLength ?? 0) > BUY_MAX_REQUEST_BYTES) return refuse(413, "request_too_large", `POST body above ${BUY_MAX_REQUEST_BYTES} bytes`, { target: url });
    const raw = new Uint8Array(await req.readBody());
    if (raw.byteLength > BUY_MAX_REQUEST_BYTES) return refuse(413, "request_too_large", `POST body above ${BUY_MAX_REQUEST_BYTES} bytes`, { target: url });
    try {
      if (raw.byteLength) JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      return refuse(400, "invalid_json", "POST body is not valid JSON", { target: url });
    }
    body = raw;
    contentType = "application/json";
  }
  const method = req.method as "GET" | "POST";

  // The seller's price, read without paying (same request vet402 would pay for).
  let res: Response;
  let text: string;
  try {
    res = await deps.probeDeps.fetchImpl(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(cfg.probeTimeoutMs),
      ...(body ? { body, headers: { "content-type": contentType! } } : {}),
    });
    text = await readCapped(res);
  } catch (e) {
    return refuse(502, "probe_error", String((e as Error).message ?? e).slice(0, 200), { target: url });
  }
  if (res.status !== 402) return refuse(422, "not_x402", `expected 402, got ${res.status}`, { target: url });
  const parsed = parsePaymentRequired(res, text);
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
  return { ok: true, target: url, method, body, contentType, accept, sellerAtomic, feeAtomic, customerAtomic: buyPriceAtomic(sellerAtomic, feeAtomic) };
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
 * Mounts GET|POST /v1/buy on `app` with its own settle-first payment middleware.
 * Call before any catch-all route; it passes every other request through untouched.
 */
export function registerBuy(app: Hono<SettleFirstEnv>, cfg: AppConfig, deps: BuyDeps): void {
  const resourceServer = new x402ResourceServer(deps.facilitator).register(cfg.network as `${string}:${string}`, new ExactAvmScheme());
  resourceServer.registerExtension(bazaarResourceServerExtension as unknown as ResourceServerExtension);

  /** One seller read per request object: the 402, the price and the preflight see the same quote. */
  const quotes = new WeakMap<Request, Promise<QuoteOutcome>>();
  const quoteFor = (c: Context<SettleFirstEnv>): Promise<QuoteOutcome> => {
    const hit = quotes.get(c.req.raw);
    if (hit) return hit;
    const q = quote(
      {
        method: c.req.method,
        path: c.req.path,
        url: c.req.query("url"),
        contentType: c.req.header("content-type"),
        contentLength: c.req.header("content-length"),
        readBody: () => c.req.arrayBuffer(),
      },
      cfg,
      deps,
    );
    quotes.set(c.req.raw, q);
    return q;
  };
  /** What the paid request settled for, kept per request object for the handler. */
  const approved = new WeakMap<Request, Quote>();

  const price = async (ctx: HTTPRequestContext) => {
    const c = (ctx.adapter as unknown as { c: Context<SettleFirstEnv> }).c;
    const q = await quoteFor(c);
    // A refused purchase has no payable price: amount 0 matches no signed payment, and the preflight refuses it anyway.
    if (!q.ok) return { amount: "0", asset: cfg.usdcAsaId, extra: { refused: q.body.reason } };
    return {
      amount: q.customerAtomic.toString(),
      asset: cfg.usdcAsaId,
      extra: { sellerAmount: q.accept.amount, sellerPayTo: q.accept.payTo, buyFee: q.feeAtomic.toString() },
    };
  };
  const accepts = [
    {
      scheme: "exact",
      price,
      network: cfg.network as `${string}:${string}`,
      payTo: deps.payTo,
      extra: { asset: cfg.usdcAsaId, tag: cfg.challengeTag },
    },
  ];
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
        return {
          info: {
            buy: {
              target: q.target,
              method: q.method,
              sellerPrice: { amountAtomic: q.accept.amount, usdc: atomicToUsdc(q.sellerAtomic), payTo: q.accept.payTo },
              fee: { amountAtomic: q.feeAtomic.toString(), usdc: atomicToUsdc(q.feeAtomic) },
              total: { amountAtomic: q.customerAtomic.toString(), usdc: atomicToUsdc(q.customerAtomic) },
              refund: "none",
            },
          },
        };
      },
      // Paid and verified, not yet settled: every refusal here costs the customer nothing.
      preflight: async (c) => {
        const q = await quoteFor(c); // the paid request's own fresh read of the seller
        if (!q.ok) return c.json(q.body, q.status);
        const paid = c.get("paidRequirements");
        const ex = paid?.extra ?? {};
        // x402 v2 already required deep equality; checked again here so no other path (v1 payloads) can slip by.
        if (paid?.amount !== q.customerAtomic.toString() || ex.sellerAmount !== q.accept.amount || ex.sellerPayTo !== q.accept.payTo) {
          return c.json(
            { verdict: "REFUSE", reason: "price_changed", target: q.target, charged: false, detail: `the seller now asks ${q.accept.amount} (you would pay ${q.customerAtomic}); the payment was for ${paid?.amount}. Nothing was charged: request the 402 again.` },
            409,
          );
        }
        const h = await deps.guard.headroom();
        if (!h.ok) return c.json({ verdict: "REFUSE", reason: h.reason, target: q.target, charged: false, detail: h.detail }, 503);
        if (h.remainingAtomic < q.sellerAtomic) {
          return c.json({ verdict: "REFUSE", reason: "daily_cap_reached", target: q.target, charged: false, detail: "today's remaining cap cannot pay this seller" }, 503);
        }
        approved.set(c.req.raw, q);
        return null;
      },
    }),
  );

  const handler = async (c: Context<SettleFirstEnv>) => {
    const customerPayment = c.get("customerPayment");
    // Defence in depth: never pay a seller unless this request's own payment has settled.
    if (!customerPayment) return c.json({ error: "payment_required" }, 402);
    const q = approved.get(c.req.raw);
    if (!q) return c.json({ verdict: "REFUSE", reason: "probe_error", detail: "purchase not approved in preflight", customerPayment, refund: "none" }, 500, paidHeaders("REFUSE", "probe_error", customerPayment));
    let out: Awaited<ReturnType<typeof probeWithBody>>;
    try {
      out = await probeWithBody(q.target, cfg, deps.guard, deps.probeDeps, { method: q.method, body: q.body, contentType: q.contentType, expect: q.accept });
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
    const status = delivered.status >= 200 && delivered.status < 300 ? delivered.status : 502;
    return c.body(new Uint8Array(delivered.bytes), status as 200, {
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
