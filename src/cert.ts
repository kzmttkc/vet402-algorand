/**
 * Delivery certificate: a free public page for one paid seller audit.
 *
 *   GET /cert/:id              the certificate (id = the customer's audit payment tx id)
 *   GET /cert/:id/badge.svg    README badge
 *
 * Where the facts live (no server state, no new storage service):
 *   - the customer's audit payment: a USDC transfer to vet402's payTo (on-chain);
 *   - vet402's payments to the seller: USDC transfers from the payer wallet (on-chain);
 *   - the link between them and the verdicts: an "anchor", a 0-ALGO payment from the
 *     payer wallet to itself whose note carries the audit record (one atomic group of up
 *     to 16 notes). Only the payer's key can sign it, and a confirmed note cannot change.
 *
 * The x402 payments themselves carry no link: their note is "x402-payment-v2-<ms>"
 * (checked on MainNet, 2026-09-27), so the chain alone cannot tell which seller payments
 * belong to which audit. The anchor is that link.
 *
 * The page re-reads everything from the indexer on each (uncached) request and shows only
 * what it can read: the customer's payment must be an x402 settlement to payTo of at least
 * the audit price, the anchor must be sent by the payer to itself and name this very tx,
 * and each seller payment listed in it must be a USDC transfer from the payer after the
 * customer's payment. Anything else is a 404 (or a row marked "not verified").
 */
import type { Env, Hono } from "hono";
import { AlgorandClient, microAlgo } from "@algorandfoundation/algokit-utils";
import { getAlgokitSigner, toClientAvmSigner } from "@x402/avm";
import { encodeAddress } from "@algorandfoundation/algokit-utils/common";
import { atomicToUsdc, type AppConfig, type NetworkName } from "./config.js";
import { GOPLAUSIBLE_FEE_PAYERS, explorer, shortAddr } from "./activity.js";
import { esc } from "./board.js";
import type { AuditClass, AuditPlan, AuditRun } from "./audit.js";

export const CERT_NOTE_PREFIX = "vet402-cert/1:";
export const TXID_RE = /^[A-Z2-7]{52}$/;
const ADDR_RE = /^[A-Z2-7]{58}$/;
const NOTE_MAX_BYTES = 1024;
/** Largest atomic group on Algorand. */
const MAX_CHUNKS = 16;

/** What vet402 signs into the anchor. Short keys: it has to fit in notes. */
export interface CertRecord {
  v: 1;
  net: NetworkName;
  /** Customer's audit payment tx id (= the certificate id). */
  c: string;
  /** Seller as the customer named it (host or payTo). */
  s: string;
  /** The seller's payTo addresses in the plan (for the self-purchase check). */
  p: string[];
  r: CertRow[];
  /** Resources listed but not looked at. */
  n?: { found: number; notChecked: number };
  /** What the customer paid for this audit (atomic USDC). The page compares with this, not today's price. */
  pa?: string;
}

export interface CertRow {
  /** Resource URL (as listed). */
  u: string;
  m: string;
  v: "ALLOW" | "REFUSE" | "SKIPPED";
  k: AuditClass;
  /** reason */
  why: string;
  d?: string;
  /** vet402 -> seller tx id, when vet402 paid. */
  t?: string;
}

/** The record for one finished audit. */
export function buildCertRecord(
  networkName: NetworkName,
  plan: Pick<AuditPlan, "seller" | "targets" | "found" | "notChecked">,
  run: Pick<AuditRun, "results">,
  customerTx: string,
  paidAtomic?: string,
): CertRecord {
  return {
    v: 1,
    net: networkName,
    c: customerTx,
    s: plan.seller.slice(0, 200),
    p: [...new Set(plan.targets.map((t) => t.payTo))].filter((a) => ADDR_RE.test(a)).slice(0, 20),
    r: run.results.map((x) => {
      const tx = x.downstreamPayment?.success === true ? x.downstreamPayment.transaction : undefined;
      return {
        u: x.resourceUrl.slice(0, 300),
        m: x.method,
        v: x.verdict,
        k: x.class,
        why: x.reason.slice(0, 60),
        ...(x.detail ? { d: x.detail.slice(0, 160) } : {}),
        ...(tx && TXID_RE.test(tx) ? { t: tx } : {}),
      };
    }),
    n: { found: plan.found, notChecked: plan.notChecked.total },
    ...(paidAtomic && /^\d{1,15}$/.test(paidAtomic) ? { pa: paidAtomic } : {}),
  };
}

