/**
 * Swap domain types. Everything is JSON-serializable (bigints as decimal
 * strings) because swap records must survive tab closes in localStorage.
 *
 * Terminology, fixed for the whole codebase:
 *   buyer  — pays USDT on Arbitrum, receives BRC, GENERATES AND HOLDS the
 *            secret. Reveals it by redeeming the BRC lock.
 *   seller — pays BRC, receives USDT. Locks BRC only after independently
 *            verifying the buyer's USDT lock on-chain; learns the secret from
 *            the BRC chain and uses it to claim the USDT.
 *
 * The buyer is the secret-holder on purpose: the secret is only ever revealed
 * against the chain this app validates natively (the in-tab BRC full node),
 * never against RPC-reported foreign state.
 */

export type SwapRole = 'buyer' | 'seller';

export type SwapState =
  // shared
  | 'init'
  // maker-buyer only: accepted a take, waiting for the taker's confirm before
  // locking anything (so it never commits funds against a taker that gave up)
  | 'awaiting-confirm'
  // buyer path
  | 'evm-locking'        // sending approve + lock on Arbitrum
  | 'evm-locked'         // our USDT is escrowed; told the seller
  | 'awaiting-brc-lock'  // watching own BRC node for the seller's lock
  | 'brc-claiming'       // redeeming the BRC lock (reveals the secret)
  // seller path
  | 'awaiting-evm-lock'  // cross-checking the buyer's USDT lock via RPCs
  | 'brc-locking'        // broadcasting our BRC Lock tx
  | 'brc-locked'         // waiting for the buyer to redeem (reveal secret)
  | 'evm-claiming'       // claiming USDT with the revealed secret
  // terminal / recovery
  | 'done'
  | 'refunding'
  | 'refunded'
  | 'failed';

export const TERMINAL_STATES: ReadonlySet<SwapState> = new Set(['done', 'refunded', 'failed']);

export interface SwapParty {
  /** Ed25519 pubkey on the BRC chain, hex (32 bytes). */
  brcPubkey: string;
  /** EVM address on Arbitrum. */
  evmAddress: string;
  /** Solana address, base58. Present on sol:* pair swaps. */
  solAddress?: string;
  /** Market PeerJS id, for the in-swap message channel. */
  peerId: string;
}

/** The party's address on the pair's foreign chain. */
export function foreignAddressOf(party: SwapParty, chain: 'evm' | 'sol'): string {
  return chain === 'evm' ? party.evmAddress : (party.solAddress ?? '');
}

export interface SwapRecord {
  id: string;                // uuid
  /** Trading pair (config PAIRS key). Absent = 'arb:usdt' (pre-pair records). */
  pair?: string;
  role: SwapRole;
  /** Whether this swap filled OUR offer ('maker') or we took someone else's
   * ('taker'). Purely informational (UI notifications); role decides logic. */
  origin?: 'maker' | 'taker';
  offerId: string;
  createdAt: number;         // unix seconds
  updatedAt: number;

  amountBrc: string;         // smallest units (1e-8 BRC), decimal string
  amountToken: string;       // token units (1e-6 USDT), decimal string
  /** Seller only: fee (wei) for the BRC lock tx, chosen when posting the offer. */
  brcFeeWei?: string;

  hashlock: string;          // hex, sha256(secret)
  secret?: string;           // hex, 32 bytes — BUYER ONLY, never sent pre-claim

  self: SwapParty;
  counterparty: SwapParty;

  /** Agreed absolute deadlines (unix seconds). Invariant: brcLocktime + gap <= evmTimelock. */
  evmTimelock: number;
  brcLocktime: number;

  /** Foreign-chain escrow refs. Named `evm` for localStorage compatibility,
   * but sol:* pair swaps store their Solana refs here too: lockId is the
   * lock-state PDA (base58) and the hashes are transaction signatures. */
  evm: {
    lockId?: string;         // EVM: 0x… deterministic id; SOL: lock PDA base58
    lockTxHash?: string;
    claimTxHash?: string;
    refundTxHash?: string;
  };
  brc: {
    lockTxId?: string;       // txHash of the Lock tx
    redeemScript?: string;   // hex — both sides can reconstruct it, stored for convenience
    scriptHash?: string;     // hex, sha256(redeemScript)
    redeemTxId?: string;
    refundTxId?: string;
  };

