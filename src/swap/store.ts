/** Durable swap storage. Swaps must survive tab closes: a half-done swap that
 * is forgotten is how funds get stuck until a timelock, so every state change
 * is written through to localStorage immediately. */
import type { SwapRecord } from './types.js';

const KEY = 'bswap.swaps.v1';

export class SwapStore {
  private swaps = new Map<string, SwapRecord>();
  private listeners = new Set<() => void>();

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) for (const s of JSON.parse(raw) as SwapRecord[]) this.swaps.set(s.id, s);
    } catch {
      // corrupted store: keep going with empty state rather than crashing the app
    }
  }

  all(): SwapRecord[] {
    return [...this.swaps.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): SwapRecord | undefined {
    return this.swaps.get(id);
  }

  put(swap: SwapRecord): void {
    this.swaps.set(swap.id, swap);
    this.persist();
    for (const fn of this.listeners) fn();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private persist(): void {
    localStorage.setItem(KEY, JSON.stringify([...this.swaps.values()]));
  }
}
