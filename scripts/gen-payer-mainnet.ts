/**
 * Generates the MainNet PAYER wallet (the account vet402 pays sellers from) and
 * writes it to .env.mainnet.local (gitignored, mode 0600). Prints the ADDRESS ONLY.
 * Generating a key moves no funds. Funding and USDC opt-in are owner steps.
 */
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { mnemonicFromSeed } from "@algorandfoundation/algokit-utils/algo25";
import { addressFromSeed } from "../src/keys.js";

const FILE = ".env.mainnet.local";
if (existsSync(FILE)) {
  console.log(`${FILE} already exists; not overwriting.`);
  process.exit(0);
}
const seed = randomBytes(32);
const address = addressFromSeed(seed);
const lines = [
  "# vet402 MainNet payer wallet. NEVER commit. Copy PAYER_MNEMONIC into the deploy env as a secret.",
  `PAYER_ADDRESS=${address}`,
  `PAYER_MNEMONIC="${mnemonicFromSeed(seed)}"`,
  "",
];
writeFileSync(FILE, lines.join("\n"), { mode: 0o600 });
console.log(`wrote ${FILE} (mode 600). MainNet payer address: ${address}`);
