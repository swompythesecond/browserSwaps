// BrowserSwaps relayer module — a "gas station" for the HTLC contract on
// Arbitrum.
//
// Accepts relay requests over HTTP, simulates them, submits the ones that are
// valid AND pay at least the configured minimum fee, and earns that fee in
// tokens. It can never redirect or steal funds: every operation it submits is
// bound by the user's signature (lockWithPermit) or by contract-fixed
// parameters (claim/refund). Its only power is declining — and then users can
// self-submit or use another relayer.
//
// Economics: each relayed op costs ~$0.01-0.03 gas and earns the fee embedded
// in the swap (default 0.05 USDT). ETH drains, tokens accumulate — top up ETH
// occasionally; the status endpoint shows balances.
//
// Standalone:  node server/relayer.mjs --port 9200   (RELAYER_KEY env or .env)
// Combined:    see server/swapd.mjs (npm run server)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createWalletClient, createPublicClient, http as viemHttp, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import { createAutoRefill } from './autorefill.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Real client IP for rate limiting. Behind the Apache reverse proxy every
// request's socket peer is 127.0.0.1, which would bucket ALL users together.
// Trust X-Forwarded-For only when the immediate peer IS loopback (i.e. our
// Apache proxy). Apache is the edge and APPENDS the real client IP to any
// header the client sent, so the trustworthy hop is the RIGHTMOST entry — a
// client that forges "X-Forwarded-For: fake" just yields "fake, realIP" and we
// still bucket them by realIP. A direct, non-proxied client uses its socket IP.
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
 * Returns the relayer route handler, or null when no key is configured
 * (the combined server then runs market-only).
 */
