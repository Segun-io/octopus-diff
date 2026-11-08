/**
 * `pnpm --filter @octopus-diff/web preview:mock`: serves the production build (`dist/`, run
 * `pnpm build` first) with `vite preview`, proxying `/api` to the mock. Same env vars as dev.ts.
 */
import { fileURLToPath } from 'node:url';
import { mockServerOptionsFromEnv, startMockServer } from './server.js';

const mock = await startMockServer({
  ...mockServerOptionsFromEnv(),
  port: Number(process.env.MOCK_PORT ?? 0),
});
process.env.OCTOPUS_DIFF_API = mock.url;

const { preview } = await import('vite');
const server = await preview({
  configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
  root: fileURLToPath(new URL('..', import.meta.url)),
  preview: { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 4173), strictPort: true },
});
console.log(`mock API: ${mock.url} (dataset: ${process.env.MOCK_DATASET ?? 'demo'})`);
server.printUrls();

const shutdown = async () => {
  await server.close();
  await mock.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
