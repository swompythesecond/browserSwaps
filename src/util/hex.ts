/** Hex <-> bytes helpers. All hex in this codebase is lowercase, no 0x prefix
 * unless explicitly an EVM value (viem's `0x…` strings). */

export function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error('odd hex length');
  // Validate the WHOLE string up front: parseInt('0z',16) returns 0 (it stops
  // at the first bad nibble) rather than NaN, so a per-pair NaN check silently
  // truncates half-invalid input instead of rejecting it.
  if (!/^[0-9a-fA-F]*$/.test(h)) throw new Error('bad hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('bad hex');
    out[i] = byte;
  }
  return out;
}

export function randomBytes32(): Uint8Array {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}

/** 0x-prefixed variant for EVM interfaces. */
export const hex0x = (b: Uint8Array): `0x${string}` => `0x${bytesToHex(b)}` as `0x${string}`;
