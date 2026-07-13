// BrowserSwaps market module — central, dumb, and safe to be either.
//
// Holds two things in memory:
//   1. OFFERS: makers re-post every ~15 s; anything not refreshed for 45 s
//      drops out, so the book only ever shows makers whose tab is open.
//   2. MAILBOXES: swap handshake messages (take/accept/hint) queued per
//      recipient, drained by polling.
//
// Trust model: this server sees and relays METADATA ONLY. Every value-bearing
// decision is re-verified on-chain by the clients (own BRC full node +
// cross-checked Arbitrum RPCs), so a malicious market server can censor or
// delay trades — never steal, redirect, or fake them. Anyone can run one.
//
// Auth without accounts: a client picks a random secret key; its public
// mailbox id IS sha256(key) truncated. Posting/deleting offers and draining a
// mailbox require the key; owning the id proves nothing. No registration.
//
// Standalone:  node server/market.mjs --port 9300
// Combined:    see server/swapd.mjs (npm run server)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Runtime state lives at the PROJECT ROOT (../.runtime), deliberately OUTSIDE
// the server/ tree that nodemon watches — writing it must never trigger a
// dev-server restart.
const RUNTIME_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.runtime');
const OFFERS_FILE = path.join(RUNTIME_DIR, 'offers.json');

// Generous TTL: browsers throttle background-tab timers to ~1/min, so a
// healthy maker tab may heartbeat that slowly. Intentional tab closes are
// removed INSTANTLY via a pagehide beacon — the TTL is only the crash net.
const OFFER_TTL_MS = 150_000;
const MAILBOX_TTL_MS = 10 * 60_000;
const MAX_QUEUE = 100;
const MAX_BODY = 50_000;

const boxIdOf = (key) => createHash('sha256').update(String(key)).digest('hex').slice(0, 20);

function json(res, code, body, cors) {
  res.writeHead(code, { 'content-type': 'application/json', ...cors });
  res.end(JSON.stringify(body));
}

