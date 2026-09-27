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
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { toClientAvmSigner, ExactAvmScheme } from "@x402/avm";
import { loadConfig, usdcToAtomic } from "./config.js";
import { loadKeys, secretKeyB64FromMnemonic } from "./keys.js";

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
  const signer = toClientAvmSigner(secretKeyB64FromMnemonic(keys.client.mnemonic));
  const client = new x402Client();
  client.register(cfg.network as `${string}:${string}`, new ExactAvmScheme(signer));
  // The customer also caps what it pays vet402.
  const customerCap = usdcToAtomic(process.env.CUSTOMER_MAX_USDC ?? "0.10");
  client.registerPolicy((_v, reqs) => reqs.filter((r) => BigInt(r.amount) <= customerCap));

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const url = `${vet402}/v1/check?url=${encodeURIComponent(target)}`;
  const res = await fetchWithPayment(url, { method: "GET" });

  let customerTx: string | undefined;
  try {
    const s = new x402HTTPClient(client).getPaymentSettleResponse((n) => res.headers.get(n));
    customerTx = s.success ? s.transaction : undefined;
  } catch {
    customerTx = undefined;
  }
  const body = (await res.json().catch(() => ({}))) as {
    verdict?: string;
    reason?: string;
    detail?: string;
    customerPayment?: { transaction?: string };
    downstreamPayment?: { transaction?: string; success?: boolean };
    delivery?: { summary?: string; missingKeys?: string[] };
    price?: { usdc?: string };
  };

  console.log(`HTTP ${res.status}`);
  if (res.status === 402) {
    let why = "payment not accepted";
    try {
      why = new x402HTTPClient(client).getPaymentRequiredResponse((n) => res.headers.get(n), body).error ?? why;
    } catch {
      /* keep default */
    }
    console.log(`customer payment to vet402 was not accepted: ${why}`);
    process.exitCode = 1;
    return;
  }
  console.log(`verdict           ${body.verdict ?? "-"}  reason=${body.reason ?? "-"}${body.detail ? `  (${body.detail})` : ""}`);
  console.log(`seller price      ${body.price?.usdc ?? "-"} USDC`);
  customerTx = body.customerPayment?.transaction ?? customerTx;
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
