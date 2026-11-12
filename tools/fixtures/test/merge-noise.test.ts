import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addBenchOrigins,
  benchOwnFile,
  generateFixtures,
  generateMergeNoise,
  gitText,
  MERGE_NOISE_EXPECTED,
  type MergeNoiseSet,
} from '../src/index.js';

let set: MergeNoiseSet;

const git = (cwd: string, ...args: string[]) => gitText(args, { cwd, env: set.env });
const names = (cwd: string, ...range: string[]) =>
  git(cwd, 'diff', '--name-only', ...range).then((t) => (t ? t.split('\n') : []));

beforeAll(async () => {
  set = await generateMergeNoise();
}, 60_000);

afterAll(async () => {
  await set?.cleanup();
});

describe('merge-noise scenarios', () => {
  it('lives under the OS temp dir, with an isolated config and `origin` as a bare repository', async () => {
    expect(set.root.startsWith(`${await realpath(tmpdir())}/octopus-diff-noise-`)).toBe(true);
    expect(set.env.vars.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(await git(set.originDir, 'rev-parse', '--is-bare-repository')).toBe('true');
    expect(await git(set.remote.dir, 'remote', 'get-url', 'origin')).toBe(set.originDir);
    // The local project has no remote at all.
    expect(await git(set.local.dir, 'remote')).toBe('');
  });

  it('starts every feature worktree at the base commit, clean', async () => {
    for (const project of [set.local, set.remote]) {
      const base = await git(project.dir, 'rev-parse', 'main');
      for (const w of Object.values(project.worktrees)) {
        expect(await git(w.path, 'rev-parse', 'HEAD'), w.role).toBe(base);
        expect(await git(w.path, 'status', '--porcelain'), w.role).toBe('');
      }
    }
  });

  it('builds each scenario the way it is named (and is deterministic)', async () => {
    await set.commitOwnWork();
    await set.integrate();
    const { local, remote } = set;
    const wt = (project: typeof local, role: string) => {
      const w = project.worktrees[role];
      if (!w) throw new Error(role);
      return w.path;
    };
    const parents = async (cwd: string) => (await git(cwd, 'log', '-1', '--format=%P')).split(' ');

    // Clean merge, resolved conflict, file both sides changed: a merge commit on top.
    for (const role of ['merge', 'conflict', 'mixed']) {
      expect((await parents(wt(local, role))).length, role).toBe(2);
      expect(await git(wt(local, role), 'status', '--porcelain'), role).toBe('');
    }
    // The resolved conflict has no markers left.
    expect(await git(wt(local, 'conflict'), 'show', 'HEAD:src/conflict.txt')).not.toMatch(
      /[<>=]{7}/,
    );
    // Cherry-pick: linear, main's hotfix is not an ancestor, its content is on the branch.
    expect((await parents(wt(local, 'pick'))).length).toBe(1);
    expect(
      await git(wt(local, 'pick'), 'merge-base', '--is-ancestor', 'main', 'HEAD').catch(() => 'no'),
    ).toBe('no');
    expect(await git(wt(local, 'pick'), 'show', 'HEAD:src/hotfix.txt')).toBe('hotfix');
    // Rebase onto origin/main with a stale local main.
    const rebase = wt(remote, 'rebase');
    expect((await parents(rebase)).length).toBe(1);
    expect(await git(rebase, 'merge-base', 'HEAD', 'origin/main')).toBe(
      await git(rebase, 'rev-parse', 'origin/main'),
    );
    expect(await git(remote.dir, 'rev-list', '--count', 'main..origin/main')).toBe('1');
    expect(await names(remote.dir, 'main', 'origin/main')).toEqual([
      'docs/upstream.md',
      'src/upstream-api.ts',
    ]);
    // What each scenario brought is what the expectations say (own and mixed files excluded).
    const fromMain = await names(wt(local, 'merge'), 'main~3', 'main');
    expect(fromMain).toEqual([...MERGE_NOISE_EXPECTED.merge.base]);

    // The fetch moves origin/main, the local main stays.
    const before = await git(remote.dir, 'rev-parse', 'origin/main');
    const localMain = await git(remote.dir, 'rev-parse', 'main');
    await set.fetchMovesOrigin();
    expect(await git(remote.dir, 'rev-parse', 'origin/main')).not.toBe(before);
    expect(await git(remote.dir, 'rev-parse', 'main')).toBe(localMain);
    expect(existsSync(set.originDir)).toBe(true);
  });
});

describe('bench origins (opt-in, the bench layout itself is unchanged)', () => {
  it('gives each bench repo a bare origin, merge noise in the linked worktrees, and a fetch that moves origin/main', async () => {
    const plain = await generateFixtures({
      acceptance: false,
      bench: { repos: 2, worktreesPerRepo: 3 },
      prefix: 'octopus-diff-benchorigins-',
    });
    try {
      const project = plain.manifest.projects[0];
      if (!project?.mainWorktreePath) throw new Error('no bench project');
      // Before: no remote at all (what the other benches and specs rely on).
      const run = (cwd: string, ...args: string[]) => gitText(args, { cwd, env: plain.env });
      expect(await run(project.mainWorktreePath, 'remote')).toBe('');
      const origins = await addBenchOrigins(plain.manifest, plain.env, plain.root, {
        concurrency: 2,
      });
      expect(origins).toMatchObject({ repos: 2, linkedWorktrees: 4 });
      const main = project.mainWorktreePath;
      const linked = project.worktrees.filter((w) => !w.isMain);
      expect(linked).toHaveLength(2);
      // Stale local main; every linked worktree merged origin/main and kept its dirty files.
      expect(await run(main, 'rev-list', '--count', 'main..origin/main')).toBe('1');
      for (const w of linked) {
        expect((await run(w.path, 'log', '-1', '--format=%P')).split(' ')).toHaveLength(2);
        expect(await run(w.path, 'show', `HEAD:${benchOwnFile(w.name)}`)).toContain(w.name);
        expect(await run(w.path, 'status', '--porcelain')).not.toBe('');
      }
      const before = await run(main, 'rev-parse', 'origin/main');
      await origins.fetchMovesOrigin(1);
      expect(await run(main, 'rev-parse', 'origin/main')).not.toBe(before);
      await origins.fetchMovesOrigin(2);
      // Round 2 lands every linked worktree's own file upstream, same content.
      for (const w of linked) {
        expect(await run(main, 'show', `origin/main:${benchOwnFile(w.name)}`)).toBe(
          await run(w.path, 'show', `HEAD:${benchOwnFile(w.name)}`),
        );
      }
      expect(await run(main, 'rev-list', '--count', 'main..origin/main')).toBe('3');
    } finally {
      await plain.cleanup();
    }
  }, 60_000);
});
