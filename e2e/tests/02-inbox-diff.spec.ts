/**
 * PLAN §8 item 3: the daemon's inbox has every dirty worktree; the UI lists every worktree, lands
 * on the first one (there is no Inbox view since #83) and shows its files; selecting a file shows
 * a correct diff in split and unified modes.
 */
import { TEST_IDS } from '@octopus-diff/contracts';
import { findWorktree } from '@octopus-diff/fixtures';
import {
  countPatchLines,
  dirtyCheckouts,
  expect,
  registeredCheckouts,
  sampleLines,
  test,
} from '../support/test.js';

test.describe('§8.3 inbox and diff', () => {
  test('API inbox has exactly the dirty worktrees, each with its working-scope files', async ({
    manifest,
    daemon,
  }) => {
    const inbox = await daemon.client.inbox();
    const expected = dirtyCheckouts(manifest);
    expect(inbox.entries.map((e) => e.worktree.id).sort()).toEqual(
      expected.map((e) => e.worktree.id).sort(),
    );
    for (const { worktree } of expected) {
      const entry = inbox.entries.find((e) => e.worktree.id === worktree.id);
      expect(entry?.files.map((f) => f.path).sort(), worktree.name).toEqual(
        (worktree.scopes.working ?? []).map((f) => f.path).sort(),
      );
      expect(entry?.summary.changedFiles).toBe(worktree.changedFiles);
    }
  });

  test('the UI lists every worktree, lands on the first and shows each one’s own files (dirty ones only have files)', async ({
    manifest,
    daemon,
    app,
  }) => {
    await app.open(daemon.authUrl);
    // The landing view: the first row of the list is open and its files are shown.
    const landed = await app.expectLanded();
    await expect(app.byTestId(TEST_IDS.fileGroup)).toHaveCount(1);
    await expect(app.byTestId(TEST_IDS.fileGroup)).toHaveAttribute('data-worktree-id', landed);
    const checkouts = registeredCheckouts(manifest);
    for (const { worktree } of checkouts) {
      await app.expectWorktreeItem(worktree);
    }
    // What the Inbox view used to list in one place, worktree by worktree: a dirty worktree
    // lists exactly its working-scope files, a clean one lists none.
    for (const { worktree } of checkouts) {
      await app.selectWorktree(worktree.id);
      const want = (worktree.scopes.working ?? []).map((f) => f.path).sort();
      await expect
        .poll(async () => (await app.filePaths()).sort(), { message: worktree.name })
        .toEqual(want);
      await expect(app.byTestId(TEST_IDS.fileGroup)).toHaveAttribute(
        'data-worktree-id',
        worktree.id,
      );
    }
    expect(dirtyCheckouts(manifest).length).toBeGreaterThan(0);
  });

  test('there is no Inbox: no sidebar entry, no `g i`, no palette command', async ({
    daemon,
    app,
  }) => {
    await app.open(daemon.authUrl);
    const landed = await app.expectLanded();
    await expect(app.byTestId(TEST_IDS.inboxItem)).toHaveCount(0);
    await app.focusApp();
    await app.press('g');
    await app.press('i');
    await expect(app.contextBar).toHaveAttribute('data-view', 'worktree');
    await expect(app.worktreeItem(landed)).toHaveAttribute('aria-current', 'true');
    await app.press('Control+k');
    await app.byTestId(TEST_IDS.commandPaletteInput).fill('inbox');
    await expect(
      app.byTestId(TEST_IDS.commandPaletteItem).filter({ hasText: /inbox/i }),
    ).toHaveCount(0);
  });

  test('selecting a file shows its real patch in unified and split modes', async ({
    manifest,
    daemon,
    app,
  }) => {
    const { worktree } = findWorktree(manifest, 'alpha');
    const path = 'README.md';
    const { diff } = await daemon.client.getDiff(worktree.id, { path });
    expect(diff.binary).toBe(false);
    const counts = countPatchLines(diff.patch);
    const expected = worktree.scopes.working?.find((f) => f.path === path);
    expect(counts).toEqual({ additions: expected?.additions, deletions: expected?.deletions });
    const { added, removed } = sampleLines(diff.patch);
    if (!added || !removed) throw new Error('README.md patch should add and remove lines');

    await app.open(daemon.authUrl);
    await app.selectWorktree(worktree.id);
    await app.openFile(path, worktree.id);
    await expect(app.diffViewer).toHaveAttribute('data-worktree-id', worktree.id);
    await expect(app.diffViewer).toHaveAttribute('data-state', 'ready');
    await expect(app.diffViewer).toHaveAttribute('data-patch-hash', diff.patchHash);

    for (const mode of ['unified', 'split'] as const) {
      await app.setDiffMode(mode);
      await app.expectDiffText(added);
      await app.expectDiffText(removed);
      await app.expectDiffText('octopus-marker-alpha-main-readme');
    }
  });

  test('a worktree selection shows only that worktree’s files', async ({
    manifest,
    daemon,
    app,
  }) => {
    const { worktree } = findWorktree(manifest, 'alpha-refactor');
    await app.open(daemon.authUrl);
    await app.selectWorktree(worktree.id);
    await expect
      .poll(async () => (await app.filePaths()).sort())
      .toEqual((worktree.scopes.working ?? []).map((f) => f.path).sort());
    await app.openFile('docs/guide.md');
    await app.expectDiffText('octopus-marker-alpha-refactor-unstaged');
  });
});
