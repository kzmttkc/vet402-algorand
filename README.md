# vet402 (Algorand)

**An x402 orchestrator that checks whether a paid API delivers what it promised.** Built for the Algorand x402 Global Challenge (Orchestrator track). The payment requirements carry `accepts[].extra.tag = "x402-global-challenge"`.

You name an x402 endpoint and pay vet402 0.05 USDC. vet402 pays that endpoint itself, compares what came back with what the seller declared (Bazaar `description`, output schema/example, `402 accepts`), and returns:

- `ALLOW` or `REFUSE`, with a machine-readable reason,
- the tx id of **your payment to vet402** and the tx id of **vet402's payment to the seller**, and
- a short summary of what was delivered.

**Live on Algorand MainNet:** `GET https://vet402-algorand.vercel.app/v1/check?url=<x402 endpoint>` (0.05 USDC, ASA 31566704, facilitator GoPlausible). Listed in the Bazaar discovery feed.

## Orchestrator flow (settle-first)

```
customer ──(1) pay 0.05 USDC──▶ vet402  GET /v1/check?url=<seller>
                                  │ verify (facilitator)
                                  │ preflight: URL allowed? daily cap readable and not used up?
                                  │            (if not → 400/503, customer NOT charged)
                                  │ (2) SETTLE customer payment on-chain ◀── must succeed
                                  │     (fails → 402/502, seller is never contacted)
                                  │ (3) read seller's 402 → price ≤ caps? payTo not ours?
                                  │ (4) pay seller (x402 exact, USDC) ──▶ seller
                                  │ (5) compare delivery with the declaration
customer ◀── { verdict, reason, customerPayment.transaction, downstreamPayment.transaction, delivery.summary }
```

vet402 pays a seller **only after the customer's payment has settled**. The stock `@x402/hono` middleware settles after the handler runs, so vet402 uses its own `settle-first` middleware (`src/settle-first.ts`). It is built on the official core `x402HTTPResourceServer` (`processHTTPRequest` → `processSettlement`). `test/settle-first.test.ts` locks this order: the test fails if the seller is contacted before settlement.

## Reasons (stable contract)

| reason | verdict | seller paid? |
|---|---|---|
| `delivered` | ALLOW (`detail` may say `example keys not seen: …`) | yes |
| `delivery_missing_keys` | REFUSE | yes |
| `not_json` / `empty_body` / `http_error` | REFUSE | yes |
| `payment_failed` | REFUSE | attempted |
| `price_over_cap` | REFUSE | no |
| `daily_cap_reached` | REFUSE | no |
| `cap_check_unavailable` | REFUSE | no |
| `self_dealing` | REFUSE | no |
| `requirements_body_only` | REFUSE | no |
| `no_supported_accept` / `not_x402` / `probe_error` | REFUSE | no |
| `invalid_target` | REFUSE (HTTP 400 before settlement, customer not charged) | no |

What counts as a promise:

- **Promised keys** = the `required` list of the seller's Bazaar output schema. The schema is read from `bazaar.info.output.schema`, else from where `declareDiscoveryExtension` puts it (`bazaar.schema.properties.output.properties.example`). A promised key that is absent from the delivered JSON object is `delivery_missing_keys`.
- **Example keys** = when nothing is `required`: the keys of `output.schema.properties` and the top-level keys of `output.example`. They illustrate, they do not promise. If some are absent, the verdict stays `ALLOW` / `delivered` and `detail` says `example keys not seen: a, b`. If **none** of them is present (for example the seller returned an error object with status 200), the verdict is `REFUSE` / `delivery_missing_keys`.
- A key counts as present when it exists, whatever its value (`null` and `""` included).
- `requirements_body_only`: the 402 has valid x402 v2 requirements (`x402Version`, `accepts`) only in its JSON body and no `PAYMENT-REQUIRED` header. vet402 reads them and runs the same accept, cap and `payTo` checks, but the x402 v2 paying client cannot pay this form, so vet402 does not try to pay. A cap or accept problem is still reported first under its own reason.

## Spending caps and the no-self-dealing policy

