import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 3002,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
