/**
 * Settle-first x402 middleware for Hono.
 *
 * The stock @x402/hono middleware (2.11) runs the handler and settles AFTER it.
 * vet402 is an orchestrator: it spends money in the handler (paying a seller),
 * and the challenge only counts downstream payments made after the customer's
 * payment has settled. So the order here is:
 *
 *   verify (facilitator) -> preflight (free checks; may stop, customer not charged)
 *   -> settle (facilitator, customer's payment confirmed on-chain)
 *   -> handler (pays the seller)
 *
 * If settlement fails, the handler never runs and the seller is never paid.
 * Built on the official core `x402HTTPResourceServer` (processHTTPRequest /
 * processSettlement), the same calls @x402/hono uses.
 */
import type { Context, MiddlewareHandler } from "hono";
import { HonoAdapter } from "@x402/hono";
import { x402HTTPResourceServer, getFacilitatorResponseError } from "@x402/core/server";

export interface CustomerPayment {
  transaction: string;
  network: string;
  payer?: string;
  amount: string;
  payTo: string;
}

export type SettleFirstEnv = { Variables: { customerPayment: CustomerPayment } };

export interface SettleFirstOptions {
  /** Runs after verify and before settle. Return a Response to stop (customer is NOT charged). */
  preflight?: (c: Context<SettleFirstEnv>) => Promise<Response | null>;
}

export function settleFirstMiddleware(httpServer: x402HTTPResourceServer, opts: SettleFirstOptions = {}): MiddlewareHandler<SettleFirstEnv> {
  let init: Promise<void> | null = null;
  const ensureInit = async () => {
    if (!init) init = httpServer.initialize().catch((e) => {
      init = null;
      throw e;
    });
    await init;
  };

  return async (c, next) => {
    const adapter = new HonoAdapter(c);
    const context = {
      adapter,
      path: c.req.path,
      // Hono serves HEAD with the GET handler: price HEAD exactly like GET so it can never skip payment.
      method: c.req.method === "HEAD" ? "GET" : c.req.method,
      paymentHeader: adapter.getHeader("payment-signature") || adapter.getHeader("x-payment"),
    };
    if (!httpServer.requiresPayment(context)) return next();

    try {
      await ensureInit();
    } catch (e) {
      const fe = getFacilitatorResponseError(e);
      return c.json({ error: fe ? fe.message : "facilitator unavailable" }, 502);
    }

    let result;
    try {
      result = await httpServer.processHTTPRequest(context);
    } catch (e) {
      const fe = getFacilitatorResponseError(e);
      return c.json({ error: fe ? fe.message : "payment verification failed" }, 502);
    }

    if (result.type === "no-payment-required") return next();
    if (result.type === "payment-error") {
      const r = result.response;
      for (const [k, v] of Object.entries(r.headers)) c.header(k, v);
      return r.isHtml ? c.html(String(r.body), r.status as 402) : c.json(r.body ?? {}, r.status as 402);
    }

    // payment-verified: free checks before we take the customer's money.
    if (opts.preflight) {
      const stop = await opts.preflight(c);
      if (stop) return stop;
    }

    let settle;
    try {
      settle = await httpServer.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, {
        request: context,
        responseBody: Buffer.alloc(0),
        responseHeaders: {},
      });
    } catch (e) {
      const fe = getFacilitatorResponseError(e);
      return c.json({ error: "customer_settlement_failed", detail: fe ? fe.message : String((e as Error).message ?? e).slice(0, 200) }, 502);
    }
    if (!settle.success) {
      const r = settle.response;
      for (const [k, v] of Object.entries(r.headers)) c.header(k, v);
      return c.json(
        { error: "customer_settlement_failed", reason: settle.errorReason, ...(typeof r.body === "object" && r.body ? r.body : {}) },
        (r.status || 402) as 402,
      );
    }

    c.set("customerPayment", {
      transaction: settle.transaction,
      network: settle.network,
      payer: settle.payer,
      amount: result.paymentRequirements.amount,
      payTo: result.paymentRequirements.payTo,
    });
    await next();
    for (const [k, v] of Object.entries(settle.headers)) c.res.headers.set(k, v);
  };
}