- **Per call**: vet402 never pays one seller more than `PROBE_MAX_PER_CALL_USDC` (MainNet default 0.10).
- **Per UTC day**: vet402 never sends more than `PROBE_MAX_PER_DAY_USDC` (MainNet default 3.00) from its payer wallet.
  - The day's total is read **from the chain** (Algorand indexer: USDC transfers sent by the payer wallet since 00:00 UTC), so the cap holds on serverless instances that share no files. A local ledger is kept as a backup, and the larger of the two is used.
  - If the indexer cannot be read, vet402 **does not pay** (`cap_check_unavailable`). When this is detected before settlement, the customer is not charged.
- Caps are checked before any signature exists. They are enforced again inside the paying client (policy + `onBeforePaymentCreation`), which is also locked to the approved `payTo`/asset/amount and to one payment per check.
- **No self-dealing.** vet402 never pays a seller whose `payTo` is one of its own wallets (the customer-facing `payTo` or the payer wallet); those checks return `self_dealing`. vet402 does not buy its own checks to inflate volume. Every downstream payment follows a real customer payment that has already settled.
- MainNet is locked unless `I_UNDERSTAND_MAINNET_MOVES_REAL_FUNDS=yes`. `ALLOW_PRIVATE_TARGETS=1` is refused on MainNet. Targets must be `https` and resolve to public IPs, redirects are not followed, and bodies are capped at 1 MB.
- There is a residual risk. Two instances running at the same instant can each read the same on-chain total before either payment lands. The worst-case overshoot is about (concurrent checks) × per-call cap.

## Seller audit

`GET /v1/audit?seller=<host or payTo address>` (`AUDIT_PRICE_USDC`, default 0.50 USDC). For sellers who want their own API checked from someone else's wallet: vet402 buys each of the seller's listed resources with its own payer wallet and judges each delivery the same way as `/v1/check`. The 402 has the same shape as `/v1/check` (`exact`, USDC ASA, `tag: x402-global-challenge`, Bazaar extension with input and output declared).

**Free plan before payment.** The unpaid request reads the Bazaar feed (`https://facilitator.goplausible.xyz/discovery/resources`, every page by `offset`, cached 10 minutes) and lists the seller's resources that are paid in USDC on this network. `seller` matches the resource host (`api.example.com`, or `localhost:4031` locally) or the `payTo` of its USDC accept.

- None listed → `404 seller_not_found`, no 402 challenge, nothing to pay. Invalid or vet402's own seller → `400`. Bazaar or daily-cap check unreadable → `503`.
- Otherwise the 402 JSON body carries `audit`: `found`, `checking`, `paying`, `plannedSpendUsdc`, the exact `targets` in the order they will be bought, and `notChecked` with a reason for each resource that will not be bought. So the seller knows how many resources will be checked before signing anything.
- Order: most-bought first (`settleCount`), then cheapest. At most `AUDIT_MAX_TARGETS` (default 10) resources. The listed prices of the resources vet402 expects to pay for stay within `AUDIT_MAX_SPEND_USDC` (default 0.40, always below the audit price) and today's remaining daily cap; the rest are listed as `over_audit_budget`, `over_daily_headroom` or `over_target_limit`.
- A resource above the per-call cap is still checked: vet402 reads its 402 and returns `price_over_cap` without paying.
- vet402 sends the example input the seller published in the Bazaar (query or JSON body), as the board does. `PUT`/`DELETE`, form bodies and path templates are listed as not checked. On 2026-09-27, 810 of the 2,090 MainNet USDC listings were `POST` and 867 were `GET` with declared query parameters, so a bare `GET` on the URL would misjudge most of them.
- If nothing can be bought within the caps → `422 nothing_to_audit` with the list, nothing to pay.

