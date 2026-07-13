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
import { createMarket } from './market.mjs';
import { createRelayer } from './relayer.mjs';
import { createHistory } from './history.mjs';

const PORT = Number(process.argv[process.argv.indexOf('--port') + 1] || 9250);

const history = createHistory({
  htlc: process.env.HTLC_ADDRESS || '0xdc6b492f5685829a8325ff407ba1cff21056bd89',
  rpc: process.env.RELAYER_RPC || 'https://arb1.arbitrum.io/rpc',
});
const market = createMarket(history);
const relayer = createRelayer();
if (!relayer) {
  console.warn('no relayer key configured (.env / RELAYER_KEY) — running market-only');
}

http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
  const url = new URL(req.url ?? '/', 'http://x');

  if (market.handle(req, res, url, cors)) return;
  if (history.handle(req, res, url, cors)) return;
  if (relayer?.handle(req, res, url, cors)) return;

  // status
  void (async () => {
    const body = {
      service: 'browserswaps-server',
      market: market.status(),
      history: history.status(),
      relayer: relayer ? await relayer.status() : null,
    };
    res.writeHead(200, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify(body));
  })();
}).listen(PORT, () => {
  console.log(`browserswaps server on :${PORT} (market${relayer ? ' + relayer' : ' only'})`);
  if (relayer) console.log(`relayer address: ${relayer.address} (fund with ETH on Arbitrum One)`);
});
