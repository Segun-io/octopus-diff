/**
 * Paged file lists (#42) in the browser against the real daemon and git: a worktree with 1200
 * rewritten files is listed in pages of 500 (the web's page size). The first page renders with a
 * footer and more pages load at the end of the list; `n`, the palette's file search, the diff
 * pane and bulk review reach files that are not loaded yet; no response passes about 1 MB.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ApiClient, FILES_PAGE_DEFAULT, TEST_IDS } from '@octopus-diff/contracts';
import { fixtureId, runGit } from '@octopus-diff/fixtures';
import type { Response } from '@playwright/test';
import { TestDaemon } from '../support/daemon.js';
import { test as base, expect } from '../support/test.js';

const FILES = 1200;
const WORKING = { kind: 'working' as const };
/** The footer of a partly loaded list (`FILE_LIST_MORE_TEST_ID` in the web's FileList). */
const MORE = 'file-list-more';

/** `d00/f0000.txt` … : path order is the number order. */
const rel = (i: number) =>
  `d${String(Math.floor(i / 100)).padStart(2, '0')}/f${String(i).padStart(4, '0')}.txt`;

interface Paged {
  daemon: TestDaemon;
  api: ApiClient;
  worktreeId: string;
  projectId: string;
}

const test = base.extend<{ paged: Paged }>({
  paged: async ({ manifest }, use) => {
    const dir = join(manifest.root, `paged-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const env = { configPath: manifest.git.configPath, vars: manifest.git.vars };
    await runGit(['init', '-q', dir], { cwd: manifest.root, env });
    for (let d = 0; d < FILES / 100; d++) {
      await mkdir(join(dir, `d${String(d).padStart(2, '0')}`), { recursive: true });
    }
    for (let i = 0; i < FILES; i++) await writeFile(join(dir, rel(i)), `line ${i}\n`);
    await runGit(['add', '-A'], { cwd: dir, env });
    await runGit(['commit', '-q', '-m', 'files'], {
      cwd: dir,
      env,
      extraEnv: {
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      },
    });
    // A format run: every file rewritten.
    for (let i = 0; i < FILES; i++) await writeFile(join(dir, rel(i)), `line ${i}\nformatted\n`);
    const daemon = await TestDaemon.start({ manifest, register: 'none' });
    try {
      const api = daemon.client;
      await api.addProject({ path: dir });
      const worktreeId = fixtureId(dir);
      await expect
        .poll(
          async () =>
            (await api.listProjects()).projects
              .flatMap((p) => p.worktrees)
              .find((w) => w.worktree.id === worktreeId)?.summary?.changedFiles ?? 0,
          { timeout: 30_000 },
        )
        .toBe(FILES);
      await use({ daemon, api, worktreeId, projectId: fixtureId(join(dir, '.git')) });
    } finally {
      await daemon.close();
    }
  },
});

/** Every `/api/*` response the page got, with its decoded size. */
function recordSizes(page: import('@playwright/test').Page) {
  const sizes: Array<{ url: string; bytes: number }> = [];
  page.on('response', (response: Response) => {
    const url = response.url();
    if (!url.includes('/api/') || url.includes('/api/events')) return;
    void response
      .body()
      .then((body) => sizes.push({ url, bytes: body.length }))
      .catch(() => {});
  });
  return sizes;
}

test.describe('paged file lists (#42)', () => {
  test('first page, then more at the end of the list; no response over 1 MB', async ({
    page,
    app,
    paged,
  }) => {
    const sizes = recordSizes(page);
    await app.open(paged.daemon.authUrl, {
      prefs: { settledOpen: true, defaultScope: 'working', lastWorktree: paged.worktreeId },
    });
    const more = app.byTestId(MORE);
    await expect(more).toHaveAttribute('data-loaded', String(FILES_PAGE_DEFAULT));
    await expect(more).toHaveAttribute('data-total', String(FILES));
    await expect(app.fileItem(rel(0))).toBeVisible();
    // Scrolling to the end loads the next pages.
    for (let i = 0; i < 20; i++) {
      await app.fileList.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      if ((await more.count()) === 0) break;
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    }
    await expect(more).toHaveCount(0, { timeout: 15_000 });
    await expect(app.fileItem(rel(FILES - 1))).toBeAttached();
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes.map((s) => s.bytes))).toBeLessThan(1_000_000);
    // The file list requests asked for pages.
    expect(sizes.some((s) => s.url.includes('/files?') && s.url.includes('cursor='))).toBe(true);
  });

  test('n reaches the first unreviewed file beyond the loaded page; the diff pane shows it', async ({
    app,
    paged,
  }) => {
    // The first 520 files reviewed: the whole first page and more.
    const { files } = await paged.api.listFiles(paged.worktreeId, { scope: WORKING, limit: 520 });
    const res = await paged.api.bulkReview({
      target: { kind: 'worktree', worktreeId: paged.worktreeId },
      scope: WORKING,
      reviewed: true,
      paths: files.map((f) => ({ path: f.path })),
    });
    expect(res.changed).toBe(520);
    await app.open(paged.daemon.authUrl, {
      prefs: {
        settledOpen: true,
        defaultScope: 'working',
        lastWorktree: paged.worktreeId,
        showReviewed: true,
      },
    });
    await expect(app.byTestId(MORE)).toHaveAttribute('data-loaded', String(FILES_PAGE_DEFAULT));
    await app.openFile(rel(0));
    await app.focusApp();
    await app.press('n');
    await expect(app.diffViewer).toHaveAttribute('data-path', rel(520), { timeout: 15_000 });
    await expect(app.selectedFile).toHaveAttribute('data-path', rel(520));
    await expect(app.selectedFile).toHaveAttribute('data-reviewed', 'false');
    await app.waitDiffSettled();
    // And on: the next one.
    await app.press('n');
    await expect(app.selectedFile).toHaveAttribute('data-path', rel(521));
  });

  test("the palette's file search jumps to a file that is not loaded", async ({ app, paged }) => {
    await app.open(paged.daemon.authUrl, {
      prefs: { settledOpen: true, defaultScope: 'working', lastWorktree: paged.worktreeId },
    });
    await expect(app.byTestId(MORE)).toHaveAttribute('data-loaded', String(FILES_PAGE_DEFAULT));
    await app.focusApp();
    await app.press('Control+k');
    const input = app.byTestId(TEST_IDS.commandPaletteInput);
    await expect(input).toBeVisible();
    const target = rel(1150);
    await input.fill(target);
    const item = app
      .byTestId(TEST_IDS.commandPaletteItem)
      .filter({ hasText: target })
      .and(app.page.locator('[data-kind="file"]'));
    await expect(item.first()).toBeVisible();
    await item.first().click();
    await expect(app.diffViewer).toHaveAttribute('data-path', target, { timeout: 15_000 });
    await expect(app.selectedFile).toHaveAttribute('data-path', target);
    await app.waitDiffSettled();
  });

  test('bulk review of the open worktree marks the whole list, loaded or not', async ({
    app,
    paged,
  }) => {
    await app.open(paged.daemon.authUrl, {
      prefs: {
        settledOpen: true,
        defaultScope: 'working',
        lastWorktree: paged.worktreeId,
        showReviewed: true,
      },
    });
    await expect(app.byTestId(MORE)).toHaveAttribute('data-loaded', String(FILES_PAGE_DEFAULT));
    await app.focusApp();
    await app.press('Shift+R');
    await expect
      .poll(
        async () =>
          (await paged.api.listFiles(paged.worktreeId, { scope: WORKING, limit: 1 })).counts
            ?.reviewed,
        { timeout: 15_000 },
      )
      .toBe(FILES);
  });
});
