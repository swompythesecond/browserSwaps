# BrowserSwaps bots

Headless scripts that play the market **without a browser tab open** — for
running liquidity 24/7 on a server or spare machine. Your keys stay on your
machine; the bot talks to the same market server, relayer, and chains the app
does, with the same trust model (metadata is relayed, value is verified
on-chain).

## `maker.mjs` — a 24/7 seller

Keeps a sell-BRC offer live and completes swaps automatically: verifies the
buyer's USDT lock on Arbitrum, locks BRC, waits for the buyer to reveal the
secret, and claims the USDT (via the relayer, so the bot needs no ETH).

### Requirements

- `npm install` (pulls in the `browsercoin` dependency, whose transaction/script
  encoders the bot imports so BRC txs are byte-correct, plus `tsx`).

### Configure (environment variables)

| Var | Meaning | Default |
|---|---|---|
| `BRC_PRIVATE_KEY` | 64-hex BRC key holding the BRC you're selling | **required** |
| `PAIR` | market to sell into: `arb:usdt`, `sol:usdc`, `sol:usdt` | `arb:usdt` |
| `EVM_ADDRESS` | Arbitrum address where you receive USDT | **required** on `arb:usdt` |
| `SOL_ADDRESS` | Solana address where you receive USDC/USDT | **required** on `sol:*` |
| `SOL_HTLC_PROGRAM` | bswap-htlc program id (base58) | **required** on `sol:*` |
| `SOL_RPC` | Solana RPC | mainnet-beta public RPC |
| `SOL_MINT` | SPL mint override | derived from `PAIR` |
| `AMOUNT_BRC` | BRC to sell, in 1e-8 units | `10000000000` (100 BRC) |
| `AMOUNT_TOKEN` | token price, in 1e-6 units | `1000000` (1 USDT) |
| `MARKET_URL` | market server | `http://localhost:9250` |
| `RELAYER_URL` | relayer (gas station) | `http://localhost:9250` |
| `BRC_API_URL` | a BrowserCoin API helper | `https://api1.browsercoin.org` |
| `ARB_RPC` | Arbitrum RPC | `https://arb1.arbitrum.io/rpc` |
| `HTLC_ADDRESS` | escrow contract | current mainnet HTLC |
| `TOKEN_ADDRESS` | USDT on Arbitrum | Arbitrum USDT |

### Run

```bash
export BRC_PRIVATE_KEY=<64 hex>
export EVM_ADDRESS=0xYourArbitrumPayoutAddress
export AMOUNT_BRC=10000000000   # 100 BRC
export AMOUNT_TOKEN=1000000     # 1 USDT
npm run bot:maker      # or: npx tsx bots/maker.mjs
```

### ⚠ Before real money

This is a **reference** implementation to build from, not audited production
code. Test it on Arbitrum Sepolia (or with tiny amounts) first. Notably, the
BRC **refund** path (reclaiming your BRC if a buyer abandons the swap after you
locked) is left as a TODO — until you implement it, an abandoned swap leaves
your BRC locked until you refund it manually via the app or a Redeem tx.

## Building your own

The integration surface is plain HTTP + two chains — you can write a bot in any
language. See the **Developer** tab in the app for the full API: market
endpoints, the swap message protocol, the HTLC contract ABI, and the BRC REST
endpoints. `maker.mjs` is the worked example.
