# vet402 (Algorand)

**An x402 orchestrator that checks whether a paid API delivers what it promised.** Built for the Algorand x402 Global Challenge (Orchestrator track). The payment requirements carry `accepts[].extra.tag = "x402-global-challenge"`.

You name an x402 endpoint and pay vet402 0.05 USDC. vet402 pays that endpoint itself, compares what came back with what the seller declared (Bazaar `description`, output schema/example, `402 accepts`), and returns:

- `ALLOW` or `REFUSE`, with a machine-readable reason,
- the tx id of **your payment to vet402** and the tx id of **vet402's payment to the seller**, and
- a short summary of what was delivered.

**Live on Algorand MainNet:** `GET https://vet402-algorand.vercel.app/v1/check?url=<x402 endpoint>` (0.05 USDC, ASA 31566704, facilitator GoPlausible). Listed in the Bazaar discovery feed. `/v1/check` buys with `GET` only (no request body); `/v1/audit` and the board also send `POST` bodies.

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
| `price_changed` | REFUSE (`/v1/buy`: the seller now asks more, or another `payTo`, than the customer paid for) | no |
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

**Free plan before payment.** The unpaid request reads the Bazaar feed (`https://facilitator.goplausible.xyz/discovery/resources`, every page by `offset`, cached 5 minutes) and lists the seller's resources that are paid in USDC on this network. `seller` matches the resource host (`api.example.com`, or `localhost:4031` locally) or the `payTo` of its USDC accept.

- None listed → `404 seller_not_found`, no 402 challenge, nothing to pay. Invalid or vet402's own seller → `400`. Bazaar unreadable → `503`.
- The unpaid request stays cheap: the plan (and a 404/422 answer) is cached per seller for 5 minutes, and the daily cap is read from the indexer only for a paid request.
- Otherwise the 402 JSON body carries `audit`: `found`, `checking`, `paying`, `plannedSpendUsdc`, the exact `targets` in the order they will be bought, and `notChecked` with a reason for each resource that will not be bought. So the seller knows how many resources will be checked before signing anything.
- Order: most-bought first (`settleCount`), then cheapest. At most `AUDIT_MAX_TARGETS` (default 10) resources. The listed prices of the resources vet402 expects to pay for stay within `AUDIT_MAX_SPEND_USDC` (default 0.40, always below the audit price); the rest are listed as `over_audit_budget` or `over_target_limit`. At payment time the plan is also trimmed to today's remaining daily cap (`over_daily_headroom`); if nothing is left to pay for, `503 daily_cap_reached` before settlement.
- A resource above the per-call cap is still checked: vet402 reads its 402 and returns `price_over_cap` without paying. It is never paid in this audit, even if its live price has dropped under the cap by then (`SKIPPED plan_changed`).
- vet402 sends the example input the seller published in the Bazaar (query or JSON body), as the board does. `PUT`/`DELETE`, form bodies and path templates are listed as not checked. On 2026-09-27, 810 of the 2,090 MainNet USDC listings were `POST` and 867 were `GET` with declared query parameters, so a bare `GET` on the URL would misjudge most of them.
- If nothing can be bought within the caps → `422 nothing_to_audit` with the list, nothing to pay.

**After payment (settle-first).** The paid request takes the cached plan for the seller (or plans again if the cache has expired) and trims it to the daily headroom, before the customer's payment is settled. The count is part of the price: the 402's `accepts[0].extra.auditPaying` is the plan's `paying`, and x402 accepts a payment only if what the buyer signed equals the requirements computed for the paid request. So a payment signed for N is refused with a 402 (not settled) if the plan now says something else, on any instance, and an accepted payment pays for at most min(N, the paid-time plan trimmed to the daily headroom). Resources beyond that come back as `SKIPPED plan_changed`. The plan that runs is returned in the response. The customer's payment settles first, then vet402 buys the targets one at a time through the normal `probe()`: per-call cap before any signature, the daily cap read from the chain, no self-dealing, no private addresses. On top of that, one audit never spends more than `AUDIT_MAX_SPEND_USDC`, even if a seller raised its price after the plan, and each payment is locked to the `payTo` in the plan: if the live 402 asks for a different address, vet402 does not sign (`REFUSE payto_changed`). With `seller=<payTo>`, no other address is ever paid. When the audit budget or the daily cap is hit, or the next resource could not finish within `AUDIT_DEADLINE_MS` (default 240 s; worst case per resource = 2 × `PROBE_TIMEOUT_MS` + 10 s), the remaining resources are not paid and come back as `SKIPPED` with `audit_budget`, `daily_cap` or `time_limit`.

