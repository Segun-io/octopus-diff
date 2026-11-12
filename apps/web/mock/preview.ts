/**
 * `pnpm --filter @octopus-diff/web preview:mock`: serves the production build (`dist/`, run
 * `pnpm build` first) with `vite preview`, proxying `/api` to the mock. Same env vars as dev.ts.
 * Note: the default dataset is `demo`; the render benchmark (`pnpm perf`) needs `large` and starts
 * its own copy of this when no BASE_URL is given.
 */
import { startMockPreview } from './preview-server.js';
import { mockServerOptionsFromEnv } from './server.js';

const preview = await startMockPreview({
  ...mockServerOptionsFromEnv(),
  port: Number(process.env.MOCK_PORT ?? 0),
  webPort: Number(process.env.WEB_PORT ?? 4173),
});
console.log(`mock API: ${preview.mock.url} (dataset: ${process.env.MOCK_DATASET ?? 'demo'})`);
preview.printUrls();

const shutdown = async () => {
  await preview.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
