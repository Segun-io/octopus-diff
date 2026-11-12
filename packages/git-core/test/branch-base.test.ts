/**
 * `readBranchBase` (#27): the cache identity of a branch scope's base. Loose and packed refs are
 * read from files (no git process); symbolic refs fall back to git; and the answer always equals
 * what `for-each-ref` (the scope's own lookup) says.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GitCore, ProjectLocator } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore } from '../src/index.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

let fx: Fixture;
let core: GitCore;
let repo: string;
let project: ProjectLocator;
let log: string;

/** Spawns of git by the core (a wrapper script that logs and then execs the real git). */
function spawns(): number {
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
}

beforeAll(async () => {
  fx = createFixture();
  log = path.join(fx.root, 'spawn.log');
  writeFileSync(log, '');
  const wrapper = path.join(fx.root, 'git-wrapper.sh');
  writeFileSync(wrapper, `#!/bin/sh\necho x >> '${log}'\nexec git "$@"\n`);
  chmodSync(wrapper, 0o755);
  core = createGitCore(fx.coreOptions({ gitBinary: wrapper }));
  repo = fx.repo('base', { files: { 'a.txt': 'a\n' } });
  fx.git(repo, ['switch', '-q', '-c', 'topic']);
  project = { id: 'p', commonDir: path.join(repo, '.git') };
  await core.version(); // the one-off `git --version`
});

afterAll(async () => {
  await core.dispose();
  fx.dispose();
});

const oidOf = (ref: string) => fx.git(repo, ['rev-parse', ref]).trim();

describe('readBranchBase', () => {
  it('reads a loose ref without spawning git, and follows the ref when it moves', async () => {
    const before = spawns();
    const base = await core.readBranchBase?.(project, { defaultBranch: 'main' });
    expect(base).toEqual({ name: 'main', ref: 'refs/heads/main', oid: oidOf('main') });
    expect(spawns()).toBe(before);

    fx.write(path.join(repo, 'b.txt'), 'b\n');
    fx.commitAll(repo, 'on topic');
    fx.git(repo, ['branch', '-f', 'main', 'topic']);
    const moved = await core.readBranchBase?.(project, { defaultBranch: 'main' });
    expect(moved?.oid).toBe(oidOf('topic'));
    expect(moved?.oid).not.toBe(base?.oid);
    expect(spawns()).toBe(before);
  });

  it('reads packed refs (after pack-refs), and a ref that moved after packing', async () => {
    fx.git(repo, ['pack-refs', '--all', '--prune']);
    const before = spawns();
    const packed = await core.readBranchBase?.(project, { defaultBranch: 'main' });
    expect(packed?.oid).toBe(oidOf('main'));
    expect(spawns()).toBe(before);

    fx.write(path.join(repo, 'c.txt'), 'c\n');
    fx.commitAll(repo, 'again');
    fx.git(repo, ['branch', '-f', 'main', 'topic']); // loose ref now overrides the packed one
    const loose = await core.readBranchBase?.(project, { defaultBranch: 'main' });
    expect(loose?.oid).toBe(oidOf('topic'));
    expect(loose?.oid).not.toBe(packed?.oid);
    expect(spawns()).toBe(before);
  });

  it('resolves names like the scope does: heads, then remotes, then tags; an explicit base wins', async () => {
    fx.git(repo, ['update-ref', 'refs/remotes/origin/main', oidOf('main')]);
    fx.git(repo, ['tag', 'v1', 'HEAD~1']);
    const remote = await core.readBranchBase?.(project, { defaultBranch: 'origin/main' });
    expect(remote).toEqual({
      name: 'origin/main',
      ref: 'refs/remotes/origin/main',
      oid: oidOf('main'),
    });
    const tag = await core.readBranchBase?.(project, { defaultBranch: 'main', base: 'v1' });
    expect(tag?.ref).toBe('refs/tags/v1');
    expect(tag?.oid).toBe(oidOf('v1'));
  });

  it('is null for a missing ref or when no default branch is known', async () => {
    expect(await core.readBranchBase?.(project, { defaultBranch: 'nope' })).toBeNull();
    expect(await core.readBranchBase?.(project, {})).toBeNull();
    expect(await core.readBranchBase?.(project)).toBeNull();
  });

  it('falls back to git for a symbolic ref and agrees with it', async () => {
    fx.git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    const base = await core.readBranchBase?.(project, { defaultBranch: 'origin/HEAD' });
    expect(base?.oid).toBe(oidOf('main'));
    expect(base?.ref).toBe('refs/remotes/origin/HEAD');
  });

  it('rejects an invalid ref name', async () => {
    await expect(core.readBranchBase?.(project, { defaultBranch: '-x' })).rejects.toThrow();
    await expect(core.readBranchBase?.(project, { base: 'a..b' })).rejects.toThrow();
  });

  it('works from a linked worktree: refs live in the common dir', async () => {
    const linked = path.join(fx.root, 'linked');
    fx.git(repo, ['worktree', 'add', '-q', '-b', 'side', linked]);
    const base = await core.readBranchBase?.(project, { defaultBranch: 'side' });
    expect(base?.oid).toBe(oidOf('side'));
  });
});
