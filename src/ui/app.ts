/** BrowserSwaps UI — vanilla TS, four tabs: Market, Swaps, Wallet, Settings.
 * Everything re-renders from live state on node/store/market events. */
import type { Node } from '@bc/node.js';
import type { PrivateKeyAccount } from 'viem/accounts';
import { loadSettings, saveSettings, activeNetwork, EVM_NETWORKS, MARKET, RELAY, BRC_LOCK_FEE_DEFAULT, BRC_LOCK_FEE_MIN, relayerFee, maxSendable, LOCK_FEE_BPS, CLAIM_FEE_BPS, WITHDRAW_FEE_BPS, PAIRS, DEFAULT_PAIR, UI_DEFAULT_PAIR, pairConfig, activeSolNetwork } from '../config.js';

/** Format basis points as a percent string, e.g. 40n -> "0.4%". */
const fmtBps = (bps: bigint): string => `${Number(bps) / 100}%`;
import type { MarketNetwork, HistoryTrade } from '../market/market.js';
import { makerMinBrcOf, minFillBrcOf, pairOf, remainingBrcOf, tokenForBrc, type Offer } from '../market/protocol.js';

/** Display price (token per 1 BRC) from an offer's defining totals — used by
 * the book sort, the book rows, and the fill modal so they can never differ. */
const offerPrice = (o: { amountBrc: string; amountToken: string }, tokenDecimals: number): number => {
  const brc = Number(BigInt(o.amountBrc)) / 1e8;
  return brc > 0 ? Number(BigInt(o.amountToken)) / 10 ** tokenDecimals / brc : Infinity;
};

/** Document Picture-in-Picture accessor (Chromium 116+ only, same pattern as
 * browserCoin's pop-out miner). The PiP window shares the opener's JS context
 * AND is never background-throttled — timers scheduled on it keep full cadence
 * while the main tab is minimized, and an open PiP window exempts the tab from
 * Chrome's freeze/discard. That's what keeps a minimized maker selling. */
