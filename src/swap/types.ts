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
  /** Market PeerJS id, for the in-swap message channel. */
  peerId: string;
}

export interface SwapRecord {
  id: string;                // uuid
  role: SwapRole;
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

  evm: {
    lockId?: string;         // 0x… deterministic id in the HTLC contract
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

/** On-chain view of an HTLC contract lock, as verified across RPCs. */
export interface EvmLockView {
  token: string;
  sender: string;
  recipient: string;
  amount: bigint;
  hashlock: string;          // hex, no 0x
  timelock: number;          // unix seconds
  claimed: boolean;
  refunded: boolean;
  /** True when the lock is also visible at the `safe` (L1-posted) block tag. */
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
