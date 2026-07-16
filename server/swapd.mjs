// BrowserSwaps combined server: market (orderbook + mailboxes) and relayer
// (gas station) in ONE node process on ONE port.
//
//   npm run server           -> http://localhost:9250
//
// Routes:
//   GET  /                       combined status
//   GET/POST /offers, /offers/delete, /msg   market
//   POST /relay                  relayer (disabled if no key configured)
//
// The relayer key comes from RELAYER_KEY (env) or .env (RELAYER_KEY /
// DEPLOYER_KEY fallback). Without a key the server still runs market-only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMarket } from './market.mjs';
import { createRelayer } from './relayer.mjs';
import { createSolRelayer } from './solRelayer.mjs';
import { createHistory } from './history.mjs';

const PORT = Number(process.argv[process.argv.indexOf('--port') + 1] || 9250);

// .env values as defaults for the config below (env vars still win).
let dotenv = {};
try {
  dotenv = Object.fromEntries(
    fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../.env'), 'utf8')
      .split(/\r?\n/).filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
} catch { /* no .env */ }

const history = createHistory({
  // v3 HTLC on Arbitrum One — MUST match src/config.ts and server/relayer.mjs.
  htlc: process.env.HTLC_ADDRESS || '0xd9a5db57c4fc3b08381f0cd1816769eaed13ead7',
  rpc: process.env.RELAYER_RPC || 'https://arb1.arbitrum.io/rpc',
  // Solana leg (empty until the program is deployed — history then skips it).
  solProgram: process.env.SOL_HTLC_PROGRAM || dotenv.SOL_HTLC_PROGRAM || '',
  solRpc: process.env.SOL_RPC || dotenv.SOL_RPC || 'https://api.mainnet-beta.solana.com',
});
// Same-origin Solana RPC passthrough. Browsers can't reach most public Solana
// RPCs (CORS) and api.mainnet-beta 403s browser traffic — but they work
// server-side. This is the getLock cross-check's independent SECOND source and
// a read fallback; the CLIENT hits publicnode directly (per-IP) for the bulk of
// reads, so this funnel deliberately carries only low-volume verification traffic.
//
// Because every user's proxied read shares the server's ONE IP (and thus one
// upstream rate-limit bucket), we (a) cache idempotent reads for a short TTL and
// coalesce identical in-flight requests, so a burst of identical polls costs one
// upstream call, and (b) spread across an upstream POOL with failover on 429/5xx.
// For real scale set SOL_RPCS to a keyed RPC (Helius/Alchemy) — keyed limits far
// exceed the keyless public ones, and the key stays secret here on the server.
const SOL_RPC_UPSTREAMS = (process.env.SOL_RPCS || dotenv.SOL_RPCS
  || process.env.SOL_RPC || dotenv.SOL_RPC || 'https://api.mainnet-beta.solana.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
const SOL_RPC_METHODS = new Set([
  'getAccountInfo', 'getBalance', 'getMultipleAccounts', 'getTokenAccountBalance',
  'getLatestBlockhash', 'isBlockhashValid', 'getSignatureStatuses', 'getSignaturesForAddress',
  'getTransaction', 'getSlot', 'getEpochInfo', 'getFeeForMessage', 'getBlockHeight',
  'getMinimumBalanceForRentExemption', 'getGenesisHash', 'getVersion', 'getHealth',
  'simulateTransaction', 'sendTransaction',
]);
// Idempotent reads safe to cache briefly. sendTransaction/simulateTransaction and
// anything time-sensitive-to-the-caller stay off this list.
const SOL_RPC_CACHEABLE = new Set([
  'getAccountInfo', 'getBalance', 'getMultipleAccounts', 'getTokenAccountBalance',
  'getLatestBlockhash', 'getSignatureStatuses', 'getSignaturesForAddress', 'getTransaction',
  'getSlot', 'getBlockHeight', 'getEpochInfo', 'isBlockhashValid', 'getMinimumBalanceForRentExemption',
  'getFeeForMessage', 'getGenesisHash', 'getVersion', 'getHealth',
]);
const SOL_RPC_CACHE_TTL = 1500;              // ms — swap-state reads tolerate this
const solRpcCache = new Map();               // key -> { t, result }
const solRpcInflight = new Map();            // key -> Promise<{ status, text }>
let solRpcRR = 0;                            // round-robin cursor over upstreams

// Forward a raw JSON-RPC body to the upstream pool, rotating the start point and
// failing over past 429/5xx so no single low-limit endpoint stalls everything.
async function solRpcForward(rawBody) {
  const n = SOL_RPC_UPSTREAMS.length;
  const start = solRpcRR++ % n;
  let last = { status: 502, text: '{"error":"no Solana upstream reachable"}' };
  for (let i = 0; i < n; i++) {
    const upstream = SOL_RPC_UPSTREAMS[(start + i) % n];
    try {
      const up = await fetch(upstream, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: rawBody,
        signal: AbortSignal.timeout(15_000),
      });
      const text = await up.text();
      if (up.status === 429 || up.status >= 500) { last = { status: up.status, text }; continue; }
      return { status: up.status, text };
    } catch (e) {
      last = { status: 502, text: JSON.stringify({ error: String(e?.message ?? e) }) };
    }
  }
  return last;
}

function handleSolRpc(req, res, url, cors) {
  if (url.pathname !== '/sol-rpc') return false;
  if (req.method !== 'POST') { res.writeHead(405, cors); res.end(); return true; }
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 200_000) req.destroy(); });
  req.on('end', () => {
    void (async () => {
      const send = (status, text) => {
        res.writeHead(status, { 'content-type': 'application/json', ...cors });
        res.end(text);
      };
      try {
        const parsed = JSON.parse(raw);
        const batch = Array.isArray(parsed) ? parsed : [parsed];
        for (const m of batch) {
          if (!m || typeof m.method !== 'string' || !SOL_RPC_METHODS.has(m.method)) {
            return send(403, JSON.stringify({ error: `method not allowed via proxy: ${m?.method ?? '?'}` }));
          }
        }
        // Single idempotent read: cache + coalesce by (method, params), ignoring
        // the JSON-RPC id (which varies per call); reply with the caller's id.
        const one = Array.isArray(parsed) ? null : parsed;
        if (one && SOL_RPC_CACHEABLE.has(one.method)) {
          const key = `${one.method}:${JSON.stringify(one.params ?? [])}`;
          const hit = solRpcCache.get(key);
          if (hit && Date.now() - hit.t < SOL_RPC_CACHE_TTL) {
            return send(200, JSON.stringify({ jsonrpc: '2.0', id: one.id, result: hit.result }));
          }
          let p = solRpcInflight.get(key);
          if (!p) {
            p = solRpcForward(raw).then((r) => {
              try {
                const j = JSON.parse(r.text);
                if (r.status === 200 && 'result' in j) {
                  if (solRpcCache.size > 2000) solRpcCache.clear();
                  solRpcCache.set(key, { t: Date.now(), result: j.result });
                }
              } catch { /* non-JSON upstream body: don't cache */ }
              return r;
            }).finally(() => solRpcInflight.delete(key));
            solRpcInflight.set(key, p);
          }
          const r = await p;
          let out = r.text;
          try {
            const j = JSON.parse(r.text);
            if ('result' in j) out = JSON.stringify({ jsonrpc: '2.0', id: one.id, result: j.result });
            else if ('error' in j) out = JSON.stringify({ jsonrpc: '2.0', id: one.id, error: j.error });
          } catch { /* pass upstream body through verbatim */ }
          return send(r.status, out);
        }
        // Non-cacheable (sendTransaction, simulate, batches): straight passthrough.
        const r = await solRpcForward(raw);
        return send(r.status, r.text);
      } catch (e) {
        return send(502, JSON.stringify({ error: String(e?.message ?? e) }));
      }
    })();
  });
  return true;
}

