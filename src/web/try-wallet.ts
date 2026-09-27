/**
 * Browser entry for /try/wallet.js (bundled by scripts/build-wallet.ts, served by /try/wallet.js).
 * Exposes window.vet402Wallet for the inline /try script: connect a wallet, then pay /v1/buy.
 * Nothing here pays by itself: payAndBuy() asks the wallet, and the user approves there.
 */
import { Buffer } from "buffer";
import { connectLute, connectPera, payAndBuy, NETWORKS, TRY_MAX_SELLER_ATOMIC, type TryNetwork, type WalletConnection } from "./pay.js";

const g = globalThis as unknown as { Buffer?: typeof Buffer; global?: unknown; vet402Wallet?: unknown };
g.Buffer ??= Buffer;
g.global ??= globalThis;

let conn: WalletConnection | null = null;

g.vet402Wallet = {
  networks: NETWORKS,
  maxSellerAtomic: TRY_MAX_SELLER_ATOMIC.toString(),
  async connect(kind: "pera" | "lute", network: TryNetwork) {
    if (conn) await conn.disconnect().catch(() => {});
    conn = kind === "pera" ? await connectPera(network) : await connectLute(network);
    return { name: conn.name, address: conn.signer.address };
  },
  address: () => conn?.signer.address ?? null,
  async buy(o: { target: string; network: TryNetwork; expectedTotalAtomic: string; feeAtomic: string; onStep?: (s: string) => void }) {
    if (!conn) throw new Error("connect a wallet first");
    const max = TRY_MAX_SELLER_ATOMIC + BigInt(o.feeAtomic);
    return payAndBuy(conn.signer, { vet402Base: location.origin, target: o.target, network: o.network, expectedTotalAtomic: o.expectedTotalAtomic, maxTotalAtomic: max, payer: conn.signer.address }, { onStep: o.onStep });
  },
};
window.dispatchEvent(new Event("vet402-wallet-ready"));