Response: `results[]` (per resource: `verdict`, `reason`, `class`, `customerTx`, `downstreamPayment.transaction`, `price`, `delivery`), `summary` (`delivered` / `mismatch` / `unreachable` / `unclear` / `skipped`, number of seller payments, USDC spent), `customerPayment`, and the `plan`. `class` uses the same rules as the board: `mismatch` only when vet402 paid and the delivery did not match the declaration.

Locally, the TestNet test sellers are not in the Bazaar. `AUDIT_CATALOG_URLS=<url,url,...>` lists them by URL instead (allowed only with `ALLOW_PRIVATE_TARGETS=1`). `npx tsx scripts/audit-demo.ts <seller>` pays for one audit as the TestNet client and prints each payment's confirmed round.

## Look up a past result

`GET /v1/verdict?url=<x402 URL>` (0.001 USDC, same 402 shape: `exact`, USDC ASA, `tag: x402-global-challenge`, Bazaar extension with input and output declared). It returns what vet402 recorded the last time it bought that URL with its own wallet (the files behind `/board`: `board/latest.json` and the latest census): `class` (`DELIVERED` / `MISMATCH` / `UNREACHABLE` / `UNCLEAR`), `reason`, `date`, `sellerTx` (vet402 → seller) and `countedAgainstSeller` (false for `UNCLEAR`). An exact URL match wins; otherwise the same origin and path with another query (`match: "path"`, the URL vet402 bought is in `latest.url`).

- vet402 pays nobody for this answer: the customer's payment settles first and the handler only reads the files. No probe, no seller payment, no daily-cap spend.
- A URL with no result → `404 no_result` on the unpaid request (no 402, nothing to pay), and again before settlement if a payment is sent anyway. `HEAD` is priced like `GET`; any path other than exactly `/v1/verdict` is refused before settlement.

## Buy through vet402 (`/v1/buy`)

`/v1/check` only tells you whether a seller delivers; the content stays with vet402, so a buyer who wants it pays twice. `GET|POST /v1/buy?url=<x402 URL>` buys it for you, checked, and hands over the seller's response.

**Price (dynamic).** The unpaid request is free: vet402 reads the seller's 402 without paying and answers with a 402 whose `accepts[0].amount` = the seller's price (`exact`, USDC, this network) + `BUY_FEE_USDC` (default 0.005), in integer atomic USDC. `accepts[0].extra` names what you pay for: `sellerAmount`, `sellerPayTo`, `buyFee`. The JSON body shows the same as `buy.sellerPrice` / `fee` / `total`.

**Refused before payment (nothing to sign, nothing charged).**

| HTTP | reason | when |
|---|---|---|
| 422 | `price_over_cap` | seller price above `PROBE_MAX_PER_CALL_USDC` |
| 422 | `no_supported_accept` | no `exact` USDC accept on this network (another network, another asset); `offered` lists what the seller asked |
| 422 | `self_dealing` | the seller's `payTo` is a vet402 wallet |
| 422 | `not_x402` / `requirements_body_only` | no 402, a 0 price, or requirements vet402 cannot pay |
| 400 | `invalid_target` / `missing_url` / `invalid_json` | not `https`, a private address, no `url`, a POST body that is not JSON |
| 405 | `method_not_allowed` | `HEAD` (it would deliver no body) |
| 413 / 415 | `request_too_large` / `unsupported_media_type` | POST body above 64 KB, or not `application/json` |
| 404 | `not_found` | any path other than exactly `/v1/buy` (`/v1/buy/`, `/V1/buy`, ...) |
| 422 | `not_listed` | POST purchase: the URL does not answer a plain GET with a 402 and is not listed in the Bazaar for POST (see POST below) |
| 429 | `rate_limited` | more than 30 price reads per minute from one client IP (counted in memory, per instance) |
| 400 | `unsupported_x402_version` | the payment is x402 v1 (checked after verify, before settlement) |
| 503 | `daily_cap_reached` / `cap_check_unavailable` | today's cap cannot hold this seller's price (reserved before settlement) |
| 502 | `probe_error` / `bazaar_unavailable` | the seller's 402 (or the Bazaar, for a POST-only seller) could not be read |