interface PipApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  readonly window: Window | null;
}
const pipApi = (): PipApi | undefined =>
  (globalThis as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture;
import type { SwapEngine } from '../swap/engine.js';
import type { SwapStore } from '../swap/store.js';
import type { SwapRecord, SwapState } from '../swap/types.js';
import type { HtlcEvmAdapter } from '../evm/htlcAdapter.js';
import { exportEvmKey } from '../evm/wallet.js';
import { SOL_WITHDRAW_ATA_FEE_UNITS, type HtlcSolAdapter } from '../sol/htlcAdapter.js';
import { exportSolKey } from '../sol/wallet.js';
import { el, formatBrc, parseBrc, formatUnits, parseUnits, short, timeAgo } from './format.js';
import { bytesToHex } from '../util/hex.js';
import { addressFromHex } from '@bc/crypto/keys.js';
import { isRedeem } from '@bc/chain/transaction.js';
import QRCode from 'qrcode';

export interface AppCtx {
  node: Node;
  store: SwapStore;
  engine: SwapEngine;
  market: MarketNetwork;
  account: PrivateKeyAccount;
  /** null until the HTLC contract is configured in Settings. */
  evm: () => HtlcEvmAdapter | null;
  /** Solana trading-wallet address (base58). */
  solAccount: string;
  /** Per-pair foreign-chain adapter; null until that pair is configured. */
  foreign: (pair?: string) => HtlcEvmAdapter | HtlcSolAdapter | null;
}

const BUYER_STEPS: SwapState[] = ['awaiting-confirm', 'init', 'evm-locking', 'evm-locked', 'awaiting-brc-lock', 'brc-claiming', 'done'];
const SELLER_STEPS: SwapState[] = ['init', 'awaiting-evm-lock', 'brc-locking', 'brc-locked', 'evm-claiming', 'done'];

interface StateInfo { label: string; detail: string; eta: string }
const STATE_INFO: Record<SwapState, StateInfo> = {
  'init': { label: 'Starting…', detail: 'Setting up the swap.', eta: 'a few seconds' },
  'awaiting-confirm': {
    label: 'Confirming with the other side…',
    detail: 'Making sure your counterparty is still connected before anything is locked. Nothing is committed yet — if they’ve gone, this cancels automatically with no funds moved.',
    eta: 'a few seconds',
  },
  'evm-locking': {
    label: 'Locking your USDT…',
    detail: 'Your USDT is going into the escrow contract on Arbitrum. From there it can only ever reach the seller if they deliver the BRC — or come back to you.',
    eta: '10–30 seconds',
  },
  'evm-locked': { label: 'USDT locked ✓', detail: 'Payment escrowed. Notifying the seller…', eta: 'seconds' },
  'awaiting-brc-lock': {
    label: 'Waiting for the seller’s BRC…',
    detail: 'The seller’s tab is verifying your escrowed payment and locking the BRC on-chain. Your tab claims it automatically once it has 3 confirmations. Nothing to do — leave this tab open.',
    eta: 'typically 5–15 minutes',
  },
  'brc-claiming': {
    label: 'Claiming your BRC…',
    detail: 'Your claim is being mined into the BrowserCoin chain. This same step automatically releases the escrowed USDT to the seller — that’s what makes the swap atomic.',
    eta: '2–5 minutes (next block)',
  },
  'awaiting-evm-lock': {
    label: 'Verifying buyer’s payment…',
    detail: 'Cross-checking the buyer’s USDT escrow on several independent servers before committing any BRC.',
    eta: '1–2 minutes',
  },
  'brc-locking': { label: 'Locking your BRC…', detail: 'Broadcasting the BRC lock transaction.', eta: 'seconds' },
  'brc-locked': {
    label: 'Waiting for buyer to claim…',
    detail: 'The buyer’s tab claims the BRC once it has 3 confirmations (~8 min of blocks). Their claim automatically releases the USDT to your Arbitrum wallet. Nothing to do — leave this tab open.',
    eta: 'typically 5–20 minutes',
  },
  'evm-claiming': { label: 'Collecting your USDT…', detail: 'Submitting the claim on Arbitrum.', eta: '10–30 seconds' },
  'done': { label: 'Complete ✓', detail: '', eta: '' },
  'refunding': {
    label: 'Refunding…',
    detail: 'The swap didn’t complete, so both sides get their money back. Refunds unlock after a safety timelock — funds are never lost, this can just take a while.',
    eta: 'up to the timelock (hours)',
  },
  'refunded': { label: 'Refunded', detail: 'Your funds are back in your wallet.', eta: '' },
  'failed': { label: 'Failed', detail: '', eta: '' },
};

export function mountApp(root: HTMLElement, ctx: AppCtx): void {
  const net = (): ReturnType<typeof activeNetwork> => activeNetwork(loadSettings());
  let tab: 'market' | 'swaps' | 'history' | 'developer' | 'settings' = 'market';
  let historyTrades: HistoryTrade[] = [];
  let historyFetchedAt = 0;
  let helpOpen = false;
  let postSide: 'sell-brc' | 'buy-brc' = 'sell-brc';
  let fillOfferId: string | null = null;
  let fillBusy = false;
  // Two-step fill: the first click reviews, the second commits — a swap is an
  // irreversible on-chain action, so it never fires on a single click. The
  // reviewed amount is captured here so the confirm step never re-reads the
  // input mid-render (which briefly holds its full-remaining default, not what
  // the user typed).
  let fillConfirming = false;
  let fillAmountBrc: bigint | null = null;
  // Order-book sort. 'price' keeps the classic exchange layout (asks
  // priciest-first above the spread, bids highest-first below); 'amount' and
  // 'total' re-sort both sides by size. Persisted so the choice survives
  // re-renders and reloads. Depth bars and the spread stay price-based.
  type BookSortKey = 'price' | 'amount' | 'total';
  let bookSort: { key: BookSortKey; dir: 'asc' | 'desc' } = (() => {
    try {
      const s = JSON.parse(localStorage.getItem('bswap.booksort.v1') ?? 'null');
      if (s && ['price', 'amount', 'total'].includes(s.key) && ['asc', 'desc'].includes(s.dir)) return s;
    } catch { /* fall through to default */ }
    return { key: 'price', dir: 'desc' };
  })();
  // Order-book pagination: at most this many rows per side; separate page index
  // per side. Page position is per-session (not persisted) and resets whenever
  // the sort or the pair changes so you're never stranded on a stale page.
  const BOOK_PAGE_SIZE = 12;
  let bookPage = { ask: 0, bid: 0 };
  const setBookSort = (key: BookSortKey): void => {
    // Same column → flip direction; new column → start descending (big/pricey first).
    bookSort = { key, dir: bookSort.key === key && bookSort.dir === 'desc' ? 'asc' : 'desc' };
    bookPage = { ask: 0, bid: 0 };
    localStorage.setItem('bswap.booksort.v1', JSON.stringify(bookSort));
    render();
  };
  // Active trading pair (market tab shows one pair's book at a time).
  let marketPair = PAIRS[localStorage.getItem('bswap.pair.v1') ?? ''] ? localStorage.getItem('bswap.pair.v1')! : UI_DEFAULT_PAIR;
  // Foreign-chain balances per pair: token units + native gas coin (wei/lamports).
  const balances = new Map<string, { token: bigint; gas: bigint; ok: boolean }>();
  const balOf = (pair: string): { token: bigint; gas: bigint; ok: boolean } =>
    balances.get(pair) ?? { token: 0n, gas: 0n, ok: false };
  let toastMsg = '';
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  /** Throttled trade-history refresh, shared by the book's spread row and the
   * History tab (both just read `historyTrades`). */
  const ensureHistory = (): void => {
    if (Date.now() - historyFetchedAt <= 15_000) return;
    historyFetchedAt = Date.now();
    void ctx.market.fetchHistory().then((trades) => {
      historyTrades = trades;
      scheduleRender();
    });
  };

  const toast = (msg: string): void => {
    toastMsg = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastMsg = ''; render(); }, 6000);
    render();
  };

  // ------------------------------------------------- PiP keep-alive window

  let pipWindow: Window | null = null;

  async function openKeeper(): Promise<void> {
    const api = pipApi();
    if (!api) return;
    if (pipWindow) { pipWindow.focus(); return; }
    const pip = await api.requestWindow({ width: 300, height: 190 });
    pipWindow = pip;
    const doc = pip.document;
    doc.title = 'BrowserSwaps — keeping offers live';
    // PiP documents start blank: replicate our stylesheets (same approach as
    // browserCoin's pop-out miner; cross-origin sheets get re-linked).
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        const style = doc.createElement('style');
        style.textContent = Array.from(sheet.cssRules).map((r) => r.cssText).join('\n');
        doc.head.appendChild(style);
      } catch {
        if (sheet.href) {
          const link = doc.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          doc.head.appendChild(link);
        }
      }
    }
    doc.body.className = 'pip-body';
    const root = doc.createElement('div');
    root.className = 'pip-keeper';
    doc.body.appendChild(root);

    const refresh = (): void => {
      const offers = ctx.market.myOffers().length;
      const active = ctx.store.all().filter((s) => !['done', 'refunded', 'failed'].includes(s.state));
      const mkt = ctx.market.status();
      const swapLines = active.slice(0, 2).map((s) => {
        const what = s.role === 'buyer' ? 'Buying' : 'Selling';
        const info = STATE_INFO[s.state] ?? { label: s.state };
        return `<div class="pip-line">${what} ${formatBrc(BigInt(s.amountBrc))} BRC — ${info.label}</div>`;
      }).join('');
      root.innerHTML = `
        <div class="pip-status${mkt.online ? '' : ' off'}"><span class="dot"></span> market ${mkt.online ? 'connected' : 'unreachable'}</div>
        <div class="pip-big">${offers} offer${offers === 1 ? '' : 's'} live · ${active.length} swap${active.length === 1 ? '' : 's'} running</div>
        ${swapLines}
        <div class="pip-line">Runs at full speed while this window is open — the main tab can stay minimized (just don’t close it).</div>`;
    };

    // The point of the exercise: the market + engine cadence on the PiP
    // window's NEVER-throttled clock. The tab's own (throttled) timers keep
    // running in parallel; every operation is idempotent.
    pip.setInterval(() => ctx.market.poke('mailbox'), MARKET.mailboxPollMs);
    pip.setInterval(() => ctx.market.poke('offers'), MARKET.offerPollMs);
    pip.setInterval(() => ctx.market.poke('heartbeat'), MARKET.offerHeartbeatMs);
    pip.setInterval(() => { void ctx.engine.tickAll(); }, MARKET.engineTickMs);
    pip.setInterval(refresh, 1000);
    refresh();

    // User closed the pop-up window: its timers die with it, just drop the handle.
    pip.addEventListener('pagehide', () => {
      pipWindow = null;
      scheduleRender();
    });
    render();
  }

  /** Trigger button for the keeper; '' where Document PiP isn't available. */
  const keeperBtn = (): HTMLElement | '' => {
    if (!pipApi()) return '';
    const b = el('button', {
      class: 'btn ghost',
      title: 'Opens a small always-on-top window that keeps your offers and swaps running at full speed while this tab is minimized (Chrome/Edge).',
    }, pipWindow ? '📌 Pop-up window open ✓' : '📌 Keep alive in pop-up window') as HTMLButtonElement;
    b.onclick = () => { void openKeeper(); };
    return b;
  };

  // ------------------------------------------------------------- header

  function header(): HTMLElement {
    const sync = ctx.node.getSyncStatus();
    const active = ctx.store.all().filter((s) => !['done', 'refunded', 'failed'].includes(s.state)).length;
    const mkt = ctx.market.status();
    const mktStat = el('span', {
      class: `stat ${mkt.online ? 'live' : 'off'}`,
      title: mkt.online ? 'market server reachable' : `market unreachable: ${mkt.lastError}`,
    }, mkt.online ? 'market ✓' : 'market ✗');
    return el('header', { class: 'topbar' },
      el('div', { class: 'brand' }, 'Browser', el('span', { class: 'accent' }, 'Swaps')),
      el('div', { class: 'stats' },
        mktStat,
        stat(`BRC ${formatBrc(ctx.node.myBalance())}`, true),
        stat(`${pairConfig(marketPair).tokenSymbol} ${balOf(marketPair).ok ? formatUnits(balOf(marketPair).token, pairConfig(marketPair).tokenDecimals, pairConfig(marketPair).displayDecimals) : '—'}`, balOf(marketPair).ok),
        pairConfig(marketPair).chain === 'evm'
          ? stat(`⛽ ${balOf(marketPair).ok ? formatUnits(balOf(marketPair).gas, 18, 5) : '—'} ETH`, balOf(marketPair).ok)
          : stat(`⛽ ${balOf(marketPair).ok ? formatUnits(balOf(marketPair).gas, 9, 4) : '—'} SOL`, balOf(marketPair).ok),
        stat(sync.syncing ? `syncing ${sync.localHeight}/${sync.targetHeight}` : `height ${ctx.node.chain.height}`, !sync.syncing),
        active > 0 ? stat(`${active} swap${active > 1 ? 's' : ''} active`, true) : '',
      ),
      el('nav', { class: 'tabs' },
        ...(['market', 'swaps', 'history', 'developer', 'settings'] as const).map((t) => {
          const b = el('button', { class: t === tab ? 'tab active' : 'tab' }, t[0]!.toUpperCase() + t.slice(1));
          b.onclick = () => { tab = t; render(); };
          return b;
        }),
      ),
    );
  }

  const stat = (text: string, live: boolean): HTMLElement =>
    el('span', { class: `stat ${live ? 'live' : 'off'}` }, text);

  function footer(): HTMLElement {
    return el('footer', { class: 'site-footer' },
      el('span', { class: 'muted' }, 'BrowserSwaps — non-custodial BRC ⇄ USDT atomic swaps'),
      el('a', {
        class: 'gh-link',
        href: 'https://github.com/swompythesecond/browserSwaps',
        target: '_blank',
        rel: 'noopener noreferrer',
      }, '↗ Source on GitHub'),
    );
  }

  // QR canvases are cached by content so background re-renders reuse the same
  // element instead of redrawing (and flickering) every few seconds.
  const qrCache = new Map<string, HTMLCanvasElement>();
  function qr(text: string): HTMLCanvasElement {
    let canvas = qrCache.get(text);
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'qr';
      canvas.title = text;
      void QRCode.toCanvas(canvas, text, {
        width: 112,
        margin: 1,
        color: { dark: '#0d1117', light: '#e6edf3' },
      });
      qrCache.set(text, canvas);
    }
    return canvas;
  }

  // ------------------------------------------------------------- market tab

  /** Full-page takeover while the chain syncs: trading MUST NOT look usable
   * before the node can verify anything, and quiet background syncing just
   * confuses people. */
  function syncScreen(): HTMLElement {
    const sync = ctx.node.getSyncStatus();
    const PHASE_LABEL: Record<string, string> = {
      restoring: 'Restoring saved chain from this browser…',
      connecting: 'Connecting to the BrowserCoin network…',
      fetching: 'Downloading blocks…',
      verifying: 'Verifying proof-of-work…',
      headers: 'Downloading & verifying block headers…',
      snapshot: 'Verifying the account snapshot…',
      offline: 'Network unreachable — retrying…',
      ready: 'Finishing…',
    };
    // Fast-sync phases report through `aux` — the chain height itself doesn't
    // move until the verified anchor is seeded in one step at the end, so the
    // block counter would sit frozen for the whole download and look stuck.
    const fast = (sync.phase === 'headers' || sync.phase === 'snapshot') && sync.aux && sync.aux.total > 0
      ? sync.aux : null;
    const pct = fast
      ? Math.min(100, Math.round((fast.done / fast.total) * 100))
      : sync.targetHeight > 0
        ? Math.min(100, Math.round((sync.localHeight / sync.targetHeight) * 100))
        : 0;
    const detail = fast
      ? (sync.phase === 'headers' ? `(header ${fast.done.toLocaleString()} of ${fast.total.toLocaleString()})` : '')
      : sync.targetHeight > 0 ? `(block ${sync.localHeight.toLocaleString()} of ${sync.targetHeight.toLocaleString()})` : '';
    return el('section', { class: 'view' },
      el('div', { class: 'card sync-card' },
        el('h3', {}, 'Syncing the BrowserCoin chain'),
        el('p', { class: 'muted' },
          'Your tab verifies the blockchain itself — headers, proof-of-work and account state — so no server can lie to you about a trade. ',
          'First visit takes a few minutes; after that it resumes instantly.'),
        el('div', { class: 'progress big' }, el('div', { class: 'bar', style: `width:${pct}%` })),
        el('p', { class: 'muted' },
          `${PHASE_LABEL[sync.phase] ?? sync.phase} `,
          detail),
        // Why ISN'T this a fast sync? (attempt failed / helpers too old /
        // helpers unreachable) — without this line a phone user just sees a
        // slow grind and has no console to find out why.
        sync.fastSyncNote ? el('p', { class: 'text-sm sync-note' }, sync.fastSyncNote) : '',
        el('p', { class: 'muted text-sm' }, 'Trading unlocks automatically when the chain is verified. Active swaps resume on their own.'),
      ),
    );
  }

  function marketView(): HTMLElement {
    if (ctx.node.getSyncStatus().syncing) return syncScreen();
    const view = el('section', { class: 'view' });
    const pc = pairConfig(marketPair);
    const sym = pc.tokenSymbol;
    const dec = pc.tokenDecimals;
    const disp = pc.displayDecimals;
    const minTrade = pc.minTradeUnits;
    const feeFloor = pc.feeMinUnits;
    const onSol = pc.chain === 'sol';
    const chainName = onSol ? 'Solana' : 'Arbitrum One';
    const cfgReady = onSol
      ? Boolean(activeSolNetwork(pc.network).htlcProgram)
      : Boolean(net().htlc && net().token);

    // --- markets overview: every pair at a glance, whole market in one look;
    // the highlighted row is the open book, clicking another switches to it.
    ensureHistory();
    const allOffers = ctx.market.book();
    const nowSecs = Math.floor(Date.now() / 1000);
    const overviewRows = Object.values(PAIRS).map((p) => {
      const offers = allOffers.filter((o) => pairOf(o) === p.key && remainingBrcOf(o) > 0n);
      const askPrices = offers.filter((o) => o.side === 'sell-brc').map((o) => offerPrice(o, p.tokenDecimals)).filter(Number.isFinite);
      const bidPrices = offers.filter((o) => o.side === 'buy-brc').map((o) => offerPrice(o, p.tokenDecimals)).filter(Number.isFinite);
      const trades = historyTrades.filter((t) => (t.pair ?? DEFAULT_PAIR) === p.key);
      const day = trades.filter((t) => nowSecs - t.ts < 86_400);
      const dayVol = day.reduce((a, t) => a + BigInt(t.amountToken), 0n);
      const lastTrade = trades.length ? trades[trades.length - 1]!.price : null;
      const bal = balOf(p.key);
      const row = el('div', {
        class: `mkt-row${p.key === marketPair ? ' active' : ''}`,
        title: p.key === marketPair ? 'this book is open below' : `open the ${p.label} book`,
      },
        el('span', { class: 'mkt-name' }, p.label),
        el('span', { class: 'price' }, lastTrade !== null ? lastTrade.toFixed(6) : '—'),
        el('span', {}, bidPrices.length ? Math.max(...bidPrices).toFixed(6) : '—'),
        el('span', {}, askPrices.length ? Math.min(...askPrices).toFixed(6) : '—'),
        el('span', {}, `${formatUnits(dayVol, p.tokenDecimals, p.displayDecimals)} ${p.tokenSymbol}`),
        el('span', {}, `${askPrices.length} sell · ${bidPrices.length} buy`),
        el('span', {}, bal.ok ? `${formatUnits(bal.token, p.tokenDecimals, p.displayDecimals)} ${p.tokenSymbol}` : '—'),
      );
      row.onclick = () => {
        marketPair = p.key;
        bookPage = { ask: 0, bid: 0 };
        localStorage.setItem('bswap.pair.v1', p.key);
        render();
      };
      return row;
    });
    view.append(el('div', { class: 'card' },
      el('div', { class: 'row spread' },
        el('h3', {}, 'Markets'),
        el('span', { class: 'muted' }, 'prices in token per 1 BRC · click a market to trade it'),
      ),
      el('div', { class: 'mkt-table' },
        el('div', { class: 'mkt-head' },
          el('span', {}, 'Market'), el('span', {}, 'Last'), el('span', {}, 'Best bid'),
          el('span', {}, 'Best ask'), el('span', {}, '24h volume'), el('span', {}, 'Offers'),
          el('span', {}, 'Your balance'),
        ),
        ...overviewRows,
      ),
    ));

    if (!cfgReady) {
      view.append(el('div', { class: 'banner warn' },
        `No HTLC ${onSol ? 'program' : 'contract'} configured for ${pc.label} yet — set it in Settings before trading here.`
        + (onSol ? '' : ' Deploy with: node scripts/deploy-htlc.mjs ' + loadSettings().network)));
    }

    // --- happening now: active swaps live where people actually look ---
    const activeSwaps = ctx.store.all().filter((s) => !['done', 'refunded', 'failed'].includes(s.state));
    if (activeSwaps.length > 0) {
      view.append(el('div', { class: 'card happening' },
        el('div', { class: 'row spread' },
          el('h3', {}, `Happening now (${activeSwaps.length})`),
          keeperBtn(),
        ),
        el('div', { class: 'banner danger' },
          el('strong', {}, '⚠ Keep this tab open until every swap finishes. '),
          'Your tab is doing the work — closing it now pauses the swap and can lock your funds behind a safety timer for hours. It’s safe to close only once all swaps below read “Complete”.'),
        ...activeSwaps.map((s) => swapCard(s)),
      ));
    }

    // --- live-offer reminder: presence IS the product, say so loudly ---
    const liveOffers = ctx.market.myOffers().length;
    if (liveOffers > 0) {
      view.append(el('div', { class: 'banner live' },
        el('div', { class: 'row spread' },
          el('span', {},
            `● ${liveOffers} offer${liveOffers > 1 ? 's' : ''} live — keep this tab open. `,
            'Fills complete automatically; closing this tab takes your offer off the market within seconds.'
            + (pipApi() ? ' Minimizing is fine while the pop-up window is open.' : '')),
          keeperBtn(),
        )));
    }

    // --- book data (computed early: the quick-trade strip needs it too) ---
    ensureHistory(); // the spread row shows the last on-chain trade price
    interface BookRow { offer: Offer; remaining: bigint; total: bigint; price: number; mine: boolean }
    const mine = new Set(ctx.market.myOffers().map((o) => o.id));
    const rows: BookRow[] = ctx.market.book()
      .filter((o) => pairOf(o) === marketPair)
      .map((o) => {
        const remaining = remainingBrcOf(o);
        return { offer: o, remaining, total: tokenForBrc(o, remaining), price: offerPrice(o, dec), mine: mine.has(o.id) };
      })
      .filter((r) => r.remaining > 0n && Number.isFinite(r.price));
    // Asks (makers selling BRC) sit ABOVE the spread, priciest first, so the
    // cheapest ask touches the spread row; bids sit below, best (highest)
    // first. That's the layout every exchange trains people on.
    const asks = rows.filter((r) => r.offer.side === 'sell-brc').sort((a, b) => b.price - a.price);
    const bids = rows.filter((r) => r.offer.side === 'buy-brc').sort((a, b) => b.price - a.price);
    const openFill = (offerId: string): void => {
      if (!cfgReady) { toast('Configure the HTLC contract in Settings first.'); return; }
      fillOfferId = offerId;
      fillBusy = false;
      fillConfirming = false;
      fillAmountBrc = null;
      render();
    };

    // --- quick trade: best price each way, one click, zero reading ---
    const bestAskRow = [...asks].reverse().find((r) => !r.mine) ?? null; // cheapest sell that isn't ours
    const bestBidRow = bids.find((r) => !r.mine) ?? null;                // highest bid that isn't ours
    const quickTile = (label: string, r: BookRow | null, empty: string): HTMLElement => {
      const cell = el('div', { class: 'wallet-cell' }, el('div', { class: 'label-sm' }, label));
      if (!r) {
        cell.append(el('p', { class: 'muted' }, empty));
        return cell;
      }
      const isAsk = r.offer.side === 'sell-brc';
      const btn = el('button', { class: 'btn primary' }, isAsk ? 'Buy' : 'Sell') as HTMLButtonElement;
      btn.onclick = () => openFill(r.offer.id);
      cell.append(el('div', { class: 'row spread' },
        el('div', { class: 'col' },
          el('strong', { class: 'quick-price' }, `${r.price.toFixed(6)} ${sym}/BRC`),
          el('span', { class: 'muted' }, `${formatBrc(r.remaining)} BRC ${isAsk ? 'available' : 'wanted'} — partial amounts ok`),
        ),
        btn,
      ));
      return cell;
    };
    view.append(el('div', { class: 'card' },
      el('h3', {}, 'Quick trade'),
      el('div', { class: 'wallets' },
        quickTile('Buy BRC — cheapest offer', bestAskRow, 'No sell offers right now.'),
        quickTile('Sell BRC — best bid', bestBidRow, 'No buy offers right now.'),
      ),
    ));

    // --- wallet strip: balances + funding addresses without leaving the page ---
    const brcBal = ctx.node.myBalance();
    view.append(el('div', { class: 'card' },
      el('div', { class: 'wallets' },
        el('div', { class: 'wallet-cell' },
          el('div', { class: 'label-sm' }, 'BRC trading wallet'),
          el('div', { class: 'row' },
            qr(bytesToHex(ctx.node.wallet.publicKey)),
            el('div', { class: 'col grow' },
              el('strong', {}, `${formatBrc(brcBal)} BRC`),
              el('code', { class: 'addr sm' }, bytesToHex(ctx.node.wallet.publicKey)),
            ),
          ),
        ),
        el('div', { class: 'wallet-cell' },
          el('div', { class: 'label-sm' }, `${sym} trading wallet (${chainName})`),
          el('div', { class: 'row' },
            // Bare address — the universal "receive address" QR format (what
            // exchanges and MoonPay's own deposit QRs use). URI formats like
            // EIP-681 / solana-pay are payment requests and some on-ramp
            // scanners reject them for token sends.
            qr(onSol ? ctx.solAccount : ctx.account.address),
            el('div', { class: 'col grow' },
              el('strong', {}, balOf(marketPair).ok ? `${formatUnits(balOf(marketPair).token, dec, disp)} ${sym}` : '—'),
              el('code', { class: 'addr sm' }, onSol ? ctx.solAccount : ctx.account.address),
            ),
          ),
          // The #1 way users lose deposits: right token, WRONG network. Say it
          // at the QR itself — nobody opens the help modal before pasting.
          el('div', { class: 'fund-warn' },
            el('strong', {}, `⚠ ${sym} on ${chainName} only. `),
            onSol
              ? `${sym} sent on any other network (Ethereum, Base, Tron, …) or any other coin will NOT arrive here. When withdrawing from an exchange, the network dropdown must say “Solana” (SOL/SPL).`
              : `${sym} sent on any other network (Ethereum mainnet, Tron, BSC, …) or plain ETH will NOT show up as balance here. When buying or withdrawing, the network dropdown must say “Arbitrum One”.`),
        ),
      ),
      el('p', { class: 'muted text-sm' },
        'Fund by sending to these addresses. Send a small test amount first. Key backups are in Settings.'),
      getUsdtHelp(),
    ));

    // --- post offer (sell or buy) ---
    const selling = postSide === 'sell-brc';
    const sideBtns = ([['sell-brc', 'Sell BRC'], ['buy-brc', 'Buy BRC']] as const).map(([side, label]) => {
      const b = el('button', { class: postSide === side ? 'btn primary' : 'btn ghost' }, label) as HTMLButtonElement;
      b.onclick = () => { postSide = side; render(); };
      return b;
    });
    const amountIn = el('input', { placeholder: 'BRC amount (e.g. 100)', class: 'input', 'data-keep': 'offer-brc' }) as HTMLInputElement;
    const feeIn = el('input', {
      class: 'input slim', 'data-keep': 'offer-fee', value: formatBrc(BRC_LOCK_FEE_DEFAULT),
      title: 'BRC network fee for the lock transaction. Raise it if you want your sale mined faster.',
    }) as HTMLInputElement;
    const priceIn = el('input', { placeholder: `total ${sym} (e.g. 5)`, class: 'input', 'data-keep': 'offer-usdt' }) as HTMLInputElement;
    const minIn = el('input', {
      placeholder: 'any', class: 'input slim', 'data-keep': 'offer-min',
      title: 'Smallest slice someone may take. Leave empty to allow any partial fill; set it to the full amount for all-or-nothing.',
    }) as HTMLInputElement;
    const currentMinFill = (): bigint => {
      try { return parseBrc(minIn.value || '0'); } catch { return 0n; }
    };
    const currentFee = (): bigint => {
      try {
        const f = parseBrc(feeIn.value || '0');
        return f >= BRC_LOCK_FEE_MIN ? f : BRC_LOCK_FEE_MIN;
      } catch { return BRC_LOCK_FEE_MIN; }
    };
    const maxBtn = el('button', {
      class: 'btn ghost',
      title: selling ? 'balance minus the network fee' : `all the ${sym} in your wallet minus the relayer fee`,
    }, selling ? 'Sell all' : 'Spend all') as HTMLButtonElement;
    maxBtn.onclick = () => {
      if (selling) {
        const fee = currentFee();
        amountIn.value = formatBrc(brcBal > fee ? brcBal - fee : 0n);
        amountIn.dispatchEvent(new Event('input'));
        amountIn.focus();
      } else if (balOf(marketPair).ok) {
        priceIn.value = formatUnits(maxSendable(balOf(marketPair).token, LOCK_FEE_BPS, feeFloor), dec, dec);
        priceIn.dispatchEvent(new Event('input'));
        priceIn.focus();
      }
    };
    const postBtn = el('button', { class: 'btn primary' }, selling ? 'Post sell offer' : 'Post buy offer') as HTMLButtonElement;
    const feeInfo = el('p', { class: 'muted text-sm' });
    const updateFeeInfo = (): void => {
      const lines: string[] = [];
      let brc = 0n;
      let usdt = 0n;
      try { brc = parseBrc(amountIn.value || '0'); } catch { /* mid-typing */ }
      try { usdt = parseUnits(priceIn.value || '0', dec); } catch { /* mid-typing */ }
      if (selling) {
        const fee = currentFee();
        if (brc > 0n) {
          const total = brc + fee;
          lines.push(
            `Total deducted when it sells: ${formatBrc(brc)} + ${formatBrc(fee)} network fee `
            + `= ${formatBrc(total)} BRC${total === brcBal ? ' (your full balance)' : ''}.`);
          if (total > brcBal) {
            lines.push(`⚠ That exceeds your balance of ${formatBrc(brcBal)} BRC — lower the amount or use Sell all.`);
          }
        }
        if (brc > 0n && usdt > 0n) {
          const relayFee = relayerFee(usdt, CLAIM_FEE_BPS, feeFloor);
          const receive = usdt > relayFee ? usdt - relayFee : 0n;
          lines.push(
            `When it sells you receive ≈ ${formatUnits(receive, dec, disp)} ${sym} `
            + `— the price minus a ${formatUnits(relayFee, dec, disp)} ${sym} `
            + `relayer fee (${fmtBps(CLAIM_FEE_BPS)}, min ${formatUnits(feeFloor, dec, disp)}) which pays the ${chainName} gas for you.`);
        }
      } else if (brc > 0n && usdt > 0n) {
        const lockFee = relayerFee(usdt, LOCK_FEE_BPS, feeFloor);
        lines.push(
          `When it fills you pay ${formatUnits(usdt, dec, disp)} ${sym} `
          + `+ a ${formatUnits(lockFee, dec, disp)} ${sym} relayer fee `
          + `(${fmtBps(LOCK_FEE_BPS)}, min ${formatUnits(feeFloor, dec, disp)}) which pays the ${chainName} gas for you, `
          + `and receive ${formatBrc(brc)} BRC.`);
        if (balOf(marketPair).ok && usdt + lockFee > balOf(marketPair).token) {
          lines.push(`⚠ That exceeds your balance of ${formatUnits(balOf(marketPair).token, dec, disp)} ${sym} — lower the price or use Spend all.`);
        }
      }
      if (brc > 0n && usdt >= minTrade) {
        const minFill = currentMinFill();
        if (minFill >= brc && minFill > 0n) {
          lines.push('All-or-nothing: takers must fill the whole offer at once.');
        } else if (minFill > 0n) {
          lines.push(`Partial fills allowed from ${formatBrc(minFill)} BRC up; once the remainder drops below that it delists automatically (nothing is lost).`);
        } else {
          lines.push(`Anyone can fill your offer partially (any slice worth at least ${formatUnits(minTrade, dec, disp)} ${sym}); the rest stays listed. Set a min fill to limit that.`);
        }
      }
      feeInfo.replaceChildren(...lines.map((t) => el('div', {}, t)));
    };
    amountIn.addEventListener('input', updateFeeInfo);
    feeIn.addEventListener('input', updateFeeInfo);
    priceIn.addEventListener('input', updateFeeInfo);
    minIn.addEventListener('input', updateFeeInfo);
    // Self-healing fee: empty, zero, or below-minimum snaps back to a valid
    // value the moment the field loses focus — a cleared field can never
    // produce a broken offer.
    feeIn.addEventListener('blur', () => {
      feeIn.value = formatBrc(currentFee());
      updateFeeInfo();
    });
    updateFeeInfo();
    postBtn.onclick = () => {
      try {
        const brc = parseBrc(amountIn.value);
        const usdt = parseUnits(priceIn.value, dec);
        if (brc <= 0n || usdt <= 0n) throw new Error('amounts must be positive');
        if (usdt < minTrade) throw new Error(`minimum price is ${formatUnits(minTrade, dec, disp)} ${sym} — smaller trades get eaten by the network relayer fees`);
        const minFill = currentMinFill();
        if (minFill > brc) throw new Error('the minimum fill can’t exceed the offer amount');
        if (selling) {
          // currentFee() clamps empty/invalid/too-low input to the minimum, so
          // a blank fee field can never block or break an offer.
          const fee = currentFee();
          feeIn.value = formatBrc(fee);
          if (ctx.node.myBalance() < brc + fee) {
            throw new Error(`you need ${formatBrc(brc + fee)} BRC (amount + ${formatBrc(fee)} network fee) — you have ${formatBrc(ctx.node.myBalance())}`);
          }
          ctx.market.postOffer('sell-brc', brc, usdt, { feeWei: fee, minBrc: minFill, pair: marketPair });
        } else {
          if (!cfgReady) throw new Error(`configure the ${pc.label} HTLC in Settings first`);
          const needed = usdt + relayerFee(usdt, LOCK_FEE_BPS, feeFloor);
          if (!balOf(marketPair).ok || balOf(marketPair).token < needed) {
            throw new Error(`you need ${formatUnits(needed, dec, disp)} ${sym} in your trading wallet (price + relayer fee)`);
          }
          ctx.market.postOffer('buy-brc', brc, usdt, { minBrc: minFill, pair: marketPair });
        }
        amountIn.value = ''; priceIn.value = ''; minIn.value = '';
        toast('Offer posted. It stays live while this tab is open.');
      } catch (e) { toast((e as Error).message); }
    };
    view.append(el('div', { class: 'card' },
      el('div', { class: 'row spread' },
        el('h3', {}, 'Post an offer'),
        el('div', { class: 'row' }, ...sideBtns),
      ),
      el('p', { class: 'muted' },
        '⚠ An offer requires this tab to STAY OPEN: your tab is the market maker — it fills automatically, no clicks needed. Closing it takes the offer off the market within seconds (nothing is lost; re-open and it re-lists).'),
      el('div', { class: 'row' },
        el('label', { class: 'field' }, selling ? 'Amount (BRC)' : 'Amount to buy (BRC)', amountIn),
        maxBtn,
        selling ? el('label', { class: 'field' }, 'Network fee (BRC)', feeIn) : '',
        el('label', { class: 'field' }, `Price (${sym} total)`, priceIn),
        el('label', { class: 'field' }, 'Min fill (BRC, optional)', minIn),
        postBtn,
      ),
      feeInfo,
    ));

    // --- order book: sells above the spread, buys below, depth bars ---
    // Depth: cumulative size measured from the spread outward, both sides
    // normalized to the same scale so bar lengths are comparable.
    const askCum: bigint[] = new Array<bigint>(asks.length);
    let acc = 0n;
    for (let i = asks.length - 1; i >= 0; i--) { acc += asks[i]!.total; askCum[i] = acc; }
    const askMax = acc;
    const bidCum: bigint[] = new Array<bigint>(bids.length);
    acc = 0n;
    for (let i = 0; i < bids.length; i++) { acc += bids[i]!.total; bidCum[i] = acc; }
    const maxCum = (askMax > acc ? askMax : acc) || 1n;

    // Depth is a price concept (cumulative liquidity out from the spread), so
    // keep it keyed by offer even when the rows are displayed in another order.
    const cumById = new Map<string, bigint>();
    asks.forEach((r, i) => cumById.set(r.offer.id, askCum[i]!));
    bids.forEach((r, i) => cumById.set(r.offer.id, bidCum[i]!));
    // Display order per the active sort. Both sides share the comparator; for
    // key='price' dir='desc' this reproduces the canonical layout exactly.
    const sortVal = (r: BookRow): number =>
      bookSort.key === 'amount' ? Number(r.remaining)
      : bookSort.key === 'total' ? Number(r.total)
      : r.price;
    const cmp = (a: BookRow, b: BookRow): number =>
      (bookSort.dir === 'asc' ? 1 : -1) * (sortVal(a) - sortVal(b));
    const asksView = [...asks].sort(cmp);
    const bidsView = [...bids].sort(cmp);

    // Pagination. Asks render priciest-first (cheapest touches the spread), so
    // when sorted by price we page them from the spread outward — page 0 holds
    // the best (spread-adjacent) asks. Bids already lead with the best bid, and
    // any non-price sort just pages top-down. Page index is clamped every render
    // so a shrinking book can't strand you past the last page.
    const pageOf = (arr: BookRow[], page: number, fromEnd: boolean) => {
      const pages = Math.max(1, Math.ceil(arr.length / BOOK_PAGE_SIZE));
      const p = Math.min(Math.max(0, page), pages - 1);
      const end = fromEnd ? arr.length - p * BOOK_PAGE_SIZE : Math.min(arr.length, (p + 1) * BOOK_PAGE_SIZE);
      const start = fromEnd ? Math.max(0, end - BOOK_PAGE_SIZE) : p * BOOK_PAGE_SIZE;
      return { rows: arr.slice(start, end), p, pages };
    };
    const askPaged = pageOf(asksView, bookPage.ask, bookSort.key === 'price');
    const bidPaged = pageOf(bidsView, bookPage.bid, false);
    const pager = (side: 'ask' | 'bid', p: number, pages: number): globalThis.Node => {
      if (pages <= 1) return document.createDocumentFragment();
      const btn = (label: string, to: number, disabled: boolean): HTMLButtonElement => {
        const b = el('button', { class: 'ob-page-btn' }, label) as HTMLButtonElement;
        b.disabled = disabled;
        b.onclick = () => { bookPage[side] = to; render(); };
        return b;
      };
      return el('div', { class: 'ob-pager' },
        btn('‹', p - 1, p <= 0),
        el('span', { class: 'muted' }, `${p + 1}/${pages}`),
        btn('›', p + 1, p >= pages - 1),
      );
    };
    // Clickable column headers: click to sort, click again to flip direction.
    const headCell = (key: BookSortKey, label: string): HTMLElement => {
      const arrow = bookSort.key !== key ? '' : bookSort.dir === 'asc' ? ' ↑' : ' ↓';
      const span = el('span', {
        class: `ob-sort${bookSort.key === key ? ' active' : ''}`,
        title: `Sort by ${(label.split(' ')[0] ?? label).toLowerCase()}`,
      }, label + arrow);
      span.onclick = () => setBookSort(key);
      return span;
    };

    const obRow = (r: BookRow, cum: bigint): HTMLElement => {
      const isAsk = r.offer.side === 'sell-brc';
      const pct = Number((cum * 100n) / maxCum);
      const tint = isAsk ? 'rgba(248, 81, 73, 0.13)' : 'rgba(63, 182, 139, 0.13)';
      const partial = r.remaining < BigInt(r.offer.amountBrc);
      const row = el('div', {
        class: `ob-row ${isAsk ? 'ask' : 'bid'}${r.mine ? ' mine' : ''}`,
        style: `background: linear-gradient(to left, ${tint} ${pct}%, transparent ${pct}%)`,
        title: (r.mine
          ? 'your offer'
          : `maker ${short(r.offer.maker.brcPubkey, 8)} — click to ${isAsk ? 'buy' : 'sell'}`)
          + ` · seen ${timeAgo(r.offer.ts)}`
          + (makerMinBrcOf(r.offer) > 0n ? ` · min fill ${formatBrc(minFillBrcOf(r.offer, minTrade))} BRC` : '')
          + (partial ? ` · partially filled (${formatBrc(BigInt(r.offer.amountBrc))} BRC originally)` : ''),
      },
        el('span', { class: 'price' }, r.price.toFixed(6)),
        el('span', {}, formatBrc(r.remaining) + (partial ? ' *' : '')),
        el('span', {}, formatUnits(r.total, dec, 2)),
        r.mine ? (() => {
          const x = el('button', { class: 'ob-x', title: 'cancel your offer' }, '✕') as HTMLButtonElement;
          x.onclick = (e) => { e.stopPropagation(); ctx.market.cancelOffer(r.offer.id); };
          return x;
        })() : el('button', { class: 'ob-btn' }, isAsk ? 'Buy' : 'Sell'),
      );
      // One handler for the whole row; the Buy/Sell button's click bubbles here.
      if (!r.mine) row.onclick = () => openFill(r.offer.id);
      return row;
    };

    // Spread row: best prices meet here; last on-chain trade anchors them.
    const bestAsk = asks.length ? asks[asks.length - 1]!.price : null;
    const bestBid = bids.length ? bids[0]!.price : null;
    const pairTrades = historyTrades.filter((t) => (t.pair ?? DEFAULT_PAIR) === marketPair);
    const last = pairTrades.length ? pairTrades[pairTrades.length - 1]!.price : null;
    const spreadParts: (HTMLElement | string)[] = [];
    if (last !== null) spreadParts.push(el('span', {}, 'last ', el('strong', {}, last.toFixed(6))));
    if (bestAsk !== null && bestBid !== null) {
      const spreadPct = ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 100;
      spreadParts.push(el('span', {}, 'spread ', el('strong', {}, `${spreadPct.toFixed(2)}%`)));
    }
    if (spreadParts.length === 0) spreadParts.push('no trades yet');

    view.append(el('div', { class: 'card' },
      el('div', { class: 'row spread' },
        el('h3', {}, 'Order book'),
        el('span', { class: 'muted' }, `${asks.length} sell · ${bids.length} buy`),
      ),
      el('div', { class: 'orderbook' },
        el('div', { class: 'ob-head' },
          headCell('price', `Price ${sym}/BRC`), headCell('amount', 'Amount BRC'),
          headCell('total', `Total ${sym}`), el('span', {}),
        ),
        pager('ask', askPaged.p, askPaged.pages),
        asks.length
          ? el('div', {}, ...askPaged.rows.map((r) => obRow(r, cumById.get(r.offer.id)!)))
          : el('div', { class: 'ob-empty' }, 'No sell offers — yours could be the first.'),
        el('div', { class: 'ob-spread' }, ...spreadParts),
        bids.length
          ? el('div', {}, ...bidPaged.rows.map((r) => obRow(r, cumById.get(r.offer.id)!)))
          : el('div', { class: 'ob-empty' }, 'No buy offers — yours could be the first.'),
        pager('bid', bidPaged.p, bidPaged.pages),
      ),
      el('p', { class: 'muted text-sm' },
        'Click a red row to buy that maker’s BRC, a green row to sell into their bid — any amount worth at least '
        + `${formatUnits(minTrade, dec, disp)} ${sym} (* = partially filled already; the bars show cumulative depth from the spread). `
        + `Relayer fees (${fmtBps(LOCK_FEE_BPS)} buying, ${fmtBps(CLAIM_FEE_BPS)} selling, min ${formatUnits(feeFloor, dec, disp)} ${sym}) pay ALL ${chainName} gas for you`
        + (marketPair === 'sol:sol' ? ' (they’re taken in SOL, the asset you’re already trading).' : `, so you never need ${onSol ? 'SOL' : 'ETH'}.`)),
    ));

    // --- withdrawals, right where the money is ---
    view.append(el('div', { class: 'card' },
      el('h3', {}, 'Withdraw'),
      el('div', { class: 'wallets' },
        el('div', { class: 'wallet-cell' }, withdrawBrcForm()),
        el('div', { class: 'wallet-cell' }, withdrawTokenForm(marketPair)),
      ),
    ));
    return view;
  }

  // ------------------------------------------------------------- swaps tab

  function swapsView(): HTMLElement {
    const view = el('section', { class: 'view' });
    const swaps = ctx.store.all();
    if (!swaps.length) {
      view.append(el('div', { class: 'card' }, el('p', { class: 'muted' }, 'No swaps yet. Take or post an offer on the Market tab.')));
      return view;
    }
    for (const s of swaps) view.append(swapCard(s));
    return view;
  }

  /** A reassurance line shown whenever the user has funds locked in an active
   * swap: exactly when they refund automatically if it doesn't complete. Its
   * whole job is to make "closed my tab / hit a bug" feel safe, not scary. */
  function refundNotice(s: SwapRecord): HTMLElement | null {
    if (['done', 'refunded'].includes(s.state)) return null;
    const spc = pairConfig(s.pair);
    let deadline = 0;
    let amountLabel = '';
    if (s.role === 'buyer' && s.evm.lockTxHash) {
      deadline = s.evmTimelock;
      amountLabel = `${formatUnits(BigInt(s.amountToken), spc.tokenDecimals, spc.displayDecimals)} ${spc.tokenSymbol}`;
    } else if (s.role === 'seller' && s.brc.lockTxId) {
      deadline = s.brcLocktime;
      amountLabel = `${formatBrc(BigInt(s.amountBrc))} BRC`;
    }
    if (!deadline) return null; // nothing locked yet → nothing to refund
    const now = Math.floor(Date.now() / 1000);
    const mins = Math.round((deadline - now) / 60);
    const when = new Date(deadline * 1000).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
    const rel = mins <= 0 ? '' : mins < 90 ? ` (in ~${mins} min)` : ` (in ~${Math.round(mins / 60)}h)`;
    const text = mins <= 0
      ? `🔒 Your ${amountLabel} is safe. The refund window is open — if the swap hasn’t completed, this tab refunds it automatically; if it’s closed, just reopen BrowserSwaps and it finishes the refund.`
      : `🔒 Your ${amountLabel} is safe. If this swap doesn’t complete, it refunds to you automatically after ${when}${rel} — nothing is ever lost, even if you close this tab and reopen it later.`;
    return el('div', { class: 'banner ok text-sm' }, text);
  }

  function swapCard(s: SwapRecord): HTMLElement {
    const steps = s.role === 'buyer' ? BUYER_STEPS : SELLER_STEPS;
    const idx = steps.indexOf(s.state);
    const pct = s.state === 'done' ? 100
      : s.state === 'refunded' || s.state === 'failed' ? 100
      : idx >= 0 ? Math.round((idx / (steps.length - 1)) * 100) : 50;
    const cls = s.state === 'done' ? 'ok' : s.state === 'failed' ? 'bad' : ['refunding', 'refunded'].includes(s.state) ? 'warn' : '';
    const spc = pairConfig(s.pair);
    const title = s.role === 'buyer'
      ? `Buying ${formatBrc(BigInt(s.amountBrc))} BRC for ${formatUnits(BigInt(s.amountToken), spc.tokenDecimals, spc.displayDecimals)} ${spc.tokenSymbol}`
      : `Selling ${formatBrc(BigInt(s.amountBrc))} BRC for ${formatUnits(BigInt(s.amountToken), spc.tokenDecimals, spc.displayDecimals)} ${spc.tokenSymbol}`;
    const raw = STATE_INFO[s.state] ?? { label: s.state, detail: '', eta: '' };
    // The state copy was written for USDT-on-Arbitrum; retarget it per pair.
    const retarget = (t: string): string => t
      .replaceAll('USDT', spc.tokenSymbol)
      .replaceAll('Arbitrum', spc.chain === 'sol' ? 'Solana' : 'Arbitrum');
    const info = { label: retarget(raw.label), detail: retarget(raw.detail), eta: raw.eta };
    const active = !['done', 'refunded', 'failed'].includes(s.state);
    const details = el('div', { class: 'muted text-sm' });
    if (info.detail) details.append(el('div', { class: 'step-detail' }, info.detail));
    if (active && info.eta) {
      const inStep = Math.max(0, Math.floor(Date.now() / 1000) - s.updatedAt);
      const elapsed = inStep < 60 ? `${inStep}s` : `${Math.floor(inStep / 60)}m ${inStep % 60}s`;
      details.append(el('div', { class: 'eta' }, `⏱ this step usually takes ${info.eta} — ${elapsed} so far`));
    }
    if (s.evm.lockTxHash) details.append(el('div', {}, `${spc.tokenSymbol} lock tx: ${short(s.evm.lockTxHash, 12)}`));
    if (s.brc.lockTxId) details.append(el('div', {}, `BRC lock: ${short(s.brc.lockTxId, 12)}`));
    if (s.brc.redeemTxId) details.append(el('div', {}, `BRC redeem: ${short(s.brc.redeemTxId, 12)}`));
    if (s.evm.claimTxHash) details.append(el('div', {}, `${spc.tokenSymbol} claim tx: ${short(s.evm.claimTxHash, 12)}`));
    if (s.note) details.append(el('div', { class: cls === 'bad' ? 'bad' : '' }, s.note));
    const notice = refundNotice(s);
    return el('div', { class: `card swap ${cls}` },
      el('div', { class: 'row spread' },
        el('strong', {}, title),
        el('span', { class: `state ${cls}` }, info.label),
      ),
      el('div', { class: 'progress' }, el('div', { class: `bar ${cls}`, style: `width:${pct}%` })),
      details,
      ...(notice ? [notice] : []),
    );
  }

  // ----------------------------------------------------------- developer tab

  function developerView(): HTMLElement {
    const s = loadSettings();
    const n = net();
    const market = s.marketUrls[0] ?? 'http://localhost:9250';
    const codeBlock = (text: string): HTMLElement => el('pre', { class: 'code' }, text);

    return el('section', { class: 'view' },
      el('div', { class: 'card' },
        el('h3', {}, 'Run a bot — trade without a tab open'),
        el('p', { class: 'muted' },
          'Everything the app does is plain HTTP plus two public blockchains, so you can run a headless market maker on a server and keep liquidity live 24/7. Your keys never leave your machine; the market server only relays metadata, and every value-bearing step is verified on-chain — same trust model as the app.'),
        el('p', { class: 'muted' },
          'Reference bot: ', el('code', {}, 'bots/maker.mjs'), ' (see ', el('code', {}, 'bots/README.md'), '). Run it with ', el('code', {}, 'npx tsx bots/maker.mjs'), '.'),
      ),

      el('div', { class: 'card' },
        el('h3', {}, 'Your identifiers'),
        el('p', { class: 'muted text-sm' }, 'Configure a bot with these. Treat private keys like cash — anyone with them controls the funds.'),
        kv('BRC address (pubkey)', bytesToHex(ctx.node.wallet.publicKey)),
        kv('Arbitrum address', ctx.account.address),
        kv('Market server', market),
        kv('Relayer', s.relayerUrls[0] ?? market),
        kv('HTLC contract', n.htlc || '(configure in Settings)'),
        kv('USDT token', n.token || '(configure in Settings)'),
      ),

      el('div', { class: 'card' },
        el('h3', {}, 'Market API'),
        el('p', { class: 'muted' }, 'Your bot’s identity is a random secret ', el('code', {}, 'key'), '; its public mailbox id is ', el('code', {}, 'sha256(key)[:20]'), '. The server verifies the key on offer posts and mailbox reads — no accounts.'),
        codeBlock([
          '# post / heartbeat an offer (repeat every ~15s; server TTL 150s)',
          '# side "sell-brc" = maker sells BRC; "buy-brc" = maker buys BRC with USDT.',
          '# amountBrc/amountToken define the PRICE and the original size;',
          '# remainingBrc (default amountBrc) is what partial fills have left.',
          '# minBrc (optional) = maker\'s smallest acceptable fill; set it to',
          '# amountBrc for all-or-nothing.',
          `POST ${market}/offers`,
          `  { "offer": { "v":1, "id":"…", "side":"sell-brc" | "buy-brc",`,
          '               "amountBrc":"<1e-8 units>", "amountToken":"<1e-6 units>",',
          '               "remainingBrc":"<1e-8 units>", "minBrc":"<1e-8 units>",',
          '               "maker": { "peerId":"<mailboxId>", "brcPubkey":"<hex>", "evmAddress":"0x…" },',
          '               "ts":<unix> }, "key":"<secret>" }',
          '',
          '# remove an offer',
          `POST ${market}/offers/delete   { "offerId":"…", "key":"<secret>" }`,
          '',
          '# read the live order book',
          `GET  ${market}/offers          -> { offers:[…], bootId }`,
          '',
          '# send / receive handshake messages (take, accept, reject, hint)',
          `POST ${market}/msg             { "to":"<mailboxId>", "payload":{…} }`,
          `GET  ${market}/msg?box=<id>&key=<secret>   -> { messages:[…] } (drains)`,
          '',
          '# verified trade history',
          `GET  ${market}/history         -> { trades:[{ ts, amountBrc, amountToken, price }] }`,
        ].join('\n')),
      ),

      el('div', { class: 'card' },
        el('h3', {}, 'Swap handshake'),
        codeBlock([
          '# taker -> maker: take an offer, fully or partially. amountBrc/amountToken',
          '# is the fill; the maker recomputes amountToken from its offer price',
          '# (rounded in the maker\'s favor) and rejects any mismatch or a fill',
          '# below 0.30 USDT. Whoever BUYS (pays USDT) generates the secret:',
          '#   sell-brc offer -> taker is the buyer -> take carries the hashlock',
          '#   buy-brc offer  -> MAKER is the buyer -> accept carries the hashlock',
          '{ "t":"take", "offerId":"…", "takeId":"<random hex, echoed back>",',
          '  "taker":{peerId,brcPubkey,evmAddress},',
          '  "amountBrc":"<1e-8 units>", "amountToken":"<1e-6 units>",',
          '  "hashlock":"<hex, sell-brc only>", "evmTimelock":<unix>, "brcLocktime":<unix> }',
          '',
          '# maker -> taker: accept (or reject with a reason); echo takeId',
          '{ "t":"accept", "offerId":"…", "takeId":"…", "swapId":"<hashlock>",',
          '  "hashlock":"<hex, buy-brc only>", "amountBrc":"…", "amountToken":"…" }',
          '{ "t":"reject", "offerId":"…", "takeId":"…", "reason":"…" }',
          '',
          '# then, on-chain (both sides verify, nobody is trusted):',
          '#  1. buyer locks USDT   -> HTLC.lockWithPermit (relayed, gasless)',
          '#  2. seller verifies that lock, then locks BRC (Lock tx, sha256 hashlock)',
          '#  3. buyer redeems BRC  -> reveals secret on the BrowserCoin chain',
          '#  4. seller reads secret -> HTLC.claim (relayed) collects the USDT',
          '# timelocks refund both sides if anyone walks away.',
        ].join('\n')),
      ),

      el('div', { class: 'card' },
        el('h3', {}, 'HTLC contract (Arbitrum)'),
        el('p', { class: 'muted' }, 'ABI in ', el('code', {}, 'src/evm/htlc.artifact.json'), '. Key functions:'),
        codeBlock([
          'lock(token, amount, hashlock, recipient, timelock, relayFee)',
          'lockWithPermit(intent, intentSig, permitValue, permitDeadline, v, r, s)   // gasless',
          'claim(id, secret)          // reveals secret, pays recipient; relayer-callable',
          'refund(id)                 // after timelock; relayer-callable',
          'withdrawWithPermit(intent, intentSig, permitValue, permitDeadline, v,r,s) // gasless cash-out',
          'locks(id) -> (token, sender, recipient, amount, hashlock, timelock, relayFee, claimed, refunded)',
        ].join('\n')),
      ),

      el('div', { class: 'card' },
        el('h3', {}, 'Relayer (gas station)'),
        el('p', { class: 'muted' }, 'Optional — lets a bot operate without ETH. It submits your signed operation and takes a small USDT fee. It can never redirect funds.'),
        codeBlock([
          `POST ${s.relayerUrls[0] ?? market}/relay`,
          '  { "op":"claim", "id":"0x…", "secret":"0x…" }',
          '  { "op":"lockWithPermit", "intent":{…}, "intentSig":"0x…", … }',
          '  { "op":"withdrawWithPermit", "intent":{…}, "intentSig":"0x…", … }',
          '  -> { ok:true, txHash:"0x…" }  |  { ok:false, error:"…" }',
        ].join('\n')),
      ),

      el('div', { class: 'card' },
        el('h3', {}, 'BrowserCoin (BRC) side'),
        el('p', { class: 'muted' }, 'BRC transactions are built with the BrowserCoin modules (', el('code', {}, 'chain/transaction.js'), ', ', el('code', {}, 'chain/scriptBuild.js'), ') and submitted/read via any BrowserCoin API helper:'),
        codeBlock([
          `GET  ${n.token ? 'https://api1.browsercoin.org' : '<brc-api>'}/tip                 -> { height, tipHash }`,
          'GET  <brc-api>/blocks?fromHeight=&max=   -> { blocks:[<hex>] }',
          'GET  <brc-api>/snapshot                  -> { accounts, locks, … }',
          'POST <brc-api>/txs   { txs:[<hex>] }     -> { admitted, errors }',
          '',
          '# the HTLC leaf both chains share:  htlcScript(sha256Hash, recipientPub, locktime, senderPub)',
          '# claim witness [sig, preimage, 1] · refund witness [sig, 0]',
        ].join('\n')),
      ),
    );
  }

  function kv(label: string, value: string): HTMLElement {
    return el('div', { class: 'kv' },
      el('span', { class: 'label-sm' }, label),
      el('code', { class: 'addr sm' }, value),
    );
  }

  // ------------------------------------------------------------- history tab

  /** One chip per pair — clicking switches the active pair everywhere (the
   * Market tab's book follows along, same persisted selection). */
  function pairChips(): HTMLElement {
    return el('div', { class: 'pair-chips' },
      ...Object.values(PAIRS).map((p) => {
        const b = el('button', { class: `chip${p.key === marketPair ? ' active' : ''}` }) as HTMLButtonElement;
        b.textContent = p.label;
        b.onclick = () => {
          if (p.key === marketPair) return;
          marketPair = p.key;
          bookPage = { ask: 0, bid: 0 };
          localStorage.setItem('bswap.pair.v1', p.key);
          render();
        };
        return b;
      }));
  }

  function historyView(): HTMLElement {
    ensureHistory();
    const view = el('section', { class: 'view' });
    const pc = pairConfig(marketPair);
    const trades = historyTrades.filter((t) => (t.pair ?? DEFAULT_PAIR) === marketPair);
    if (trades.length === 0) {
      view.append(el('div', { class: 'card' },
        el('div', { class: 'row spread' }, el('h3', {}, `Market history — ${pc.label}`), pairChips()),
        el('p', { class: 'muted' },
          'No completed swaps recorded on this pair yet. Trades appear here after the market server verifies their completion on-chain — self-reported or fake trades never show up.'),
      ));
      return view;
    }

    const now = Math.floor(Date.now() / 1000);
    const last = trades[trades.length - 1]!;
    const day = trades.filter((t) => now - t.ts < 86_400);
    const dayVolToken = day.reduce((a, t) => a + BigInt(t.amountToken), 0n);
    const dayVolBrc = day.reduce((a, t) => a + BigInt(t.amountBrc), 0n);
    const dayPrices = day.map((t) => t.price);
    const statCell = (label: string, value: string): HTMLElement =>
      el('div', { class: 'wallet-cell' }, el('div', { class: 'label-sm' }, label), el('strong', {}, value));

    view.append(el('div', { class: 'card' },
      el('div', { class: 'row spread' }, el('h3', {}, `Market history — ${pc.label}`), pairChips()),
      el('div', { class: 'wallets' },
        statCell('Last price', `${last.price.toFixed(6)} ${pc.tokenSymbol}/BRC`),
        statCell('24h volume', `${formatUnits(dayVolToken, pc.tokenDecimals, pc.displayDecimals)} ${pc.tokenSymbol} · ${formatBrc(dayVolBrc)} BRC`),
        statCell('24h trades', `${day.length}`),
        statCell('24h high / low', dayPrices.length
          ? `${Math.max(...dayPrices).toFixed(4)} / ${Math.min(...dayPrices).toFixed(4)}`
          : '—'),
        statCell('All-time trades', `${trades.length}`),
      ),
    ));

    view.append(el('div', { class: 'card' },
      el('h3', {}, `Price (${pc.tokenSymbol} per BRC)`),
      trades.length >= 2 ? priceChart(trades) : el('p', { class: 'muted' }, 'The chart appears after the second completed trade.'),
    ));

    const tbody = el('tbody');
    for (const t of [...trades].reverse().slice(0, 25)) {
      tbody.append(el('tr', {},
        el('td', {}, new Date(t.ts * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })),
        el('td', {}, formatBrc(BigInt(t.amountBrc))),
        el('td', {}, formatUnits(BigInt(t.amountToken), pc.tokenDecimals, pc.displayDecimals)),
        el('td', {}, t.price.toFixed(6)),
      ));
    }
    view.append(el('div', { class: 'card' },
      el('h3', {}, 'Recent trades'),
      el('table', { class: 'book' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'When'), el('th', {}, 'BRC'), el('th', {}, pc.tokenSymbol), el('th', {}, `${pc.tokenSymbol}/BRC`),
        )),
        tbody,
      ),
      el('p', { class: 'muted text-sm' }, 'Every trade here was verified on-chain: the market server matches each take against the escrow contract’s Claimed events before recording it.'),
    ));
    return view;
  }

  function priceChart(trades: HistoryTrade[]): HTMLCanvasElement {
    const canvas = el('canvas', { class: 'chart', width: '880', height: '260' }) as HTMLCanvasElement;
    const g = canvas.getContext('2d')!;
    const pts = trades.slice(-200);
    const w = canvas.width;
    const h = canvas.height;
    const padL = 56;
    const padR = 12;
    const padY = 24;
    const prices = pts.map((t) => t.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = max - min || max * 0.1 || 1;
    const x = (i: number): number => padL + (pts.length > 1 ? (i / (pts.length - 1)) * (w - padL - padR) : 0);
    const y = (p: number): number => h - padY - ((p - min) / span) * (h - 2 * padY);

    g.fillStyle = '#0d1117';
    g.fillRect(0, 0, w, h);
    // horizontal gridlines + price labels
    g.strokeStyle = '#30363d';
    g.fillStyle = '#8b949e';
    g.font = '11px system-ui';
    for (let i = 0; i <= 4; i++) {
      const p = min + (span * i) / 4;
      const yy = y(p);
      g.beginPath();
      g.moveTo(padL, yy);
      g.lineTo(w - padR, yy);
      g.stroke();
      g.fillText(p.toFixed(4), 4, yy + 4);
    }
    // time range labels
    g.fillText(new Date(pts[0]!.ts * 1000).toLocaleDateString(), padL, h - 6);
    const lastLabel = new Date(pts[pts.length - 1]!.ts * 1000).toLocaleDateString();
    g.fillText(lastLabel, w - padR - g.measureText(lastLabel).width, h - 6);
    // price line
    g.strokeStyle = '#3fb68b';
    g.lineWidth = 2;
    g.beginPath();
    pts.forEach((t, i) => (i === 0 ? g.moveTo(x(i), y(t.price)) : g.lineTo(x(i), y(t.price))));
    g.stroke();
    // last-price dot
    g.fillStyle = '#3fb68b';
    g.beginPath();
    g.arc(x(pts.length - 1), y(pts[pts.length - 1]!.price), 3.5, 0, Math.PI * 2);
    g.fill();
    return canvas;
  }

  // -------------------------------------------------- get-the-token guide

  /** The "What is X?" trigger button, one per pair (the modal itself is
   * rendered separately as a top-level overlay so it floats above everything). */
  function getUsdtHelp(): HTMLElement {
    const sym = pairConfig(marketPair).tokenSymbol;
    const toggle = el('button', { class: 'btn ghost help-toggle' },
      `❔ What is ${sym} and how do I get it?`) as HTMLButtonElement;
    toggle.onclick = () => { helpOpen = true; render(); };
    return el('div', { class: 'help-wrap' }, toggle);
  }

  /** Modal overlay with the get-the-token guide for the ACTIVE pair. */
  function getUsdtModal(): HTMLElement | string {
    if (!helpOpen) return '';
    const pc = pairConfig(marketPair);
    const sym = pc.tokenSymbol;
    const onSol = pc.chain === 'sol';
    const isNativeSol = marketPair === 'sol:sol';
    const chainName = onSol ? 'Solana' : 'Arbitrum One';
    const addr = onSol ? ctx.solAccount : ctx.account.address;
    const close = (): void => { helpOpen = false; render(); };

    const copyAddr = el('button', { class: 'btn ghost sm-btn' }, `Copy my ${chainName} address`) as HTMLButtonElement;
    copyAddr.onclick = () => { void navigator.clipboard?.writeText(addr); toast(`${chainName} address copied.`); };
    const closeX = el('button', { class: 'modal-x', title: 'Close' }, '✕') as HTMLButtonElement;
    closeX.onclick = close;
    const doneBtn = el('button', { class: 'btn primary' }, 'Got it') as HTMLButtonElement;
    doneBtn.onclick = close;

    const whatIsIt = isNativeSol
      ? 'SOL is the native coin of the Solana blockchain — one of the most traded cryptocurrencies, sold on basically every exchange and card on-ramp.'
      : `${sym} is a “stablecoin”: a token designed to always be worth 1 US dollar. It exists on several blockchains — this market uses the ${chainName} version.`;

    const dialog = el('div', { class: 'modal' },
      el('div', { class: 'modal-head' }, el('h3', {}, `What is ${sym}?`), closeX),
      el('div', { class: 'modal-body' },
        el('p', { class: 'muted' }, whatIsIt),
        el('div', { class: 'banner warn' },
          el('strong', {}, '⚠ The one rule that matters: '),
          isNativeSol
            ? 'withdraw SOL on the Solana network (its own chain — sometimes listed as SOL/SPL). “Wrapped” SOL on Ethereum or BSC is a different thing and will not arrive here.'
            : `you need ${sym} on the ${chainName} network. The same ${sym} also exists on other chains — sending from the wrong network means it won’t arrive here and is hard to recover. Whenever you buy or send, pick “${chainName}”${onSol ? ' (sometimes listed as SOL/SPL)' : ' (also written “Arbitrum” or “ARB1”)'}.`),

        el('h4', {}, 'Easiest: buy with a card (MoonPay)'),
        el('ol', {},
          el('li', {}, 'Go to a card on-ramp like MoonPay, Transak, or Ramp.'),
          el('li', {}, isNativeSol
            ? 'Choose to buy SOL (Solana).'
            : `Choose to buy ${sym}, and set the network to ${chainName}.`),
          el('li', {}, `Paste your ${chainName} address (below) as the destination, then pay with card or Apple/Google Pay.`),
          el('li', {}, `It arrives in this wallet in a few minutes — the ${sym} balance updates on its own.`),
        ),

        el('h4', {}, 'Or: from an exchange you already use'),
        el('ol', {},
          el('li', {}, `On Coinbase, Binance, Kraken, OKX, Bybit (most major exchanges), buy or already hold ${sym}.`),
          el('li', {}, `Choose Withdraw / Send, paste your ${chainName} address, and — critically — select the ${chainName} network for the withdrawal.`),
          el('li', {}, 'Confirm. The exchange pays the sending fee; it lands here in minutes.'),
        ),

        el('h4', {}, 'Getting it to this wallet'),
        el('p', { class: 'muted' },
          'Send the ', el('strong', {}, sym), ` to your ${chainName} trading wallet address (shown with a QR on the Market page). `,
          isNativeSol
            ? el('strong', {}, 'Trading fees are simply taken in SOL — nothing else to set up.')
            : el('strong', {}, `You do not need any ${onSol ? 'SOL' : 'ETH'} — this platform’s relayer covers the gas for swaps and withdrawals.`)),
        el('div', { class: 'row' }, copyAddr, el('code', { class: 'addr sm grow' }, addr)),

        el('p', { class: 'muted text-sm' }, 'Tip: for your very first transfer, send a small test amount first to confirm it arrives, then send the rest.'),

        ...(onSol ? [] : [
          el('h4', {}, 'Already sent on the wrong network?'),
          el('p', { class: 'muted' },
            'Your money is usually NOT lost — this address is yours on every Ethereum-family network, the app just can’t see other networks. ',
            'Export your Arbitrum key (Settings → Backup keys), import it into a wallet like MetaMask or Rabby, switch that wallet to the network you actually sent on (e.g. Ethereum mainnet), and the funds are there to move — you’ll need a little of that network’s ETH for gas. ',
            'Plain ETH sent on Arbitrum itself is fine too: it sits at this same address (the ⛽ number in the top bar) and simply isn’t tradable here — withdraw it the same way.'),
        ]),
      ),
      el('div', { class: 'modal-foot' }, doneBtn),
    );
    // click backdrop (but not the dialog) to close
    const backdrop = el('div', { class: 'modal-backdrop' }, dialog);
    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
    return backdrop;
  }

  // ------------------------------------------------------------ fill modal

  /** Modal to take someone's offer, fully or partially. */
  function fillModal(): HTMLElement | string {
    if (!fillOfferId) return '';
    const close = (): void => { fillOfferId = null; fillConfirming = false; fillAmountBrc = null; render(); };
    const closeX = el('button', { class: 'modal-x', title: 'Close' }, '✕') as HTMLButtonElement;
    closeX.onclick = close;
    const wrap = (title: string, ...body: (HTMLElement | string)[]): HTMLElement => {
      const dialog = el('div', { class: 'modal' },
        el('div', { class: 'modal-head' }, el('h3', {}, title), closeX),
        el('div', { class: 'modal-body' }, ...body),
      );
      const backdrop = el('div', { class: 'modal-backdrop' }, dialog);
      backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
      return backdrop;
    };

    const offer = ctx.market.book().find((o) => o.id === fillOfferId);
    if (!offer || ctx.market.myOffers().some((o) => o.id === fillOfferId)) {
      return wrap('Offer gone', el('p', { class: 'muted' },
        'This offer is no longer on the market — it may have just been taken or its maker went offline.'));
    }

    const buying = offer.side === 'sell-brc'; // we take the other side
    const remaining = remainingBrcOf(offer);
    const pair = pairOf(offer);
    const fpc = pairConfig(pair);
    const dec = fpc.tokenDecimals;
    const sym = fpc.tokenSymbol;
    const disp = fpc.displayDecimals;
    const minTrade = fpc.minTradeUnits;
    const feeFloor = fpc.feeMinUnits;
    // Effective floor: the maker's own minimum or the platform minimum,
    // whichever bites first (clamped so the full remainder is always takeable).
    const minBrc = minFillBrcOf(offer, minTrade);

    const amtIn = el('input', { class: 'input', 'data-keep': `fill-amt-${offer.id}`, value: formatBrc(remaining) }) as HTMLInputElement;
    const maxBtn = el('button', { class: 'btn ghost' }, 'Max') as HTMLButtonElement;
    maxBtn.onclick = () => {
      amtIn.value = formatBrc(remaining);
      amtIn.dispatchEvent(new Event('input'));
    };
    const info = el('div', { class: 'muted text-sm' });
    const updateInfo = (): void => {
      const lines: string[] = [];
      let brc = 0n;
      try { brc = parseBrc(amtIn.value || '0'); } catch { /* mid-typing */ }
      if (brc > 0n) {
        const token = tokenForBrc(offer, brc);
        if (brc > remaining) {
          lines.push(`⚠ Only ${formatBrc(remaining)} BRC is left on this offer.`);
        } else if (brc < minBrc || token < minTrade) {
          lines.push(`⚠ This offer’s minimum fill is ${formatBrc(minBrc)} BRC (≈ ${formatUnits(tokenForBrc(offer, minBrc), dec, disp)} ${sym}).`);
        } else if (buying) {
          const lockFee = relayerFee(token, LOCK_FEE_BPS, feeFloor);
          lines.push(`You pay ${formatUnits(token + lockFee, dec, disp)} ${sym} total `
            + `(${formatUnits(token, dec, disp)} price + ${formatUnits(lockFee, dec, disp)} relayer fee that covers all gas) `
            + `and receive ${formatBrc(brc)} BRC.`);
          if (balOf(pair).ok && token + lockFee > balOf(pair).token) {
            lines.push(`⚠ That exceeds your balance of ${formatUnits(balOf(pair).token, dec, disp)} ${sym}.`);
          }
        } else {
          const claimFee = relayerFee(token, CLAIM_FEE_BPS, feeFloor);
          lines.push(`You deliver ${formatBrc(brc)} BRC (+ ${formatBrc(BRC_LOCK_FEE_DEFAULT)} chain fee) `
            + `and receive ≈ ${formatUnits(token > claimFee ? token - claimFee : 0n, dec, disp)} ${sym} `
            + `(${formatUnits(token, dec, disp)} price − ${formatUnits(claimFee, dec, disp)} relayer fee that covers all gas).`);
          if (ctx.node.myBalance() < brc + BRC_LOCK_FEE_DEFAULT) {
            lines.push(`⚠ That exceeds your balance of ${formatBrc(ctx.node.myBalance())} BRC.`);
          }
        }
        if (brc < remaining && token >= minTrade) {
          lines.push(`Partial fill: the remaining ${formatBrc(remaining - brc)} BRC stays on the market.`);
        }
      }
      info.replaceChildren(...lines.map((t) => el('div', {}, t)));
    };
    amtIn.addEventListener('input', updateInfo);
    updateInfo();

    // Validate a specific BRC amount against the book + balances; returns the
    // token amount owed or throws a user message.
    const checkFill = (brc: bigint): bigint => {
      const token = tokenForBrc(offer, brc);
      if (brc <= 0n) throw new Error('amount must be positive');
      if (brc > remaining) throw new Error(`only ${formatBrc(remaining)} BRC is left on this offer`);
      if (brc < minBrc || token < minTrade) throw new Error(`this offer’s minimum fill is ${formatBrc(minBrc)} BRC`);
      if (buying) {
        const needed = token + relayerFee(token, LOCK_FEE_BPS, feeFloor);
        if (!balOf(pair).ok || balOf(pair).token < needed) {
          throw new Error(`you need ${formatUnits(needed, dec, disp)} ${sym} in your trading wallet (price + relayer fee)`);
        }
      } else if (ctx.node.myBalance() < brc + BRC_LOCK_FEE_DEFAULT) {
        throw new Error(`you need ${formatBrc(brc + BRC_LOCK_FEE_DEFAULT)} BRC (amount + chain fee) — you have ${formatBrc(ctx.node.myBalance())}`);
      }
      return token;
    };
    // Validate what's currently typed in the input (edit step only).
    const validateFill = (): { brc: bigint; token: bigint } => {
      const brc = parseBrc(amtIn.value);
      return { brc, token: checkFill(brc) };
    };

    const runFill = (brc: bigint): void => {
      void (async () => {
        try {
          fillBusy = true;
          render();
          await ctx.market.takeOffer(offer.id, brc);
          fillOfferId = null;
          fillConfirming = false;
          fillAmountBrc = null;
          toast('✓ Swap started! Follow it in “Happening now” at the top — keep this tab open (~15 min).');
        } catch (e) {
          toast((e as Error).message);
        }
        fillBusy = false;
        render();
      })();
    };

    const intro = el('p', { class: 'muted' },
      `This maker ${buying ? 'sells' : 'buys'} up to ${formatBrc(remaining)} BRC at ${offerPrice(offer, dec).toFixed(6)} ${sym}/BRC.`
      + (makerMinBrcOf(offer) > 0n
        ? (minBrc >= remaining ? ' All-or-nothing: the whole amount must be taken at once.' : ` Minimum fill: ${formatBrc(minBrc)} BRC.`)
        : ''));

    // --- confirm step: show a plain-language summary + a second button ---
    // Re-check the amount captured at Review time (NOT the input, which is
    // mid-render holding its default) against current balances; if it went
    // invalid while confirming, fall back to the edit step.
    let confirm: { brc: bigint; line: string } | null = null;
    if (fillConfirming && fillAmountBrc !== null) {
      try {
        const brc = fillAmountBrc;
        const token = checkFill(brc);
        const line = buying
          ? `You’ll pay ${formatUnits(token + relayerFee(token, LOCK_FEE_BPS, feeFloor), dec, disp)} ${sym} and receive ${formatBrc(brc)} BRC.`
          : `You’ll deliver ${formatBrc(brc)} BRC and receive ≈ ${formatUnits((() => { const f = relayerFee(token, CLAIM_FEE_BPS, feeFloor); return token > f ? token - f : 0n; })(), dec, disp)} ${sym}.`;
        confirm = { brc, line };
      } catch {
        fillConfirming = false;
        fillAmountBrc = null;
      }
    }

    if (confirm) {
      const confirmBtn = el('button', { class: 'btn primary' },
        fillBusy ? 'Contacting maker…' : buying ? 'Confirm buy' : 'Confirm sell') as HTMLButtonElement;
      confirmBtn.disabled = fillBusy;
      confirmBtn.onclick = () => runFill(confirm!.brc);
      const backBtn = el('button', { class: 'btn ghost' }, 'Back') as HTMLButtonElement;
      backBtn.disabled = fillBusy;
      backBtn.onclick = () => { fillConfirming = false; fillAmountBrc = null; render(); };
      return wrap(
        buying ? 'Confirm your purchase' : 'Confirm your sale',
        intro,
        el('div', { class: 'banner warn' },
          el('strong', {}, 'Review before you confirm. '),
          confirm.line,
          ' This starts a real on-chain swap that runs to completion or refunds on a timelock — keep this tab open.'),
        el('div', { class: 'row' }, backBtn, confirmBtn),
      );
    }

    // --- edit step: enter an amount, first click moves to confirm ---
    const goBtn = el('button', { class: 'btn primary' }, buying ? 'Review buy' : 'Review sell') as HTMLButtonElement;
    goBtn.onclick = () => {
      try {
        const { brc } = validateFill();
        fillAmountBrc = brc;
        fillConfirming = true;
        render();
      } catch (e) {
        toast((e as Error).message);
      }
    };

    return wrap(
      buying ? 'Buy BRC' : 'Sell BRC',
      intro,
      el('div', { class: 'row' },
        el('label', { class: 'field grow' }, buying ? 'Amount to buy (BRC)' : 'Amount to sell (BRC)', amtIn),
        maxBtn,
        goBtn,
      ),
      info,
    );
  }

  // ---------------------------------------------------------- withdrawals

  function withdrawBrcForm(): HTMLElement {
    const BRC_SEND_FEE = 1000n; // 0.00001 BRC, matches the send fee below
    // Confirmed balance counts NOTHING your own unconfirmed txs already spend:
    // sending against it twice queues a second tx that can never be mined (the
    // first already claimed the coins) and just sits in the mempool as a fake
    // "pending". Subtract everything we've already broadcast (withdrawals AND
    // BRC swap-locks) so Max and the amount check see what's really free.
    const pendingOutBrc = (): bigint => {
      const mine = bytesToHex(ctx.node.wallet.publicKey);
      let sum = 0n;
      try {
        for (const e of ctx.node.mempool.listEntries()) {
          // Redeems don't debit our balance; Transfers + Locks do (amount+fee).
          if (!isRedeem(e.tx) && bytesToHex(e.tx.from) === mine) sum += e.tx.amount + e.tx.fee;
        }
      } catch { /* mempool shape unavailable: fall back to confirmed only */ }
      return sum;
    };
    const spendable = (): bigint => {
      const free = ctx.node.myBalance() - pendingOutBrc();
      return free > 0n ? free : 0n;
    };

    const toIn = el('input', { class: 'input wide', placeholder: 'recipient BRC address (64 hex chars)', 'data-keep': 'wd-brc-to' }) as HTMLInputElement;
    const amtIn = el('input', { class: 'input', placeholder: 'amount BRC', 'data-keep': 'wd-brc-amt' }) as HTMLInputElement;
    const maxBtn = el('button', { class: 'btn ghost' }, 'Max') as HTMLButtonElement;
    maxBtn.onclick = () => {
      const free = spendable();
      amtIn.value = formatBrc(free > BRC_SEND_FEE ? free - BRC_SEND_FEE : 0n);
    };
    const sendBtn = el('button', { class: 'btn primary' }, 'Withdraw BRC') as HTMLButtonElement;
    let busy = false;
    sendBtn.onclick = () => {
      if (busy) return; // guard a double-click / double-tap
      try {
        const to = toIn.value.trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(to)) throw new Error('recipient must be a 64-character hex BRC address');
        if (to === bytesToHex(ctx.node.wallet.publicKey)) throw new Error('that is this wallet’s own address');
        const amt = parseBrc(amtIn.value);
        if (amt <= 0n) throw new Error('amount must be positive');
        // Refuse up front what the chain would leave stuck: the amount plus fee
        // must fit within the balance NOT already promised to pending txs.
        const free = spendable();
        const pending = pendingOutBrc();
        if (amt + BRC_SEND_FEE > free) {
          throw new Error(pending > 0n
            ? `only ${formatBrc(free)} BRC is free — you already have ${formatBrc(pending)} BRC in unconfirmed transactions. Wait for those to confirm, then withdraw the rest.`
            : `not enough BRC: withdrawal needs the amount plus a ${formatBrc(BRC_SEND_FEE)} BRC fee`);
        }
        busy = true;
        sendBtn.disabled = true;
        const err = ctx.node.send(addressFromHex(to), formatBrc(amt), '0.00001');
        if (err) throw new Error(err);
        toIn.value = ''; amtIn.value = '';
        toast(`Sent ${formatBrc(amt)} BRC (fee 0.00001). It confirms with the next block (~2.5 min).`);
      } catch (e) { toast((e as Error).message); }
      busy = false;
      sendBtn.disabled = false;
    };
    return el('div', { class: 'col' },
      el('div', { class: 'label-sm' }, 'BRC → any BrowserCoin address'),
      el('p', { class: 'muted text-sm' }, 'e.g. back to your main wallet. Fee: 0.00001 BRC.'),
      toIn, el('div', { class: 'row' }, amtIn, maxBtn, sendBtn),
    );
  }

  function withdrawTokenForm(pair: string): HTMLElement {
    const pc = pairConfig(pair);
    const sym = pc.tokenSymbol;
    const dec = pc.tokenDecimals;
    const disp = pc.displayDecimals;
    const onSol = pc.chain === 'sol';
    const isNativeSol = pair === 'sol:sol';
    const chainName = onSol ? 'Solana' : 'Arbitrum One';
    const gasCoin = onSol ? 'SOL' : 'ETH';
    const toIn = el('input', { class: 'input wide', placeholder: `recipient ${chainName} address${onSol ? '' : ' 0x…'}`, 'data-keep': `wd-tok-to-${pair}` }) as HTMLInputElement;
    const amtIn = el('input', { class: 'input', placeholder: `amount ${sym}`, 'data-keep': `wd-tok-amt-${pair}` }) as HTMLInputElement;
    const flatFee = (amt: bigint): bigint => relayerFee(amt, WITHDRAW_FEE_BPS, pc.feeMinUnits);
    const isSolAddr = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
    const maxBtn = el('button', { class: 'btn ghost', title: 'balance minus the relayer fee' }, 'Max') as HTMLButtonElement;
    maxBtn.onclick = () => {
      void (async () => {
        if (!balOf(pair).ok) return;
        // On Solana the fee depends on the recipient — a wallet that has never
        // held this token needs its token account created (the relayer fronts
        // the rent) — so Max can only be exact once the address is filled in.
        let floor = pc.feeMinUnits;
        const adapter = ctx.foreign(pair);
        if (onSol && !isNativeSol && adapter) {
          const to = toIn.value.trim();
          if (!isSolAddr(to)) {
            toast('enter the recipient address first — the fee depends on it');
            return;
          }
          maxBtn.disabled = true;
          try {
            floor = await (adapter as HtlcSolAdapter).withdrawFee(to);
          } catch {
            floor = SOL_WITHDRAW_ATA_FEE_UNITS; // RPC unreachable: assume the worst-case fee
          }
          maxBtn.disabled = false;
        }
        amtIn.value = formatUnits(maxSendable(balOf(pair).token, WITHDRAW_FEE_BPS, floor), dec, dec);
      })();
    };
    const sendBtn = el('button', { class: 'btn primary' }, `Withdraw ${sym}`) as HTMLButtonElement;
    sendBtn.onclick = () => {
      void (async () => {
        try {
          const adapter = ctx.foreign(pair);
          if (!adapter) throw new Error(`configure ${pc.label} in Settings first`);
          const to = toIn.value.trim();
          if (!onSol && !/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('recipient must be a 0x… Arbitrum address');
          if (onSol && !isSolAddr(to)) throw new Error('recipient must be a Solana (base58) address');
          const amt = parseUnits(amtIn.value, dec);
          if (amt <= 0n) throw new Error('amount must be positive');
          // Solana: creating the recipient's token account costs the relayer
          // real rent, so the flat fee is higher for brand-new recipients.
          const fee = onSol ? await (adapter as HtlcSolAdapter).withdrawFee(to) : flatFee(amt);
          if (balOf(pair).ok && balOf(pair).token < amt + fee) {
            const why = onSol && fee > pc.feeMinUnits
              ? ` (higher than usual: this recipient has never held ${sym} on Solana, so the fee also covers creating its token account)`
              : '';
            throw new Error(`not enough ${sym}: withdrawal needs the amount plus a ${formatUnits(fee, dec, disp)} ${sym} network fee${why} — use Max to withdraw the most possible`);
          }
          sendBtn.disabled = true;
          toast(`Sending withdrawal (no ${gasCoin} needed — a relayer pays the gas)…`);
          const tx = await adapter.withdraw(to, amt);
          toIn.value = ''; amtIn.value = '';
          toast(`Withdrawal sent: ${short(tx, 12)}`);
        } catch (e) { toast((e as Error).message); }
        sendBtn.disabled = false;
        render();
      })();
    };
    return el('div', { class: 'col' },
      el('div', { class: 'label-sm' }, `${sym} → any ${chainName} address`),
      el('p', { class: 'muted text-sm' },
        `e.g. your exchange deposit address (exchange must support ${chainName}!). `
        + (isNativeSol
          ? `Sent as native SOL; a relayer submits it for a flat ${formatUnits(pc.feeMinUnits, dec, disp)} SOL fee.`
          : `No ${gasCoin} needed — a relayer pays the gas for a flat ${formatUnits(relayerFee(0n, WITHDRAW_FEE_BPS, pc.feeMinUnits), dec, disp)} ${sym} fee`
            + (onSol ? ' (more if the recipient has never held this token — its token account costs rent to create)' : '')
            + '.')),
      toIn, el('div', { class: 'row' }, amtIn, maxBtn, sendBtn),
    );
  }

  function exportBtn(label: string, payload: () => string): HTMLElement {
    const b = el('button', { class: 'btn ghost' }, label) as HTMLButtonElement;
    b.onclick = () => {
      const blob = new Blob([payload()], { type: 'application/json' });
      const a = el('a', { href: URL.createObjectURL(blob), download: `${label.toLowerCase().replace(/\s+/g, '-')}.json` });
      a.click();
    };
    return b;
  }

  // ------------------------------------------------------------- settings tab

  function settingsView(): HTMLElement {
    const s = loadSettings();
    const view = el('section', { class: 'view' });

    // network + contract
    const netSel = el('select', { class: 'input', 'data-keep': 'set-network' }) as HTMLSelectElement;
    for (const key of Object.keys(EVM_NETWORKS)) {
      const opt = el('option', { value: key }, EVM_NETWORKS[key]!.chain.name) as HTMLOptionElement;
      if (key === s.network) opt.selected = true;
      netSel.append(opt);
    }
    const htlcIn = el('input', { class: 'input wide', placeholder: 'HTLC contract address 0x…', value: s.htlcAddress, 'data-keep': 'set-htlc' }) as HTMLInputElement;
    const tokenIn = el('input', { class: 'input wide', placeholder: `token address (default: ${net().tokenSymbol})`, value: s.tokenAddress, 'data-keep': 'set-token' }) as HTMLInputElement;
    const relayIn = el('input', { class: 'input wide', placeholder: 'relayer URLs, comma-separated', value: s.relayerUrls.join(', '), 'data-keep': 'set-relayers' }) as HTMLInputElement;
    const marketIn = el('input', { class: 'input wide', placeholder: 'market server URLs, comma-separated', value: s.marketUrls.join(', '), 'data-keep': 'set-markets' }) as HTMLInputElement;
    const saveBtn = el('button', { class: 'btn primary' }, 'Save & reload') as HTMLButtonElement;
    saveBtn.onclick = () => {
      saveSettings({
        ...loadSettings(), network: netSel.value,
        htlcAddress: htlcIn.value.trim(), tokenAddress: tokenIn.value.trim(),
        solProgramId: solProgIn.value.trim(),
        extraSolRpcs: solRpcsIn.value.split(',').map((u) => u.trim()).filter(Boolean),
        relayerUrls: relayIn.value.split(',').map((u) => u.trim()).filter(Boolean),
        marketUrls: marketIn.value.split(',').map((u) => u.trim()).filter(Boolean),
      });
      location.reload();
    };
    const solProgIn = el('input', { class: 'input wide', placeholder: 'bswap-htlc program id (base58)', value: s.solProgramId ?? '', 'data-keep': 'set-solprog' }) as HTMLInputElement;
    const solRpcsIn = el('input', { class: 'input wide', placeholder: 'extra Solana RPC URLs, comma-separated', value: (s.extraSolRpcs ?? []).join(', '), 'data-keep': 'set-solrpcs' }) as HTMLInputElement;
    view.append(el('div', { class: 'card' },
      el('h3', {}, 'Arbitrum network'),
      el('div', { class: 'col' },
        el('label', {}, 'Network', netSel),
        el('label', {}, 'HTLC contract', htlcIn),
        el('label', {}, 'Token override (optional)', tokenIn),
        el('label', {}, 'Relayers (gas stations — they can never touch funds)', relayIn),
        el('label', {}, 'Market servers (orderbook — metadata only, cannot touch funds)', marketIn),
      ),
    ));
    view.append(el('div', { class: 'card' },
      el('h3', {}, 'Solana network'),
      el('div', { class: 'col' },
        el('label', {}, 'HTLC program override (optional)', solProgIn),
        el('label', {}, 'Extra RPCs (optional — all reachable ones must agree)', solRpcsIn),
        saveBtn,
      ),
    ));

    // backup (moved here from the old Wallet tab)
    view.append(el('div', { class: 'card' },
      el('h3', {}, 'Backup keys'),
      el('p', { class: 'muted' }, 'Your trading wallets exist only in this browser. Export both keys and store them somewhere safe — clearing browser data without a backup loses the funds.'),
      el('div', { class: 'row' },
        exportBtn('Export BRC key', () => JSON.stringify({
          type: 'browserswaps-brc', privateKeyHex: bytesToHex(ctx.node.wallet.privateKey), address: bytesToHex(ctx.node.wallet.publicKey),
        })),
        exportBtn('Export Arbitrum key', () => JSON.stringify({
          type: 'browserswaps-evm', privateKey: exportEvmKey(), address: ctx.account.address,
        })),
        exportBtn('Export Solana key', () => JSON.stringify({
          type: 'browserswaps-sol', secretKeyHex: exportSolKey(), address: ctx.solAccount,
        })),
      ),
    ));

    return view;
  }

  // ------------------------------------------------------------- render loop

  const container = el('div', { class: 'app' });
  root.append(container);

  function render(): void {
    // Snapshot user-editable fields (value, focus, cursor) so background
    // re-renders — status ticks, new blocks, book updates — never eat typing.
    interface Kept { value: string; focused: boolean; selStart: number | null; selEnd: number | null }
    const kept = new Map<string, Kept>();
    for (const field of container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-keep]')) {
      kept.set(field.dataset.keep!, {
        value: field.value,
        focused: document.activeElement === field,
        selStart: field instanceof HTMLInputElement ? field.selectionStart : null,
        selEnd: field instanceof HTMLInputElement ? field.selectionEnd : null,
      });
    }

    container.replaceChildren(
      header(),
      tab === 'market' ? marketView() : tab === 'swaps' ? swapsView() : tab === 'history' ? historyView() : tab === 'developer' ? developerView() : settingsView(),
      getUsdtModal(),
      fillModal(),
      footer(),
      toastMsg ? el('div', { class: 'toast' }, toastMsg) : '',
    );

    for (const field of container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-keep]')) {
      const s = kept.get(field.dataset.keep!);
      if (!s) continue;
      field.value = s.value;
      field.dispatchEvent(new Event('input')); // resync live summaries (fee info etc.)
      if (s.focused) {
        field.focus();
        if (field instanceof HTMLInputElement && s.selStart !== null) {
          try { field.setSelectionRange(s.selStart, s.selEnd); } catch { /* non-text input types */ }
        }
      }
    }
  }

  // Escape closes any open modal.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (helpOpen || fillOfferId)) { helpOpen = false; fillOfferId = null; fillConfirming = false; fillAmountBrc = null; render(); }
  });

  // Native browser guard: if a swap is mid-flight, warn before the tab closes
  // or navigates away — this is the moment funds can get stranded.
  window.addEventListener('beforeunload', (e) => {
    const active = ctx.store.all().some((s) => !['done', 'refunded', 'failed'].includes(s.state));
    if (active) {
      e.preventDefault();
      e.returnValue = ''; // required for the prompt to show in most browsers
    }
  });

  // event wiring — all background events go through a throttle. During chain
  // sync, onChain fires for every connected block in rapid bursts; rendering
  // each one rebuilds the whole DOM and freezes the tab. Coalescing to at
  // most ~5 renders/sec keeps the UI live no matter how fast events arrive.
  let renderQueued = false;
  let lastRender = 0;
  function scheduleRender(): void {
    if (renderQueued) return;
    renderQueued = true;
    const delay = Math.max(0, 200 - (Date.now() - lastRender));
    setTimeout(() => {
      renderQueued = false;
      lastRender = Date.now();
      render();
    }, delay);
  }
  setInterval(scheduleRender, 5_000); // keeps status chips honest even when idle
  ctx.node.onChain(scheduleRender);
  ctx.node.onSync(scheduleRender);
  ctx.store.onChange(scheduleRender);
  ctx.market.onBook(scheduleRender);

  // Announce brand-new swaps loudly — a seller shouldn't have to NOTICE a
  // subtle change to learn their offer just sold.
  const knownSwaps = new Set(ctx.store.all().map((s) => s.id));
  ctx.store.onChange(() => {
    for (const s of ctx.store.all()) {
      if (knownSwaps.has(s.id)) continue;
      knownSwaps.add(s.id);
      // Only maker-side fills need announcing — taker-side swaps started with
      // the user's own click. (Old records have no origin; sellers were
      // always makers before buy offers existed.)
      if (s.origin === 'maker' || (!s.origin && s.role === 'seller')) {
        const spc = pairConfig(s.pair);
        const what = s.role === 'seller'
          ? `Selling ${formatBrc(BigInt(s.amountBrc))} BRC for ${formatUnits(BigInt(s.amountToken), spc.tokenDecimals, spc.displayDecimals)} ${spc.tokenSymbol}`
          : `Buying ${formatBrc(BigInt(s.amountBrc))} BRC for ${formatUnits(BigInt(s.amountToken), spc.tokenDecimals, spc.displayDecimals)} ${spc.tokenSymbol}`;
        toast(`💰 Your offer filled! ${what} — running automatically, keep this tab open.`);
      }
    }
  });
  // Foreign-chain balance refreshing: a 10 s poll over every configured pair,
  // plus immediate refreshes at the moments a balance is likely to have JUST
  // changed — swap progress, the tab regaining focus (user comes back after
  // funding from MoonPay/an exchange).
  let balancesInFlight = false;
  async function refreshBalances(): Promise<void> {
    if (balancesInFlight) return;
    balancesInFlight = true;
    try {
      await Promise.all(Object.keys(PAIRS).map(async (pair) => {
        const adapter = ctx.foreign(pair);
        if (!adapter) return;
        const prev = balOf(pair);
        try {
          const [token, gas] = await Promise.all([
            adapter.tokenBalance(),
            'ethBalance' in adapter ? adapter.ethBalance() : adapter.solBalance(),
          ]);
          balances.set(pair, { token, gas, ok: true });
          if (token !== prev.token || gas !== prev.gas || !prev.ok) scheduleRender();
        } catch {
          balances.set(pair, { ...prev, ok: false });
          scheduleRender();
        }
      }));
    } finally {
      balancesInFlight = false;
    }
  }
  setInterval(() => { void refreshBalances(); }, 10_000);
  ctx.store.onChange(() => { void refreshBalances(); }); // swap moved money
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshBalances();
  });
  void refreshBalances();
  render();
}
