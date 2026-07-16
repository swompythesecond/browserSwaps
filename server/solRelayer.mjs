// BrowserSwaps Solana relayer module — the "gas station" for the bswap-htlc
// program (solana/programs/bswap-htlc), sibling of the EVM relayer.
//
// Two kinds of work:
//   - Co-signing (solLock, solWithdraw): the user builds and PARTIALLY SIGNS
//     the transaction with us as fee payer; we validate it strictly,
//     countersign, and submit. The user's ed25519 signature binds every
//     parameter, so we can submit-or-decline, never alter.
//   - Building (solClaim, solRefund): those instructions need no signature
//     from the user at all (the program fixes the beneficiary), so we build
//     the whole transaction ourselves and earn the in-lock relay fee.
//
// SECURITY — the fee-payer drain problem. Whatever we countersign executes
// with OUR signature on it. A malicious "user" transaction could otherwise
// include instructions that spend our SOL (system transfer), move our token
// balances (we'd be signing as the token owner!), or invoke arbitrary
// programs with us as a signer. Rules enforced here, in this order:
//   1. The fee payer must be exactly our key.
//   2. Every signature already on the tx must verify (nothing forged).
//   3. Only whitelisted instruction shapes are allowed (the HTLC lock, the
//      SPL transferChecked, the idempotent ATA create) — nothing else, and
//      our key must never appear as a required signer inside any instruction
//      except the two slots where paying is the point (lock fee payer /
//      ATA rent funder), each of which must be paid for in tokens.
//   4. The transaction must simulate cleanly before we sign it.
//
// Economics: a relayed op costs ~5000 lamports of fees (plus ~0.003 SOL of
// rent fronted per lock, returned when the lock is reaped) and earns the fee
// embedded in the op. SOL drains, tokens accumulate; the status endpoint
// shows balances. TODO: Jupiter USDC->SOL auto-refill, mirroring the EVM
// relayer's USDT->ETH refill.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
} from '@solana/web3.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');

const sha256 = (buf) => createHash('sha256').update(buf).digest();
const ixDisc = (name) => sha256(Buffer.from(`global:${name}`)).subarray(0, 8);

// Real client IP for rate limiting (same logic as server/relayer.mjs: trust
// X-Forwarded-For's rightmost hop only when the peer is our loopback proxy).
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function clientIp(req) {
  const peer = req.socket.remoteAddress ?? '?';
  if (LOOPBACK.has(peer)) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const hops = String(xff).split(',');
      return hops[hops.length - 1].trim() || peer;
    }
  }
  return peer;
}

function ataOf(owner, mint) {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()], ATA_PROGRAM)[0];
}

/** Decode a LockState account (must mirror solana program + src/sol adapter). */
function decodeLockState(data) {
  if (!data || data.length < 8 + 251) return null;
  const dv = new DataView(data.buffer, data.byteOffset);
  return {
    lockId: data.subarray(8, 40),
    mint: new PublicKey(data.subarray(42, 74)),
    sender: new PublicKey(data.subarray(74, 106)),
    recipient: new PublicKey(data.subarray(106, 138)),
    rentPayer: new PublicKey(data.subarray(138, 170)),
    amount: dv.getBigUint64(170, true),
    timelock: Number(dv.getBigInt64(210, true)),
    relayFee: dv.getBigUint64(218, true),
    status: data[226],
  };
}

function loadDotEnv() {
  try {
    return Object.fromEntries(
      fs.readFileSync(path.join(here, '../.env'), 'utf8')
        .split(/\r?\n/).filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    );
  } catch {
    return {};
  }
}

function json(res, code, body, cors) {
  res.writeHead(code, { 'content-type': 'application/json', ...cors });
  res.end(JSON.stringify(body));
}

/**
 * Returns the Solana relayer route handler, or null when no key/program is
 * configured (the combined server then runs without Solana relaying).
 */
