import { defineConfig } from 'vite';

export default defineConfig({
  // Relative URLs, so the build runs from any folder of any host, the portal's included.
  base: './',
  server: {
    port: 3000,
    open: true,
  },
  build: {
    target: 'es2022',
    // Scripts, the audio worklet and WebAssembly stay separate files: the portal runs
    // scripts only from the game's own files.
    assetsInlineLimit: (file) => (/\.(m?js|wasm)$/i.test(file) ? false : undefined),
  },
});
