import { defineConfig } from 'vitest/config';

// Unit tests for the repository scripts (scripts/lib), run by `pnpm test` after the packages'.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['test/**/*.test.mjs'],
  },
});
