/**
 * `pnpm --filter @octopus-diff/web dev:mock`: starts the mock API and a Vite dev server that
 * proxies `/api` to it. Same env vars as `mock/server.ts`, plus WEB_PORT (default 5173).
 */
import { fileURLToPath } from 'node:url';
import { mockServerOptionsFromEnv, startMockServer } from './server.js';

const mock = await startMockServer({
  ...mockServerOptionsFromEnv(),
  port: Number(process.env.MOCK_PORT ?? 0),
});
process.env.OCTOPUS_DIFF_API = mock.url;

const { createServer } = await import('vite');
const vite = await createServer({
  configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 5173) },
});
await vite.listen();
console.log(`mock API: ${mock.url} (dataset: ${process.env.MOCK_DATASET ?? 'demo'})`);
vite.printUrls();
if (process.env.MOCK_TOKEN) {
  console.log(`MOCK_TOKEN is set: open the UI with #token=${process.env.MOCK_TOKEN} once`);
}

const shutdown = async () => {
  await vite.close();
  await mock.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
