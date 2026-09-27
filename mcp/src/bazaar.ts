/**
 * Algorand x402 endpoints from the Bazaar discovery feed (free, no payment).
 *
 * The feed is paginated: `limit` tops out at 200 while the feed holds thousands
 * of resources, so a single page misses most of them (vet402's own entry
 * included). All pages are read and the Algorand ones kept.
 */
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
} from "@x402/avm";
import { normalizeNetwork } from "../../src/declaration.js";

export const BAZAAR_DEFAULT_URL = "https://facilitator.goplausible.xyz/discovery/resources";
const PAGE = 200;
const MAX_PAGES = 50;

export interface BazaarAccept {
  scheme?: string;
  network?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
}

export interface BazaarItem {
  resourceUrl?: string;
  resource?: string;
  method?: string;
  description?: string;
  accepts?: BazaarAccept[];
  settleCount?: number;
  lastSeen?: string;
}

interface BazaarPage {
  items?: BazaarItem[];
  pagination?: { limit?: number; offset?: number; total?: number };
}

export type NetworkFilter = "mainnet" | "testnet" | "any";

export interface Endpoint {
  url: string;
  method: string;
  description: string;
  network: "mainnet" | "testnet" | "other";
  price: string;
  payTo?: string;
  settleCount?: number;
  lastSeen?: string;
}

const MAIN = normalizeNetwork(ALGORAND_MAINNET_CAIP2);
const TEST = normalizeNetwork(ALGORAND_TESTNET_CAIP2);
const USDC = new Set([String(USDC_MAINNET_ASA_ID), String(USDC_TESTNET_ASA_ID)]);

export function networkLabel(n: string): Endpoint["network"] {
  const k = normalizeNetwork(n);
  return k === MAIN ? "mainnet" : k === TEST ? "testnet" : "other";
}

function priceOf(a: BazaarAccept): string {
  const amt = String(a.amount ?? "");
  if (!/^\d+$/.test(amt)) return "unknown";
  if (USDC.has(String(a.asset))) {
    const v = BigInt(amt);
    const frac = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return `${v / 1_000_000n}${frac ? `.${frac}` : ""} USDC`;
  }
  return `${amt} atomic of ASA ${a.asset ?? "?"}`;
}

/** Keep resources that accept payment on an Algorand network; match `query` against URL and description. */
export function algorandEndpoints(items: BazaarItem[], opts: { query?: string; network?: NetworkFilter } = {}): Endpoint[] {
  const q = opts.query?.trim().toLowerCase();
  const want = opts.network ?? "any";
  const out: Endpoint[] = [];
  for (const it of items) {
    const url = it.resourceUrl ?? it.resource;
    if (!url) continue;
    const accept = (it.accepts ?? []).find((a) => {
      if (!a.network?.startsWith("algorand:")) return false;
      return want === "any" || networkLabel(a.network) === want;
    });
    if (!accept?.network) continue;
    const description = String(it.description ?? "");
    if (q && !`${url}\n${description}`.toLowerCase().includes(q)) continue;
    out.push({
      url,
      method: it.method ?? "GET",
      description: description.length > 300 ? `${description.slice(0, 297)}...` : description,
      network: networkLabel(accept.network),
      price: priceOf(accept),
      payTo: accept.payTo,
      settleCount: it.settleCount,
      lastSeen: it.lastSeen,
    });
  }
  return out.sort((a, b) => (b.settleCount ?? 0) - (a.settleCount ?? 0));
}

async function getPage(base: string, offset: number, fetchImpl: typeof fetch): Promise<BazaarPage> {
  const u = new URL(base);
  u.searchParams.set("limit", String(PAGE));
  u.searchParams.set("offset", String(offset));
  const res = await fetchImpl(u, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Bazaar feed answered HTTP ${res.status} at offset ${offset}`);
  return (await res.json()) as BazaarPage;
}

/** Reads every page of the feed (first page gives the total; the rest in parallel). */
export async function fetchAllResources(base = BAZAAR_DEFAULT_URL, fetchImpl: typeof fetch = fetch): Promise<BazaarItem[]> {
  const first = await getPage(base, 0, fetchImpl);
  const items = [...(first.items ?? [])];
  const total = Number(first.pagination?.total ?? items.length);
  const offsets: number[] = [];
  for (let o = PAGE; o < total && offsets.length < MAX_PAGES - 1; o += PAGE) offsets.push(o);
  const pages = await Promise.all(offsets.map((o) => getPage(base, o, fetchImpl)));
  for (const p of pages) items.push(...(p.items ?? []));
  return items;
}

const CACHE_MS = 5 * 60_000;
let cache: { at: number; base: string; items: BazaarItem[] } | null = null;

export async function cachedResources(base = BAZAAR_DEFAULT_URL, fetchImpl: typeof fetch = fetch): Promise<BazaarItem[]> {
  if (cache && cache.base === base && Date.now() - cache.at < CACHE_MS) return cache.items;
  const items = await fetchAllResources(base, fetchImpl);
  cache = { at: Date.now(), base, items };
  return items;
}
