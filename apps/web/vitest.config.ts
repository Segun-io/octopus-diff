import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources so tests never need a prebuild.
const source = '@octopus-diff/source';

export default defineConfig({
  resolve: { conditions: [source, ...defaultClientConditions] },
  ssr: {
    resolve: { conditions: [source, ...defaultServerConditions], externalConditions: [source] },
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    // jsdom UI tests: many take 3-4.6 s on a 4-core CI runner testing other packages in parallel
    // (one passed the 5 s default there, PR #3's first run). DECISIONS #133.
    testTimeout: 20_000,
    setupFiles: ['test/setup.ts'],
  },
});