**Payment.** The paid request reads the seller's 402 again and computes the price again. x402 v2 accepts a payment only if what you signed (`accepted`: amount and `extra`) deep-equals that new computation, and the facilitator verifies the signed transfer against the exact amount. So if the seller's price or `payTo` changed since your free read, or the payment was altered, the answer is a 402 and nothing settles; ask again for the new price. x402 v1 payments are refused (v1 is matched by scheme and network only). Before settling, vet402 **reserves** the seller's price on today's cap, so two purchases near the cap cannot both be charged when only one can be paid (`503`, not charged); the reservation is given back if your payment does not settle.

**After your payment settles** (settle-first), vet402 pays the seller through the same `probe()` as `/v1/check` (per-call cap, `payTo` lock) using the reservation it already holds (not a second one), at most the seller price you paid for. If the seller now asks more, or another `payTo`, vet402 does not pay it (`price_changed`).

**What you get back.**

- Seller paid: `200` with the seller's body **as it was delivered**, byte for byte, with its `content-type` (bodies up to 1 MB). Any 2xx of the seller is answered as 200; a 204/205 or another empty body comes back as an empty body. The seller's own status is in `x-vet402-seller-status`. Headers: `x-vet402-verdict` (`ALLOW`/`REFUSE`), `x-vet402-reason` (the reason words above), `x-vet402-customer-tx`, `x-vet402-seller-tx`, `x-vet402-seller-price`, `x-vet402-seller-status`, and the x402 `PAYMENT-RESPONSE` of your payment. `REFUSE` (for example `delivery_missing_keys`) still comes with the body: you paid for it and it is yours, the header tells you it is not what the seller declared. The body is served with `x-content-type-options: nosniff` and `content-security-policy: sandbox`, so seller HTML never runs on vet402's origin.
- Seller not paid after you paid (its payment failed, it changed its price, it could not be reached): `502` JSON `{ error: "seller_not_paid", reason, detail, customerPayment, downstreamPayment, refund: "none" }` with `x-vet402-verdict: REFUSE` and `x-vet402-customer-tx`.
- Seller paid but its body is above 1 MB: `502` JSON `{ error: "response_too_large", ..., refund: "none" }` with both tx headers. vet402 does not forward part of a body.
- **There are no refunds.** Everything vet402 can check without paying is checked before your payment settles; what can only go wrong after it (the seller's payment, the seller's answer) is reported with both tx ids.

