/**
 * Customer role: pays vet402 for a check of a target x402 URL and prints the
 * verdict with both transaction ids.
 *
 *   npm run demo -- http://localhost:4031/honest
 *
 * Payment 1 (customer -> vet402) settles first; its tx id is in the body
 * (customerPayment) and in the PAYMENT-RESPONSE header.
 * Payment 2 (vet402 -> seller) happens only after that (downstreamPayment).
 */
import { loadConfig } from "./config.js";
import { loadKeys, secretKeyB64FromMnemonic } from "./keys.js";
import { checkBeforeBuy, CheckError } from "./check-client.js";

// Customer role is TestNet-only in this repo (MainNet customers bring their own wallet).

const cfg = loadConfig();
const keys = loadKeys(cfg.keysFile);
const target = process.argv[2];
const vet402 = process.env.VET402_URL ?? `http://localhost:${cfg.port}`;
if (!target) {
  console.error("usage: npm run demo -- <x402 URL to check>");
  process.exit(2);
}

const explorer = (tx?: string) =>
  tx ? `https://lora.algokit.io/${cfg.networkName}/transaction/${tx}` : "(none)";

async function main() {
  let body;
  try {
    body = await checkBeforeBuy(target, {
      secretKey: secretKeyB64FromMnemonic(keys.client.mnemonic),
      network: cfg.networkName,
      vet402Url: vet402,
      // The customer also caps what it pays vet402.
      maxPriceUsdc: process.env.CUSTOMER_MAX_USDC ?? "0.10",
    });
  } catch (e) {
    if (e instanceof CheckError && e.httpStatus === 402) {
      console.log("HTTP 402");
      console.log(`customer payment to vet402 was not accepted: ${e.message}`);
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  console.log(`HTTP ${body.httpStatus}`);
  console.log(`verdict           ${body.verdict ?? "-"}  reason=${body.reason ?? "-"}${body.detail ? `  (${body.detail})` : ""}`);
  console.log(`seller price      ${body.price?.usdc ?? "-"} USDC`);
  const customerTx = body.customerPayment?.transaction;
  console.log(`payment 1 (you -> vet402)    ${customerTx ?? "(not settled)"}  ${explorer(customerTx)}`);
  console.log(`payment 2 (vet402 -> seller) ${body.downstreamPayment?.transaction ?? "(not paid)"}  ${explorer(body.downstreamPayment?.transaction)}`);
  if (body.delivery) {
    console.log(`delivered         ${body.delivery.summary}`);
    if (body.delivery.missingKeys?.length) console.log(`missing keys      ${body.delivery.missingKeys.join(", ")}`);
  }
}

main().catch((e: Error) => {
  console.error("error:", e.message);
  process.exit(1);
});
