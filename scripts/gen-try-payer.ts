/**
 * Generates the free-trial wallet (/try/run) and writes it to .env.try.local (gitignored, mode 0600).
 * Prints the ADDRESS ONLY. Generating a key moves no funds. It must stay separate from the customer
 * payTo, the /v1/check payer and the board's sweep wallet. Funding (ALGO for note fees, USDC opt-in,
 * USDC for trials) and copying TRY_PAYER_MNEMONIC into the deploy env are operator steps.
 */
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mnemonicFromSeed } from "@algorandfoundation/algokit-utils/algo25";
import { addressFromSeed } from "../src/keys.js";

const FILE = ".env.try.local";
if (existsSync(FILE)) {
  console.log(`${FILE} already exists; not overwriting.`);
  process.exit(0);
}
const seed = randomBytes(32);
const address = addressFromSeed(seed);
const lines = [
  "# vet402 free-trial wallet (/try/run). NEVER commit. Copy TRY_PAYER_MNEMONIC into the deploy env as a secret.",
  `TRY_PAYER_ADDRESS=${address}`,
  `TRY_PAYER_MNEMONIC="${mnemonicFromSeed(seed)}"`,
  "TRY_MAX_PER_DAY_USDC=3.00",
  "",
];
writeFileSync(FILE, lines.join("\n"), { mode: 0o600 });
console.log(`wrote ${FILE} (mode 600). Trial wallet address: ${address}`);
