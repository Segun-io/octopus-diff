import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources so tests never need a prebuild. The unit
// tests never import `electron` at runtime (only its types): they run without the Electron binary.
const conditions = ['@octopus-diff/source', 'module', 'node', 'development|production'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['@octopus-diff/source'] } },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
