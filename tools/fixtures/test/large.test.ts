import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type GitResult,
  generateLargeFixtures,
  LARGE_LAYOUTS,
  type LargeFixtureSet,
  largeFilePath,
  READ_ONLY_GIT_ARGS,
  runGit,
} from '../src/index.js';

// Same shape as the real layouts, tiny so the unit test stays quick.
const TINY = { files: 400, dirtyTracked: 10, untracked: 8, manyUntracked: 250, rewriteLines: 500 };

let set: LargeFixtureSet;

beforeAll(async () => {
  set = await generateLargeFixtures({ layout: TINY, prefix: 'octopus-diff-large-test-' });
}, 120_000);

afterAll(async () => {
  await set?.cleanup();
});

function git(cwd: string, args: string[]): Promise<GitResult> {
  return runGit([...READ_ONLY_GIT_ARGS, ...args], { cwd, env: set.env });
}

const lines = (result: GitResult, sep = '\n') =>
  result.stdout
    .toString('utf8')
    .split(sep)
    .filter((l) => l.length > 0);

describe('large layout', () => {
  it('has the issue-26 shapes and a CI-sized variant of about 20k files', () => {
    expect(LARGE_LAYOUTS.large.files).toBe(100_000);
    expect(LARGE_LAYOUTS.large.manyUntracked).toBe(30_000);
    expect(LARGE_LAYOUTS.large.rewriteLines).toBe(300_000);
    expect(LARGE_LAYOUTS['large-ci'].files).toBe(20_000);
    expect(new Set(Array.from({ length: 3000 }, (_, i) => largeFilePath(i))).size).toBe(3000);
  });

  it('lives under the OS temp dir with one monorepo and three worktrees', async () => {
    expect(set.root.startsWith(`${await realpath(tmpdir())}/octopus-diff-large-test-`)).toBe(true);
    expect(set.worktrees.map((w) => w.role)).toEqual(['main', 'stale-index', 'untracked-heavy']);
    const list = lines(await git(set.projectPath, ['worktree', 'list', '--porcelain']))
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length));
    expect(list.sort()).toEqual(set.worktrees.map((w) => w.path).sort());
    const tracked = lines(await git(set.projectPath, ['ls-files', '-z']), '\0');
    expect(tracked).toHaveLength(TINY.files + 2);
  });

  it('every worktree is dirty as advertised', async () => {
    for (const w of set.worktrees) {
      const status = lines(
        await git(w.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
        '\0',
      );
      const untracked = status.filter((l) => l.startsWith('?? ')).length;
      const modified = status.filter((l) => l.startsWith(' M') || l.startsWith('M ')).length;
      expect({ role: w.role, modified, untracked }).toEqual({
        role: w.role,
        modified: w.expectedModified,
        untracked: w.expectedUntracked,
      });
    }
  });

  it('only the stale-index worktree has an index that disagrees with the files', async () => {
    const stale = async (path: string) =>
      lines(await git(path, ['diff-files', '--name-only', '-z']), '\0').length;
    const byRole = Object.fromEntries(set.worktrees.map((w) => [w.role, w.path]));
    expect(await stale(byRole.main as string)).toBe(TINY.dirtyTracked + 1);
    expect(await stale(byRole['untracked-heavy'] as string)).toBe(TINY.dirtyTracked);
    // Every tracked file looks changed to git until the index is refreshed.
    expect(await stale(byRole['stale-index'] as string)).toBeGreaterThanOrEqual(TINY.files);
    // ...but the content is unchanged: a content-level diff only reports the dirty files.
    const real = lines(
      await git(byRole['stale-index'] as string, ['diff-index', '--name-only', '-z', 'HEAD']),
      '\0',
    );
    expect(real.length).toBeGreaterThanOrEqual(TINY.dirtyTracked);
  });

  it('the main worktree rewrites the huge file completely', async () => {
    const numstat = lines(await git(set.projectPath, ['diff', '--numstat', 'HEAD', '--', 'docs']));
    expect(numstat[0]).toMatch(new RegExp(`^${TINY.rewriteLines}\\t${TINY.rewriteLines}\\t`));
  });
});
