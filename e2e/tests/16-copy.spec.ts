/**
 * Copy tools (docs/COPY-TOOLS.md §7, PLAN §8 items 19–23): branch / worktree path / commit id from
 * the worktree menu, path / name / absolute path from the file row menu and the diff header,
 * the palette commands, and the textarea fallback where `navigator.clipboard` is missing (a
 * plain-http LAN address); then line selection in the diff (a drag on the line numbers) with
 * the Copy bar, Copy as Markdown, Ctrl+C, Esc and a file change. Web only: these flows send no
 * daemon request.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TEST_IDS } from '@octopus-diff/contracts';
import { findWorktree, LIVE_FILES } from '@octopus-diff/fixtures';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/test.js';

const COPY = {
  branch: 'copy-branch',
  worktreePath: 'copy-worktree-path',
  sha: 'copy-sha',
  path: 'copy-path',
  name: 'copy-name',
  absolutePath: 'copy-absolute-path',
  pathButton: 'copy-path-button',
  diffMenu: 'diff-header-menu',
  toast: 'copy-toast',
  bar: 'copy-selection-bar',
  barCopy: 'copy-selection-plain',
  barMarkdown: 'copy-selection-markdown',
} as const;

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

async function clipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** Clears the clipboard so a stale value cannot satisfy the next expectation. */
async function resetClipboard(page: Page): Promise<void> {
  await page.evaluate(() => navigator.clipboard.writeText('<empty>'));
}

