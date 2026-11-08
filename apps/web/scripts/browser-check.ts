/**
 * Drives the UI (served by `pnpm dev:mock`) in headless Chromium: smoke checks + screenshots.
 * Usage: BASE_URL=http://127.0.0.1:5173 pnpm exec tsx scripts/browser-check.ts [outDir]
 * Not part of the unit tests; WS4 owns the real e2e suite.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';

const LIBS = path.join(homedir(), '.cache/octopus-diff-dev/chromium-libs/usr/lib/x86_64-linux-gnu');
if (existsSync(LIBS)) {
  process.env.LD_LIBRARY_PATH = [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}

const base = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const outDir = process.argv[2] ?? '/tmp/octopus-diff-web-shots';

async function attrs(page: Page, selector: string, names: string[]) {
  return page
    .locator(selector)
    .first()
    .evaluate((el, n) => Object.fromEntries(n.map((name) => [name, el.getAttribute(name)])), names);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  });
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning')
      errors.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  const t0 = Date.now();
  await page.goto(base);
  await page.locator('[data-testid="app"][data-ready="true"]').waitFor();
  console.log(`ready in ${Date.now() - t0} ms`);
  await page.locator('[data-testid="diff-viewer"][data-state="ready"]').waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${outDir}/01-inbox-dark.png` });
  console.log(
    'inbox',
    await attrs(page, '[data-testid="inbox-item"]', ['data-count', 'aria-current']),
  );
  console.log(
    'files',
    await page.getByTestId('file-item').count(),
    'groups',
    await page.getByTestId('file-group').count(),
  );
  console.log(
    'diff',
    await attrs(page, '[data-testid="diff-viewer"]', ['data-path', 'data-state', 'data-mode']),
  );

  for (const key of ['j', 'j', 'k']) await page.keyboard.press(key);
  console.log('after jjk', await attrs(page, '[data-testid="diff-viewer"]', ['data-path']));
  await page.keyboard.press('s');
  console.log('mode after s', await attrs(page, '[data-testid="diff-mode-toggle"]', ['data-mode']));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outDir}/02-unified.png` });
  await page.keyboard.press('s');

  await page.keyboard.press('r');
  await page.waitForTimeout(200);
  console.log(
    'after r',
    await attrs(page, '[data-testid="file-item"][aria-selected="true"]', [
      'data-path',
      'data-reviewed',
    ]),
  );
  await page.keyboard.press('n');
  console.log('after n', await attrs(page, '[data-testid="diff-viewer"]', ['data-path']));

  await page.keyboard.press('J');
  await page.waitForTimeout(300);
  console.log(
    'after J',
    await attrs(page, '[data-testid="worktree-item"][aria-current="true"]', ['data-branch']),
  );
  await page.keyboard.press('J');
  console.log(
    'after JJ',
    await attrs(page, '[data-testid="worktree-item"][aria-current="true"]', ['data-branch']),
  );
  await page.locator('[data-testid="worktree-item"][data-branch="feat/auth"]').click();
  await page.locator('[data-testid="diff-viewer"][data-state="ready"]').waitFor();
  // Walk the special-case files of feat/auth.
  const kinds: Record<string, string | null> = {};
  const count = await page.getByTestId('file-item').count();
  for (let i = 0; i < count; i++) {
    const p = await page.getByTestId('file-item').nth(i).getAttribute('data-path');
    await page.getByTestId('file-item').nth(i).click();
    await page.locator(`[data-testid="diff-viewer"][data-state="ready"]`).waitFor();
    const placeholder = page.getByTestId('diff-placeholder');
    kinds[p ?? '?'] =
      (await placeholder.count()) > 0
        ? await placeholder.first().getAttribute('data-kind')
        : 'patch';
    if (
      p === 'data/generated-big.ts' ||
      p === 'src/auth/middleware.ts' ||
      p === 'vendor/libgit' ||
      p === 'data/fixtures.min.json'
    ) {
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${outDir}/03-${p.replace(/\W+/g, '_')}.png` });
    }
  }
  console.log('kinds', kinds);
  const loadAnyway = page.getByTestId('diff-load-anyway');
  await page
    .getByTestId('file-item')
    .filter({ has: page.locator('text=fixtures.min.json') })
    .first()
    .click();
  if (await loadAnyway.count()) {
    await loadAnyway.click();
    await page.waitForTimeout(1500);
    console.log(
      'after load anyway',
      await page.getByTestId('diff-placeholder').first().getAttribute('data-kind'),
    );
    await page.screenshot({ path: `${outDir}/04-load-anyway.png` });
  }

  // Live update: mutate the open file through the mock control endpoint.
  await page.setViewportSize({ width: 1440, height: 420 });
  await page.locator('[data-testid="file-item"][data-path="src/auth/session.ts"]').click();
  await page.locator('[data-testid="diff-viewer"][data-state="ready"]').waitFor();
  await page.waitForTimeout(500);
  const scroller = page.locator('[data-testid="diff-viewer"] .od-scroll').first();
  await scroller.evaluate((el) => {
    el.scrollTop = 120;
  });
  const scrollBefore = await scroller.evaluate((el) => el.scrollTop);
  const before = await attrs(page, '[data-testid="diff-viewer"]', [
    'data-worktree-id',
    'data-path',
    'data-patch-hash',
  ]);
  const t1 = Date.now();
  await page.evaluate(
    async ([wt, p]) => {
      const q = new URLSearchParams({ worktreeId: wt ?? '', action: 'edit', path: p ?? '' });
      await fetch(`/api/__mock/mutate?${q}`, { method: 'POST' });
    },
    [before['data-worktree-id'], before['data-path']] as const,
  );
  await page.waitForTimeout(100);
  // Mutation picks a random file; loop until the banner or a changed hash appears.
  for (let i = 0; i < 20; i++) {
    const now = await attrs(page, '[data-testid="diff-viewer"]', ['data-patch-hash']);
    if (now['data-patch-hash'] !== before['data-patch-hash']) {
      console.log(
        `open file updated after ${Date.now() - t1} ms; banner=${await page.getByTestId('diff-updated-banner').count()}`,
      );
      break;
    }
    if (i === 19)
      console.log('open file not mutated this round (random file); refresh still exercised');
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(300);
  console.log(
    'selection after refresh',
    await attrs(page, '[data-testid="diff-viewer"]', ['data-path']),
  );
  console.log(
    'diff scrollTop before/after refresh',
    scrollBefore,
    await scroller.evaluate((el) => el.scrollTop),
  );
  await page.screenshot({ path: `${outDir}/05-updated-banner.png` });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.keyboard.press('?');
  console.log('help visible', await page.getByTestId('help-dialog').isVisible());
  await page.screenshot({ path: `${outDir}/05-help.png` });
  await page.keyboard.press('Escape');
  await page.keyboard.press('/');
  await page.keyboard.type('web');
  console.log('filtered worktrees', await page.getByTestId('worktree-item').count());
  await page.keyboard.press('j'); // must type into the input, not navigate
  console.log('filter value', await page.getByTestId('sidebar-filter').inputValue());
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.keyboard.press('g');
  await page.keyboard.press('i');
  console.log('inbox current', await attrs(page, '[data-testid="inbox-item"]', ['aria-current']));
  await page.getByTestId('theme-toggle').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outDir}/06-light.png` });

  console.log('console errors/warnings:', errors.length ? errors.slice(0, 20) : 'none');
  await browser.close();
}

await main();
