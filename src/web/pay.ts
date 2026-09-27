/**
 * Browser side of /try: pay GET /v1/buy with an Algorand wallet (x402 v2, exact, USDC).
 *
 * DOM-free on purpose: the same function runs in the page (with Pera or Lute) and in the
 * TestNet end-to-end script (with a TestNet key), so what is tested is what the page runs.
 *
 * Nothing is paid unless:
 *   - vet402 answers the unpaid request with a 402 whose amount equals `expectedTotalAtomic`
 *     (the total the page showed the user before they pressed the button), and
 *   - that amount is at most `maxTotalAtomic`, and
 *   - the wallet signs (the user approves in the wallet).
 * One payment per call.
 */
import { AlgorandClient } from "@algorandfoundation/algokit-utils/algorand-client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import type { ClientAvmSigner } from "@x402/avm";

export type TryNetwork = "testnet" | "mainnet";

export const NETWORKS: Record<TryNetwork, { caip2: string; usdc: string; genesisId: string; peraChainId: 416001 | 416002; algod: string }> = {
  mainnet: {
    caip2: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    usdc: "31566704",
    genesisId: "mainnet-v1.0",
    peraChainId: 416001,
    algod: "https://mainnet-api.algonode.cloud",
  },
  testnet: {
    caip2: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
    usdc: "10458941",
    genesisId: "testnet-v1.0",
    peraChainId: 416002,
    algod: "https://testnet-api.algonode.cloud",
  },
};

/** Largest seller price the page offers to buy (atomic USDC): 0.10 USDC. */
export const TRY_MAX_SELLER_ATOMIC = 100_000n;

export interface BuyPlan {
  /** vet402 origin, e.g. "" (same origin) or "http://localhost:4021". */
  vet402Base: string;
  target: string;
  network: TryNetwork;
  /** The total the user was shown (atomic USDC, string of digits). */
  expectedTotalAtomic: string;
  maxTotalAtomic: bigint;
  /** The paying address: asks vet402 for the first-purchase price (no fee) when it has never paid vet402. */
  payer?: string;
}

export interface BuyResult {
  status: number;
  contentType: string;
  /** Seller body as text (the page shows at most a few KB of it). */
  bodyText: string;
  bytes: number;
  verdict?: string;
  reason?: string;
  customerTx?: string;
  sellerTx?: string;
  sellerStatus?: string;
  /** JSON error body from vet402 (402 / 4xx / 5xx). */
  error?: Record<string, unknown>;
}

export class PriceChangedError extends Error {
  constructor(readonly newTotalAtomic: string | null) {
    super(newTotalAtomic ? `the price changed to ${newTotalAtomic} atomic USDC; nothing was paid` : "vet402 did not offer a payable price; nothing was paid");
    this.name = "PriceChangedError";
  }
}

export class RefusedError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.detail ?? body.reason ?? body.error ?? `HTTP ${status}`));
    this.name = "RefusedError";
  }
}

export function buyUrl(base: string, target: string, payer?: string): string {
  return `${base.replace(/\/+$/, "")}/v1/buy?url=${encodeURIComponent(target)}${payer ? `&payer=${encodeURIComponent(payer)}` : ""}`;
}

const digits = (v: unknown) => typeof v === "string" && /^\d+$/.test(v);

