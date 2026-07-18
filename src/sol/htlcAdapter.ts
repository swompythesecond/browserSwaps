/**
 * EvmAdapter implementation (the shared foreign-chain interface) against the
 * bswap-htlc program on Solana (solana/programs/bswap-htlc).
 *
 * Gasless-first, like the EVM adapter — but simpler, because relaying is
 * native to Solana: the user PARTIALLY SIGNS the very transaction that moves
 * their tokens and the relayer countersigns as fee payer. No permit, no
 * intent structs, no replay guards (a signed tx embeds a recent blockhash and
 * can land at most once). Claims and refunds need no user signature at all —
 * the program fixes the beneficiary — so the relayer builds those itself and
 * earns the in-lock relay fee.
 *
 * Verification model mirrors the EVM adapter: value-bearing decisions require
 * agreement from every reachable configured RPC (quorum ≥ 2) on the lock
 * PDA's immutable fields; `finalized` commitment plays the role of the EVM
 * `safe` tag for large swaps.
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  type FetchMiddleware,
} from '@solana/web3.js';
import { sha256 } from '@bc/crypto/hash.js';
import type { EvmAdapter, EvmLockView } from '../swap/types.js';
import {
  relayerFee, LOCK_FEE_BPS, CLAIM_FEE_BPS,
  type SolNetworkConfig, type PairConfig,
} from '../config.js';
import { hexToBytes } from '../util/hex.js';

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
/** Wrapped SOL. The sol:sol pair escrows this mint; the adapter wraps native
 * lamports on lock and unwraps on withdraw, so users only ever see SOL. */
const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/** Lamports kept out of the tradable sol:sol balance: covers the one-time
 * wSOL account rent (~0.00204) plus a little for self-submitted rescues. */
const NATIVE_RESERVE = 3_000_000n;
/** Smallest native withdrawal — below the rent-exempt minimum a transfer to
 * a brand-new address fails outright. */
const MIN_NATIVE_WITHDRAW = 1_000_000n; // 0.001 SOL

/** SOL a wallet needs before self-submitting is worth attempting (~40 txs). */
const MIN_SELF_SUBMIT_LAMPORTS = 200_000;

/** Flat withdrawal fees (token units, 6 dp): base covers the tx signature;
 * the larger one applies when the destination has no token account yet and
 * the relayer must front ~0.002 SOL of rent to create it. The relayer server
 * enforces the same floor — keep the two in sync. */
export const SOL_WITHDRAW_FEE_UNITS = 30_000n;      // 0.03
export const SOL_WITHDRAW_ATA_FEE_UNITS = 400_000n; // 0.40, dest ATA creation

const utf8 = (s: string) => new TextEncoder().encode(s);

/** @solana/web3.js tags every request with a non-standard `solana-client`
 * header. In the browser that forces the CORS preflight to demand the RPC
 * allow `solana-client` in Access-Control-Allow-Headers — which most public
 * endpoints DON'T, so the request is blocked before it's sent. Strip the
 * header here so the preflight only asks for `content-type` (universally
 * allowed). Runs in place of the direct fetch; must call `next` to proceed. */
const stripSolanaClientHeader: FetchMiddleware = (info, init, next) => {
  const headers = init?.headers as Record<string, string> | undefined;
  if (headers) {
    delete headers['solana-client'];
    delete headers['Solana-Client'];
  }
  next(info, init);
};

/** Anchor instruction discriminator: sha256("global:<name>")[0..8]. */
const disc = (name: string) => sha256(utf8(`global:${name}`)).slice(0, 8);

function u64le(v: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, v), true);
  return b;
}
function i64le(v: number | bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, BigInt(v), true);
  return b;
}
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Associated token account (canonical per-owner-per-mint account). */
function ataOf(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()], ATA_PROGRAM)[0];
}

