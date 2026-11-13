import { defineConfig } from '@playwright/test';

/**
 * The PACKAGED desktop app's smoke suite (roadmap #19): `pnpm --filter @octopus-diff/e2e
 * test:e2e:desktop`, after `pnpm build` and `pnpm --filter @octopus-diff/desktop run package`
 * (or with OCTOPUS_DESKTOP_APP pointing at an installed app). Not part of `pnpm test:e2e`: it needs
 * a packaged Electron app and a display (Linux CI: xvfb-run). No browser is launched: the specs
 * drive the app over its DevTools pipe (desktop/support/cdp-pipe.ts).
 */
export default defineConfig({
  testDir: './desktop',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/desktop' }]],
  outputDir: 'test-results/desktop',
});
