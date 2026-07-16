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
import { MARKET, SWAP_TIMING, BRC_LOCK_FEE_DEFAULT, LOCK_FEE_BPS, relayerFee, loadSettings, PAIRS, DEFAULT_PAIR, pairConfig } from '../config.js';
import type { SwapEngine, OutboundHint } from '../swap/engine.js';
import type { SwapStore } from '../swap/store.js';
import type { SwapRecord } from '../swap/types.js';
import { TERMINAL_STATES } from '../swap/types.js';
import { bytesToHex, hexToBytes, randomBytes32 } from '../util/hex.js';
import { makerMinBrcOf, minFillBrcOf, pairOf, remainingBrcOf, tokenForBrc } from './protocol.js';
import type { AcceptMsg, ConfirmMsg, MarketMsg, Offer, OfferParty, TakeMsg } from './protocol.js';

const OWN_OFFERS_KEY = 'bswap.offers.v1';
const MAILBOX_KEY = 'bswap.market.key.v1';

export interface HistoryTrade {
  ts: number;          // unix seconds (block time of the on-chain claim)
  amountBrc: string;   // smallest units
  amountToken: string; // token units
  price: number;       // token per 1 BRC
  /** Trading pair; absent on trades recorded before pairs existed (arb:usdt). */
  pair?: string;
}

export class MarketNetwork {
  private readonly readKey: string;
  private readonly myBoxId: string;
  private remoteOffers: Offer[] = [];
  private ownOffers: Offer[] = [];
  private consumedOffers = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private listeners = new Set<() => void>();
  private pendingTakes = new Map<string, { resolve: (accept: AcceptMsg) => void; reject: (e: Error) => void }>();
  private lastOkAt = 0;
  private lastError = 'not started yet';
  private lastBootId = '';

