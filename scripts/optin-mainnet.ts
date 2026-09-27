/**
 * One-off: opt the MainNet payer wallet into USDC (ASA 31566704).
 * Reads PAYER_MNEMONIC from .env.mainnet.local. Prints the address and tx id only.
 */
import { readFileSync } from "node:fs";
import { AlgorandClient } from "@algorandfoundation/algokit-utils";

const env = readFileSync(".env.mainnet.local", "utf8");
const m = env.match(/^PAYER_MNEMONIC="([^"]+)"/m);
if (!m) throw new Error("PAYER_MNEMONIC missing in .env.mainnet.local");
const USDC = 31566704n;
const algorand = AlgorandClient.mainNet();
const acct = algorand.account.fromMnemonic(m[1]);
console.log("payer", acct.addr.toString());
const r = await algorand.send.assetOptIn({ sender: acct.addr, assetId: USDC });
console.log("USDC opt-in tx", r.txIds[0], "round", r.confirmation.confirmedRound);
