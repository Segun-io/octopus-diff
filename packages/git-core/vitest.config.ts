import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources so tests never need a prebuild.
const conditions = ['@octopus-diff/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['@octopus-diff/source'] } },
  test: {
    include: ['test/**/*.test.ts'],
    // Every test spawns git, often hundreds of times; several take 3-4 s on a 4-core CI runner
    // while the other packages' tests run in parallel (the 5 s default timed out there).
    testTimeout: 20_000,
  },
});
