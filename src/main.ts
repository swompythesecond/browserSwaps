/**
 * BrowserSwaps bootstrap: embed a full BrowserCoin node, wire the swap engine
 * to the Arbitrum HTLC adapter and the in-tab BRC adapter, start the market
 * mesh, and mount the UI. Mining is optional and starts only if enabled in
 * Settings (default: off).
 */
import './polyfills.js'; // MUST be first: installs the Buffer global for @solana/web3.js
import './styles.css';
import { Node } from '@bc/node.js';
import { loadSettings, activeNetwork, activeSolNetwork, MARKET, pairConfig, DEFAULT_PAIR } from './config.js';
import { loadOrCreateEvmAccount } from './evm/wallet.js';
import { HtlcEvmAdapter } from './evm/htlcAdapter.js';
import { loadOrCreateSolKeypair } from './sol/wallet.js';
import { HtlcSolAdapter } from './sol/htlcAdapter.js';
import { NodeBrcAdapter } from './brc/adapter.js';
import { SwapStore } from './swap/store.js';
import { SwapEngine, type OutboundHint } from './swap/engine.js';
import type { EvmAdapter } from './swap/types.js';
import { MarketNetwork } from './market/market.js';
import { mountApp } from './ui/app.js';

const node = new Node();
(window as unknown as Record<string, unknown>).browserswaps = node; // debug handle

const account = loadOrCreateEvmAccount();
const solKeypair = loadOrCreateSolKeypair();
const store = new SwapStore();
const brcAdapter = new NodeBrcAdapter(node);

// Foreign-chain adapters need configured contracts/programs; build lazily so
// the app still boots (and the BRC node still syncs) before Settings are
// filled in. One adapter per pair — EVM pairs share nothing with sol pairs,
// and the two sol pairs differ only in mint.
const foreignAdapters = new Map<string, HtlcEvmAdapter | HtlcSolAdapter>();
function getForeignAdapter(pair: string = DEFAULT_PAIR): HtlcEvmAdapter | HtlcSolAdapter | null {
  const cached = foreignAdapters.get(pair);
  if (cached) return cached;
  try {
    const settings = loadSettings();
    const cfg = pairConfig(pair);
    const adapter = cfg.chain === 'evm'
      ? new HtlcEvmAdapter(activeNetwork(settings), account, settings.relayerUrls)
      : new HtlcSolAdapter(activeSolNetwork(cfg.network, settings), cfg, solKeypair, settings.relayerUrls);
    foreignAdapters.set(pair, adapter);
    return adapter;
  } catch {
    return null;
  }
}
/** Kept name: the arb:usdt adapter (existing UI paths use it directly). */
const getEvmAdapter = () => getForeignAdapter(DEFAULT_PAIR) as HtlcEvmAdapter | null;

/** Per-pair proxy that fails with a clear message until the pair's contract/
 * program is configured — the engine treats thrown errors as transient. */
function foreignProxy(pair: string | undefined): EvmAdapter {
  return new Proxy({} as EvmAdapter, {
    get(_t, prop: string) {
      const real = getForeignAdapter(pair ?? DEFAULT_PAIR);
      if (!real) {
        if (prop === 'address') {
          return () => (pairConfig(pair).chain === 'evm' ? account.address : solKeypair.publicKey.toBase58());
        }
        return () => { throw new Error(`${pairConfig(pair).label} HTLC not configured (Settings)`); };
      }
      const v = (real as unknown as Record<string, unknown>)[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(real) : v;
    },
  });
}

// hint sink is late-bound because engine and market reference each other
let hintSink: (peerId: string, hint: OutboundHint) => void = () => {};
const engine = new SwapEngine(foreignProxy, brcAdapter, store, (p, h) => hintSink(p, h));
const market = new MarketNetwork(node, store, engine, {
  evm: () => account.address,
  sol: () => solKeypair.publicKey.toBase58(),
}, async (pair) => {
  const adapter = getForeignAdapter(pair);
  return adapter ? adapter.tokenBalance() : null;
});
hintSink = (p, h) => market.sendHint(p, h);

// drive the engine: steady tick + a tick on new BRC blocks. The tip-change
// trigger is throttled: during initial sync blocks connect in rapid bursts,
// and each tick can involve RPC reads — once every few seconds is plenty.
setInterval(() => { void engine.tickAll(); }, MARKET.engineTickMs);
let lastTipTick = 0;
node.chain.onTipChanged(() => {
  const now = Date.now();
  if (now - lastTipTick < 3_000) return;
  lastTipTick = now;
  void engine.tickAll();
});

// boot — market and node start INDEPENDENTLY: the orderbook must work even
// while the chain is still doing its (potentially long) initial sync.
void market.start();
void node.start();

mountApp(document.getElementById('app')!, {
  node, store, engine, market, account, evm: getEvmAdapter,
  solAccount: solKeypair.publicKey.toBase58(), foreign: getForeignAdapter,
});
