import { defineConfig } from 'vite';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
// BrowserCoin ships as TypeScript source (installed via the `browsercoin` git
// dependency). We alias to its src so Vite transpiles it as part of the app.
const bcSrc = path.resolve(here, 'node_modules/browsercoin/src');

export default defineConfig({
  resolve: {
    alias: { '@bc': bcSrc },
  },
  // Don't pre-bundle the source package — it must go through Vite's TS
  // pipeline. Because the app imports it through the `@bc` alias, the dep
  // optimizer registers each specifier under its OWN id ('@bc/node.js', …),
  // so excluding 'browsercoin' alone doesn't cover them. A pre-bundled
  // @bc/node.js breaks the chain verifier: browserCoin spawns its worker via
  // `new Worker(new URL('./verifier.worker.ts', import.meta.url))`, which
  // then resolves into .vite/deps/ where no worker source exists ("The file
  // does not exist at …verifier.worker.ts" console spam, sync stuck).
  optimizeDeps: {
    exclude: [
      'browsercoin',
      '@bc/node.js',
      '@bc/chain/transaction.js',
      '@bc/chain/scriptBuild.js',
      '@bc/chain/script.js',
      '@bc/chain/state.js',
      '@bc/crypto/keys.js',
      '@bc/crypto/hash.js',
    ],
    // Flip side of the excludes: dependencies that browserCoin's source pulls
    // in are now discovered inside excluded modules, so Vite serves them raw
    // unless force-included here — and the CommonJS ones then lack ESM
    // interop ("does not provide an export named 'default'": peerjs →
    // webrtc-adapter → sdp; jsqr and qrcode are CJS too). Pre-bundling
    // these is safe — none of them resolve workers/assets via import.meta.url
    // the way browserCoin itself does.
    include: ['peerjs', 'jsqr', 'qrcode'],
  },
  // `vite dev` serves only the SPA; the helper server (market + relayer +
  // history, `npm run server`) listens on :9250. The app defaults its
  // market/relayer URLs to the page origin (matches the hosted deployment,
  // where a reverse proxy fronts both), so proxy those routes in dev to make
  // the same-origin default work here too instead of answering index.html.
  server: {
    proxy: {
      '/offers': 'http://localhost:9250',
      '/msg': 'http://localhost:9250',
      '/relay': 'http://localhost:9250',
      '/history': 'http://localhost:9250',
      '/sol-rpc': 'http://localhost:9250',
    },
  },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
