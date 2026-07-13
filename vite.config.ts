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
  // Don't pre-bundle the source package — it must go through Vite's TS pipeline.
  optimizeDeps: { exclude: ['browsercoin'] },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
