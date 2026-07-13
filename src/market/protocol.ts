/**
 * Market wire protocol (JSON over PeerJS data channels).
 *
 * Design rule: nothing in these messages is trusted with value. Offers are
 * advertisements; take/accept only exchange parameters; hints only wake the
 * swap engine, which re-verifies everything on-chain before acting.
 */

export interface OfferParty {
  peerId: string;
  brcPubkey: string;  // hex, 32 bytes
  evmAddress: string; // 0x…
}

/** v1 supports maker-sells-BRC offers (taker pays USDT). */
export interface Offer {
  v: 1;
  id: string;
  side: 'sell-brc';
  amountBrc: string;   // smallest units, decimal string
  amountToken: string; // token units, decimal string
  /** BRC lock tx fee (wei) the maker will pay on fill; maker-local choice. */
  makerFeeWei?: string;
  maker: OfferParty;
  ts: number;          // maker's last heartbeat (unix seconds)
}

export interface TakeMsg {
  t: 'take';
  offerId: string;
  taker: OfferParty;
  hashlock: string;     // sha256(secret), hex — taker generated the secret
  evmTimelock: number;  // unix seconds
  brcLocktime: number;  // unix seconds
}

export interface AcceptMsg {
  t: 'accept';
  offerId: string;
  swapId: string;
}

export interface RejectMsg {
  t: 'reject';
  offerId: string;
  reason: string;
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

export type MarketMsg = OffersMsg | TakeMsg | AcceptMsg | RejectMsg | HintMsg;

export function isMarketMsg(x: unknown): x is MarketMsg {
  return typeof x === 'object' && x !== null && typeof (x as { t?: unknown }).t === 'string';
}