  state: SwapState;
  /** Human-readable last error / abort reason, if any. */
  note?: string;
}

/** On-chain view of an HTLC lock, as verified across RPCs. Chain-agnostic:
 * the EVM adapter reads the contract mapping, the Solana adapter the lock
 * PDA's account state. */
export interface EvmLockView {
  token: string;             // ERC-20 address / SPL mint
  sender: string;
  recipient: string;
  amount: bigint;
  hashlock: string;          // hex, no 0x
  timelock: number;          // unix seconds
  relayFee: bigint;          // paid to a non-beneficiary claim/refund submitter, out of `amount`
  claimed: boolean;
  refunded: boolean;
  /** Strong-finality flag: EVM = visible at the `safe` (L1-posted) block tag,
   * Solana = visible at `finalized` commitment. */
  safe: boolean;
  /** Seconds since the RPCs' latest block timestamp saw the lock (age proxy). */
  ageSecs: number;
}

export interface BrcLockView {
  txId: string;
  amount: bigint;            // smallest units actually locked
  confirmations: number;
}

// ---------------------------------------------------------------------------
// Adapters. The engine only talks to these interfaces; real implementations
// live in src/evm/ and src/brc/, mocks live in the tests.
// ---------------------------------------------------------------------------

export interface EvmAdapter {
  /** Our own EVM address. */
  address(): string;
  /** Approve (if needed) and lock tokens. Returns the deterministic lock id. */
  lock(p: {
    amount: bigint;
    hashlock: string;        // hex
    recipient: string;       // seller's EVM address
    timelock: number;        // unix seconds
  }): Promise<{ lockId: string; txHash: string }>;
  /** Cross-checked lock lookup; null if not found on a quorum of RPCs. */
  getLock(lockId: string): Promise<EvmLockView | null>;
  /** Claim with the revealed secret (hex). Anyone may call; recipient is fixed. */
  claim(lockId: string, secret: string): Promise<string>;
  /** Refund after the timelock. */
  refund(lockId: string): Promise<string>;
  /** Deterministic lock id from the same fields the contract hashes. */
  computeLockId(p: {
    sender: string; recipient: string; token: string;
    amount: bigint; hashlock: string; timelock: number;
  }): string;
}

export interface BrcAdapter {
  /** Our own BRC pubkey (hex). */
  pubkey(): string;
  /** Build htlcScript(hash, recipientPub, locktime, ourPub), send a Lock tx. */
  sendLock(p: {
    amount: bigint;
    hashlock: string;
    recipientPubkey: string; // buyer's BRC pubkey
    locktime: number;        // unix seconds (>= 500,000,000)
    feeWei?: bigint;         // lock tx fee; defaults to the protocol minimum
  }): Promise<{ lockTxId: string; redeemScript: string; scriptHash: string }>;
  /** Reconstruct the redeem script the seller must have used (buyer side). */
  expectedScript(p: {
    hashlock: string;
    recipientPubkey: string; // our own pubkey when we are the buyer
    locktime: number;
    senderPubkey: string;    // seller's pubkey
  }): { redeemScript: string; scriptHash: string };
  /** Find a confirmed Lock tx by script hash in the locally validated chain. */
  findLock(scriptHash: string): Promise<BrcLockView | null>;
  /** Redeem via the claim branch, revealing the secret. Returns tx id. */
  claim(p: { lockTxId: string; redeemScript: string; secret: string; amount: bigint }): Promise<string>;
  /** Redeem via the refund branch after the locktime. Returns tx id. */
  refund(p: { lockTxId: string; redeemScript: string; amount: bigint }): Promise<string>;
  /** If the lock was redeemed, extract the revealed 32-byte secret (hex),
   * verified against the expected hashlock. */
  findRevealedSecret(lockTxId: string, hashlock: string): Promise<string | null>;
  /** Is a redeem/claim tx confirmed to depth n? */
  txConfirmations(txId: string): Promise<number>;
  /** Local chain clock (median-time-past of the tip), unix seconds. */
  chainTime(): number;
}

/** Wall clock, injectable for tests. */
export type Clock = () => number;
