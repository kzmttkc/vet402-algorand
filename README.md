# vet402 (Algorand)

An x402 **orchestrator** for the Algorand x402 Global Challenge.

A customer pays vet402 to check an x402 endpoint. vet402 then:

1. reads the seller's `402` (price, `accepts[]`, Bazaar `description` and output declaration),
2. refuses without paying if the price is above its caps,
3. **actually pays the seller** in USDC on Algorand (x402 `exact`, via the GoPlausible facilitator),
4. checks what was delivered against what was declared, and
5. answers `ALLOW` / `REFUSE` with a machine-readable reason, both payment tx ids, and a short summary of the delivery.

```
customer --(0.05 USDC, x402)--> vet402 /v1/check?url=<seller>
                                   |--(seller price <= cap, x402)--> seller
                                   |<-- delivery
customer <-- { verdict, reason, downstreamPayment.transaction, delivery.summary }
             + PAYMENT-RESPONSE header (customer -> vet402 tx id)
```

## Reasons (stable contract)

| reason | verdict | paid seller? |
|---|---|---|
| `delivered` | ALLOW | yes |
| `delivery_missing_keys` | REFUSE | yes |
| `not_json` | REFUSE | yes |
| `empty_body` | REFUSE | yes |
| `http_error` | REFUSE | yes |
| `payment_failed` | REFUSE | attempted |
| `price_over_cap` | REFUSE | **no** |
| `daily_cap_reached` | REFUSE (HTTP 503, customer not charged) | **no** |
| `no_supported_accept` | REFUSE | no |
| `not_x402` | REFUSE | no |
| `invalid_target` | REFUSE (HTTP 400, customer not charged) | no |
| `probe_error` | REFUSE | no |

"Declared keys" = Bazaar `output.schema.required`, else `output.schema.properties`, else the top-level keys of `output.example`. A key that is present but `null` or blank counts as missing.

## Safety

- **Per-call cap** (`PROBE_MAX_PER_CALL_USDC`, default 0.04, may not exceed the check price) and **per-UTC-day cap** (`PROBE_MAX_PER_DAY_USDC`, default 1.00) are enforced before any signature exists. They are enforced again inside the paying client (policy + `onBeforePaymentCreation` hook), which is also locked to the exact `payTo`/asset/amount that was approved and to one payment per check. A seller that raises its price between the look and the payment is not paid.
- The daily ledger persists in `state/`. If it is unreadable, it fails closed.
- **MainNet is locked**: `X402_NETWORK=mainnet` also requires `I_UNDERSTAND_MAINNET_MOVES_REAL_FUNDS=yes`.
- The target is fetched with `redirect: manual`, a timeout and a 1 MB body cap. Without `ALLOW_PRIVATE_TARGETS=1` only `https` URLs that resolve to public addresses are allowed. There is a residual DNS-rebinding window between the check and the fetch.
- Keys live only in `.keys/<network>.json` (gitignored, mode 600). Scripts print addresses and tx ids, never keys.

## Versions (important)

`@x402/*` is pinned to **2.11.0**, the version locked in the official `algorandfoundation/x402-demo` tutorial. From 2.20.0 onward `ALGORAND_TESTNET_CAIP2` is truncated to `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe`. The GoPlausible facilitator's `/supported` still lists only the full-hash form `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=`, so with 2.27.0 the server refuses to start (`Facilitator does not support scheme "exact" on network ...`). vet402 accepts sellers that advertise either form.

## Run (TestNet)

```bash
npm install
npm test                       # offline unit tests
npm run keys:gen               # creates .keys/testnet.json, prints 3 addresses
npm run balances

# fund the CLIENT address only: ALGO (Lora faucet), then:
npm run setup:testnet          # sends ALGO to vet402/seller, opts all into USDC
# then TestNet USDC to the CLIENT address (Circle faucet), then again:
npm run setup:testnet          # moves 1 USDC to vet402 so it can pay sellers

ALLOW_PRIVATE_TARGETS=1 npm run sellers   # :4031  /honest /liar /pricey
ALLOW_PRIVATE_TARGETS=1 npm run server    # :4021  vet402

npm run demo -- http://localhost:4031/honest   # expect ALLOW delivered, 2 tx ids
npm run demo -- http://localhost:4031/liar     # expect REFUSE delivery_missing_keys, 2 tx ids
npm run demo -- http://localhost:4031/pricey   # expect REFUSE price_over_cap, seller not paid
ALLOW_PRIVATE_TARGETS=1 npm run probe:once -- http://localhost:4031/pricey  # vet402 alone, no customer
```

Transactions: `https://lora.algokit.io/testnet/transaction/<txid>`.

## Files

| path | role |
|---|---|
| `src/server.ts` | vet402 paid endpoint `GET /v1/check` (Hono + `@x402/hono` + Bazaar, `extra.tag = x402-global-challenge`) |
| `src/probe.ts` | look at the 402 → caps → pay the seller (`wrapFetchWithPayment` + `ExactAvmScheme`) → judge |
| `src/verdict.ts` | pure declaration-vs-delivery check and the reason words |
| `src/caps.ts` | per-call / per-day spend ledger |
| `src/declaration.ts` | extract the seller's declaration and choose the payable accept |
| `src/target.ts` | URL / private-address guard |
| `src/client-demo.ts` | customer role |
| `src/sellers.ts` | TestNet test sellers (honest / liar / pricey) |
| `scripts/` | key generation, balances, TestNet setup, single probe |
| `test/` | offline unit tests (`node:test`) |

## TestNet run record

2026-09-27 (JST)

- `npm test` → 34 tests, 34 pass, 0 fail.
- Unpaid `GET /v1/check` → `402`. `accepts[0]` = exact / `algorand:SGO1…OiI=` / 50000 / asset 10458941, with `extra.tag = "x402-global-challenge"` and the facilitator `feePayer ZMFK2OI7…RA22AA`. The Bazaar `info` and `schema` are present.
- `probe:once …/pricey` → `REFUSE price_over_cap` ("price 500000 > per-call cap 40000"). Nothing was signed.
- `demo …/honest` with unfunded accounts → the facilitator ran its simulation and it failed with `asset 10458941 missing from JJCAA6…CHWCH4`. So signing, the facilitator and the network ID all work. What is missing is funds.
- **Pending**: the funded end-to-end run (ALLOW + REFUSE with 2 confirmed tx ids each). TestNet ALGO (Lora / AlgoKit dispenser) needs a login. TestNet USDC (Circle faucet) needs reCAPTCHA.

Addresses (TestNet):

- client `JJCAA6JLV5XWPQRGNHVWGRUS5KM4JHTAFHQL7XGMAIHQPY6BX63CCHWCH4`
- vet402 `YICSOXOUJHLOUT5YZN7E4MG4H3TDXV5VKGAEKESY6YAKZLH5VKL6CNU2RM`
- seller `Y6IYAN3LMOTOB2LQNKGO4M4C4EPLFY3Z2GIQKTCWR3RAA7WPAIHZKEJXXM`
