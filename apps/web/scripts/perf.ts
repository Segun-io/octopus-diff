/**
 * Render benchmark against the large mock dataset (30 worktrees × 200 files = 6000 files in the
 * Inbox) in headless Chromium.
 *
 *   pnpm --filter @octopus-diff/web build      # a preview serves the production build
 *   pnpm --filter @octopus-diff/web perf       # starts its own mock + preview, fresh every run
 *
 * With no `BASE_URL` it starts the mock (large dataset, no simulator, merge noise on) and
 * `vite preview` of `dist/` in this process and stops them at the end. `BASE_URL=http://host:port`
 * measures a server you started (then it must serve `MOCK_DATASET=large`: the script checks the
 * worktree count and says so; the default `preview:mock` serves the small `demo` dataset, whose
 * worktrees can have no files at all, which is what broke this script in #68).
 *
 * Env: `SCOPE` (`working`, the default: no merge noise; or `review`: the To review scope, where the
 * noise is wrapped in a collapsed group per worktree), `MOCK_MERGE_NOISE=0` (own mock only),
 * `PERF_OUT=<file>` (also write the JSON there), `PERF_SMOKE=1` (fewer iterations, about 8 s: the
 * CI guard, see docs/bench/README.md). Prints a JSON summary (all times in ms) and exits 1 when a
 * structural check fails (virtualisation broke, a wait timed out, page errors); it never judges
 * timings: those are for you to compare against docs/bench/web-perf.json.
 *
 * Every wait is on a real condition (the scope's own list, the viewer's data attributes, the
 * refresh indicator's own transitions observed inside the page), never a fixed sleep. Needs
 * `[data-testid=scope-select]`'s options and a selected first file; if the UI changes those, the
 * load wait (step 1) times out with the page state in the message.
 * Fix history: 2026-11-11 (#26) the default scope became "To review" and the old wait never ended;
 * 2026-11-12 (#51) a live edit stopped refetching the projects list and the inbox: it fetches the
 * changed inbox rows only (one request); that fetch now drives the refresh indicator (it goes
 * through React Query), and the request check asserts the new shape instead of "projects + files";
 * 2026-11-12 (#68) the script needed `MOCK_DATASET=large` without saying so (the first file of a
 * demo worktree can be missing, so `J` never matched), and the live-refresh number was quantised
 * by Playwright's polling (see docs/reports/web-perf-script.md).
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const LIBS = path.join(homedir(), '.cache/octopus-diff-dev/chromium-libs/usr/lib/x86_64-linux-gnu');
if (existsSync(LIBS)) {
  process.env.LD_LIBRARY_PATH = [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}
const scopeKind = process.env.SCOPE ?? 'working';
const smoke = process.env.PERF_SMOKE === '1';
/** The large mock dataset (mock/backend.ts): what every number in docs/bench/web-perf.json is on. */
const DATASET = { worktrees: 30, filesPerWorktree: 200 };
const ITER = smoke
  ? { j: 20, switches: 8, refreshes: 3 }
  : { j: 200, switches: DATASET.worktrees, refreshes: 10 };

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

/** The mock this run measures: its own (fresh), or the server at BASE_URL (checked). */
async function target(): Promise<{ url: string; own: boolean; close: () => Promise<void> }> {
  if (process.env.BASE_URL) {
    const url = process.env.BASE_URL.replace(/\/$/, '');
    const res = await fetch(`${url}/api/projects`).catch((e: unknown) => {
      throw new Error(
        `cannot reach ${url} (${e instanceof Error ? e.message : e}). Start it, or leave BASE_URL unset so this script starts its own mock`,
      );
    });
    const body = (await res.json()) as { projects: { worktrees: unknown[] }[] };
    const worktrees = body.projects.reduce((n, p) => n + p.worktrees.length, 0);
    if (worktrees < DATASET.worktrees) {
      throw new Error(
        `${url} serves ${worktrees} worktrees, this benchmark needs the large mock dataset (${DATASET.worktrees}): start it with MOCK_DATASET=large (the default dataset is "demo"), or leave BASE_URL unset`,
      );
    }
    return { url, own: false, close: async () => undefined };
  }
  const { startMockPreview } = await import('../mock/preview-server.js');
  const preview = await startMockPreview({
    dataset: 'large',
    intervalMs: 0,
    mergeNoise: process.env.MOCK_MERGE_NOISE !== '0',
  });
  return { url: preview.url, own: true, close: () => preview.close() };
}

