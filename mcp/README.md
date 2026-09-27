# vet402 MCP server (Algorand)

A stdio MCP server that lets an agent check an x402 endpoint with vet402 before buying from it.

| tool | input | cost | returns |
|---|---|---|---|
| `vet402_check` | `{ url }` | **0.05 USDC per call**, paid on Algorand from `ALGORAND_MNEMONIC` | `ALLOW`/`REFUSE`, reason, tx id of your payment to vet402, tx id of vet402's payment to the seller, delivery summary |
| `vet402_buy` | `{ url, method?: "GET"\|"POST", body? }` | **the seller's price + 0.005 USDC**, paid on Algorand from `ALGORAND_MNEMONIC`, only after a free price read and only up to `VET402_MAX_BUY_USDC` | the seller's body as delivered, `ALLOW`/`REFUSE` and reason (`x-vet402-verdict`), tx id of your payment to vet402, tx id of vet402's payment to the seller. No refunds; above the limit, nothing is paid and the price is returned |
| `algorand_x402_endpoints` | `{ query?, network?: "mainnet"\|"testnet"\|"any", limit? }` | free | Algorand x402 endpoints from the Bazaar feed (`facilitator.goplausible.xyz`), most-settled first |

vet402 pays the seller only after your payment has settled. Requests vet402 refuses up front (invalid URL, daily cap reached) come back as `REFUSE` without charging you.

## Install

This package imports `../src/check-client.ts`, so run it from a checkout of the whole repository:

```bash
npm ci            # repository root
cd mcp && npm ci
```

## Configure

```json
{
  "mcpServers": {
    "vet402": {
      "command": "npm",
      "args": ["--prefix", "/path/to/vet402-algorand/mcp", "start", "--silent"],
      "env": { "ALGORAND_MNEMONIC": "<25 words of a wallet holding a little USDC>" }
    }
  }
}
```

| env | default | notes |
|---|---|---|
| `ALGORAND_MNEMONIC` | none | required for `vet402_check` and `vet402_buy`. Without it the tool returns an error and pays nothing. Keep it in the client config's `env`, not on a command line |
| `VET402_NETWORK` | `mainnet` | `mainnet` or `testnet` |
| `VET402_URL` | `https://vet402-algorand.vercel.app` | vet402 base URL |
| `VET402_MAX_PRICE_USDC` | `0.05` | the most one `vet402_check` call pays vet402. A higher price is refused before signing |
| `VET402_MAX_BUY_USDC` | `0.10` | the most one `vet402_buy` call pays in total (seller price + 0.005 fee). Above it nothing is paid and the price is returned; a price raised between the free read and the payment is not signed. The payment is signed only to the address named in vet402's free 402, never to the seller's address; with the default `VET402_URL` on MainNet only to vet402's own address `RMMD7KW5…PIY33Q` (also for `vet402_check`) |
| `BAZAAR_URL` | `https://facilitator.goplausible.xyz/discovery/resources` | discovery feed |

The paying wallet needs USDC (ASA 31566704 on MainNet, 10458941 on TestNet). Fees are covered by the facilitator.

## Check it

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"algorand_x402_endpoints","arguments":{"query":"vet402"}}}' \
  | npm --prefix mcp start --silent

cd mcp && npm test && npm run typecheck
```

stdout carries JSON-RPC only; console output from libraries is sent to stderr.
