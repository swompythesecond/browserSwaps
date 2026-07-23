/**
 * BrowserSwaps configuration: EVM networks, swap timing policy, and market
 * gossip parameters. Users can override the mutable parts in Settings
 * (persisted to localStorage); these are the shipped defaults.
 */
import { arbitrum, arbitrumSepolia } from 'viem/chains';
import type { Chain } from 'viem';

export interface EvmNetworkConfig {
  key: string;
  chain: Chain;
  /** ERC-20 token being swapped against BRC (USDT on Arbitrum One). */
  token: `0x${string}` | '';
  tokenSymbol: string;
  tokenDecimals: number;
  /** Deployed HTLC escrow contract (contracts/HTLC.sol). Empty = not deployed yet. */
  htlc: `0x${string}` | '';
  /** Independent RPC endpoints. Lock verification cross-checks ALL reachable
   * ones and requires agreement — a single lying RPC cannot fake a lock. */
  rpcs: string[];
}

export const EVM_NETWORKS: Record<string, EvmNetworkConfig> = {
  arbitrum: {
    key: 'arbitrum',
    chain: arbitrum,
    token: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USDT on Arbitrum One
    tokenSymbol: 'USDT',
    tokenDecimals: 6,
    // HTLC v3 (relayed swaps + gasless withdrawals), deployed 2026-07-13,
    // tx 0x1e1755d3f4addcfddaba0c1b82170ba61b23e7b22c0a6b8fd3c22f070615ed40
    // (v2 at 0xdc6b492f5685829a8325ff407ba1cff21056bd89, v1 at 0xe7dd4f7d…)
    htlc: '0xd9a5db57c4fc3b08381f0cd1816769eaed13ead7',
    rpcs: [
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum-one-rpc.publicnode.com',
      'https://arbitrum.llamarpc.com',
      'https://arbitrum-one.public.blastapi.io',
    ],
  },
  arbitrumSepolia: {
    key: 'arbitrumSepolia',
    chain: arbitrumSepolia,
    token: '', // TODO: any test ERC-20; deploy one or use a faucet token
    tokenSymbol: 'tUSDT',
    tokenDecimals: 6,
    htlc: '', // TODO: fill in after `node scripts/deploy-htlc.mjs arbitrumSepolia`
    rpcs: [
      'https://sepolia-rollup.arbitrum.io/rpc',
      'https://arbitrum-sepolia-rpc.publicnode.com',
    ],
  },
};

// ---------------------------------------------------------------------------
// Solana networks. Same trust rule as EVM: lock verification cross-checks all
// reachable RPCs and requires agreement; `finalized` commitment replaces the
// EVM `safe` tag for large swaps.
// ---------------------------------------------------------------------------
export interface SolNetworkConfig {
  key: string;
  /** Deployed bswap-htlc program id (base58). Empty = not deployed yet. */
  htlcProgram: string;
  rpcs: string[];
}

export const SOL_NETWORKS: Record<string, SolNetworkConfig> = {
  solana: {
    key: 'solana',
    // bswap-htlc, deployed to mainnet-beta 2026-07-15,
    // tx 62zB2bRb4wAU7BEe6Mf2ETmpzwDcN7DxagUmMmFZNEkf3NAosEFz6PgLwJNbgdgcqB8j9cpeWtziuyuhHjLmtFqH
    htlcProgram: 'BgonehyDwfg8UtUKQW5TkYLAvFnJ47BRXu1TLYaDZ1dV',
    // Browser-usable direct RPC. Public Solana endpoints are a CORS minefield:
    // most reject the request because @solana/web3.js sends a non-standard
    // `solana-client` header (we strip it in the adapter), and even then many
    // don't return Access-Control-Allow-Headers at all. publicnode is the one
    // reliable keyless endpoint (answers the preflight, allows content-type).
    // A second INDEPENDENT source for the getLock quorum comes from the app's
    // own same-origin `/sol-rpc` passthrough, prepended in activeSolNetwork()
    // (no CORS — same origin — and it reaches api.mainnet-beta server-side,
    // which works fine off-browser). Users can add more in Settings.
    rpcs: [
      'https://solana-rpc.publicnode.com',
    ],
  },
  solanaDevnet: {
    key: 'solanaDevnet',
    // Deployed 2026-07-15, tx 4K7Z6fJh7mAic93DdLG9oewAPDUNXVz2S9cWBW5TpdJPVS2iWLhGzQw2WwVp4WGVUGCbMt39nk1TAsYYMfzSFkhG
    htlcProgram: 'BgonehyDwfg8UtUKQW5TkYLAvFnJ47BRXu1TLYaDZ1dV',
    rpcs: [
      'https://api.devnet.solana.com',
    ],
  },
};

