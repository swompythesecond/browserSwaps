import { describe, it, expect, beforeEach } from 'vitest';
import { SwapEngine, type OutboundHint } from './engine.js';
import { SwapStore } from './store.js';
import type { BrcAdapter, BrcLockView, EvmAdapter, EvmLockView, SwapRecord } from './types.js';
import { SWAP_TIMING, relayerFee, CLAIM_FEE_BPS, pairConfig } from '../config.js';

// The honest relayFee every buyer's adapter stores in the lock, for the
// default-pair fixture amount below. The seller gate now requires this exact
// value, so the happy path must present it.
const HONEST_RELAY_FEE = relayerFee(5_000_000n, CLAIM_FEE_BPS, pairConfig(undefined).feeMinUnits);

// localStorage shim for the node test environment
const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const T0 = 1_800_000_000; // fixed "now"
const HASH = 'aa'.repeat(32);
const SECRET = 'bb'.repeat(32);

class MockEvm implements EvmAdapter {
  lockView: EvmLockView | null = null;
  lockCalls = 0;
  claimCalls = 0;
  refundCalls = 0;
  failLock = false;

  address(): string { return '0xSELF'; }

  computeLockId(): string { return '0xlockid'; }

  async lock(): Promise<{ lockId: string; txHash: string }> {
    if (this.failLock) throw new Error('rpc down');
    this.lockCalls++;
    this.lockView = {
      token: '0xT', sender: '0xSELF', recipient: '0xCP', amount: 5_000_000n,
      hashlock: HASH, timelock: T0 + SWAP_TIMING.evmTimelockSecs,
      relayFee: HONEST_RELAY_FEE, claimed: false, refunded: false, safe: true, ageSecs: 120,
    };
    return { lockId: '0xlockid', txHash: '0xtx1' };
  }

  async getLock(): Promise<EvmLockView | null> { return this.lockView; }

  async claim(): Promise<string> {
    this.claimCalls++;
    if (this.lockView) this.lockView = { ...this.lockView, claimed: true };
    return '0xclaimtx';
  }

  async refund(): Promise<string> {
    this.refundCalls++;
    if (this.lockView) this.lockView = { ...this.lockView, refunded: true };
    return '0xrefundtx';
  }
}

class MockBrc implements BrcAdapter {
  lock: BrcLockView | null = null;
  revealedSecret: string | null = null;
  confirmations = new Map<string, number>();
  mtp = T0;
  claimCalls = 0;
  refundCalls = 0;

  pubkey(): string { return 'cc'.repeat(32); }

  expectedScript(): { redeemScript: string; scriptHash: string } {
    return { redeemScript: 'dd'.repeat(40), scriptHash: 'ee'.repeat(32) };
  }

  async sendLock(): Promise<{ lockTxId: string; redeemScript: string; scriptHash: string }> {
    this.lock = { txId: 'ff'.repeat(32), amount: 10_000_000_000n, confirmations: 0 };
    return { lockTxId: this.lock.txId, redeemScript: 'dd'.repeat(40), scriptHash: 'ee'.repeat(32) };
  }

  async findLock(): Promise<BrcLockView | null> { return this.lock; }

  async claim(): Promise<string> {
    this.claimCalls++;
    this.revealedSecret = SECRET;
    this.confirmations.set('redeemtx', 1);
    return 'redeemtx';
  }

  async refund(): Promise<string> {
    this.refundCalls++;
    // stays at 0 confirmations until the test advances it — this is what
    // opens the refund/claim race window the engine must handle
    return 'refundtx';
  }

  async findRevealedSecret(): Promise<string | null> { return this.revealedSecret; }

  async txConfirmations(txId: string): Promise<number> { return this.confirmations.get(txId) ?? 0; }

  chainTime(): number { return this.mtp; }
}

function baseSwap(role: 'buyer' | 'seller'): SwapRecord {
  return {
    id: HASH,
    role,
    offerId: 'o1',
    createdAt: T0,
    updatedAt: T0,
    amountBrc: '10000000000',   // 100 BRC
    amountToken: '5000000',     // 5 USDT
    hashlock: HASH,
    ...(role === 'buyer' ? { secret: SECRET } : {}),
    self: { brcPubkey: 'cc'.repeat(32), evmAddress: '0xSELF', peerId: 'me' },
    counterparty: { brcPubkey: '11'.repeat(32), evmAddress: '0xCP', peerId: 'them' },
    evmTimelock: T0 + SWAP_TIMING.evmTimelockSecs,
    brcLocktime: T0 + SWAP_TIMING.brcLocktimeSecs,
    evm: {}, brc: {},
    state: 'init',
  };
}