export function createMarket(history = null) {
  // Boot id: if the market's in-memory state is being wiped by a silent
  // process restart, this value changes and offers reset to 0 — the single
  // clearest signal for the "offers flicker" class of bug.
  const bootId = createHash('sha256').update(String(process.pid) + process.hrtime.bigint()).digest('hex').slice(0, 6);
  console.log(new Date().toISOString(), `market module booted (id=${bootId}, pid=${process.pid})`);

  /** offerId -> { offer, ts } */
  const offers = new Map();
  /** mailboxId -> [{ payload, ts }] */
  const mailboxes = new Map();

  // Offers survive a process restart: reload any that are still within TTL, so
  // a server bounce (crash, redeploy, nodemon) never wipes the live book. Live
  // makers keep heartbeating; genuinely-gone ones expire normally.
  try {
    const saved = JSON.parse(fs.readFileSync(OFFERS_FILE, 'utf8'));
    const now = Date.now();
    for (const [id, o] of Object.entries(saved)) {
      if (now - o.ts <= OFFER_TTL_MS) offers.set(id, o);
    }
    if (offers.size) console.log(new Date().toISOString(), `reloaded ${offers.size} offer(s) from disk`);
  } catch { /* no saved offers */ }

  let persistTimer = null;
  const persistOffers = () => {
    if (persistTimer) return; // debounce bursts of heartbeats into one write
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(OFFERS_FILE, JSON.stringify(Object.fromEntries(offers)));
      } catch (e) { console.log('offer persist failed:', e.message); }
    }, 1000);
    persistTimer.unref?.();
  };

  // naive per-IP rate limit: 240 requests/min (polling is chatty by design)
  const hits = new Map();
  function rateLimited(ip) {
    const now = Date.now();
    const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    arr.push(now);
    hits.set(ip, arr);
    return arr.length > 240;
  }

  const cleaner = setInterval(() => {
    const now = Date.now();
    let expired = false;
    for (const [id, o] of offers) {
      if (now - o.ts > OFFER_TTL_MS) {
        offers.delete(id);
        expired = true;
        console.log(new Date().toISOString(), `offer ${id} EXPIRED (stale ${((now - o.ts) / 1000).toFixed(0)}s > ${OFFER_TTL_MS / 1000}s TTL)`);
      }
    }
    if (expired) persistOffers();
    for (const [id, q] of mailboxes) {
      const fresh = q.filter((m) => now - m.ts < MAILBOX_TTL_MS);
      if (fresh.length === 0) mailboxes.delete(id);
      else mailboxes.set(id, fresh);
    }
    for (const [ip, arr] of hits) if (arr.every((t) => now - t > 60_000)) hits.delete(ip);
  }, 15_000);
  cleaner.unref?.();

  function handlePost(url, body, res, cors) {
    if (url.pathname === '/offers') {
      const { offer, key } = body ?? {};
      if (!offer?.id || !offer?.maker?.peerId || typeof key !== 'string') {
        return json(res, 400, { error: 'bad offer' }, cors);
      }
      // the poster must own the maker mailbox they advertise
      if (boxIdOf(key) !== offer.maker.peerId) return json(res, 403, { error: 'bad key' }, cors);
      if (JSON.stringify(offer).length > 2000) return json(res, 400, { error: 'offer too large' }, cors);
      const existing = offers.get(offer.id);
      if (existing && existing.offer.maker.peerId !== offer.maker.peerId) {
        return json(res, 403, { error: 'offer id taken' }, cors);
      }
      if (!existing) console.log(new Date().toISOString(), `offer ${offer.id} POSTED by ${offer.maker.peerId} (${offer.amountBrc} BRC for ${offer.amountToken})`);
      else console.log(new Date().toISOString(), `offer ${offer.id} heartbeat (was ${((Date.now() - existing.ts) / 1000).toFixed(0)}s old)`);
      offers.set(offer.id, { offer, ts: Date.now() });
      persistOffers();
      return json(res, 200, { ok: true }, cors);
    }
    if (url.pathname === '/offers/delete') {
      const { offerId, key } = body ?? {};
      const existing = offers.get(offerId);
      if (existing && existing.offer.maker.peerId === boxIdOf(key)) { offers.delete(offerId); persistOffers(); }
      return json(res, 200, { ok: true }, cors);
    }
    if (url.pathname === '/msg') {
      const { to, payload } = body ?? {};
      if (typeof to !== 'string' || !/^[0-9a-f]{20}$/.test(to) || payload == null) {
        return json(res, 400, { error: 'bad message' }, cors);
      }
      const q = mailboxes.get(to) ?? [];
      if (q.length >= MAX_QUEUE) return json(res, 429, { error: 'mailbox full' }, cors);
      q.push({ payload, ts: Date.now() });
      mailboxes.set(to, q);
      console.log(new Date().toISOString(), `msg '${payload?.t ?? '?'}' -> ${to}`);
      // A take against a live offer becomes a PENDING history entry; it only
      // ever becomes a published trade once the claim is proven on-chain.
      if (history && payload?.t === 'take' && typeof payload.offerId === 'string') {
        const taken = offers.get(payload.offerId);
        if (taken) history.notePending(payload.hashlock, taken.offer.amountBrc, taken.offer.amountToken);
      }
      return json(res, 200, { ok: true }, cors);
    }
  }

  return {
    status() {
      return { offers: offers.size, mailboxes: mailboxes.size };
    },

    /** Returns true if this module owns the route (response will be sent). */
    handle(req, res, url, cors) {
      const isMarketPath = ['/offers', '/offers/delete', '/msg'].includes(url.pathname);
      if (!isMarketPath) return false;
      const ip = req.socket.remoteAddress ?? '?';
      if (rateLimited(ip)) { res.writeHead(429, cors); res.end(); return true; }

      if (req.method === 'GET' && url.pathname === '/offers') {
        const now = Date.now();
        const live = [...offers.values()].filter((o) => now - o.ts <= OFFER_TTL_MS).map((o) => o.offer);
        json(res, 200, { offers: live, bootId }, cors);
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/msg') {
        const key = url.searchParams.get('key') ?? '';
        const box = boxIdOf(key);
        if (box !== url.searchParams.get('box')) { json(res, 403, { error: 'bad key' }, cors); return true; }
        const q = mailboxes.get(box) ?? [];
        mailboxes.delete(box);
        if (q.length > 0) console.log(new Date().toISOString(), `${box} drained ${q.length} message(s)`);
        json(res, 200, { messages: q.map((m) => m.payload) }, cors);
        return true;
      }
      if (req.method !== 'POST') { res.writeHead(404, cors); res.end(); return true; }
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > MAX_BODY) req.destroy(); });
      req.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }, cors); }
        handlePost(url, body, res, cors);
      });
      return true;
    },
  };
}

// ------------------------------------------------------------- standalone

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PORT = Number(process.argv[process.argv.indexOf('--port') + 1] || 9300);
  const market = createMarket();
  http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    if (market.handle(req, res, url, cors)) return;
    json(res, 200, { service: 'browserswaps-market', ...market.status() }, cors);
  }).listen(PORT, () => console.log(`browserswaps market server on :${PORT}`));
}
