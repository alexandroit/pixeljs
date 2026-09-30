import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 3001,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    // Every asset stays a same-origin file: no data: URLs, which a strict
    // connect-src blocks and which would bypass the shell's URL resolution.
    assetsInlineLimit: 0,
  },
});