test.describe('copy names and paths', () => {
  test('worktree row menu: branch name, worktree path, commit id', async ({
    manifest,
    daemon,
    app,
    page,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    await app.open(daemon.authUrl);
    const row = app.worktreeItem(live.id);

    await resetClipboard(page);
    await row.click({ button: 'right' });
    await app.byTestId(COPY.branch).click();
    await expect.poll(() => clipboard(page)).toBe(live.branch);
    await expect(app.byTestId(COPY.toast)).toHaveAttribute('data-state', 'copied');
    await expect(app.byTestId(COPY.toast)).toContainText('Copied branch name');

    await row.click({ button: 'right' });
    await app.byTestId(COPY.worktreePath).click();
    await expect.poll(() => clipboard(page)).toBe(live.path);

    await row.click({ button: 'right' });
    await app.byTestId(COPY.sha).click();
    await expect.poll(() => clipboard(page)).toBe(live.headSha);
  });

  test('a detached worktree has no branch name to copy', async ({ manifest, daemon, app }) => {
    const detached = findWorktree(manifest, 'beta-detached').worktree;
    await app.open(daemon.authUrl);
    await app.worktreeItem(detached.id).click({ button: 'right' });
    await expect(app.byTestId(COPY.branch)).toHaveAttribute('aria-disabled', 'true');
    await expect(app.byTestId(COPY.branch)).toHaveAttribute('title', 'Detached HEAD');
    await expect(app.byTestId(COPY.sha)).toBeVisible();
  });

  test('file row menu and diff header: path, name, absolute path', async ({
    manifest,
    daemon,
    app,
    page,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    const path = LIVE_FILES.review;
    await app.open(daemon.authUrl);
    await app.selectWorktree(live.id);
    await app.openFile(path);

    await resetClipboard(page);
    await app.fileItem(path).click({ button: 'right' });
    await app.byTestId(COPY.path).click();
    await expect.poll(() => clipboard(page)).toBe(path);

    await app.fileItem(path).click({ button: 'right' });
    await app.byTestId(COPY.name).click();
    await expect.poll(() => clipboard(page)).toBe('review-me.ts');

    await app.fileItem(path).click({ button: 'right' });
    await app.byTestId(COPY.absolutePath).click();
    await expect.poll(() => clipboard(page)).toBe(join(live.path, path));

    // The icon button next to the path in the diff header.
    await resetClipboard(page);
    const button = app.byTestId(COPY.pathButton);
    await button.click();
    await expect.poll(() => clipboard(page)).toBe(path);
    await expect(button).toHaveAttribute('data-copied', 'true');

    // The header's ⋯ menu has the file and the worktree items.
    await app.byTestId(COPY.diffMenu).click();
    await app.byTestId(COPY.absolutePath).click();
    await expect.poll(() => clipboard(page)).toBe(join(live.path, path));
    await app.byTestId(COPY.diffMenu).click();
    await app.byTestId(COPY.worktreePath).click();
    await expect.poll(() => clipboard(page)).toBe(live.path);

    // …and the whole file's patch.
    await app.byTestId(COPY.diffMenu).click();
    await app.byTestId('copy-file-diff').click();
    await expect
      .poll(() => clipboard(page))
      .toMatch(/^diff --git a\/src\/review-me\.ts b\/src\/review-me\.ts\n/);
  });

  test('palette commands copy the open worktree and file', async ({
    manifest,
    daemon,
    app,
    page,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    await app.open(daemon.authUrl);
    await app.selectWorktree(live.id);
    await app.openFile(LIVE_FILES.review);

    const run = async (label: string) => {
      await app.focusApp();
      await app.press('Control+k');
      const input = app.byTestId(TEST_IDS.commandPaletteInput);
      await input.fill(label);
      await input.press('Enter');
    };
    await resetClipboard(page);
    await run('Copy worktree path');
    await expect.poll(() => clipboard(page)).toBe(live.path);
    await run('Copy absolute file path');
    await expect.poll(() => clipboard(page)).toBe(join(live.path, LIVE_FILES.review));
    await run('Copy branch name');
    await expect.poll(() => clipboard(page)).toBe(live.branch);
  });

  test('without navigator.clipboard (plain http on the LAN) the textarea fallback copies', async ({
    manifest,
    daemon,
    app,
    page,
    context,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'clipboard', {
        configurable: true,
        get: () => undefined,
      });
    });
    await app.open(daemon.authUrl);
    expect(await page.evaluate(() => navigator.clipboard === undefined)).toBe(true);

    // A second page of the same context still has the API, to read the result back.
    const reader = await context.newPage();
    await reader.goto(daemon.authUrl);
    await reader.evaluate(() => navigator.clipboard.writeText('<empty>'));

    await page.bringToFront();
    await app.worktreeItem(live.id).click({ button: 'right' });
    await app.byTestId(COPY.worktreePath).click();
    await expect(app.byTestId(COPY.toast)).toHaveAttribute('data-state', 'copied');
    await reader.bringToFront();
    await expect.poll(() => reader.evaluate(() => navigator.clipboard.readText())).toBe(live.path);
    await reader.close();
  });
});

/** Line-number cells of one kind in the open diff (the renderer's shadow DOM is open). */
async function gutterBoxes(page: Page, type: 'change-addition' | 'change-deletion') {
  return page.locator('[data-diff-scroller] [data-column-number]').evaluateAll(
    (els, kind) =>
      els
        .filter((e) => e.getAttribute('data-line-type') === kind)
        .map((e) => {
          const r = e.getBoundingClientRect();
          return {
            n: Number(e.getAttribute('data-column-number')),
            x: r.x + 6,
            y: r.y + r.height / 2,
          };
        }),
    type,
  );
}

/**
 * Presses on line number `from` and releases on `to` (both of `type`). The diff can re-render
 * between measuring the line numbers and the mouse presses (a refresh of the patch, the viewer's
 * own layout settling on a loaded runner), which moves the cells and makes the drag miss, so the
 * positions are measured again and the drag repeated until the Copy bar shows (at most 4 times).
 */
async function dragLines(
  page: Page,
  type: 'change-addition' | 'change-deletion',
  from: number,
  to: number,
): Promise<void> {
  await expect.poll(async () => (await gutterBoxes(page, type)).length).toBeGreaterThan(to);
  const bar = page.locator(`[data-testid="${COPY.bar}"]`);
  for (let attempt = 1; ; attempt++) {
    const boxes = await gutterBoxes(page, type);
    const a = boxes.find((b) => b.n === from);
    const b = boxes.find((x) => x.n === to);
    if (!a || !b) throw new Error(`no line number ${from} / ${to}`);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.mouse.up();
    const shown = await bar
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (shown || attempt >= 4) return;
  }
}

async function setMode(app: import('../support/app.js').AppPage, mode: 'split' | 'unified') {
  await app.setDiffMode(mode);
}

test.describe('copy selected diff lines', () => {
  test('select two lines → Copy bar → Copy as Markdown, Copy, Ctrl+C, Esc', async ({
    manifest,
    daemon,
    app,
    page,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    const path = LIVE_FILES.review;
    const lines = (await readFile(join(live.path, path), 'utf8')).split('\n');
    await app.open(daemon.authUrl);
    await app.selectWorktree(live.id);
    await app.openFile(path);
    await setMode(app, 'unified');

    await dragLines(page, 'change-addition', 2, 3);
    const bar = app.byTestId(COPY.bar);
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('data-start', '2');
    await expect(bar).toHaveAttribute('data-end', '3');
    await expect(bar).toHaveAttribute('data-side', 'additions');
    await expect(bar).toHaveAttribute('data-lines', '2');

    await resetClipboard(page);
    await app.byTestId(COPY.barMarkdown).click();
    const short = (live.headSha ?? '').slice(0, 7);
    await expect
      .poll(() => clipboard(page))
      .toBe(
        [
          `\`${path}\` L2–3 · \`${live.branch}\` · live`,
          `worktree \`${live.path}\` · uncommitted · head \`${short}\``,
          '',
          '```ts',
          lines[1],
          lines[2],
          '```',
        ].join('\n'),
      );
    await expect(app.byTestId(COPY.barMarkdown)).toHaveAttribute('data-copied', 'true');

    await app.byTestId(COPY.barCopy).click();
    await expect.poll(() => clipboard(page)).toBe(`${lines[1]}\n${lines[2]}`);

    // Ctrl+C with the line selection (and no text selection) copies the plain code too.
    await resetClipboard(page);
    await app.press('Control+c');
    await expect.poll(() => clipboard(page)).toBe(`${lines[1]}\n${lines[2]}`);

    // The bar never took focus, so j / k still move between files.
    expect(
      await page.evaluate(() => document.activeElement?.closest('[role="toolbar"]')),
    ).toBeNull();

    await app.press('Escape');
    await expect(bar).toHaveCount(0);
    await expect(page.locator('[data-line-selection]')).toHaveAttribute('data-line-selection', '');
  });

  test('split mode: a range on the old side copies the deleted lines', async ({
    manifest,
    daemon,
    app,
    page,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    await app.open(daemon.authUrl);
    await app.selectWorktree(live.id);
    await app.openFile(LIVE_FILES.review);
    await setMode(app, 'split');
    await dragLines(page, 'change-deletion', 4, 6);
    const bar = app.byTestId(COPY.bar);
    await expect(bar).toHaveAttribute('data-side', 'deletions');
    await expect(bar).toHaveAttribute('data-end-side', 'deletions');
    await expect(bar).toHaveAttribute('data-lines', '3');
    await resetClipboard(page);
    await app.byTestId(COPY.barMarkdown).click();
    await expect.poll(() => clipboard(page)).toMatch(/^`src\/review-me\.ts` old L4–6 · /);
    const text = await clipboard(page);
    expect(text).toContain('```diff\n@@ -4,3 +');
    expect(text.split('\n').filter((l) => l.startsWith('-'))).toHaveLength(3);
  });

  test('the selection clears when another file opens', async ({ manifest, daemon, app, page }) => {
    const live = findWorktree(manifest, 'live').worktree;
    await app.open(daemon.authUrl);
    await app.selectWorktree(live.id);
    await app.openFile(LIVE_FILES.review);
    await setMode(app, 'unified');
    await dragLines(page, 'change-addition', 1, 2);
    await expect(app.byTestId(COPY.bar)).toBeVisible();
    await app.openFile(LIVE_FILES.edit);
    await expect(app.diffViewer).toHaveAttribute('data-path', LIVE_FILES.edit);
    await expect(app.byTestId(COPY.bar)).toHaveCount(0);
    await app.openFile(LIVE_FILES.review);
    await expect(app.byTestId(COPY.bar)).toHaveCount(0);
  });

  test('a text selection in the code copies only the code (no line numbers or markers)', async ({
    manifest,
    daemon,
    app,
    page,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    const path = LIVE_FILES.review;
    const lines = (await readFile(join(live.path, path), 'utf8')).split('\n');
    await app.open(daemon.authUrl);
    await app.selectWorktree(live.id);
    await app.openFile(path);
    await setMode(app, 'unified');
    // A line selection first: the later text drag must win.
    await dragLines(page, 'change-addition', 8, 9);
    await expect(app.byTestId(COPY.bar)).toBeVisible();
    const boxes = await gutterBoxes(page, 'change-addition');
    const a = boxes.find((b) => b.n === 2);
    const b = boxes.find((x) => x.n === 4);
    if (!a || !b) throw new Error('no lines');
    // From the start of line 2's code to past the end of line 4's.
    await page.mouse.move(a.x + 40, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x + 700, b.y, { steps: 6 });
    await page.mouse.up();
    await resetClipboard(page);
    await app.press('Control+c');
    await expect.poll(() => clipboard(page)).not.toBe('<empty>');
    const copied = await clipboard(page);
    expect(copied).toContain(lines[2]);
    expect(copied).not.toMatch(/^\s*\d+\s/m);
    expect(copied).not.toMatch(/^[+-]/m);
    expect(copied).not.toContain(lines[7]);
  });
});
