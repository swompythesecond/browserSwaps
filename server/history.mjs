// BrowserSwaps trade history — verified, not self-reported.
//
// The market server witnesses every take (amounts + hashlock). A swap that
// actually completes ends with the HTLC emitting Claimed(id, secret) — on
// Arbitrum as a contract event, on Solana as an Anchor event in the program's
// transaction logs — and sha256(secret) equals the take's hashlock. So we
// record takes as PENDING (tagged with their pair) and only publish trades
// whose completion is proven on-chain — clients can't spam fake volume.
//
// History persists to .runtime/history.json across restarts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createPublicClient, http, parseAbi, parseAbiItem } from 'viem';
import { arbitrum } from 'viem/chains';
import { Connection, PublicKey } from '@solana/web3.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Project-root .runtime (outside the nodemon-watched server/ tree).
const RUNTIME_DIR = path.join(here, '..', '.runtime');
const FILE = path.join(RUNTIME_DIR, 'history.json');
const CLAIMED = parseAbiItem('event Claimed(bytes32 indexed id, bytes32 secret)');
const LOCKS_ABI = parseAbi([
  'function locks(bytes32) view returns (address token, address sender, address recipient, uint256 amount, bytes32 hashlock, uint256 timelock, uint256 relayFee, bool claimed, bool refunded)',
]);
const SCAN_INTERVAL_MS = 60_000;
const LOG_CHUNK = 9_000;          // public RPC getLogs range limit headroom
const FIRST_RUN_LOOKBACK = 40_000; // ~3h of Arbitrum blocks
const PENDING_TTL_MS = 24 * 3600e3;
const MAX_TRADES = 10_000;

