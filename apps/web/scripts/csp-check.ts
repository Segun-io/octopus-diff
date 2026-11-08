/**
 * Loads the production build under a strict Content-Security-Policy and reports violations and
 * diff worker usage. BASE_URL must point at `pnpm preview:mock`.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const LIBS = path.join(homedir(), '.cache/octopus-diff-dev/chromium-libs/usr/lib/x86_64-linux-gnu');
if (existsSync(LIBS)) {
  process.env.LD_LIBRARY_PATH = [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}
const base = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
export const CSP =
  process.env.CSP ??
  "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.route(`${base}/`, async (route) => {
  const response = await route.fetch();
  await route.fulfill({
    response,
    headers: { ...response.headers(), 'content-security-policy': CSP },
  });
});
const messages: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') messages.push(m.text());
});
const workers: string[] = [];
page.on('worker', (w) => workers.push(w.url()));
await page.goto(base);
await page.locator('[data-testid="app"][data-ready="true"]').waitFor();
await page.locator('[data-testid="diff-viewer"][data-state="ready"]').waitFor();
await page.waitForTimeout(1500);
const highlighted = await page.evaluate(() => {
  const host = document.querySelector('diffs-container');
  const root = host?.shadowRoot ?? host;
  return root ? root.querySelectorAll('[style*="--diffs-token"], span[style]').length : -1;
});
console.log(
  JSON.stringify(
    { csp: CSP, workers, highlightedSpans: highlighted, consoleErrors: messages },
    null,
    2,
  ),
);
await browser.close();
