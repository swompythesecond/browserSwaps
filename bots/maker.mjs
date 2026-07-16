/**
 * BrowserSwaps reference MAKER bot — a headless, 24/7 seller.
 *
 * Runs the same seller role a browser tab plays, with no UI: it keeps a
 * sell-BRC offer live on the market server, and when a buyer takes it, it
 * verifies the buyer's USDT lock on Arbitrum, locks BRC on the BrowserCoin
 * chain, waits for the buyer to reveal the swap secret, and claims the USDT.
 *
 * Trust model is identical to the app: the market server only relays
 * metadata, and every value-bearing step is verified against chain data
 * (Arbitrum RPCs + the BrowserCoin REST API). The bot never hands funds to
 * anyone it has to trust.
 *
 * ⚠ This is a REFERENCE implementation. Test it against Arbitrum Sepolia / a
 * throwaway wallet with tiny amounts before running it with real value.
 *
 * Run:
 *   npm run bot:maker         (or: npx tsx bots/maker.mjs)
 * Configure via environment — see bots/README.md.
 *
 * BrowserCoin modules (from the `browsercoin` dependency) are imported for
 * correct BRC transaction/script encoding:
 */
import { fromPrivateKey, sign } from 'browsercoin/src/crypto/keys.js';
import { sha256 } from 'browsercoin/src/crypto/hash.js';
import {
  signLock, txHash, encodeTx, isRedeem,
} from 'browsercoin/src/chain/transaction.js';
import { decodeBlock } from 'browsercoin/src/chain/block.js';
import { htlcScript } from 'browsercoin/src/chain/scriptBuild.js';
import { scriptHash as scriptHashOf } from 'browsercoin/src/chain/script.js';
import { createPublicClient, http, keccak256, encodeAbiParameters } from 'viem';
import { arbitrum } from 'viem/chains';
import { Connection, PublicKey } from '@solana/web3.js';
// Canonical market math — the SAME modules the app uses (this bot runs under
// tsx, which resolves the .ts sources), so price rounding and the trade
// minimum can never drift out of sync with real takers.
import { tokenForBrc as canonicalTokenForBrc, minBrcForFill } from '../src/market/protocol.js';
import { PAIRS } from '../src/config.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- config
const SOL_MINTS = {
  'sol:usdc': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'sol:usdt': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'sol:sol': 'So11111111111111111111111111111111111111112', // wrapped SOL
};

const cfg = {
  market: process.env.MARKET_URL || 'http://localhost:9250',
  relayer: process.env.RELAYER_URL || 'http://localhost:9250',
  brcApi: process.env.BRC_API_URL || 'https://api1.browsercoin.org',
  /** Trading pair: 'arb:usdt' (default), 'sol:usdc' or 'sol:usdt'. */
  pair: process.env.PAIR || 'arb:usdt',
  rpc: process.env.ARB_RPC || 'https://arb1.arbitrum.io/rpc',
  htlc: (process.env.HTLC_ADDRESS || '0xd9a5db57c4fc3b08381f0cd1816769eaed13ead7').toLowerCase(),
  token: (process.env.TOKEN_ADDRESS || '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9').toLowerCase(),
  solRpc: process.env.SOL_RPC || 'https://api.mainnet-beta.solana.com',
  solProgram: process.env.SOL_HTLC_PROGRAM || '',
  solMint: process.env.SOL_MINT || '',      // defaults from the pair below
  solAddress: process.env.SOL_ADDRESS || '', // where you receive USDC/USDT on Solana
  brcKeyHex: process.env.BRC_PRIVATE_KEY,   // 64 hex chars
  evmAddress: process.env.EVM_ADDRESS,      // where you receive USDT on Arbitrum
  amountBrc: BigInt(process.env.AMOUNT_BRC || '10000000000'), // 100 BRC (1e-8 units)
  amountToken: BigInt(process.env.AMOUNT_TOKEN || '1000000'), // 1 USDT (1e-6 units)
  /** Smallest slice a taker may fill (1e-8 units); 0 = any partial,
   * AMOUNT_BRC = all-or-nothing. */
  minFillBrc: BigInt(process.env.MIN_FILL_BRC || '0'),
};
const onSol = cfg.pair.startsWith('sol:');
if (!cfg.brcKeyHex || !/^[0-9a-f]{64}$/i.test(cfg.brcKeyHex)) throw new Error('set BRC_PRIVATE_KEY (64 hex)');
if (!onSol && !/^0x[0-9a-fA-F]{40}$/.test(cfg.evmAddress || '')) throw new Error('set EVM_ADDRESS (0x…)');
if (onSol) {
  if (!cfg.solMint) cfg.solMint = SOL_MINTS[cfg.pair] ?? '';
  if (!cfg.solMint) throw new Error(`unknown pair ${cfg.pair} — set SOL_MINT`);
  if (!cfg.solProgram) throw new Error('set SOL_HTLC_PROGRAM (base58 program id)');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cfg.solAddress)) throw new Error('set SOL_ADDRESS (base58)');
}
const solConn = onSol ? new Connection(cfg.solRpc, { commitment: 'confirmed' }) : null;

