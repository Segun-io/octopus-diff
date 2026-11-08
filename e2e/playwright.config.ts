import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Dev-machine workaround (see docs/DECISIONS.md, 2026-11-08): Chromium's system libraries
// (libnss3, libnspr4, libasound2) are extracted user-locally because there is no sudo. If the
// directory exists, prepend it to LD_LIBRARY_PATH so the browser can start. CI uses
// `playwright install --with-deps` instead and never has this directory.
const localChromiumLibs =
  process.env.OCTOPUS_DIFF_CHROMIUM_LIBS ??
  join(homedir(), '.cache/octopus-diff-dev/chromium-libs/usr/lib/x86_64-linux-gnu');
if (process.platform === 'linux' && existsSync(localChromiumLibs)) {
  const current = process.env.LD_LIBRARY_PATH;
  if (!current?.split(':').includes(localChromiumLibs)) {
    process.env.LD_LIBRARY_PATH = current ? `${localChromiumLibs}:${current}` : localChromiumLibs;
  }
}

/**
 * PLACEHOLDER config until WS4 lands. WS4 adds global setup (fixture repos in the OS temp dir,
 * a daemon on an ephemeral port) and the acceptance specs from PLAN §8.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
