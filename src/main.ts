/**
 * BrowserSwaps bootstrap: embed a full BrowserCoin node, wire the swap engine
 * to the Arbitrum HTLC adapter and the in-tab BRC adapter, start the market
 * mesh, and mount the UI. Mining is optional and starts only if enabled in
 * Settings (default: off).
 */
import './styles.css';
import { Node } from '@bc/node.js';
import { loadSettings, activeNetwork, MARKET } from './config.js';
import { loadOrCreateEvmAccount } from './evm/wallet.js';
import { HtlcEvmAdapter } from './evm/htlcAdapter.js';
import { NodeBrcAdapter } from './brc/adapter.js';
import { SwapStore } from './swap/store.js';
import { SwapEngine, type OutboundHint } from './swap/engine.js';
import type { EvmAdapter } from './swap/types.js';
import { MarketNetwork } from './market/market.js';
import { mountApp } from './ui/app.js';

const node = new Node();
(window as unknown as Record<string, unknown>).browserswaps = node; // debug handle

const account = loadOrCreateEvmAccount();
const store = new SwapStore();
const brcAdapter = new NodeBrcAdapter(node);

// The EVM adapter needs a configured contract; build lazily so the app still
// boots (and the BRC node still syncs) before Settings are filled in.
let evmAdapter: HtlcEvmAdapter | null = null;
function getEvmAdapter(): HtlcEvmAdapter | null {
  if (evmAdapter) return evmAdapter;
  try {
    const settings = loadSettings();
    evmAdapter = new HtlcEvmAdapter(activeNetwork(settings), account, settings.relayerUrls);
    return evmAdapter;
  } catch {
    return null;
  }
}

/** Proxy that fails with a clear message until the contract is configured —
 * the engine treats thrown errors as transient and retries. */
const evmProxy: EvmAdapter = new Proxy({} as EvmAdapter, {
  get(_t, prop: string) {
    const real = getEvmAdapter();
    if (!real) {
      if (prop === 'address') return () => account.address;
      return () => { throw new Error('HTLC contract not configured (Settings)'); };
    }
    const v = (real as unknown as Record<string, unknown>)[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});

// hint sink is late-bound because engine and market reference each other
let hintSink: (peerId: string, hint: OutboundHint) => void = () => {};
const engine = new SwapEngine(evmProxy, brcAdapter, store, (p, h) => hintSink(p, h));
const market = new MarketNetwork(node, store, engine, () => account.address);
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
});
