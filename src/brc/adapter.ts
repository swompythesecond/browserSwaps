/**
 * BrcAdapter backed by the embedded BrowserCoin full node. All reads here are
 * against the locally validated chain — this side of a swap needs no external
 * trust at all, which is why the secret-holder is always the BRC receiver.
 */
import type { Node } from '@bc/node.js';
import { formatAmount } from '@bc/node.js';
import {
  TxKind, redeemSighash, txHash, isLock, isRedeem, type Transaction,
} from '@bc/chain/transaction.js';
import { htlcScript } from '@bc/chain/scriptBuild.js';
import { scriptHash as scriptHashOf } from '@bc/chain/script.js';
import { getLock } from '@bc/chain/state.js';
import { sign } from '@bc/crypto/keys.js';
import { sha256 } from '@bc/crypto/hash.js';
import type { BrcAdapter, BrcLockView } from '../swap/types.js';
import { bytesToHex, hexToBytes } from '../util/hex.js';

/** Flat fee for Lock/Redeem txs, comfortably above the 1 wei/byte floor. */
const SCRIPT_TX_FEE = '0.00001';
/** How far back we are willing to scan block bodies for a redeem/refund tx. */
const MAX_SCAN_BLOCKS = 5000;

const TRUE_ITEM = new Uint8Array([1]);
const FALSE_ITEM = new Uint8Array(0);

export class NodeBrcAdapter implements BrcAdapter {
  /** txId(hex) -> confirmed height, so repeat confirmation checks are O(1). */
  private txHeightCache = new Map<string, number>();

  constructor(private readonly node: Node) {}

  pubkey(): string {
    return bytesToHex(this.node.wallet.publicKey);
  }

  expectedScript(p: {
    hashlock: string; recipientPubkey: string; locktime: number; senderPubkey: string;
  }): { redeemScript: string; scriptHash: string } {
    const script = htlcScript(
      hexToBytes(p.hashlock),
      hexToBytes(p.recipientPubkey),
      p.locktime,
      hexToBytes(p.senderPubkey),
    );
    return { redeemScript: bytesToHex(script), scriptHash: bytesToHex(scriptHashOf(script)) };
  }

  async sendLock(p: {
    amount: bigint; hashlock: string; recipientPubkey: string; locktime: number; feeWei?: bigint;
  }): Promise<{ lockTxId: string; redeemScript: string; scriptHash: string }> {
    const { redeemScript, scriptHash } = this.expectedScript({
      hashlock: p.hashlock,
      recipientPubkey: p.recipientPubkey,
      locktime: p.locktime,
      senderPubkey: this.pubkey(),
    });
    // Crash recovery: if a lock under this exact script already exists on
    // chain (we sent it but died before persisting), reuse it instead of
    // double-spending our balance into a second lock.
    const existing = await this.findLock(scriptHash);
    if (existing) return { lockTxId: existing.txId, redeemScript, scriptHash };

    const fee = p.feeWei && p.feeWei > 0n ? formatAmount(p.feeWei) : SCRIPT_TX_FEE;
    const res = this.node.lock(formatAmount(p.amount), fee, hexToBytes(redeemScript));
    if (typeof res === 'string') throw new Error(`BRC lock failed: ${res}`);
    return { lockTxId: res.lockId, redeemScript, scriptHash };
  }

  async findLock(scriptHashHex: string): Promise<BrcLockView | null> {
    // Active locks live in the tip state — no block scanning needed.
    const target = scriptHashHex.toLowerCase();
    let best: BrcLockView | null = null;
    for (const [lockId, lock] of this.node.chain.tipState.locks) {
      if (bytesToHex(lock.scriptHash) !== target) continue;
      const confirmations = this.node.chain.height - lock.createdHeight + 1;
      if (!best || lock.amount > best.amount) {
        best = { txId: lockId, amount: lock.amount, confirmations };
      }
    }
    return best;
  }

