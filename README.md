# vet402 (Algorand)

**Before your AI agent pays for an API, vet402 buys it once with its own money and shows you what came back.** The x402 payment is the product: vet402 can only see what a seller sends by paying it, on Algorand MainNet, with the receipt on chain.

- Try it free, no wallet: https://vet402-algorand.vercel.app/try
- What vet402 got from every Algorand seller: https://vet402-algorand.vercel.app/board
- Every payment it received: [/activity](https://vet402-algorand.vercel.app/activity). Every payment it made to other teams in the challenge: [/fairness](https://vet402-algorand.vercel.app/fairness)

What the check covers: after payment, a 2xx answer of non-empty JSON with the keys the listing declares (see [Reasons](#reasons-stable-contract)). It does not check whether the content itself is right.

Built for the Algorand Foundation Global x402 Challenge (Orchestrator track). The payment requirements carry `accepts[].extra.tag = "x402-global-challenge"`.

You name an x402 endpoint and pay vet402 0.05 USDC. vet402 pays that endpoint itself, checks what came back against what the seller declared (the output schema's `required` keys, or, when there is no `required` list, at least one of the example's keys, and the `402 accepts`), and returns:

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
                                  │ (3) read seller's 402 → price ≤ caps? payTo not vet402's?
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
| `self_dealing` | REFUSE (`/v1/check` on a vet402 host: HTTP 422 on the unpaid request, no 402) | no |
| `requirements_body_only` | REFUSE | no |
| `no_supported_accept` / `not_x402` / `probe_error` | REFUSE | no |
| `invalid_target` | REFUSE (HTTP 400: on the unpaid request instead of a 402, and again before settlement; customer not charged) | no |

`/v1/check` refuses on the unpaid request, without a 402, a URL it cannot buy: not `https`, a host that does not resolve within 3 s, a private address, or a vet402 host (`invalid_target` 400 / `self_dealing` 422, JSON with `detail` and `charged: false`). The bare `/v1/check` with no `url` (the URL listed in the Bazaar) still answers the 402; a payment without `url` is refused before it settles. The unpaid check resolves at most 30 hosts per minute per client, then answers `429 rate_limited` without resolving. The same checks run again after the payment is verified and before it settles. After settlement the purchase checks the URL once more (`https`, resolves, public addresses) and refuses a seller whose `payTo` is a vet402 wallet.

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
- **No self-dealing.** vet402 never pays a seller whose `payTo` is one of its own wallets (the customer-facing `payTo` or the payer wallet); those checks return `self_dealing`. vet402 does not buy its own checks to inflate volume; the 3 test checks the operator paid from vet402's own payer wallet on 2026-09-27 to try the live deployment are self-payments and are listed as operator tests on `/activity` and `/fairness`. Every payment the payer wallet makes to a seller for `/v1/check`, `/v1/audit` or `/v1/buy` follows a customer payment that has already settled; the one exception, a bug on 2026-09-27, is recorded in the MainNet run record below. The board wallet (census and daily sweep) and the trial wallet (`/try`) pay sellers without a customer, from vet402's own money: the board wallet's purchases are on `/board` (5 census payments on 2026-09-27 that the files still record as not paid, because they cannot be paired one to one with a row, are listed under [Corrections](#corrections)), the trial wallet's on `/try/log`, and every payment to another team in the challenge, read from the chain, on `/fairness`.
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

## Delivery certificate (`/cert/<id>`)

Every paid audit also gets a free public page: `certificateUrl` in the audit answer, `GET /cert/<customer payment tx id>`, and a README badge at `/cert/<id>/badge.svg`. It shows the seller, each resource vet402 bought with its verdict and reason, vet402's payment to the seller, and who paid for the audit (short address). If the buyer is a vet402 wallet or the seller's own `payTo`, the page and badge say `self-purchased`.

- No server state and no extra service. Right after the audit, vet402's payer wallet sends itself a 0-ALGO payment group (fee 0.001 ALGO per note) whose notes hold the record: `vet402-cert/1:<customer tx>:<i>/<n>:<JSON>`. The x402 payments themselves carry no link to each other (their note is `x402-payment-v2-<ms>`), so this signed note is the link.
- The page reads everything back from the indexer and shows only what it finds: the customer payment must be an x402 settlement to `payTo` of at least the audit price, the note must be sent by the payer to itself and name that tx, and each seller payment must be a USDC transfer from the payer after the customer's payment (otherwise that row says "not verified"). Any other id, a missing tx, or a note sent by anyone else gives 404.
- The record never delays the audit answer by more than 40 s. If it is submitted but not yet confirmed, the answer has `certificatePending: true` and `certificateUrl` ends in `?anchor=<tx>`; the page then says "Recording…" (202) until the indexer has it. If it could not be written, the answer has `certificateError` and the audit result is still complete.
- **Operations:** the payer wallet needs ALGO for these fees. Below 1 ALGO (`CERT_MIN_PAYER_ALGO`) vet402 writes no record, answers `certificateError` ("low on ALGO") and logs a line starting with `ALERT vet402 cert` (Vercel logs). Top the payer wallet up with ALGO when you see it.
- Get one from the command line (plain JS, runs from this repo): `npx -y github:kzmttkc/vet402-algorand <seller>` shows the free plan; add `--yes` with `ALGORAND_MNEMONIC` set to pay and print the certificate URL.

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
| `AUDIT_DEADLINE_MS` | no | `190000` | whole ms, at most 105 s under the function limit (room for settle, planning and the certificate record) (`export const config = { maxDuration: 300 }` in `src/server.ts`); anything else refuses to start. The rest of an audit is SKIPPED after this |
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
| `src/fairness.ts` | `GET /fairness`: vet402's payments to other challenge teams (leaderboard + indexer, read live) |
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

## Fairness: payments to other challenge teams

vet402 buys from every listing by the same public rules (see [Daily delivery board](#daily-delivery-board)), and that includes the other teams in the Algorand x402 challenge. Those purchases are x402 payments to them, so they can raise their volume on the challenge leaderboard, not vet402's. `GET /fairness` (HTML) and `GET /fairness.json` list every one of them. Both are free and read-only, and are mounted on MainNet only.

- **vet402 takes no money from any participant for buying from them, and there is no arrangement to buy from each other.** The page also lists, from the chain, any USDC that a participant address sent to one of vet402's addresses, so the claim can be checked.
- **Participants**: every challenge-tagged merchant on GoPlausible's leaderboard (`/data/leaderboards?range=all&env=mainnet&src=x402-global-challenge&group=merchant&cat=merchants`, every page), except vet402's own merchant (matched by `payTo` or by id, `FAIRNESS_OWN_MERCHANT_IDS`, default `f24265ae51cee85e`). A participant's addresses are its `address` plus every Algorand MainNet address in its `accounts` (some teams list more than one; TestNet accounts are ignored).
- **Payments**: USDC (ASA 31566704) asset transfers sent by vet402's three wallets (the payer `OZ3KML…`, the board wallet `HVRJUK…` and the free-try wallet `2MSEYN…`), read from the Algorand indexer. ALGO payments (the try wallet's 0-ALGO notes), zero-amount transfers and transfers to vet402's own addresses are not counted. The addresses can be overridden with `VET402_PAYER_ADDRESS`, `VET402_BOARD_PAYER_ADDRESS` and `VET402_TRIAL_ADDRESS`.
- **Why vet402 paid**: a board-wallet payment is the per-listing census or the daily sweep, matched by the tx id the run recorded or by the run's time window (the same board files as `/board/payments.csv`); a try-wallet payment is a free try; a payer payment is a check someone asked vet402 for. Teams with many payments have many listings: the census buys each listed resource once per run, and the page shows each team's listings in the latest census.
- **The chain is the record, not the census file.** A census row can say `payment_failed` ("transaction already in ledger") although the payment did settle; the page counts it, because it is on chain.
- **Freshness**: cached for 10 minutes (`Cache-Control: public, max-age=600, s-maxage=600`). If the indexer or the leaderboard cannot be read, the page says it cannot read the numbers now and shows none (503; the JSON answers `{"error":"cannot_read_now"}`); it never shows old or partial totals.

## Pay in Base USDC (`BASE_ACCEPT`, off by default)

With `BASE_ACCEPT=on` and `BASE_PAY_TO=<0x address>`, every paid route (`/v1/check`, `/v1/audit`, `/v1/verdict`, `/v1/buy`) answers its 402 with a second accept after the Algorand one: `exact`, Base USDC (`eip155:8453`, `0x833589fC…2913` on MainNet; Base Sepolia `eip155:84532`, `0x036CbD53…CF7e` on TestNet, following `X402_NETWORK`), the same atomic USDC amount (both have 6 decimals; `/v1/buy` and `/v1/audit` price dynamically on both), `payTo = BASE_PAY_TO`, `extra.tag = x402-global-challenge`. The Bazaar declaration sits next to both accepts. Only the customer's leg moves to Base: vet402 holds no Base key (`BASE_PAY_TO` only receives), and sellers are still paid on Algorand from the payer wallet, after the customer's payment settled. Settle-first, the caps, HEAD pricing, exact-path checks and the payTo match work the same for a Base payment (`test/base-accept.test.ts`). With the switch off every 402 is identical to the one before Base existed (golden file `test/fixtures/x402-402-off.json`, taken from e563b4c).

`/activity` then also counts Base customers: USDC transfers into `BASE_PAY_TO` are listed from Blockscout (keyless) and each one is proven from its receipt on the public RPC: a successful transaction sent by the GoPlausible facilitator's EVM signer (`0x13600897…66fa`) to the USDC contract, with USDC's EIP-3009 `AuthorizationUsed` for the payer. Plain transfers are not counted. If Base cannot be read, the page says Base payments are not counted instead of leaving them out silently. `@x402/evm` is pinned to 2.11.0 like the rest of `@x402/*`. TestNet customer run: `scripts/base-customer-demo.ts`.

## Daily delivery board

`GET /board` (HTML) and `GET /board.json` (free) show whether the paid answers of Algorand x402 sellers had the keys they declared, when vet402 bought from them with its own money (the content itself is not checked). `?view=census` shows the census run.

- **Daily** (`npx tsx scripts/board-sweep.ts`): from the Bazaar feed, MainNet USDC resources priced at or under the per-call cap, seen in the last 7 days, **one per host (the cheapest)**. vet402's own hosts and any resource paying one of vet402's addresses are excluded. Results go to `board/YYYY-MM-DD.json` and `board/latest.json`.
- **Census** (`--census`): every listed resource under the per-call cap, once each. Results go to `board/census-YYYY-MM-DD.json` and `board/census-latest.json`. Concurrency is 1–4 (default 3). The order takes turns between hosts (round-robin), a host never has two purchases in flight, and purchases from one host are at least 60 s apart (`--host-gap-ms` can only raise it). A census buys at most 5 resources per seller host per UTC day (purchases already made that day count); the rest are written as `SKIPPED not_measured_this_run`, not contacted, not paid and not counted against the seller. Which 5 rotates by day. Until 2026-09-28 there was no per-host limit, and one host received 581 purchases in a single census; that burst is why this limit exists. `/board?view=census&date=YYYY-MM-DD` shows one day's census.
- The census is rerun on 9/28 with the corrected verdict code; the 9/27 results are kept (`board/census-2026-09-27.json`). The workflow has a one-off schedule for it: 2026-09-28 00:30 UTC (`30 0 28 9 *`, mode census).
- A placeholder in a seller's example input (the whole string `<...>` but not an HTML tag, `{{...}}` or `YOUR_...`) is replaced with a fresh random value that fits the hint or schema on every purchase (`<sha256-hex-64-chars>` → 64 random hex characters, uuid → UUID v4) and the row records it (`filled: ["hash"]`); a placeholder vet402 does not make up (an address, an email, a key, a URL…) makes the row `REFUSE placeholder_unfillable`, not sent and not paid, shown as UNCLEAR.
- `GET /board/payments.csv` (free): vet402's own purchases, one line per settled payment (`time_utc`, `payer`, `seller_pay_to`, `host`, `amount_usdc`, `tx`, `class`), from the daily file and every census file, deduplicated by tx. To leave vet402's own purchases out when judging a leaderboard, use this CSV.
- `GET /board/verdicts.json` (free): the same purchases as JSON, one item each (`purchaseTx`, `network`, `payer`, `payTo`, `host`, `resource`, `amountUsdc`, `class`, `reason`, `checkedAt`, `receiptUrl` at the facilitator, `sourceFile`); rows vet402 did not pay are left out.
- `GET /seller/<host>` (free) shows the latest result for each resource of one seller, with the vet402 → seller tx, and the Markdown for a README badge, `GET /badge/<host>.svg` (cached 1 hour). The paid re-check box (`/v1/audit?seller=`) is shown only with `SELLER_PAGE_AUDIT=on` (price `AUDIT_PRICE_USDC`, default 0.50).
- `--dry-run` lists the targets and the cost estimate, and pays nothing. It needs no key. `--targets <url,...>` runs an explicit list (TestNet test sellers).
- Each purchase goes through the normal `probe()`: per-call cap before any signature, and a daily cap read from the chain (indexer) with a local backup ledger. The board has its own daily cap, `BOARD_MAX_PER_DAY_USDC` (default = `PROBE_MAX_PER_DAY_USDC`), and its own ledger file. The `/v1/check` caps are unchanged. When the cap is hit, the remaining rows are written as `SKIPPED daily_cap` and the run stops.
- Payment check (since 2026-09-30): at the end of every daily and census run, vet402 reads from the indexer every USDC transfer the board wallet sent during the run and checks that each one is on a row. A transfer on no row (a paid request that timed out, or a 200 without a settlement receipt) is written to its row only when the pairing is one to one, with the same five conditions as the 2026-09-29 corrections under [Corrections](#corrections): to the row's `payTo`, for the row's price, in an x402 settlement group, on no other row, and signed (the `x402-payment-v2-<ms>` note) between 30 s before and 1 s after the row's time. The row gets `paid: true`, the tx and a note in `detail`; its reason and class do not change. Any other transfer is kept in the file under `reconcile.unmatched`, `/board` shows how many, and the workflow fails after committing the files. When the indexer cannot be read, the file says the check did not run, and the workflow fails too. The check is repeated: a later scheduled run the same UTC day checks from the run's start to that time, and the first daily run of the next UTC day checks the previous day's files once more, up to 2 hours after their last run, for a payment the facilitator settled late (a transaction stays valid for about 1,000 rounds); what it pairs is written to the previous day's file. A repeated check that cannot read the chain keeps the earlier result and its list, adds that the latest check did not run, and fails the workflow. `/board` names the time the check covered. `npx tsx scripts/board-sweep.ts --reconcile <file>` runs the same check on a written file (reads the indexer, pays nothing); on the files before the 2026-09-29 corrections it finds the same rows and tx ids as the hand corrections, and on `census-2026-09-27.json` it lists the 5 transfers that stay unpaired.
- A resource is bought at most once per UTC day, across daily and census runs. Each attempt is recorded before paying, so a rerun resumes and never buys the same URL twice that day. On a day census has run, the daily sweep does not run. The day is fixed when the run starts, and the cap counts that day (indexer window and ledger). The board's ledger is `board/spend-<network>.json`; the workflow commits it with the results, and a run starts from max(ledger, on-chain total).
- vet402 sends the example input the seller published in the Bazaar (query or JSON body). `PUT`/`DELETE`, form bodies and path templates are not bought.
- Reason codes are shown as they are. One result does not rate a seller. Mistakes: GitHub issues.
- These purchases are vet402's own, made to publish the board. They are the one exception to "every downstream payment follows a real customer payment" above, and every one is listed on `/board` with its tx id. On MainNet they are paid from a separate wallet, `BOARD_PAYER_MNEMONIC`. The script refuses to run with the `/v1/check` payer wallet unless `--share-payer-wallet` is given. On a shared wallet, board spending would count toward the customers' daily cap (same on-chain total), and `/activity` could pair a board purchase with a customer payment.
- `.github/workflows/board.yml` runs the daily sweep at 06:17, 12:17 and 18:17 UTC (`workflow_dispatch`: `daily` or `census`, optional dry run) and commits `board/*.json`, including a partial day if the run failed. A scheduled run can start hours late or not at all (2026-09-27: the 21:00 UTC run started at 23:29; 2026-09-28: the 21:00 UTC run never started), so there are three chances in the same UTC day. The first run that finishes the day's purchases writes `completedAt` in `board/<date>.json`; a later run that day finds it, buys nothing, and only repeats the payment check below. A file without `completedAt` (a run that stopped early) is resumed as before. Its one secret, `BOARD_PAYER_MNEMONIC`, comes from the GitHub environment `mainnet-board`, which must be restricted to the `main` branch; the `/v1/check` payer key is not given to the workflow. Dependencies install with `npm ci --ignore-scripts`.

## Corrections

Published board files are corrected only toward what the chain shows, and every correction is listed here. The previous values stay in git history.

- **2026-09-28**: `board/census-2026-09-27.json`, `board/census-2026-09-28.json` (and `census-latest.json`): 3 rows in each file (host `gateway-x402.vercel.app`, 0.005–0.01 USDC each) were recorded as not paid. The facilitator had answered "transaction already in ledger", which vet402 read as a refused payment. The indexer shows vet402's USDC transfer in the same group, settled about 3 s before the row's time. The rows now read `paid: true` with vet402's transfer tx, and `totals.paidUsdc` rose by 0.025 USDC in each file (09-27: 16.052200 → 16.077200). They are shown as "Paid on chain, answered 402, delivered nothing". Found by comparing the files with the chain; checked with `npx tsx scripts/board-sweep.ts --repair-settled <file>` (reads the indexer, pays nothing). Commit 127addc.

- **2026-09-27**: the checker was too strict in the first census (`board/census-2026-09-27.json`, run 04:32 to 05:00 UTC). It read the output schema from only one place, so `required` was almost never seen and every example key was treated as a promise; a key present with a null or blank value also counted as missing. Fixed at 05:17 UTC in 947a6e3 (promised keys = `schema.required`; example keys are hints). The 09-27 file is kept as it was recorded. The 09-28 census reran every listing with the fixed checker: of the 80 rows shown as MISMATCH on 09-27, 55 were DELIVERED, 18 MISMATCH and 7 UNCLEAR on 09-28 (same method and URL). On 2026-09-29 the landing page's census numbers were switched from the 09-27 run to the 09-28 run, and `/demo` got a note under the video, which was recorded on 09-27 and shows the 80.

- **2026-09-29**: content notes on 3 purchases whose result stays DELIVERED. `moltworld.xyz` `POST /v1/models/tts-1/audio/speech` (0.10 USDC; census 09-27 tx `AMVUEQ3SOQQLWOJSCNQPZO4ZEB3LFSHKRGT7TNAAVDOFWBHF7CZQ`, census 09-28 tx `XXF5QZMWBATOATXZCUSZYYABIXYYIZ6A7GRY7RZ6YVFZ4YIPWXPA`) and `POST /v1/models/gpt-audio-mini/audio/speech` (0.02 USDC; census 09-28 tx `5NZLANQCS3GFGVF7KJEXVG3DDVXKE54BU62YB3ZHVVAQYORPCZAA`). The declared keys were present, which is all the checker looks at. The listings describe speech synthesis ("OpenAI TTS-1 text-to-speech synthesis", "OpenAI GPT Audio Mini lightweight expressive voice synthesis"). vet402 sent the seller's Bazaar example (`"input":"Welcome to Moltworld, powered by Algorand x402 payments."`, 56 characters, `"response_format":"mp3"`). Each answer's `id` began with `audio-free-` and its `audio_url` was `data:audio/wav;base64,…`; the recorded first bytes decode to a RIFF/WAVE header with RIFF size 29,876 (the two `tts-1` rows also show PCM, mono, 8,000 Hz). In the seller's public source at commit `c2b4344` (`UncleTom29/moltworld-x402`, `src/providers/openrouter.ts`), this answer comes from `generateWavBase64()`: a sine tone of 8,000 8-bit samples a second whose pitch follows the input characters, lasting input length / 15 = 3.73 s, so 36 + 29,840 = 29,876, returned with an `audio-free-` id. The verdict words are unchanged; the note is shown on those rows on `/board` and `/seller/moltworld.xyz`. The 3 rows stay in the DELIVERED count, because DELIVERED says what the check found (the declared keys) and a file is corrected only toward what the chain shows; the result column marks each one as a mismatch outside the check (a generated tone, not speech), and the `/board` headline says how many DELIVERED rows carry a content note.

- **2026-09-29**: `board/census-2026-09-27.json`, `board/census-2026-09-28.json` (and `census-latest.json`): 13 rows recorded as not paid (`payment_failed` after a timeout, or a 200 or other status without a settlement receipt) were paid on chain; 3 on 09-27, 10 on 09-28. Example: `GET eth-avm-light-client.vercel.app/verify-receipt/25782067/2/0` on 09-27, recorded as a timeout at 04:45:15 UTC, settled in `GP46GFPSE3JAER7CNWN65GRRJVVNJHEKE4LJ363KZGMA7LR24CFQ` (round 65433626, 04:45:15 UTC, 0.01 USDC). Each row was paired with a transfer only when the pairing is one to one: a USDC transfer from the board wallet that is on no row of any board file, to the row's `payTo`, for the row's price, in an x402 settlement group (the facilitator's fee payer signs the other transaction, vet402's transfer has fee 0), and signed while that row's paid request was open. The signing time is the one vet402's client writes into the transfer's note (`x402-payment-v2-<ms>`), on the same clock as the row's time; on the 1,149 rows recorded paid when the pairing was made (the 1,148 recorded paid before these corrections, 578 on 09-27 and 570 on 09-28, plus the GP46 row), it is 3.1 to 26.7 s before the row's time (the same range on all 1,161 paid rows after the corrections), and the pairing comes out the same with a 25, 30 or 60 s window. The rows now read `paid: true` with that tx and a note in `detail`; reason and class are unchanged (UNCLEAR, not counted against the seller: the seller was paid for an answer vet402 did not read). `totals.paidUsdc`: 09-27 16.077200 → 16.107200 (paid rows 578 → 581), 09-28 16.692200 → 16.787200 (570 → 580). The landing page's census numbers follow (580 paid, 16.79 USDC). Read from the indexer, edited by hand; `--repair-settled` cannot find these rows, because it looks only for the tx id in a facilitator's "already in ledger" error.

- **2026-09-29**: `board/2026-09-29.json` (daily): 2 rows recorded as `status 200, no settlement receipt` were paid on chain, by the same rule: `api.algofile.io/api/v3/x402/bazaar/asset-storage-info` (05:35:41 UTC, `MH6I6JKDXUKAR4R4OA6NDGFMMDVVOJVMTMAS2WZEP5VA2JBA22BA`, 0.001 USDC) and `x402-echo-service.vercel.app/api/echo/test` (05:40:52 UTC, `522EQ5HAVMRI4P37F2WCLXNSZ7L22V7FL2WF4Q6QN3GWIZTBFYYA`, 0.01 USDC). Both stay UNCLEAR; `totals.paidUsdc` 0.961100 → 0.972100 (paid rows 54 → 56). `board/latest.json`, the copy of the day's file that the daily run writes, is not edited here.

- **Not corrected (2026-09-29)**: 5 more board-wallet transfers during the 09-27 census are on chain and on no row, 0.005 USDC in total, and stay out of `census-2026-09-27.json` because no one-to-one pairing exists: 3 to `api.algofile.io` (0.001 USDC each, signed within 0.4 s of each other, while 3 of its rows were open and answered within 10 ms) and 2 to `algorand.ottoai.services` (0.001 USDC each; 3 and 2 of its rows were open when they were signed). The 09-27 run had no per-host limit, so one host could have several purchases in flight. `/fairness` counts them, because it reads the chain.

- **2026-09-29**: the commit history was rewritten once to change the author name on every commit. File contents are unchanged apart from the author name in `LICENSE`, `README.md` and the `package.json` files; commit ids changed (for example, the correction above was 3db3e6e before).

## MainNet run record

### 2026-09-27 12:1x JST: first MainNet checks (operator smoke test)

The paying client here is vet402's own payer wallet, so these three calls are a deployment check by the operator, not customer usage.

| target | verdict | payment 1 (client → vet402) | payment 2 (vet402 → seller) |
|---|---|---|---|
| blocksigner.org/commission/pulse (0.01 USDC) | ALLOW delivered | UTFFAINOX54Y4BI6K5ANNVWQRXGYM56P7NETSMCD4QYCGO5TJVOA (round 65431727, 0.05 USDC) | 4GMCTRIGQYL3Z5DRHKIBFOUKHNG5NNAYR7ZNYFU5ICCUCAC7F3TA (round 65431730, 0.01 USDC) |
| agent402.tools/api/time (0.001 USDC) | REFUSE payment_failed (the seller's facilitator answered `subcent_quota_exceeded`) | QU6RPL2CKPD4SLDARRKM637PFPHHGCWQUWCW7WCJXHTKLBCXRL2A (round 65431721, 0.05 USDC) | not paid |
| canix402 (0.01 USDC), 03:51 UTC | seller paid (see `/activity`) | WUHOUH5C6MMSQY5QAJAI6ZTPQWXDA3GUVNNZ5FUKA6XNB367BDFA (round 65432448, 0.05 USDC) | 2SJMXF6T4OF3467QB4DBOKBXPWQIRJMZ3ZLTPXEACC5U5VPKZ7QA (round 65432457, 0.01 USDC) |

Rounds were read from `mainnet-idx.algonode.cloud`. The customer's payment confirms before the seller payment.

MainNet addresses: vet402 payTo `RMMD7KW5F627Q72AJKNZEIEP33I3RD4VSCBGUSYVUTPZARJ6PDBNPIY33Q`, vet402 payer `OZ3KMLALTO67BZLYLCZOT7IJBGN7JTO5A3MJHI2267EKQDASFKS52KU6VY`.

### 2026-09-27: one seller payment without a customer payment (bug, fixed)

`OZZH2TRA3MANN55OTTWOXVBDHRRYIJ52IBXEPVBBE4BNQUOR6CCQ` (04:42 UTC, 0.01 USDC to canix402) had no customer payment in front of it. An unpaid `HEAD /v1/check` skipped the payment check and reached the handler, which paid the seller. Fixed at 05:28 UTC in 84121e6 (3d1377f before the history rewrite): HEAD is priced like GET, and the handler refuses without a settled customer payment. It shows on `/activity` under unmatched seller payments.

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
