import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';
import { octopusThemesPlugin } from './src/theme/vite-plugin.ts';

// The daemon serves the built assets (apps/web/dist) and the API from the same origin.
// In dev, `/api` is proxied to a daemon (or WS3's mock server) on OCTOPUS_DIFF_API.
const apiTarget = process.env.OCTOPUS_DIFF_API ?? 'http://127.0.0.1:7428';

export default defineConfig({
  plugins: [react(), tailwindcss(), octopusThemesPlugin()],
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
    rollupOptions: {
      output: {
        /**
         * `src/zod-config.ts` must run before `@octopus-diff/contracts` builds its schemas (zod
         * probes `Function('')` then, which the CSP reports). Chunks evaluate before the chunks
         * that import them, so zod and its config form one chunk: every chunk using zod (the
         * contracts included) evaluates it, config included, first.
         */
        manualChunks(id) {
          if (/[\\/]src[\\/]zod-config\.ts$/.test(id) || /node_modules[\\/]zod[\\/]/.test(id)) {
            return 'zod';
          }
          return undefined;
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
});
