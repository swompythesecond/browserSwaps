// Node's `Buffer` global doesn't exist in browsers, but @solana/web3.js and our
// own Solana adapter build and serialize transactions with it (Buffer.from,
// tx.serialize().toString('base64'), …). Install it on globalThis before any of
// that code runs — this module is imported FIRST from main.ts, so the global is
// in place by the time web3.js module bodies evaluate.
import { Buffer } from 'buffer';

const g = globalThis as unknown as { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;
