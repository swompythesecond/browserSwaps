// Devnet rehearsal for the bswap-htlc program: runs the full escrow
// lifecycle against LIVE devnet RPC with a throwaway mint, using the same
// hand-rolled instruction encodings as server/solRelayer.mjs and
// bots/maker.mjs (so it rehearses those byte layouts too, not just the
// program).
//
//   node scripts/sol-devnet-rehearsal.mjs
//
// Needs: solana/.devnet-deployer.json funded with ~0.5 SOL beyond program
// rent, and SOL_HTLC_PROGRAM below (or env) pointing at the devnet deploy.
//
// Flow: create 6dp test mint -> fund a sender -> (1) sender locks 1.0 token
// for recipient, deployer relays as fee payer and earns lock_fee ->
// (2) deployer claims with the secret as a third party, earning relay_fee,
// recipient ATA auto-created -> (3) second lock with a short timelock,
// refunded after expiry -> (4) reap both tombstones, rent returns.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.SOL_RPC || 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey(process.env.SOL_HTLC_PROGRAM || 'BgonehyDwfg8UtUKQW5TkYLAvFnJ47BRXu1TLYaDZ1dV');

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const sha256 = (b) => createHash('sha256').update(b).digest();
const disc = (n) => sha256(Buffer.from(`global:${n}`)).subarray(0, 8);
const le64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(v))); return b; };
const ataOf = (owner, mint) => PublicKey.findProgramAddressSync(
  [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const conn = new Connection(RPC, { commitment: 'confirmed' });
const deployer = Keypair.fromSecretKey(Uint8Array.from(
  JSON.parse(fs.readFileSync(path.join(here, '../solana/.devnet-deployer.json'), 'utf8'))));

const AMOUNT = 1_000_000n; // 1.0 token
const LOCK_FEE = 2_000n;
const RELAY_FEE = 2_000n;

// ------------------------------------------------------- SPL helpers (raw)

function ixCreateAta(payer, owner, mint) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataOf(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // idempotent
  });
}

async function createMint() {
  const mint = Keypair.generate();
  const rent = await conn.getMinimumBalanceForRentExemption(82);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: deployer.publicKey, newAccountPubkey: mint.publicKey,
      lamports: rent, space: 82, programId: TOKEN_PROGRAM,
    }),
    new TransactionInstruction({ // InitializeMint2: [20, decimals, authority, coption none]
      programId: TOKEN_PROGRAM,
      keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }],
      data: Buffer.concat([Buffer.from([20, 6]), deployer.publicKey.toBuffer(), Buffer.from([0])]),
    }),
  );
  await sendAndConfirmTransaction(conn, tx, [deployer, mint], { commitment: 'confirmed' });
  return mint.publicKey;
}

function ixMintTo(mint, destAta, amount) {
  return new TransactionInstruction({ // MintTo: [7, u64]
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([7]), le64(amount)]),
  });
}

async function tokenBal(ata) {
  const b = await conn.getTokenAccountBalance(ata, 'confirmed').catch(() => null);
  return b ? BigInt(b.value.amount) : 0n;
}

// ----------------------------------------------------- HTLC ix construction

function lockIdFor(sender, recipient, mint, amount, hashlock, timelock) {
  return sha256(Buffer.concat([
    sender.toBuffer(), recipient.toBuffer(), mint.toBuffer(),
    le64(amount), hashlock, le64(timelock),
  ]));
}
const lockPda = (id) => PublicKey.findProgramAddressSync([Buffer.from('lock'), id], PROGRAM_ID)[0];
const vaultPda = (id) => PublicKey.findProgramAddressSync([Buffer.from('vault'), id], PROGRAM_ID)[0];

function ixLock({ sender, payer, mint, recipient, amount, hashlock, timelock, relayFee, lockFee }) {
  const id = lockIdFor(sender, recipient, mint, amount, hashlock, timelock);
  const relayed = !payer.equals(sender);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: sender, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: ataOf(sender, mint), isSigner: false, isWritable: true },
      relayed
        ? { pubkey: ataOf(payer, mint), isSigner: false, isWritable: true }
        : { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: lockPda(id), isSigner: false, isWritable: true },
      { pubkey: vaultPda(id), isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      disc('lock'), id, recipient.toBuffer(), le64(amount), hashlock, le64(timelock),
      le64(relayFee), le64(lockFee),
    ]),
  });
}

function ixSettle({ submitter, lockState, lockId, mint, beneficiary, rentPayer, secret }) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: submitter, isSigner: true, isWritable: true },
      { pubkey: lockState, isSigner: false, isWritable: true },
      { pubkey: vaultPda(lockId), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: beneficiary, isSigner: false, isWritable: false },
      { pubkey: ataOf(beneficiary, mint), isSigner: false, isWritable: true },
      { pubkey: ataOf(submitter, mint), isSigner: false, isWritable: true },
      { pubkey: rentPayer, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: secret ? Buffer.concat([disc('claim'), secret]) : Buffer.from(disc('refund')),
  });
}

function ixReap(lockState, rentPayer) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: lockState, isSigner: false, isWritable: true },
      { pubkey: rentPayer, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(disc('reap')),
  });
}

const send = (tx, signers) => sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' });

// ------------------------------------------------------------------- main

