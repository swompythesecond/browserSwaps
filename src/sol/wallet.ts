/** In-tab Solana wallet: an ed25519 key generated on first visit and kept in
 * localStorage, mirroring the EVM and BRC wallets. Deliberately NOT derived
 * from the BRC key (also ed25519): reusing one keypair across chains links
 * identities and multiplies the blast radius of a leak. This is a HOT trading
 * wallet by design — users fund it with what they intend to trade. */
import { Keypair } from '@solana/web3.js';
import { bytesToHex, hexToBytes } from '../util/hex.js';

const KEY = 'bswap.sol.key.v1';

export function loadOrCreateSolKeypair(): Keypair {
  const raw = localStorage.getItem(KEY);
  if (raw && /^[0-9a-f]{128}$/.test(raw)) {
    return Keypair.fromSecretKey(hexToBytes(raw));
  }
  const kp = Keypair.generate();
  localStorage.setItem(KEY, bytesToHex(kp.secretKey));
  return kp;
}

/** 64-byte secret key, hex (the standard Solana keypair format, hex-encoded). */
export function exportSolKey(): string {
  return localStorage.getItem(KEY) ?? '';
}

export function importSolKey(hex: string): Keypair {
  if (!/^[0-9a-f]{128}$/.test(hex)) throw new Error('invalid Solana secret key (need 128 hex chars)');
  const kp = Keypair.fromSecretKey(hexToBytes(hex)); // throws on a bad key
  localStorage.setItem(KEY, hex);
  return kp;
}