**POST.** Only `application/json`, up to 64 KB (a chunked body is cut as soon as it passes 64 KB, whatever `content-length` says). Your body is sent to the seller **only after your payment has settled**, unchanged, with `content-type` as the only header. Before that (the free price read and the paid request's price read), vet402 never sends it anywhere, so `/v1/buy` cannot be used as a free relay: the price is read with a plain `GET` of the URL, and if that is not a readable 402 (a POST-only seller), with a `POST` of the example input the seller published in the Bazaar, only for a URL listed there for POST (`buy.priceRead`: `get` or `listed_example`). Otherwise `422 not_listed`. If the seller prices your POST differently from the read, vet402 does not pay more than you paid for (`502 seller_not_paid`, `price_changed`).

On `/activity`, a purchase is one customer payment (seller price + fee) paired with one seller payment (see "Public activity ledger" for how a purchase below the check price is recognised). `npx tsx scripts/buy-demo.ts <x402 URL>` buys once as the TestNet client and prints the confirmed round of both payments.

## Use from an agent (MCP)

An agent that pays Algorand x402 endpoints can ask vet402 first. `mcp/` is a stdio MCP server with three tools:

| tool | input | cost |
|---|---|---|
| `vet402_check` | `{ url }` | **pays 0.05 USDC** per call to vet402 from the wallet in `ALGORAND_MNEMONIC`. Returns the verdict, the reason, both tx ids and the delivery summary |
| `vet402_buy` | `{ url, method?, body? }` | **pays the seller's price + 0.005 USDC** through `/v1/buy`, only after reading the price for free and only if the total is at most `VET402_MAX_BUY_USDC` (default 0.10). Returns the seller's body, the verdict, the reason and both tx ids. No refunds |
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

`src/server.ts` default-exports a Hono app, which Vercel's zero-config Hono support picks up (Node.js runtime, Fluid compute). The app is built lazily on the first request. `vercel.json` only pins `npm ci`. The function limit is `export const config = { maxDuration: 300 }` in `src/server.ts` (an audit buys up to 10 resources in one request); a `functions` entry in `vercel.json` is not matched for zero-config Hono. Keep the value a literal: Vercel reads it statically, and a test checks it. Do not add `src/index.ts` or `src/app.ts`: Vercel also looks for those names.

### Environment variables

| name | required | example / default | notes |
|---|---|---|---|
| `X402_NETWORK` | yes | `mainnet` | `testnet` (default) or `mainnet` |
| `I_UNDERSTAND_MAINNET_MOVES_REAL_FUNDS` | MainNet | `yes` | lock; anything else refuses to start |
| `PAYER_MNEMONIC` | yes | (secret) | wallet that pays sellers; **encrypted env only** |
| `VET402_PAY_TO` | no | MainNet default `RMMD7KW5…PIY33Q` | where customers pay vet402 |
| `CHECK_PRICE_USDC` | no | `0.05` | customer price |
| `BUY_FEE_USDC` | no | `0.005` | vet402's fee on `/v1/buy` (added to the seller's price); above 0, and `PROBE_MAX_PER_CALL_USDC` + fee must stay below `AUDIT_PRICE_USDC` |
| `AUDIT_PRICE_USDC` | no | `0.50` | price of one seller audit |
| `AUDIT_MAX_SPEND_USDC` | no | `0.40` | most one audit pays sellers; must be below `AUDIT_PRICE_USDC` |
| `AUDIT_MAX_TARGETS` | no | `10` | most resources one audit checks (1–50) |
| `AUDIT_DEADLINE_MS` | no | `240000` | whole ms, at most 60 s under the function limit (`export const config = { maxDuration: 300 }` in `src/server.ts`); anything else refuses to start. The rest of an audit is SKIPPED after this |
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
| `src/lookup.ts` | `GET /v1/verdict`: paid lookup of vet402's own earlier purchase (own settle-first middleware, pays no seller) |
| `src/buy.ts` | `GET\|POST /v1/buy`: free price from the seller's 402, own settle-first middleware, body passed through |
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

- **Customer payment**: a USDC transfer to `payTo` inside an atomic group that also holds a transaction from the x402 facilitator's fee payer (GoPlausible `ZMFK2OI7…RA22AA`). Only the facilitator can sign that transaction. Other USDC deposits to `payTo` (for example exchange withdrawals, or transfers by app call) are not rows; their tx ids are listed in `notCounted` in the JSON. A payment below the check price counts only as (a) a `/v1/verdict` lookup, when it is exactly the verdict price (`kind: "verdict"`; it never takes a seller payment), or (b) a `/v1/buy` purchase (`kind: "buy"`), when a seller payment pairs with it and (payment − `BUY_FEE_USDC`) ≥ that seller payment. Any other small payment, including one no seller payment follows, is `below_price` and not a customer, so small deposits cannot inflate the customer count. When several customer payments could take a seller payment, the order is: a purchase whose (payment − fee) equals the seller payment exactly, then a check or an audit, then a purchase it only fits. So a small payment slipped in between does not take a check's or an audit's seller payment unless it matches it to the atomic unit, and a purchase's own seller payment is not taken by an earlier check.
- **Operator test**: the customer is vet402's own `payTo` or payer wallet (exact address match). These rows are marked `operator test` and are left out of the customer totals. The two MainNet checks in the run record below are operator tests.
- **Seller payment**: any USDC sent by the payer wallet to an address that is not vet402's own. It is matched to the most recent earlier customer payment that still has room. A check or a purchase (`/v1/buy`) has room for one seller payment (within 300 s); a lookup (`/v1/verdict`) has none. A seller audit (a customer payment of at least the audit price) has room for up to `AUDIT_MAX_TARGETS` (within 900 s), because one audit buys several resources. A seller payment with no such customer payment is listed under `unmatchedPayouts`, not hidden.
- **Audits are one row.** An audit is one customer payment: it is counted once in the customer totals, marked `audit`, and its seller payments are listed under it (`sellerPayments[]` in the JSON; `seller`/`sellerTx` repeat the first one). The headline says how many seller payments were inside audits (`totals.audits`), so several seller payments per audit do not read as several customers.
- Pairing uses amounts and times only (x402 transfers carry no reference). If a check and an audit run at the same moment, a seller payment can be credited to the wrong one of the two; customer counts are unaffected.
- Totals: distinct paying customer addresses (operator excluded), customer payments and USDC, seller payments and USDC, audits, operator tests.