// ---------------------------------------------------------------------------
// Trading pairs. Every market is BRC against one token on one foreign chain;
// a pair pins down the chain adapter, token contract/mint, decimals, and the
// two DECIMAL-SENSITIVE amounts: the minimum trade size and the flat per-op
// relayer-fee floor. The percentage fees (0.4%) are decimal-agnostic, but a
// flat floor is meaningless without knowing the token's units — so both live
// here per pair instead of as global constants.
// ---------------------------------------------------------------------------
export type ChainKind = 'evm' | 'sol';

export interface PairConfig {
  key: string;          // 'arb:usdt' — wire format in offers and swap records
  chain: ChainKind;
  network: string;      // key into EVM_NETWORKS / SOL_NETWORKS
  label: string;        // UI: 'USDT · Arbitrum'
  tokenSymbol: string;
  tokenDecimals: number;
  /** How many decimals the UI shows for amounts of this token. */
  displayDecimals: number;
  /** Minimum trade size (token units) — must comfortably exceed 2x the fee
   * floor or the fees eat the trade (the HTLC rejects relayFee >= amount). */
  minTradeUnits: bigint;
  /** Flat floor (token units) for one relayed op's fee; the percentage fee
   * never drops below this. Keep it above the relayer server's per-mint min. */
  feeMinUnits: bigint;
  /** SPL mint (sol pairs only); EVM pairs take the token from the network.
   * Native SOL trades as wrapped SOL (the So111…1112 mint) — the adapter
   * wraps/unwraps transparently, users only ever see native SOL. */
  mint?: string;
}