**After payment (settle-first).** The plan is made again when the paid request arrives (same cached catalogue, current daily headroom), before the customer's payment is settled; that plan is the one that runs, and it is returned in the response. The customer's payment settles first, then vet402 buys the targets one at a time through the normal `probe()`: per-call cap before any signature, the daily cap read from the chain, no self-dealing, no private addresses. On top of that, one audit never spends more than `AUDIT_MAX_SPEND_USDC`, even if a seller raised its price after the plan. When the audit budget or the daily cap is hit, or the audit runs longer than `AUDIT_DEADLINE_MS` (default 240 s), the remaining resources are not paid and come back as `SKIPPED` with `audit_budget`, `daily_cap` or `time_limit`.

Response: `results[]` (per resource: `verdict`, `reason`, `class`, `customerTx`, `downstreamPayment.transaction`, `price`, `delivery`), `summary` (`delivered` / `mismatch` / `unreachable` / `unclear` / `skipped`, number of seller payments, USDC spent), `customerPayment`, and the `plan`. `class` uses the same rules as the board: `mismatch` only when vet402 paid and the delivery did not match the declaration.

Locally, the TestNet test sellers are not in the Bazaar. `AUDIT_CATALOG_URLS=<url,url,...>` lists them by URL instead (allowed only with `ALLOW_PRIVATE_TARGETS=1`). `npx tsx scripts/audit-demo.ts <seller>` pays for one audit as the TestNet client and prints each payment's confirmed round.

## Use from an agent (MCP)

An agent that pays Algorand x402 endpoints can ask vet402 first. `mcp/` is a stdio MCP server with two tools:

| tool | input | cost |
|---|---|---|
| `vet402_check` | `{ url }` | **pays 0.05 USDC** per call to vet402 from the wallet in `ALGORAND_MNEMONIC`. Returns the verdict, the reason, both tx ids and the delivery summary |
| `algorand_x402_endpoints` | `{ query?, network?, limit? }` | free. Lists Algorand x402 endpoints from the Bazaar feed. All pages are read, because one page holds at most 200 of the 2,000+ entries |

```bash
npm ci && (cd mcp && npm ci)
```

MCP client config (Claude Desktop, Claude Code `.mcp.json`, etc.):

```json
{
  "mcpServers": {
    "vet402": {
      "command": "npm",
      "args": ["--prefix", "/path/to/vet402-algorand/mcp", "start", "--silent"],
      "env": { "ALGORAND_MNEMONIC": "<25 words of a wallet holding a little USDC>", "VET402_NETWORK": "mainnet" }
    }
  }
}
```

`VET402_NETWORK` is `mainnet` (default) or `testnet`. `VET402_URL` defaults to `https://vet402-algorand.vercel.app`. `VET402_MAX_PRICE_USDC` (default `0.05`) is the most one call pays vet402. Without `ALGORAND_MNEMONIC`, `vet402_check` returns an error and pays nothing.

The same check from TypeScript, without MCP (`src/check-client.ts`):

```ts
import { checkBeforeBuy } from "./src/check-client.js";

const r = await checkBeforeBuy(url, { mnemonic: process.env.ALGORAND_MNEMONIC, network: "mainnet" });
if (r.verdict === "ALLOW") { /* buy it yourself */ }
// r.reason, r.customerPayment.transaction, r.downstreamPayment?.transaction, r.delivery?.summary
```

The client pays only an `exact` USDC accept on the chosen Algorand network, at most `maxPriceUsdc`, and at most once per call.

TestNet run through the MCP server (2026-09-27, local vet402 and test sellers): `/honest` → ALLOW delivered, payment 1 `IMENJ5DJR3V6U34V2CXDP64WRABOPRSHIGXWRTQ7QXG4TMEKXCQA`, payment 2 `LEDG2MC2EJYSOHPWI6Y5H6O5NP42VG4WE7V7KLIR3W7FMUWTISQQ`. `/liar` → REFUSE delivery_missing_keys, payment 1 `O6IFUIQNQYX5BARHZDMDJXVFGIJRTKVBFBB7X5RYF4QNGWALJ74Q`, payment 2 `OZPPC343S7SQB5VGV3GOVVHOPKRQO3TQ3CRIJSMKGJ4WAXHS33QQ`.

## Run locally (TestNet)