async function jsonOrEmpty(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Read vet402's 402 for the target, check the amount is the one shown, have the wallet sign
 * exactly that, and send the paid request. Throws before any signature when anything differs.
 */
export async function payAndBuy(
  signer: ClientAvmSigner,
  plan: BuyPlan,
  o: { fetchImpl?: typeof fetch; algorandClient?: AlgorandClient; onStep?: (step: "price" | "sign" | "send") => void } = {},
): Promise<BuyResult> {
  const f = o.fetchImpl ?? ((u: RequestInfo | URL, i?: RequestInit) => fetch(u, i));
  const net = NETWORKS[plan.network];
  if (!digits(plan.expectedTotalAtomic)) throw new PriceChangedError(null);
  if (BigInt(plan.expectedTotalAtomic) > plan.maxTotalAtomic) throw new PriceChangedError(plan.expectedTotalAtomic);
  const url = buyUrl(plan.vet402Base, plan.target, plan.payer);

  o.onStep?.("price");
  const first = await f(url, { method: "GET", headers: { accept: "application/json" } });
  if (first.status !== 402) throw new RefusedError(first.status, await jsonOrEmpty(first));

  const scheme = new ExactAvmScheme(signer, { algorandClient: o.algorandClient ?? AlgorandClient.fromConfig({ algodConfig: { server: net.algod, token: "" } }) });
  const client = new x402Client();
  client.register(net.caip2 as `${string}:${string}`, scheme);
  const want = plan.expectedTotalAtomic;
  client.registerPolicy((_v, reqs) =>
    reqs.filter((r) => r.scheme === "exact" && r.network === net.caip2 && String(r.asset) === net.usdc && String(r.amount) === want),
  );
  let signed = 0;
  client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
    if (signed >= 1) return { abort: true, reason: "one payment per purchase" };
    if (String(r.amount) !== want || BigInt(r.amount) > plan.maxTotalAtomic) return { abort: true, reason: "price differs from the one shown" };
    return undefined;
  });
  client.onAfterPaymentCreation(async () => {
    signed += 1;
  });
  const http = new x402HTTPClient(client);
  const body = await jsonOrEmpty(first);
  let pr: PaymentRequired;
  try {
    pr = http.getPaymentRequiredResponse((n) => first.headers.get(n), body);
  } catch {
    throw new RefusedError(402, { error: "unreadable_402", detail: "vet402's payment request could not be read. Nothing was paid." });
  }
  const offered = pr.accepts.find((a) => a.scheme === "exact" && a.network === net.caip2 && String(a.asset) === net.usdc);
  if (!offered || String(offered.amount) !== want) throw new PriceChangedError(offered && digits(String(offered.amount)) ? String(offered.amount) : null);

  o.onStep?.("sign");
  const payload = await client.createPaymentPayload(pr); // the wallet asks the user here
  o.onStep?.("send");
  const paid = await f(url, { method: "GET", headers: { ...http.encodePaymentSignatureHeader(payload) } });

  const h = (n: string) => paid.headers.get(n) ?? undefined;
  let customerTx = h("x-vet402-customer-tx");
  if (!customerTx) {
    try {
      const s = http.getPaymentSettleResponse((n) => paid.headers.get(n));
      if (s.success && s.transaction) customerTx = s.transaction;
    } catch {
      /* no settle header: not settled */
    }
  }
  const contentType = h("content-type") ?? "";
  const buf = new Uint8Array(await paid.arrayBuffer());
  const bodyText = new TextDecoder().decode(buf.slice(0, 64 * 1024));
  const out: BuyResult = {
    status: paid.status,
    contentType,
    bodyText,
    bytes: buf.byteLength,
    verdict: h("x-vet402-verdict"),
    reason: h("x-vet402-reason"),
    customerTx,
    sellerTx: h("x-vet402-seller-tx"),
    sellerStatus: h("x-vet402-seller-status"),
  };
  if (paid.status !== 200) {
    try {
      out.error = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  }
  return out;
}

/* ---------- wallets ---------- */

export interface WalletConnection {
  name: "Pera" | "Lute";
  signer: ClientAvmSigner;
  disconnect(): Promise<void>;
}

const b64 = (u: Uint8Array) => {
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Pera (mobile app by QR / deep link, or the Pera web wallet). Signs only the user's transaction; the fee payer's is left to the facilitator. */
export async function connectPera(network: TryNetwork): Promise<WalletConnection> {
  const [{ PeraWalletConnect }, algosdk] = await Promise.all([import("@perawallet/connect"), import("algosdk")]);
  const pera = new PeraWalletConnect({ chainId: NETWORKS[network].peraChainId });
  let accounts: string[];
  try {
    accounts = await pera.reconnectSession();
  } catch {
    accounts = [];
  }
  if (!accounts.length) accounts = await pera.connect();
  const address = accounts[0];
  if (!address) throw new Error("Pera returned no account");
  return {
    name: "Pera",
    signer: {
      address,
      async signTransactions(txns, indexesToSign) {
        const mine = (i: number) => !indexesToSign || indexesToSign.includes(i);
        const group = txns.map((t, i) => ({ txn: algosdk.decodeUnsignedTransaction(t), ...(mine(i) ? {} : { signers: [] as string[] }) }));
        const signed = await pera.signTransaction([group], address);
        let k = 0;
        return txns.map((_t, i) => (mine(i) ? (signed[k++] ?? null) : null));
      },
    },
    disconnect: () => pera.disconnect(),
  };
}

type LuteCtor = new (siteName?: string) => {
  connect(genesisID: string): Promise<string[]>;
  signTxns(txns: { txn: string; signers?: string[] }[]): Promise<(Uint8Array | null)[]>;
};

/** Lute (lute.app web wallet or its browser extension). */
export async function connectLute(network: TryNetwork): Promise<WalletConnection> {
  const mod = (await import("lute-connect")) as unknown as { default: LuteCtor | { default: LuteCtor } };
  const LuteConnect: LuteCtor = typeof mod.default === "function" ? mod.default : mod.default.default;
  const lute = new LuteConnect("vet402");
  const accounts = await lute.connect(NETWORKS[network].genesisId);
  const address = accounts[0];
  if (!address) throw new Error("Lute returned no account");
  return {
    name: "Lute",
    signer: {
      address,
      async signTransactions(txns, indexesToSign) {
        const mine = (i: number) => !indexesToSign || indexesToSign.includes(i);
        const signed = await lute.signTxns(txns.map((t, i) => ({ txn: b64(t), ...(mine(i) ? {} : { signers: [] }) })));
        return txns.map((_t, i) => {
          const s = signed[i] as Uint8Array | string | null | undefined;
          if (!mine(i) || !s) return null;
          return typeof s === "string" ? unb64(s) : s;
        });
      },
    },
    disconnect: async () => {},
  };
}
