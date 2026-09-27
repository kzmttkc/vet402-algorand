/**
 * Generates fresh TestNet accounts (client, vet402, seller) and writes them to
 * .keys/testnet.json (gitignored, mode 0600). Prints ADDRESSES ONLY.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mnemonicFromSeed } from "@algorandfoundation/algokit-utils/algo25";
import { addressFromSeed, type KeysFile, type Role } from "../src/keys.js";
import { loadConfig } from "../src/config.js";

const cfg = loadConfig();
if (cfg.networkName !== "testnet") throw new Error("keys:gen only generates TestNet keys");

if (existsSync(cfg.keysFile) && !process.argv.includes("--force")) {
  console.log(`${cfg.keysFile} already exists; not overwriting (pass --force to replace).`);
  process.exit(0);
}

const roles: Role[] = ["client", "vet402", "seller"];
const out = {} as KeysFile;
for (const role of roles) {
  const seed = randomBytes(32);
  out[role] = { address: addressFromSeed(seed), mnemonic: mnemonicFromSeed(seed) };
}
mkdirSync(dirname(cfg.keysFile), { recursive: true, mode: 0o700 });
writeFileSync(cfg.keysFile, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });

console.log(`wrote ${cfg.keysFile} (mode 600). Addresses:`);
for (const role of roles) console.log(`  ${role.padEnd(7)} ${out[role].address}`);
