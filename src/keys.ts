import { readFileSync, existsSync } from "node:fs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { seedFromMnemonic } from "@algorandfoundation/algokit-utils/algo25";
import { encodeAddress } from "@algorandfoundation/algokit-utils/common";

export type Role = "client" | "vet402" | "seller";

export interface StoredAccount {
  address: string;
  mnemonic: string;
}

export type KeysFile = Record<Role, StoredAccount>;

/** Ed25519 PKCS#8 DER prefix; appending the 32-byte seed yields a private key. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function publicKeyFromSeed(seed: Uint8Array): Uint8Array {
  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  return new Uint8Array(spki.subarray(spki.length - 32));
}

export function addressFromSeed(seed: Uint8Array): string {
  return encodeAddress(publicKeyFromSeed(seed));
}

/**
 * Base64 of seed(32) || pubkey(32): the 64-byte secret key format that
 * `toClientAvmSigner` from @x402/avm expects (same as the official tutorial).
 */
export function secretKeyB64FromMnemonic(mnemonic: string): string {
  const seed = seedFromMnemonic(mnemonic);
  return Buffer.concat([Buffer.from(seed), Buffer.from(publicKeyFromSeed(seed))]).toString("base64");
}

export function loadKeys(path: string): KeysFile {
  if (!existsSync(path)) {
    throw new Error(`keys file not found: ${path} (run: npm run keys:gen)`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as KeysFile;
}

export interface Payer {
  address: string;
  secretKeyB64: string;
}

/**
 * The wallet vet402 pays sellers from.
 * PAYER_MNEMONIC (env, e.g. from .env.mainnet.local or Vercel env) wins;
 * on TestNet it falls back to the `vet402` account in the keys file.
 */
export function loadPayer(networkName: string, keysFile: string, env: NodeJS.ProcessEnv = process.env): Payer {
  const m = env.PAYER_MNEMONIC?.trim();
  if (m) {
    const seed = seedFromMnemonic(m);
    return { address: addressFromSeed(seed), secretKeyB64: secretKeyB64FromMnemonic(m) };
  }
  if (networkName === "mainnet") throw new Error("PAYER_MNEMONIC is required on MainNet (.env.mainnet.local or deploy env)");
  const k = loadKeys(keysFile).vet402;
  return { address: k.address, secretKeyB64: secretKeyB64FromMnemonic(k.mnemonic) };
}
