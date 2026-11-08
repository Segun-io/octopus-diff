import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources so tests never need a prebuild.
const conditions = ['@octopus-diff/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['@octopus-diff/source'] } },
  test: {
    include: ['support/**/*.test.ts'],
  },
});
