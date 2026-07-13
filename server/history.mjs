// BrowserSwaps trade history — verified, not self-reported.
//
// The market server witnesses every take (amounts + hashlock). A swap that
// actually completes ends with the HTLC contract emitting Claimed(id, secret)
// on Arbitrum, and sha256(secret) equals the take's hashlock. So we record
// takes as PENDING and only publish trades whose completion is proven
// on-chain — clients can't spam fake volume into the chart.
//
// History persists to server/history.json across restarts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { arbitrum } from 'viem/chains';

const here = path.dirname(fileURLToPath(import.meta.url));
// Project-root .runtime (outside the nodemon-watched server/ tree).
const RUNTIME_DIR = path.join(here, '..', '.runtime');
const FILE = path.join(RUNTIME_DIR, 'history.json');
const CLAIMED = parseAbiItem('event Claimed(bytes32 indexed id, bytes32 secret)');
const SCAN_INTERVAL_MS = 60_000;
const LOG_CHUNK = 9_000;          // public RPC getLogs range limit headroom
const FIRST_RUN_LOOKBACK = 40_000; // ~3h of Arbitrum blocks
const PENDING_TTL_MS = 24 * 3600e3;
const MAX_TRADES = 10_000;

export function createHistory({ htlc, rpc }) {
  /** trades: { ts, amountBrc, amountToken, price } — price in token per BRC */
  let state = { lastBlock: 0, trades: [] };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* fresh file */ }
  /** hashlock (hex, no 0x) -> { amountBrc, amountToken, ts } */
  const pending = new Map();
  const client = createPublicClient({ chain: arbitrum, transport: http(rpc) });
  let scanning = false;

  const persist = () => {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state));
  };

  function notePending(hashlock, amountBrc, amountToken) {
    if (typeof hashlock !== 'string' || pending.size > 5_000) return;
    const key = hashlock.toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(key)) return;
    pending.set(key, { amountBrc, amountToken, ts: Date.now() });
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
          const brc = Number(BigInt(p.amountBrc)) / 1e8;
          const usdt = Number(BigInt(p.amountToken)) / 1e6;
          state.trades.push({
            ts: Number(block.timestamp),
            amountBrc: p.amountBrc,
            amountToken: p.amountToken,
            price: brc > 0 ? usdt / brc : 0,
          });
          console.log(new Date().toISOString(), `trade confirmed on-chain: ${brc} BRC @ ${usdt} USDT`);
        }
        state.lastBlock = to;
        from = to + 1;
      }
      const cutoff = Date.now() - PENDING_TTL_MS;
      for (const [k, v] of pending) if (v.ts < cutoff) pending.delete(k);
      if (state.trades.length > MAX_TRADES) state.trades = state.trades.slice(-MAX_TRADES);
      persist();
    } finally {
      scanning = false;
    }
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