export function createSolRelayer() {
  const dotenv = loadDotEnv();
  const RPC = process.env.SOL_RPC || dotenv.SOL_RPC || 'https://api.mainnet-beta.solana.com';
  const programStr = process.env.SOL_HTLC_PROGRAM || dotenv.SOL_HTLC_PROGRAM || '';
  const keyHex = process.env.SOL_RELAYER_KEY || dotenv.SOL_RELAYER_KEY || '';
  if (!programStr || !/^[0-9a-f]{128}$/.test(keyHex)) return null;

  const PROGRAM_ID = new PublicKey(programStr);
  const keypair = Keypair.fromSecretKey(Buffer.from(keyHex, 'hex'));
  const conn = new Connection(RPC, { commitment: 'confirmed' });

  const WSOL = 'So11111111111111111111111111111111111111112';
  /** Minimum fee an op must pay us, PER MINT (units are mint-specific:
   * 6 decimals for the stables, 9 for wrapped SOL). */
  const MIN_FEE_BY_MINT = new Map([
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 20_000n],  // 0.02 USDC
    ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 20_000n],  // 0.02 USDT
    [WSOL, 100_000n],                                            // 0.0001 SOL
  ]);
  /** Minimum fee when we must front rent for a new token account (~0.002 SOL). */
  const ATA_FEE_BY_MINT = new Map([
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 350_000n],   // 0.35 USDC
    ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 350_000n],   // 0.35 USDT
    [WSOL, 3_000_000n],                                            // 0.003 SOL
  ]);
  const minFeeFor = (mint) => MIN_FEE_BY_MINT.get(mint.toBase58?.() ?? String(mint));
  /** SPL mints we accept fees in (stables + wrapped SOL on mainnet). */
  const MINTS = new Set((process.env.SOL_MINTS || dotenv.SOL_MINTS
    || `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB,${WSOL}`)
    .split(',').map((m) => m.trim()).filter(Boolean));

  console.log(`[sol-relayer] program: ${PROGRAM_ID.toBase58()}, fee payer: ${keypair.publicKey.toBase58()}`);

  let relayed = 0;
  let rejected = 0;

  const LOCK_DISC = ixDisc('lock');
  const CLAIM_DISC = ixDisc('claim');
  const REFUND_DISC = ixDisc('refund');

  // ------------------------------------------------------------ validation

  /** Deserialize a base64 co-sign request and run the common checks:
   * fee payer is us, all present signatures verify. */
  function parseCosign(txB64) {
    const tx = Transaction.from(Buffer.from(txB64, 'base64'));
    if (!tx.feePayer || !tx.feePayer.equals(keypair.publicKey)) {
      throw new Error('fee payer is not this relayer');
    }
    // Reject forged/absent user signatures up front (our co-signature must be
    // the only missing one, and everything present must verify).
    if (!tx.verifySignatures(false)) throw new Error('bad signature on transaction');
    const missing = tx.signatures.filter((s) => s.signature === null);
    if (missing.length !== 1 || !missing[0].publicKey.equals(keypair.publicKey)) {
      throw new Error('exactly the relayer signature must be missing');
    }
    return tx;
  }

  /** Our key must never be a required signer inside an instruction (we sign
   * the tx as fee payer — that signature satisfies EVERY isSigner slot naming
   * us, which is exactly how a malicious tx would spend our balances). */
  function assertNotInnerSigner(ix, allowedSignerIndexes = []) {
    ix.keys.forEach((k, i) => {
      if (k.isSigner && k.pubkey.equals(keypair.publicKey) && !allowedSignerIndexes.includes(i)) {
        throw new Error('transaction tries to use the relayer as a signer');
      }
    });
  }

  /** A wrap-prefix instruction allowed ahead of a lock on the sol:sol pair:
   * the user funding their OWN wrapped-SOL account. Never lets our key sign. */
  function assertWrapIx(ix) {
    if (ix.programId.equals(ATA_PROGRAM)) {
      const data = Buffer.from(ix.data);
      if (data.length !== 1 || data[0] !== 1) throw new Error('only idempotent ATA creation allowed');
      if (ix.keys.length < 6 || !MINTS.has(ix.keys[3].pubkey.toBase58())) throw new Error('bad ATA instruction');
      assertNotInnerSigner(ix); // the user pays their own rent on locks
      return;
    }
    if (ix.programId.equals(SYSTEM_PROGRAM)) {
      // SystemProgram.transfer (tag 2): the sender must sign, so the
      // inner-signer rule alone guarantees it can't move OUR lamports.
      const data = Buffer.from(ix.data);
      if (data.length !== 12 || data.readUInt32LE(0) !== 2) throw new Error('only plain transfers allowed');
      assertNotInnerSigner(ix);
      return;
    }
    if (ix.programId.equals(TOKEN_PROGRAM)) {
      const data = Buffer.from(ix.data);
      if (data.length !== 1 || data[0] !== 17) throw new Error('only syncNative allowed here'); // syncNative
      return;
    }
    throw new Error('instruction program not allowed before a lock');
  }

  /** Whitelist check for a lock co-sign: the LAST instruction is the lock
   * (our program, allowed mint, our fee ATA, fee >= the mint's minimum); up
   * to three wrap-prefix instructions may precede it (sol:sol wrapping). */
  function validateLockTx(tx) {
    if (tx.instructions.length < 1 || tx.instructions.length > 4) {
      throw new Error('lock tx must have 1-4 instructions');
    }
    for (const pre of tx.instructions.slice(0, -1)) assertWrapIx(pre);
    const ix = tx.instructions[tx.instructions.length - 1];
    if (!ix.programId.equals(PROGRAM_ID)) throw new Error('not the HTLC program');
    const data = Buffer.from(ix.data);
    if (data.length !== 8 + 32 + 32 + 8 + 32 + 8 + 8 + 8 || !data.subarray(0, 8).equals(LOCK_DISC)) {
      throw new Error('not a lock instruction');
    }
    // LockAccounts order: sender, payer, mint, sender_token, payer_token,
    // lock_state, vault, token_program, system_program
    if (ix.keys.length !== 9) throw new Error('unexpected lock account count');
    if (!ix.keys[1].pubkey.equals(keypair.publicKey)) throw new Error('lock payer is not this relayer');
    assertNotInnerSigner(ix, [1]); // payer slot is the point of relaying
    const mint = ix.keys[2].pubkey;
    if (!MINTS.has(mint.toBase58())) throw new Error('mint not accepted by this relayer');
    if (!ix.keys[4].pubkey.equals(ataOf(keypair.publicKey, mint))) {
      throw new Error('lock fee must go to the relayer token account');
    }
    const lockFee = data.readBigUInt64LE(data.length - 8);
    const minFee = minFeeFor(mint);
    if (lockFee < minFee) throw new Error(`fee below relayer minimum (${minFee} units)`);
  }

  /** Whitelist check for a withdrawal co-sign. Stable withdrawals are SPL
   * transferChecked (+ optional ATA create we pay rent for); native SOL
   * withdrawals are plain system transfers, optionally preceded by the user
   * closing their own wrapped-SOL account (unwrap). Nothing may use our
   * authority, and a fee — in tokens to our ATA or lamports to our key —
   * must cover what the tx costs us (more when we front rent). */
  function validateWithdrawTx(tx) {
    if (tx.instructions.length < 1 || tx.instructions.length > 3) {
      throw new Error('withdrawal tx must have 1-3 instructions');
    }
    let ataFeeRequired = null; // set when WE fund an ATA (in that mint's units)
    let tokenFeePaid = 0n;
    let tokenFeeMint = null;
    let lamportsFeePaid = 0n;
    for (const ix of tx.instructions) {
      if (ix.programId.equals(ATA_PROGRAM)) {
        // createAssociatedTokenAccountIdempotent: [funder s w, ata, owner, mint, system, token]
        const data = Buffer.from(ix.data);
        if (data.length !== 1 || data[0] !== 1) throw new Error('only idempotent ATA creation allowed');
        if (ix.keys.length < 6) throw new Error('bad ATA instruction');
        const mint = ix.keys[3].pubkey;
        if (!MINTS.has(mint.toBase58())) throw new Error('mint not accepted by this relayer');
        if (ix.keys[0].pubkey.equals(keypair.publicKey)) ataFeeRequired = ATA_FEE_BY_MINT.get(mint.toBase58());
        assertNotInnerSigner(ix, ix.keys[0].pubkey.equals(keypair.publicKey) ? [0] : []);
      } else if (ix.programId.equals(TOKEN_PROGRAM)) {
        const data = Buffer.from(ix.data);
        if (data.length === 10 && data[0] === 12) {
          // transferChecked: [12, u64 amount, u8 decimals], keys [src w, mint, dst w, owner s]
          if (ix.keys.length < 4) throw new Error('bad transfer instruction');
          assertNotInnerSigner(ix); // never move tokens with OUR authority
          const mint = ix.keys[1].pubkey;
          if (!MINTS.has(mint.toBase58())) throw new Error('mint not accepted by this relayer');
          if (ix.keys[2].pubkey.equals(ataOf(keypair.publicKey, mint))) {
            tokenFeePaid += data.readBigUInt64LE(1);
            tokenFeeMint = mint;
          }
        } else if (data.length === 1 && data[0] === 9) {
          // closeAccount (unwrap): keys [account w, destination w, owner s].
          // The owner must sign, so the inner-signer rule blocks closing OURS.
          assertNotInnerSigner(ix);
        } else {
          throw new Error('only transferChecked/closeAccount allowed');
        }
      } else if (ix.programId.equals(SYSTEM_PROGRAM)) {
        // SystemProgram.transfer (tag 2): sender signs, so it can't be us.
        const data = Buffer.from(ix.data);
        if (data.length !== 12 || data.readUInt32LE(0) !== 2) throw new Error('only plain transfers allowed');
        assertNotInnerSigner(ix);
        if (ix.keys.length >= 2 && ix.keys[1].pubkey.equals(keypair.publicKey)) {
          lamportsFeePaid += data.readBigUInt64LE(4);
        }
      } else {
        throw new Error('instruction program not allowed');
      }
    }
    if (ataFeeRequired !== null) {
      // We're fronting rent: the fee must arrive in that same mint and cover it.
      if (tokenFeePaid < ataFeeRequired) throw new Error(`fee below relayer minimum (${ataFeeRequired} units, covers new token account rent)`);
      return;
    }
    const tokenOk = tokenFeeMint !== null && tokenFeePaid >= minFeeFor(tokenFeeMint);
    const lamportsOk = lamportsFeePaid >= MIN_FEE_BY_MINT.get(WSOL);
    if (!tokenOk && !lamportsOk) throw new Error('fee below relayer minimum');
  }

  // -------------------------------------------------------------- submission

  async function simulateAndSend(tx) {
    tx.partialSign(keypair);
    const raw = tx.serialize();
    const sim = await conn.simulateTransaction(tx);
    if (sim.value.err) {
      throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`);
    }
    const sig = await conn.sendRawTransaction(raw, { maxRetries: 5 });
    const conf = await conn.confirmTransaction(sig, 'confirmed');
    if (conf.value.err) throw new Error(`tx failed: ${JSON.stringify(conf.value.err)}`);
    relayed++;
    return sig;
  }

  /** Build and submit a claim (secretHex set) or refund for a lock, with us
   * as the fee-earning submitter. */
  async function settle(lockStateStr, secretHex) {
    const lockState = new PublicKey(lockStateStr);
    const info = await conn.getAccountInfo(lockState, 'confirmed');
    const s = info && decodeLockState(info.data);
    if (!s) throw new Error('unknown lock');
    if (s.status !== 0) throw new Error('lock already closed');
    if (!MINTS.has(s.mint.toBase58())) throw new Error('mint not accepted by this relayer');
    const minFee = minFeeFor(s.mint);
    if (s.relayFee < minFee) throw new Error(`fee below relayer minimum (${minFee} units)`);
    const beneficiary = secretHex ? s.recipient : s.sender;
    if (!secretHex && Date.now() / 1000 < s.timelock) throw new Error('timelock not reached');
    const vault = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), s.lockId], PROGRAM_ID)[0];
    const data = secretHex
      ? Buffer.concat([CLAIM_DISC, Buffer.from(secretHex, 'hex')])
      : Buffer.from(REFUND_DISC);
    if (secretHex && data.length !== 40) throw new Error('secret must be 32 bytes hex');
    const tx = new Transaction();
    tx.add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: lockState, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: s.mint, isSigner: false, isWritable: false },
        { pubkey: beneficiary, isSigner: false, isWritable: false },
        { pubkey: ataOf(beneficiary, s.mint), isSigner: false, isWritable: true },
        { pubkey: ataOf(keypair.publicKey, s.mint), isSigner: false, isWritable: true },
        { pubkey: s.rentPayer, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      ],
      data,
    }));
    tx.feePayer = keypair.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    return simulateAndSend(tx);
  }

  async function handleOp(op, body) {
    switch (op) {
      case 'solLock': {
        const tx = parseCosign(body.tx);
        validateLockTx(tx);
        return simulateAndSend(tx);
      }
      case 'solWithdraw': {
        const tx = parseCosign(body.tx);
        validateWithdrawTx(tx);
        return simulateAndSend(tx);
      }
      case 'solClaim': {
        if (!/^[0-9a-f]{64}$/.test(body.secret ?? '')) throw new Error('bad secret');
        return settle(body.lockState, body.secret);
      }
      case 'solRefund':
        return settle(body.lockState, null);
      default:
        throw new Error('unknown op');
    }
  }

  // naive per-IP rate limit, same policy as the EVM relayer
  const hits = new Map();
  function rateLimited(ip) {
    const now = Date.now();
    const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    arr.push(now);
    hits.set(ip, arr);
    return arr.length > 30;
  }

  return {
    address: keypair.publicKey.toBase58(),

    async status() {
      const lamports = await conn.getBalance(keypair.publicKey).catch(() => 0);
      return {
        feePayer: keypair.publicKey.toBase58(),
        solBalance: (lamports / 1e9).toFixed(4),
        program: PROGRAM_ID.toBase58(),
        minFeeUnits: Object.fromEntries([...MIN_FEE_BY_MINT].map(([m, v]) => [m, v.toString()])),
        relayed, rejected,
        lowGas: lamports < 20_000_000, // < 0.02 SOL: top me up
      };
    },

    /** Returns true if this module owns the route (response will be sent). */
    handle(req, res, url, cors) {
      if (url.pathname !== '/relay/sol') return false;
      if (req.method === 'GET') {
        json(res, 200, { ok: true, feePayer: keypair.publicKey.toBase58() }, cors);
        return true;
      }
      if (req.method !== 'POST') { res.writeHead(404, cors); res.end(); return true; }
      if (rateLimited(clientIp(req))) { res.writeHead(429, cors); res.end('rate limited'); return true; }
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 100_000) req.destroy(); });
      req.on('end', () => {
        void (async () => {
          try {
            const body = JSON.parse(raw);
            const sig = await handleOp(body.op, body);
            json(res, 200, { ok: true, txHash: sig }, cors);
            console.log(new Date().toISOString(), 'sol-relayed', body.op, sig);
          } catch (e) {
            rejected++;
            json(res, 400, { ok: false, error: e.message }, cors);
            console.log(new Date().toISOString(), 'sol-rejected:', e.message);
          }
        })();
      });
      return true;
    },
  };
}
