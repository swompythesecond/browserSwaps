import { describe, it, expect } from 'vitest';
import {
  RELAY, relayerFee, maxSendable, LOCK_FEE_BPS, CLAIM_FEE_BPS, WITHDRAW_FEE_BPS,
} from './config.js';

const FLOOR = RELAY.feeMinUnits; // 0.03 USDT

describe('relayerFee', () => {
  it('charges the percentage when it exceeds the floor', () => {
    // 0.2% of 100 USDT = 0.20 USDT
    expect(relayerFee(100_000_000n, LOCK_FEE_BPS)).toBe(200_000n);
  });

  it('floors tiny trades so they still cover gas', () => {
    // 0.2% of 0.30 USDT = 0.0006 USDT -> floored to 0.03
    expect(relayerFee(300_000n, LOCK_FEE_BPS)).toBe(FLOOR);
  });

  it('withdrawals pay only the flat gas-covering floor, at any size', () => {
    expect(WITHDRAW_FEE_BPS).toBe(0n);
    expect(relayerFee(1n, WITHDRAW_FEE_BPS)).toBe(FLOOR);
    expect(relayerFee(100_000_000n, WITHDRAW_FEE_BPS)).toBe(FLOOR);
    expect(relayerFee(10_000_000_000n, WITHDRAW_FEE_BPS)).toBe(FLOOR); // 10k USDT
  });

  it('a swap total (lock + claim) is ~0.4% on large trades', () => {
    const amt = 250_000_000n; // 250 USDT
    const total = relayerFee(amt, LOCK_FEE_BPS) + relayerFee(amt, CLAIM_FEE_BPS);
    expect(total).toBe((amt * RELAY.feeBps) / 10_000n); // exactly 0.4%
  });
});

describe('maxSendable', () => {
  it('never lets amount + fee exceed the balance (percentage regime)', () => {
    const bal = 100_000_000n; // 100 USDT, well into the percentage regime
    const amt = maxSendable(bal, LOCK_FEE_BPS);
    // Safe: total never exceeds the balance.
    expect(amt + relayerFee(amt, LOCK_FEE_BPS)).toBeLessThanOrEqual(bal);
    // Tight: integer flooring leaves at most a few units (< 0.00001 USDT) unused.
    expect(bal - (amt + relayerFee(amt, LOCK_FEE_BPS))).toBeLessThanOrEqual(3n);
  });

  it('never lets amount + fee exceed the balance (floor regime)', () => {
    const bal = 500_000n; // 0.50 USDT, fee stays at the floor here
    const amt = maxSendable(bal, LOCK_FEE_BPS);
    expect(amt).toBe(bal - FLOOR);
    expect(amt + relayerFee(amt, LOCK_FEE_BPS)).toBeLessThanOrEqual(bal);
  });

  it('withdraw Max sends balance minus the flat floor, at any size', () => {
    for (const bal of [500_000n, 100_000_000n, 10_000_000_000n]) {
      const amt = maxSendable(bal, WITHDRAW_FEE_BPS);
      expect(amt).toBe(bal - FLOOR);
    }
  });

  it('returns 0 when the balance cannot even cover the floor', () => {
    expect(maxSendable(FLOOR, WITHDRAW_FEE_BPS)).toBe(0n);
    expect(maxSendable(FLOOR - 1n, WITHDRAW_FEE_BPS)).toBe(0n);
  });
});
