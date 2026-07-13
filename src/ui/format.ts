import { BRC_DECIMALS } from '../config.js';

export function formatUnits(v: bigint, decimals: number, maxFrac = 4): string {
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function parseUnits(s: string, decimals: number): bigint {
  const t = s.trim();
  if (!/^\d+(\.\d*)?$/.test(t)) throw new Error('invalid amount');
  const [whole = '0', frac = ''] = t.split('.');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals));
}

// Full 8-decimal precision: BRC fees are as small as 0.00001, which a
// 4-decimal display would render as a very confusing "0".
export const formatBrc = (v: bigint): string => formatUnits(v, BRC_DECIMALS, BRC_DECIMALS);
export const parseBrc = (s: string): bigint => parseUnits(s, BRC_DECIMALS);

export function short(s: string, n = 10): string {
  return s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-6)}`;
}

export function timeAgo(unixSecs: number): string {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - unixSecs);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  return `${Math.floor(d / 3600)}h ago`;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}