```bash
npm install
npm test && npm run typecheck
npm run keys:gen               # .keys/testnet.json (gitignored), prints 3 addresses
npm run balances
npm run setup:testnet          # after the client address has ALGO (and later USDC)

ALLOW_PRIVATE_TARGETS=1 npm run sellers   # :4031  /honest /liar /pricey
ALLOW_PRIVATE_TARGETS=1 npm run server    # :4021  vet402

npm run demo -- http://localhost:4031/honest   # ALLOW delivered, 2 tx ids
npm run demo -- http://localhost:4031/liar     # REFUSE delivery_missing_keys, 2 tx ids
npm run demo -- http://localhost:4031/pricey   # REFUSE price_over_cap, seller not paid
```

Transactions: `https://lora.algokit.io/{testnet,mainnet}/transaction/<txid>`.

## Deploy (Vercel, Node runtime)

`src/server.ts` default-exports a Hono app, which Vercel's zero-config Hono support picks up (Node.js runtime, Fluid compute). The app is built lazily on the first request. `vercel.json` only pins `npm ci`. Do not add `src/index.ts` or `src/app.ts`: Vercel also looks for those names.

### Environment variables

| name | required | example / default | notes |
|---|---|---|---|
| `X402_NETWORK` | yes | `mainnet` | `testnet` (default) or `mainnet` |
| `I_UNDERSTAND_MAINNET_MOVES_REAL_FUNDS` | MainNet | `yes` | lock; anything else refuses to start |
| `PAYER_MNEMONIC` | yes | (secret) | wallet that pays sellers; **encrypted env only** |
| `VET402_PAY_TO` | no | MainNet default `RMMD7KW5…PIY33Q` | where customers pay vet402 |
| `CHECK_PRICE_USDC` | no | `0.05` | customer price |
| `AUDIT_PRICE_USDC` | no | `0.50` | price of one seller audit |
| `AUDIT_MAX_SPEND_USDC` | no | `0.40` | most one audit pays sellers; must be below `AUDIT_PRICE_USDC` |
| `AUDIT_MAX_TARGETS` | no | `10` | most resources one audit checks (1–50) |
| `AUDIT_DEADLINE_MS` | no | `240000` | the rest of an audit is SKIPPED after this |
| `BAZAAR_URL` | no | `https://facilitator.goplausible.xyz/discovery/resources` | where the audit lists a seller's resources |
| `PROBE_MAX_PER_CALL_USDC` | no | `0.10` (MainNet) | per-seller-payment cap |
| `PROBE_MAX_PER_DAY_USDC` | no | `3.00` (MainNet) | per-UTC-day cap (on-chain) |
| `FACILITATOR_URL` | no | `https://facilitator.goplausible.xyz` | |
| `INDEXER_URL` | no | `https://mainnet-idx.algonode.cloud` | daily-cap source |
| `PROBE_TIMEOUT_MS` | no | `20000` | seller request timeout |
| `ALLOW_PRIVATE_TARGETS` | no | `0` | must be `0` on MainNet |
| `SPEND_LEDGER_FILE` | no | none on Vercel | local backup ledger |

## Versions

`@x402/*` is pinned to **2.11.0**, the version locked in the official `algorandfoundation/x402-demo` tutorial. From 2.20.0 onward the Algorand CAIP-2 is truncated to 32 characters, while the GoPlausible facilitator's `/supported` still lists the full genesis-hash form. With 2.27.0 the server fails at startup with `Facilitator does not support scheme "exact"`. vet402 accepts sellers that advertise either form.

## Files

| path | role |
|---|---|
| `src/server.ts` | `GET /v1/check`, `GET /v1/audit`, Bazaar discovery, production wiring, Vercel default export |
| `src/audit.ts` | seller audit: free plan from the Bazaar, audit budget, run through `probe()` |
| `src/bazaar.ts` | Bazaar feed reader (cached), request built from the seller's example input (shared with the board) |
| `src/settle-first.ts` | verify → preflight → **settle** → handler middleware |
| `src/probe.ts` | read seller 402 → caps / self-dealing → pay (`wrapFetchWithPayment` + `ExactAvmScheme`) → judge |
| `src/spend.ts` | on-chain daily cap (indexer) + guard |
| `src/caps.ts` | per-call cap and local backup ledger |
| `src/verdict.ts` | declaration-vs-delivery check, reason words |
| `src/declaration.ts` / `src/target.ts` | seller declaration parsing, URL guard |
| `src/client-demo.ts` / `src/sellers.ts` | customer role, TestNet test sellers |
| `scripts/` | key generation (TestNet, MainNet payer), balances, TestNet setup, single probe |
| `test/` | offline unit tests (`node:test`) |

