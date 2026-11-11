/**
 * PLAN §8 item 4: all five scopes produce correct diffs, including untracked, renamed, deleted,
 * binary and very large files. Correctness is checked against the git oracle recorded in the
 * fixture manifest (API level, every worktree × scope × file), then the UI is checked for the
 * scope selector and every special-case rendering.
 */
import { type DiffScope, type FileDiff, TEST_IDS } from '@octopus-diff/contracts';
import { type ExpectedFile, findProject, findWorktree } from '@octopus-diff/fixtures';
import type { TestDaemon } from '../support/daemon.js';
import {
  countPatchLines,
  expect,
  hasComparableLineCounts,
  registeredCheckouts,
  statusMatches,
  test,
} from '../support/test.js';

const MIB = 1024 * 1024;

async function checkScope(
  daemon: TestDaemon,
  worktreeId: string,
  label: string,
  scope: DiffScope,
  expected: readonly ExpectedFile[],
  options: { allowExtraUntracked?: boolean } = {},
) {
  const { files } = await daemon.client.listFiles(worktreeId, { scope });
  const actualPaths = files.filter(
    (f) => !(options.allowExtraUntracked && f.status === 'untracked'),
  );
  expect(actualPaths.map((f) => f.path).sort(), `${label}: file list`).toEqual(
    expected.map((f) => f.path).sort(),
  );
  for (const want of expected) {
    const got = files.find((f) => f.path === want.path);
    if (!got) continue;
    const where = `${label}: ${want.path}`;
    expect(statusMatches(got.status, want), `${where} status ${got.status} vs ${want.status}`).toBe(
      true,
    );
    if (want.status === 'renamed') expect(got.oldPath, where).toBe(want.oldPath);
    expect(got.binary, `${where} binary`).toBe(want.binary);
    if (want.rawPath) expect(got.rawPath, `${where} rawPath`).toBe(want.rawPath);
    if (want.newMode === '120000' || want.newMode === '160000')
      expect(got.newMode, where).toBe(want.newMode);
    if (hasComparableLineCounts(want)) {
      expect(
        { additions: got.additions, deletions: got.deletions },
        `${where} line counts`,
      ).toEqual({
        additions: want.additions,
        deletions: want.deletions,
      });
    }

    const { diff } = await daemon.client.getDiff(worktreeId, {
      scope,
      path: got.path,
      ...(got.rawPath ? { rawPath: got.rawPath } : {}),
    });
    expect(diff.patchHash, `${where}: listFiles and getDiff agree on patchHash`).toBe(
      got.patchHash,
    );
    checkPatch(diff, want, where);
  }
}

function checkPatch(diff: FileDiff, want: ExpectedFile, where: string) {
  if (want.binary) {
    expect(diff.binary, where).toBe(true);
    expect(countPatchLines(diff.patch), `${where}: no text hunks for binary`).toEqual({
      additions: 0,
      deletions: 0,
    });
    return;
  }
  if (diff.tooLarge || diff.truncated) return;
  if (hasComparableLineCounts(want)) {
    expect(countPatchLines(diff.patch), `${where}: patch lines`).toEqual({
      additions: want.additions,
      deletions: want.deletions,
    });
  }
  if (want.status !== 'conflicted') expect(diff.patch, where).toContain('diff --git ');
}

