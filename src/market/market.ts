/**
 * MarketNetwork — the orderbook and swap handshake channel, backed by one or
 * more central market servers (server/market.mjs) over plain HTTP polling.
 *
 * Why central: offers and handshake messages are pure discovery metadata.
 * A market server can censor or delay, but every value-bearing decision is
 * re-verified on-chain by the swap engine (own BRC full node, cross-checked
 * Arbitrum RPCs) — so centralizing THIS layer trades zero trust for a lot of
 * reliability. Anyone can run a market server; clients fan out to all
 * configured ones.
 *
 * Presence still works like before: own offers are re-posted every ~15 s and
 * the server expires anything not refreshed for 45 s, so closing the tab
 * pulls your offers from everyone's book within seconds.
 *
 * Identity: this client owns a random secret key; its public "peerId" (kept
 * name for compatibility) is sha256(key) truncated — the server verifies
 * ownership for offer posting and mailbox draining, no accounts needed.
 */
import { sha256 } from '@bc/crypto/hash.js';
import type { Node } from '@bc/node.js';
import { MARKET, SWAP_TIMING, BRC_LOCK_FEE_DEFAULT, MIN_TRADE_TOKEN, loadSettings } from '../config.js';
import type { SwapEngine, OutboundHint } from '../swap/engine.js';
import type { SwapStore } from '../swap/store.js';
import type { SwapRecord } from '../swap/types.js';
import { bytesToHex, hexToBytes, randomBytes32 } from '../util/hex.js';
import type { AcceptMsg, MarketMsg, Offer, OfferParty, TakeMsg } from './protocol.js';

const OWN_OFFERS_KEY = 'bswap.offers.v1';
const MAILBOX_KEY = 'bswap.market.key.v1';

export interface HistoryTrade {
  ts: number;          // unix seconds (block time of the on-chain claim)
  amountBrc: string;   // smallest units
  amountToken: string; // token units
  price: number;       // token per 1 BRC
}

export class MarketNetwork {
  private readonly readKey: string;
  private readonly myBoxId: string;
  private remoteOffers: Offer[] = [];
  private ownOffers: Offer[] = [];
  private consumedOffers = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private listeners = new Set<() => void>();
  private pendingTakes = new Map<string, { resolve: (swapId: string) => void; reject: (e: Error) => void }>();
  private lastOkAt = 0;
  private lastError = 'not started yet';
  private lastBootId = '';

  constructor(
    private readonly node: Node,
    private readonly store: SwapStore,
    private readonly engine: SwapEngine,
    private readonly evmAddress: () => string,
  ) {
    // Stable mailbox identity across reloads (a mid-swap reload must keep
    // receiving handshake messages at the same address).
    let key = localStorage.getItem(MAILBOX_KEY);
    if (!key || !/^[0-9a-f]{64}$/.test(key)) {
      key = bytesToHex(randomBytes32());
      localStorage.setItem(MAILBOX_KEY, key);
    }
    this.readKey = key;
    this.myBoxId = bytesToHex(sha256(new TextEncoder().encode(key))).slice(0, 20);
    try {
      const raw = localStorage.getItem(OWN_OFFERS_KEY);
      if (raw) this.ownOffers = JSON.parse(raw);
    } catch { /* start with no offers */ }
  }

