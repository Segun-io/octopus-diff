import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type FixtureSet,
  findProject,
  findWorktree,
  generateFixtures,
  readManifestFile,
  readStatus,
  removeFixtureRoot,
  SPECIAL_CASES,
} from '../src/index.js';

let set: FixtureSet;

beforeAll(async () => {
  set = await generateFixtures({ seed: 42 });
}, 120_000);

afterAll(async () => {
  await set?.cleanup();
});

describe('fixture layout', () => {
  it('lives under the OS temp dir and writes a readable manifest', async () => {
    const tmp = await realpath(tmpdir());
    expect(set.root.startsWith(`${tmp}/octopus-diff-`)).toBe(true);
    const manifest = await readManifestFile(set.manifestPath);
    expect(manifest.projects.map((p) => p.name)).toEqual(set.manifest.projects.map((p) => p.name));
    expect(manifest.git.vars.GIT_CONFIG_GLOBAL).toBe(set.env.configPath);
    expect(manifest.git.vars.GIT_CONFIG_NOSYSTEM).toBe('1');
  });

  it('covers every special case', () => {
    const covered = new Set(set.manifest.projects.flatMap((p) => Object.keys(p.cases)));
    for (const name of SPECIAL_CASES) {
      if (name === 'conflict') continue;
      expect(covered, `special case ${name}`).toContain(name);
    }
    expect(covered).toContain('conflict');
  });

  it('places each case at a path the oracle reports in the working scope', () => {
    for (const project of set.manifest.projects) {
      for (const [name, location] of Object.entries(project.cases)) {
        if (!location || name === 'stat-dirty') continue;
        const { worktree } = findWorktree(set.manifest, location.worktree);
        const file = worktree.scopes.working?.find((f) => f.path === location.path);
        expect(file, `${name} at ${location.path}`).toBeDefined();
      }
    }
  });

  it('has globally unique worktree names and ids', () => {
    const worktrees = set.manifest.projects.flatMap((p) => p.worktrees);
    expect(new Set(worktrees.map((w) => w.name)).size).toBe(worktrees.length);
    expect(new Set(worktrees.map((w) => w.id)).size).toBe(worktrees.length);
    for (const w of worktrees) expect(w.id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('alpha: upstream, ahead/behind, linked worktrees', () => {
  it('main tracks origin/main and is ahead 2, behind 1', () => {
    const { worktree } = findWorktree(set.manifest, 'alpha');
    expect(worktree).toMatchObject({
      branch: 'main',
      isMain: true,
      upstream: 'origin/main',
      aheadBehindRef: 'origin/main',
      ahead: 2,
      behind: 1,
      dirty: true,
      counts: { staged: 1, unstaged: 1, untracked: 0, conflicted: 0 },
    });
  });

  it('has exactly two linked worktrees measured against the default branch', () => {
    const alpha = findProject(set.manifest, 'alpha');
    expect(alpha.worktrees.map((w) => w.name)).toEqual(['alpha', 'alpha-login', 'alpha-refactor']);
    expect(findWorktree(set.manifest, 'alpha-login').worktree).toMatchObject({
      branch: 'feature/login',
      upstream: null,
      aheadBehindRef: 'main',
      ahead: 2,
      behind: 1,
      counts: { staged: 0, unstaged: 1, untracked: 1, conflicted: 0 },
    });
    expect(findWorktree(set.manifest, 'alpha-refactor').worktree).toMatchObject({
      branch: 'agent/refactor',
      ahead: 1,
      behind: 0,
      counts: { staged: 1, unstaged: 1, untracked: 0, conflicted: 0 },
    });
    expect(alpha.defaultBranch).toBe('main');
  });

  it('records the branch scope of a feature worktree', () => {
    const { worktree } = findWorktree(set.manifest, 'alpha-login');
    expect(worktree.scopes.branch?.map((f) => f.path).sort()).toEqual([
      'src/app.ts',
      'src/login.ts',
    ]);
  });
});

describe('scan root layout', () => {
  it('lists expected projects, exclusions and symlink loops', () => {
    const [scan] = set.manifest.scanRoots;
    expect(scan?.depth).toBe(3);
    expect(scan?.expectedProjects.sort()).toEqual(['beta', 'epsilon', 'gamma']);
    for (const path of scan?.excludedRepoPaths ?? [])
      expect(existsSync(join(path, '.git'))).toBe(true);
    expect(scan?.excludedRepoPaths.some((p) => p.includes('/node_modules/'))).toBe(true);
    for (const loop of scan?.symlinkLoops ?? []) {
      expect(lstatSync(loop).isSymbolicLink()).toBe(true);
      expect(['.', '..']).toContain(readlinkSync(loop));
    }
  });

  it('beta has a detached linked worktree; gamma uses master; epsilon is clean', () => {
    expect(findWorktree(set.manifest, 'beta-detached').worktree).toMatchObject({
      branch: null,
      detached: true,
      isMain: false,
    });
    expect(findProject(set.manifest, 'gamma').defaultBranch).toBe('master');
    expect(findWorktree(set.manifest, 'gamma').worktree.branch).toBe('master');
    expect(findWorktree(set.manifest, 'epsilon').worktree.dirty).toBe(false);
  });
});

describe('kitchen-sink special cases', () => {
  const file = (path: string) => {
    const { worktree } = findWorktree(set.manifest, 'kitchen-sink');
    const found = worktree.scopes.working?.find((f) => f.path === path);
    if (!found) throw new Error(`missing ${path}`);
    return found;
  };
  const statusOf = (path: string) =>
    findWorktree(set.manifest, 'kitchen-sink').worktree.status.find((e) => e.path === path);

  it('staged + unstaged on the same file', () => {
    expect(statusOf('src/both.ts')).toMatchObject({ x: 'M', y: 'M' });
    const { worktree } = findWorktree(set.manifest, 'kitchen-sink');
    expect(worktree.scopes.staged?.some((f) => f.path === 'src/both.ts')).toBe(true);
    expect(worktree.scopes.unstaged?.some((f) => f.path === 'src/both.ts')).toBe(true);
  });

  it('rename, copy, deletes, added', () => {
    expect(file('src/new-name.ts')).toMatchObject({
      status: 'renamed',
      oldPath: 'src/old-name.ts',
    });
    expect(file('src/copy-dest.ts').status).toBe('added');
    expect(file('src/deleted.ts').status).toBe('deleted');
    expect(statusOf('src/deleted.ts')).toMatchObject({ x: '.', y: 'D' });
    expect(statusOf('src/staged-deleted.ts')).toMatchObject({ x: 'D', y: '.' });
    expect(file('src/feature-added.ts').status).toBe('added');
  });

  it('binary, very large, minified, CRLF', () => {
    expect(file('assets/logo.png')).toMatchObject({ binary: true, additions: null });
    const huge = file('generated/huge.sql');
    expect(huge.status).toBe('added');
    expect(huge.additions).toBeGreaterThan(50_000);
    const min = file('dist/app.min.js');
    expect(min).toMatchObject({ additions: 1, deletions: 1, binary: false });
    expect(file('windows/crlf.txt')).toMatchObject({ additions: 1, deletions: 1 });
  });

  it('non-UTF-8 and unicode filenames', () => {
    const latin = set.manifest.projects.find((p) => p.name === 'kitchen-sink')?.cases[
      'non-utf8-filename'
    ];
    expect(latin?.rawPath).toBe(Buffer.from('latin1/caf\xe9.txt', 'latin1').toString('base64'));
    const f = file(latin?.path ?? '');
    expect(f.rawPath).toBe(latin?.rawPath);
    expect(f.path).toContain('�');
    expect(file('docs/ünïcødé ✓.md').status).toBe('modified');
  });

  it('symlink, typechange, submodule', () => {
    expect(file('links/current')).toMatchObject({
      status: 'modified',
      oldMode: '120000',
      newMode: '120000',
    });
    expect(file('config/settings.json')).toMatchObject({ status: 'typechange', newMode: '120000' });
    expect(file('vendor/lib')).toMatchObject({ status: 'modified', newMode: '160000' });
  });

  it('untracked file counts and stat-dirty bait stays out of status', () => {
    expect(file('src/scratch.ts')).toMatchObject({ status: 'untracked', additions: 8 });
    expect(statusOf('src/touched.ts')).toBeUndefined();
    const { worktree } = findWorktree(set.manifest, 'kitchen-sink');
    expect(worktree.counts.untracked).toBe(1);
  });
});

describe('edge-case repositories', () => {
  it('conflict repo is mid-merge with an unmerged file', () => {
    const { worktree } = findWorktree(set.manifest, 'conflict');
    expect(worktree.inProgress).toBe('merge');
    expect(worktree.counts.conflicted).toBe(1);
    expect(worktree.scopes.working?.find((f) => f.path === 'shared.txt')?.status).toBe(
      'conflicted',
    );
  });

  it('root-only repo records its root commit files', () => {
    const { worktree } = findWorktree(set.manifest, 'root-only');
    expect(worktree.commits).toHaveLength(1);
    expect(worktree.commits[0]?.parents).toEqual([]);
    expect(worktree.commits[0]?.files?.map((f) => f.path).sort()).toEqual([
      'README.md',
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  it('empty repo has an unborn HEAD with staged and untracked files', () => {
    const { project, worktree } = findWorktree(set.manifest, 'empty');
    expect(worktree.headSha).toBeNull();
    expect(worktree.branch).toBe('main');
    expect(worktree.counts).toEqual({ staged: 1, unstaged: 0, untracked: 1, conflicted: 0 });
    expect(project.defaultBranch).toBeNull();
  });

  it('bare repo has a bare entry and two linked worktrees', () => {
    const project = findProject(set.manifest, 'bare-project');
    expect(project.bare).toBe(true);
    expect(project.mainWorktreePath).toBeNull();
    expect(project.worktrees.find((w) => w.bare)?.path).toBe(project.commonDir);
    expect(
      project.worktrees
        .filter((w) => !w.bare)
        .map((w) => w.branch)
        .sort(),
    ).toEqual(['feature/bare', 'main']);
  });

  it('mutable live project has two dirty worktrees', () => {
    const live = findProject(set.manifest, 'live');
    expect(live.role).toBe('mutable');
    expect(live.worktrees.map((w) => w.dirty)).toEqual([true, true]);
  });
});

describe('oracle agrees with git after a mutation', () => {
  it('describeWorktree re-derives counts', async () => {
    const { worktree } = findWorktree(set.manifest, 'live');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(worktree.path, 'src/new-untracked.ts'), 'export const x = 1;\n');
    const updated = await set.describeWorktree('live');
    expect(updated.counts.untracked).toBe(worktree.counts.untracked + 1);
    const status = await readStatus({ env: set.env }, worktree.path);
    expect(status.entries.some((e) => e.path === 'src/new-untracked.ts')).toBe(true);
  });
});

describe('determinism and cleanup', () => {
  it('the same seed produces the same commit shas', async () => {
    const again = await generateFixtures({ seed: 42 });
    try {
      const shas = (s: FixtureSet) =>
        s.manifest.projects.flatMap((p) => p.worktrees.map((w) => `${w.name}:${w.headSha}`));
      expect(shas(again)).toEqual(shas(set));
    } finally {
      await again.cleanup();
    }
    expect(existsSync(again.root)).toBe(false);
  }, 120_000);

  it('refuses to delete paths outside the temp dir', async () => {
    await expect(removeFixtureRoot('/home')).rejects.toThrow(/refusing/);
  });

  it('bench layout builds N repos × M worktrees', async () => {
    const bench = await generateFixtures({
      acceptance: false,
      bench: { repos: 2, worktreesPerRepo: 3, filesPerRepo: 5 },
    });
    try {
      const projects = bench.manifest.projects.filter((p) => p.role === 'bench');
      expect(projects).toHaveLength(2);
      for (const p of projects) {
        expect(p.worktrees).toHaveLength(3);
        for (const w of p.worktrees) expect(w.dirty).toBe(true);
      }
    } finally {
      await bench.cleanup();
    }
  }, 120_000);
});