## Public activity ledger

`GET /activity` (HTML) and `GET /activity.json` list every x402 payment vet402 has received, each next to the payment vet402 then made to the seller. Both are free (mounted before the payment middleware), read live from the Algorand indexer, and cached for 60 s (`Cache-Control: public, max-age=60, s-maxage=60`). Every tx id links to an explorer (allo.info on MainNet), so each row can be checked on-chain. If the indexer cannot be read, the routes answer 503; they never show an empty ledger in its place.

- **Customer payment**: a USDC transfer to `payTo` inside an atomic group that also holds a transaction from the x402 facilitator's fee payer (GoPlausible `ZMFK2OI7…RA22AA`). Only the facilitator can sign that transaction. Other USDC deposits to `payTo` (for example exchange withdrawals, or transfers by app call) are not rows; their tx ids are listed in `notCounted` in the JSON.
- **Operator test**: the customer is vet402's own `payTo` or payer wallet (exact address match). These rows are marked `operator test` and are left out of the customer totals. The two MainNet checks in the run record below are operator tests.
- **Seller payment**: any USDC sent by the payer wallet to an address that is not vet402's own. It is matched to the most recent earlier customer payment that still has room. A check has room for one seller payment (within 300 s). A seller audit (a customer payment of at least the audit price) has room for up to `AUDIT_MAX_TARGETS` (within 900 s), because one audit buys several resources. A seller payment with no such customer payment is listed under `unmatchedPayouts`, not hidden.
- **Audits are one row.** An audit is one customer payment: it is counted once in the customer totals, marked `audit`, and its seller payments are listed under it (`sellerPayments[]` in the JSON; `seller`/`sellerTx` repeat the first one). The headline says how many seller payments were inside audits (`totals.audits`), so several seller payments per audit do not read as several customers.
- Pairing uses amounts and times only (x402 transfers carry no reference). If a check and an audit run at the same moment, a seller payment can be credited to the wrong one of the two; customer counts are unaffected.
- Totals: distinct paying customer addresses (operator excluded), customer payments and USDC, seller payments and USDC, audits, operator tests.

The page needs only public addresses. The payer address is taken from `PAYER_MNEMONIC` as before, or from `VET402_PAYER_ADDRESS` if set.

## Daily delivery board

`GET /board` (HTML) and `GET /board.json` (free) show whether Algorand x402 sellers delivered what they declared, when vet402 bought from them with its own money. `?view=census` shows the census run.

