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

const SETTINGS_KEY = 'bswap.settings.v1';

export interface Settings {
  network: string;
  /** Overrides for the active network (htlc/token/rpcs), e.g. after deploying. */
  htlcAddress: string;
  tokenAddress: string;
  extraRpcs: string[];
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

/** Fee for one relayed op: `bps` of `amount`, floored to cover gas. */
export function relayerFee(amount: bigint, bps: bigint): bigint {
  const pct = (amount * bps) / 10_000n;
  return pct > RELAY.feeMinUnits ? pct : RELAY.feeMinUnits;
}

/**
 * Largest amount you can send when the fee (`bps`, floored) is also drawn from
 * `balance` — i.e. the biggest `amt` with `amt + relayerFee(amt, bps) <=
 * balance`. Used by "Max"/"Sell all" so the total never exceeds the balance.
 */
export function maxSendable(balance: bigint, bps: bigint): bigint {
  if (balance <= RELAY.feeMinUnits) return 0n;
  const amtPct = (balance * 10_000n) / (10_000n + bps); // percentage regime
  if ((amtPct * bps) / 10_000n >= RELAY.feeMinUnits) return amtPct;
  return balance - RELAY.feeMinUnits; // floor regime
}

/**
 * Minimum trade size (token units). Must comfortably exceed the seller's
 * floored relayFee (else the HTLC contract rejects the lock, "relayFee >=
 * amount"). At 0.30 USDT the fee is a steep ~20% (fine for testing / dust) and
 * dilutes toward the 0.4% headline as trades grow.
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
  /** How often the swap engine ticks active swaps. */
  engineTickMs: 5_000,
} as const;

/** BRC uses 8 decimals (like the chain's smallest unit). */
export const BRC_DECIMALS = 8;

/** Default + minimum fee (wei) for the seller's BRC lock transaction. The
 * seller can raise it in the sell form for faster mining; the offered amount
 * plus this fee is deducted from their balance when the offer fills. */
export const BRC_LOCK_FEE_DEFAULT = 1_000n; // 0.00001 BRC
export const BRC_LOCK_FEE_MIN = 1_000n;
