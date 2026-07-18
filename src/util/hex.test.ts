import { describe, it, expect } from 'vitest';
import { bytesToHex, hexToBytes } from './hex.js';

describe('hexToBytes', () => {
  it('round-trips valid lowercase hex', () => {
    const bytes = Uint8Array.from([0x00, 0x0f, 0xff, 0xab]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  it('accepts a 0x prefix', () => {
    expect(hexToBytes('0xff00')).toEqual(Uint8Array.from([0xff, 0x00]));
  });

  it('rejects odd-length input', () => {
    expect(() => hexToBytes('abc')).toThrow();
  });

  it('rejects non-hex where the FIRST nibble is bad', () => {
    expect(() => hexToBytes('z0')).toThrow();
  });

  it('rejects non-hex where only the SECOND nibble is bad (no silent truncation)', () => {
    // parseInt('0z', 16) === 0, so a per-pair NaN check would accept this and
    // corrupt the byte to 0x00. The whole-string check must reject it.
    expect(() => hexToBytes('0z')).toThrow();
    expect(() => hexToBytes('1g')).toThrow();
    expect(() => hexToBytes('deadbe0g')).toThrow();
  });
});