test.describe('§8.4 scopes (API, against the git oracle)', () => {
  test('working, staged and unstaged scopes for every worktree', async ({ manifest, daemon }) => {
    test.setTimeout(180_000);
    for (const { project, worktree } of registeredCheckouts(manifest)) {
      const label = `${project.name}/${worktree.name}`;
      await checkScope(
        daemon,
        worktree.id,
        `${label} working`,
        { kind: 'working' },
        worktree.scopes.working ?? [],
      );
      await checkScope(
        daemon,
        worktree.id,
        `${label} staged`,
        { kind: 'staged' },
        worktree.scopes.staged ?? [],
      );
      await checkScope(
        daemon,
        worktree.id,
        `${label} unstaged`,
        { kind: 'unstaged' },
        worktree.scopes.unstaged ?? [],
        {
          // Whether untracked files show in `unstaged` is git-core's call; tracked ones must match.
          allowExtraUntracked: true,
        },
      );
    }
  });

  test('branch scope against the default branch', async ({ manifest, daemon }) => {
    let checked = 0;
    for (const { project, worktree } of registeredCheckouts(manifest)) {
      if (!worktree.scopes.branch) continue;
      checked++;
      await checkScope(
        daemon,
        worktree.id,
        `${project.name}/${worktree.name} branch`,
        { kind: 'branch' },
        worktree.scopes.branch,
      );
    }
    expect(checked).toBeGreaterThanOrEqual(3);
    // Explicit base.
    const login = findWorktree(manifest, 'alpha-login').worktree;
    await checkScope(
      daemon,
      login.id,
      'alpha-login branch:main',
      { kind: 'branch', base: 'main' },
      login.scopes.branch ?? [],
    );
  });

  test('commit scope, including a root commit, and the commit list', async ({
    manifest,
    daemon,
  }) => {
    const rootOnly = findWorktree(manifest, 'root-only').worktree;
    const root = rootOnly.commits[0];
    if (!root?.files) throw new Error('root-only fixture lacks its root commit');
    await checkScope(
      daemon,
      rootOnly.id,
      'root-only root commit',
      { kind: 'commit', sha: root.sha },
      root.files,
    );
    for (const file of root.files) expect(file.status).toBe('added');

    const alpha = findWorktree(manifest, 'alpha').worktree;
    const { commits } = await daemon.client.listCommits(alpha.id, { limit: 10 });
    expect(commits.map((c) => c.sha)).toEqual(alpha.commits.slice(0, 10).map((c) => c.sha));
    expect(commits[0]?.subject).toBe(alpha.commits[0]?.subject);
    const head = alpha.commits[0];
    if (!head) throw new Error('alpha has no commits');
    const files = (
      await daemon.client.listFiles(alpha.id, { scope: { kind: 'commit', sha: head.sha } })
    ).files;
    expect(files.map((f) => f.path)).toEqual(['src/util.ts']);
    expect(files[0]?.status).toBe('modified');
    // Short shas work too.
    const short = await daemon.client.listFiles(alpha.id, {
      scope: { kind: 'commit', sha: head.sha.slice(0, 10) },
    });
    expect(short.files.map((f) => f.path)).toEqual(['src/util.ts']);
  });

  test('special cases: very large, whitespace-only, non-UTF-8, rename, deletes', async ({
    manifest,
    daemon,
  }) => {
    const sink = findProject(manifest, 'kitchen-sink');
    const wt = sink.worktrees[0];
    if (!wt) throw new Error('kitchen-sink missing');
    const huge = await daemon.client.getDiff(wt.id, { path: 'generated/huge.sql' });
    expect(huge.diff.tooLarge, 'a several-MB patch is withheld by default').toBe(true);
    expect(huge.diff.patch).toBe('');
    expect(huge.diff.byteLength ?? 0).toBeGreaterThan(MIB);
    const full = await daemon.client.getDiff(wt.id, { path: 'generated/huge.sql', full: true });
    expect(full.diff.tooLarge).toBe(false);
    expect(full.diff.patch.length > MIB || full.diff.truncated).toBe(true);
    expect(full.diff.patch).toContain('octopus-marker-very-large');
    expect(full.diff.patchHash).toBe(huge.diff.patchHash);

    const ws = await daemon.client.getDiff(wt.id, { path: 'src/whitespace.ts' });
    const wsIgnored = await daemon.client.getDiff(wt.id, {
      path: 'src/whitespace.ts',
      ignoreWhitespace: true,
    });
    expect(countPatchLines(ws.diff.patch).additions).toBeGreaterThan(0);
    expect(countPatchLines(wsIgnored.diff.patch)).toEqual({ additions: 0, deletions: 0 });
    expect(wsIgnored.diff.patchHash, 'view options never change patchHash').toBe(ws.diff.patchHash);
    const ctx = await daemon.client.getDiff(wt.id, { path: 'src/both.ts', context: 0 });
    const ctxDefault = await daemon.client.getDiff(wt.id, { path: 'src/both.ts' });
    expect(ctx.diff.patch.length).toBeLessThan(ctxDefault.diff.patch.length);
    expect(ctx.diff.patchHash).toBe(ctxDefault.diff.patchHash);

    // Absent where the file system refuses non-UTF-8 names (APFS on macOS); the fixtures' own
    // tests check that it is present everywhere else.
    const latin = sink.cases['non-utf8-filename'];
    if (latin) {
      if (!latin.rawPath) throw new Error('non-UTF-8 case without rawPath');
      const latinDiff = await daemon.client.getDiff(wt.id, {
        path: latin.path,
        rawPath: latin.rawPath,
      });
      expect(latinDiff.diff.rawPath).toBe(latin.rawPath);
      expect(latinDiff.diff.patch).toContain('octopus-marker-non-utf8');
    }

    const renamed = await daemon.client.getDiff(wt.id, { path: 'src/new-name.ts' });
    expect(renamed.diff).toMatchObject({ status: 'renamed', oldPath: 'src/old-name.ts' });
    const deleted = await daemon.client.getDiff(wt.id, { path: 'src/deleted.ts' });
    expect(deleted.diff).toMatchObject({ status: 'deleted', newMode: null });
    expect(countPatchLines(deleted.diff.patch).deletions).toBe(25);
    const untracked = await daemon.client.getDiff(wt.id, { path: 'src/scratch.ts' });
    expect(untracked.diff.status).toBe('untracked');
    expect(untracked.diff.patch).toContain('+// octopus-marker-untracked');

    await expect(
      daemon.client.getDiff(wt.id, { path: 'src/not-changed-at-all.ts' }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

test.describe('§8.4 scopes (UI)', () => {
  test('the scope selector switches the file list for every scope kind', async ({
    manifest,
    daemon,
    app,
  }) => {
    const sink = findWorktree(manifest, 'kitchen-sink').worktree;
    await app.open(daemon.authUrl);
    await app.selectWorktree(sink.id);
    for (const kind of ['working', 'staged', 'unstaged'] as const) {
      await app.setScope(kind);
      const expected = (await daemon.client.listFiles(sink.id, { scope: { kind } })).files.map(
        (f) => f.path,
      );
      await expect
        .poll(async () => (await app.filePaths()).sort(), { message: `UI files for ${kind}` })
        .toEqual(expected.sort());
    }
    const login = findWorktree(manifest, 'alpha-login').worktree;
    await app.selectWorktree(login.id);
    // "All on branch" (status flow v2) is the working tree against the merge-base.
    await app.setScope('branch');
    const allOnBranch = (
      await daemon.client.listFiles(login.id, { scope: { kind: 'branch', includeWorking: true } })
    ).files.map((f) => f.path);
    for (const f of login.scopes.branch ?? []) expect(allOnBranch).toContain(f.path);
    await expect.poll(async () => (await app.filePaths()).sort()).toEqual(allOnBranch.sort());
    await app.setScope('working');
  });

  test('special files render sanely', async ({ manifest, daemon, app }) => {
    const sink = findProject(manifest, 'kitchen-sink');
    const wt = sink.worktrees[0];
    if (!wt) throw new Error('kitchen-sink missing');
    await app.open(daemon.authUrl);
    await app.selectWorktree(wt.id);
    await app.setScope('working');

    await app.openFile('assets/logo.png');
    await expect(app.diffViewer.getByRole('combobox', { name: 'Image comparison' })).toBeVisible();
    for (const side of ['Before', 'After']) {
      const image = app.diffViewer.getByRole('img', { name: side, exact: true });
      await expect(image).toBeVisible();
      await expect
        .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
        .toBe(1);
    }
    await expect(app.placeholder('binary')).toHaveCount(0);

    await app.openFile('generated/huge.sql');
    await expect(app.placeholder('too-large')).toBeVisible();
    await app.byTestId(TEST_IDS.diffLoadAnyway).click();
    await expect(app.diffViewer).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await app.expectDiffText('octopus-marker-very-large', 30_000);

    await app.openFile('src/new-name.ts');
    await expect(app.fileItem('src/new-name.ts')).toHaveAttribute(
      'data-old-path',
      'src/old-name.ts',
    );
    await expect(app.diffViewer.getByText('src/old-name.ts').first()).toBeVisible();

    await app.openFile('src/deleted.ts');
    await expect(app.fileItem('src/deleted.ts')).toHaveAttribute('data-status', 'deleted');
    expect(await app.waitDiffSettled()).not.toBe('error');

    await app.openFile('src/scratch.ts');
    await expect(app.fileItem('src/scratch.ts')).toHaveAttribute('data-status', 'untracked');
    await app.expectDiffText('octopus-marker-untracked');

    await app.openFile('dist/app.min.js');
    expect(await app.waitDiffSettled()).not.toBe('error');

    await app.openFile('windows/crlf.txt');
    await app.expectDiffText('octopus-marker-crlf');

    const latin = sink.cases['non-utf8-filename']; // absent on APFS (macOS)
    if (latin) {
      await app.openFile(latin.path);
      await app.expectDiffText('octopus-marker-non-utf8');
    }

    await app.openFile('docs/ünïcødé ✓.md');
    await app.expectDiffText('octopus-marker-unicode');

    for (const path of ['links/current', 'vendor/lib', 'config/settings.json']) {
      await app.openFile(path);
      expect(await app.waitDiffSettled(), `${path} must not error`).not.toBe('error');
      await expect(app.placeholder('error')).toHaveCount(0);
    }

    // Hide-whitespace toggle empties a whitespace-only diff.
    await app.openFile('src/whitespace.ts');
    await app.setToggle(TEST_IDS.whitespaceToggle, true);
    await expect(app.diffViewer).toHaveAttribute('data-state', /^(ready|empty)$/);
    await app.setToggle(TEST_IDS.whitespaceToggle, false);
  });

  test('conflicted and unborn repositories render', async ({ manifest, daemon, app }) => {
    const conflict = findWorktree(manifest, 'conflict').worktree;
    await app.open(daemon.authUrl);
    await app.selectWorktree(conflict.id);
    await expect(app.fileItem('shared.txt')).toHaveAttribute('data-status', 'conflicted');
    await app.openFile('shared.txt');
    expect(await app.waitDiffSettled()).not.toBe('error');

    const empty = findWorktree(manifest, 'empty').worktree;
    await app.selectWorktree(empty.id);
    await app.openFile('notes.txt');
    await app.expectDiffText('octopus-marker-empty-staged');
  });
});