The page needs only public addresses. The payer address is taken from `PAYER_MNEMONIC` as before, or from `VET402_PAYER_ADDRESS` if set.

## Pay in Base USDC (`BASE_ACCEPT`, off by default)

With `BASE_ACCEPT=on` and `BASE_PAY_TO=<0x address>`, every paid route (`/v1/check`, `/v1/audit`, `/v1/verdict`, `/v1/buy`) answers its 402 with a second accept after the Algorand one: `exact`, Base USDC (`eip155:8453`, `0x833589fC…2913` on MainNet; Base Sepolia `eip155:84532`, `0x036CbD53…CF7e` on TestNet, following `X402_NETWORK`), the same atomic USDC amount (both have 6 decimals; `/v1/buy` and `/v1/audit` price dynamically on both), `payTo = BASE_PAY_TO`, `extra.tag = x402-global-challenge`. The Bazaar declaration sits next to both accepts. Only the customer's leg moves to Base: vet402 holds no Base key (`BASE_PAY_TO` only receives), and sellers are still paid on Algorand from the payer wallet, after the customer's payment settled. Settle-first, the caps, HEAD pricing, exact-path checks and the payTo match work the same for a Base payment (`test/base-accept.test.ts`). With the switch off every 402 is identical to the one before Base existed (golden file `test/fixtures/x402-402-off.json`, taken from e563b4c).

`/activity` then also counts Base customers: USDC transfers into `BASE_PAY_TO` are listed from Blockscout (keyless) and each one is proven from its receipt on the public RPC: a successful transaction sent by the GoPlausible facilitator's EVM signer (`0x13600897…66fa`) to the USDC contract, with USDC's EIP-3009 `AuthorizationUsed` for the payer. Plain transfers are not counted. If Base cannot be read, the page says Base payments are not counted instead of leaving them out silently. `@x402/evm` is pinned to 2.11.0 like the rest of `@x402/*`. TestNet customer run: `scripts/base-customer-demo.ts`.

## Daily delivery board

`GET /board` (HTML) and `GET /board.json` (free) show whether Algorand x402 sellers delivered what they declared, when vet402 bought from them with its own money. `?view=census` shows the census run.

