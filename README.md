# vet402 (Algorand)

**An x402 orchestrator that checks whether a paid API delivers what it promised.** Built for the Algorand x402 Global Challenge (Orchestrator track). The payment requirements carry `accepts[].extra.tag = "x402-global-challenge"`.

You name an x402 endpoint and pay vet402 0.05 USDC. vet402 pays that endpoint itself, compares what came back with what the seller declared (Bazaar `description`, output schema/example, `402 accepts`), and returns:

- `ALLOW` or `REFUSE`, with a machine-readable reason,
- the tx id of **your payment to vet402** and the tx id of **vet402's payment to the seller**, and
- a short summary of what was delivered.

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
| `delivered` | ALLOW | yes |
| `delivery_missing_keys` | REFUSE | yes |
| `not_json` / `empty_body` / `http_error` | REFUSE | yes |
| `payment_failed` | REFUSE | attempted |
| `price_over_cap` | REFUSE | no |
| `daily_cap_reached` | REFUSE | no |
| `cap_check_unavailable` | REFUSE | no |
| `self_dealing` | REFUSE | no |
| `no_supported_accept` / `not_x402` / `probe_error` | REFUSE | no |
| `invalid_target` | REFUSE (HTTP 400 before settlement, customer not charged) | no |

"Declared keys" = Bazaar `output.schema.required`, else `output.schema.properties`, else the top-level keys of `output.example`. A key that is present but `null` or blank counts as missing.

## Spending caps and the no-self-dealing policy

- **Per call**: vet402 never pays one seller more than `PROBE_MAX_PER_CALL_USDC` (MainNet default 0.10).
- **Per UTC day**: vet402 never sends more than `PROBE_MAX_PER_DAY_USDC` (MainNet default 3.00) from its payer wallet.
  - The day's total is read **from the chain** (Algorand indexer: USDC transfers sent by the payer wallet since 00:00 UTC), so the cap holds on serverless instances that share no files. A local ledger is kept as a backup, and the larger of the two is used.
  - If the indexer cannot be read, vet402 **does not pay** (`cap_check_unavailable`). When this is detected before settlement, the customer is not charged.
- Caps are checked before any signature exists. They are enforced again inside the paying client (policy + `onBeforePaymentCreation`), which is also locked to the approved `payTo`/asset/amount and to one payment per check.
- **No self-dealing.** vet402 never pays a seller whose `payTo` is one of its own wallets (the customer-facing `payTo` or the payer wallet); those checks return `self_dealing`. vet402 does not buy its own checks to inflate volume. Every downstream payment follows a real customer payment that has already settled.
- MainNet is locked unless `I_UNDERSTAND_MAINNET_MOVES_REAL_FUNDS=yes`. `ALLOW_PRIVATE_TARGETS=1` is refused on MainNet. Targets must be `https` and resolve to public IPs, redirects are not followed, and bodies are capped at 1 MB.
- There is a residual risk. Two instances running at the same instant can each read the same on-chain total before either payment lands. The worst-case overshoot is about (concurrent checks) × per-call cap.

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
| `src/server.ts` | `GET /v1/check`, Bazaar discovery, production wiring, Vercel default export |
| `src/settle-first.ts` | verify → preflight → **settle** → handler middleware |
| `src/probe.ts` | read seller 402 → caps / self-dealing → pay (`wrapFetchWithPayment` + `ExactAvmScheme`) → judge |
| `src/spend.ts` | on-chain daily cap (indexer) + guard |
| `src/caps.ts` | per-call cap and local backup ledger |
| `src/verdict.ts` | declaration-vs-delivery check, reason words |
| `src/declaration.ts` / `src/target.ts` | seller declaration parsing, URL guard |
| `src/client-demo.ts` / `src/sellers.ts` | customer role, TestNet test sellers |
| `scripts/` | key generation (TestNet, MainNet payer), balances, TestNet setup, single probe |
| `test/` | offline unit tests (`node:test`) |

## TestNet run record

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
