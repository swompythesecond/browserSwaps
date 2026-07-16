/**
 * The swap state machine. One instance drives all active swaps by ticking
 * them every few seconds; every transition is idempotent and every state is
 * re-entrant, so a tab crash at any point resumes cleanly from localStorage.
 *
 * Trust rules enforced here (the whole point of the platform):
 *   - Nothing a counterparty SAYS is believed; peer messages only accelerate
 *     polling. Chain observation (own BRC full node, cross-checked EVM RPCs)
 *     is the only input that causes value-bearing actions.
 *   - The buyer reveals the secret exclusively by redeeming the BRC lock,
 *     and only after the lock is confirmed on the locally validated chain
 *     with a safe margin before its refund locktime.
 *   - The seller locks BRC only after the buyer's USDT lock exists on-chain,
 *     is unclaimed, and leaves a wide enough claim window.
 */
import type {
  BrcAdapter, Clock, EvmAdapter, SwapRecord, SwapState,
} from './types.js';
import { TERMINAL_STATES, foreignAddressOf } from './types.js';
import type { SwapStore } from './store.js';
import { SWAP_TIMING, relayerFee, LOCK_FEE_BPS, CLAIM_FEE_BPS, pairConfig } from '../config.js';

/** Resolve the foreign-chain adapter for a swap's pair (undefined = the
 * legacy default pair, arb:usdt). One adapter instance per configured pair;
 * both the EVM and the Solana HTLC adapters implement the same interface. */
export type ForeignAdapters = (pair: string | undefined) => EvmAdapter;

/** Peer hints the engine wants to send (delivered by the market layer). */
export type OutboundHint =
  | { type: 'evm-locked'; swapId: string; lockId: string; txHash: string }
  | { type: 'brc-locked'; swapId: string; lockTxId: string }
  | { type: 'secret'; swapId: string; secret: string };

export class SwapEngine {
  private ticking = new Set<string>();

