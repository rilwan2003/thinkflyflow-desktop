import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      // Vite drops the node: prefix and then fails to resolve the bare name.
      // Point it at itself so Node's real built-in is used at runtime.
      sqlite: 'node:sqlite',
    },
  },
  test: {
    environment: 'node',
    // node:sqlite cannot be bundled; keep main-process modules external.
    server: {
      deps: {
        external: ['node:sqlite'],
      },
    },
  },
  ssr: {
    external: ['node:sqlite'],
  },
});
