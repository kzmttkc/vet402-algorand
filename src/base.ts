/**
 * Customers may pay vet402 in Base USDC (BASE_ACCEPT=on, off by default).
 *
 * Only the customer -> vet402 leg can be on Base. vet402 holds no Base key: BASE_PAY_TO only receives.
 * Sellers are still paid on Algorand from vet402's Algorand wallet, after the customer's payment has
 * settled (settle-first.ts does not care which chain the customer paid on).
 *
 * Every paid route keeps its Algorand accept first and, when the switch is on, gets a second accept:
 * exact / Base USDC / payTo BASE_PAY_TO / the same atomic amount (both USDC have 6 decimals) /
 * extra.tag = the challenge tag. With the switch off nothing here is used and the 402s are unchanged.
 *
 * /activity: the Algorand indexer does not see Base. `BaseCustomerReader` lists USDC transfers into
 * BASE_PAY_TO from a keyless Blockscout API, then proves each one from the chain itself (public RPC
 * receipt): an x402 settlement through the GoPlausible facilitator is a successful transaction SENT BY
 * the facilitator's EVM signer TO the USDC contract (transferWithAuthorization, EIP-3009), whose logs
 * hold USDC's AuthorizationUsed and a Transfer to payTo. Checked against Base MainNet data on
 * 2026-09-27 (tx 0x27156fea…: from 0x13600897… = GoPlausible's eip155 signer in /supported).
 * Plain transfers (a wallet's own transfer/transferFrom) are sent by someone else and are not counted.
 */
import type { PaymentOption } from "@x402/core/http";
import type { HTTPRequestContext } from "@x402/core/server";
import type { AppConfig, BaseAcceptConfig } from "./config.js";

type Money = `$${string}`;
type AssetPrice = { amount: string; extra?: Record<string, unknown> };
export type BasePrice = Money | ((ctx: HTTPRequestContext) => Promise<AssetPrice>);

/**
 * The Base accept for a route, or null when BASE_ACCEPT is off.
 * `price`: a "$0.05" string (same as the Algorand accept), or a function returning the atomic amount
 * (and extra) for this request, the same amount the Algorand accept asks for.
 */
export function baseAccept(cfg: AppConfig, price: BasePrice): PaymentOption | null {
  const b = cfg.base;
  if (!b) return null;
  const domain = { name: b.usdcName, version: b.usdcVersion };
  return {
    scheme: "exact",
    network: b.network,
    payTo: b.payTo,
    // A dynamic price is an AssetAmount: name the contract and its EIP-712 domain (the buyer signs over it).
    price:
      typeof price === "string"
        ? price
        : async (ctx) => {
            const p = await price(ctx);
            return { amount: p.amount, asset: b.usdc, extra: { ...domain, ...(p.extra ?? {}) } };
          },
    extra: { tag: cfg.challengeTag },
  };
}

/** [algorand] or [algorand, base]: the Algorand accept always stays first. */
export function withBase(cfg: AppConfig, algorand: PaymentOption, price: BasePrice): PaymentOption[] {
  const b = baseAccept(cfg, price);
  return b ? [algorand, b] : [algorand];
}

/** USDC's AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce) (EIP-3009). */
export const AUTHORIZATION_USED_TOPIC = "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5";
/** ERC-20 Transfer(address indexed from, address indexed to, uint256 value). */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** GoPlausible facilitator's EVM signer (its /supported, signers["eip155:*"], 2026-09-27). */
export const GOPLAUSIBLE_EVM_SIGNERS = ["0x136008978ad053942dCDBE759A0903f5d84966fa"];

export interface BaseCustomerPayment {
  tx: string;
  block: number;
  logIndex: number;
  /** Unix seconds. */
  time: number;
  customer: string;
  amount: bigint;
}

export interface BaseNotCounted {
  tx: string;
  block: number;
  reason: "not_sent_by_x402_facilitator" | "no_eip3009_authorization" | "failed_or_unreadable";
}

export interface BaseCustomerRead {
  payments: BaseCustomerPayment[];
  notCounted: BaseNotCounted[];
}

interface BlockscoutTransfer {
  transaction_hash: string;
  block_number: number;
  log_index: number;
  timestamp: string;
  from: { hash: string };
  to: { hash: string };
  total: { value: string };
}

interface Receipt {
  status: string;
  from: string;
  to: string | null;
  logs: Array<{ address: string; topics: string[]; data: string; logIndex: string }>;
}

const lc = (s: string) => s.toLowerCase();
const topicAddr = (t: string | undefined) => (t && t.length === 66 ? `0x${t.slice(26)}`.toLowerCase() : "");

export interface BaseReaderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signers?: string[];
  /** Most Blockscout pages read per refresh (50 transfers each). */
  maxPages?: number;
}

