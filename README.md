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
- No relayer service yet for gasless USDT claims — sellers need a sliver of ETH.
- Orderbook spam is only rate-limited by PeerJS connection count; no offer bonds yet.

MIT