const HTLC_ABI = JSON.parse(fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/evm/htlc.artifact.json'), 'utf8')).abi;

const wallet = fromPrivateKey(hexToBytes(cfg.brcKeyHex));
const evm = createPublicClient({ chain: arbitrum, transport: http(cfg.rpc) });

// market identity: mailbox id = sha256(secret market key).slice(20)
const marketKey = process.env.MARKET_KEY || bytesToHex(fromPrivateKey(hexToBytes(cfg.brcKeyHex)).privateKey);
const myBox = createHash('sha256').update(marketKey).digest('hex').slice(0, 20);

const OFFER_ID = 'bot-' + myBox.slice(0, 8);
const swaps = new Map(); // hashlock -> swap state
let remainingBrc = cfg.amountBrc; // partial fills eat into this

/** This offer's price definition, in the shape the canonical math expects. */
const OFFER_PRICE = { side: 'sell-brc', amountBrc: cfg.amountBrc.toString(), amountToken: cfg.amountToken.toString() };
const tokenForBrc = (brcPart) => canonicalTokenForBrc(OFFER_PRICE, brcPart);
// Effective minimum fill: our configured min or the platform floor, clamped
// so the remainder can always be taken whole.
/** The pair's platform-wide minimum trade size (token units). */
const MIN_TRADE_TOKEN = PAIRS[cfg.pair]?.minTradeUnits ?? 300_000n;
const FLOOR_BRC = minBrcForFill(OFFER_PRICE, MIN_TRADE_TOKEN);
function minFill() {
  const eff = cfg.minFillBrc > FLOOR_BRC ? cfg.minFillBrc : FLOOR_BRC;
  return eff > remainingBrc ? remainingBrc : eff;
}

// ---------------------------------------------------------------- helpers
function hexToBytes(h) {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b) {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}
async function get(url) {
  const r = await fetch(url);
  return r.ok ? r.json() : null;
}

function selfParty() {
  return {
    peerId: myBox, brcPubkey: bytesToHex(wallet.publicKey),
    evmAddress: cfg.evmAddress ?? '',
    ...(cfg.solAddress ? { solAddress: cfg.solAddress } : {}),
  };
}

// ---------------------------------------------------------------- market
async function heartbeatOffer() {
  // Depleted (or the leftover is below the tradable minimum): stop advertising.
  if (remainingBrc <= 0n || tokenForBrc(remainingBrc) < MIN_TRADE_TOKEN || remainingBrc < cfg.minFillBrc) return;
  const offer = {
    // arb:usdt stays v:1 (pre-pair clients still see it); other pairs are v:2
    ...(onSol ? { v: 2, pair: cfg.pair } : { v: 1 }),
    id: OFFER_ID, side: 'sell-brc',
    amountBrc: cfg.amountBrc.toString(), amountToken: cfg.amountToken.toString(),
    remainingBrc: remainingBrc.toString(),
    ...(cfg.minFillBrc > 0n ? { minBrc: cfg.minFillBrc.toString() } : {}),
    makerFeeWei: '1000', maker: selfParty(), ts: Math.floor(Date.now() / 1000),
  };
  await post(`${cfg.market}/offers`, { offer, key: marketKey });
}

async function pollMailbox() {
  const out = await get(`${cfg.market}/msg?box=${myBox}&key=${marketKey}`);
  for (const msg of out?.messages ?? []) await onMessage(msg);
}

async function onMessage(msg) {
  if (msg.t === 'take') await onTake(msg);
  // 'hint' messages (buyer announcing their lock / secret) just accelerate our
  // polling; we re-verify on-chain regardless, so they're optional here.
}

async function onTake(take) {
  const now = Math.floor(Date.now() / 1000);
  const reject = (reason) => post(`${cfg.market}/msg`, { to: take.taker.peerId, payload: { t: 'reject', offerId: OFFER_ID, takeId: take.takeId, reason } });
  if (!/^[0-9a-f]{64}$/.test(take.hashlock ?? '')) return reject('bad hashlock');
  if (take.evmTimelock - take.brcLocktime < 8 * 3600) return reject('timelock gap too small');
  if (swaps.has(take.hashlock)) return reject('already taken');

  // Fill amounts: any slice of what's left, at exactly the offered price.
  let takeBrc, takeToken;
  try { takeBrc = BigInt(take.amountBrc); takeToken = BigInt(take.amountToken); } catch { return reject('bad fill amounts'); }
  if (takeBrc <= 0n || takeBrc > remainingBrc) return reject('amount exceeds the offer');
  if (takeToken !== tokenForBrc(takeBrc)) return reject('fill price mismatch');
  if (takeToken < MIN_TRADE_TOKEN) return reject('trade below minimum size');
  if (takeBrc < minFill()) return reject('fill below the offer minimum');

  console.log(`[take] ${take.hashlock.slice(0, 12)}… from ${take.taker.evmAddress}: ${Number(takeBrc) / 1e8} BRC for ${Number(takeToken) / 1e6} USDT`);
  remainingBrc -= takeBrc;
  swaps.set(take.hashlock, { take, amountBrc: takeBrc, amountToken: takeToken, state: 'accepted', createdAt: now });
  await post(`${cfg.market}/msg`, {
    to: take.taker.peerId,
    payload: { t: 'accept', offerId: OFFER_ID, takeId: take.takeId, swapId: take.hashlock, amountBrc: takeBrc.toString(), amountToken: takeToken.toString() },
  });
  if (remainingBrc <= 0n || tokenForBrc(remainingBrc) < MIN_TRADE_TOKEN || remainingBrc < cfg.minFillBrc) {
    // fully consumed (or the leftover is below our minimum) — stop advertising
    await post(`${cfg.market}/offers/delete`, { offerId: OFFER_ID, key: marketKey });
  } else {
    await heartbeatOffer(); // re-list immediately with the reduced remainder
  }
}

// ---------------------------------------------------------------- swap engine (seller)
function computeLockId(sender, recipient, amount, hashlock, timelock) {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint256' }],
    [sender, recipient, cfg.token, amount, `0x${hashlock}`, BigInt(timelock)],
  ));
}

