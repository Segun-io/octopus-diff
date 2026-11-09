/**
 * Copy tools (docs/COPY-TOOLS.md §7, PLAN §8 items 19–23): branch / worktree path / commit id from
 * the worktree menu, path / name / absolute path from the file row menu and the diff header,
 * the palette commands, and the textarea fallback where `navigator.clipboard` is missing (a
 * plain-http LAN address). Web only: these flows send no daemon request.
 */
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
