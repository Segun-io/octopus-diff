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
  },
});