async function readEvmLock(lockId) {
  const row = await evm.readContract({ address: cfg.htlc, abi: HTLC_ABI, functionName: 'locks', args: [lockId] });
  if (row[1] === '0x0000000000000000000000000000000000000000') return null;
  return { token: row[0], sender: row[1], recipient: row[2], amount: row[3], hashlock: row[4].slice(2), timelock: Number(row[5]), relayFee: row[6], claimed: row[7], refunded: row[8] };
}

// Solana twin: lock id = sha256(sender‖recipient‖mint‖amount_le‖hashlock‖
// timelock_le); the lock-state PDA derived from it is the handle we track
// (must mirror solana/programs/bswap-htlc and src/sol/htlcAdapter.ts).
function computeSolLockState(senderB58, recipientB58, amount, hashlock, timelock) {
  const le64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(v))); return b; };
  const lockId = createHash('sha256').update(Buffer.concat([
    new PublicKey(senderB58).toBuffer(),
    new PublicKey(recipientB58).toBuffer(),
    new PublicKey(cfg.solMint).toBuffer(),
    le64(amount),
    Buffer.from(hashlock, 'hex'),
    le64(timelock),
  ])).digest();
  return PublicKey.findProgramAddressSync([Buffer.from('lock'), lockId], new PublicKey(cfg.solProgram))[0];
}

async function readSolLock(lockStatePda) {
  const info = await solConn.getAccountInfo(lockStatePda, 'confirmed');
  if (!info || info.data.length < 8 + 251) return null;
  const d = info.data;
  const dv = new DataView(d.buffer, d.byteOffset);
  const status = d[226];
  return {
    amount: dv.getBigUint64(170, true),
    timelock: Number(dv.getBigInt64(210, true)),
    claimed: status === 1,
    refunded: status === 2,
  };
}