- **Daily** (`npx tsx scripts/board-sweep.ts`): from the Bazaar feed, MainNet USDC resources priced at or under the per-call cap, seen in the last 7 days, **one per host (the cheapest)**. vet402's own hosts and any resource paying one of vet402's addresses are excluded. Results go to `board/YYYY-MM-DD.json` and `board/latest.json`.
- **Census** (`--census`): every listed resource under the per-call cap, once each. Results go to `board/census-YYYY-MM-DD.json` and `board/census-latest.json`. Concurrency is 1–4 (default 3). The order takes turns between hosts (round-robin), a host never has two purchases in flight, and purchases from one host are at least 2 s apart (`--host-gap-ms` can only raise it). `/board?view=census&date=YYYY-MM-DD` shows one day's census.
- The census is rerun on 9/28 with the corrected verdict code; the 9/27 results are kept (`board/census-2026-09-27.json`). The workflow has a one-off schedule for it: 2026-09-28 00:30 UTC (`30 0 28 9 *`, mode census).
- `GET /board/payments.csv` (free): vet402's own purchases, one line per settled payment (`time_utc`, `payer`, `seller_pay_to`, `host`, `amount_usdc`, `tx`, `class`), from the daily file and every census file, deduplicated by tx. To leave vet402's own purchases out when judging a leaderboard, use this CSV.
- `GET /board/verdicts.json` (free): the same purchases as JSON, one item each (`purchaseTx`, `network`, `payer`, `payTo`, `host`, `resource`, `amountUsdc`, `class`, `reason`, `checkedAt`, `receiptUrl` at the facilitator, `sourceFile`); rows vet402 did not pay are left out.
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

### 2026-09-27: one seller payment without a customer payment (bug, fixed)

`OZZH2TRA3MANN55OTTWOXVBDHRRYIJ52IBXEPVBBE4BNQUOR6CCQ` (04:42 UTC, 0.01 USDC to canix402) had no customer payment in front of it. An unpaid `HEAD /v1/check` skipped the payment check and reached the handler, which paid the seller. Fixed at 05:28 UTC in 3d1377f: HEAD is priced like GET, and the handler refuses without a settled customer payment. It shows on `/activity` under unmatched seller payments.

## TestNet run record

### 2026-09-27 JST: `vet402_buy` through the MCP server (stdio)

Local vet402 and test sellers; an MCP client started `mcp/src/index.ts` with the TestNet client wallet and called `vet402_buy {url: http://localhost:4131/honest}`. Free price 0.01 + 0.005 = 0.015 USDC (within `VET402_MAX_BUY_USDC` 0.10), then paid: `ALLOW delivered`, body `{"forecast":"sunny","temperature":21,"city":"Tokyo"}`, customer → vet402 `7NGHDKTBN4CZH5SQTPWMYAFA3QIRUC7LL3WSXAGGXPRTH63564EQ` (round 67711416), vet402 → seller `GNDFRAX4AAEWGEJQ6CZP3SYCPXPYPOPH5MMVENCKMKJKPLGQHOVA` (round 67711418). `/activity.json`: `kind: "buy"`, 0.015 paired with 0.01.

### 2026-09-27 19:4x JST: `/v1/buy` after review fixes (reservation before settle, 2xx as 200, v2 only)

Same setup, plus the test seller `/empty` (answers 204 after being paid). Free price 0.01 + 0.005 = 0.015 USDC for each paid row.

| target | HTTP | verdict | body returned | customer → vet402 (round) | vet402 → seller (round) |
|---|---|---|---|---|---|
| `/honest` | 200 | ALLOW delivered | `{"forecast":"sunny","temperature":21,"city":"Tokyo"}` | `3CC6HXFANU5W35WJ7PMHSYBDRKMEAIRTLITWKTZIU6TDVKVUFRAQ` (67711187) | `5AWCO55CRPGC2STAAOPHSCQEIEFHQPUERJSPOBSFM5UJYXXS2DJQ` (67711189) |
| `/liar` | 200 | REFUSE delivery_missing_keys | `{"message":"thanks for paying"}` | `Y7LS7A4INLUORAUSPFNK4RNBDVCYFFRBPVCP4IZNG3FMZFTCEA5A` (67711191) | `NRYI7TO33UQWESISQ2AA5VGIHBXV6FUR7FTO4P4S525TKQZHA64A` (67711193) |
| `/empty` (seller 204) | 200 | REFUSE not_json | empty | `BGJXNV7JQ7NPZ7AONVO3CVCHBYRW7QNMCMNLTJWJAW4NSSEKEZKQ` (67711195) | `LQ2Z2WN36AJSUNPFXI4IE7MHGD5FFT2QHJXHNTZDPRJ75J7XGXLA` (67711197) |
| `/pricey` | 422 | price_over_cap (free read) | none, nothing charged | none | none |

