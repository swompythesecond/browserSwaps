import { describe, expect, it } from 'vitest';
import { makerMinBrcOf, minBrcForFill, minFillBrcOf, remainingBrcOf, tokenForBrc, type Offer } from './protocol.js';

const base = (side: Offer['side'], amountBrc: string, amountToken: string): Offer => ({
  v: 1, id: 'x', side, amountBrc, amountToken,
  maker: { peerId: 'p', brcPubkey: 'k', evmAddress: '0x0' }, ts: 0,
});

describe('remainingBrcOf', () => {
  it('defaults to the full size', () => {
    expect(remainingBrcOf(base('sell-brc', '100', '50'))).toBe(100n);
  });
  it('honors partial fills', () => {
    expect(remainingBrcOf({ ...base('sell-brc', '100', '50'), remainingBrc: '30' })).toBe(30n);
  });
  it('returns 0 on garbage', () => {
    expect(remainingBrcOf({ ...base('sell-brc', '100', '50'), remainingBrc: 'lol' })).toBe(0n);
  });
});

describe('tokenForBrc', () => {
  it('full fill costs exactly the offer total, both sides', () => {
    expect(tokenForBrc(base('sell-brc', '10000000000', '5000000'), 10000000000n)).toBe(5000000n);
    expect(tokenForBrc(base('buy-brc', '10000000000', '5000000'), 10000000000n)).toBe(5000000n);
  });
  it('proportional partial fill', () => {
    // 100 BRC for 5 USDT -> 40 BRC costs 2 USDT
    expect(tokenForBrc(base('sell-brc', '10000000000', '5000000'), 4000000000n)).toBe(2000000n);
    expect(tokenForBrc(base('buy-brc', '10000000000', '5000000'), 4000000000n)).toBe(2000000n);
  });
  it('sub-unit rounding always favors the maker', () => {
    // 3 units of BRC at 1 token per 3 BRC: 1 BRC is worth 1/3 token unit.
    // sell-brc: maker receives tokens -> round UP; buy-brc: maker pays -> DOWN.
    expect(tokenForBrc(base('sell-brc', '3', '1'), 1n)).toBe(1n);
    expect(tokenForBrc(base('buy-brc', '3', '1'), 1n)).toBe(0n);
  });
  it('partials never sum to more than the total (buy-brc) or less (sell-brc)', () => {
    const sell = base('sell-brc', '7', '5');
    const buy = base('buy-brc', '7', '5');
    let sumSell = 0n;
    let sumBuy = 0n;
    for (const part of [1n, 2n, 4n]) { // 1+2+4 = 7
      sumSell += tokenForBrc(sell, part);
      sumBuy += tokenForBrc(buy, part);
    }
    expect(sumSell).toBeGreaterThanOrEqual(5n); // seller-maker never shortchanged
    expect(sumBuy).toBeLessThanOrEqual(5n);     // buyer-maker never overcharged
  });
  it('is 0 for non-positive input', () => {
    expect(tokenForBrc(base('sell-brc', '100', '50'), 0n)).toBe(0n);
    expect(tokenForBrc(base('sell-brc', '0', '50'), 10n)).toBe(0n);
  });
});

describe('minBrcForFill', () => {
  it('is the exact inverse of tokenForBrc for both rounding directions', () => {
    // awkward ratios on purpose: 7 BRC units for 5 token units, min 2 tokens
    for (const side of ['sell-brc', 'buy-brc'] as const) {
      const o = base(side, '7', '5');
      const min = minBrcForFill(o, 2n);
      expect(tokenForBrc(o, min)).toBeGreaterThanOrEqual(2n);       // reaches the min
      if (min > 1n) expect(tokenForBrc(o, min - 1n)).toBeLessThan(2n); // and is minimal
    }
  });
  it('round numbers: 100 BRC for 5 USDT, min 0.30 USDT', () => {
    // buy-brc floors, so exactly 6 BRC is needed; sell-brc ceils, so a hair
    // less (5.99998001 BRC) already rounds up to 0.30 USDT.
    expect(minBrcForFill(base('buy-brc', '10000000000', '5000000'), 300_000n)).toBe(600000000n);
    expect(minBrcForFill(base('sell-brc', '10000000000', '5000000'), 300_000n)).toBe(599998001n);
  });
});

describe('maker minimum fill', () => {
  // 100 BRC for 5 USDT; platform floor at 0.30 USDT ≈ 6 BRC
  const o = base('buy-brc', '10000000000', '5000000');

  it('makerMinBrcOf: unset/garbage/negative-ish -> 0', () => {
    expect(makerMinBrcOf(o)).toBe(0n);
    expect(makerMinBrcOf({ ...o, minBrc: 'lol' })).toBe(0n);
    expect(makerMinBrcOf({ ...o, minBrc: '0' })).toBe(0n);
    expect(makerMinBrcOf({ ...o, minBrc: '42' })).toBe(42n);
  });
  it('unset maker min -> platform floor applies', () => {
    expect(minFillBrcOf(o, 300_000n)).toBe(600000000n);
  });
  it('maker min above the floor wins', () => {
    expect(minFillBrcOf({ ...o, minBrc: '2500000000' }, 300_000n)).toBe(2500000000n); // 25 BRC
  });
  it('maker min below the floor is raised to the floor', () => {
    expect(minFillBrcOf({ ...o, minBrc: '100' }, 300_000n)).toBe(600000000n);
  });
  it('clamped to the remaining amount so a full take is always allowed', () => {
    expect(minFillBrcOf({ ...o, minBrc: '9000000000', remainingBrc: '7000000000' }, 300_000n)).toBe(7000000000n);
  });
  it('all-or-nothing: min == amount forces the whole offer', () => {
    expect(minFillBrcOf({ ...o, minBrc: o.amountBrc }, 300_000n)).toBe(BigInt(o.amountBrc));
  });
});
