/**
 * Test sellers for the TestNet end-to-end run (local only).
 *
 *   GET /honest   0.01 USDC  declares {forecast, temperature}; returns them       -> ALLOW
 *   GET /liar     0.01 USDC  declares {forecast, temperature}; returns {message}  -> REFUSE delivery_missing_keys
 *   GET /pricey   0.50 USDC  honest, but above vet402's per-call cap             -> REFUSE price_over_cap (never paid)
 *   GET /empty    0.01 USDC  declares {forecast, temperature}; answers 204 (no body) -> paid, REFUSE; /v1/buy returns 200 + empty body
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { ResourceServerExtension } from "@x402/core/types";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402-avm/extensions";
import { loadConfig } from "./config.js";
import { loadKeys } from "./keys.js";

const cfg = loadConfig();
if (cfg.networkName !== "testnet") throw new Error("test sellers run on TestNet only");
const keys = loadKeys(cfg.keysFile);
const port = Number(process.env.SELLERS_PORT ?? 4031);

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: cfg.facilitatorUrl })).register(
  cfg.network as `${string}:${string}`,
  new ExactAvmScheme(),
);
resourceServer.registerExtension(bazaarResourceServerExtension as unknown as ResourceServerExtension);

const forecastDecl = declareDiscoveryExtension({
  output: {
    example: { forecast: "sunny", temperature: 21 },
    schema: {
      type: "object",
      properties: { forecast: { type: "string" }, temperature: { type: "number" } },
      required: ["forecast", "temperature"],
    },
  },
});

const route = (price: string, description: string) => ({
  accepts: [
    {
      scheme: "exact",
      price,
      network: cfg.network as `${string}:${string}`,
      payTo: keys.seller.address,
      extra: { asset: cfg.usdcAsaId },
    },
  ],
  description,
  mimeType: "application/json",
  extensions: forecastDecl,
});

const app = new Hono();
app.use(
  paymentMiddleware(
    {
      "GET /honest": route("$0.01", "Tokyo forecast: {forecast, temperature}"),
      "GET /liar": route("$0.01", "Tokyo forecast: {forecast, temperature}"),
      "GET /pricey": route("$0.50", "Tokyo forecast: {forecast, temperature} (premium)"),
      "GET /empty": route("$0.01", "Tokyo forecast: {forecast, temperature}"),
    },
    resourceServer,
  ),
);
app.get("/honest", (c) => c.json({ forecast: "sunny", temperature: 21, city: "Tokyo" }));
app.get("/liar", (c) => c.json({ message: "thanks for paying" }));
app.get("/pricey", (c) => c.json({ forecast: "sunny", temperature: 21 }));
app.get("/empty", (c) => c.body(null, 204));

serve({ fetch: app.fetch, port }, () => {
  console.log(`test sellers on http://localhost:${port}  payTo=${keys.seller.address}`);
});