/** Decoded LockState account (see solana program: struct LockState). */
interface LockStateView {
  lockId: Uint8Array;
  mint: PublicKey;
  sender: PublicKey;
  recipient: PublicKey;
  rentPayer: PublicKey;
  amount: bigint;
  hashlock: string;   // hex
  timelock: number;
  relayFee: bigint;
  status: number;     // 0 open, 1 claimed, 2 refunded
  secret: string;     // hex, zeros until claimed
}

const STATE_SPAN = 8 + 251;             // discriminator + LockState::SIZE
const IMMUTABLE_SPAN = 8 + 210;         // everything before `status`

function decodeLockState(data: Uint8Array): LockStateView | null {
  if (data.length < STATE_SPAN) return null;
  const dv = new DataView(data.buffer, data.byteOffset);
  const hex = (from: number, len: number) =>
    Array.from(data.subarray(from, from + len)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const pk = (from: number) => new PublicKey(data.subarray(from, from + 32));
  return {
    lockId: data.subarray(8, 40),
    // bump 40, vaultBump 41 — client re-derives PDAs, no need to read them
    mint: pk(42),
    sender: pk(74),
    recipient: pk(106),
    rentPayer: pk(138),
    amount: dv.getBigUint64(170, true),
    hashlock: hex(178, 32),
    timelock: Number(dv.getBigInt64(210, true)),
    relayFee: dv.getBigUint64(218, true),
    status: data[226]!,
    secret: hex(227, 32),
  };
}

export class HtlcSolAdapter implements EvmAdapter {
  private readonly programId: PublicKey;
  private readonly mint: PublicKey;
  /** True for the sol:sol pair — the escrowed "token" is wrapped SOL. */
  private readonly isNative: boolean;
  /** One independent connection per RPC. Used two ways: `getLock` cross-checks
   * ALL of them for quorum; every other read/send goes through `viaRpc`, which
   * tries them in order so a single dead endpoint can't blank balances. */
  private readonly conns: Connection[];
  /** Back-compat alias for the quorum read in getLock. */
  private readonly verifiers: Connection[];

  constructor(
    private readonly cfg: SolNetworkConfig,
    private readonly pair: PairConfig,
    private readonly keypair: Keypair,
    private readonly relayerUrls: string[] = [],
  ) {
    if (!cfg.htlcProgram) throw new Error('Solana HTLC program not configured (Settings)');
    if (!pair.mint) throw new Error(`pair ${pair.key} has no mint configured`);
    if (!cfg.rpcs.length) throw new Error('no Solana RPCs configured');
    this.programId = new PublicKey(cfg.htlcProgram);
    this.mint = new PublicKey(pair.mint);
    this.isNative = this.mint.equals(NATIVE_MINT);
    this.conns = cfg.rpcs.map((u) => new Connection(u, {
      commitment: 'confirmed',
      fetchMiddleware: stripSolanaClientHeader,
    }));
    this.verifiers = this.conns;
  }

  /** Run a read/send against the configured RPCs in order, returning the first
   * success. A single endpoint that 403s, rate-limits, or times out just falls
   * through to the next — mirrors the EVM adapter's viem `fallback()`. */
  private async viaRpc<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    let lastError: unknown = new Error('no Solana RPCs reachable');
    for (const conn of this.conns) {
      try {
        return await fn(conn);
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  }

  address(): string {
    return this.keypair.publicKey.toBase58();
  }

  // ---------------------------------------------------------------- identity

  /** lock id = sha256 over the same six fields the program hashes; the lock
   * STATE PDA derived from it is what we hand around as the `lockId` string. */
  computeLockId(p: {
    sender: string; recipient: string; token: string;
    amount: bigint; hashlock: string; timelock: number;
  }): string {
    return this.lockPda(this.lockIdBytes(p)).toBase58();
  }

  private lockIdBytes(p: {
    sender: string; recipient: string; amount: bigint; hashlock: string; timelock: number;
  }): Uint8Array {
    return sha256(concatBytes(
      new PublicKey(p.sender).toBytes(),
      new PublicKey(p.recipient).toBytes(),
      this.mint.toBytes(),
      u64le(p.amount),
      hexToBytes(p.hashlock),
      i64le(p.timelock),
    ));
  }

  private lockPda(lockId: Uint8Array): PublicKey {
    return PublicKey.findProgramAddressSync([utf8('lock'), lockId], this.programId)[0];
  }

  private vaultPda(lockId: Uint8Array): PublicKey {
    return PublicKey.findProgramAddressSync([utf8('vault'), lockId], this.programId)[0];
  }

  // ------------------------------------------------------------------- lock

  async lock(p: { amount: bigint; hashlock: string; recipient: string; timelock: number }):
    Promise<{ lockId: string; txHash: string }> {
    const lockId = this.computeLockId({
      sender: this.address(), recipient: p.recipient, token: '',
      amount: p.amount, hashlock: p.hashlock, timelock: p.timelock,
    });
    try {
      const txHash = await this.relayedLock(p);
      return { lockId, txHash };
    } catch (e) {
      console.warn('relayed sol lock unavailable, falling back to self-submit:', (e as Error).message);
    }
    const txHash = await this.directLock(p);
    return { lockId, txHash };
  }

  private lockInstruction(p: {
    amount: bigint; hashlock: string; recipient: string; timelock: number;
    payer: PublicKey; lockFee: bigint;
  }): TransactionInstruction {
    const sender = this.keypair.publicKey;
    const relayFee = relayerFee(p.amount, CLAIM_FEE_BPS, this.pair.feeMinUnits);
    const lockId = this.lockIdBytes({
      sender: sender.toBase58(), recipient: p.recipient,
      amount: p.amount, hashlock: p.hashlock, timelock: p.timelock,
    });
    const relayed = !p.payer.equals(sender);
    const data = concatBytes(
      disc('lock'),
      lockId,
      new PublicKey(p.recipient).toBytes(),
      u64le(p.amount),
      hexToBytes(p.hashlock),
      i64le(p.timelock),
      u64le(relayFee),
      u64le(p.lockFee),
    );
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: sender, isSigner: true, isWritable: false },
        { pubkey: p.payer, isSigner: true, isWritable: true },
        { pubkey: this.mint, isSigner: false, isWritable: false },
        { pubkey: ataOf(sender, this.mint), isSigner: false, isWritable: true },
        // optional payer_token: Anchor's "None" convention is the program id
        relayed
          ? { pubkey: ataOf(p.payer, this.mint), isSigner: false, isWritable: true }
          : { pubkey: this.programId, isSigner: false, isWritable: false },
        { pubkey: this.lockPda(lockId), isSigner: false, isWritable: true },
        { pubkey: this.vaultPda(lockId), isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(data),
    });
  }

  /** sol:sol only: instructions that top up our wrapped-SOL account from
   * native lamports so `needed` wSOL is spendable — create the account if
   * missing (our own rent, we hold SOL by definition on this pair), move the
   * shortfall in, and syncNative so the token program sees it. */
  private async wrapIxs(needed: bigint): Promise<TransactionInstruction[]> {
    if (!this.isNative) return [];
    const self = this.keypair.publicKey;
    const ownAta = ataOf(self, this.mint);
    const info = await this.viaRpc((c) => c.getAccountInfo(ownAta, 'confirmed'));
    const wsolBal = info
      ? BigInt((await this.viaRpc((c) => c.getTokenAccountBalance(ownAta, 'confirmed'))).value.amount)
      : 0n;
    const shortfall = needed > wsolBal ? needed - wsolBal : 0n;
    const ixs: TransactionInstruction[] = [];
    if (!info) {
      ixs.push(new TransactionInstruction({ // createAssociatedTokenAccountIdempotent
        programId: ATA_PROGRAM,
        keys: [
          { pubkey: self, isSigner: true, isWritable: true },
          { pubkey: ownAta, isSigner: false, isWritable: true },
          { pubkey: self, isSigner: false, isWritable: false },
          { pubkey: this.mint, isSigner: false, isWritable: false },
          { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
      }));
    }
    if (shortfall > 0n) {
      ixs.push(SystemProgram.transfer({ fromPubkey: self, toPubkey: ownAta, lamports: shortfall }));
      ixs.push(new TransactionInstruction({ // syncNative
        programId: TOKEN_PROGRAM,
        keys: [{ pubkey: ownAta, isSigner: false, isWritable: true }],
        data: Buffer.from([17]),
      }));
    }
    return ixs;
  }

  /** Build the lock tx with the relayer as fee payer, partially sign it, and
   * hand it over for countersigning. The relayer can submit or decline —
   * never alter — because our ed25519 signature covers the whole message. */
  private async relayedLock(p: {
    amount: bigint; hashlock: string; recipient: string; timelock: number;
  }): Promise<string> {
    const feePayer = await this.relayerFeePayer();
    const lockFee = relayerFee(p.amount, LOCK_FEE_BPS, this.pair.feeMinUnits);
    const tx = new Transaction();
    for (const ix of await this.wrapIxs(p.amount + lockFee)) tx.add(ix);
    tx.add(this.lockInstruction({ ...p, payer: feePayer, lockFee }));
    tx.feePayer = feePayer;
    tx.recentBlockhash = (await this.viaRpc((c) => c.getLatestBlockhash('confirmed'))).blockhash;
    tx.partialSign(this.keypair);
    return this.postToRelayer({
      op: 'solLock',
      tx: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    });
  }

  /** Self-submit fallback (requires SOL for the tx fee + account rent). */
  private async directLock(p: {
    amount: bigint; hashlock: string; recipient: string; timelock: number;
  }): Promise<string> {
    const tx = new Transaction();
    for (const ix of await this.wrapIxs(p.amount)) tx.add(ix);
    tx.add(this.lockInstruction({ ...p, payer: this.keypair.publicKey, lockFee: 0n }));
    return this.signAndSend(tx);
  }

  // ----------------------------------------------------------- claim/refund

  /** Claim/refund need no signature from us: the relayer builds the whole tx
   * itself (the program pays it the in-lock relay fee for doing so). */
  async claim(lockId: string, secret: string): Promise<string> {
    try {
      return await this.postToRelayer({ op: 'solClaim', lockState: lockId, secret });
    } catch (e) {
      console.warn('relayed sol claim unavailable, self-submitting:', (e as Error).message);
    }
    return this.selfSettle(lockId, hexToBytes(secret));
  }

  async refund(lockId: string): Promise<string> {
    try {
      return await this.postToRelayer({ op: 'solRefund', lockState: lockId });
    } catch (e) {
      console.warn('relayed sol refund unavailable, self-submitting:', (e as Error).message);
    }
    return this.selfSettle(lockId, null);
  }

  /** Self-submitted claim (secret != null) or refund. We are the beneficiary,
   * so no relay fee is due and no fee account is passed. */
  private async selfSettle(lockId: string, secret: Uint8Array | null): Promise<string> {
    const info = await this.viaRpc((c) => c.getAccountInfo(new PublicKey(lockId), 'confirmed'));
    const s = info && decodeLockState(info.data);
    if (!s) throw new Error('lock not found on-chain');
    const beneficiary = secret ? s.recipient : s.sender;
    const data = secret ? concatBytes(disc('claim'), secret) : disc('refund');
    const tx = new Transaction();
    tx.add(new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: this.keypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: new PublicKey(lockId), isSigner: false, isWritable: true },
        { pubkey: this.vaultPda(s.lockId), isSigner: false, isWritable: true },
        { pubkey: s.mint, isSigner: false, isWritable: false },
        { pubkey: beneficiary, isSigner: false, isWritable: false },
        { pubkey: ataOf(beneficiary, s.mint), isSigner: false, isWritable: true },
        { pubkey: this.programId, isSigner: false, isWritable: false }, // no fee account
        { pubkey: s.rentPayer, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(data),
    }));
    return this.signAndSend(tx);
  }

  // ------------------------------------------------------------------ reads

  async getLock(lockId: string): Promise<EvmLockView | null> {
    const pda = new PublicKey(lockId);
    const reads = await Promise.allSettled(this.verifiers.map(async (conn) => {
      const info = await conn.getAccountInfo(pda, 'confirmed');
      return info ? decodeLockState(info.data) : null;
    }));
    const oks = reads.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (oks.length < Math.min(2, this.verifiers.length)) {
      throw new Error('not enough Solana RPCs reachable to verify lock');
    }
    const views = oks.filter((v): v is LockStateView => v !== null);
    if (views.length === 0) return null;
    // ALL RPCs that see the lock must agree on the immutable fields.
    const key = (v: LockStateView) => [
      v.mint.toBase58(), v.sender.toBase58(), v.recipient.toBase58(),
      v.amount, v.hashlock, v.timelock, v.relayFee,
    ].join('|');
    if (new Set(views.map(key)).size > 1) {
      throw new Error('Solana RPCs disagree about lock — refusing to proceed');
    }
    if (views.length < Math.min(2, this.verifiers.length)) return null; // quorum must SEE it
    const v = views[0]!;
    // status is monotonic (open -> claimed|refunded): trust the furthest RPC.
    const status = Math.max(...views.map((x) => x.status));
    // `finalized` visibility is the Solana analog of the EVM `safe` tag
    // (supermajority-rooted, ~13 s — not merely sequencer-confirmed). It gates
    // large swaps, so — like the immutable fields above — it must clear a
    // quorum: one RPC must not be able to fake finality and let the
    // counterparty commit against a lock that can still be rolled back.
    const finalReads = await Promise.allSettled(
      this.verifiers.map(async (conn) => (await conn.getAccountInfo(pda, 'finalized')) !== null),
    );
    const finalSeen = finalReads.filter((r) => r.status === 'fulfilled' && r.value).length;
    const safe = finalSeen >= Math.min(2, this.verifiers.length);
    // Age since WE first saw the lock (observation age, wall clock — used for
    // the small-swap "let it settle for a minute" policy).
    const seenKey = `bswap.sol.lockseen.${lockId}`;
    let firstSeen = Number(localStorage.getItem(seenKey) ?? '0');
    const now = Math.floor(Date.now() / 1000);
    if (!firstSeen) {
      firstSeen = now;
      localStorage.setItem(seenKey, String(firstSeen));
    }
    return {
      token: v.mint.toBase58(),
      sender: v.sender.toBase58(),
      recipient: v.recipient.toBase58(),
      amount: v.amount,
      hashlock: v.hashlock,
      timelock: v.timelock,
      relayFee: v.relayFee,
      claimed: status === 1,
      refunded: status === 2,
      safe,
      ageSecs: Math.max(0, now - firstSeen),
    };
  }

  /** The revealed secret straight from the lock's account state (the program
   * stores it on claim) — lets the seller recover even with no hint. */
  async revealedSecret(lockId: string): Promise<string | null> {
    const info = await this.viaRpc((c) => c.getAccountInfo(new PublicKey(lockId), 'confirmed'));
    const s = info && decodeLockState(info.data);
    return s && s.status === 1 ? s.secret : null;
  }

  // ------------------------------------------------------------ withdrawals

  /** Gasless withdrawal: build the SPL transfer (plus a fee transfer to the
   * relayer, plus the destination's token account if it doesn't exist yet),
   * partially sign, let the relayer countersign as fee payer. */
  async withdraw(to: string, amount: bigint): Promise<string> {
    let relayError: string;
    try {
      return await this.relayedWithdraw(to, amount);
    } catch (e) {
      relayError = (e as Error).message;
      console.warn('relayed sol withdrawal unavailable:', relayError);
    }
    const lamports = await this.viaRpc((c) => c.getBalance(this.keypair.publicKey)).catch(() => 0);
    if (lamports < MIN_SELF_SUBMIT_LAMPORTS) {
      throw new Error(`the relayer couldn't process your gasless withdrawal (${relayError}). Your funds are safe — try again in a moment, or ask the operator to check the relayer.`);
    }
    const tx = new Transaction();
    for (const ix of await this.withdrawInstructions(to, amount, this.keypair.publicKey, 0n)) tx.add(ix);
    return this.signAndSend(tx);
  }

  /** The fee a withdrawal to `to` will carry (bigger when the destination
   * needs its token account created — the relayer fronts that rent). Native
   * SOL withdrawals are plain transfers: flat fee, no token account ever. */
  async withdrawFee(to: string): Promise<bigint> {
    if (this.isNative) return this.pair.feeMinUnits;
    const destAta = ataOf(new PublicKey(to), this.mint);
    const exists = (await this.viaRpc((c) => c.getAccountInfo(destAta, 'confirmed'))) !== null;
    return exists ? SOL_WITHDRAW_FEE_UNITS : SOL_WITHDRAW_ATA_FEE_UNITS;
  }

  private async relayedWithdraw(to: string, amount: bigint): Promise<string> {
    const feePayer = await this.relayerFeePayer();
    const fee = await this.withdrawFee(to);
    const tx = new Transaction();
    for (const ix of await this.withdrawInstructions(to, amount, feePayer, fee)) tx.add(ix);
    tx.feePayer = feePayer;
    tx.recentBlockhash = (await this.viaRpc((c) => c.getLatestBlockhash('confirmed'))).blockhash;
    tx.partialSign(this.keypair);
    return this.postToRelayer({
      op: 'solWithdraw',
      tx: tx.serialize({ requireAllSignatures: false }).toString('base64'),
    });
  }

  private async withdrawInstructions(
    to: string, amount: bigint, payer: PublicKey, fee: bigint,
  ): Promise<TransactionInstruction[]> {
    const dest = new PublicKey(to);
    const self = this.keypair.publicKey;
    if (this.isNative) {
      // Native SOL: consolidate any wrapped balance back to lamports (closing
      // the wSOL account also recovers its rent), then plain transfers — the
      // destination needs no token account, ever.
      if (amount < MIN_NATIVE_WITHDRAW) {
        throw new Error('minimum SOL withdrawal is 0.001 (smaller transfers to new addresses fail on Solana)');
      }
      const ownWsol = ataOf(self, this.mint);
      const ixs: TransactionInstruction[] = [];
      if ((await this.viaRpc((c) => c.getAccountInfo(ownWsol, 'confirmed'))) !== null) {
        ixs.push(new TransactionInstruction({ // closeAccount: wSOL -> native
          programId: TOKEN_PROGRAM,
          keys: [
            { pubkey: ownWsol, isSigner: false, isWritable: true },
            { pubkey: self, isSigner: false, isWritable: true },
            { pubkey: self, isSigner: true, isWritable: false },
          ],
          data: Buffer.from([9]),
        }));
      }
      ixs.push(SystemProgram.transfer({ fromPubkey: self, toPubkey: dest, lamports: amount }));
      if (fee > 0n && !payer.equals(self)) {
        ixs.push(SystemProgram.transfer({ fromPubkey: self, toPubkey: payer, lamports: fee }));
      }
      return ixs;
    }
    const destAta = ataOf(dest, this.mint);
    const ownAta = ataOf(self, this.mint);
    const ixs: TransactionInstruction[] = [];
    if ((await this.viaRpc((c) => c.getAccountInfo(destAta, 'confirmed'))) === null) {
      ixs.push(new TransactionInstruction({ // createAssociatedTokenAccountIdempotent
        programId: ATA_PROGRAM,
        keys: [
          { pubkey: payer, isSigner: true, isWritable: true },
          { pubkey: destAta, isSigner: false, isWritable: true },
          { pubkey: dest, isSigner: false, isWritable: false },
          { pubkey: this.mint, isSigner: false, isWritable: false },
          { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
      }));
    }
    const transferChecked = (toAcc: PublicKey, units: bigint) =>
      new TransactionInstruction({
        programId: TOKEN_PROGRAM,
        keys: [
          { pubkey: ownAta, isSigner: false, isWritable: true },
          { pubkey: this.mint, isSigner: false, isWritable: false },
          { pubkey: toAcc, isSigner: false, isWritable: true },
          { pubkey: this.keypair.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from(concatBytes(new Uint8Array([12]), u64le(units), new Uint8Array([this.pair.tokenDecimals]))),
      });
    ixs.push(transferChecked(destAta, amount));
    if (fee > 0n && !payer.equals(this.keypair.publicKey)) {
      ixs.push(transferChecked(ataOf(payer, this.mint), fee));
    }
    return ixs;
  }

  // ---------------------------------------------------------------- plumbing

  private async signAndSend(tx: Transaction): Promise<string> {
    tx.feePayer = this.keypair.publicKey;
    tx.recentBlockhash = (await this.viaRpc((c) => c.getLatestBlockhash('confirmed'))).blockhash;
    tx.sign(this.keypair);
    const raw = tx.serialize();
    const sig = await this.viaRpc((c) => c.sendRawTransaction(raw, { maxRetries: 5 }));
    const conf = await this.viaRpc((c) => c.confirmTransaction(sig, 'confirmed'));
    if (conf.value.err) throw new Error(`tx failed: ${JSON.stringify(conf.value.err)}`);
    return sig;
  }

  /** The relayer's fee-payer pubkey (also where lock fees go, via its ATA). */
  private async relayerFeePayer(): Promise<PublicKey> {
    let lastError = 'no relayers configured';
    for (const url of this.relayerUrls) {
      try {
        const res = await fetch(`${url.replace(/\/$/, '')}/relay/sol`, { signal: AbortSignal.timeout(10_000) });
        const out = await res.json() as { ok: boolean; feePayer?: string; error?: string };
        if (out.ok && out.feePayer) return new PublicKey(out.feePayer);
        lastError = out.error ?? `relayer ${url} has no Solana fee payer`;
      } catch (e) {
        lastError = (e as Error).message;
      }
    }
    throw new Error(lastError);
  }

  private async postToRelayer(body: Record<string, unknown>): Promise<string> {
    let lastError = 'no relayers configured';
    for (const url of this.relayerUrls) {
      try {
        const res = await fetch(`${url.replace(/\/$/, '')}/relay/sol`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        const out = await res.json() as { ok: boolean; txHash?: string; error?: string };
        if (out.ok && out.txHash) return out.txHash;
        lastError = out.error ?? `relayer ${url} refused`;
      } catch (e) {
        lastError = (e as Error).message;
      }
    }
    throw new Error(lastError);
  }

  // ---- wallet view: balances ----

  async tokenBalance(): Promise<bigint> {
    const ata = ataOf(this.keypair.publicKey, this.mint);
    const info = await this.viaRpc((c) => c.getTokenAccountBalance(ata, 'confirmed')).catch(() => null);
    const wsol = info ? BigInt(info.value.amount) : 0n;
    if (!this.isNative) return wsol;
    // sol:sol trades NATIVE lamports + whatever is already wrapped (locks
    // wrap the shortfall automatically), minus a small reserve for the wSOL
    // account's rent so a max-size trade can't strand itself.
    const native = BigInt(await this.viaRpc((c) => c.getBalance(this.keypair.publicKey)));
    const total = native + wsol;
    return total > NATIVE_RESERVE ? total - NATIVE_RESERVE : 0n;
  }

  /** Native SOL balance (lamports) — the gas-money analog of ethBalance. */
  async solBalance(): Promise<bigint> {
    return BigInt(await this.viaRpc((c) => c.getBalance(this.keypair.publicKey)));
  }
}