- **Daily** (`npx tsx scripts/board-sweep.ts`): from the Bazaar feed, MainNet USDC resources priced at or under the per-call cap, seen in the last 7 days, **one per host (the cheapest)**. vet402's own hosts and any resource paying one of vet402's addresses are excluded. Results go to `board/YYYY-MM-DD.json` and `board/latest.json`.
- **Census** (`--census`): every listed resource under the per-call cap, once each. Results go to `board/census-YYYY-MM-DD.json` and `board/census-latest.json`. Concurrency is 1–4 (default 3). The order takes turns between hosts (round-robin), a host never has two purchases in flight, and purchases from one host are at least 2 s apart (`--host-gap-ms` can only raise it). `/board?view=census&date=YYYY-MM-DD` shows one day's census.
- The census is rerun on 9/28 with the corrected verdict code; the 9/27 results are kept (`board/census-2026-09-27.json`). The workflow has a one-off schedule for it: 2026-09-28 00:30 UTC (`30 0 28 9 *`, mode census).
- `GET /seller/<host>` (free) shows the latest result for each resource of one seller, with the vet402 → seller tx, and the Markdown for a README badge, `GET /badge/<host>.svg` (cached 1 hour). The paid re-check box (`/v1/audit?seller=`) is shown only with `SELLER_PAGE_AUDIT=on` (price `AUDIT_PRICE_USDC`, default 0.50).
- `--dry-run` lists the targets and the cost estimate, and pays nothing. It needs no key. `--targets <url,...>` runs an explicit list (TestNet test sellers).
- Each purchase goes through the normal `probe()`: per-call cap before any signature, and a daily cap read from the chain (indexer) with a local backup ledger. The board has its own daily cap, `BOARD_MAX_PER_DAY_USDC` (default = `PROBE_MAX_PER_DAY_USDC`), and its own ledger file. The `/v1/check` caps are unchanged. When the cap is hit, the remaining rows are written as `SKIPPED daily_cap` and the run stops.
- A resource is bought at most once per UTC day, across daily and census runs. Each attempt is recorded before paying, so a rerun resumes and never buys the same URL twice that day. On a day census has run, the daily sweep does not run. The day is fixed when the run starts, and the cap counts that day (indexer window and ledger). The board's ledger is `board/spend-<network>.json`; the workflow commits it with the results, and a run starts from max(ledger, on-chain total).
- vet402 sends the example input the seller published in the Bazaar (query or JSON body). `PUT`/`DELETE`, form bodies and path templates are not bought.
- Reason codes are shown as they are. One result does not rate a seller. Mistakes: GitHub issues.
- These purchases are vet402's own, made to publish the board. They are the one exception to "every downstream payment follows a real customer payment" above, and every one is listed on `/board` with its tx id. On MainNet they are paid from a separate wallet, `BOARD_PAYER_MNEMONIC`. The script refuses to run with the `/v1/check` payer wallet unless `--share-payer-wallet` is given. On a shared wallet, board spending would count toward the customers' daily cap (same on-chain total), and `/activity` could pair a board purchase with a customer payment.
- `.github/workflows/board.yml` runs the daily sweep at 21:00 UTC (`workflow_dispatch`: `daily` or `census`, optional dry run) and commits `board/*.json`, including a partial day if the run failed. Its secrets (`BOARD_PAYER_MNEMONIC`, `PAYER_MNEMONIC`) come from the GitHub environment `mainnet-board`, which must be restricted to the `main` branch. Dependencies install with `npm ci --ignore-scripts`.

## MainNet run record

### 2026-09-27 12:1x JST: first MainNet checks (operator smoke test)

The paying client here is vet402's own payer wallet, so these two calls are a deployment check by the operator, not customer usage.