// Listed in DISPLAY ORDER (the Markets table renders top-to-bottom from
// here): Solana first — it's what most users asked for.
export const PAIRS: Record<string, PairConfig> = {
  'sol:sol': {
    key: 'sol:sol', chain: 'sol', network: 'solana',
    label: 'SOL · Solana', tokenSymbol: 'SOL', tokenDecimals: 9,
    // SOL is volatile — these floors are ~$0.30 / ~$0.012 at $60/SOL and
    // should be revisited if the price moves a lot.
    displayDecimals: 4, minTradeUnits: 5_000_000n /* 0.005 SOL */, feeMinUnits: 200_000n /* 0.0002 SOL */,
    mint: 'So11111111111111111111111111111111111111112', // wrapped SOL
  },
  'sol:usdc': {
    key: 'sol:usdc', chain: 'sol', network: 'solana',
    label: 'USDC · Solana', tokenSymbol: 'USDC', tokenDecimals: 6,
    displayDecimals: 2, minTradeUnits: 300_000n, feeMinUnits: 30_000n,
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
  'sol:usdt': {
    key: 'sol:usdt', chain: 'sol', network: 'solana',
    label: 'USDT · Solana', tokenSymbol: 'USDT', tokenDecimals: 6,
    displayDecimals: 2, minTradeUnits: 300_000n, feeMinUnits: 30_000n,
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  },
  'arb:usdt': {
    key: 'arb:usdt', chain: 'evm', network: 'arbitrum',
    label: 'USDT · Arbitrum', tokenSymbol: 'USDT', tokenDecimals: 6,
    displayDecimals: 2, minTradeUnits: 300_000n /* 0.30 */, feeMinUnits: 30_000n /* 0.03 */,
  },
};

/** Pair every v1 offer and pre-pair swap record implicitly traded — a WIRE
 * PROTOCOL constant, not a display preference (see UI_DEFAULT_PAIR). */
export const DEFAULT_PAIR = 'arb:usdt';

/** The book a fresh visitor lands on. */
export const UI_DEFAULT_PAIR = 'sol:sol';

export function pairConfig(key: string | undefined): PairConfig {
  return PAIRS[key ?? DEFAULT_PAIR] ?? PAIRS[DEFAULT_PAIR]!;
}

// ---------------------------------------------------------------------------
// Wind-down switch. BrowserSwaps is being retired: when TRADING_CLOSED is true
// the app blocks every NEW trade (posting an offer, taking an offer) and shows
// a prominent notice asking users to withdraw their balances. What deliberately
// KEEPS working: withdrawals, and any swap already in flight — those always run
// to completion so nobody's funds get stranded. This is a CLIENT-ONLY gate (the
// relayer/market server still function); flip it back to false to re-open.
// ---------------------------------------------------------------------------
export const TRADING_CLOSED = true;

/** Where the wind-down notice points people with questions. */
export const DISCORD_INVITE = 'https://discord.gg/xV3De6ErTr';

const SETTINGS_KEY = 'bswap.settings.v1';

export interface Settings {
  network: string;
  /** Overrides for the active network (htlc/token/rpcs), e.g. after deploying. */
  htlcAddress: string;
  tokenAddress: string;
  extraRpcs: string[];
  /** Solana overrides: HTLC program id + extra RPCs for the quorum. */
  solProgramId: string;
  extraSolRpcs: string[];
  /** Relayer ("gas station") endpoints; tried in order, self-submit fallback. */
  relayerUrls: string[];
  /** Market servers (orderbook + handshake mailboxes); writes fan out to all. */
  marketUrls: string[];
}

export function loadSettings(): Settings {
  // Default the helper server (orderbook + relayer) to the page's own origin so
  // a hosted deployment works over HTTPS without mixed-content, and a `vite dev`
  // checkout falls back to the local swapd on :9250. Users can override both in
  // Settings.
  const sameOrigin =
    typeof location !== 'undefined' && location.protocol.startsWith('http')
      ? location.origin
      : 'http://localhost:9250';
  const defaults: Settings = {
    network: 'arbitrum',
    htlcAddress: '',
    tokenAddress: '',
    extraRpcs: [],
    solProgramId: '',
    extraSolRpcs: [],
    relayerUrls: [sameOrigin],
    marketUrls: [sameOrigin],
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch {
    return defaults;
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/** A Solana network config with user overrides applied. */
export function activeSolNetwork(network: string, s: Settings = loadSettings()): SolNetworkConfig {
  const base = SOL_NETWORKS[network] ?? SOL_NETWORKS['solana']!;
  // RPC ORDER MATTERS. reads (viaRpc) use the first that answers; getLock hits
  // ALL of them for its cross-check. So:
  //   1. base.rpcs (publicnode) FIRST — a direct, CORS-clean public RPC. Every
  //      user's browser hits it from THEIR OWN IP, so the high-volume balance
  //      polling is rate-limited per-user and scales with the userbase.
  //   2. user-supplied RPCs next (Settings) — best per-user option at scale.
  //   3. the same-origin `/sol-rpc` passthrough LAST — a fallback for reads, and
  //      the independent SECOND source the getLock cross-check needs (it fronts
  //      a DIFFERENT upstream than publicnode). It funnels through the server's
  //      one IP, so it deliberately carries only the low-volume verification
  //      reads, never the continuous balance polling. Mainnet only — devnet has
  //      no server-side upstream.
  const sameOrigin =
    typeof location !== 'undefined' && location.protocol.startsWith('http')
      ? location.origin
      : 'http://localhost:9250';
  const proxyRpc = network === 'solana' ? [`${sameOrigin}/sol-rpc`] : [];
  return {
    ...base,
    htlcProgram: s.solProgramId || base.htlcProgram,
    rpcs: [...base.rpcs, ...(s.extraSolRpcs ?? []), ...proxyRpc],
  };
}

/** Active network config with user overrides applied. */
export function activeNetwork(s: Settings = loadSettings()): EvmNetworkConfig {
  const base = EVM_NETWORKS[s.network] ?? EVM_NETWORKS['arbitrumSepolia']!;
  return {
    ...base,
    htlc: (s.htlcAddress || base.htlc) as EvmNetworkConfig['htlc'],
    token: (s.tokenAddress || base.token) as EvmNetworkConfig['token'],
    rpcs: [...base.rpcs, ...s.extraRpcs],
  };
}

// ---------------------------------------------------------------------------
// Swap timing policy. Invariant that makes the swap atomic:
//   BRC locktime (T_brc)  <  EVM timelock (T_evm), with a healthy margin, so
//   the secret is always revealed (BRC claim, before T_brc) while the seller
//   still has hours to claim the USDT (before T_evm).
// ---------------------------------------------------------------------------
export const SWAP_TIMING = {
  /** Buyer's USDT refund unlocks this long after the take. */
  evmTimelockSecs: 24 * 3600,
  /** Seller's BRC refund unlocks this long after the take. */
  brcLocktimeSecs: 12 * 3600,
  /** Seller only proceeds if the buyer's EVM lock still has at least this long to run. */
  minEvmWindowSecs: 20 * 3600,
  /** Minimum required gap T_evm - T_brc when the seller validates a take. */
  minTimelockGapSecs: 8 * 3600,
  /** Buyer refuses to reveal the secret with less than this left before T_brc. */
  buyerClaimSafetySecs: 2 * 3600,
  /** A maker-buyer waits this long for the taker's `confirm` before cancelling
   * the swap. Nothing is locked in this window, so cancelling is free and safe.
   * Longer than the taker's 30 s give-up so a slow-but-alive taker still lands. */
  confirmTimeoutSecs: 120,
  /** BRC confirmations required on the seller's lock before the buyer claims. */
  brcConfirmations: 3,
  /** Above this many token units (USDT has 6 decimals => 100 USDT), the buyer's
   * EVM lock must also be visible at the `safe` block tag (posted to L1). */
  largeSwapTokenUnits: 100_000_000n,
  /** Minimum age (seconds) of the EVM lock tx before the seller trusts it for
   * small swaps (sequencer-confirmed + a breath). */
  smallSwapMinAgeSecs: 60,
} as const;

// ---------------------------------------------------------------------------
// Relaying (gasless UX). Fees are in token units (6 decimals for USDT).
//
// The relayer takes a PERCENTAGE cut, floored so a relayed op always covers
// its ~$0.01-0.03 of Arbitrum gas. A swap is two relayed ops — the buyer's
// lock and the seller's claim — so the headline 0.4% is split 0.2% + 0.2% to
// make the *trade's* total cut ~0.4% (buyer pays lockFee, seller pays
// relayFee). Withdrawals are NOT monetized: they charge 0 bps, so the fee
// falls through to the flat per-op floor that just covers gas.
// ---------------------------------------------------------------------------
export const RELAY = {
  /** Headline relayer cut, in basis points (40 = 0.4%). */
  feeBps: 40n,
  /** Per-op floor (token units): the smallest fee any single relayed op may
   * charge, so tiny trades still cover gas + a thin margin. Keep it above the
   * relayer server's MIN_FEE. */
  feeMinUnits: 30_000n, // 0.03 USDT
  /** LockIntent / WithdrawIntent signatures expire after this long. */
  intentTtlSecs: 2 * 3600,
} as const;

/** Buyer-side share of a swap's cut (submits the lock). */
export const LOCK_FEE_BPS = RELAY.feeBps / 2n; // 0.2%
/** Seller-side share of a swap's cut (stored in the lock, paid on claim/refund). */
export const CLAIM_FEE_BPS = RELAY.feeBps / 2n; // 0.2%
/** Gasless withdrawals only cover gas: 0 bps -> flat `feeMinUnits` fee. */
export const WITHDRAW_FEE_BPS = 0n;

/** Fee for one relayed op: `bps` of `amount`, floored to cover gas. The
 * floor is decimal-sensitive — pair-aware callers pass their pair's
 * `feeMinUnits`; the default is the 6-decimal stablecoin floor. */
export function relayerFee(amount: bigint, bps: bigint, floor: bigint = RELAY.feeMinUnits): bigint {
  const pct = (amount * bps) / 10_000n;
  return pct > floor ? pct : floor;
}

/**
 * Largest amount you can send when the fee (`bps`, floored) is also drawn from
 * `balance` — i.e. the biggest `amt` with `amt + relayerFee(amt, bps) <=
 * balance`. Used by "Max"/"Sell all" so the total never exceeds the balance.
 */
export function maxSendable(balance: bigint, bps: bigint, floor: bigint = RELAY.feeMinUnits): bigint {
  if (balance <= floor) return 0n;
  const amtPct = (balance * 10_000n) / (10_000n + bps); // percentage regime
  if ((amtPct * bps) / 10_000n >= floor) return amtPct;
  return balance - floor; // floor regime
}

/**
 * Minimum trade size for the DEFAULT pair (token units) — legacy constant;
 * pair-aware code reads `pairConfig(pair).minTradeUnits` instead. Must
 * comfortably exceed the seller's floored relayFee (else the HTLC contract
 * rejects the lock, "relayFee >= amount"). At 0.30 USDT the fee is a steep
 * ~20% (fine for testing / dust) and dilutes toward the 0.4% headline.
 */
export const MIN_TRADE_TOKEN = 300_000n; // 0.30 USDT

// ---------------------------------------------------------------------------
// Market / orderbook gossip.
// ---------------------------------------------------------------------------
export const MARKET = {
  /** Re-post own offers every N ms (presence heartbeat; server TTL is 45 s). */
  offerHeartbeatMs: 15_000,
  /** Refresh the remote orderbook every N ms. */
  offerPollMs: 5_000,
  /** Drain our handshake mailbox every N ms. */
  mailboxPollMs: 2_500,
  /** How often the swap engine ticks active swaps. This is also the cadence of
   * each active swap's foreign-chain reads (the getLock finality quorum), so it
   * sets the Solana RPC read rate. 10s is well within the swap's hour-scale
   * timelock margins and roughly halves that read load vs the old 5s; the fast
   * handshake stays responsive on its own offer/mailbox timers. */
  engineTickMs: 10_000,
} as const;

/** BRC uses 8 decimals (like the chain's smallest unit). */
export const BRC_DECIMALS = 8;

/** Default + minimum fee (wei) for the seller's BRC lock transaction. The
 * seller can raise it in the sell form for faster mining; the offered amount
 * plus this fee is deducted from their balance when the offer fills. */
export const BRC_LOCK_FEE_DEFAULT = 1_000n; // 0.00001 BRC
export const BRC_LOCK_FEE_MIN = 1_000n;