  constructor(
    private readonly node: Node,
    private readonly store: SwapStore,
    private readonly engine: SwapEngine,
    /** Own addresses per foreign chain ('' = that chain not set up). */
    private readonly addresses: { evm: () => string; sol: () => string },
    /** Own token balance on a pair, for auto-filling buy-brc offers (null = unknown). */
    private readonly tokenBalance: (pair: string) => Promise<bigint | null> = async () => null,
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

  /**
   * Drive one round of market upkeep from an EXTERNAL clock. Browsers
   * throttle a background tab's own timers to ~1/min, which is fatal for the
   * maker role: takes give up after 30 s, so a minimized tab misses sales.
   * The PiP keep-alive window schedules these on its own (never-throttled)
   * clock instead. All three are idempotent and safe to overlap with the
   * regular timers.
   */
  poke(kind: 'heartbeat' | 'offers' | 'mailbox'): void {
    if (kind === 'heartbeat') void this.postOwnOffers();
    else if (kind === 'offers') void this.pollOffers();
    else void this.pollMailbox();
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
      // v1 = implicit arb:usdt; v2 adds `pair` (must be one we know). Old
      // clients drop v2 offers the same way, so sol pairs never leak to them.
      if (o?.v !== 1 && o?.v !== 2) { rejected.push(`${o?.id ?? '?'}:badversion`); return false; }
      if (!PAIRS[pairOf(o)]) { rejected.push(`${o.id}:pair`); return false; }
      if (o.side !== 'sell-brc' && o.side !== 'buy-brc') { rejected.push(`${o.id}:side`); return false; }
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

  postOffer(side: Offer['side'], amountBrc: bigint, amountToken: bigint, opts: { feeWei?: bigint; minBrc?: bigint; pair?: string } = {}): Offer {
    const pair = opts.pair ?? DEFAULT_PAIR;
    if (!PAIRS[pair]) throw new Error(`unknown pair: ${pair}`);
    if (pairConfig(pair).chain === 'sol' && !this.addresses.sol()) {
      throw new Error('Solana wallet not set up');
    }
    const offer: Offer = {
      // arb:usdt keeps v:1 so pre-pair clients still see those offers; any
      // other pair MUST go out as v:2 (old clients drop unknown versions).
      ...(pair === DEFAULT_PAIR ? { v: 1 as const } : { v: 2 as const, pair }),
      id: bytesToHex(randomBytes32()).slice(0, 16),
      side,
      amountBrc: amountBrc.toString(),
      amountToken: amountToken.toString(),
      // the BRC lock fee is the seller's cost; on buy-brc the TAKER sells
      ...(side === 'sell-brc' ? { makerFeeWei: (opts.feeWei ?? BRC_LOCK_FEE_DEFAULT).toString() } : {}),
      ...(opts.minBrc && opts.minBrc > 0n ? { minBrc: opts.minBrc.toString() } : {}),
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

  // A fill is accepted minutes before its lock lands on-chain, so the wallet
  // balance alone can't tell how much is still spendable — rapid partial
  // fills would each pass against the same untouched balance and over-commit.
  // Reserve the full amount of every swap that isn't finished yet: this
  // over-reserves a little after a lock confirms (balance already reduced),
  // which at worst rejects a take the maker could technically afford — far
  // better than accepting one it can't fund and stranding the counterparty
  // behind a timelock refund.

  /** BRC promised to unfinished swaps where we are the seller. */
  private reservedBrc(): bigint {
    let sum = 0n;
    for (const s of this.store.all()) {
      if (s.role !== 'seller' || TERMINAL_STATES.has(s.state)) continue;
      sum += BigInt(s.amountBrc) + BigInt(s.brcFeeWei ?? BRC_LOCK_FEE_DEFAULT.toString());
    }
    return sum;
  }

  /** Token units promised to unfinished swaps (on `pair`) where we buy. */
  private reservedToken(pair: string): bigint {
    const floor = pairConfig(pair).feeMinUnits;
    let sum = 0n;
    for (const s of this.store.all()) {
      if (s.role !== 'buyer' || TERMINAL_STATES.has(s.state)) continue;
      if ((s.pair ?? DEFAULT_PAIR) !== pair) continue;
      const amount = BigInt(s.amountToken);
      sum += amount + relayerFee(amount, LOCK_FEE_BPS, floor);
    }
    return sum;
  }

  private selfParty(): OfferParty {
    const sol = this.addresses.sol();
    return {
      peerId: this.myBoxId,
      brcPubkey: bytesToHex(this.node.wallet.publicKey),
      evmAddress: this.addresses.evm(),
      ...(sol ? { solAddress: sol } : {}),
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
        // takeId pairs the response with ITS take (several takes of one offer
        // can be in flight); offerId fallback covers legacy makers/bots.
        const key = msg.takeId ?? msg.offerId;
        const pending = this.pendingTakes.get(key);
        if (pending) {
          this.pendingTakes.delete(key);
          pending.resolve(msg);
        }
        return;
      }
      case 'reject': {
        const key = msg.takeId ?? msg.offerId;
        const pending = this.pendingTakes.get(key);
        if (pending) {
          this.pendingTakes.delete(key);
          pending.reject(new Error(msg.reason));
        }
        return;
      }
      case 'confirm':
        this.onConfirm(msg);
        return;
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
   * Take a remote offer, fully or partially (`brcPart` defaults to everything
   * left). On a sell-brc offer we become the BUYER: generate the secret (only
   * ever revealed by redeeming BRC on our own validated chain) and send its
   * hashlock. On a buy-brc offer we become the SELLER: the maker is the buyer
   * and returns the hashlock it generated in the accept. Either way we
   * propose the timelocks and wait for the maker's accept.
   */
  takeOffer(offerId: string, brcPart?: bigint): Promise<string> {
    const offer = this.remoteOffers.find((o) => o.id === offerId);
    if (!offer) return Promise.reject(new Error('offer no longer available'));
    const pair = pairOf(offer);
    const minTrade = pairConfig(pair).minTradeUnits;
    const remaining = remainingBrcOf(offer);
    const takeBrc = brcPart ?? remaining;
    if (takeBrc <= 0n) return Promise.reject(new Error('amount must be positive'));
    if (takeBrc > remaining) return Promise.reject(new Error('amount exceeds what is left of this offer'));
    const takeToken = tokenForBrc(offer, takeBrc);
    if (takeToken < minTrade) return Promise.reject(new Error('fill below the minimum trade size'));
    if (takeBrc < minFillBrcOf(offer, minTrade)) return Promise.reject(new Error('below this offer’s minimum fill'));

    if (pairConfig(pair).chain === 'sol' && !this.addresses.sol()) {
      return Promise.reject(new Error('Solana wallet not set up'));
    }
    const weBuy = offer.side === 'sell-brc';
    if (!weBuy) {
      // We become the SELLER: the maker locks USDT the moment it accepts, so
      // an underfunded take would strand THEIR money behind the timelock.
      // Count BRC already promised to unfinished swaps, not just the balance.
      const need = this.reservedBrc() + takeBrc + BRC_LOCK_FEE_DEFAULT;
      if (this.node.myBalance() < need) {
        return Promise.reject(new Error('not enough BRC for this fill (amount + lock fee, on top of swaps already running)'));
      }
    }
    const secret = weBuy ? randomBytes32() : null;
    const hashlock = secret ? bytesToHex(sha256(secret)) : undefined;
    const takeId = bytesToHex(randomBytes32()).slice(0, 16);
    const now = Math.floor(Date.now() / 1000);
    const take: TakeMsg = {
      t: 'take',
      offerId: offer.id,
      ...(offer.pair ? { pair } : {}),
      takeId,
      taker: this.selfParty(),
      amountBrc: takeBrc.toString(),
      amountToken: takeToken.toString(),
      ...(hashlock ? { hashlock } : {}),
      evmTimelock: now + SWAP_TIMING.evmTimelockSecs,
      brcLocktime: now + SWAP_TIMING.brcLocktimeSecs,
    };

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTakes.delete(takeId);
        reject(new Error('maker did not respond (their tab may have just closed)'));
      }, 30_000);
      this.pendingTakes.set(takeId, {
        resolve: (accept) => {
          clearTimeout(timer);
          // Selling into a buy-brc offer: the hashlock comes from the maker.
          const agreedHashlock = hashlock ?? accept.hashlock ?? '';
          if (!/^[0-9a-f]{64}$/.test(agreedHashlock)) {
            reject(new Error('maker sent no valid hashlock'));
            return;
          }
          // Persist our side of the swap BEFORE anything moves on any chain.
          const swap: SwapRecord = {
            id: typeof accept.swapId === 'string' && accept.swapId ? accept.swapId : agreedHashlock,
            pair,
            role: weBuy ? 'buyer' : 'seller',
            origin: 'taker',
            offerId: offer.id,
            createdAt: now,
            updatedAt: now,
            amountBrc: takeBrc.toString(),
            amountToken: takeToken.toString(),
            ...(weBuy ? {} : { brcFeeWei: BRC_LOCK_FEE_DEFAULT.toString() }),
            hashlock: agreedHashlock,
            ...(secret ? { secret: bytesToHex(secret) } : {}),
            self: this.selfParty(),
            counterparty: offer.maker,
            evmTimelock: take.evmTimelock,
            brcLocktime: take.brcLocktime,
            evm: {}, brc: {},
            state: 'init',
          };
          this.store.put(swap);
          // Tell the maker we're engaged so a maker-buyer can safely lock its
          // token; a maker-seller ignores it and waits for our on-chain lock.
          void this.send(offer.maker.peerId, {
            t: 'confirm', offerId: offer.id, takeId, swapId: swap.id,
          });
          void this.engine.tick(swap.id);
          resolve(swap.id);
        },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      void this.send(offer.maker.peerId, take).then((delivered) => {
        if (!delivered) {
          const pending = this.pendingTakes.get(takeId);
          if (pending) {
            this.pendingTakes.delete(takeId);
            pending.reject(new Error('no market server reachable'));
          }
        }
      });
    });
  }

  /** Maker side: auto-accept a valid (possibly partial) take on a live offer. */
  private async onTake(take: TakeMsg): Promise<void> {
    const offer = this.ownOffers.find((o) => o.id === take.offerId);
    const rejectWith = (reason: string): Promise<boolean> =>
      this.send(take.taker.peerId, { t: 'reject', offerId: take.offerId, takeId: take.takeId, reason });
    if (!offer) { void rejectWith('offer no longer available'); return; }
    const pair = pairOf(offer);
    const chain = pairConfig(pair).chain;
    const minTrade = pairConfig(pair).minTradeUnits;
    if (!/^[0-9a-f]{64}$/.test(take.taker.brcPubkey)) { void rejectWith('bad BRC pubkey'); return; }
    // The taker needs a valid address on THIS pair's foreign chain.
    if (chain === 'evm' && !/^0x[0-9a-fA-F]{40}$/.test(take.taker.evmAddress)) { void rejectWith('bad EVM address'); return; }
    if (chain === 'sol' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(take.taker.solAddress ?? '')) { void rejectWith('bad Solana address'); return; }
    if (!/^[0-9a-f]{20}$/.test(take.taker.peerId)) { void rejectWith('bad mailbox id'); return; }

    // Fill amounts: any part of what's left, at EXACTLY the offer's price
    // (tokenForBrc is the canonical rounding both sides compute).
    let takeBrc = 0n;
    let takeToken = 0n;
    try {
      takeBrc = BigInt(take.amountBrc ?? '');
      takeToken = BigInt(take.amountToken ?? '');
    } catch { void rejectWith('bad fill amounts'); return; }
    if (takeBrc <= 0n || takeBrc > remainingBrcOf(offer)) { void rejectWith('amount exceeds the offer'); return; }
    if (takeToken !== tokenForBrc(offer, takeBrc)) { void rejectWith('fill price mismatch'); return; }
    if (takeToken < minTrade) { void rejectWith('trade below minimum size'); return; }
    if (takeBrc < minFillBrcOf(offer, minTrade)) { void rejectWith('fill below the offer minimum'); return; }

    // Timelock policy: reject anything that squeezes our claim window.
    const now = Math.floor(Date.now() / 1000);
    const evmWindow = take.evmTimelock - now;
    const brcWindow = take.brcLocktime - now;
    const gap = take.evmTimelock - take.brcLocktime;
    if (evmWindow < SWAP_TIMING.minEvmWindowSecs || evmWindow > 30 * 3600) { void rejectWith('bad EVM timelock'); return; }
    if (brcWindow < 10 * 3600 || brcWindow > 14 * 3600) { void rejectWith('bad BRC locktime'); return; }
    if (gap < SWAP_TIMING.minTimelockGapSecs) { void rejectWith('timelock gap too small'); return; }

    const weSell = offer.side === 'sell-brc';
    const lockFee = BigInt(offer.makerFeeWei ?? BRC_LOCK_FEE_DEFAULT.toString());
    let hashlock: string;
    let secret: Uint8Array | null = null;
    if (weSell) {
      // The taker is the buyer and must have committed to a secret.
      if (!/^[0-9a-f]{64}$/.test(take.hashlock ?? '')) { void rejectWith('bad hashlock'); return; }
      hashlock = take.hashlock!;
      // Enough BRC to actually lock this fill — counting what earlier fills
      // have already promised but not yet locked on-chain?
      if (this.node.myBalance() < this.reservedBrc() + takeBrc + lockFee) { void rejectWith('maker balance too low'); return; }
    } else {
      // Buy offer: WE are the buyer, so we generate and hold the secret.
      // Need enough of the pair's token for this fill plus the relayer's
      // lock fee, on top of what unfinished swaps have already committed.
      let balance: bigint | null = null;
      try { balance = await this.tokenBalance(pair); } catch { balance = null; }
      if (balance === null) { void rejectWith('maker cannot verify its balance'); return; }
      if (balance < this.reservedToken(pair) + takeToken + relayerFee(takeToken, LOCK_FEE_BPS, pairConfig(pair).feeMinUnits)) { void rejectWith('maker balance too low'); return; }
      // The balance check awaited — another take may have raced us. Re-check.
      if (!this.ownOffers.includes(offer) || takeBrc > remainingBrcOf(offer)) {
        void rejectWith('offer no longer available');
        return;
      }
      secret = randomBytes32();
      hashlock = bytesToHex(sha256(secret));
    }
    if (this.store.get(hashlock)) { void rejectWith('duplicate take'); return; }

    // Consume the fill: shrink the offer, delist it entirely once what's left
    // is gone or too small to ever be taken — by the platform floor OR by the
    // maker's own minimum fill (Binance-P2P-style: ads close below their min).
    const newRemaining = remainingBrcOf(offer) - takeBrc;
    if (newRemaining <= 0n || tokenForBrc(offer, newRemaining) < minTrade || newRemaining < makerMinBrcOf(offer)) {
      this.ownOffers = this.ownOffers.filter((o) => o.id !== offer.id);
      this.consumedOffers.add(offer.id);
      void this.postAll('/offers/delete', { offerId: offer.id, key: this.readKey });
    } else {
      offer.remainingBrc = newRemaining.toString();
      offer.ts = now;
      void this.postAll('/offers', { offer, key: this.readKey });
    }
    this.persistOwn();
    this.emit();

    const swapId = hashlock; // unique per swap: fresh secret => fresh hash
    const swap: SwapRecord = {
      id: swapId,
      pair,
      role: weSell ? 'seller' : 'buyer',
      origin: 'maker',
      offerId: offer.id,
      createdAt: now,
      updatedAt: now,
      amountBrc: takeBrc.toString(),
      amountToken: takeToken.toString(),
      ...(weSell ? { brcFeeWei: lockFee.toString() } : {}),
      hashlock,
      ...(secret ? { secret: bytesToHex(secret) } : {}),
      self: this.selfParty(),
      counterparty: take.taker,
      evmTimelock: take.evmTimelock,
      brcLocktime: take.brcLocktime,
      evm: {}, brc: {},
      // A maker-seller waits for the taker's on-chain lock before it commits, so
      // it can start immediately. A maker-BUYER locks its token first, so it
      // holds until the taker confirms — otherwise a take from a taker whose 30 s
      // window already lapsed would strand the maker's funds behind the timelock.
      state: weSell ? 'init' : 'awaiting-confirm',
    };
    this.store.put(swap);
    const accept: AcceptMsg = {
      t: 'accept',
      offerId: offer.id,
      ...(offer.pair ? { pair } : {}),
      takeId: take.takeId,
      swapId,
      // buy-brc: hand the taker (seller) the hashlock we generated; amounts
      // let market servers pair this fill with the on-chain claim (history).
      ...(weSell ? {} : { hashlock }),
      amountBrc: swap.amountBrc,
      amountToken: swap.amountToken,
    };
    await this.send(take.taker.peerId, accept);
    void this.engine.tick(swapId);
  }

  /** A maker-buyer that locks its token first stays in 'awaiting-confirm' until
   * this arrives — proof the taker got our accept and is proceeding — so its
   * funds are never stranded against a taker whose 30 s window already lapsed. */
  private onConfirm(msg: ConfirmMsg): void {
    const swap = this.store.get(msg.swapId);
    if (swap && swap.state === 'awaiting-confirm') {
      this.store.put({ ...swap, state: 'init', updatedAt: Math.floor(Date.now() / 1000) });
      void this.engine.tick(swap.id);
    }
  }
}