const header = (c: string, i: number, n: number) => `${CERT_NOTE_PREFIX}${c}:${i}/${n}:`;

/** Split the record into notes of at most 1024 bytes; shortens details, then URLs, if it would need more than 16. */
export function encodeCertNotes(rec: CertRecord): Uint8Array[] {
  const attempts: ((r: CertRecord) => CertRecord)[] = [
    (r) => r,
    (r) => ({ ...r, r: r.r.map((x) => ({ ...x, ...(x.d ? { d: x.d.slice(0, 60) } : {}) })) }),
    (r) => ({ ...r, r: r.r.map(({ d: _d, ...x }) => ({ ...x, u: x.u.slice(0, 120) })) }),
  ];
  for (const shrink of attempts) {
    const body = Buffer.from(JSON.stringify(shrink(rec)), "utf8");
    // Header is at most "vet402-cert/1:" + 52 + ":16/16:" bytes.
    const room = NOTE_MAX_BYTES - Buffer.byteLength(header(rec.c, MAX_CHUNKS, MAX_CHUNKS));
    const n = Math.max(1, Math.ceil(body.length / room));
    if (n > MAX_CHUNKS) continue;
    const out: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      out.push(new Uint8Array(Buffer.concat([Buffer.from(header(rec.c, i, n)), body.subarray(i * room, (i + 1) * room)])));
    }
    return out;
  }
  throw new Error("certificate record too large for one group of notes");
}

/** Join the notes of one anchor group back into the record; null if incomplete or not about `id`. */
export function decodeCertNotes(notes: Uint8Array[], id: string): CertRecord | null {
  const parts = new Map<number, Buffer>();
  let total = -1;
  const re = /^vet402-cert\/1:([A-Z2-7]{52}):(\d{1,2})\/(\d{1,2}):/;
  for (const raw of notes) {
    const b = Buffer.from(raw);
    const m = re.exec(b.subarray(0, 80).toString("latin1"));
    if (!m || m[1] !== id) return null;
    const i = Number(m[2]);
    const n = Number(m[3]);
    if (n < 1 || n > MAX_CHUNKS || i >= n || (total !== -1 && n !== total) || parts.has(i)) return null;
    total = n;
    parts.set(i, b.subarray(m[0].length));
  }
  if (total === -1 || parts.size !== total) return null;
  let rec: unknown;
  try {
    rec = JSON.parse(Buffer.concat([...Array(total).keys()].map((i) => parts.get(i)!)).toString("utf8"));
  } catch {
    return null;
  }
  return validRecord(rec, id) ? rec : null;
}

function validRecord(x: unknown, id: string): x is CertRecord {
  const r = x as CertRecord;
  if (!r || typeof r !== "object" || r.v !== 1 || r.c !== id || typeof r.s !== "string") return false;
  if (r.net !== "mainnet" && r.net !== "testnet") return false;
  if (!Array.isArray(r.p) || !r.p.every((a) => typeof a === "string" && ADDR_RE.test(a))) return false;
  if (!Array.isArray(r.r)) return false;
  return r.r.every(
    (w) =>
      w &&
      typeof w.u === "string" &&
      typeof w.m === "string" &&
      (w.v === "ALLOW" || w.v === "REFUSE" || w.v === "SKIPPED") &&
      typeof w.k === "string" &&
      typeof w.why === "string" &&
      (w.t === undefined || (typeof w.t === "string" && TXID_RE.test(w.t))),
  ) && (r.pa === undefined || (typeof r.pa === "string" && /^\d{1,15}$/.test(r.pa)));
}

// ---------------------------------------------------------------- writing (after a paid audit)

/**
 * Writes the notes as one atomic group of 0-ALGO self-payments from the payer wallet.
 * `submit` returns once algod accepted the group (the ids are known then); confirmation
 * is awaited separately, so a slow confirmation never loses the ids.
 */
export interface CertAnchor {
  /** The payer wallet's ALGO balance (microAlgo). */
  algoBalance(): Promise<bigint>;
  submit(notes: Uint8Array[]): Promise<{ txIds: string[] }>;
  /** true once confirmed; false if not confirmed within `ms`. Throws if algod dropped it. */
  waitConfirmed(txId: string, ms: number): Promise<boolean>;
}

export const ALGOD_URLS: Record<NetworkName, string> = {
  mainnet: "https://mainnet-api.algonode.cloud",
  testnet: "https://testnet-api.algonode.cloud",
};

interface PendingInfo {
  "confirmed-round"?: number;
  "pool-error"?: string;
  txn?: { txn?: { snd?: string; note?: string } };
}