  private servers(): string[] {
    return loadSettings().marketUrls.map((u) => u.replace(/\/$/, ''));
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    console.info(`[market] starting: mailbox=${this.myBoxId}, servers=${this.servers().join(', ')}`);
    this.timers.push(setInterval(() => { void this.postOwnOffers(); }, MARKET.offerHeartbeatMs));
    this.timers.push(setInterval(() => { void this.pollOffers(); }, MARKET.offerPollMs));
    this.timers.push(setInterval(() => { void this.pollMailbox(); }, MARKET.mailboxPollMs));

    // Closing the tab pulls offers off the market INSTANTLY (sendBeacon is
    // built to survive page teardown) instead of waiting for the server TTL.
    window.addEventListener('pagehide', () => {
      for (const base of this.servers()) {
        for (const o of this.ownOffers) {
          navigator.sendBeacon(
            `${base}/offers/delete`,
            new Blob([JSON.stringify({ offerId: o.id, key: this.readKey })], { type: 'application/json' }),
          );
        }
      }
    });
    // Coming back to the foreground: re-list and refresh immediately rather
    // than waiting out throttled timers.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void this.postOwnOffers();
        void this.pollOffers();
        void this.pollMailbox();
      }
    });

    await Promise.allSettled([this.postOwnOffers(), this.pollOffers(), this.pollMailbox()]);
  }

  /** Connection health for the UI. */
  status(): { online: boolean; lastError: string; remoteOffers: number } {
    return {
      online: Date.now() - this.lastOkAt < 3 * MARKET.offerPollMs,
      lastError: this.lastError,
      remoteOffers: this.remoteOffers.length,
    };
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  // ----------------------------------------------------------------- HTTP

  /** POST to every configured market server (writes fan out). */
  private async postAll(path: string, body: unknown): Promise<boolean> {
    const results = await Promise.allSettled(this.servers().map(async (base) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${base}${path}: HTTP ${res.status} ${text}`);
      }
    }));
    const ok = results.some((r) => r.status === 'fulfilled');
    if (!ok) {
      const first = results[0];
      this.lastError = first?.status === 'rejected' ? String(first.reason) : 'post failed';
      console.warn(`[market] POST ${path} failed on all servers:`, this.lastError);
    }
    return ok;
  }

  /** GET from the first market server that answers (reads take first success). */
  private async getFirst<T>(path: string): Promise<T | null> {
    return (await this.getFirstVerbose<T>(path))?.data ?? null;
  }

  /** As getFirst, but also reports which server answered (for diagnostics). */
  private async getFirstVerbose<T>(path: string): Promise<{ data: T; server: string } | null> {
    let lastErr = 'no market servers configured';
    for (const base of this.servers()) {
      try {
        const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          this.lastOkAt = Date.now();
          this.lastError = '';
          return { data: await res.json() as T, server: base };
        }
        lastErr = `${base}: HTTP ${res.status}`;
      } catch (e) {
        lastErr = `${base}: ${(e as Error).message}`;
      }
    }
    if (this.lastError !== lastErr) console.warn(`[market] GET ${path} failed:`, lastErr);
    this.lastError = lastErr;
    return null;
  }

  // ---------------------------------------------------------------- orderbook

  private async postOwnOffers(): Promise<void> {
    if (this.ownOffers.length === 0) return;
    const ts = Math.floor(Date.now() / 1000);
    for (const o of this.ownOffers) {
      o.ts = ts;
      await this.postAll('/offers', { offer: o, key: this.readKey });
    }
    this.persistOwn();
  }

  private async pollOffers(): Promise<void> {
    const got = await this.getFirstVerbose<{ offers: Offer[]; bootId?: string }>('/offers');
    if (!got) { console.warn('[market] pollOffers: no server answered'); return; }
    const { data: out, server } = got;
    // Detect a server that restarted under us (in-memory offers wiped).
    if (out.bootId && this.lastBootId && out.bootId !== this.lastBootId) {
      console.warn(`[market] SERVER RESTARTED: bootId ${this.lastBootId} -> ${out.bootId} — offers were wiped, re-listing`);
      void this.postOwnOffers();
    }
    if (out.bootId) this.lastBootId = out.bootId;
    const raw = out.offers ?? [];
    const mineIds = new Set(this.ownOffers.map((o) => o.id));
    const rejected: string[] = [];
    const fresh = raw.filter((o) => {
      if (o?.v !== 1) { rejected.push(`${o?.id ?? '?'}:badversion`); return false; }
      if (o.side !== 'sell-brc') { rejected.push(`${o.id}:side`); return false; }
      if (!o.maker?.peerId) { rejected.push(`${o.id}:nomaker`); return false; }
      if (mineIds.has(o.id)) { rejected.push(`${o.id}:mine-byid`); return false; }
      if (o.maker.peerId === this.myBoxId) { rejected.push(`${o.id}:mine-bybox`); return false; }
      if (this.consumedOffers.has(o.id)) { rejected.push(`${o.id}:consumed`); return false; }
      return true;
    });
    // Always log the shape so flicker is diagnosable: raw from server vs kept.
    console.info(`[market] poll @ ${server}: raw=${raw.length} kept=${fresh.length}`
      + (rejected.length ? ` rejected=[${rejected.join(', ')}]` : '')
      + ` myBox=${this.myBoxId}`);
    const before = JSON.stringify(this.remoteOffers);
    this.remoteOffers = fresh;
    if (JSON.stringify(this.remoteOffers) !== before) {
      console.info(`[market] BOOK CHANGED -> ${fresh.length} remote offer(s)`);
      this.emit();
    }
  }

  /** Completed-trade history, verified on-chain by the market server. */
  async fetchHistory(): Promise<HistoryTrade[]> {
    const out = await this.getFirst<{ trades: HistoryTrade[] }>('/history');
    return out?.trades ?? [];
  }

  /** Everyone's live offers, own first. */
  book(): Offer[] {
    return [...this.ownOffers, ...this.remoteOffers.sort((a, b) => b.ts - a.ts)];
  }

  myOffers(): Offer[] {
    return this.ownOffers;
  }

  postOffer(amountBrc: bigint, amountToken: bigint, feeWei: bigint = BRC_LOCK_FEE_DEFAULT): Offer {
    const offer: Offer = {
      v: 1,
      id: bytesToHex(randomBytes32()).slice(0, 16),
      side: 'sell-brc',
      amountBrc: amountBrc.toString(),
      amountToken: amountToken.toString(),
      makerFeeWei: feeWei.toString(),
      maker: this.selfParty(),
      ts: Math.floor(Date.now() / 1000),
    };
    this.ownOffers.push(offer);
    this.persistOwn();
    void this.postAll('/offers', { offer, key: this.readKey });
    this.emit();
    return offer;
  }

  cancelOffer(id: string): void {
    this.ownOffers = this.ownOffers.filter((o) => o.id !== id);
    this.persistOwn();
    void this.postAll('/offers/delete', { offerId: id, key: this.readKey });
    this.emit();
  }

  onBook(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private selfParty(): OfferParty {
    return {
      peerId: this.myBoxId,
      brcPubkey: bytesToHex(this.node.wallet.publicKey),
      evmAddress: this.evmAddress(),
    };
  }

  private persistOwn(): void {
    localStorage.setItem(OWN_OFFERS_KEY, JSON.stringify(this.ownOffers));
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  // ---------------------------------------------------------------- messaging

  /** Used by the swap engine to deliver hints to the counterparty. */
  sendHint(peerId: string, hint: OutboundHint): void {
    const { swapId, type, ...rest } = hint;
    void this.postAll('/msg', { to: peerId, payload: { t: 'hint', swapId, hint: { type, ...rest } } });
  }

  private send(to: string, payload: MarketMsg): Promise<boolean> {
    return this.postAll('/msg', { to, payload });
  }

  private async pollMailbox(): Promise<void> {
    const out = await this.getFirst<{ messages: MarketMsg[] }>(
      `/msg?box=${this.myBoxId}&key=${this.readKey}`);
    if (!out) return;
    for (const msg of out.messages ?? []) {
      console.info('[market] received:', (msg as { t?: string }).t, msg);
      this.onMessage(msg);
    }
  }

  private onMessage(msg: MarketMsg): void {
    if (typeof (msg as { t?: unknown })?.t !== 'string') return;
    switch (msg.t) {
      case 'take':
        void this.onTake(msg);
        return;
      case 'accept': {
        const pending = this.pendingTakes.get(msg.offerId);
        if (pending) {
          this.pendingTakes.delete(msg.offerId);
          pending.resolve(msg.swapId);
        }
        return;
      }
      case 'reject': {
        const pending = this.pendingTakes.get(msg.offerId);
        if (pending) {
          this.pendingTakes.delete(msg.offerId);
          pending.reject(new Error(msg.reason));
        }
        return;
      }
      case 'hint':
        // Route to the engine; it verifies everything on-chain itself.
        void this.engine.onHint(msg.swapId, msg.hint);
        return;
      case 'offers':
        return; // legacy gossip message, not used with market servers
    }
  }

  // ---------------------------------------------------------------- taking

  /**
   * Take a remote offer: generate the secret (we become the BUYER and only
   * ever reveal it by redeeming BRC on our own validated chain), propose
   * timelocks, and wait for the maker's accept.
   */
  takeOffer(offerId: string): Promise<string> {
    const offer = this.remoteOffers.find((o) => o.id === offerId);
    if (!offer) return Promise.reject(new Error('offer no longer available'));

    const secret = randomBytes32();
    const hashlock = bytesToHex(sha256(secret));
    const now = Math.floor(Date.now() / 1000);
    const take: TakeMsg = {
      t: 'take',
      offerId: offer.id,
      taker: this.selfParty(),
      hashlock,
      evmTimelock: now + SWAP_TIMING.evmTimelockSecs,
      brcLocktime: now + SWAP_TIMING.brcLocktimeSecs,
    };

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTakes.delete(offer.id);
        reject(new Error('maker did not respond (their tab may have just closed)'));
      }, 30_000);
      this.pendingTakes.set(offer.id, {
        resolve: (swapId) => {
          clearTimeout(timer);
          // Persist the buyer-side swap BEFORE anything moves on any chain.
          const swap: SwapRecord = {
            id: swapId,
            role: 'buyer',
            offerId: offer.id,
            createdAt: now,
            updatedAt: now,
            amountBrc: offer.amountBrc,
            amountToken: offer.amountToken,
            hashlock,
            secret: bytesToHex(secret),
            self: this.selfParty(),
            counterparty: offer.maker,
            evmTimelock: take.evmTimelock,
            brcLocktime: take.brcLocktime,
            evm: {}, brc: {},
            state: 'init',
          };
          this.store.put(swap);
          void this.engine.tick(swapId);
          resolve(swapId);
        },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      void this.send(offer.maker.peerId, take).then((delivered) => {
        if (!delivered) {
          const pending = this.pendingTakes.get(offer.id);
          if (pending) {
            this.pendingTakes.delete(offer.id);
            pending.reject(new Error('no market server reachable'));
          }
        }
      });
    });
  }

  /** Maker side: auto-accept the first valid take on a live offer. */
  private async onTake(take: TakeMsg): Promise<void> {
    const offer = this.ownOffers.find((o) => o.id === take.offerId);
    const rejectWith = (reason: string): Promise<boolean> =>
      this.send(take.taker.peerId, { t: 'reject', offerId: take.offerId, reason });
    if (!offer) { void rejectWith('offer no longer available'); return; }
    if (!/^[0-9a-f]{64}$/.test(take.hashlock)) { void rejectWith('bad hashlock'); return; }
    if (!/^[0-9a-f]{64}$/.test(take.taker.brcPubkey)) { void rejectWith('bad BRC pubkey'); return; }
    if (!/^0x[0-9a-fA-F]{40}$/.test(take.taker.evmAddress)) { void rejectWith('bad EVM address'); return; }
    if (!/^[0-9a-f]{20}$/.test(take.taker.peerId)) { void rejectWith('bad mailbox id'); return; }
    if (BigInt(offer.amountToken) < MIN_TRADE_TOKEN) { void rejectWith('trade below minimum size'); return; }

    // Timelock policy: reject anything that squeezes our claim window.
    const now = Math.floor(Date.now() / 1000);
    const evmWindow = take.evmTimelock - now;
    const brcWindow = take.brcLocktime - now;
    const gap = take.evmTimelock - take.brcLocktime;
    if (evmWindow < SWAP_TIMING.minEvmWindowSecs || evmWindow > 30 * 3600) { void rejectWith('bad EVM timelock'); return; }
    if (brcWindow < 10 * 3600 || brcWindow > 14 * 3600) { void rejectWith('bad BRC locktime'); return; }
    if (gap < SWAP_TIMING.minTimelockGapSecs) { void rejectWith('timelock gap too small'); return; }

    // Enough BRC to actually lock (amount + the lock fee we committed to)?
    const lockFee = BigInt(offer.makerFeeWei ?? BRC_LOCK_FEE_DEFAULT.toString());
    if (this.node.myBalance() < BigInt(offer.amountBrc) + lockFee) {
      void rejectWith('maker balance too low');
      return;
    }

    // Consume the offer so it can't be double-taken, then start the swap.
    this.ownOffers = this.ownOffers.filter((o) => o.id !== offer.id);
    this.consumedOffers.add(offer.id);
    this.persistOwn();
    void this.postAll('/offers/delete', { offerId: offer.id, key: this.readKey });
    this.emit();

    const swapId = take.hashlock; // unique per swap: fresh secret => fresh hash
    const swap: SwapRecord = {
      id: swapId,
      role: 'seller',
      offerId: offer.id,
      createdAt: now,
      updatedAt: now,
      amountBrc: offer.amountBrc,
      amountToken: offer.amountToken,
      brcFeeWei: lockFee.toString(),
      hashlock: take.hashlock,
      self: this.selfParty(),
      counterparty: take.taker,
      evmTimelock: take.evmTimelock,
      brcLocktime: take.brcLocktime,
      evm: {}, brc: {},
      state: 'init',
    };
    this.store.put(swap);
    const accept: AcceptMsg = { t: 'accept', offerId: offer.id, swapId };
    await this.send(take.taker.peerId, accept);
    void this.engine.tick(swapId);
  }
}
