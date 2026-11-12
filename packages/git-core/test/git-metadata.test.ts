/**
 * Per-project git metadata (#29): worktrees of one repository share their repository info, the
 * config scan, the default branch lookup and commit facts, so a refresh of a project costs one
 * `for-each-ref` and one config read, not one per worktree. Every shared answer must equal what
 * git itself says, and repository config stays untrusted: a change to it is seen by the next
 * operation, and `include` / `includeIf` disable reuse.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { GitCore, ProjectLocator, WorktreeLocator } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore } from '../src/index.js';
import { locator } from './helpers/core.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

let fx: Fixture;

/** Config files younger than this are never reused (racy guard in `GitContext.configScan`). */
const RACY_WAIT_MS = 2100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A git wrapper that logs each invocation's argv, one file per process (concurrent processes would
 * interleave writes to one shared log), so tests can count spawns by subcommand.
 */
function spawnLog(name: string, version?: string) {
  const dir = path.join(fx.root, `${name}.spawns`);
  mkdirSync(dir, { recursive: true });
  const wrapper = path.join(fx.root, `${name}.sh`);
  const fake = version
    ? `if [ "$1" = "--version" ]; then echo "git version ${version}"; exit 0; fi\n`
    : '';
  writeFileSync(
    wrapper,
    `#!/bin/sh\n${fake}f=$(mktemp '${dir}/XXXXXXXX')\nfor a in "$@"; do printf '%s\\001' "$a" >> "$f"; done\nexec git "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  const seen = new Set<string>();
  /** Subcommands of the processes started since the last `take()`. */
  const take = (): string[] => {
    const fresh = readdirSync(dir).filter((file) => !seen.has(file));
    return fresh.map((file) => {
      seen.add(file);
      const args = readFileSync(path.join(dir, file), 'utf8')
        .split('\u0001')
        .filter((a) => a.length > 0);
      let i = 0;
      while (i < args.length) {
        const a = args[i] as string;
        if (a === '-c' || a === '-C') i += 2;
        else if (a.startsWith('-')) i += 1;
        else break;
      }
      return args[i] ?? (args[0] as string);
    });
  };
  return { wrapper, take };
}

const count = (subs: string[], sub: string) => subs.filter((s) => s === sub).length;

function gitText(cwd: string, args: string[]): string {
  return fx.git(cwd, args).trim();
}

beforeAll(() => {
  fx = createFixture();
});

afterAll(() => {
  fx.dispose();
});

describe('a project with three worktrees', () => {
  let repo: string;
  let wt1: string;
  let wt2: string;
  let project: ProjectLocator;
  let core: GitCore;
  let spawns: ReturnType<typeof spawnLog>;
  let locators: WorktreeLocator[];

  beforeAll(async () => {
    repo = fx.repo('shared', { files: { 'a.txt': 'a\n' } });
    fx.write(path.join(repo, 'b.txt'), 'b\n');
    fx.commitAll(repo, 'second');
    wt1 = path.join(fx.root, 'shared-wt1');
    wt2 = path.join(fx.root, 'shared-wt2');
    fx.git(repo, ['worktree', 'add', '-q', '-b', 'agent/one', wt1]);
    fx.git(repo, ['worktree', 'add', '-q', '-b', 'agent/two', wt2, 'HEAD~1']);
    fx.write(path.join(wt1, 'c.txt'), 'c\n');
    fx.commitAll(wt1, 'ahead on one');
    fx.write(path.join(wt1, 'dirty.txt'), 'dirty\n');
    fx.write(path.join(wt2, 'a.txt'), 'changed\n');
    // Main moves on: agent/two is behind it, agent/one ahead and behind.
    fx.write(path.join(repo, 'm.txt'), 'm\n');
    fx.commitAll(repo, 'main moves');
    await sleep(RACY_WAIT_MS);
    spawns = spawnLog('shared');
    core = createGitCore(fx.coreOptions({ gitBinary: spawns.wrapper }));
  });

  afterAll(async () => {
    await core?.dispose();
  });

  it('resolves the project once and derives every worktree from it', async () => {
    const resolved = await core.resolveProject(repo);
    project = resolved.project;
    expect(resolved.worktrees).toHaveLength(3);
    locators = resolved.worktrees.map((w) => ({
      projectId: w.projectId,
      worktreeId: w.id,
      path: w.path,
    }));
    spawns.take();
    await Promise.all(locators.map((wt) => core.getWatchTargets(wt)));
    // No `rev-parse` per worktree: `git worktree list` already told us where they are.
    expect(spawns.take()).toEqual([]);
  });

  it('summarizes all worktrees with one for-each-ref and one config read', async () => {
    const summaries = await Promise.all(
      locators.map((wt) => core.getSummary(wt, { defaultBranch: 'main' })),
    );
    const subs = spawns.take();
    expect(count(subs, 'rev-parse')).toBe(0);
    expect(count(subs, 'symbolic-ref')).toBe(0);
    expect(count(subs, 'config')).toBe(1);
    expect(count(subs, 'status')).toBe(3);
    const version = await core.version();
    if (version.features.forEachRefAheadBehind) {
      expect(count(subs, 'for-each-ref')).toBe(1);
      expect(count(subs, 'rev-list')).toBe(0);
    } else {
      expect(count(subs, 'for-each-ref')).toBe(0);
    }
    // The counts are git's.
    for (const summary of summaries) {
      const wt = locators.find((l) => l.worktreeId === summary.worktreeId) as WorktreeLocator;
      if (summary.branch === 'main') {
        expect(summary.ahead).toBeNull();
        continue;
      }
      const [ahead, behind] = gitText(wt.path, [
        'rev-list',
        '--left-right',
        '--count',
        'HEAD...main',
      ])
        .split(/\s+/)
        .map(Number);
      expect(summary.aheadBehindRef).toBe('main');
      expect([summary.ahead, summary.behind]).toEqual([ahead, behind]);
    }
  });

  it('a second refresh reuses the config read and the counts', async () => {
    await Promise.all(locators.map((wt) => core.getSummary(wt, { defaultBranch: 'main' })));
    const subs = spawns.take();
    expect(count(subs, 'config')).toBe(0);
    expect(count(subs, 'for-each-ref')).toBe(0);
    expect(count(subs, 'rev-list')).toBe(0);
    expect(subs.filter((s) => s !== 'status' && s !== 'diff' && s !== 'check-attr')).toEqual([]);
  });

  it('review ranges read HEAD from files and share merge bases', async () => {
    const ranges = await Promise.all(
      locators.map((wt) => core.readReviewRange?.(wt, { bookmark: null, defaultBranch: 'main' })),
    );
    const subs = spawns.take();
    expect(count(subs, 'rev-parse')).toBe(0);
    expect(count(subs, 'symbolic-ref')).toBe(0);
    expect(count(subs, 'for-each-ref')).toBe(0);
    for (const [i, wt] of locators.entries()) {
      const range = ranges[i];
      expect(range?.head).toBe(gitText(wt.path, ['rev-parse', 'HEAD']));
      if (wt.path === repo) {
        expect(range?.startsAtHead).toBe(true);
      } else {
        expect(range?.base).toBe(gitText(wt.path, ['merge-base', 'HEAD', 'main']));
      }
    }
    // Same answers again, without any git process.
    await Promise.all(
      locators.map((wt) => core.readReviewRange?.(wt, { bookmark: null, defaultBranch: 'main' })),
    );
    expect(spawns.take()).toEqual([]);
  });

  it('follows a commit: the moved head is counted again, once', async () => {
    fx.write(path.join(wt2, 'd.txt'), 'd\n');
    fx.commitAll(wt2, 'two moves');
    const wt = locators.find((l) => l.path === wt2) as WorktreeLocator;
    const summary = await core.getSummary(wt, { defaultBranch: 'main' });
    const [ahead, behind] = gitText(wt2, ['rev-list', '--left-right', '--count', 'HEAD...main'])
      .split(/\s+/)
      .map(Number);
    expect([summary.ahead, summary.behind]).toEqual([ahead, behind]);
    const range = await core.readReviewRange?.(wt, { bookmark: null, defaultBranch: 'main' });
    expect(range?.head).toBe(gitText(wt2, ['rev-parse', 'HEAD']));
    expect(range?.commits.map((c) => c.sha)).toEqual(
      gitText(wt2, ['rev-list', 'main..HEAD']).split('\n'),
    );
  });

  it('agrees with git for a detached HEAD (no branch to batch: rev-list)', async () => {
    const sha = gitText(wt1, ['rev-parse', 'HEAD~1']);
    fx.git(wt1, ['switch', '-q', '--detach', sha]);
    try {
      const wt = locators.find((l) => l.path === wt1) as WorktreeLocator;
      const summary = await core.getSummary(wt, { defaultBranch: 'main' });
      expect(summary.detached).toBe(true);
      const [ahead, behind] = gitText(wt1, ['rev-list', '--left-right', '--count', 'HEAD...main'])
        .split(/\s+/)
        .map(Number);
      expect([summary.ahead, summary.behind]).toEqual([ahead, behind]);
      const range = await core.readReviewRange?.(wt, { bookmark: null, defaultBranch: 'main' });
      expect(range?.head).toBe(sha);
      expect(range?.startsAtHead).toBe(true);
    } finally {
      fx.git(wt1, ['switch', '-q', 'agent/one']);
    }
  });

  it('agrees with git for packed refs and the default branch detection', async () => {
    fx.git(repo, ['pack-refs', '--all', '--prune']);
    expect(await core.detectDefaultBranch(project)).toBe('main');
    fx.git(repo, ['update-ref', 'refs/remotes/origin/trunk', 'agent/two']);
    fx.git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
    // origin/HEAD → origin/trunk; no local trunk: the remote one.
    expect(await core.detectDefaultBranch(project)).toBe('origin/trunk');
    fx.git(repo, ['branch', 'trunk', 'agent/two']);
    expect(await core.detectDefaultBranch(project)).toBe('trunk');
    // A dangling origin/HEAD is skipped, as for-each-ref skips broken refs.
    fx.git(repo, ['update-ref', '-d', 'refs/remotes/origin/trunk']);
    fx.git(repo, ['branch', '-D', 'trunk']);
    expect(await core.detectDefaultBranch(project)).toBe('main');
    fx.git(repo, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
    for (const wt of locators) {
      const range = await core.readReviewRange?.(wt, { bookmark: null, defaultBranch: 'main' });
      expect(range?.head).toBe(gitText(wt.path, ['rev-parse', 'HEAD']));
    }
  });
});

describe('config scan reuse', () => {
  let markers: string;
  const script = (name: string): string => {
    const file = path.join(fx.root, `${name}-filter.sh`);
    writeFileSync(file, `#!/bin/sh\necho x > "${markers}/${name}"\ncat\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const markerNames = (): string[] => (existsSync(markers) ? readdirSync(markers).sort() : []);
  const clearMarkers = (): void => {
    for (const name of markerNames()) rmSync(path.join(markers, name));
  };
  /** Makes `file` stat-dirty so the next status/diff re-reads it through any clean filter. */
  const touch = (file: string): void => {
    const future = new Date(Date.now() + 60_000 + Math.floor(Math.random() * 60_000));
    utimesSync(file, future, future);
  };

  beforeAll(() => {
    markers = path.join(fx.root, 'cfg-markers');
    fx.write(path.join(markers, '.keep'), '');
    rmSync(path.join(markers, '.keep'));
  });

  it('a filter driver added to repository config is neutralized by the very next operation', async () => {
    const repo = fx.repo('cfg-late', {
      files: { 'x.txt': 'x\n', '.gitattributes': '* filter=late\n' },
    });
    fx.write(path.join(repo, 'x.txt'), 'changed\n');
    await sleep(RACY_WAIT_MS);
    const spawns = spawnLog('cfg-late');
    const core = createGitCore(fx.coreOptions({ gitBinary: spawns.wrapper }));
    try {
      const wt = locator(repo, path.join(repo, '.git'));
      await core.getSummary(wt);
      spawns.take();
      await core.getSummary(wt);
      expect(count(spawns.take(), 'config')).toBe(0); // reused
      clearMarkers();
      fx.git(repo, ['config', 'filter.late.clean', script('late')]);
      touch(path.join(repo, 'x.txt'));
      await core.getSummary(wt);
      await core.listChangedFiles(wt, { kind: 'working' });
      expect(markerNames()).toEqual([]);
      // Changed within the racy window: read again on every operation until it settles.
      expect(count(spawns.take(), 'config')).toBe(2);
    } finally {
      await core.dispose();
    }
  });

  it('a filter driver in one worktree’s config.worktree applies to that worktree only', async () => {
    const repo = fx.repo('cfg-wt', {
      files: { 'x.txt': 'x\n', '.gitattributes': '* filter=wt\n' },
    });
    const linked = path.join(fx.root, 'cfg-wt-linked');
    fx.git(repo, ['worktree', 'add', '-q', '-b', 'side', linked]);
    fx.git(repo, ['config', 'extensions.worktreeConfig', 'true']);
    fx.write(path.join(repo, 'x.txt'), 'main\n');
    fx.write(path.join(linked, 'x.txt'), 'linked\n');
    await sleep(RACY_WAIT_MS);
    const core = createGitCore(fx.coreOptions());
    try {
      const { worktrees } = await core.resolveProject(repo);
      const wts = worktrees.map((w) => ({
        projectId: w.projectId,
        worktreeId: w.id,
        path: w.path,
      }));
      await Promise.all(wts.map((wt) => core.getSummary(wt)));
      clearMarkers();
      fx.git(linked, ['config', '--worktree', 'filter.wt.clean', script('worktree')]);
      touch(path.join(repo, 'x.txt'));
      touch(path.join(linked, 'x.txt'));
      await Promise.all(wts.map((wt) => core.getSummary(wt)));
      await Promise.all(wts.map((wt) => core.listChangedFiles(wt, { kind: 'working' })));
      expect(markerNames()).toEqual([]);
    } finally {
      await core.dispose();
    }
  });

  it('never reuses a scan when config includes other files', async () => {
    const repo = fx.repo('cfg-include', {
      files: { 'x.txt': 'x\n', '.gitattributes': '* filter=inc\n' },
    });
    const include = path.join(fx.root, 'cfg-include.inc');
    writeFileSync(include, '');
    fx.git(repo, ['config', 'include.path', include]);
    fx.write(path.join(repo, 'x.txt'), 'changed\n');
    await sleep(RACY_WAIT_MS);
    const spawns = spawnLog('cfg-include');
    const core = createGitCore(fx.coreOptions({ gitBinary: spawns.wrapper }));
    try {
      const wt = locator(repo, path.join(repo, '.git'));
      await core.getSummary(wt);
      await core.getSummary(wt);
      expect(count(spawns.take(), 'config')).toBe(2);
      clearMarkers();
      // Only the included file changes; the repository's own config file does not.
      writeFileSync(include, `[filter "inc"]\n\tclean = ${script('include')}\n`);
      touch(path.join(repo, 'x.txt'));
      await Promise.all([core.getSummary(wt), core.listChangedFiles(wt, { kind: 'working' })]);
      expect(markerNames()).toEqual([]);
    } finally {
      await core.dispose();
    }
  });
});