const assert = (cond, what) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${what}`);
  console.log(`  ✓ ${what}`);
};

console.log(`devnet rehearsal against ${PROGRAM_ID.toBase58()} via ${RPC}`);
console.log(`deployer ${deployer.publicKey.toBase58()}: ${(await conn.getBalance(deployer.publicKey)) / 1e9} SOL`);

// Actors: deployer doubles as the relayer/fee payer; sender + recipient are
// throwaways funded from it.
const sender = Keypair.generate();
const recipient = Keypair.generate();
console.log(`sender ${sender.publicKey.toBase58()}, recipient ${recipient.publicKey.toBase58()}`);

console.log('\n[setup] mint + funding');
const mint = await createMint();
console.log(`  test mint: ${mint.toBase58()}`);
await send(new Transaction().add(
  SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: sender.publicKey, lamports: 30_000_000 }),
  ixCreateAta(deployer.publicKey, sender.publicKey, mint),
  ixCreateAta(deployer.publicKey, deployer.publicKey, mint),
  ixMintTo(mint, ataOf(sender.publicKey, mint), 10_000_000n),
), [deployer]);
console.log('  sender funded with 10.0 tokens + 0.03 SOL');

// ---- 1. relayed lock: sender signs, deployer is fee payer + earns lock_fee
console.log('\n[1] relayed lock');
const secret = randomBytes(32);
const hashlock = sha256(secret);
const timelock1 = Math.floor(Date.now() / 1000) + 3600;
const id1 = lockIdFor(sender.publicKey, recipient.publicKey, mint, AMOUNT, hashlock, timelock1);
const relayerTokBefore = await tokenBal(ataOf(deployer.publicKey, mint));
await send(new Transaction().add(ixLock({
  sender: sender.publicKey, payer: deployer.publicKey, mint, recipient: recipient.publicKey,
  amount: AMOUNT, hashlock, timelock: timelock1, relayFee: RELAY_FEE, lockFee: LOCK_FEE,
})), [deployer, sender]);
assert(await tokenBal(vaultPda(id1)) === AMOUNT, 'vault escrows 1.0 token');
assert(await tokenBal(ataOf(deployer.publicKey, mint)) === relayerTokBefore + LOCK_FEE, 'relayer earned lock_fee');

// ---- 2. third-party claim: deployer submits with the secret, earns relay_fee
console.log('\n[2] relayed claim (recipient ATA auto-created)');
await send(new Transaction().add(ixSettle({
  submitter: deployer.publicKey, lockState: lockPda(id1), lockId: id1, mint,
  beneficiary: recipient.publicKey, rentPayer: deployer.publicKey, secret,
})), [deployer]);
assert(await tokenBal(ataOf(recipient.publicKey, mint)) === AMOUNT - RELAY_FEE, 'recipient got amount minus relay_fee');
const state1 = await conn.getAccountInfo(lockPda(id1), 'confirmed');
assert(state1 !== null && state1.data[226] === 1, 'lock state = Claimed');
assert(Buffer.from(state1.data.subarray(227, 259)).equals(secret), 'revealed secret readable from state');
assert(await conn.getAccountInfo(vaultPda(id1), 'confirmed') === null, 'vault closed, rent returned');

// ---- 3. short-timelock lock, then refund after expiry
console.log('\n[3] lock + refund after timelock (waits ~30s)');
const hashlock2 = sha256(randomBytes(32));
const timelock2 = Math.floor(Date.now() / 1000) + 20;
const id2 = lockIdFor(sender.publicKey, recipient.publicKey, mint, AMOUNT, hashlock2, timelock2);
await send(new Transaction().add(ixLock({
  sender: sender.publicKey, payer: deployer.publicKey, mint, recipient: recipient.publicKey,
  amount: AMOUNT, hashlock: hashlock2, timelock: timelock2, relayFee: RELAY_FEE, lockFee: LOCK_FEE,
})), [deployer, sender]);
const senderBefore = await tokenBal(ataOf(sender.publicKey, mint));
await sleep(30_000); // let the chain clock pass the timelock
await send(new Transaction().add(ixSettle({
  submitter: deployer.publicKey, lockState: lockPda(id2), lockId: id2, mint,
  beneficiary: sender.publicKey, rentPayer: deployer.publicKey, secret: null,
})), [deployer]);
assert(await tokenBal(ataOf(sender.publicKey, mint)) === senderBefore + AMOUNT - RELAY_FEE, 'sender refunded minus relay_fee');

// ---- 4. reap both tombstones (id1's timelock is 1h out — expect rejection;
//         id2's has passed — expect rent back)
console.log('\n[4] reap');
let earlyReapRejected = false;
try {
  await send(new Transaction().add(ixReap(lockPda(id1), deployer.publicKey)), [deployer]);
} catch { earlyReapRejected = true; }
assert(earlyReapRejected, 'reap before timelock rejected');
const lamportsBefore = await conn.getBalance(deployer.publicKey);
await send(new Transaction().add(ixReap(lockPda(id2), deployer.publicKey)), [deployer]);
assert(await conn.getAccountInfo(lockPda(id2), 'confirmed') === null, 'settled lock reaped');
assert(await conn.getBalance(deployer.publicKey) > lamportsBefore, 'rent returned to payer');

console.log(`\nALL CHECKS PASSED — deployer balance: ${(await conn.getBalance(deployer.publicKey)) / 1e9} SOL`);
