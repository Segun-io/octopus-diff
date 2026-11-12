/**
 * Render benchmark against the large mock dataset (30 worktrees × 200 files) in headless
 * Chromium. Start the server first, preferably the production build:
 *   pnpm build && MOCK_DATASET=large MOCK_INTERVAL_MS=0 WEB_PORT=4173 pnpm preview:mock
 *   BASE_URL=http://127.0.0.1:4173 pnpm perf
 * Prints a JSON summary (all times in ms). Needs `[data-testid=scope-select]`'s `working` option and a
 * selected first file (see step 1 below); if the UI changes those, this script fails at step 1.
 * `SCOPE=review` measures the To review scope, where the large dataset's merge noise (#34) is
 * wrapped in a collapsed group per worktree; the default (`working`) has none and is what the
 * numbers in docs/reports were taken with before #34.
 * Fix history: 2026-11-11 (#26) the default scope became "To review" and the old wait never ended.
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
const scopeKind = process.env.SCOPE ?? 'working';

declare global {
  interface Window {
    __longTasks: { start: number; duration: number }[];
  }
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    n: values.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? 0),
  };
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        window.__longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const longTasksSince = async (since: number) =>
    page.evaluate(
      (s) => window.__longTasks.filter((t) => t.start >= s).map((t) => t.duration),
      since,
    );
  const now = () => page.evaluate(() => performance.now());

  // 1. Initial load.
  await page.goto(base);
  await page.locator('[data-testid="app"][data-ready="true"]').waitFor({ timeout: 30_000 });
  // The default scope is "To review", which the mock has nothing in, so nothing is selected and
  // the viewer stays `empty`. The benchmark measures a busy inbox: show the uncommitted changes
  // (the scope this script was written for); the first file is then selected and the viewer ready.
  await page.getByTestId('scope-select').selectOption(scopeKind);
  // The viewer may already be `ready` for another scope's first file: wait for this scope's list.
  await page.waitForFunction(
    (kind) =>
      document
        .querySelector('[data-testid="scope-select"]')
        ?.getAttribute('data-scope')
        ?.startsWith(kind) &&
      document.querySelectorAll('[data-testid="file-item"]').length > 0 &&
      document.querySelector('[data-testid="diff-viewer"]')?.getAttribute('data-state') === 'ready',
    scopeKind,
    { timeout: 30_000 },
  );
  const load = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
    return {
      fcp,
      domContentLoaded: nav?.domContentLoadedEventEnd ?? null,
      readyAt: performance.now(),
    };
  });
  const loadLongTasks = await longTasksSince(0);
  const fileRows = await page.getByTestId('file-item').count();
  const groups = await page.getByTestId('file-group').count();

  // 2. j navigation in the inbox (6000 files): keydown → next frame painted.
  const t2 = await now();
  const jTimes = await page.evaluate(async () => {
    const out: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      out.push(performance.now() - t);
    }
    return out;
  });
  const jLongTasks = await longTasksSince(t2);

  // 3. Scroll the inbox file list top → bottom.
  const t3 = await now();
  const scroll = await page.evaluate(async () => {
    const list = document.querySelector<HTMLElement>('[data-testid="file-list"]');
    if (!list) return { frames: [] as number[], height: 0 };
    list.scrollTop = 0;
    const frames: number[] = [];
    let last = performance.now();
    while (list.scrollTop + list.clientHeight < list.scrollHeight - 1) {
      list.scrollTop += 600;
      await new Promise((r) => requestAnimationFrame(r));
      const t = performance.now();
      frames.push(t - last);
      last = t;
    }
    return { frames, height: list.scrollHeight };
  });
  const scrollLongTasks = await longTasksSince(t3);
  const mountedRows = await page.getByTestId('file-item').count();

  // 4. J through every worktree (each has 200 files).
  const t4 = await now();
  const switchTimes: number[] = [];
  for (let i = 0; i < 30; i++) {
    const start = Date.now();
    await page.keyboard.press('J');
    await page.waitForFunction(() => {
      const current = document.querySelector('[data-testid="worktree-item"][aria-current="true"]');
      const id = current?.getAttribute('data-worktree-id');
      const first = document.querySelector('[data-testid="file-item"]');
      return id && first?.getAttribute('data-worktree-id') === id;
    });
    switchTimes.push(Date.now() - start);
  }
  const switchLongTasks = await longTasksSince(t4);

  // 5. Live refresh in the inbox: mutate a worktree, wait for the refresh to settle.
  await page.keyboard.press('g');
  await page.keyboard.press('i');
  await page.locator('[data-testid="refresh-indicator"][data-state="idle"]').waitFor();
  const t5 = await now();
  const refreshTimes: number[] = [];
  for (let i = 0; i < 10; i++) {
    const before = await page.evaluate(() => performance.now());
    const changed = await page.evaluate(async () => {
      const res = await fetch('/api/__mock/mutate?action=edit', { method: 'POST' });
      return (await res.json()) as { worktreeId: string; path: string };
    });
    await page
      .locator('[data-testid="refresh-indicator"][data-state="refreshing"]')
      .waitFor({ timeout: 5000 })
      .catch(() => undefined);
    await page
      .locator('[data-testid="refresh-indicator"][data-state="idle"]')
      .waitFor({ timeout: 10_000 });
    refreshTimes.push((await page.evaluate(() => performance.now())) - before);
    void changed;
  }
  const refreshLongTasks = await longTasksSince(t5);

  const summary = {
    dataset: {
      scope: scopeKind,
      worktrees: 30,
      filesPerWorktree: 200,
      inboxGroups: groups,
      mountedRowsAtLoad: fileRows,
    },
    load: { ...load, longTasks: stats(loadLongTasks) },
    jNavigation: { perPressToNextFrame: stats(jTimes), longTasks: stats(jLongTasks) },
    scroll: {
      listHeightPx: scroll.height,
      frameDelta: stats(scroll.frames),
      framesOver50ms: scroll.frames.filter((f) => f > 50).length,
      longTasks: stats(scrollLongTasks),
      mountedRowsAfterScroll: mountedRows,
    },
    worktreeSwitchJ: { wallClock: stats(switchTimes), longTasks: stats(switchLongTasks) },
    liveRefreshInbox: { mutateToIdle: stats(refreshTimes), longTasks: stats(refreshLongTasks) },
    pageErrors: errors,
  };
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
}

await main();