export function createHistory({ htlc, rpc, solProgram = '', solRpc = '' }) {
  /** trades: { ts, amountBrc, amountToken, price, pair } — price in token per BRC */
  let state = { lastBlock: 0, lastSolSig: '', trades: [] };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* fresh file */ }
  /** hashlock (hex, no 0x) -> { amountBrc, amountToken, pair, ts } */
  const pending = new Map();
  const client = createPublicClient({ chain: arbitrum, transport: http(rpc) });
  const solConn = solProgram && solRpc ? new Connection(solRpc, { commitment: 'confirmed' }) : null;
  const solProgramId = solProgram ? new PublicKey(solProgram) : null;
  /** Anchor event discriminator for `Claimed { lock_id, secret }`. */
  const CLAIMED_EVENT_DISC = createHash('sha256').update('event:Claimed').digest().subarray(0, 8);
  let scanning = false;

  const persist = () => {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state));
  };

  function notePending(hashlock, amountBrc, amountToken, pair = 'arb:usdt') {
    if (typeof hashlock !== 'string' || pending.size > 5_000) return;
    const key = hashlock.toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(key)) return;
    pending.set(key, { amountBrc, amountToken, pair: typeof pair === 'string' ? pair : 'arb:usdt', ts: Date.now() });
  }

  function publishTrade(p, amountToken, ts, chainLabel) {
    const brc = Number(BigInt(p.amountBrc)) / 1e8;
    // Token decimals per pair (sol:sol trades 9-decimal wrapped SOL; every
    // other pair is a 6-decimal stablecoin) — keep in sync with src/config.ts.
    const tok = Number(BigInt(amountToken)) / (p.pair === 'sol:sol' ? 1e9 : 1e6);
    state.trades.push({
      ts,
      amountBrc: p.amountBrc,
      amountToken,
      price: brc > 0 ? tok / brc : 0,
      pair: p.pair,
    });
    console.log(new Date().toISOString(), `trade confirmed on-chain (${chainLabel}): ${brc} BRC @ ${tok} (${p.pair})`);
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      const latest = Number(await client.getBlockNumber());
      if (!state.lastBlock) state.lastBlock = Math.max(0, latest - FIRST_RUN_LOOKBACK);
      let from = state.lastBlock + 1;
      while (from <= latest) {
        const to = Math.min(from + LOG_CHUNK, latest);
        const logs = await client.getLogs({
          address: htlc, event: CLAIMED, fromBlock: BigInt(from), toBlock: BigInt(to),
        });
        for (const log of logs) {
          const secretHex = (log.args.secret ?? '').slice(2);
          const h = createHash('sha256').update(Buffer.from(secretHex, 'hex')).digest('hex');
          const p = pending.get(h);
          if (!p) continue; // a claim we never saw the take for (other market server, self-arranged)
          pending.delete(h);
          const block = await client.getBlock({ blockNumber: log.blockNumber });
          // The pended amounts are self-reported metadata, but the USDT that
          // actually moved is ON-CHAIN in the claimed lock — read it there so
          // published volume can't be inflated by a lying take/accept. (The
          // BRC amount, and thus the price, still comes from the report.)
          let amountToken = p.amountToken;
          try {
            const row = await client.readContract({ address: htlc, abi: LOCKS_ABI, functionName: 'locks', args: [log.args.id] });
            if (row[3] > 0n) amountToken = row[3].toString();
          } catch { /* RPC hiccup: fall back to the reported amount */ }
          publishTrade(p, amountToken, Number(block.timestamp), 'arbitrum');
        }
        state.lastBlock = to;
        from = to + 1;
      }
      await scanSol();
      const cutoff = Date.now() - PENDING_TTL_MS;
      for (const [k, v] of pending) if (v.ts < cutoff) pending.delete(k);
      if (state.trades.length > MAX_TRADES) state.trades = state.trades.slice(-MAX_TRADES);
      persist();
    } finally {
      scanning = false;
    }
  }

  /** Solana leg: walk the HTLC program's new transactions and pull Anchor
   * `Claimed` events ("Program data:" logs). Volume is verified by reading
   * the claimed lock's account (its state survives until reaped). */
  async function scanSol() {
    if (!solConn) return;
    // Newest-first page down to where we stopped last time.
    const sigs = [];
    let before;
    for (let page = 0; page < 10; page++) {
      const batch = await solConn.getSignaturesForAddress(solProgramId, {
        limit: 1000, before, until: state.lastSolSig || undefined,
      });
      sigs.push(...batch);
      if (batch.length < 1000) break;
      before = batch[batch.length - 1].signature;
    }
    if (sigs.length === 0) return;
    const newest = sigs[0].signature;
    // Nothing pended = nothing to match; skip the expensive per-tx fetches.
    if (pending.size > 0) {
      for (const s of sigs.reverse()) {
        if (s.err) continue;
        let tx;
        try {
          tx = await solConn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        } catch { continue; }
        for (const line of tx?.meta?.logMessages ?? []) {
          if (!line.startsWith('Program data: ')) continue;
          const data = Buffer.from(line.slice('Program data: '.length), 'base64');
          if (data.length < 8 + 32 + 32 || !data.subarray(0, 8).equals(CLAIMED_EVENT_DISC)) continue;
          const lockId = data.subarray(8, 40);
          const secret = data.subarray(40, 72);
          const h = createHash('sha256').update(secret).digest('hex');
          const p = pending.get(h);
          if (!p) continue;
          pending.delete(h);
          // Verify the moved amount from the lock's on-chain state.
          let amountToken = p.amountToken;
          try {
            const [lockPda] = PublicKey.findProgramAddressSync([Buffer.from('lock'), lockId], solProgramId);
            const info = await solConn.getAccountInfo(lockPda, 'confirmed');
            if (info && info.data.length >= 178) {
              const onchain = new DataView(info.data.buffer, info.data.byteOffset).getBigUint64(170, true);
              if (onchain > 0n) amountToken = onchain.toString();
            }
          } catch { /* reaped or RPC hiccup: fall back to the reported amount */ }
          publishTrade(p, amountToken, tx.blockTime ?? Math.floor(Date.now() / 1000), 'solana');
        }
      }
    }
    state.lastSolSig = newest;
  }

  const timer = setInterval(() => { scan().catch((e) => console.log('history scan:', e.shortMessage ?? e.message)); }, SCAN_INTERVAL_MS);
  timer.unref?.();
  scan().catch(() => { /* first scan retries on the interval */ });

  return {
    notePending,

    /** Returns true if this module owns the route. */
    handle(req, res, url, cors) {
      if (req.method !== 'GET' || url.pathname !== '/history') return false;
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify({ trades: state.trades.slice(-1000) }));
      return true;
    },

    status() {
      return { trades: state.trades.length, pendingTakes: pending.size, scannedTo: state.lastBlock };
    },
  };
}
