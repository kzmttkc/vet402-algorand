/**
 * vet402 on Algorand — paid check endpoint.
 *
 *   GET /v1/check?url=<x402 URL>   (0.05 USDC by default)
 *
 * vet402 pays the target seller itself (within caps), checks the delivery
 * against the seller's declaration, and answers ALLOW / REFUSE with evidence.
 * Layout follows algorandfoundation/x402-demo x402-basic-tutorial/server.
 */
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { ResourceServerExtension } from "@x402/core/types";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402-avm/extensions";
import { loadConfig, type AppConfig } from "./config.js";
import { loadKeys, secretKeyB64FromMnemonic } from "./keys.js";
import { SpendLedger } from "./caps.js";
import { makePaidFetch, probe, type ProbeDeps } from "./probe.js";

export const CHECK_OUTPUT_EXAMPLE = {
  verdict: "ALLOW",
  reason: "delivered",
  target: "https://seller.example/v1/data",
  declared: { description: "Weather data", mimeType: "application/json", expectedKeys: ["weather", "temperature"] },
  price: { amountAtomic: "5000", usdc: "0.005000", payTo: "SELLER...", network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe", asset: "10458941" },
  downstreamPayment: { success: true, transaction: "TXID...", network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe" },
  delivery: { status: 200, contentType: "application/json", bytes: 64, summary: "object{weather:string=\"sunny\", temperature:number=70}", missingKeys: [] },
};

export function createApp(cfg: AppConfig, payTo: string, deps: ProbeDeps, ledger: SpendLedger) {
  const facilitatorClient = new HTTPFacilitatorClient({ url: cfg.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    cfg.network as `${string}:${string}`,
    new ExactAvmScheme(),
  );
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
          downstreamPayment: { type: "object" },
          delivery: { type: "object" },
        },
        required: ["verdict", "reason", "target"],
      },
    },
  });

  const app = new Hono();

  app.get("/", (c) =>
    c.json({
      service: "vet402 (Algorand)",
      network: cfg.network,
      endpoints: { "GET /v1/check?url=<x402 URL>": `${cfg.checkPriceUsdc} USDC` },
      caps: { perCallUsdc: Number(cfg.maxPerCallAtomic) / 1e6, perDayUsdc: Number(cfg.maxPerDayAtomic) / 1e6 },
    }),
  );

  app.use(
    paymentMiddleware(
      {
        "GET /v1/check": {
          accepts: [
            {
              scheme: "exact",
              price: `$${cfg.checkPriceUsdc}`,
              network: cfg.network as `${string}:${string}`,
              payTo,
              extra: { asset: cfg.usdcAsaId, tag: cfg.challengeTag },
            },
          ],
          description:
            "vet402 pays the x402 endpoint you name, checks the delivery against its declared output (Bazaar schema / 402), and returns ALLOW or REFUSE with both payment tx ids and a summary of what was delivered.",
          mimeType: "application/json",
          extensions: discovery,
        },
      },
      resourceServer,
    ),
  );

  app.get("/v1/check", async (c) => {
    const target = c.req.query("url");
    // Non-2xx responses are not settled: the customer is not charged.
    if (!target) return c.json({ error: "missing url query parameter" }, 400);
    const result = await probe(target, cfg, ledger, deps);
    if (result.reason === "invalid_target") return c.json(result, 400);
    if (result.reason === "daily_cap_reached") return c.json(result, 503);
    return c.json(result, 200);
  });

  return app;
}

async function main() {
  const cfg = loadConfig();
  const keys = loadKeys(cfg.keysFile);
  const ledger = new SpendLedger(cfg.maxPerCallAtomic, cfg.maxPerDayAtomic, cfg.spendLedgerFile);
  const deps: ProbeDeps = {
    fetchImpl: (url, init) => fetch(url, init),
    paidFetch: makePaidFetch(cfg, secretKeyB64FromMnemonic(keys.vet402.mnemonic)),
  };
  const app = createApp(cfg, keys.vet402.address, deps, ledger);
  serve({ fetch: app.fetch, port: cfg.port }, () => {
    console.log(`vet402 (Algorand ${cfg.networkName}) listening on http://localhost:${cfg.port}  payTo=${keys.vet402.address}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
