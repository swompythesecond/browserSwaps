/**
 * Market wire protocol (JSON over the market servers' mailboxes).
 *
 * Design rule: nothing in these messages is trusted with value. Offers are
 * advertisements; take/accept only exchange parameters; hints only wake the
 * swap engine, which re-verifies everything on-chain before acting.
 */

export interface OfferParty {
  peerId: string;
  brcPubkey: string;  // hex, 32 bytes
  evmAddress: string; // 0x…
  /** Solana address (base58). Required by sol:* pairs, absent on v1 parties. */
  solAddress?: string;
}

export interface Offer {
  /** 1 = original protocol, always the arb:usdt pair (old clients drop
   * anything else, so only arb:usdt offers may carry v:1). 2 = adds `pair`. */
  v: 1 | 2;
  id: string;
  /** Trading pair key (config PAIRS). Absent = 'arb:usdt' (v1 offers). */
  pair?: string;
  /** 'sell-brc': maker sells BRC, taker pays USDT (taker = buyer, holds the
   * secret). 'buy-brc': maker buys BRC with USDT, taker delivers BRC (MAKER =
   * buyer, so the maker generates the secret and sends the hashlock in the
   * accept). */
  side: 'sell-brc' | 'buy-brc';
  /** Original size. Together with amountToken this DEFINES the price and
   * never changes — partial fills only move remainingBrc. */
  amountBrc: string;   // smallest units, decimal string
  amountToken: string; // token units, decimal string
  /** Unfilled portion (smallest units). Absent = amountBrc (nothing filled). */
  remainingBrc?: string;
  /** Maker's smallest acceptable fill (smallest units). Absent/0 = only the
   * platform-wide minimum applies; equal to amountBrc = all-or-nothing. */
  minBrc?: string;
  /** BRC lock tx fee (wei) the maker will pay on fill; sell-brc only. */
  makerFeeWei?: string;
  maker: OfferParty;
  ts: number;          // maker's last heartbeat (unix seconds)
}

/** The pair an offer trades, with the v1 implicit default. */
export function pairOf(o: Pick<Offer, 'pair'>): string {
  return o.pair ?? 'arb:usdt';
}

/** Unfilled BRC still up for grabs on an offer. */
export function remainingBrcOf(o: Offer): bigint {
  try { return BigInt(o.remainingBrc ?? o.amountBrc); } catch { return 0n; }
}

/**
 * Token units a fill of `brcPart` costs at the offer's price. Both sides
 * compute this canonically — a take whose amountToken differs is rejected.
 * Sub-unit rounding always favors the maker: on a sell-brc offer the maker
 * RECEIVES tokens (round up), on a buy-brc offer the maker PAYS them (round
 * down) — a partial fill can never beat the advertised price.
 */
export function tokenForBrc(o: Pick<Offer, 'side' | 'amountBrc' | 'amountToken'>, brcPart: bigint): bigint {
  const totalBrc = BigInt(o.amountBrc);
  const totalToken = BigInt(o.amountToken);
  if (totalBrc <= 0n || brcPart <= 0n) return 0n;
  const num = brcPart * totalToken;
  return o.side === 'sell-brc' ? (num + totalBrc - 1n) / totalBrc : num / totalBrc;
}

/** Smallest BRC fill whose tokenForBrc reaches `minToken`, exact per side:
 * sell-brc rounds tokens UP, so ceil(brc·T/B) ≥ min ⇔ brc·T > (min−1)·B;
 * buy-brc rounds DOWN, so floor(brc·T/B) ≥ min ⇔ brc·T ≥ min·B. */
export function minBrcForFill(o: Pick<Offer, 'side' | 'amountBrc' | 'amountToken'>, minToken: bigint): bigint {
  const totalBrc = BigInt(o.amountBrc);
  const totalToken = BigInt(o.amountToken);
  if (totalToken <= 0n || minToken <= 0n) return 0n;
  return o.side === 'sell-brc'
    ? ((minToken - 1n) * totalBrc) / totalToken + 1n
    : (minToken * totalBrc + totalToken - 1n) / totalToken;
}

/** Maker-declared minimum fill (smallest units); 0 when unset or garbage. */
export function makerMinBrcOf(o: Offer): bigint {
  try {
    const v = BigInt(o.minBrc ?? '0');
    return v > 0n ? v : 0n;
  } catch { return 0n; }
}

/** Effective smallest takeable fill: the maker's declared minimum or the
 * platform floor (`minToken` worth), whichever is larger — clamped to what's
 * left, so a shrunken offer can always still be taken whole. */
export function minFillBrcOf(o: Offer, minToken: bigint): bigint {
  const floor = minBrcForFill(o, minToken);
  const makerMin = makerMinBrcOf(o);
  const eff = makerMin > floor ? makerMin : floor;
  const remaining = remainingBrcOf(o);
  return eff > remaining ? remaining : eff;
}

export interface TakeMsg {
  t: 'take';
  offerId: string;
  /** Echo of the offer's pair, so market servers can tag the pending trade
   * for verified history without an offer lookup. Absent = 'arb:usdt'. */
  pair?: string;
  /** Taker-generated id for THIS take, echoed in the accept/reject so the
   * taker can pair responses when several takes of the same offer are in
   * flight (partial fills keep an offer alive across takes). */
  takeId?: string;
  taker: OfferParty;
  /** Fill size — the whole remaining offer or a part of it. The maker
   * re-derives amountToken from its own offer and rejects any mismatch. */
  amountBrc: string;
  amountToken: string;
  /** sha256(secret), hex — present only on sell-brc takes (the taker is the
   * buyer and generated the secret). Absent on buy-brc takes: the maker is
   * the buyer there and returns the hashlock in the accept. */
  hashlock?: string;
  evmTimelock: number;  // unix seconds
  brcLocktime: number;  // unix seconds
}

export interface AcceptMsg {
  t: 'accept';
  offerId: string;
  /** Pair echo for market-server history tagging (see TakeMsg.pair). */
  pair?: string;
  /** Echo of the take's takeId (absent when answering a legacy take). */
  takeId?: string;
  swapId: string;
  /** buy-brc accepts only: the maker-generated sha256(secret). */
  hashlock?: string;
  /** Fill size echoed so market servers can pair the take with the on-chain
   * claim for verified history. */
  amountBrc?: string;
  amountToken?: string;
}

export interface RejectMsg {
  t: 'reject';
  offerId: string;
  /** Echo of the take's takeId (absent when answering a legacy take). */
  takeId?: string;
  reason: string;
}

/** Taker → maker, after it receives the accept and commits its own swap record.
 * A maker-BUYER (which must lock its token first) waits for this before locking,
 * so it never commits funds against a taker whose 30 s window already elapsed.
 * A maker-seller ignores it (it waits for the taker's on-chain lock instead). */
export interface ConfirmMsg {
  t: 'confirm';
  offerId: string;
  takeId?: string;
  swapId: string;
}

export interface OffersMsg {
  t: 'offers';
  offers: Offer[];
}

export interface HintMsg {
  t: 'hint';
  swapId: string;
  hint: { type: 'evm-locked' | 'brc-locked' | 'secret'; lockId?: string; txHash?: string; lockTxId?: string; secret?: string };
}

export type MarketMsg = OffersMsg | TakeMsg | AcceptMsg | RejectMsg | ConfirmMsg | HintMsg;

export function isMarketMsg(x: unknown): x is MarketMsg {
  return typeof x === 'object' && x !== null && typeof (x as { t?: unknown }).t === 'string';
}