| target | verdict | payment 1 (client → vet402) | payment 2 (vet402 → seller) |
|---|---|---|---|
| blocksigner.org/commission/pulse (0.01 USDC) | ALLOW delivered | UTFFAINOX54Y4BI6K5ANNVWQRXGYM56P7NETSMCD4QYCGO5TJVOA (round 65431727, 0.05 USDC) | 4GMCTRIGQYL3Z5DRHKIBFOUKHNG5NNAYR7ZNYFU5ICCUCAC7F3TA (round 65431730, 0.01 USDC) |
| agent402.tools/api/time (0.001 USDC) | REFUSE payment_failed (the seller's facilitator answered `subcent_quota_exceeded`) | QU6RPL2CKPD4SLDARRKM637PFPHHGCWQUWCW7WCJXHTKLBCXRL2A (round 65431721, 0.05 USDC) | not paid |

Rounds were read from `mainnet-idx.algonode.cloud`. The customer's payment confirms before the seller payment.

MainNet addresses: vet402 payTo `RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q`, vet402 payer `OZ3KMLALTO67BZLYLCZOT7IJBGN7JTO5A3MJHI2267EKQDASFKS52KU6VY`.

## TestNet run record

### 2026-09-27 JST: first seller audit (`/v1/audit`)

One audit of the test seller `Y6IYAN3L…HZKEJXXM` (`/honest`, `/liar`, `/pricey` under one payTo). Free plan: found 3, checking 3, paying 2.

| resource | verdict | reason | seller tx | round |
|---|---|---|---|---|
| customer → vet402 (0.50 USDC) | | | `JEFWCRC3R4GW45R54LAORFRDMYMEOABATC6XJPRTJ6RNYJFAZDGA` | 67704026 |
| `/honest` | ALLOW | delivered | `KYV7WFWRYXO5NO3NULY4QTJ7EBB2XHMMR5VIX4NLRKKT7GATFSNA` | 67704028 |
| `/liar` | REFUSE | delivery_missing_keys | `VPEF6Z773KLRBXGGYRWEZDWLGCF4N2CW67UU3OJPIIGYJK4B2Y2A` | 67704030 |
| `/pricey` | REFUSE | price_over_cap | not paid | |

The customer's round is earlier than both seller payments. `/activity.json` shows the audit as one row (`kind: "audit"`) with both seller payments under it.

### 2026-09-27 11:1x JST: settle-first run (current code)

| case | verdict | payment 1 (client → vet402) | payment 2 (vet402 → seller) |
|---|---|---|---|
| /honest | ALLOW delivered | HCEPBJQNMNIVL6V7FITAZG4C6C372TJXZXXHAMPPNKSYD3WRLZSA (round 67699772, 0.05 USDC) | FRCKC7VEIROQZ3DBZXPAQAHZ4LAUMFRMVKC7O5VLOSIPF2VVZFVQ (round 67699774, 0.01 USDC) |
| /liar | REFUSE delivery_missing_keys (forecast, temperature) | ZIWZ6HSLRWW7XSKPD7TYQEHRRS7QM7ENE2RTRO7PVXJRWKVB4M7A (round 67699776) | OBWRJ5SIA5BGCOWDGEKBPN5CSWUFCGAFGQUXFY6AMMKGMMMP7OVQ (round 67699778) |
| /pricey | REFUSE price_over_cap (0.50 > cap 0.04) | HKCZTVM5OD23OOQKUKBWW3N3UZIYVGYIYC6FQDRYUOPM6IDGZXMA (round 67699780) | not paid |

The customer's payment is confirmed in an earlier round than the seller payment every time. Rounds were read from `testnet-idx.algonode.cloud`.

### 2026-09-27 10:2x JST: first end-to-end run (settled after the response; superseded ordering)

| case | verdict | payment 1 (client → vet402) | payment 2 (vet402 → seller) |
|---|---|---|---|
| /honest | ALLOW delivered | WS73SICTU6SKTHIXWUU74NEFH4UCBKSRQ3EV2M2RHQ42C7RZLIFQ (round 67698670, 0.05 USDC) | N5CMGOVB3GBBCFF5NCWZ46LYOQV4U2445R552OL3Q6ZZPD6QXBDA (round 67698668, 0.01 USDC) |
| /liar | REFUSE delivery_missing_keys (forecast, temperature) | P2DHQVGLBLO5UCG6CV2356MHGWVCC7OW3KLKIAKEO2BOL7VMICUQ (round 67698674) | YSEHFOXFBPMGD7E37QLRUFGTDIPNKWWQNXER2XGEMDMHS6ESLT2Q (round 67698672) |

In this run payment 2 confirmed before payment 1, because the stock middleware settles after the handler. Fixed by settle-first (run above).

Other checks on the same day: an unpaid `/v1/check` returns `402` with the challenge tag and the facilitator `feePayer`. `/pricey` → `REFUSE price_over_cap` with no signature. The indexer read of the TestNet vet402 wallet returns 20000 atomic (= the two 0.01 USDC seller payments above).

TestNet addresses: client `JJCAA6JLV5XWPQRGNHVWGRUS5KM4JHTAFHQL7XGMAIHQPY6BX63CCHWCH4`, vet402 `YICSOXOUJHLOUT5YZN7E4MG4H3TDXV5VKGAEKESY6YAKZLH5VKL6CNU2RM`, seller `Y6IYAN3LMOTOB2LQNKGO4M4C4EPLFY3Z2GIQKTCWR3RAA7WPAIHZKEJXXM`.

## License

MIT © Sen
