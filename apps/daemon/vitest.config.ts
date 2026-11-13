import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources so tests never need a prebuild.
const conditions = ['@octopus-diff/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['@octopus-diff/source'] } },
  test: {
    include: ['test/**/*.test.ts'],
    // The real-git daemon tests start daemons and git processes: on a loaded or slower CI runner
    // (macOS) a normal run can pass the 5 s default (it timed out there more than once), and a
    // real hang still fails, 25 s later.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
