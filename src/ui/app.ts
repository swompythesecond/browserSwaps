/** BrowserSwaps UI — vanilla TS, four tabs: Market, Swaps, Wallet, Settings.
 * Everything re-renders from live state on node/store/market events. */
import type { Node } from '@bc/node.js';
import type { PrivateKeyAccount } from 'viem/accounts';
import { loadSettings, saveSettings, activeNetwork, EVM_NETWORKS, RELAY, MIN_TRADE_TOKEN, BRC_LOCK_FEE_DEFAULT, BRC_LOCK_FEE_MIN, relayerFee, maxSendable, LOCK_FEE_BPS, CLAIM_FEE_BPS, WITHDRAW_FEE_BPS } from '../config.js';

/** Format basis points as a percent string, e.g. 40n -> "0.4%". */
const fmtBps = (bps: bigint): string => `${Number(bps) / 100}%`;
import type { MarketNetwork, HistoryTrade } from '../market/market.js';
import type { SwapEngine } from '../swap/engine.js';
import type { SwapStore } from '../swap/store.js';
import type { SwapRecord, SwapState } from '../swap/types.js';
import type { HtlcEvmAdapter } from '../evm/htlcAdapter.js';
import { exportEvmKey } from '../evm/wallet.js';
import { el, formatBrc, parseBrc, formatUnits, parseUnits, short, timeAgo } from './format.js';
import { bytesToHex } from '../util/hex.js';
import { addressFromHex } from '@bc/crypto/keys.js';
import QRCode from 'qrcode';

export interface AppCtx {
  node: Node;
  store: SwapStore;
  engine: SwapEngine;
  market: MarketNetwork;
  account: PrivateKeyAccount;
  /** null until the HTLC contract is configured in Settings. */
  evm: () => HtlcEvmAdapter | null;
}

const BUYER_STEPS: SwapState[] = ['init', 'evm-locking', 'evm-locked', 'awaiting-brc-lock', 'brc-claiming', 'done'];
const SELLER_STEPS: SwapState[] = ['init', 'awaiting-evm-lock', 'brc-locking', 'brc-locked', 'evm-claiming', 'done'];

