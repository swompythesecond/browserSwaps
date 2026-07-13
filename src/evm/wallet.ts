/** In-tab EVM wallet: a secp256k1 key generated on first visit and kept in
 * localStorage, mirroring how the BRC wallet works. This is a HOT trading
 * wallet by design — users fund it with what they intend to trade. */
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

const KEY = 'bswap.evm.key.v1';

export function loadOrCreateEvmAccount(): PrivateKeyAccount {
  let pk = localStorage.getItem(KEY) as `0x${string}` | null;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    pk = generatePrivateKey();
    localStorage.setItem(KEY, pk);
  }
  return privateKeyToAccount(pk);
}

export function exportEvmKey(): string {
  return localStorage.getItem(KEY) ?? '';
}

export function importEvmKey(pk: string): PrivateKeyAccount {
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('invalid private key');
  localStorage.setItem(KEY, pk);
  return privateKeyToAccount(pk as `0x${string}`);
}
