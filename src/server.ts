/**
 * vet402 on Algorand — paid check endpoint.
 *
 *   GET /v1/check?url=<x402 URL>   (0.05 USDC)
 *
 * Order (settle-first, see settle-first.ts):
 *   1. customer's payment is verified, then SETTLED on-chain
 *   2. only then vet402 pays the target seller (within caps)
 *   3. delivery is checked against the seller's declaration
 *   4. ALLOW / REFUSE with both tx ids and a delivery summary
 *
 * Runs locally (`npm run server`) and on Vercel (zero-config Hono: this file's
 * default export). Layout follows algorandfoundation/x402-demo.
 */
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { x402HTTPResourceServer, x402ResourceServer } from "@x402/hono";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { ResourceServerExtension } from "@x402/core/types";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402-avm/extensions";
import { atomicToUsdc, loadConfig, type AppConfig } from "./config.js";
import { loadKeys, loadPayer } from "./keys.js";
import { SpendLedger } from "./caps.js";
import { IndexedSpendGuard, usdcSentToday, type SpendGuard } from "./spend.js";
import { makePaidFetch, probe, type ProbeDeps } from "./probe.js";
import { checkTarget } from "./target.js";
import { settleFirstMiddleware, type SettleFirstEnv } from "./settle-first.js";

type FacilitatorLike = ConstructorParameters<typeof x402ResourceServer>[0];

export const CHECK_OUTPUT_EXAMPLE = {
  verdict: "ALLOW",
  reason: "delivered",
  target: "https://seller.example/v1/data",
  customerPayment: { transaction: "TXID_CUSTOMER...", network: "algorand:...", amount: "50000", payTo: "VET402..." },
  declared: { description: "Weather data", mimeType: "application/json", expectedKeys: ["weather", "temperature"] },
  price: { amountAtomic: "5000", usdc: "0.005000", payTo: "SELLER...", network: "algorand:...", asset: "31566704" },
  downstreamPayment: { success: true, transaction: "TXID_SELLER...", network: "algorand:..." },
  delivery: { status: 200, contentType: "application/json", bytes: 64, summary: "object{weather:string=\"sunny\", temperature:number=70}", missingKeys: [] },
};

export interface AppDeps {
  payTo: string;
  probeDeps: ProbeDeps;
  guard: SpendGuard;
  /** Injected in tests; default is the HTTP facilitator at cfg.facilitatorUrl. */
  facilitator?: FacilitatorLike;
}

export function createApp(cfg: AppConfig, deps: AppDeps) {
  const facilitator = deps.facilitator ?? new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitator).register(cfg.network as `${string}:${string}`, new ExactAvmScheme());
  resourceServer.registerExtension(bazaarResourceServerExtension as unknown as ResourceServerExtension);

  const discovery = declareDiscoveryExtension({
    input: { url: "https://seller.example/v1/data" },
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "x402 endpoint for vet402 to pay and check" } },
      required: ["url"],
    },
    output: {
      example: CHECK_OUTPUT_EXAMPLE,
      schema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["ALLOW", "REFUSE"] },
          reason: { type: "string" },
          target: { type: "string" },
          customerPayment: { type: "object" },
          downstreamPayment: { type: "object" },
          delivery: { type: "object" },
        },
        required: ["verdict", "reason", "target", "customerPayment"],
      },
    },
  });

  const httpServer = new x402HTTPResourceServer(resourceServer, {
    "GET /v1/check": {
      accepts: [
        {
          scheme: "exact",
          price: `$${cfg.checkPriceUsdc}`,
          network: cfg.network as `${string}:${string}`,
          payTo: deps.payTo,
          extra: { asset: cfg.usdcAsaId, tag: cfg.challengeTag },
        },
      ],
      description:
        "vet402 pays the x402 endpoint you name (only after your payment has settled), checks the delivery against its declared output (Bazaar schema / 402), and returns ALLOW or REFUSE with both payment tx ids and a summary of what was delivered.",
      mimeType: "application/json",
      extensions: discovery,
    },
  });

  const ownAddresses = [...new Set([deps.payTo, ...(deps.probeDeps.ownAddresses ?? [])])];
  const probeDeps: ProbeDeps = { ...deps.probeDeps, ownAddresses };

  const app = new Hono<SettleFirstEnv>();

  app.get("/", (c) =>
    c.json({
      service: "vet402 (Algorand)",
      network: cfg.network,
      endpoints: { "GET /v1/check?url=<x402 URL>": `${cfg.checkPriceUsdc} USDC` },
      order: "customer payment settles first; the seller is paid only after that",
      caps: { perCallUsdc: atomicToUsdc(cfg.maxPerCallAtomic), perDayUsdc: atomicToUsdc(cfg.maxPerDayAtomic) },
    }),
  );

  app.use(
    settleFirstMiddleware(httpServer, {
      // Free checks: a request we cannot serve is refused before the customer is charged.
      preflight: async (c) => {
        const target = c.req.query("url");
        if (!target) return c.json({ error: "missing url query parameter" }, 400);
        const t = await checkTarget(target, cfg.allowPrivateTargets, deps.probeDeps.resolveHost);
        if (!t.ok) return c.json({ verdict: "REFUSE", reason: "invalid_target", target, detail: t.detail }, 400);
        const h = await deps.guard.headroom();
        if (!h.ok) return c.json({ verdict: "REFUSE", reason: h.reason, target, detail: h.detail }, 503);
        return null;
      },
    }),
  );

  app.get("/v1/check", async (c) => {
    const customerPayment = c.get("customerPayment");
    const target = c.req.query("url") ?? "";
    try {
      const result = await probe(target, cfg, deps.guard, probeDeps);
      return c.json({ ...result, customerPayment }, 200);
    } catch (e) {
      // The customer has paid: always answer with a verdict.
      return c.json({ verdict: "REFUSE", reason: "probe_error", target, customerPayment, detail: String((e as Error).message ?? e).slice(0, 200) }, 200);
    }
  });

  return app;
}

/** Production wiring from env: chain-backed daily cap, real paying fetch. */
export function createAppFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const cfg = loadConfig(env);
  const payer = loadPayer(cfg.networkName, cfg.keysFile, env);
  const payTo = cfg.payTo ?? loadKeys(cfg.keysFile).vet402.address;
  const ledger = new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic, cfg.spendLedgerFile);
  const guard = new IndexedSpendGuard(ledger, () =>
    usdcSentToday({ indexerUrl: cfg.indexerUrl, address: payer.address, asaId: cfg.usdcAsaId }),
  );
  const probeDeps: ProbeDeps = {
    fetchImpl: (url, init) => fetch(url, init),
    paidFetch: makePaidFetch(cfg, payer.secretKeyB64),
    ownAddresses: [payTo, payer.address],
  };
  return { cfg, payTo, payer: payer.address, app: createApp(cfg, { payTo, probeDeps, guard }) };
}

// Vercel entry (zero-config Hono): build lazily so importing this module has no side effects.
let built: ReturnType<typeof createAppFromEnv>["app"] | null = null;
const entry = new Hono();
entry.all("*", (c) => {
  built ??= createAppFromEnv().app;
  return built.fetch(c.req.raw);
});
export default entry;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { cfg, payTo, payer, app } = createAppFromEnv();
  serve({ fetch: app.fetch, port: cfg.port }, () => {
    console.log(`vet402 (Algorand ${cfg.networkName}) on http://localhost:${cfg.port}  payTo=${payTo}  payer=${payer}`);
  });
}