  constructor(
    private readonly foreign: ForeignAdapters,
    private readonly brc: BrcAdapter,
    private readonly store: SwapStore,
    private readonly sendHint: (peerId: string, hint: OutboundHint) => void,
    private readonly now: Clock = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Tick every non-terminal swap. Called on a timer AND on chain events. */
  async tickAll(): Promise<void> {
    for (const swap of this.store.all()) {
      if (!TERMINAL_STATES.has(swap.state)) await this.tick(swap.id);
    }
  }

  /** Advance one swap as far as it can currently go. Re-entrancy-guarded. */
  async tick(id: string): Promise<void> {
    if (this.ticking.has(id)) return;
    this.ticking.add(id);
    try {
      let prev: string | null = null;
      // Loop while the record keeps changing so a single tick can cross
      // several fast states; the iteration cap bounds pathological churn.
      for (let i = 0; i < 8; i++) {
        const swap = this.store.get(id);
        if (!swap || TERMINAL_STATES.has(swap.state)) break;
        const snapshot = JSON.stringify(swap);
        if (snapshot === prev) break;
        prev = snapshot;
        await this.step(swap);
      }
    } finally {
      this.ticking.delete(id);
    }
  }

  /** A counterparty hint arrived. Verify cheaply, then let the tick confirm on-chain. */
  async onHint(swapId: string, hint: { type: string; secret?: string }): Promise<void> {
    const swap = this.store.get(swapId);
    if (!swap) return;
    if (hint.type === 'secret' && hint.secret && swap.role === 'seller') {
      // Verify before trusting: sha256(secret) must equal the agreed hashlock.
      const ok = await sha256HexMatches(hint.secret, swap.hashlock);
      if (ok && !swap.secret) this.save({ ...swap, secret: hint.secret });
    }
    await this.tick(swapId);
  }

  // -------------------------------------------------------------------------

  private save(swap: SwapRecord): void {
    this.store.put({ ...swap, updatedAt: this.now() });
  }

  private move(swap: SwapRecord, state: SwapState, extra: Partial<SwapRecord> = {}): void {
    this.save({ ...swap, ...extra, state });
  }

  private fail(swap: SwapRecord, note: string): void {
    this.move(swap, 'failed', { note });
  }

  private async step(swap: SwapRecord): Promise<void> {
    // Permanent guard: a trade at or below the total relayer fees can never be
    // locked (the HTLC contract reverts "relayFee >= amount"). Fail it once
    // instead of retrying the doomed lock forever. Safe at any pre-lock state
    // because no funds have moved yet; if a lock somehow already exists we skip
    // this so the normal refund path can recover it.
    const amountToken = BigInt(swap.amountToken);
    const floor = pairConfig(swap.pair).feeMinUnits;
    const minViable = relayerFee(amountToken, LOCK_FEE_BPS, floor) + relayerFee(amountToken, CLAIM_FEE_BPS, floor);
    if (amountToken <= minViable && !swap.evm.lockTxHash && !swap.brc.lockTxId
      && !TERMINAL_STATES.has(swap.state)) {
      this.fail(swap, `trade too small: ${amountToken} token units ≤ ${minViable} in fees`);
      return;
    }
    try {
      if (swap.role === 'buyer') await this.stepBuyer(swap);
      else await this.stepSeller(swap);
    } catch (e) {
      // Transient errors (RPC down, mempool hiccup) leave the state unchanged;
      // the next tick retries. Only explicit checks move to 'failed'.
      const note = `retrying: ${(e as Error).message}`;
      if (swap.note !== note) this.save({ ...swap, note });
    }
  }

  // ------------------------------- BUYER ------------------------------------
  // pays USDT, holds the secret, receives BRC

  private async stepBuyer(swap: SwapRecord): Promise<void> {
    const now = this.now();
    const evm = this.foreign(swap.pair);
    const chain = pairConfig(swap.pair).chain;
    const sym = pairConfig(swap.pair).tokenSymbol;
    switch (swap.state) {
      case 'awaiting-confirm': {
        // Maker-buyer only: we accepted a take but have locked NOTHING yet. The
        // market layer flips us to 'init' the instant the taker's confirm lands.
        // If it never comes — the taker gave up or went offline — cancel cleanly.
        // No funds are at risk precisely because nothing has been locked.
        if (now - swap.createdAt > SWAP_TIMING.confirmTimeoutSecs) {
          this.fail(swap, 'the other side never confirmed — cancelled safely, no funds were locked');
        }
        return;
      }

      case 'init': {
        // Lock id is deterministic, so compute it before sending anything —
        // recovery after a crash mid-send is then a simple on-chain lookup.
        const lockId = evm.computeLockId({
          sender: foreignAddressOf(swap.self, chain),
          recipient: foreignAddressOf(swap.counterparty, chain),
          token: '', // adapter fills its configured token
          amount: BigInt(swap.amountToken),
          hashlock: swap.hashlock,
          timelock: swap.evmTimelock,
        });
        this.move(swap, 'evm-locking', { evm: { ...swap.evm, lockId } });
        return;
      }

      case 'evm-locking': {
        const existing = swap.evm.lockId ? await evm.getLock(swap.evm.lockId) : null;
        if (existing) {
          this.move(swap, 'evm-locked');
          return;
        }
        const { lockId, txHash } = await evm.lock({
          amount: BigInt(swap.amountToken),
          hashlock: swap.hashlock,
          recipient: foreignAddressOf(swap.counterparty, chain),
          timelock: swap.evmTimelock,
        });
        this.move(swap, 'evm-locked', { evm: { ...swap.evm, lockId, lockTxHash: txHash } });
        return;
      }

      case 'evm-locked': {
        this.sendHint(swap.counterparty.peerId, {
          type: 'evm-locked', swapId: swap.id,
          lockId: swap.evm.lockId!, txHash: swap.evm.lockTxHash ?? '',
        });
        this.move(swap, 'awaiting-brc-lock');
        return;
      }

      case 'awaiting-brc-lock': {
        const { redeemScript, scriptHash } = this.brc.expectedScript({
          hashlock: swap.hashlock,
          recipientPubkey: swap.self.brcPubkey,
          locktime: swap.brcLocktime,
          senderPubkey: swap.counterparty.brcPubkey,
        });
        const lock = await this.brc.findLock(scriptHash);
        const claimDeadline = swap.brcLocktime - SWAP_TIMING.buyerClaimSafetySecs;

        if (lock && lock.amount >= BigInt(swap.amountBrc)
          && lock.confirmations >= SWAP_TIMING.brcConfirmations) {
          if (now >= claimDeadline) {
            // Too close to the seller's refund window — do NOT reveal the secret.
            this.move(swap, 'refunding', { note: `BRC lock confirmed too late; refunding ${sym}` });
            return;
          }
          this.move(swap, 'brc-claiming', {
            brc: { ...swap.brc, lockTxId: lock.txId, redeemScript, scriptHash },
          });
          return;
        }
        if (now >= claimDeadline) {
          this.move(swap, 'refunding', { note: 'seller never locked BRC in time' });
        }
        return;
      }

      case 'brc-claiming': {
        if (!swap.brc.redeemTxId) {
          const redeemTxId = await this.brc.claim({
            lockTxId: swap.brc.lockTxId!,
            redeemScript: swap.brc.redeemScript!,
            secret: swap.secret!,
            amount: BigInt(swap.amountBrc),
          });
          // The secret is now public; hint it to the seller so their USDT
          // claim is instant instead of waiting on their chain scan.
          this.sendHint(swap.counterparty.peerId, {
            type: 'secret', swapId: swap.id, secret: swap.secret!,
          });
          this.save({ ...swap, brc: { ...swap.brc, redeemTxId } });
          return;
        }
        const conf = await this.brc.txConfirmations(swap.brc.redeemTxId);
        if (conf >= 1) this.move(swap, 'done', { note: 'BRC received' });
        return;
      }

      case 'refunding': {
        if (now < swap.evmTimelock) return; // wait out the contract timelock
        const view = swap.evm.lockId ? await evm.getLock(swap.evm.lockId) : null;
        if (view?.refunded || !view) {
          this.move(swap, 'refunded');
          return;
        }
        if (view.claimed) {
          // Only possible if the secret got out — which only happens via our
          // own BRC redeem, so this should be unreachable. Record it loudly.
          this.fail(swap, 'USDT claimed by counterparty — inspect this swap');
          return;
        }
        const refundTxHash = await evm.refund(swap.evm.lockId!);
        this.move(swap, 'refunded', { evm: { ...swap.evm, refundTxHash } });
        return;
      }
    }
  }

  // ------------------------------- SELLER -----------------------------------
  // pays BRC after verifying the USDT lock; learns the secret from the BRC chain

  private async stepSeller(swap: SwapRecord): Promise<void> {
    const now = this.now();
    const evm = this.foreign(swap.pair);
    const chain = pairConfig(swap.pair).chain;
    const sym = pairConfig(swap.pair).tokenSymbol;
    switch (swap.state) {
      case 'init': {
        const lockId = evm.computeLockId({
          sender: foreignAddressOf(swap.counterparty, chain),
          recipient: foreignAddressOf(swap.self, chain),
          token: '',
          amount: BigInt(swap.amountToken),
          hashlock: swap.hashlock,
          timelock: swap.evmTimelock,
        });
        this.move(swap, 'awaiting-evm-lock', { evm: { ...swap.evm, lockId } });
        return;
      }

      case 'awaiting-evm-lock': {
        const view = await evm.getLock(swap.evm.lockId!);
        if (!view) {
          // Give the buyer 30 minutes to fund; we have committed nothing yet.
          if (now - swap.createdAt > 1800) this.fail(swap, 'buyer never locked USDT');
          return;
        }
        if (view.claimed || view.refunded) {
          this.fail(swap, 'USDT lock already closed');
          return;
        }
        // The lock id commits to token/amount/recipient/hashlock/timelock, so
        // existence == parameter correctness. Remaining checks are policy:
        if (view.timelock - now < SWAP_TIMING.minEvmWindowSecs) {
          this.fail(swap, 'USDT lock window too short');
          return;
        }
        const large = view.amount >= SWAP_TIMING.largeSwapTokenUnits;
        const settled = large ? view.safe : view.ageSecs >= SWAP_TIMING.smallSwapMinAgeSecs;
        if (!settled) return; // keep polling until the finality policy is met
        this.move(swap, 'brc-locking');
        return;
      }

      case 'brc-locking': {
        if (!swap.brc.lockTxId) {
          const { lockTxId, redeemScript, scriptHash } = await this.brc.sendLock({
            amount: BigInt(swap.amountBrc),
            hashlock: swap.hashlock,
            recipientPubkey: swap.counterparty.brcPubkey,
            locktime: swap.brcLocktime,
            feeWei: swap.brcFeeWei ? BigInt(swap.brcFeeWei) : undefined,
          });
          this.save({ ...swap, brc: { ...swap.brc, lockTxId, redeemScript, scriptHash } });
          return;
        }
        this.sendHint(swap.counterparty.peerId, {
          type: 'brc-locked', swapId: swap.id, lockTxId: swap.brc.lockTxId,
        });
        this.move(swap, 'brc-locked');
        return;
      }

      case 'brc-locked': {
        const secret = swap.secret
          ?? await this.brc.findRevealedSecret(swap.brc.lockTxId!, swap.hashlock);
        if (secret) {
          this.move(swap, 'evm-claiming', { secret });
          return;
        }
        if (this.brc.chainTime() >= swap.brcLocktime) {
          this.move(swap, 'refunding', { note: 'buyer never redeemed; refunding BRC' });
        }
        return;
      }

      case 'evm-claiming': {
        const view = await evm.getLock(swap.evm.lockId!);
        if (view?.claimed) {
          this.move(swap, 'done', { note: `${sym} received` });
          return;
        }
        const claimTxHash = await evm.claim(swap.evm.lockId!, swap.secret!);
        this.move(swap, 'done', { evm: { ...swap.evm, claimTxHash }, note: `${sym} received` });
        return;
      }

      case 'refunding': {
        // Race guard: the buyer may have redeemed at the last moment. A
        // revealed secret beats a refund — claim the USDT instead.
        const secret = swap.secret
          ?? await this.brc.findRevealedSecret(swap.brc.lockTxId!, swap.hashlock);
        if (secret) {
          this.move(swap, 'evm-claiming', { secret });
          return;
        }
        if (!swap.brc.refundTxId) {
          const refundTxId = await this.brc.refund({
            lockTxId: swap.brc.lockTxId!,
            redeemScript: swap.brc.redeemScript!,
            amount: BigInt(swap.amountBrc),
          });
          this.save({ ...swap, brc: { ...swap.brc, refundTxId } });
          return;
        }
        const conf = await this.brc.txConfirmations(swap.brc.refundTxId);
        if (conf >= 1) this.move(swap, 'refunded');
        return;
      }
    }
  }
}

async function sha256HexMatches(secretHex: string, hashHex: string): Promise<boolean> {
  try {
    const bytes = new Uint8Array(secretHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    if (bytes.length !== 32) return false;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('') === hashHex;
  } catch {
    return false;
  }
}
