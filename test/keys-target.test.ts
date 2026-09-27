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

// SSRF regression (review 2026-09-27): IPv4 hidden inside IPv6 in any spelling.
test("isPrivateAddress: IPv4-mapped/translated/NAT64/6to4/Teredo forms and metadata are private", () => {
  for (const ip of [
    "::ffff:7f00:1",
    "::ffff:127.0.0.1",
    "::FFFF:A9FE:A9FE",
    "::ffff:169.254.169.254",
    "::ffff:a00:1",
    "::127.0.0.1",
    "::ffff:0:7f00:1",
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "fd00:ec2::254",
    "fe80::1",
    "fe80::1%eth0",
    "ff02::1",
    "100.100.100.200",
    "100.64.0.1",
    "255.255.255.255",
    "0:0:0:0:0:ffff:7f00:0001",
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["::ffff:8.8.8.8", "::ffff:808:808", "2606:4700:4700::1111", "2a00:1450:4001::200e", "93.184.216.34"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("checkTarget: IPv6 literals that embed a private IPv4 are refused", async () => {
  for (const u of [
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:169.254.169.254]/latest/meta-data",
    "https://[::ffff:7f00:1]/",
    "https://[64:ff9b::a9fe:a9fe]/",
    "https://[2002:a9fe:a9fe::]/",
    "https://[::1]/",
  ]) {
    const r = await checkTarget(u, false, async () => assert.fail("literal IPs are not resolved"));
    assert.equal(r.ok, false, u);
  }
  // A hostname resolving to a mapped private address is refused too.
  const r = await checkTarget("https://seller.example/x", false, async () => ["93.184.216.34", "::ffff:7f00:1"]);
  assert.equal(r.ok, false);
});