/** Reads and proves Base customer payments to `base.payTo`. Nothing here signs or sends anything. */
export class BaseCustomerReader {
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  readonly signers: string[];
  private readonly maxPages: number;
  /** Confirmed receipts never change: remember the verdict for good. */
  private readonly proven = new Map<string, { ok: true; customer: string; amount: bigint } | { ok: false; reason: BaseNotCounted["reason"] }>();

  constructor(readonly base: BaseAcceptConfig, o: BaseReaderOptions = {}) {
    this.f = o.fetchImpl ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 8000;
    this.signers = o.signers ?? GOPLAUSIBLE_EVM_SIGNERS;
    this.maxPages = o.maxPages ?? 10;
  }

  private async transfersIn(): Promise<BlockscoutTransfer[]> {
    const out: BlockscoutTransfer[] = [];
    let next: Record<string, unknown> | null = null;
    for (let page = 0; page < this.maxPages; page++) {
      const q = new URLSearchParams({ type: "ERC-20", filter: "to", token: this.base.usdc });
      if (next) for (const [k, v] of Object.entries(next)) q.set(k, String(v));
      const res = await this.f(`${this.base.explorerApiUrl}/api/v2/addresses/${this.base.payTo}/token-transfers?${q}`, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status === 404) return out; // an address Blockscout has never seen: no transfers
      if (!res.ok) throw new Error(`base explorer ${res.status}`);
      const body = (await res.json()) as { items?: BlockscoutTransfer[]; next_page_params?: Record<string, unknown> | null };
      if (!Array.isArray(body.items)) throw new Error("base explorer: malformed response");
      out.push(...body.items);
      next = body.next_page_params ?? null;
      if (!next || body.items.length === 0) return out;
    }
    throw new Error("base explorer: too many pages");
  }

  private async receipt(tx: string): Promise<Receipt | null> {
    const res = await this.f(this.base.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [tx] }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`base rpc ${res.status}`);
    const body = (await res.json()) as { result?: Receipt | null; error?: { message?: string } };
    if (body.error) throw new Error(`base rpc: ${String(body.error.message ?? "error").slice(0, 100)}`);
    return body.result ?? null;
  }

  /** Is `tx` an x402 settlement into payTo? Decided from the receipt only (not from the explorer's fields). */
  async prove(tx: string): Promise<{ ok: true; customer: string; amount: bigint } | { ok: false; reason: BaseNotCounted["reason"] }> {
    const known = this.proven.get(tx);
    if (known) return known;
    const r = await this.receipt(tx);
    if (!r) return { ok: false, reason: "failed_or_unreadable" }; // not mined yet: not cached, asked again next time
    const usdc = lc(this.base.usdc);
    const payTo = lc(this.base.payTo);
    let out: { ok: true; customer: string; amount: bigint } | { ok: false; reason: BaseNotCounted["reason"] };
    if (r.status !== "0x1") out = { ok: false, reason: "failed_or_unreadable" };
    else if (!this.signers.map(lc).includes(lc(r.from)) || lc(r.to ?? "") !== usdc) out = { ok: false, reason: "not_sent_by_x402_facilitator" };
    else {
      const usdcLogs = r.logs.filter((l) => lc(l.address) === usdc);
      const auth = usdcLogs.find((l) => lc(l.topics[0] ?? "") === AUTHORIZATION_USED_TOPIC);
      const transfer = usdcLogs.find((l) => lc(l.topics[0] ?? "") === TRANSFER_TOPIC && topicAddr(l.topics[2]) === payTo);
      // The authorizer of the EIP-3009 transfer must be the one whose USDC moved (the customer).
      if (!auth || !transfer || topicAddr(auth.topics[1]) !== topicAddr(transfer.topics[1])) out = { ok: false, reason: "no_eip3009_authorization" };
      else out = { ok: true, customer: topicAddr(transfer.topics[1]), amount: BigInt(transfer.data) };
    }
    this.proven.set(tx, out);
    return out;
  }

  async read(): Promise<BaseCustomerRead> {
    const items = await this.transfersIn();
    const payments: BaseCustomerPayment[] = [];
    const notCounted: BaseNotCounted[] = [];
    const seen = new Set<string>();
    for (const t of items) {
      if (lc(t.to?.hash ?? "") !== lc(this.base.payTo) || seen.has(t.transaction_hash)) continue;
      seen.add(t.transaction_hash);
      const p = await this.prove(t.transaction_hash);
      if (!p.ok) {
        notCounted.push({ tx: t.transaction_hash, block: t.block_number, reason: p.reason });
        continue;
      }
      if (p.amount <= 0n) continue;
      payments.push({ tx: t.transaction_hash, block: t.block_number, logIndex: t.log_index, time: Math.floor(Date.parse(t.timestamp) / 1000), customer: p.customer, amount: p.amount });
    }
    return { payments, notCounted };
  }
}
