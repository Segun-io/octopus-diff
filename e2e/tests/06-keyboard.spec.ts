/**
 * PLAN §8 item 7 (shortcuts from §4.2): `n` jumps to the next unreviewed file across projects;
 * `j`/`k`, `J`/`K`, `r`, `s`, `/`, `g i` and `?` all work without a mouse.
 */
import { TEST_IDS } from '@octopus-diff/contracts';
import { findWorktree } from '@octopus-diff/fixtures';
import { expect, test } from '../support/test.js';

test.describe('§8.7 keyboard', () => {
  test('j / k move between files', async ({ manifest, daemon, app }) => {
    const sink = findWorktree(manifest, 'kitchen-sink').worktree;
    await app.open(daemon.authUrl);
    await app.selectWorktree(sink.id);
    const files = await app.fileItems();
    expect(files.length).toBeGreaterThanOrEqual(4);
    await app.openFile(files[0]?.path ?? '');
    await app.focusApp();
    await app.press('j');
    await expect(app.selectedFile).toHaveAttribute('data-path', files[1]?.path ?? '');
    await expect(app.diffViewer).toHaveAttribute('data-path', files[1]?.path ?? '');
    await app.press('j');
    await expect(app.selectedFile).toHaveAttribute('data-path', files[2]?.path ?? '');
    await app.press('k');
    await expect(app.selectedFile).toHaveAttribute('data-path', files[1]?.path ?? '');
  });

  test('J / K move between worktrees', async ({ manifest, daemon, app }) => {
    await app.open(daemon.authUrl);
    const ids = await app
      .allWorktreeItems()
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-worktree-id') ?? ''));
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const startId = findWorktree(manifest, 'alpha').worktree.id;
    const start = ids.indexOf(startId);
    expect(start).toBeGreaterThanOrEqual(0);
    await app.selectWorktree(startId);
    await app.focusApp();
    await app.press('Shift+J');
    await expect(app.worktreeItem(ids[start + 1] ?? '')).toHaveAttribute('aria-current', 'true');
    await app.press('Shift+J');
    await expect(app.worktreeItem(ids[start + 2] ?? '')).toHaveAttribute('aria-current', 'true');
    await app.press('Shift+K');
    await expect(app.worktreeItem(ids[start + 1] ?? '')).toHaveAttribute('aria-current', 'true');
  });

  test('s toggles split/unified, r toggles reviewed', async ({ manifest, daemon, app }) => {
    const gamma = findWorktree(manifest, 'gamma').worktree;
    await app.open(daemon.authUrl);
    await app.selectWorktree(gamma.id);
    await app.setToggle(TEST_IDS.showReviewedToggle, true);
    await app.openFile('cmd/gamma.go');
    await app.focusApp();

    const mode = await app.diffViewer.getAttribute('data-mode');
    const other = mode === 'split' ? 'unified' : 'split';
    await app.press('s');
    await expect(app.diffViewer).toHaveAttribute('data-mode', other);
    await expect(app.byTestId(TEST_IDS.diffModeToggle)).toHaveAttribute('data-mode', other);
    await app.press('s');
    await expect(app.diffViewer).toHaveAttribute('data-mode', mode ?? '');

    const item = app.fileItem('cmd/gamma.go');
    await expect(item).toHaveAttribute('data-reviewed', 'false');
    await app.press('r');
    await expect(item).toHaveAttribute('data-reviewed', 'true');
    await expect(app.byTestId(TEST_IDS.reviewToggle)).toHaveAttribute('aria-pressed', 'true');
    await app.press('r');
    await expect(item).toHaveAttribute('data-reviewed', 'false');
  });

  test('/ focuses the filter, g i opens the inbox, ? opens help', async ({
    manifest,
    daemon,
    app,
  }) => {
    await app.open(daemon.authUrl);
    await app.selectWorktree(findWorktree(manifest, 'beta').worktree.id);
    await app.focusApp();

    await app.press('/');
    await expect(app.byTestId(TEST_IDS.sidebarFilterSearch)).toBeFocused();
    await app.page.keyboard.type('gamma');
    await app.page.keyboard.press('Enter'); // picks the best match: the gamma project
    await expect(app.worktreeItem(findWorktree(manifest, 'alpha').worktree.id)).toBeHidden();
    await app.clearFilters();
    await app.focusApp();

    await app.press('g');
    await app.press('i');
    await expect(app.inbox).toHaveAttribute('aria-current', 'true');

    await app.press('?');
    await expect(app.byTestId(TEST_IDS.helpDialog)).toBeVisible();
    for (const key of ['j', 'k', 'J', 'K', 'n', 'r', 's', '/', '?']) {
      await expect(app.byTestId(TEST_IDS.helpDialog)).toContainText(key);
    }
    await app.press('Escape');
    await expect(app.byTestId(TEST_IDS.helpDialog)).toBeHidden();
  });

  test('n jumps to the next unreviewed file across projects', async ({ manifest, daemon, app }) => {
    // Review everything except one file in each of three projects.
    const keep = [
      { worktree: findWorktree(manifest, 'alpha'), path: 'README.md' },
      { worktree: findWorktree(manifest, 'gamma'), path: 'cmd/gamma.go' },
      { worktree: findWorktree(manifest, 'kitchen-sink'), path: 'src/scratch.ts' },
    ];
    const keepKeys = new Set(keep.map((k) => `${k.worktree.worktree.id}:${k.path}`));
    const inbox = await daemon.client.inbox();
    for (const entry of inbox.entries) {
      for (const file of entry.files) {
        if (keepKeys.has(`${entry.worktree.id}:${file.path}`)) continue;
        await daemon.client.setReview({
          projectId: entry.project.id,
          scopeKind: 'working',
          path: file.path,
          ...(file.rawPath ? { rawPath: file.rawPath } : {}),
          patchHash: file.patchHash,
          reviewed: true,
        });
      }
    }
    const unreviewed = await daemon.client.inbox({ onlyUnreviewed: true });
    expect(
      unreviewed.entries.flatMap((e) => e.files.map((f) => `${e.worktree.id}:${f.path}`)).sort(),
    ).toEqual([...keepKeys].sort());

    await app.open(daemon.authUrl);
    await app.setToggle(TEST_IDS.showReviewedToggle, true);
    // Start on a reviewed file in a worktree whose files are all reviewed.
    const beta = findWorktree(manifest, 'beta').worktree;
    await app.selectWorktree(beta.id);
    const betaFirst = (await app.fileItems())[0]?.path ?? '';
    await app.openFile(betaFirst);
    await expect(app.selectedFile).toHaveAttribute('data-reviewed', 'true');
    await app.focusApp();

    const visited = new Set<string>();
    for (let i = 0; i < keep.length; i++) {
      await app.press('n');
      await expect(async () => {
        const wt = await app.diffViewer.getAttribute('data-worktree-id');
        const path = await app.diffViewer.getAttribute('data-path');
        const key = `${wt}:${path}`;
        expect(keepKeys.has(key), `n landed on ${key}`).toBe(true);
        expect(visited.has(key), `n revisited ${key} before visiting all`).toBe(false);
      }).toPass({ timeout: 5000 });
      visited.add(
        `${await app.diffViewer.getAttribute('data-worktree-id')}:${await app.diffViewer.getAttribute('data-path')}`,
      );
      await expect(app.selectedFile).toHaveAttribute('data-reviewed', 'false');
    }
    expect(visited).toEqual(keepKeys);
    const projects = new Set(
      [...visited].map(
        (key) => keep.find((k) => key.startsWith(k.worktree.worktree.id))?.worktree.project.id,
      ),
    );
    expect(projects.size).toBe(3);

    // Reviewing the current file with r, then n, never lands on a reviewed file.
    await app.press('r');
    await app.press('n');
    await expect(app.selectedFile).toHaveAttribute('data-reviewed', 'false');
  });
});
