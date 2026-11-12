import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertReadOnly,
  type FixtureSet,
  findWorktree,
  generateFixtures,
  proofTargetsFromManifest,
  ReadOnlyViolationError,
  runGit,
  startReadOnlyProof,
} from '../src/index.js';

let set: FixtureSet;

beforeEach(async () => {
  set = await generateFixtures({ seed: 3, largeFileBytes: 64 * 1024 });
}, 120_000);

afterEach(async () => {
  await set?.cleanup();
});

const git = (cwd: string, args: string[], extraEnv?: Record<string, string>) =>
  runGit(args, { cwd, env: set.env, ...(extraEnv ? { extraEnv } : {}), allowFailure: true });

describe('read-only proof harness', () => {
  it('targets control and source repos, never the mutable ones', () => {
    const names = proofTargetsFromManifest(set.manifest).map((t) => t.name);
    expect(names).toContain('kitchen-sink');
    expect(names).toContain('alpha');
    expect(names).toContain('source:alpha-origin.git');
    expect(names).not.toContain('live');
  });

  it('passes when only read-only git commands run', async () => {
    const proof = await startReadOnlyProof({
      env: set.env,
      targets: proofTargetsFromManifest(set.manifest),
    });
    for (const project of set.manifest.projects) {
      for (const worktree of project.worktrees.filter((w) => !w.bare)) {
        const ro = ['--no-optional-locks'];
        await git(worktree.path, [...ro, 'status', '--porcelain=v2', '-z', '--branch'], {
          GIT_OPTIONAL_LOCKS: '0',
        });
        const env0 = { GIT_OPTIONAL_LOCKS: '0' };
        if (worktree.headSha) {
          await git(
            worktree.path,
            [...ro, 'diff-index', '--no-ext-diff', '-p', '-M', 'HEAD', '--'],
            env0,
          );
          await git(
            worktree.path,
            [...ro, 'diff-index', '--cached', '--numstat', '-z', 'HEAD'],
            env0,
          );
        }
        await git(worktree.path, [...ro, 'diff-files', '--no-ext-diff', '-p', '--'], env0);
        await git(worktree.path, [...ro, 'ls-files', '-z', '--others', '--exclude-standard'], env0);
        await git(worktree.path, [...ro, 'worktree', 'list', '--porcelain'], {
          GIT_OPTIONAL_LOCKS: '0',
        });
        await git(worktree.path, [...ro, 'log', '-n5', '--format=%H'], { GIT_OPTIONAL_LOCKS: '0' });
      }
    }
    // The mutable project may be modified freely.
    const live = findWorktree(set.manifest, 'live').worktree;
    await writeFile(join(live.path, 'src/live.ts'), 'changed\n');
    await git(live.path, ['add', '-A']);
    await git(live.path, ['commit', '-q', '-m', 'allowed']);
    const report = await proof.finish();
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.pollCount).toBeGreaterThan(0);
    expect(() => assertReadOnly(report)).not.toThrow();
  });

  it('passes for the blob read of the live feed (cat-file -t, blob, -s by full oid)', async () => {
    // The argv of git-core's `readBlob` (#37): the content of a tracked file that was deleted
    // in the working tree, by the object id `git status` reports, in every worktree.
    const proof = await startReadOnlyProof({
      env: set.env,
      targets: proofTargetsFromManifest(set.manifest),
    });
    const ro = ['--no-optional-locks'];
    const env0 = { GIT_OPTIONAL_LOCKS: '0' };
    let blobs = 0;
    for (const project of set.manifest.projects) {
      for (const worktree of project.worktrees.filter((w) => !w.bare && w.headSha)) {
        const listing = await git(worktree.path, [...ro, 'ls-files', '-s', '-z'], env0);
        const oid = /^\d+ ([0-9a-f]{40,64}) \d\t/.exec(listing.stdout.toString('latin1'))?.[1];
        if (!oid) continue;
        const type = await git(worktree.path, [...ro, 'cat-file', '-t', oid], env0);
        if (type.stdout.toString().trim() !== 'blob') continue;
        await git(worktree.path, [...ro, 'cat-file', 'blob', oid], env0);
        await git(worktree.path, [...ro, 'cat-file', '-s', oid], env0);
        blobs += 1;
      }
    }
    expect(blobs).toBeGreaterThan(3);
    const report = await proof.finish();
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('catches a plain `git status` that refreshes the index (stat-dirty bait)', async () => {
    const target = proofTargetsFromManifest(set.manifest).filter((t) => t.name === 'kitchen-sink');
    const proof = await startReadOnlyProof({ env: set.env, targets: target });
    // No --no-optional-locks: git refreshes the stat-dirty entry and rewrites .git/index.
    await git(findWorktree(set.manifest, 'kitchen-sink').worktree.path, ['status']);
    const report = await proof.finish();
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.includes('index'))).toBe(true);
    expect(() => assertReadOnly(report)).toThrow(ReadOnlyViolationError);
  });

  it('catches porcelain `git diff`, which rewrites the index even with --no-optional-locks', async () => {
    // Pinned git behavior (git 2.53): `git diff` against the working tree calls
    // refresh_index_quietly() and ignores --no-optional-locks. Plumbing diff-files/diff-index
    // does not write. git-core must therefore not use porcelain `diff` for working-tree scopes.
    const target = proofTargetsFromManifest(set.manifest).filter((t) => t.name === 'kitchen-sink');
    const proof = await startReadOnlyProof({ env: set.env, targets: target });
    await git(
      findWorktree(set.manifest, 'kitchen-sink').worktree.path,
      ['--no-optional-locks', 'diff', '--numstat'],
      {
        GIT_OPTIONAL_LOCKS: '0',
      },
    );
    const report = await proof.finish();
    expect(report.ok).toBe(false);
    expect(report.events.some((e) => e.kind === 'lock' && e.path === 'index.lock')).toBe(true);
  });

  it('catches `git add` + `git commit` (locks, index and refs)', async () => {
    const proof = await startReadOnlyProof({
      env: set.env,
      targets: proofTargetsFromManifest(set.manifest),
    });
    const gamma = findWorktree(set.manifest, 'gamma').worktree;
    await git(gamma.path, ['add', '-A']);
    await git(gamma.path, ['commit', '-q', '-m', 'forbidden']);
    const report = await proof.finish();
    expect(report.ok).toBe(false);
    expect(report.events.some((e) => e.kind === 'lock' && e.path === 'index.lock')).toBe(true);
    expect(report.violations.some((v) => v.startsWith('gamma: refs/heads/master'))).toBe(true);
    expect(report.violations.some((v) => v.includes('git status of'))).toBe(true);
  });

  it('catches a lock file that exists only for an instant', async () => {
    const beta = proofTargetsFromManifest(set.manifest).filter((t) => t.name === 'beta');
    const proof = await startReadOnlyProof({ env: set.env, targets: beta, strictEvents: false });
    const lock = join(beta[0]?.commonDir ?? '', 'index.lock');
    await writeFile(lock, '');
    await rm(lock);
    const report = await proof.finish();
    expect(report.events.some((e) => e.kind === 'lock' && e.path === 'index.lock')).toBe(true);
    expect(report.ok).toBe(false);
  });

  it('catches a lock in a linked worktree git dir and a ref update', async () => {
    const alpha = proofTargetsFromManifest(set.manifest).filter((t) => t.name === 'alpha');
    const proof = await startReadOnlyProof({ env: set.env, targets: alpha });
    const login = findWorktree(set.manifest, 'alpha-login').worktree;
    await git(login.path, ['update-ref', 'refs/heads/sneaky', 'HEAD']);
    const report = await proof.finish();
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.includes('refs/heads/sneaky'))).toBe(true);
  });

  it('catches working-tree changes in a control repo through git status', async () => {
    const epsilon = proofTargetsFromManifest(set.manifest).filter((t) => t.name === 'epsilon');
    const proof = await startReadOnlyProof({ env: set.env, targets: epsilon });
    await writeFile(join(findWorktree(set.manifest, 'epsilon').worktree.path, 'new.txt'), 'x\n');
    const report = await proof.finish();
    expect(report.violations).toEqual([expect.stringContaining('git status of')]);
  });
});