async function tickSwap(hashlock) {
  const s = swaps.get(hashlock);
  if (!s) return;
  const take = s.take;
  const now = Math.floor(Date.now() / 1000);

  try {
    if (s.state === 'accepted') {
      // verify the buyer's token lock exists and is unclaimed
      let lockId, view;
      if (onSol) {
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(take.taker.solAddress ?? '')) { s.state = 'failed'; return; }
        const pda = computeSolLockState(take.taker.solAddress, cfg.solAddress, s.amountToken, hashlock, take.evmTimelock);
        lockId = pda.toBase58();
        view = await readSolLock(pda);
      } else {
        lockId = computeLockId(take.taker.evmAddress, cfg.evmAddress, s.amountToken, hashlock, take.evmTimelock);
        view = await readEvmLock(lockId);
      }
      if (!view) { if (now - s.createdAt > 1800) { s.state = 'failed'; console.log('[fail] buyer never locked the tokens'); } return; }
      if (view.claimed || view.refunded) { s.state = 'failed'; return; }
      if (view.timelock - now < 20 * 3600) { s.state = 'failed'; console.log('[fail] token lock window too short'); return; }
      s.lockId = lockId;
      s.state = 'lock-brc';
    }

    if (s.state === 'lock-brc') {
      // build + submit the BRC HTLC lock (recipient = buyer's BRC pubkey)
      const script = htlcScript(hexToBytes(hashlock), hexToBytes(take.taker.brcPubkey), take.brcLocktime, wallet.publicKey);
      const sHash = scriptHashOf(script);
      const nonce = await brcNextNonce(bytesToHex(wallet.publicKey));
      const lockTx = signLock({ from: wallet.publicKey, to: new Uint8Array(32), amount: s.amountBrc, fee: 1000n, nonce, scriptHash: sHash }, wallet.privateKey);
      await post(`${cfg.brcApi}/txs`, { txs: [bytesToHex(encodeTx(lockTx))] });
      s.brcLockTxId = bytesToHex(txHash(lockTx));
      s.redeemScript = script;
      s.state = 'await-secret';
      console.log(`[lock] BRC locked, tx ${s.brcLockTxId.slice(0, 12)}…`);
    }

    if (s.state === 'await-secret') {
      const secret = await scanForSecret(s.brcLockTxId, hashlock);
      if (secret) { s.secret = secret; s.state = 'claim-usdt'; console.log('[secret] revealed on BRC chain'); }
      else if (now >= take.brcLocktime) { s.state = 'refund-brc'; console.log('[refund] buyer never redeemed'); }
      return;
    }

    if (s.state === 'claim-usdt') {
      // hand to the relayer (it pays gas, keeps relayFee); anyone may claim.
      const res = onSol
        ? await post(`${cfg.relayer}/relay/sol`, { op: 'solClaim', lockState: s.lockId, secret: s.secret })
        : await post(`${cfg.relayer}/relay`, { op: 'claim', id: s.lockId, secret: `0x${s.secret}` });
      if (res.ok) { s.state = 'done'; console.log(`[done] tokens claimed, tx ${res.txHash}`); }
      else console.log('[claim] relayer error:', res.error);
    }

    // refund-brc: submit a refund redeem after brcLocktime (left as an exercise —
    // build a Redeem spending s.brcLockTxId via the ELSE branch, witness [sig, 0]).
  } catch (e) {
    console.log(`[tick ${hashlock.slice(0, 8)}] ${e.shortMessage ?? e.message}`);
  }
}

// ---------------------------------------------------------------- BRC REST helpers
async function brcNextNonce(addrHex) {
  // Minimal: read the snapshot for the account nonce. For a busy bot, track
  // locally and increment. Here we read /snapshot once per lock.
  const snap = await get(`${cfg.brcApi}/snapshot`);
  const row = snap?.accounts?.find((a) => a[0] === addrHex);
  return row ? Number(row[2]) : 0;
}

async function scanForSecret(lockTxId, hashlock) {
  // Scan recent blocks for a Redeem spending our lock; extract the 32-byte
  // preimage whose sha256 == hashlock.
  const tip = await get(`${cfg.brcApi}/tip`);
  if (!tip) return null;
  const from = Math.max(1, tip.height - 200);
  const blocks = await get(`${cfg.brcApi}/blocks?fromHeight=${from}&max=200`);
  for (const hex of blocks?.blocks ?? []) {
    const block = decodeBlock(hexToBytes(hex));
    for (const tx of block.transactions) {
      if (!isRedeem(tx) || bytesToHex(tx.lockId) !== lockTxId) continue;
      for (const item of tx.witness ?? []) {
        if (item.length === 32 && bytesToHex(sha256(item)) === hashlock) return bytesToHex(item);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- main loop
console.log(`BrowserSwaps maker bot`);
console.log(`  pair       : ${cfg.pair}`);
console.log(`  BRC pubkey : ${bytesToHex(wallet.publicKey)}`);
console.log(`  payout     : ${onSol ? cfg.solAddress + ' (Solana)' : cfg.evmAddress + ' (Arbitrum)'}`);
console.log(`  offering   : ${Number(cfg.amountBrc) / 1e8} BRC for ${Number(cfg.amountToken) / 1e6} ${cfg.pair.split(':')[1].toUpperCase()}`);
console.log(`  market box : ${myBox}`);

await heartbeatOffer();
setInterval(heartbeatOffer, 15_000);
setInterval(pollMailbox, 2_500);
setInterval(() => { for (const h of swaps.keys()) void tickSwap(h); }, 5_000);