  async claim(p: {
    lockTxId: string; redeemScript: string; secret: string; amount: bigint;
  }): Promise<string> {
    return this.redeem(p.lockTxId, p.redeemScript, (sighash) => {
      const sig = sign(sighash, this.node.wallet.privateKey);
      return [sig, hexToBytes(p.secret), TRUE_ITEM]; // claim branch
    });
  }

  async refund(p: { lockTxId: string; redeemScript: string; amount: bigint }): Promise<string> {
    return this.redeem(p.lockTxId, p.redeemScript, (sighash) => {
      const sig = sign(sighash, this.node.wallet.privateKey);
      return [sig, FALSE_ITEM]; // refund branch (after CLTV locktime)
    });
  }

  /** Shared redeem path: rebuild the exact tx Node.redeem will submit so we
   * can (a) sign its sighash and (b) know its txId for tracking. */
  private redeem(
    lockIdHex: string,
    redeemScriptHex: string,
    witnessFor: (sighash: Uint8Array) => Uint8Array[],
  ): string {
    const lock = getLock(this.node.chain.tipState, lockIdHex.toLowerCase());
    if (!lock) throw new Error('lock not found or already spent');
    const redeemScript = hexToBytes(redeemScriptHex);
    const to = this.node.wallet.publicKey;
    const fee = parseBrcAmount(SCRIPT_TX_FEE);
    const tx: Transaction = {
      kind: TxKind.Redeem,
      from: new Uint8Array(32),
      to,
      amount: lock.amount,
      fee,
      nonce: 0,
      signature: new Uint8Array(0),
      lockId: hexToBytes(lockIdHex),
      redeemScript,
      witness: [],
    };
    tx.witness = witnessFor(redeemSighash(tx));
    const err = this.node.redeem(lockIdHex, to, SCRIPT_TX_FEE, redeemScript, tx.witness);
    if (err) throw new Error(`BRC redeem failed: ${err}`);
    return bytesToHex(txHash(tx));
  }

  async findRevealedSecret(lockTxId: string, hashlock: string): Promise<string | null> {
    // Fast path: still locked -> definitely no secret yet.
    if (getLock(this.node.chain.tipState, lockTxId.toLowerCase())) return null;
    const targetLockId = lockTxId.toLowerCase();
    const targetHash = hashlock.toLowerCase();
    let scanned = 0;
    for (const cb of this.node.chain.iterateCanonical()) {
      if (!cb.hasBody || ++scanned > MAX_SCAN_BLOCKS) break;
      for (const tx of cb.block.transactions) {
        if (!isRedeem(tx) || bytesToHex(tx.lockId!) !== targetLockId) continue;
        for (const item of tx.witness ?? []) {
          if (item.length === 32 && bytesToHex(sha256(item)) === targetHash) {
            return bytesToHex(item);
          }
        }
        return null; // redeem found but no matching preimage => it was a refund
      }
    }
    return null;
  }

  async txConfirmations(txId: string): Promise<number> {
    const target = txId.toLowerCase();
    const cached = this.txHeightCache.get(target);
    if (cached !== undefined) return this.node.chain.height - cached + 1;
    let scanned = 0;
    for (const cb of this.node.chain.iterateCanonical()) {
      if (!cb.hasBody || ++scanned > MAX_SCAN_BLOCKS) break;
      for (const tx of cb.block.transactions) {
        if (bytesToHex(txHash(tx)) === target) {
          this.txHeightCache.set(target, cb.block.header.height);
          return this.node.chain.height - cb.block.header.height + 1;
        }
      }
    }
    return 0;
  }

  chainTime(): number {
    return this.node.chain.nextBlockScriptContext().blockMtp;
  }
}

/** Parse a human BRC amount ("0.00001") into wei without importing parseAmount
 * (kept local to avoid a circular import through node.ts in tests). */
function parseBrcAmount(s: string): bigint {
  const [whole = '0', frac = ''] = s.split('.');
  return BigInt(whole) * 100_000_000n + BigInt((frac + '00000000').slice(0, 8));
}