describe('git older than 2.41', () => {
  it('counts ahead/behind with rev-list, once per head and base', async () => {
    const repo = fx.repo('oldgit', { files: { 'a.txt': 'a\n' } });
    const linked = path.join(fx.root, 'oldgit-wt');
    fx.git(repo, ['worktree', 'add', '-q', '-b', 'topic', linked]);
    fx.write(path.join(linked, 'b.txt'), 'b\n');
    fx.commitAll(linked, 'topic');
    const spawns = spawnLog('oldgit', '2.40.1');
    const core = createGitCore(fx.coreOptions({ gitBinary: spawns.wrapper }));
    try {
      expect((await core.version()).features.forEachRefAheadBehind).toBe(false);
      const { worktrees } = await core.resolveProject(repo);
      const wt = worktrees.find((w) => w.path === linked);
      const loc = { projectId: wt?.projectId ?? '', worktreeId: wt?.id ?? '', path: linked };
      spawns.take();
      const summary = await core.getSummary(loc, { defaultBranch: 'main' });
      expect([summary.ahead, summary.behind]).toEqual([1, 0]);
      expect(count(spawns.take(), 'rev-list')).toBe(1);
      await core.getSummary(loc, { defaultBranch: 'main' });
      expect(count(spawns.take(), 'rev-list')).toBe(0);
    } finally {
      await core.dispose();
    }
  });
});

