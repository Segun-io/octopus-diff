/**
 * PLAN §8 item 3: the Inbox lists every dirty worktree; selecting a file shows a correct diff in
 * split and unified modes.
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

  test('UI inbox lists every dirty worktree and no clean one', async ({
    manifest,
    daemon,
    app,
  }) => {
    await app.open(daemon.authUrl);
    await app.selectInbox();
    const dirty = dirtyCheckouts(manifest);
    await expect(app.contextBar).toHaveAttribute('data-count', String(dirty.length));
    const groups = app.byTestId(TEST_IDS.fileGroup);
    await expect(groups).toHaveCount(dirty.length);
    const ids = await groups.evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute('data-worktree-id')),
    );
    expect(ids.sort()).toEqual(dirty.map((d) => d.worktree.id).sort());
    for (const { worktree } of registeredCheckouts(manifest).filter((c) => !c.worktree.dirty)) {
      await expect(
        app.page.locator(
          `[data-testid="${TEST_IDS.fileGroup}"][data-worktree-id="${worktree.id}"]`,
        ),
        `clean ${worktree.name} must not be in the inbox`,
      ).toHaveCount(0);
    }
    // Every file of a dirty worktree is listed under its group. The list is virtualized, so
    // collect rows by scrolling through it instead of expecting them all in the DOM at once.
    const listed = new Set(
      (await app.allFileItems()).map((item) => `${item.worktreeId ?? ''}\u0000${item.path}`),
    );
    for (const { worktree } of dirty) {
      for (const file of worktree.scopes.working ?? []) {
        expect(
          listed.has(`${worktree.id}\u0000${file.path}`),
          `${worktree.name}: ${file.path}`,
        ).toBe(true);
      }
    }
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
    await app.selectInbox();
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
