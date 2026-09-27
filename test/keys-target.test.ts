import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mnemonicFromSeed } from "@algorandfoundation/algokit-utils/algo25";
import { ed25519SigningKeyFromWrappedSecret } from "@algorandfoundation/algokit-utils/crypto";
import { encodeAddress } from "@algorandfoundation/algokit-utils/common";
import { toClientAvmSigner } from "@x402/avm";
import { addressFromSeed, publicKeyFromSeed, secretKeyB64FromMnemonic } from "../src/keys.js";
import { checkTarget, isPrivateAddress } from "../src/target.js";

test("our ed25519 pubkey derivation matches algokit's (tutorial path)", async () => {
  const seed = new Uint8Array(randomBytes(32));
  const k = await ed25519SigningKeyFromWrappedSecret({ unwrapEd25519Seed: async () => new Uint8Array(seed), wrapEd25519Seed: async () => {} });
  assert.deepEqual(Buffer.from(publicKeyFromSeed(seed)), Buffer.from(k.ed25519Pubkey));
  assert.equal(addressFromSeed(seed), encodeAddress(k.ed25519Pubkey));
});

test("secret key from mnemonic produces a signer with the same address", () => {
  const seed = new Uint8Array(randomBytes(32));
  const m = mnemonicFromSeed(seed);
  const signer = toClientAvmSigner(secretKeyB64FromMnemonic(m));
  assert.equal(signer.address, addressFromSeed(seed));
});

test("private address detection", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("checkTarget rejects bad schemes, credentials, http and private hosts in strict mode", async () => {
  const pub = async () => ["8.8.8.8"];
  assert.equal((await checkTarget("file:///etc/passwd", false, pub)).ok, false);
  assert.equal((await checkTarget("https://u:p@example.com/", false, pub)).ok, false);
  assert.equal((await checkTarget("http://example.com/", false, pub)).ok, false);
  assert.equal((await checkTarget("https://localhost/", false, async () => ["127.0.0.1"])).ok, false);
  assert.equal((await checkTarget("https://169.254.169.254/", false, pub)).ok, false);
  assert.equal((await checkTarget("https://example.com/x", false, pub)).ok, true);
  assert.equal((await checkTarget("http://localhost:4031/honest", true)).ok, true);
});
