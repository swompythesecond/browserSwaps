import { defineConfig } from 'vitest/config';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

export default defineConfig({
  resolve: {
    alias: { '@bc': path.resolve(here, 'node_modules/browsercoin/src') },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
