/**
 * The mock API plus `vite preview` of the production build (`dist/`), in this process. Used by
 * `mock/preview.ts` (`pnpm preview:mock`) and by `scripts/perf.ts`, which starts its own copy so
 * every run gets a fresh dataset and needs no server to be started and stopped by hand.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type MockServer, type MockServerOptions, startMockServer } from './server.js';

export interface MockPreview {
  /** The page's origin, e.g. `http://127.0.0.1:4173`. */
  url: string;
  mock: MockServer;
  close(): Promise<void>;
  printUrls(): void;
}

export const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));

export async function startMockPreview(
  options: MockServerOptions & { webPort?: number },
): Promise<MockPreview> {
  if (!existsSync(`${WEB_ROOT}dist/index.html`)) {
    throw new Error(
      'apps/web/dist is missing: run `pnpm --filter @octopus-diff/web build` (a preview serves the production build)',
    );
  }
  const { webPort = 0, ...mockOptions } = options;
  const mock = await startMockServer({ ...mockOptions, port: mockOptions.port ?? 0 });
  // vite.config.ts reads this when the config is loaded.
  process.env.OCTOPUS_DIFF_API = mock.url;
  const { preview } = await import('vite');
  const server = await preview({
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    root: WEB_ROOT,
    preview: { host: '127.0.0.1', port: webPort, strictPort: webPort !== 0 },
  });
  const url = server.resolvedUrls?.local[0]?.replace(/\/$/, '');
  if (!url) throw new Error('vite preview did not report its address');
  return {
    url,
    mock,
    printUrls: () => server.printUrls(),
    close: async () => {
      await server.close();
      await mock.close();
    },
  };
}