const market = createMarket(history);
const relayer = createRelayer();
if (!relayer) {
  console.warn('no relayer key configured (.env / RELAYER_KEY) — running market-only');
}
const solRelayer = createSolRelayer();
if (!solRelayer) {
  console.warn('no Solana relayer configured (.env SOL_RELAYER_KEY + SOL_HTLC_PROGRAM) — sol pairs are self-submit only');
}

http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const url = new URL(req.url ?? '/', 'http://x');

  if (handleSolRpc(req, res, url, cors)) return;
  if (market.handle(req, res, url, cors)) return;
  if (history.handle(req, res, url, cors)) return;
  if (solRelayer?.handle(req, res, url, cors)) return; // before /relay (longer prefix)
  if (relayer?.handle(req, res, url, cors)) return;

  // status
  void (async () => {
    const body = {
      service: 'browserswaps-server',
      market: market.status(),
      history: history.status(),
      relayer: relayer ? await relayer.status() : null,
      solRelayer: solRelayer ? await solRelayer.status() : null,
    };
    res.writeHead(200, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify(body));
  })();
}).listen(PORT, () => {
  console.log(`browserswaps server on :${PORT} (market${relayer ? ' + relayer' : ' only'})`);
  if (relayer) console.log(`relayer address: ${relayer.address} (fund with ETH on Arbitrum One)`);
});