The customer's payment is in an earlier round than the seller's in every paid row. `/activity.json` listed each of the three as `kind: "buy"`, 0.015 paired with its one 0.01 seller payment.

### 2026-09-27 19:27 JST: first purchases through vet402 (`/v1/buy`)

Local vet402 and the test sellers (`src/sellers.ts`), `npx tsx scripts/buy-demo.ts <url>`. Free price for each: seller 0.01 + fee 0.005 = 0.015 USDC.

| target | HTTP | verdict | body returned | customer → vet402 (round) | vet402 → seller (round) |
|---|---|---|---|---|---|
| `/honest` | 200 | ALLOW delivered | `{"forecast":"sunny","temperature":21,"city":"Tokyo"}` | `2DOVNKF6ONFGV2H6S5HT7KN27AHWC4TF7NPERBAZCUU3EQUKUX7Q` (67710831) | `QUCDWVD2GTAO5XJRBWL5WE4KPX4KUHPZKDZN2JJXABQNCNBJ5RZQ` (67710833) |
| `/liar` | 200 | REFUSE delivery_missing_keys | `{"message":"thanks for paying"}` | `77U2RWAGNCZ645SCTGPMZ6FF4FYT5WEYM4KLO2KUO67IZOCL325A` (67710835) | `HZKUB576WG4E56E34HPOAK7ZSMK3NDNGXGWDR7O2M62KJJIYS3TQ` (67710837) |
| `/pricey` | 422 | price_over_cap (free read) | none, nothing charged | none | none |

In both paid rows the customer's payment is in an earlier round than the seller's. `/activity.json` on the same server paired each 0.015 customer payment with its one 0.01 seller payment.

### 2026-09-27 JST: first seller audit (`/v1/audit`)

One audit of the test seller `Y6IYAN3L…HZKEJXXM` (`/honest`, `/liar`, `/pricey` under one payTo). Free plan: found 3, checking 3, paying 2.

| resource | verdict | reason | seller tx | round |
|---|---|---|---|---|
| customer → vet402 (0.50 USDC) | | | `JEFWCRC3R4GW45R54LAORFRDMYMEOABATC6XJPRTJ6RNYJFAZDGA` | 67704026 |
| `/honest` | ALLOW | delivered | `KYV7WFWRYXO5NO3NULY4QTJ7EBB2XHMMR5VIX4NLRKKT7GATFSNA` | 67704028 |
| `/liar` | REFUSE | delivery_missing_keys | `VPEF6Z773KLRBXGGYRWEZDWLGCF4N2CW67UU3OJPIIGYJK4B2Y2A` | 67704030 |
| `/pricey` | REFUSE | price_over_cap | not paid | |

The customer's round is earlier than both seller payments. `/activity.json` shows the audit as one row (`kind: "audit"`) with both seller payments under it.

Re-run after the review fixes (plan cache, payTo lock, paying cap): customer `F7XPSMXYWE6QWSPEL4AJNN62FQPPDFSMWRIHT6AZEJ6MUSS3NIXA` round 67704373 → `/honest` ALLOW `6J2AP5JFKBSYQSJQTIRGV5S7FID4MGJOQBUA7XEL2EQXODXSYDCQ` round 67704375 → `/liar` REFUSE delivery_missing_keys `56CKOPLE7O6THCQGGBKTG7IPCS2I6VCFSBFSHNWU4HKPVNVC3TCQ` round 67704377 → `/pricey` REFUSE price_over_cap, not paid.

Re-run with the planned count in the price (`extra.auditPaying`): customer `TLBQPDEPFTB6EZYHJEDAWLAWOVUAGZ3WGAYRA55TS57Q5EOVMVPA` round 67704696 → `/honest` ALLOW `437SY4KPONC7ZHCPANDSHXPAVD657I5LBWCNOJRTDVCK2IGK5F6A` round 67704698 → `/liar` REFUSE delivery_missing_keys `TGN3JAQKLFSR4ONBADA27EQIU4T6C67U7CCAJ5P2Y27DBHWV533Q` round 67704700 → `/pricey` REFUSE price_over_cap, not paid.

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
