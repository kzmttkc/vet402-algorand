/**
 * Customer role on Base Sepolia (TestNet only): pays vet402 in Base Sepolia USDC for one check,
 * and vet402 then pays the Algorand TestNet seller.
 *
 *   BASE_CUSTOMER_KEYS=.keys/base-sepolia-customer.json VET402_URL=http://localhost:4021 \
 *     npx tsx scripts/base-customer-demo.ts http://localhost:4031/honest
 *
 * Before signing it reads the free 402, takes only the Base Sepolia USDC accept (at most
 * CUSTOMER_MAX_USDC, payTo = EXPECT_BASE_PAY_TO when set) and checks the wallet's USDC balance.
 * An unfunded wallet stops here with the amount and address to fund, unless --even-if-unfunded
 * (then the facilitator's verify refuses it and nothing settles: a check of the signature format).
 * The payer needs no ETH: the facilitator submits the EIP-3009 transfer and pays the gas.
 */
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { atomicToUsdc, BASE_USDC, usdcToAtomic } from "../src/config.js";

const NET = BASE_USDC.testnet.network;
const USDC = BASE_USDC.testnet.address;
const RPC = process.env.BASE_RPC_URL ?? "https://sepolia.base.org";

if ((process.env.X402_NETWORK ?? "testnet").toLowerCase() !== "testnet") {
  console.error("TestNet only: this script pays on Base Sepolia.");
  process.exit(2);
}
const target = process.argv[2];
if (!target) {
  console.error("usage: npx tsx scripts/base-customer-demo.ts <x402 URL to check> [--even-if-unfunded]");
  process.exit(2);
}
const evenIfUnfunded = process.argv.includes("--even-if-unfunded");
const vet402 = process.env.VET402_URL ?? "http://localhost:4021";
const keys = JSON.parse(readFileSync(process.env.BASE_CUSTOMER_KEYS ?? ".keys/base-sepolia-customer.json", "utf8")) as { privateKey: `0x${string}` };
const account = privateKeyToAccount(keys.privateKey);
const maxAtomic = usdcToAtomic(process.env.CUSTOMER_MAX_USDC ?? "0.10");
const expectPayTo = process.env.EXPECT_BASE_PAY_TO?.toLowerCase();

async function usdcBalance(addr: string): Promise<bigint> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC, data: `0x70a08231${addr.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"] }),
  });
  const body = (await res.json()) as { result?: string };
  return BigInt(body.result ?? "0x0");
}

const isOurs = (r: { scheme: string; network: string; asset: string; amount: string; payTo: string }) =>
  r.scheme === "exact" && r.network === NET && r.asset.toLowerCase() === USDC.toLowerCase() && /^\d+$/.test(r.amount) && BigInt(r.amount) <= maxAtomic && (!expectPayTo || r.payTo.toLowerCase() === expectPayTo);

async function main() {
  const url = `${vet402}/v1/check?url=${encodeURIComponent(target)}`;
  const free = await fetch(url);
  if (free.status !== 402) throw new Error(`expected 402 from vet402, got ${free.status}: ${(await free.text()).slice(0, 200)}`);
  const pr = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((n) => free.headers.get(n), await free.json().catch(() => undefined));
  console.log(`402 accepts: ${pr.accepts.map((a) => `${a.network} ${a.amount} -> ${a.payTo} tag=${String(a.extra?.tag)}`).join(" | ")}`);
  const ours = pr.accepts.find(isOurs);
  if (!ours) throw new Error(`vet402's 402 has no Base Sepolia USDC accept within ${atomicToUsdc(maxAtomic)} USDC${expectPayTo ? ` to ${expectPayTo}` : ""} (is BASE_ACCEPT=on?)`);

  const bal = await usdcBalance(account.address);
  console.log(`customer ${account.address}  Base Sepolia USDC=${atomicToUsdc(bal)}  price=${atomicToUsdc(BigInt(ours.amount))}`);
  if (bal < BigInt(ours.amount) && !evenIfUnfunded) {
    console.log(`NEEDS FUNDS: send at least ${atomicToUsdc(BigInt(ours.amount) - bal)} Base Sepolia USDC (${USDC}) to ${account.address}. No ETH is needed. Nothing was signed.`);
    process.exitCode = 3;
    return;
  }

  let signed = 0;
  const client = new x402Client();
  client.register(NET, new ExactEvmScheme(account));
  client.registerPolicy((_v, reqs) => reqs.filter((r) => isOurs(r) && r.payTo === ours.payTo && r.amount === ours.amount));
  client.onBeforePaymentCreation(async () => (signed >= 1 ? { abort: true, reason: "one payment per check" } : undefined));
  client.onAfterPaymentCreation(async () => {
    signed += 1;
  });
  const res = await wrapFetchWithPayment(fetch, client)(url);
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  const again = res.status === 402 ? res.headers.get("PAYMENT-REQUIRED") : null;
  if (again) console.log(`refused by verify: ${String(JSON.parse(Buffer.from(again, "base64").toString()).error ?? "-")}  (signed ${signed})`);
  let body: Record<string, any> = {};
  try {
    body = JSON.parse(text);
  } catch {
    console.log(text.slice(0, 400));
    return;
  }
  const cp = body.customerPayment;
  const dp = body.downstreamPayment;
  console.log(`verdict           ${body.verdict ?? "-"}  reason=${body.reason ?? "-"}${body.detail ? `  (${body.detail})` : ""}`);
  console.log(`payment 1 (you -> vet402, Base Sepolia)       ${cp?.transaction ?? "(not settled)"}${cp?.transaction ? `  https://sepolia.basescan.org/tx/${cp.transaction}` : ""}`);
  console.log(`payment 2 (vet402 -> seller, Algorand TestNet) ${dp?.transaction ?? "(not paid)"}${dp?.transaction ? `  https://lora.algokit.io/testnet/transaction/${dp.transaction}` : ""}`);
  if (!cp) console.log(JSON.stringify(body).slice(0, 600));
  const pay = res.headers.get("PAYMENT-RESPONSE");
  if (pay) console.log(`PAYMENT-RESPONSE  ${Buffer.from(pay, "base64").toString().slice(0, 300)}`);
}

main().catch((e) => {
  console.error(String((e as Error).message ?? e));
  process.exitCode = 1;
});