export function createRelayer() {
  const artifact = JSON.parse(fs.readFileSync(path.join(here, '../src/evm/htlc.artifact.json'), 'utf8'));
  const dotenv = loadDotEnv();
  const RPC = process.env.RELAYER_RPC || 'https://arb1.arbitrum.io/rpc';
  /** HTLC v3 on Arbitrum One — MUST match src/config.ts EVM_NETWORKS.arbitrum.htlc.
   * If this drifts from what the app signs against, every relayed op reverts
   * (the EIP-712 intent signature is bound to the verifying contract address). */
  const HTLC = (process.env.HTLC_ADDRESS || '0xd9a5db57c4fc3b08381f0cd1816769eaed13ead7').toLowerCase();
  console.log(`[relayer] HTLC contract: ${HTLC}`);
  /** Minimum fee (token units, 6 decimals) an op must pay us. */
  const MIN_FEE = BigInt(process.env.MIN_FEE_UNITS || '20000'); // 0.02 USDT

  const pk = process.env.RELAYER_KEY || dotenv.RELAYER_KEY || dotenv.DEPLOYER_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) return null;

  /** USDT on Arbitrum One (matches src/config.ts). Used by auto-refill. */
  const TOKEN = process.env.TOKEN_ADDRESS || dotenv.TOKEN_ADDRESS || '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';

  const account = privateKeyToAccount(pk);
  const wallet = createWalletClient({ chain: arbitrum, account, transport: viemHttp(RPC) });
  const client = createPublicClient({ chain: arbitrum, transport: viemHttp(RPC) });

  // Serialize every wallet send (relay ops AND auto-refill swaps) so two
  // transactions can't grab the same nonce and clobber each other.
  let txChain = Promise.resolve();
  function exclusive(fn) {
    const run = txChain.then(fn, fn);
    txChain = run.then(() => {}, () => {});
    return run;
  }

  const autorefill = createAutoRefill({ client, wallet, account, token: TOKEN, exclusive });

  let relayed = 0;
  let rejected = 0;

  // naive per-IP rate limit: 30 requests/min (relay ops are rare and heavy)
  const hits = new Map();
  function rateLimited(ip) {
    const now = Date.now();
    const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    arr.push(now);
    hits.set(ip, arr);
    return arr.length > 30;
  }

  async function readLock(id) {
    const row = await client.readContract({
      address: HTLC, abi: artifact.abi, functionName: 'locks', args: [id],
    });
    return {
      token: row[0], sender: row[1], recipient: row[2], amount: row[3],
      hashlock: row[4], timelock: row[5], relayFee: row[6], claimed: row[7], refunded: row[8],
    };
  }

  /** Simulate, check profitability, submit. Returns tx hash. */
  async function submit(functionName, args, feeUnits) {
    if (feeUnits < MIN_FEE) throw new Error(`fee below relayer minimum (${MIN_FEE} units)`);
    // simulate first — a reverting op costs us gas for nothing
    await client.simulateContract({ address: HTLC, abi: artifact.abi, functionName, args, account });
    const hash = await exclusive(() => wallet.writeContract({ address: HTLC, abi: artifact.abi, functionName, args }));
    await client.waitForTransactionReceipt({ hash });
    relayed++;
    // We just spent ETH on gas — opportunistically top it back up (never awaited).
    void autorefill.maybeRefill();
    return hash;
  }

  async function handleOp(op, body) {
    switch (op) {
      case 'lockWithPermit': {
        const it = body.intent;
        const intent = {
          token: it.token, amount: BigInt(it.amount), hashlock: it.hashlock,
          recipient: it.recipient, timelock: BigInt(it.timelock),
          lockFee: BigInt(it.lockFee), relayFee: BigInt(it.relayFee), deadline: BigInt(it.deadline),
        };
        return submit('lockWithPermit', [
          intent, body.intentSig,
          BigInt(body.permitValue), BigInt(body.permitDeadline),
          Number(body.pv), body.pr, body.ps,
        ], intent.lockFee);
      }
      case 'withdrawWithPermit': {
        const it = body.intent;
        const intent = {
          token: it.token, to: it.to, amount: BigInt(it.amount),
          fee: BigInt(it.fee), deadline: BigInt(it.deadline), salt: it.salt,
        };
        return submit('withdrawWithPermit', [
          intent, body.intentSig,
          BigInt(body.permitValue), BigInt(body.permitDeadline),
          Number(body.pv), body.pr, body.ps,
        ], intent.fee);
      }
      case 'claim': {
        const lock = await readLock(body.id);
        if (lock.sender === '0x0000000000000000000000000000000000000000') throw new Error('unknown lock');
        return submit('claim', [body.id, body.secret], lock.relayFee);
      }
      case 'refund': {
        const lock = await readLock(body.id);
        if (lock.sender === '0x0000000000000000000000000000000000000000') throw new Error('unknown lock');
        return submit('refund', [body.id], lock.relayFee);
      }
      default:
        throw new Error('unknown op');
    }
  }

  return {
    address: account.address,

    async status() {
      const eth = await client.getBalance({ address: account.address }).catch(() => 0n);
      return {
        address: account.address, ethBalance: formatEther(eth),
        minFeeUnits: MIN_FEE.toString(), htlc: HTLC, relayed, rejected,
        lowGas: eth < 200_000_000_000_000n, // < 0.0002 ETH: top me up
        autorefill: autorefill.status(),
      };
    },

    /** Returns true if this module owns the route (response will be sent). */
    handle(req, res, url, cors) {
      if (url.pathname !== '/relay') return false;
      if (req.method !== 'POST') { res.writeHead(404, cors); res.end(); return true; }
      const ip = clientIp(req);
      if (rateLimited(ip)) { res.writeHead(429, cors); res.end('rate limited'); return true; }
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 100_000) req.destroy(); });
      req.on('end', () => {
        void (async () => {
          try {
            const body = JSON.parse(raw);
            const hash = await handleOp(body.op, body);
            json(res, 200, { ok: true, txHash: hash }, cors);
            console.log(new Date().toISOString(), 'relayed', body.op, hash);
          } catch (e) {
            rejected++;
            json(res, 400, { ok: false, error: e.shortMessage ?? e.message }, cors);
            console.log(new Date().toISOString(), 'rejected:', e.shortMessage ?? e.message);
          }
        })();
      });
      return true;
    },
  };
}

// ------------------------------------------------------------- standalone

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PORT = Number(process.argv[process.argv.indexOf('--port') + 1] || 9200);
  const relayer = createRelayer();
  if (!relayer) {
    console.error('set RELAYER_KEY=0x<64 hex> (env or .env) to run the relayer');
    process.exit(1);
  }
  http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    if (relayer.handle(req, res, url, cors)) return;
    void relayer.status().then((s) => json(res, 200, { service: 'browserswaps-relayer', ...s }, cors));
  }).listen(PORT, () => {
    console.log(`browserswaps relayer on :${PORT}`);
    console.log(`relayer address: ${relayer.address} (fund with ETH on Arbitrum One)`);
  });
}