async function pendingInfo(algodUrl: string, txId: string, f: typeof fetch = fetch): Promise<PendingInfo | null> {
  const res = await f(`${algodUrl}/v2/transactions/pending/${txId}?format=json`, { signal: AbortSignal.timeout(8000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`algod ${res.status}`);
  return (await res.json()) as PendingInfo;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makeCertAnchor(networkName: NetworkName, payerSecretKeyB64: string, algodUrl = ALGOD_URLS[networkName]): CertAnchor {
  const account = getAlgokitSigner(toClientAvmSigner(payerSecretKeyB64));
  if (!account) throw new Error("cannot build the payer signer");
  const algorand = networkName === "mainnet" ? AlgorandClient.mainNet() : AlgorandClient.testNet();
  const address = account.addr.toString();
  return {
    async algoBalance() {
      const res = await fetch(`${algodUrl}/v2/accounts/${address}?exclude=all&format=json`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`algod ${res.status}`);
      return BigInt(((await res.json()) as { amount: number }).amount);
    },
    async submit(notes) {
      const g = algorand.newGroup();
      for (const note of notes) g.addPayment({ sender: account.addr, receiver: account.addr, amount: microAlgo(0), note, signer: account.signer });
      const { transactions } = await g.build();
      const txIds = transactions.map((t) => t.txn.txId());
      const signed = await g.gatherSignatures();
      const res = await fetch(`${algodUrl}/v2/transactions`, {
        method: "POST",
        headers: { "content-type": "application/x-binary" },
        body: Buffer.concat(signed.map((b) => Buffer.from(b))),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`algod ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return { txIds };
    },
    async waitConfirmed(txId, ms) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const p = await pendingInfo(algodUrl, txId).catch(() => null);
        if (p?.["pool-error"]) throw new Error(`algod dropped it: ${p["pool-error"].slice(0, 160)}`);
        if ((p?.["confirmed-round"] ?? 0) > 0) return true;
        await pause(Math.min(1500, Math.max(0, end - Date.now())));
      }
      return false;
    },
  };
}

export type IssueOutcome =
  | { certificateUrl: string; certificateTx: string; certificatePending?: true }
  | { certificateError: string };

export interface IssueOptions {
  /** Most time the record may take (balance read + submit + confirmation). Default 40 s. */
  limitMs?: number;
  /** Below this ALGO balance (microAlgo) the payer writes no record. Default 1 ALGO. */
  minPayerMicroAlgo?: bigint;
  log?: (msg: string) => void;
}

export const CERT_DEFAULT_LIMIT_MS = 40_000;
export const CERT_DEFAULT_MIN_PAYER_MICROALGO = 1_000_000n;

class TimedOut extends Error {}
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new TimedOut(`took longer than ${Math.round(ms / 1000)} s`)), Math.max(0, ms))))]).finally(() => clearTimeout(t));
}

/**
 * Write the audit's record on-chain and return the certificate URL. Never throws and never
 * takes longer than `limitMs`: the customer has paid and always gets the audit result.
 * Submitted but not yet confirmed → the URL with `?anchor=<tx>` and `certificatePending`
 * (the page says "recording…" until the indexer has it).
 */
export async function issueCertificate(
  anchor: CertAnchor,
  networkName: NetworkName,
  plan: AuditPlan,
  run: AuditRun,
  customerPayment: { transaction: string; amount?: string },
  baseUrl: string,
  o: IssueOptions = {},
): Promise<IssueOutcome> {
  const customerTx = customerPayment.transaction;
  if (!TXID_RE.test(customerTx)) return { certificateError: "the customer payment has no Algorand tx id" };
  const log = o.log ?? ((m: string) => console.error(m));
  const end = Date.now() + (o.limitMs ?? CERT_DEFAULT_LIMIT_MS);
  const left = () => end - Date.now();
  const min = o.minPayerMicroAlgo ?? CERT_DEFAULT_MIN_PAYER_MICROALGO;
  const url = `${baseUrl.replace(/\/+$/, "")}/cert/${customerTx}`;
  let txIds: string[];
  try {
    const balance = await within(anchor.algoBalance(), left());
    if (balance < min) {
      log(`ALERT vet402 cert: payer ALGO balance ${balance} microAlgo is below ${min}; no certificate written for ${customerTx}`);
      return { certificateError: `no certificate: vet402's payer wallet is low on ALGO for the on-chain record (below ${Number(min) / 1e6} ALGO). Your audit result above is complete.` };
    }
    txIds = (await within(anchor.submit(encodeCertNotes(buildCertRecord(networkName, plan, run, customerTx, customerPayment.amount))), left())).txIds;
  } catch (e) {
    return { certificateError: `the certificate could not be written on-chain: ${String((e as Error).message ?? e).slice(0, 160)}` };
  }
  const confirmed = await within(anchor.waitConfirmed(txIds[0], left()), left() + 1000).catch(() => false);
  return confirmed
    ? { certificateUrl: url, certificateTx: txIds[0] }
    : { certificateUrl: `${url}?anchor=${txIds[0]}`, certificateTx: txIds[0], certificatePending: true };
}

// ---------------------------------------------------------------- reading (the public page)

export interface CertReaderOptions {
  networkName: NetworkName;
  indexerUrl: string;
  asaId: string;
  /** Where customers pay vet402. */
  payTo: string;
  /** The wallet that pays sellers and signs anchors. */
  payer: string;
  auditPriceAtomic: bigint;
  feePayers?: string[];
  /** algod, to show "recording…" while a submitted record is not yet in the indexer. Omitted = no pending page. */
  algodUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface IdxTxn {
  id: string;
  sender: string;
  "tx-type": string;
  "confirmed-round": number;
  "round-time": number;
  group?: string;
  note?: string;
  "intra-round-offset"?: number;
  "asset-transfer-transaction"?: { "asset-id": number; amount: number; receiver: string; "close-amount"?: number };
  "payment-transaction"?: { amount: number; receiver: string; "close-amount"?: number };
}

export interface CertPayment {
  tx: string;
  verified: boolean;
  /** Why it could not be verified (only when verified is false). */
  problem?: string;
  seller?: string;
  amountUsdc?: string;
  time?: string;
  round?: number;
}

export interface CertView {
  id: string;
  network: NetworkName;
  seller: string;
  customer: { address: string; tx: string; amountUsdc: string; time: string; round: number };
  anchor: { txIds: string[]; round: number; time: string };
  rows: (CertRow & { payment?: CertPayment })[];
  counts: { delivered: number; mismatch: number; unreachable: number; unclear: number; skipped: number; paid: number };
  found?: number;
  notChecked?: number;
  /** null = a stranger bought it; otherwise who the buyer is. */
  selfPurchased: null | "vet402" | "seller";
  /** Every seller payment named in the record was found on-chain as recorded. */
  allPaymentsVerified: boolean;
}

export type CertOutcome = { ok: true; cert: CertView } | { ok: false; status: 400 | 404 | 503; error: string; detail: string };

const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
const notFound = (error: string, detail: string): CertOutcome => ({ ok: false, status: 404, error, detail });

class IndexerDown extends Error {}

export async function readCertificate(id: string, o: CertReaderOptions): Promise<CertOutcome> {
  if (!TXID_RE.test(id)) return { ok: false, status: 400, error: "invalid_id", detail: "a certificate id is a 52-character Algorand transaction id" };
  const f = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 8000;
  const get = async (path: string): Promise<unknown | null> => {
    let res: Response;
    try {
      res = await f(`${o.indexerUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new IndexerDown(String((e as Error).message ?? e));
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new IndexerDown(`indexer ${res.status}`);
    return res.json();
  };
  try {
    // 1) The customer's payment: an x402 settlement of at least the audit price to payTo.
    const ct = ((await get(`/v2/transactions/${id}`)) as { transaction?: IdxTxn } | null)?.transaction;
    if (!ct) return notFound("not_found", "no Algorand transaction has this id");
    const ax = ct["asset-transfer-transaction"];
    if (ct["tx-type"] !== "axfer" || !ax || String(ax["asset-id"]) !== String(o.asaId) || ax.receiver !== o.payTo) {
      return notFound("not_an_audit_payment", "this transaction is not a USDC payment to vet402");
    }
    const paid = BigInt(ax.amount) + BigInt(ax["close-amount"] ?? 0);
    if (!ct.group) return notFound("not_an_audit_payment", "this payment is not an x402 settlement");
    const q = new URLSearchParams({ "group-id": ct.group, round: String(ct["confirmed-round"]) });
    const grp = ((await get(`/v2/transactions?${q}`)) as { transactions?: IdxTxn[] } | null)?.transactions ?? [];
    const feePayers = o.feePayers ?? GOPLAUSIBLE_FEE_PAYERS;
    if (!grp.some((x) => x["tx-type"] === "pay" && feePayers.includes(x.sender))) {
      return notFound("not_an_audit_payment", "this payment is not an x402 settlement (no facilitator in its group)");
    }
    const round = ct["confirmed-round"];

    // 2) The anchor: sent by the payer to itself, after the customer's payment, naming this tx.
    const prefix = Buffer.from(`${CERT_NOTE_PREFIX}${id}:`).toString("base64");
    // Sent by the payer only: anyone can send the payer notes with this prefix, and those must not
    // push the real record out of the page (the account endpoint also returns received txs).
    const found: IdxTxn[] = [];
    let next: string | undefined;
    for (let page = 0; page < 10; page++) {
      const aq = new URLSearchParams({ address: o.payer, "address-role": "sender", "note-prefix": prefix, "tx-type": "pay", "min-round": String(round), limit: "100" });
      if (next) aq.set("next", next);
      const body = (await get(`/v2/transactions?${aq}`)) as { transactions?: IdxTxn[]; "next-token"?: string } | null;
      const txs = body?.transactions ?? [];
      found.push(...txs);
      next = body?.["next-token"];
      if (!next || txs.length === 0) break;
    }
    const groups = new Map<string, IdxTxn[]>();
    for (const t of found) {
      const p = t["payment-transaction"];
      // Anyone can send the payer a payment with this note: only the payer's own signature counts.
      if (t.sender !== o.payer || !p || p.receiver !== o.payer || p.amount !== 0 || !t.note || t["confirmed-round"] < round) continue;
      const k = t.group ?? t.id;
      groups.set(k, [...(groups.get(k) ?? []), t]);
    }
    let rec: CertRecord | null = null;
    let anchorTxns: IdxTxn[] = [];
    for (const g of [...groups.values()].sort((a, b) => a[0]["confirmed-round"] - b[0]["confirmed-round"])) {
      const r = decodeCertNotes(g.map((t) => new Uint8Array(Buffer.from(t.note!, "base64"))), id);
      if (r && r.net === o.networkName) {
        rec = r;
        anchorTxns = g;
        break;
      }
    }
    if (!rec) return notFound("no_certificate", "vet402 has not written a certificate for this payment");
    // The price vet402 recorded for this audit (a later price change does not undo old certificates).
    if (rec.pa !== undefined ? paid !== BigInt(rec.pa) : paid < o.auditPriceAtomic) {
      return notFound("not_an_audit_payment", "this payment does not match the audit price vet402 recorded");
    }

    // 3) Each seller payment named in the record, read back from the chain.
    const own = new Set([o.payTo, o.payer]);
    const txs = [...new Set(rec.r.map((r) => r.t).filter((t): t is string => !!t))];
    const payments = new Map<string, CertPayment>();
    await Promise.all(
      txs.map(async (tx) => {
        const t = ((await get(`/v2/transactions/${tx}`)) as { transaction?: IdxTxn } | null)?.transaction;
        const a = t?.["asset-transfer-transaction"];
        let problem: string | undefined;
        if (!t || !a) problem = "not found on-chain";
        else if (t.sender !== o.payer) problem = "not sent by vet402's payer wallet";
        else if (String(a["asset-id"]) !== String(o.asaId)) problem = "not a USDC transfer";
        else if (own.has(a.receiver)) problem = "sent to a vet402 wallet";
        else if (t["confirmed-round"] < round) problem = "made before the customer's payment";
        payments.set(
          tx,
          problem || !t || !a
            ? { tx, verified: false, problem: problem ?? "not found on-chain" }
            : { tx, verified: true, seller: a.receiver, amountUsdc: atomicToUsdc(BigInt(a.amount)), time: iso(t["round-time"]), round: t["confirmed-round"] },
        );
      }),
    );

    const rows = rec.r.map((r) => (r.t ? { ...r, payment: payments.get(r.t) } : { ...r }));
    const n = (k: AuditClass) => rec!.r.filter((r) => r.k === k).length;
    const sellerAddrs = new Set([...rec.p, ...[...payments.values()].filter((p) => p.verified).map((p) => p.seller!)]);
    const customer = ct.sender;
    const selfPurchased = own.has(customer) ? "vet402" : sellerAddrs.has(customer) || rec.s === customer ? "seller" : null;
    const anchorRound = anchorTxns[0]["confirmed-round"];
    return {
      ok: true,
      cert: {
        id,
        network: rec.net,
        seller: rec.s,
        customer: { address: customer, tx: id, amountUsdc: atomicToUsdc(paid), time: iso(ct["round-time"]), round },
        anchor: {
          txIds: [...anchorTxns].sort((a, b) => (a["intra-round-offset"] ?? 0) - (b["intra-round-offset"] ?? 0)).map((t) => t.id),
          round: anchorRound,
          time: iso(anchorTxns[0]["round-time"]),
        },
        rows,
        counts: {
          delivered: n("delivered"),
          mismatch: n("mismatch"),
          unreachable: n("unreachable"),
          unclear: n("unclear"),
          skipped: n("skipped"),
          paid: [...payments.values()].filter((p) => p.verified).length,
        },
        ...(rec.n ? { found: rec.n.found, notChecked: rec.n.notChecked } : {}),
        selfPurchased,
        allPaymentsVerified: [...payments.values()].every((p) => p.verified),
      },
    };
  } catch (e) {
    if (e instanceof IndexerDown) return { ok: false, status: 503, error: "indexer_unavailable", detail: e.message.slice(0, 200) };
    throw e;
  }
}

// ---------------------------------------------------------------- page, badge, links

export const CERT_CLI = "npx -y github:kzmttkc/vet402-algorand";

/** "Get a delivery certificate" box for /seller/<host> and /try. */
export function certificateCtaHtml(seller: string, priceUsdc: string): string {
  const s = esc(seller);
  return (
    `<div class="box cert-cta">` +
    `<p><b>Get a delivery certificate for this seller (${esc(priceUsdc)} USDC)</b></p>` +
    `<p>vet402 buys each listed resource from its own wallet and gives you a public page with every payment on Algorand. Show it to buyers or put its badge in your README.</p>` +
    `<p><small>See what it would buy (free, pays nothing):</small></p><pre><code>${esc(CERT_CLI)} ${s}</code></pre>` +
    `<p><small>Pay and get the certificate (uses the wallet whose 25 words you pass):</small></p>` +
    `<pre><code>ALGORAND_MNEMONIC="your 25 words" ${esc(CERT_CLI)} ${s} --yes</code></pre>` +
    `<p><small>Any x402 client works too: <code>GET /v1/audit?seller=${s}</code>. Your payment settles first; only then does vet402 pay the seller. The answer has <code>certificateUrl</code>.</small></p>` +
    `</div>`
  );
}

export const CERT_NOTE =
  "This certificate is what happened when vet402 bought from this seller with its own wallet. A seller who pays for it gets the same verdict as anyone else: the rules are the same as vet402's free delivery board.";

type BadgeInfo = { text: string; color: string };

export function certBadgeInfo(c: CertView | null): BadgeInfo {
  if (!c) return { text: "no certificate", color: "#8a8f98" };
  // Only paid rows are deliveries; a resource vet402 did not pay for was never delivered.
  const judged = c.rows.filter((r) => r.t).length;
  let text = judged ? `delivered ${c.counts.delivered}/${judged}` : "no delivery";
  let color = c.counts.mismatch > 0 ? "#d73a3a" : c.counts.delivered > 0 ? "#2e9e4f" : "#8a8f98";
  if (!c.allPaymentsVerified) {
    text += " (unverified)";
    color = "#8a8f98";
  }
  if (c.selfPurchased) text += " · self-purchased";
  return { text, color };
}

function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[mw]/.test(ch) ? 9 : /[il.1 -/·()]/.test(ch) ? 4 : /[0-9]/.test(ch) ? 7 : 6.5;
  return Math.ceil(w);
}

export function certBadgeSvg(c: CertView | null): string {
  const left = "vet402 certificate";
  const { text: right, color } = certBadgeInfo(c);
  const lw = textWidth(left) + 12;
  const rw = textWidth(right) + 12;
  const w = lw + rw;
  const label = esc(`${left}: ${right}`);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}"><title>${label}</title>` +
    `<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="${lw / 2}" y="14">${esc(left)}</text><text x="${lw + rw / 2}" y="14">${esc(right)}</text></g></svg>`
  );
}

export function certBadgeMarkdown(id: string, base: string): string {
  const b = base.replace(/\/+$/, "");
  return `[![vet402 delivery certificate](${b}/cert/${id}/badge.svg)](${b}/cert/${id})`;
}

const CLS: Record<AuditClass, string> = { delivered: "delivered", mismatch: "mismatch", unreachable: "unreach", unclear: "unclear", skipped: "unreach" };

export function certHtml(c: CertView, base: string): string {
  const x = explorer(c.network);
  const txA = (id: string, label?: string) => `<a href="${esc(x.tx(id))}" rel="noopener" title="${esc(id)}"><code>${esc(label ?? `${id.slice(0, 10)}…`)}</code></a>`;
  const addrA = (a: string) => `<a href="${esc(x.addr(a))}" rel="noopener" title="${esc(a)}"><code>${esc(shortAddr(a))}</code></a>`;
  const judged = c.rows.filter((r) => r.t).length;
  const headline =
    c.counts.delivered > 0 && c.counts.delivered === judged && c.allPaymentsVerified
      ? `vet402's wallet bought from ${esc(c.seller)} and got what the listing promised${judged > 1 ? `, ${judged} of ${judged} times` : ""}.`
      : `vet402 bought from ${esc(c.seller)} with its own wallet: ${c.counts.delivered} of ${judged} ${judged === 1 ? "delivery" : "deliveries"} matched the listing.`;
  const self =
    c.selfPurchased === null
      ? ""
      : `<p class="self"><b>self-purchased</b>: the audit was paid for by ${c.selfPurchased === "vet402" ? "a vet402 wallet (an operator test)" : "the seller's own wallet"}. vet402 still paid the seller from its own wallet, but the buyer is not a stranger.</p>`;
  const rows = c.rows
    .map((r) => {
      const p = r.payment;
      const pay = !r.t
        ? `<span class="muted">vet402 did not pay for this one</span>`
        : p?.verified
          ? `vet402 → ${addrA(p.seller!)} ${esc(p.amountUsdc)} USDC · ${esc(p.time!.replace("T", " ").replace("Z", " UTC"))} · tx ${txA(p.tx)}`
          : `<span class="mismatch">tx ${txA(r.t)} not verified: ${esc(p?.problem ?? "not found on-chain")}</span>`;
      return (
        `<li class="card"><div class="top"><b class="${CLS[r.k] ?? "unreach"}">${esc(r.k.toUpperCase())}</b><span>${esc(r.v)} · <code>${esc(r.why)}</code></span></div>` +
        `<div class="u">${esc(r.m)} ${esc(r.u)}</div>` +
        (r.d ? `<small>${esc(r.d)}</small>` : "") +
        `<div>${pay}</div></li>`
      );
    })
    .join("");
  const url = `${base.replace(/\/+$/, "")}/cert/${c.id}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Delivery certificate · ${esc(c.seller)}</title>
<meta name="description" content="vet402 bought from ${esc(c.seller)} with its own wallet on Algorand. Every payment on this page is on-chain.">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<style>
:root{--bg:#fff;--fg:#111;--mut:#5f6673;--line:#dde1e7;--card:#f7f8fa;--a:#0645ad;--delivered:#1a7f37;--mismatch:#c62828;--unreach:#6b7280;--unclear:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#0a0e17;--fg:#e8ecf3;--mut:#8a93a6;--line:rgba(255,255,255,.1);--card:#111827;--a:#93c5fd;--delivered:#34d399;--mismatch:#f87171;--unreach:#9ca3af;--unclear:#f59e0b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif}
a{color:var(--a);overflow-wrap:anywhere}
main{max-width:760px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:20px;margin:0 0 6px;overflow-wrap:anywhere}
.lead{font-size:17px;margin:4px 0 12px}
.delivered{color:var(--delivered)} .mismatch{color:var(--mismatch)} .unreach{color:var(--unreach)} .unclear{color:var(--unclear)}
.muted,small{color:var(--mut)}
.box{border:1px solid var(--line);border-radius:8px;background:var(--card);padding:10px 12px;margin:0 0 12px;overflow-wrap:anywhere}
.box p{margin:4px 0}
.self{border:1px solid var(--unclear);border-radius:8px;padding:8px 12px}
pre{margin:6px 0 0;padding:8px;background:var(--card);border:1px solid var(--line);border-radius:6px;white-space:pre-wrap;word-break:break-all;font-size:12px}
code{font-size:12px;overflow-wrap:anywhere}
ul{list-style:none;padding:0;margin:0}
.card{border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:0 0 8px;font-size:14px;overflow-wrap:anywhere}
.card .top{display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap}
.u{font-family:ui-monospace,monospace;font-size:13px}
</style></head><body><main>
<p><small><a href="/">vet402</a> › delivery certificate</small></p>
<h1>Delivery certificate: ${esc(c.seller)}</h1>
<p><img src="/cert/${esc(c.id)}/badge.svg" alt="${esc(certBadgeInfo(c).text)}" height="20"></p>
<p class="lead">${headline}</p>
${self}
<div class="box">
<p>Audit bought by ${addrA(c.customer.address)} for ${esc(c.customer.amountUsdc)} USDC on ${esc(c.customer.time.replace("T", " ").replace("Z", " UTC"))} · tx ${txA(c.customer.tx)}</p>
<p><small>${c.counts.paid} payment(s) from vet402 to the seller · ${c.counts.delivered} delivered · ${c.counts.mismatch} mismatch · ${c.counts.unreachable} unreachable · ${c.counts.unclear} unclear${c.counts.skipped ? ` · ${c.counts.skipped} skipped` : ""}${c.found !== undefined ? ` · ${c.found} listed in the Bazaar${c.notChecked ? `, ${c.notChecked} not looked at` : ""}` : ""}</small></p>
</div>
<ul>${rows}</ul>
<p>${esc(CERT_NOTE)}</p>
<div class="box">
<p>Badge for your README (Markdown):</p>
<pre><code>${esc(certBadgeMarkdown(c.id, base))}</code></pre>
<p><small>Link: <a href="${esc(url)}">${esc(url)}</a></small></p>
</div>
<p><small>How to check this page yourself: every payment above is an Algorand ${esc(c.network)} transaction; open the links. The verdicts are in a note that vet402's payer wallet signed and sent to itself right after the audit (${c.anchor.txIds.map((t) => txA(t)).join(" ")}, ${esc(c.anchor.time.replace("T", " ").replace("Z", " UTC"))}). This page reads them back from the indexer and shows only what it finds there. UNCLEAR results are not counted against the seller. Something wrong? <a href="https://github.com/kzmttkc/vet402-algorand/issues" rel="noopener">Open an issue</a>.</small></p>
</main></body></html>`;
}

function recordingHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>Recording certificate · vet402</title>
<style>:root{--bg:#fff;--fg:#111}@media (prefers-color-scheme:dark){:root{--bg:#0a0e17;--fg:#e8ecf3}}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:760px;margin:0 auto;padding:20px 16px}</style>
</head><body><main><h1>Recording…</h1><p>vet402 is writing this certificate on Algorand. It shows here once the record is confirmed and indexed, usually within a minute. This page reloads by itself.</p></main></body></html>`;
}

/** Register GET /cert/:id and GET /cert/:id/badge.svg. Free: call before the payment middleware. */
export function registerCert<E extends Env>(app: Hono<E>, o: CertReaderOptions, base?: string): void {
  // A certificate that was found never changes: keep it per instance (bounded).
  const found = new Map<string, CertView>();
  const load = async (id: string): Promise<CertOutcome> => {
    const hit = found.get(id);
    if (hit) return { ok: true, cert: hit };
    const out = await readCertificate(id, o);
    if (out.ok) {
      found.set(id, out.cert);
      if (found.size > 500) found.delete(found.keys().next().value!);
    }
    return out;
  };
  /** A record vet402 submitted for `id` that the indexer does not show yet (pending, or confirmed moments ago). */
  const recording = async (id: string, anchorTx: string | undefined): Promise<boolean> => {
    if (!o.algodUrl || !anchorTx || !TXID_RE.test(anchorTx)) return false;
    try {
      const p = await pendingInfo(o.algodUrl, anchorTx, o.fetchImpl);
      const t = p?.txn?.txn;
      if (!p || p["pool-error"] || !t?.snd || !t.note) return false;
      const note = Buffer.from(t.note, "base64").subarray(0, 80).toString("latin1");
      return encodeAddress(new Uint8Array(Buffer.from(t.snd, "base64"))) === o.payer && note.startsWith(`${CERT_NOTE_PREFIX}${id}:`);
    } catch {
      return false;
    }
  };
  const baseOf = (reqUrl: string) => base ?? new URL(reqUrl).origin;
  app.get("/cert/:id", async (c) => {
    const id = c.req.param("id");
    const out = await load(id);
    if (!out.ok && out.error === "no_certificate" && (await recording(id, c.req.query("anchor")))) {
      return c.html(recordingHtml(), 202, { "cache-control": "no-store" });
    }
    if (!out.ok) {
      return c.text(`vet402: no certificate here (${out.error}): ${out.detail}.`, out.status, { "cache-control": "no-store" });
    }
    return c.html(certHtml(out.cert, baseOf(c.req.url)), 200, { "cache-control": "public, max-age=300, s-maxage=86400" });
  });
  app.get("/cert/:id/badge.svg", async (c) => {
    const out = await load(c.req.param("id"));
    const headers = {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": out.ok ? "public, max-age=3600" : "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    };
    return c.body(certBadgeSvg(out.ok ? out.cert : null), out.ok ? 200 : out.status, headers);
  });
}
