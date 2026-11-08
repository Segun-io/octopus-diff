import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// The daemon serves the built assets (apps/web/dist) and the API from the same origin.
// In dev, `/api` is proxied to a daemon (or WS3's mock server) on OCTOPUS_DIFF_API.
const apiTarget = process.env.OCTOPUS_DIFF_API ?? 'http://127.0.0.1:7428';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Resolve workspace packages to their TypeScript sources (no prebuild needed).
    conditions: ['@octopus-diff/source', ...defaultClientConditions],
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  worker: {
    format: 'es',
  },
});