describe('reftable repositories', () => {
  it('fall back to git for refs and HEAD, with the same answers', async () => {
    const dir = path.join(fx.root, 'reftable');
    const init = spawnSync('git', ['init', '-q', '--ref-format=reftable', dir], {
      env: { ...process.env, ...fx.env },
    });
    if (init.status !== 0) return; // git < 2.45: no reftable support to test.
    fx.write(path.join(dir, 'a.txt'), 'a\n');
    fx.commitAll(dir, 'one');
    fx.git(dir, ['switch', '-q', '-c', 'topic']);
    fx.write(path.join(dir, 'b.txt'), 'b\n');
    fx.commitAll(dir, 'two');
    const core = createGitCore(fx.coreOptions());
    try {
      const { project } = await core.resolveProject(dir);
      const wt = locator(dir, project.commonDir);
      expect(await core.detectDefaultBranch(project)).toBe('main');
      const summary = await core.getSummary(wt, { defaultBranch: 'main' });
      expect([summary.ahead, summary.behind]).toEqual([1, 0]);
      const range = await core.readReviewRange?.(wt, { bookmark: null, defaultBranch: 'main' });
      expect(range?.head).toBe(gitText(dir, ['rev-parse', 'HEAD']));
      expect(range?.base).toBe(gitText(dir, ['rev-parse', 'main']));
      const base = await core.readBranchBase?.(project, { defaultBranch: 'main' });
      expect(base?.oid).toBe(gitText(dir, ['rev-parse', 'main']));
    } finally {
      await core.dispose();
    }
  });
});