interface StateInfo { label: string; detail: string; eta: string }
const STATE_INFO: Record<SwapState, StateInfo> = {
  'init': { label: 'Starting…', detail: 'Setting up the swap.', eta: 'a few seconds' },
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
  let bookSort: 'price-asc' | 'price-desc' | 'amount-desc' | 'newest' = 'price-asc';
  let evmBalances = { token: 0n, eth: 0n, ok: false };
  let toastMsg = '';
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  const toast = (msg: string): void => {
    toastMsg = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastMsg = ''; render(); }, 6000);
    render();
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
        stat(`${net().tokenSymbol} ${evmBalances.ok ? formatUnits(evmBalances.token, net().tokenDecimals, 2) : '—'}`, evmBalances.ok),
        stat(`⛽ ${evmBalances.ok ? formatUnits(evmBalances.eth, 18, 5) : '—'} ETH`, evmBalances.ok),
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
    const pct = sync.targetHeight > 0
      ? Math.min(100, Math.round((sync.localHeight / sync.targetHeight) * 100))
      : 0;
    return el('section', { class: 'view' },
      el('div', { class: 'card sync-card' },
        el('h3', {}, 'Syncing the BrowserCoin chain'),
        el('p', { class: 'muted' },
          'Your tab verifies the blockchain itself — headers, proof-of-work and account state — so no server can lie to you about a trade. ',
          'First visit takes a few minutes; after that it resumes instantly.'),
        el('div', { class: 'progress big' }, el('div', { class: 'bar', style: `width:${pct}%` })),
        el('p', { class: 'muted' },
          `${PHASE_LABEL[sync.phase] ?? sync.phase} `,
          sync.targetHeight > 0 ? `(block ${sync.localHeight.toLocaleString()} of ${sync.targetHeight.toLocaleString()})` : ''),
        el('p', { class: 'muted text-sm' }, 'Trading unlocks automatically when the chain is verified. Active swaps resume on their own.'),
      ),
    );
  }

  function marketView(): HTMLElement {
    if (ctx.node.getSyncStatus().syncing) return syncScreen();
    const view = el('section', { class: 'view' });
    const cfgReady = Boolean(net().htlc && net().token);
    if (!cfgReady) {
      view.append(el('div', { class: 'banner warn' },
        'No HTLC contract configured for this network yet — set it in Settings before trading. ',
        'Deploy with: node scripts/deploy-htlc.mjs ' + loadSettings().network));
    }

    // --- happening now: active swaps live where people actually look ---
    const activeSwaps = ctx.store.all().filter((s) => !['done', 'refunded', 'failed'].includes(s.state));
    if (activeSwaps.length > 0) {
      view.append(el('div', { class: 'card happening' },
        el('h3', {}, `Happening now (${activeSwaps.length})`),
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
        `● ${liveOffers} offer${liveOffers > 1 ? 's' : ''} live — keep this tab open. `,
        'Sales complete automatically; closing this tab takes your offer off the market within seconds.'));
    }

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
          el('div', { class: 'label-sm' }, `${net().tokenSymbol} trading wallet (Arbitrum One)`),
          el('div', { class: 'row' },
            // Bare checksummed address — the universal "receive address" QR
            // format (what exchanges and MoonPay's own deposit QRs use). An
            // EIP-681 `ethereum:` URI is a payment-request format and some
            // on-ramp scanners reject it for L2/ERC-20 sends.
            qr(ctx.account.address),
            el('div', { class: 'col grow' },
              el('strong', {}, evmBalances.ok ? `${formatUnits(evmBalances.token, net().tokenDecimals, 2)} ${net().tokenSymbol}` : '—'),
              el('code', { class: 'addr sm' }, ctx.account.address),
            ),
          ),
        ),
      ),
      el('p', { class: 'muted text-sm' }, 'Fund by sending to these addresses. Key backups are in Settings.'),
      getUsdtHelp(),
    ));

    // --- post offer ---
    const amountIn = el('input', { placeholder: 'BRC amount (e.g. 100)', class: 'input', 'data-keep': 'offer-brc' }) as HTMLInputElement;
    const feeIn = el('input', {
      class: 'input slim', 'data-keep': 'offer-fee', value: formatBrc(BRC_LOCK_FEE_DEFAULT),
      title: 'BRC network fee for the lock transaction. Raise it if you want your sale mined faster.',
    }) as HTMLInputElement;
    const priceIn = el('input', { placeholder: `total ${net().tokenSymbol} (e.g. 5)`, class: 'input', 'data-keep': 'offer-usdt' }) as HTMLInputElement;
    const currentFee = (): bigint => {
      try {
        const f = parseBrc(feeIn.value || '0');
        return f >= BRC_LOCK_FEE_MIN ? f : BRC_LOCK_FEE_MIN;
      } catch { return BRC_LOCK_FEE_MIN; }
    };
    const maxBtn = el('button', { class: 'btn ghost', title: 'balance minus the network fee' }, 'Sell all') as HTMLButtonElement;
    maxBtn.onclick = () => {
      const fee = currentFee();
      amountIn.value = formatBrc(brcBal > fee ? brcBal - fee : 0n);
      amountIn.dispatchEvent(new Event('input'));
      amountIn.focus();
    };
    const postBtn = el('button', { class: 'btn primary' }, 'Post sell offer') as HTMLButtonElement;
    const feeInfo = el('p', { class: 'muted text-sm' });
    const updateFeeInfo = (): void => {
      const lines: string[] = [];
      const fee = currentFee();
      let brc = 0n;
      try { brc = parseBrc(amountIn.value || '0'); } catch { /* mid-typing */ }
      if (brc > 0n) {
        const total = brc + fee;
        lines.push(
          `Total deducted when it sells: ${formatBrc(brc)} + ${formatBrc(fee)} network fee `
          + `= ${formatBrc(total)} BRC${total === brcBal ? ' (your full balance)' : ''}.`);
        if (total > brcBal) {
          lines.push(`⚠ That exceeds your balance of ${formatBrc(brcBal)} BRC — lower the amount or use Sell all.`);
        }
      }
      try {
        const usdt = parseUnits(priceIn.value || '0', net().tokenDecimals);
        if (brc > 0n && usdt > 0n) {
          const relayFee = relayerFee(usdt, CLAIM_FEE_BPS);
          const receive = usdt > relayFee ? usdt - relayFee : 0n;
          lines.push(
            `When it sells you receive ≈ ${formatUnits(receive, net().tokenDecimals, 2)} ${net().tokenSymbol} `
            + `— the price minus a ${formatUnits(relayFee, net().tokenDecimals, 2)} ${net().tokenSymbol} `
            + `relayer fee (${fmtBps(CLAIM_FEE_BPS)}, min ${formatUnits(RELAY.feeMinUnits, net().tokenDecimals, 2)}) which pays the Arbitrum gas for you.`);
        }
      } catch { /* mid-typing */ }
      feeInfo.replaceChildren(...lines.map((t) => el('div', {}, t)));
    };
    amountIn.addEventListener('input', updateFeeInfo);
    feeIn.addEventListener('input', updateFeeInfo);
    priceIn.addEventListener('input', updateFeeInfo);
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
        const usdt = parseUnits(priceIn.value, net().tokenDecimals);
        // currentFee() clamps empty/invalid/too-low input to the minimum, so a
        // blank fee field can never block or break an offer.
        const fee = currentFee();
        feeIn.value = formatBrc(fee);
        if (brc <= 0n || usdt <= 0n) throw new Error('amounts must be positive');
        if (usdt < MIN_TRADE_TOKEN) throw new Error(`minimum price is ${formatUnits(MIN_TRADE_TOKEN, net().tokenDecimals, 2)} ${net().tokenSymbol} — smaller trades get eaten by the network relayer fees`);
        if (ctx.node.myBalance() < brc + fee) {
          throw new Error(`you need ${formatBrc(brc + fee)} BRC (amount + ${formatBrc(fee)} network fee) — you have ${formatBrc(ctx.node.myBalance())}`);
        }
        ctx.market.postOffer(brc, usdt, fee);
        amountIn.value = ''; priceIn.value = '';
        toast('Offer posted. It stays live while this tab is open.');
      } catch (e) { toast((e as Error).message); }
    };
    view.append(el('div', { class: 'card' },
      el('h3', {}, 'Sell BRC'),
      el('p', { class: 'muted' },
        '⚠ Selling requires this tab to STAY OPEN: your tab is the market maker — it fills the sale automatically, no clicks needed. Closing it takes the offer off the market within seconds (nothing is lost; re-open and it re-lists).'),
      el('div', { class: 'row' },
        el('label', { class: 'field' }, 'Amount (BRC)', amountIn),
        maxBtn,
        el('label', { class: 'field' }, 'Network fee (BRC)', feeIn),
        el('label', { class: 'field' }, `Price (${net().tokenSymbol} total)`, priceIn),
        postBtn,
      ),
      feeInfo,
    ));

    // --- book ---
    const priceOf = (o: { amountBrc: string; amountToken: string }): number => {
      const brcN = Number(BigInt(o.amountBrc)) / 1e8;
      return brcN > 0 ? Number(BigInt(o.amountToken)) / 10 ** net().tokenDecimals / brcN : Infinity;
    };
    const offers = [...ctx.market.book()].sort((a, b) => {
      switch (bookSort) {
        case 'price-asc': return priceOf(a) - priceOf(b);
        case 'price-desc': return priceOf(b) - priceOf(a);
        case 'amount-desc': return Number(BigInt(b.amountBrc) - BigInt(a.amountBrc));
        case 'newest': return b.ts - a.ts;
      }
    });
    const sortSel = el('select', { class: 'input slim' },
      ...([
        ['price-asc', 'Cheapest first'],
        ['price-desc', 'Priciest first'],
        ['amount-desc', 'Biggest first'],
        ['newest', 'Newest first'],
      ] as const).map(([value, label]) => {
        const opt = el('option', { value }, label) as HTMLOptionElement;
        if (value === bookSort) opt.selected = true;
        return opt;
      }),
    ) as HTMLSelectElement;
    sortSel.onchange = () => {
      bookSort = sortSel.value as typeof bookSort;
      render();
    };
    const table = el('table', { class: 'book' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'BRC'), el('th', {}, net().tokenSymbol), el('th', {}, `${net().tokenSymbol}/BRC`),
        el('th', { title: 'price + relayer fee that covers all gas for you' }, 'You pay'),
        el('th', {}, 'Maker'), el('th', {}, 'Seen'), el('th', {}, ''),
      )),
    );
    const tbody = el('tbody');
    const mine = new Set(ctx.market.myOffers().map((o) => o.id));
    for (const o of offers) {
      const brc = BigInt(o.amountBrc);
      const usdt = BigInt(o.amountToken);
      const price = brc > 0n ? Number(usdt) / 10 ** net().tokenDecimals / (Number(brc) / 1e8) : 0;
      const isMine = mine.has(o.id);
      const action = el('button', { class: isMine ? 'btn ghost' : 'btn primary' }, isMine ? 'Cancel' : 'Buy') as HTMLButtonElement;
      action.onclick = async () => {
        if (isMine) { ctx.market.cancelOffer(o.id); return; }
        if (!cfgReady) { toast('Configure the HTLC contract in Settings first.'); return; }
        if (usdt < MIN_TRADE_TOKEN) { toast(`This offer (${formatUnits(usdt, net().tokenDecimals, 2)} ${net().tokenSymbol}) is below the ${formatUnits(MIN_TRADE_TOKEN, net().tokenDecimals, 2)} ${net().tokenSymbol} minimum and can’t be filled.`); return; }
        const lockFee = relayerFee(usdt, LOCK_FEE_BPS);
        const needed = usdt + lockFee;
        if (!evmBalances.ok || evmBalances.token < needed) { toast(`You need ${formatUnits(needed, net().tokenDecimals, 2)} ${net().tokenSymbol} in your trading wallet (price + ${formatUnits(lockFee, net().tokenDecimals, 2)} network fee).`); return; }
        // Instant feedback: the maker's accept takes a second or two — the
        // button itself narrates that gap so the click never feels ignored.
        action.disabled = true;
        action.textContent = 'Contacting seller…';
        toast('Contacting the seller…');
        try {
          await ctx.market.takeOffer(o.id);
          toast('✓ Swap started! Follow it in “Happening now” at the top — keep this tab open (~15 min).');
        } catch (e) {
          toast((e as Error).message);
        }
        render();
      };
      tbody.append(el('tr', { class: isMine ? 'mine' : '' },
        el('td', {}, formatBrc(brc)),
        el('td', {}, formatUnits(usdt, net().tokenDecimals, 2)),
        el('td', {}, price ? price.toFixed(6) : '—'),
        el('td', {}, isMine ? '—' : `${formatUnits(usdt + relayerFee(usdt, LOCK_FEE_BPS), net().tokenDecimals, 2)}`),
        el('td', { class: 'mono' }, isMine ? 'you' : short(o.maker.brcPubkey, 8)),
        el('td', {}, timeAgo(o.ts)),
        el('td', {}, action),
      ));
    }
    table.append(tbody);
    view.append(el('div', { class: 'card' },
      el('div', { class: 'row spread' },
        el('h3', {}, `Order book (${offers.length})`),
        el('label', { class: 'field' }, 'Sort', sortSel),
      ),
      offers.length ? table : el('p', { class: 'muted' }, 'No live offers right now. Offers appear here while their maker’s tab is online.'),
      el('p', { class: 'muted text-sm' },
        `Buying: "You pay" = price + a ${fmtBps(LOCK_FEE_BPS)} relayer fee (min ${formatUnits(RELAY.feeMinUnits, net().tokenDecimals, 2)} ${net().tokenSymbol}) — `
        + 'that fee pays ALL Arbitrum gas for you, so you never need ETH. You receive the BRC amount minus a 0.00001 BRC chain fee.'),
    ));

    // --- withdrawals, right where the money is ---
    view.append(el('div', { class: 'card' },
      el('h3', {}, 'Withdraw'),
      el('div', { class: 'wallets' },
        el('div', { class: 'wallet-cell' }, withdrawBrcForm()),
        el('div', { class: 'wallet-cell' }, withdrawTokenForm()),
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

  function swapCard(s: SwapRecord): HTMLElement {
    const steps = s.role === 'buyer' ? BUYER_STEPS : SELLER_STEPS;
    const idx = steps.indexOf(s.state);
    const pct = s.state === 'done' ? 100
      : s.state === 'refunded' || s.state === 'failed' ? 100
      : idx >= 0 ? Math.round((idx / (steps.length - 1)) * 100) : 50;
    const cls = s.state === 'done' ? 'ok' : s.state === 'failed' ? 'bad' : ['refunding', 'refunded'].includes(s.state) ? 'warn' : '';
    const title = s.role === 'buyer'
      ? `Buying ${formatBrc(BigInt(s.amountBrc))} BRC for ${formatUnits(BigInt(s.amountToken), net().tokenDecimals, 2)} ${net().tokenSymbol}`
      : `Selling ${formatBrc(BigInt(s.amountBrc))} BRC for ${formatUnits(BigInt(s.amountToken), net().tokenDecimals, 2)} ${net().tokenSymbol}`;
    const info = STATE_INFO[s.state] ?? { label: s.state, detail: '', eta: '' };
    const active = !['done', 'refunded', 'failed'].includes(s.state);
    const details = el('div', { class: 'muted text-sm' });
    if (info.detail) details.append(el('div', { class: 'step-detail' }, info.detail));
    if (active && info.eta) {
      const inStep = Math.max(0, Math.floor(Date.now() / 1000) - s.updatedAt);
      const elapsed = inStep < 60 ? `${inStep}s` : `${Math.floor(inStep / 60)}m ${inStep % 60}s`;
      details.append(el('div', { class: 'eta' }, `⏱ this step usually takes ${info.eta} — ${elapsed} so far`));
    }
    if (s.evm.lockTxHash) details.append(el('div', {}, `USDT lock tx: ${short(s.evm.lockTxHash, 12)}`));
    if (s.brc.lockTxId) details.append(el('div', {}, `BRC lock: ${short(s.brc.lockTxId, 12)}`));
    if (s.brc.redeemTxId) details.append(el('div', {}, `BRC redeem: ${short(s.brc.redeemTxId, 12)}`));
    if (s.evm.claimTxHash) details.append(el('div', {}, `USDT claim tx: ${short(s.evm.claimTxHash, 12)}`));
    if (s.note) details.append(el('div', { class: cls === 'bad' ? 'bad' : '' }, s.note));
    return el('div', { class: `card swap ${cls}` },
      el('div', { class: 'row spread' },
        el('strong', {}, title),
        el('span', { class: `state ${cls}` }, info.label),
      ),
      el('div', { class: 'progress' }, el('div', { class: `bar ${cls}`, style: `width:${pct}%` })),
      details,
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
          `POST ${market}/offers`,
          `  { "offer": { "v":1, "id":"…", "side":"sell-brc",`,
          '               "amountBrc":"<1e-8 units>", "amountToken":"<1e-6 units>",',
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
          '# buyer -> maker: take an offer (buyer generates secret, sends sha256(secret))',
          '{ "t":"take", "offerId":"…", "taker":{peerId,brcPubkey,evmAddress},',
          '  "hashlock":"<hex>", "evmTimelock":<unix>, "brcLocktime":<unix> }',
          '',
          '# maker -> buyer: accept (or reject with a reason)',
          '{ "t":"accept", "offerId":"…", "swapId":"<hashlock>" }',
          '{ "t":"reject", "offerId":"…", "reason":"…" }',
          '',
          '# then, on-chain (both sides verify, nobody is trusted):',
          '#  1. buyer locks USDT   -> HTLC.lockWithPermit (relayed, gasless)',
          '#  2. maker verifies that lock, then locks BRC (Lock tx, sha256 hashlock)',
          '#  3. buyer redeems BRC  -> reveals secret on the BrowserCoin chain',
          '#  4. maker reads secret -> HTLC.claim (relayed) collects the USDT',
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

  function historyView(): HTMLElement {
    // refresh at most every 15 s while the tab is being looked at
    if (Date.now() - historyFetchedAt > 15_000) {
      historyFetchedAt = Date.now();
      void ctx.market.fetchHistory().then((trades) => {
        historyTrades = trades;
        scheduleRender();
      });
    }
    const view = el('section', { class: 'view' });
    const trades = historyTrades;
    if (trades.length === 0) {
      view.append(el('div', { class: 'card' },
        el('h3', {}, 'Market history'),
        el('p', { class: 'muted' },
          'No completed swaps recorded yet. Trades appear here after the market server verifies their completion on-chain — self-reported or fake trades never show up.'),
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
      el('h3', {}, 'Market history'),
      el('div', { class: 'wallets' },
        statCell('Last price', `${last.price.toFixed(6)} ${net().tokenSymbol}/BRC`),
        statCell('24h volume', `${formatUnits(dayVolToken, net().tokenDecimals, 2)} ${net().tokenSymbol} · ${formatBrc(dayVolBrc)} BRC`),
        statCell('24h trades', `${day.length}`),
        statCell('24h high / low', dayPrices.length
          ? `${Math.max(...dayPrices).toFixed(4)} / ${Math.min(...dayPrices).toFixed(4)}`
          : '—'),
        statCell('All-time trades', `${trades.length}`),
      ),
    ));

    view.append(el('div', { class: 'card' },
      el('h3', {}, `Price (${net().tokenSymbol} per BRC)`),
      trades.length >= 2 ? priceChart(trades) : el('p', { class: 'muted' }, 'The chart appears after the second completed trade.'),
    ));

    const tbody = el('tbody');
    for (const t of [...trades].reverse().slice(0, 25)) {
      tbody.append(el('tr', {},
        el('td', {}, new Date(t.ts * 1000).toLocaleString()),
        el('td', {}, formatBrc(BigInt(t.amountBrc))),
        el('td', {}, formatUnits(BigInt(t.amountToken), net().tokenDecimals, 2)),
        el('td', {}, t.price.toFixed(6)),
      ));
    }
    view.append(el('div', { class: 'card' },
      el('h3', {}, 'Recent trades'),
      el('table', { class: 'book' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'When'), el('th', {}, 'BRC'), el('th', {}, net().tokenSymbol), el('th', {}, `${net().tokenSymbol}/BRC`),
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

  // -------------------------------------------------------- get-USDT guide

  /** The "How to get USDT" trigger button (the modal itself is rendered
   * separately as a top-level overlay so it floats above everything). */
  function getUsdtHelp(): HTMLElement {
    const sym = net().tokenSymbol;
    const toggle = el('button', { class: 'btn ghost help-toggle' },
      `❔ New to ${sym}? How to get it and fund this wallet`) as HTMLButtonElement;
    toggle.onclick = () => { helpOpen = true; render(); };
    return el('div', { class: 'help-wrap' }, toggle);
  }

  /** Modal overlay with the get-USDT guide. Returns '' when closed. */
  function getUsdtModal(): HTMLElement | string {
    if (!helpOpen) return '';
    const sym = net().tokenSymbol;
    const evmAddr = ctx.account.address;
    const close = (): void => { helpOpen = false; render(); };

    const copyAddr = el('button', { class: 'btn ghost sm-btn' }, 'Copy my Arbitrum address') as HTMLButtonElement;
    copyAddr.onclick = () => { void navigator.clipboard?.writeText(evmAddr); toast('Arbitrum address copied.'); };
    const closeX = el('button', { class: 'modal-x', title: 'Close' }, '✕') as HTMLButtonElement;
    closeX.onclick = close;
    const doneBtn = el('button', { class: 'btn primary' }, 'Got it') as HTMLButtonElement;
    doneBtn.onclick = close;

    const dialog = el('div', { class: 'modal' },
      el('div', { class: 'modal-head' }, el('h3', {}, `How to get ${sym}`), closeX),
      el('div', { class: 'modal-body' },
        el('div', { class: 'banner warn' },
          el('strong', {}, '⚠ The one rule that matters: '),
          `you need ${sym} on the Arbitrum One network. `,
          `The same ${sym} also exists on Ethereum, Tron, and others — sending from the wrong network means it won’t arrive here and is hard to recover. Whenever you buy or send, pick “Arbitrum One” (also written “Arbitrum” or “ARB1”).`),

        el('h4', {}, 'Easiest: buy with a card (MoonPay)'),
        el('ol', {},
          el('li', {}, 'Go to a card on-ramp like MoonPay, Transak, or Ramp.'),
          el('li', {}, `Choose to buy ${sym} (USDT / Tether), and set the network to Arbitrum.`),
          el('li', {}, 'Paste your Arbitrum address (below) as the destination, then pay with card or Apple/Google Pay.'),
          el('li', {}, `It arrives in this wallet in a few minutes — the ${sym} balance updates on its own.`),
        ),
        el('p', { class: 'muted text-sm' }, 'MoonPay tends to be the smoothest for a first purchase. If its QR scanner is fussy, use “Copy my Arbitrum address” below and paste the address instead.'),

        el('h4', {}, 'Or: from an exchange you already use'),
        el('ol', {},
          el('li', {}, 'On Coinbase, Binance, Kraken, OKX, Bybit (most major exchanges), buy or already hold USDT.'),
          el('li', {}, 'Choose Withdraw / Send, paste your Arbitrum address, and — critically — select the Arbitrum One network for the withdrawal.'),
          el('li', {}, 'Confirm. The exchange pays the sending fee; it lands here in minutes.'),
        ),

        el('h4', {}, 'Getting it to this wallet'),
        el('p', { class: 'muted' },
          'Send the ', el('strong', {}, sym), ' to your Arbitrum trading wallet address (shown with a QR on the Market page) over Arbitrum One. ',
          el('strong', {}, 'You do not need any ETH'), ' — this platform’s relayer covers the gas for swaps and withdrawals.'),
        el('div', { class: 'row' }, copyAddr, el('code', { class: 'addr sm grow' }, evmAddr)),

        el('p', { class: 'muted text-sm' }, 'Tip: for your very first transfer, send a small test amount first to confirm it arrives, then send the rest.'),
      ),
      el('div', { class: 'modal-foot' }, doneBtn),
    );
    // click backdrop (but not the dialog) to close
    const backdrop = el('div', { class: 'modal-backdrop' }, dialog);
    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
    return backdrop;
  }

  // ---------------------------------------------------------- withdrawals

  function withdrawBrcForm(): HTMLElement {
    const BRC_SEND_FEE = 1000n; // 0.00001 BRC, matches the send fee below
    const toIn = el('input', { class: 'input wide', placeholder: 'recipient BRC address (64 hex chars)', 'data-keep': 'wd-brc-to' }) as HTMLInputElement;
    const amtIn = el('input', { class: 'input', placeholder: 'amount BRC', 'data-keep': 'wd-brc-amt' }) as HTMLInputElement;
    const maxBtn = el('button', { class: 'btn ghost' }, 'Max') as HTMLButtonElement;
    maxBtn.onclick = () => {
      const bal = ctx.node.myBalance();
      amtIn.value = formatBrc(bal > BRC_SEND_FEE ? bal - BRC_SEND_FEE : 0n);
    };
    const sendBtn = el('button', { class: 'btn primary' }, 'Withdraw BRC') as HTMLButtonElement;
    sendBtn.onclick = () => {
      try {
        const to = toIn.value.trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(to)) throw new Error('recipient must be a 64-character hex BRC address');
        if (to === bytesToHex(ctx.node.wallet.publicKey)) throw new Error('that is this wallet’s own address');
        const amt = parseBrc(amtIn.value);
        if (amt <= 0n) throw new Error('amount must be positive');
        const err = ctx.node.send(addressFromHex(to), formatBrc(amt), '0.00001');
        if (err) throw new Error(err);
        toIn.value = ''; amtIn.value = '';
        toast(`Sent ${formatBrc(amt)} BRC (fee 0.00001). It confirms with the next block (~2.5 min).`);
      } catch (e) { toast((e as Error).message); }
    };
    return el('div', { class: 'col' },
      el('div', { class: 'label-sm' }, 'BRC → any BrowserCoin address'),
      el('p', { class: 'muted text-sm' }, 'e.g. back to your main wallet. Fee: 0.00001 BRC.'),
      toIn, el('div', { class: 'row' }, amtIn, maxBtn, sendBtn),
    );
  }

  function withdrawTokenForm(): HTMLElement {
    const toIn = el('input', { class: 'input wide', placeholder: 'recipient Arbitrum address 0x…', 'data-keep': 'wd-usdt-to' }) as HTMLInputElement;
    const amtIn = el('input', { class: 'input', placeholder: `amount ${net().tokenSymbol}`, 'data-keep': 'wd-usdt-amt' }) as HTMLInputElement;
    const feeFor = (amt: bigint): bigint => relayerFee(amt, WITHDRAW_FEE_BPS);
    const maxBtn = el('button', { class: 'btn ghost', title: 'balance minus the relayer fee' }, 'Max') as HTMLButtonElement;
    maxBtn.onclick = () => {
      if (evmBalances.ok) {
        amtIn.value = formatUnits(maxSendable(evmBalances.token, WITHDRAW_FEE_BPS), net().tokenDecimals, net().tokenDecimals);
      }
    };
    const sendBtn = el('button', { class: 'btn primary' }, `Withdraw ${net().tokenSymbol}`) as HTMLButtonElement;
    sendBtn.onclick = () => {
      void (async () => {
        try {
          const adapter = ctx.evm();
          if (!adapter) throw new Error('configure the network in Settings first');
          const to = toIn.value.trim();
          if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('recipient must be a 0x… Arbitrum address');
          const amt = parseUnits(amtIn.value, net().tokenDecimals);
          if (amt <= 0n) throw new Error('amount must be positive');
          const fee = feeFor(amt);
          if (evmBalances.ok && evmBalances.token < amt + fee) {
            throw new Error(`not enough ${net().tokenSymbol}: withdrawal needs the amount plus a ${formatUnits(fee, net().tokenDecimals, 2)} ${net().tokenSymbol} network fee`);
          }
          sendBtn.disabled = true;
          toast('Sending withdrawal (no ETH needed — a relayer pays the gas)…');
          const tx = await adapter.withdraw(to, amt);
          toIn.value = ''; amtIn.value = '';
          toast(`Withdrawal sent: ${short(tx, 12)}`);
        } catch (e) { toast((e as Error).message); }
        sendBtn.disabled = false;
        render();
      })();
    };
    return el('div', { class: 'col' },
      el('div', { class: 'label-sm' }, `${net().tokenSymbol} → any Arbitrum One address`),
      el('p', { class: 'muted text-sm' }, `e.g. your exchange deposit address (exchange must support Arbitrum!). No ETH needed — a relayer pays the gas for a flat ${formatUnits(relayerFee(0n, WITHDRAW_FEE_BPS), net().tokenDecimals, 2)} ${net().tokenSymbol} fee.`),
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
        relayerUrls: relayIn.value.split(',').map((u) => u.trim()).filter(Boolean),
        marketUrls: marketIn.value.split(',').map((u) => u.trim()).filter(Boolean),
      });
      location.reload();
    };
    view.append(el('div', { class: 'card' },
      el('h3', {}, 'Arbitrum network'),
      el('div', { class: 'col' },
        el('label', {}, 'Network', netSel),
        el('label', {}, 'HTLC contract', htlcIn),
        el('label', {}, 'Token override (optional)', tokenIn),
        el('label', {}, 'Relayers (gas stations — they can never touch funds)', relayIn),
        el('label', {}, 'Market servers (orderbook — metadata only, cannot touch funds)', marketIn),
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

  // Escape closes the get-USDT modal.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && helpOpen) { helpOpen = false; render(); }
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
      if (s.role === 'seller') {
        toast(`💰 Your offer sold! Swapping ${formatBrc(BigInt(s.amountBrc))} BRC for ${formatUnits(BigInt(s.amountToken), net().tokenDecimals, 2)} ${net().tokenSymbol} — running automatically, keep this tab open.`);
      }
    }
  });
  // EVM balance refreshing: a 10 s poll, plus immediate refreshes at the
  // moments a balance is likely to have JUST changed — swap progress, the tab
  // regaining focus (user comes back after funding from MoonPay/an exchange).
  let balancesInFlight = false;
  async function refreshBalances(): Promise<void> {
    const adapter = ctx.evm();
    if (!adapter || balancesInFlight) return;
    balancesInFlight = true;
    try {
      const [token, eth] = await Promise.all([adapter.tokenBalance(), adapter.ethBalance()]);
      const changed = token !== evmBalances.token || eth !== evmBalances.eth || !evmBalances.ok;
      evmBalances = { token, eth, ok: true };
      if (changed) scheduleRender();
    } catch {
      evmBalances = { ...evmBalances, ok: false };
      scheduleRender();
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