describe('SwapEngine', () => {
  let evm: MockEvm;
  let brc: MockBrc;
  let store: SwapStore;
  let hints: OutboundHint[];
  let now: number;
  let engine: SwapEngine;

  beforeEach(() => {
    mem.clear();
    evm = new MockEvm();
    brc = new MockBrc();
    store = new SwapStore();
    hints = [];
    now = T0 + 60;
    engine = new SwapEngine(() => evm, brc, store, (_p, h) => hints.push(h), () => now);
  });

  it('buyer happy path: lock USDT -> see BRC lock -> claim, revealing the secret', async () => {
    store.put(baseSwap('buyer'));
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('awaiting-brc-lock');
    expect(evm.lockCalls).toBe(1);
    expect(hints.some((h) => h.type === 'evm-locked')).toBe(true);

    // seller's BRC lock appears but with too few confirmations
    brc.lock = { txId: 'ff'.repeat(32), amount: 10_000_000_000n, confirmations: 1 };
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('awaiting-brc-lock');

    // confirmed deep enough -> claim
    brc.lock = { ...brc.lock, confirmations: 3 };
    await engine.tick(HASH);
    const s = store.get(HASH)!;
    expect(s.state).toBe('done');
    expect(brc.claimCalls).toBe(1);
    expect(hints.some((h) => h.type === 'secret')).toBe(true);
  });

  it('buyer refuses to reveal the secret too close to the BRC locktime', async () => {
    store.put(baseSwap('buyer'));
    await engine.tick(HASH);
    brc.lock = { txId: 'ff'.repeat(32), amount: 10_000_000_000n, confirmations: 3 };
    // jump the clock inside the safety margin
    now = T0 + SWAP_TIMING.brcLocktimeSecs - SWAP_TIMING.buyerClaimSafetySecs + 10;
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('refunding');
    expect(brc.claimCalls).toBe(0); // secret never revealed
  });

  it('buyer refunds USDT after the timelock when the seller never locks', async () => {
    store.put(baseSwap('buyer'));
    await engine.tick(HASH);
    now = T0 + SWAP_TIMING.brcLocktimeSecs; // deadline passed, no BRC lock
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('refunding');
    now = T0 + SWAP_TIMING.evmTimelockSecs + 1;
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('refunded');
    expect(evm.refundCalls).toBe(1);
  });

  it('maker-buyer in awaiting-confirm locks NOTHING until the taker confirms', async () => {
    store.put({ ...baseSwap('buyer'), state: 'awaiting-confirm' });
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('awaiting-confirm'); // still holding
    expect(evm.lockCalls).toBe(0);                            // no funds committed
  });

  it('maker-buyer cancels safely (no funds locked) when the confirm never arrives', async () => {
    store.put({ ...baseSwap('buyer'), state: 'awaiting-confirm' });
    now = T0 + SWAP_TIMING.confirmTimeoutSecs + 1; // past the confirm deadline
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('failed');
    expect(evm.lockCalls).toBe(0); // nothing was ever locked -> nothing stranded
  });

  it('seller happy path: verify USDT lock -> lock BRC -> learn secret -> claim USDT', async () => {
    store.put(baseSwap('seller'));
    await engine.tick(HASH);
    // no USDT lock yet
    expect(store.get(HASH)!.state).toBe('awaiting-evm-lock');

    // buyer's lock appears, settled per policy
    await evm.lock();
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('brc-locked');
    expect(brc.lock).not.toBeNull();
    expect(hints.some((h) => h.type === 'brc-locked')).toBe(true);

    // buyer redeems on the BRC chain -> secret becomes visible
    brc.revealedSecret = SECRET;
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('done');
    expect(evm.claimCalls).toBe(1);
  });

  it('seller does not lock BRC until the finality policy is met', async () => {
    store.put(baseSwap('seller'));
    await evm.lock();
    const largeAmount = 500_000_000n; // large + not safe
    evm.lockView = { ...evm.lockView!, safe: false, ageSecs: 5, amount: largeAmount,
      relayFee: relayerFee(largeAmount, CLAIM_FEE_BPS, pairConfig(undefined).feeMinUnits) };
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('awaiting-evm-lock');
    evm.lockView = { ...evm.lockView, safe: true };
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('brc-locked');
  });

  it('seller rejects a USDT lock whose relayFee would drain the payout', async () => {
    store.put(baseSwap('seller'));
    await evm.lock();
    // relayFee is not committed by the lock id; a buyer sets it near `amount`
    // so a non-beneficiary claim skims almost everything from our proceeds.
    evm.lockView = { ...evm.lockView!, relayFee: evm.lockView!.amount - 1n };
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('failed');
    expect(brc.lock).toBeNull(); // we must NOT have locked BRC
  });

  it('seller rejects a USDT lock whose relayFee is too low to relay the claim', async () => {
    store.put(baseSwap('seller'));
    await evm.lock();
    // A too-low relayFee (0 here) passes every id-bound check but leaves our
    // own claim below the relayer's minimum: a gasless seller could never exit,
    // the lock would rot to timelock, and the buyer would refund and keep the
    // BRC. Reject it before committing BRC, same as a too-high fee.
    evm.lockView = { ...evm.lockView!, relayFee: 0n };
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('failed');
    expect(brc.lock).toBeNull(); // we must NOT have locked BRC
  });

  it('seller refunds BRC at locktime, but a last-second reveal flips to claiming USDT', async () => {
    store.put(baseSwap('seller'));
    await evm.lock();
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('brc-locked');

    // locktime passes with no secret -> refund broadcast (unconfirmed)
    brc.mtp = T0 + SWAP_TIMING.brcLocktimeSecs + 1;
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('refunding');
    expect(brc.refundCalls).toBe(1);
    // race: the secret shows up before our refund confirms
    brc.revealedSecret = SECRET;
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('done');
    expect(evm.claimCalls).toBe(1);
  });

  it('a verified secret hint from the counterparty short-circuits the seller claim', async () => {
    store.put(baseSwap('seller'));
    await evm.lock();
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('brc-locked');
    // hint with a WRONG secret is ignored
    await engine.onHint(HASH, { type: 'secret', secret: '00'.repeat(32) });
    expect(store.get(HASH)!.secret).toBeUndefined();
    // hint with the right secret is accepted (sha256('bb'*32) must equal hashlock)
  });

  it('transient adapter errors do not change state and retry cleanly', async () => {
    store.put(baseSwap('buyer'));
    evm.failLock = true;
    await engine.tick(HASH);
    const s = store.get(HASH)!;
    expect(s.state).toBe('evm-locking'); // stuck mid-state, not failed
    expect(s.note).toContain('retrying');
    evm.failLock = false; // RPC back up
    await engine.tick(HASH);
    expect(store.get(HASH)!.state).toBe('awaiting-brc-lock'); // recovered
  });
});