async function main() {
  const server = await target();
  try {
    await measure(server.url);
  } finally {
    await server.close();
  }
}

async function measure(base: string) {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const browser = await chromium.launch();
  try {
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
    const apiRequests: { at: number; url: string }[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/')) apiRequests.push({ at: Date.now(), url: r.url() });
    });

    const longTasksSince = async (since: number) =>
      page.evaluate(
        (s) => window.__longTasks.filter((t) => t.start >= s).map((t) => t.duration),
        since,
      );
    const now = () => page.evaluate(() => performance.now());
    /** What the page shows, for the message of a wait that timed out. */
    const pageState = () =>
      page
        .evaluate(() => {
          // No helper functions in here: tsx's keepNames wraps them in a `__name` the page lacks.
          const viewer = document.querySelector('[data-testid="diff-viewer"]');
          return JSON.stringify({
            scope: document
              .querySelector('[data-testid="scope-select"]')
              ?.getAttribute('data-scope'),
            files: document.querySelectorAll('[data-testid="file-item"]').length,
            groups: document.querySelectorAll('[data-testid="file-group"]').length,
            worktrees: document.querySelectorAll('[data-testid="worktree-item"]').length,
            // The sidebar list is virtual (#13): rows in it vs rows mounted.
            listed: document
              .querySelector('[data-testid="sidebar-list"]')
              ?.getAttribute('data-total'),
            current: document
              .querySelector('[data-testid="worktree-item"][aria-current="true"]')
              ?.getAttribute('data-worktree-id'),
            firstFile: document
              .querySelector('[data-testid="file-item"]')
              ?.getAttribute('data-worktree-id'),
            viewer: viewer?.getAttribute('data-state'),
            placeholder: viewer?.getAttribute('data-placeholder'),
          });
        })
        .catch((e: unknown) => `(cannot read the page: ${e instanceof Error ? e.message : e})`);
    const waitStep = async <T>(what: string, wait: Promise<T>): Promise<T> => {
      try {
        return await wait;
      } catch (e) {
        throw new Error(
          `${what}: ${e instanceof Error ? e.message.split('\n')[0] : e}\n  page state: ${await pageState()}`,
        );
      }
    };

    // 1. Initial load.
    await page.goto(base);
    await waitStep(
      'app never became ready',
      page.locator('[data-testid="app"][data-ready="true"]').waitFor({ timeout: 30_000 }),
    );
    // The default scope is "To review"; the benchmark measures a busy inbox in the scope this
    // script was written for (`working`) or, with SCOPE=review, the merge-noise one.
    await page.getByTestId('scope-select').selectOption(scopeKind);
    // The viewer may already be `ready` for another scope's first file: wait for this scope's list,
    // every worktree of the dataset in the sidebar (the Inbox fills in project batches) and a
    // viewer that shows this scope's diff.
    await waitStep(
      `load wait (scope ${scopeKind})`,
      page.waitForFunction(
        ({ kind, worktrees }) => {
          const viewer = document.querySelector('[data-testid="diff-viewer"]');
          return (
            document
              .querySelector('[data-testid="scope-select"]')
              ?.getAttribute('data-scope')
              ?.startsWith(kind) &&
            document.querySelectorAll('[data-testid="file-item"]').length > 0 &&
            // Every worktree is in the sidebar's list (it is virtual: only a window is mounted).
            Number(
              document.querySelector('[data-testid="sidebar-list"]')?.getAttribute('data-total'),
            ) >= worktrees &&
            viewer?.getAttribute('data-state') === 'ready' &&
            // ...and not the previous scope's diff of the same file kept as placeholder data.
            viewer.getAttribute('data-placeholder') !== 'true'
          );
        },
        { kind: scopeKind, worktrees: DATASET.worktrees },
        { timeout: 30_000 },
      ),
    );
    const load = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as
        | PerformanceNavigationTiming
        | undefined;
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
      return {
        fcp,
        domContentLoaded: nav?.domContentLoadedEventEnd ?? null,
        // First list of the scope shown; `inboxCompleteAt` (below) is when all groups are in.
        readyAt: performance.now(),
      };
    });
    // The Inbox fills in project batches after the first list is shown (3 of 30 groups at the first
    // paint, all of them ~1.4 s later): measure on the complete one, and report both times.
    await waitStep(
      'the Inbox never showed every worktree group',
      page.waitForFunction(
        (n) => document.querySelectorAll('[data-testid="file-group"]').length >= n,
        DATASET.worktrees,
        { timeout: 30_000 },
      ),
    );
    const inboxCompleteAt = await now();
    const loadLongTasks = await longTasksSince(0);
    const fileRows = await page.getByTestId('file-item').count();
    const groups = await page.getByTestId('file-group').count();

    // 2. j navigation in the inbox (6000 files): keydown → next frame painted.
    const t2 = await now();
    const jTimes = await page.evaluate(async (n) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) {
        const t = performance.now();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
        await new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        );
        out.push(performance.now() - t);
      }
      return out;
    }, ITER.j);
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

    // 4. J through the worktrees (each has 200 files): the press moves the current worktree and the
    // file list shows that worktree's files, first row included.
    const t4 = await now();
    const switchTimes: number[] = [];
    const visited = new Set<string>();
    for (let i = 0; i < ITER.switches; i++) {
      const before = await page.evaluate(() =>
        document
          .querySelector('[data-testid="worktree-item"][aria-current="true"]')
          ?.getAttribute('data-worktree-id'),
      );
      const start = Date.now();
      await page.keyboard.press('J');
      await waitStep(
        `J #${i + 1} (from worktree ${before ?? 'none'})`,
        page.waitForFunction(
          (prev) => {
            const current = document.querySelector(
              '[data-testid="worktree-item"][aria-current="true"]',
            );
            const id = current?.getAttribute('data-worktree-id');
            const first = document.querySelector('[data-testid="file-item"]');
            return !!id && id !== prev && first?.getAttribute('data-worktree-id') === id;
          },
          before ?? null,
          { timeout: 10_000 },
        ),
      );
      switchTimes.push(Date.now() - start);
      const id = await page.evaluate(() =>
        document
          .querySelector('[data-testid="worktree-item"][aria-current="true"]')
          ?.getAttribute('data-worktree-id'),
      );
      if (id) visited.add(id);
    }
    const switchLongTasks = await longTasksSince(t4);

    // 5. Live refresh in the inbox: mutate a worktree, time until the refresh indicator is idle
    // again. Observed inside the page (MutationObserver on the indicator, clock started just before
    // the mutation request): a Playwright `waitFor` polls on a 100 ms grid, which quantised this
    // number to ~90 or ~190 ms depending on a few ms of server time (#68).
    await page.keyboard.press('g');
    await page.keyboard.press('i');
    await waitStep(
      'inbox idle before the refresh measurements',
      page.locator('[data-testid="refresh-indicator"][data-state="idle"]').waitFor(),
    );
    const t5 = await now();
    const refreshTimes: number[] = [];
    const refreshRequests: number[] = [];
    /** The API paths each refresh requested (#51: the inbox's changed rows only, no projects). */
    const refreshUrls: string[][] = [];
    for (let i = 0; i < ITER.refreshes; i++) {
      const requestsBefore = apiRequests.length;
      // Wrapped like every other wait: a stuck refresh prints the scope, the current worktree, the
      // file counts and the viewer state, not only the indicator's.
      const elapsed = await waitStep(
        `live refresh ${i + 1} of ${ITER.refreshes}`,
        page.evaluate(async () => {
          const indicator = document.querySelector('[data-testid="refresh-indicator"]');
          if (!indicator) throw new Error('no refresh indicator');
          let sawRefreshing = false;
          const settled = new Promise<number>((resolve, reject) => {
            const timer = setTimeout(
              () =>
                reject(
                  new Error(`refresh indicator stuck in "${indicator.getAttribute('data-state')}"`),
                ),
              10_000,
            );
            new MutationObserver((_, observer) => {
              if (indicator.getAttribute('data-state') === 'refreshing') sawRefreshing = true;
              else if (sawRefreshing && indicator.getAttribute('data-state') === 'idle') {
                clearTimeout(timer);
                observer.disconnect();
                resolve(performance.now());
              }
            }).observe(indicator, { attributes: true, attributeFilter: ['data-state'] });
          });
          const t = performance.now();
          const res = await fetch('/api/__mock/mutate?action=edit', { method: 'POST' });
          if (!res.ok) throw new Error(`mutate failed: ${res.status}`);
          return (await settled) - t;
        }),
      );
      refreshTimes.push(elapsed);
      const made = apiRequests.slice(requestsBefore).filter((r) => !r.url.includes('/__mock/'));
      refreshRequests.push(made.length);
      refreshUrls.push(made.map((r) => r.url));
    }
    const refreshLongTasks = await longTasksSince(t5);
    const memory = await page
      .evaluate(() => {
        const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        return m ? Math.round(m.usedJSHeapSize / 1024 / 1024) : null;
      })
      .catch(() => null);

    // Structural checks: virtualisation holds, every step ran, nothing threw. Timings are reported,
    // not judged (they depend on the machine).
    check('page errors', errors.length === 0, `${errors.length}`);
    check(
      'virtualised list (mounted rows at load / after scrolling < 120)',
      fileRows > 0 && fileRows < 120 && mountedRows > 0 && mountedRows < 120,
      `${fileRows} / ${mountedRows}`,
    );
    check(
      'the list is long (a 6000-file inbox)',
      scroll.height > DATASET.worktrees * DATASET.filesPerWorktree * 10,
      `${scroll.height} px`,
    );
    check(
      'J visited distinct worktrees',
      visited.size >= Math.min(ITER.switches, DATASET.worktrees) - 1,
      `${visited.size} of ${ITER.switches} presses`,
    );
    check(
      // Since #51 a live edit in the Inbox fetches the changed worktree's rows
      // (`/api/inbox?worktreeIds=`) and never the projects list (the event carries the row).
      'a refresh fetches the changed inbox rows only (no /api/projects, #51)',
      refreshUrls.every(
        (urls) =>
          urls.some((u) => u.includes('/api/inbox?') && u.includes('worktreeIds=')) &&
          !urls.some((u) => new URL(u).pathname === '/api/projects'),
      ),
      `requests per refresh: ${refreshRequests.join(', ')}; ${refreshUrls
        .map((urls) => urls.map((u) => new URL(u).pathname).join(' + ') || 'none')
        .join(' | ')}`,
    );

    const summary = {
      dataset: {
        scope: scopeKind,
        mode: smoke ? 'smoke' : 'full',
        server: process.env.BASE_URL ? 'BASE_URL' : 'own mock',
        worktrees: DATASET.worktrees,
        filesPerWorktree: DATASET.filesPerWorktree,
        inboxGroups: groups,
        mountedRowsAtLoad: fileRows,
      },
      load: { ...load, inboxCompleteAt, longTasks: stats(loadLongTasks) },
      jNavigation: { perPressToNextFrame: stats(jTimes), longTasks: stats(jLongTasks) },
      scroll: {
        listHeightPx: scroll.height,
        frameDelta: stats(scroll.frames),
        framesOver50ms: scroll.frames.filter((f) => f > 50).length,
        longTasks: stats(scrollLongTasks),
        mountedRowsAfterScroll: mountedRows,
      },
      worktreeSwitchJ: { wallClock: stats(switchTimes), longTasks: stats(switchLongTasks) },
      liveRefreshInbox: {
        mutateToIdle: stats(refreshTimes),
        requestsPerRefresh: stats(refreshRequests),
        longTasks: stats(refreshLongTasks),
      },
      usedJsHeapMB: memory,
      pageErrors: errors,
      checks,
    };
    const json = JSON.stringify(summary, null, 2);
    console.log(json);
    if (process.env.PERF_OUT) await writeFile(process.env.PERF_OUT, `${json}\n`);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      console.error(
        `perf: ${failed.length} check(s) failed: ${failed.map((c) => `${c.name} (${c.detail})`).join('; ')}`,
      );
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (e) {
  console.error(`perf: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
