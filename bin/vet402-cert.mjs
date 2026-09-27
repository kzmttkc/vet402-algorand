#!/usr/bin/env node
/**
 * Get a vet402 delivery certificate for an x402 seller on Algorand.
 *
 *   npx -y github:kzmttkc/vet402-algorand <seller host or payTo>
 *       free: shows which of the seller's resources vet402 would buy. Pays nothing.
 *   ALGORAND_MNEMONIC="25 words" npx -y github:kzmttkc/vet402-algorand <seller> --yes
 *       pays the audit price (0.50 USDC) from that wallet and prints the certificate URL.
 *
 * Env: VET402_NETWORK=mainnet|testnet (default mainnet), VET402_URL (default the public vet402),
 *      MAX_USDC (most this may pay, default 0.50).
 * With the public vet402 on MainNet, only a payment to vet402's own address is signed.
 * The mnemonic never leaves this process: it signs one USDC payment locally.
 *
 * Plain JavaScript (no build step), so it runs straight from the GitHub repo with npx.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createPrivateKey, createPublicKey } from "node:crypto";

export const DEFAULT_URL = "https://vet402-algorand.vercel.app";
/** vet402's MainNet payTo (same as MAINNET_DEFAULT_PAY_TO in src/config.ts; a test checks it). */
export const MAINNET_PAY_TO = "RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q";
export const NETWORKS = {
  mainnet: { caip2: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", usdc: "31566704" },
  testnet: { caip2: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=", usdc: "10458941" },
};

export function usdcToAtomic(s) {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(s).trim());
  if (!m) throw new Error(`invalid USDC amount: ${s}`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

export function parseArgs(argv) {
  const yes = argv.includes("--yes");
  const pos = argv.filter((a) => !a.startsWith("--"));
  return { seller: pos[0], yes, help: argv.includes("--help") || argv.includes("-h") };
}

/** Which requirement this CLI may pay: exact, USDC on the chosen network, at most maxAtomic, to the allowed payTo. */
export function allowedRequirement(r, o) {
  const net = NETWORKS[o.network];
  const sameNet = r.network === net.caip2 || r.network === `algorand:${net.caip2.slice(9, 41)}`;
  return (
    r.scheme === "exact" &&
    sameNet &&
    String(r.asset) === net.usdc &&
    /^\d+$/.test(String(r.amount)) &&
    BigInt(r.amount) <= o.maxAtomic &&
    (!o.payTo || r.payTo === o.payTo)
  );
}

export function payToLock(vet402Url, network) {
  return vet402Url.replace(/\/+$/, "") === DEFAULT_URL && network === "mainnet" ? MAINNET_PAY_TO : undefined;
}

function secretKeyFromSeed(seed) {
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  return Buffer.concat([Buffer.from(seed), spki.subarray(spki.length - 32)]).toString("base64");
}

async function main() {
  const { seller, yes, help } = parseArgs(process.argv.slice(2));
  if (help || !seller) {
    console.log("usage: vet402-cert <seller host or payTo> [--yes]\n  without --yes: shows the plan for free\n  with --yes: pays the audit from ALGORAND_MNEMONIC and prints the certificate URL");
    process.exit(seller || help ? 0 : 1);
  }
  const network = (process.env.VET402_NETWORK ?? "mainnet").toLowerCase();
  if (!(network in NETWORKS)) throw new Error("VET402_NETWORK must be mainnet or testnet");
  const base = (process.env.VET402_URL ?? DEFAULT_URL).replace(/\/+$/, "");
  const url = `${base}/v1/audit?seller=${encodeURIComponent(seller)}`;
  const maxAtomic = usdcToAtomic(process.env.MAX_USDC ?? "0.50");

  // 1) Free plan.
  const free = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  const body = await free.json().catch(() => ({}));
  if (free.status !== 402) {
    console.log(`vet402 answered HTTP ${free.status}: ${body.error ?? ""} ${body.detail ?? ""}`.trim());
    console.log("Nothing was paid.");
    process.exit(1);
  }
  const pr = JSON.parse(Buffer.from(free.headers.get("payment-required") ?? "", "base64").toString() || "{}");
  const accept = (pr.accepts ?? [])[0] ?? {};
  const a = body.audit ?? {};
  console.log(`Seller ${seller}: ${a.found ?? "?"} resource(s) listed, vet402 would look at ${a.checking ?? "?"} and pay for ${a.paying ?? "?"} (${a.plannedSpendUsdc ?? "?"} USDC from its own wallet).`);
  for (const t of a.targets ?? []) console.log(`  ${t.willPay ? "buy " : "look"} ${t.method} ${t.url}  (${t.listedPriceUsdc} USDC)`);
  const price = /^\d+$/.test(String(accept.amount)) ? Number(accept.amount) / 1e6 : NaN;
  if (!yes) {
    console.log(`\nThe certificate costs ${price} USDC. To pay and get it, run again with --yes and ALGORAND_MNEMONIC set.`);
    return;
  }

  // 2) Pay and get the certificate.
  const mnemonic = process.env.ALGORAND_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("ALGORAND_MNEMONIC (25 words of the paying wallet) is required with --yes. Nothing was paid.");
  const [{ x402Client, wrapFetchWithPayment }, { ExactAvmScheme, toClientAvmSigner }, { AlgorandClient }, { seedFromMnemonic }] = await Promise.all([
    import("@x402/fetch"),
    import("@x402/avm"),
    import("@algorandfoundation/algokit-utils"),
    import("@algorandfoundation/algokit-utils/algo25"),
  ]);
  let sk;
  try {
    sk = secretKeyFromSeed(seedFromMnemonic(mnemonic));
  } catch {
    throw new Error("ALGORAND_MNEMONIC could not be decoded (expected 25 Algorand words). Nothing was paid.");
  }
  const lock = { network, maxAtomic, payTo: payToLock(base, network) };
  const net = NETWORKS[network];
  const scheme = new ExactAvmScheme(toClientAvmSigner(sk), { algorandClient: network === "testnet" ? AlgorandClient.testNet() : AlgorandClient.mainNet() });
  const client = new x402Client();
  client.register(net.caip2, scheme);
  client.register(`algorand:${net.caip2.slice(9, 41)}`, scheme);
  client.registerPolicy((_v, reqs) => reqs.filter((r) => allowedRequirement(r, lock)));
  let signed = 0;
  client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
    if (signed >= 1) return { abort: true, reason: "one payment per run" };
    if (!allowedRequirement(r, lock)) return { abort: true, reason: "not vet402's audit price or address" };
    return undefined;
  });
  client.onAfterPaymentCreation(async () => {
    signed += 1;
  });
  console.log("\nPaying vet402 and running the audit (this can take a few minutes)...");
  const res = await wrapFetchWithPayment(fetch, client)(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(330_000) });
  const out = await res.json().catch(() => ({}));
  if (res.status !== 200) {
    console.log(`vet402 answered HTTP ${res.status}: ${out.error ?? ""} ${out.detail ?? ""}`.trim());
    console.log(signed ? "A payment was signed; if it settled, its tx is on-chain." : "Nothing was paid.");
    process.exit(1);
  }
  console.log(`Your payment: ${out.customerPayment?.transaction}`);
  for (const r of out.results ?? []) {
    console.log(`  ${String(r.class).toUpperCase().padEnd(11)} ${String(r.reason ?? "").padEnd(22)} ${r.resourceUrl}${r.downstreamPayment?.transaction ? `  vet402 paid: ${r.downstreamPayment.transaction}` : ""}`);
  }
  if (out.certificateUrl) {
    const clean = String(out.certificateUrl).split("?")[0];
    console.log(`\nCertificate: ${out.certificateUrl}${out.certificatePending ? "  (still being recorded on Algorand; the page shows it within a minute)" : ""}`);
    console.log(`Badge (Markdown): [![vet402 delivery certificate](${clean}/badge.svg)](${clean})`);
  }
  else console.log(`\nNo certificate: ${out.certificateError ?? "this vet402 does not issue certificates"}`);
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((e) => {
    console.error(`vet402-cert: ${e.message ?? e}`);
    process.exit(1);
  });
}
