# BrowserSwaps

**Non-custodial atomic swaps between [BrowserCoin](https://browsercoin.org) (BRC) and USDT on Arbitrum — entirely in your browser.**

No exchange, no escrow service, no account. Every swap is a hashed-timelock contract on both chains: either both sides get paid, or both sides get refunded. At no point can the counterparty, this website's host, or any helper server take your funds — the worst any of them can do is waste your time.

## How a swap works

The buyer (pays USDT, receives BRC) generates a 32-byte secret `s` and shares only `h = sha256(s)`:

1. Buyer locks USDT in the [HTLC contract](contracts/HTLC.sol) on Arbitrum: *"seller with `s`, or buyer back after 24 h."*
2. Seller's tab independently verifies that lock across multiple RPCs, then locks BRC on-chain under the same hash: *"buyer with `s`, or seller back after 12 h."* (This uses BrowserCoin's native script HTLC.)
3. Buyer's tab — a full BRC node that validated the lock itself — redeems the BRC, publishing `s` on the BrowserCoin chain.
4. Seller's tab reads `s` from the chain and claims the USDT. Done, typically in ~15–30 minutes.

The secret-holder is always the BRC receiver, so the secret is only ever revealed against **self-validated** chain state, never against RPC-reported state. Foreign-chain verification cross-checks every configured RPC and refuses to proceed on any disagreement.

## The market

Offers live in a peer-to-peer mesh (WebRTC via the existing BrowserCoin signaling helpers). Your offer is broadcast while your tab is open and expires ~45 s after you close it — the orderbook only ever shows makers who can actually fill. Filling is fully automatic on the maker side: post a price, leave the tab open, swaps run themselves. Mining is **optional** (Settings → off by default) — but if the tab is open anyway, it can earn block rewards with spare CPU.

Both wallets (BRC ed25519 + Arbitrum secp256k1) are generated in-tab on first visit and stored in localStorage, like the main BrowserCoin app. They are hot *trading* wallets: fund them with what you intend to trade, export backups from the Wallet tab.

## Getting started (dev)

```bash
npm install
npm test                # swap state-machine tests
npm run dev             # http://localhost:5173  (expects ../browserCoin checkout)
```

One-time setup per EVM network (needs a funded deployer key):

```bash
npm run compile:htlc                              # refresh ABI/bytecode artifact
set DEPLOYER_KEY=0x<key>
node scripts/deploy-htlc.mjs arbitrumSepolia      # or: arbitrum
```

Paste the printed contract address into **Settings → HTLC contract** (or bake it into `src/config.ts`). On Sepolia you'll also want to set a test ERC-20 as the token override.

## Fees & the relayer (gas station)

The relayer submits users' signed operations, pays the Arbitrum gas, and earns
a **percentage cut in USDT** — so buyers and sellers never need ETH.

- **Cut:** `RELAY.feeBps` in `src/config.ts` (default **0.4%**). A swap is two
  relayed ops (the buyer's lock + the seller's claim), so the 0.4% is split
  0.2% buyer-side + 0.2% seller-side — the *trade's* total cut is ~0.4%. A
  gasless withdrawal is a single op and pays the full 0.4%.
- **Floor:** every relayed op charges at least `RELAY.feeMinUnits` (default
  0.03 USDT) so tiny trades still cover gas. The fee is `max(pct, floor)`.
- Fees are pure client-computed values carried in the EIP-712 intents; changing
  the rate needs **no contract redeploy**.

Run it (combined market + relayer + history on one port):

```bash
set RELAYER_KEY=0x<64 hex>     # or put RELAYER_KEY / DEPLOYER_KEY in .env
npm run server                 # http://localhost:9250
```

Fund the printed relayer address with a little ETH on Arbitrum One. The status
endpoint (`GET /`) reports `relayer.ethBalance` and `lowGas`.

### Auto-refill (USDT → ETH)

The relayer earns USDT but spends ETH, so its ETH drains over time. Optional
auto-refill swaps accumulated USDT back to ETH on Uniswap V3 when the balance
runs low. It's **off by default** (it trades real funds); enable per-deployment:

```bash
set AUTOREFILL=on              # everything below is optional, with sane defaults
set REFILL_MIN_ETH=0.0008      # top up when ETH dips below this
set REFILL_TARGET_ETH=0.003    # ...back up to this
set REFILL_MAX_USDT_UNITS=5000000   # cap per refill (5 USDT)
set REFILL_SLIPPAGE_BPS=100    # 1% slippage tolerance (quote-checked)
set REFILL_POOL_FEE=500        # Uniswap USDT/WETH fee tier (0.05%)
```

Each refill is capped, slippage-protected against a live Uniswap quote,
rate-limited by a cooldown, and skipped (not executed blind) if the quote
reverts. Keep `REFILL_MIN_ETH` above the gas cost of the approve+swap so a
critically-empty relayer can still pay to refuel itself.

## Project layout

```
contracts/HTLC.sol        Arbitrum escrow (no owner, no admin, relayer-friendly claims)
src/swap/engine.ts        the swap state machine (idempotent, crash-resumable)
src/swap/types.ts         swap records + chain adapter interfaces
src/evm/htlcAdapter.ts    viem adapter, multi-RPC cross-checked verification
src/brc/adapter.ts        adapter over the embedded BrowserCoin full node
src/market/               offer gossip + take/accept handshake (PeerJS mesh)
src/ui/                   vanilla-TS UI (Market / Swaps / Wallet / Settings)
scripts/                  solc compile + deploy
```

## Trust model, stated plainly

- **Counterparty:** cannot steal — HTLCs on both chains; timelocks refund abandoned swaps.
- **This site's host / helper servers:** relay discovery traffic only; cannot touch funds; can at worst censor/delay.
- **Arbitrum RPCs:** all configured RPCs must agree before the seller commits BRC; a lying RPC can stall, not steal. Large swaps additionally wait for L1-posted (`safe`) state.
- **Tether & Arbitrum themselves:** USDT is a centrally-administered token and Arbitrum has a sequencer. That trust is inherent to the asset the user chose, not added by this platform.

## v1 limitations (known, deliberate)

- Offers are sell-BRC only (buy-side offers/RFQs: next).
- Both tabs must stay open for the swap's ~20 minutes; refunds require reopening the tab after the timelock (automatic once opened).
- Orderbook spam is only rate-limited by PeerJS connection count; no offer bonds yet.

MIT
