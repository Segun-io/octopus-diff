import { defineConfig, devices } from '@playwright/test';
import { applyChromiumLibraryPath } from './support/env.js';

// Dev-machine workaround (DECISIONS #19): user-local Chromium system libraries.
applyChromiumLibraryPath();

/**
 * octopus-diff acceptance suite (PLAN §8 items 2–9). One command: `pnpm test:e2e` (after
 * `pnpm build`). Global setup generates fixture repos in the OS temp dir, starts the read-only
 * proof and smoke-tests the daemon; each test gets its own in-process daemon (fresh state dir,
 * port 0, explicit token, `webRoot` = apps/web/dist). Global teardown fails the run on any write
 * to a control repository.
 *
 * Tests run serially in one worker: specs edit the shared mutable fixture project.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './support/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
