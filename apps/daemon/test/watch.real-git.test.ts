import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitCore, ServerEvent } from '@octopus-diff/contracts';
import { createGitCore, GIT_CORE_IMPLEMENTED } from '@octopus-diff/git-core';
import parcelWatcher from '@parcel/watcher';
import { describe, expect, it } from 'vitest';
import { type Daemon, startDaemon } from '../src/daemon.js';
import { hashId } from '../src/ids.js';
import {
  client,
  type EventRecorder,
  eventually,
  onCleanup,
  recordEvents,
  sleep,
  TEST_TOKEN,
  tempDir,
} from './helpers.js';

/**
 * End-to-end regression tests for the watcher findings (review-code F1, F3, F5, F6 and
 * review-security SEC-07) with the REAL git-core and real repositories. Fixtures live under
 * os.tmpdir() with an isolated git config (AGENTS.md); git commands here only set up fixtures.
 */

interface Fixture {
  root: string;
  env: Record<string, string>;
  git: (cwd: string, ...args: string[]) => string;
  sh: (cwd: string, script: string) => string;
}

async function makeFixture(): Promise<Fixture> {
  const root = realpathSync(await tempDir('octopus-diff-watch-'));
  const gitconfig = path.join(root, 'gitconfig');
  await writeFile(
    gitconfig,
    [
      '[user]',
      '\tname = Fixture',
      '\temail = fixture@example.com',
      '[init]',
      '\tdefaultBranch = main',
      '[commit]',
      '\tgpgsign = false',
      '[core]',
      '\tautocrlf = false',
      '[protocol "file"]',
      '\tallow = always',
      '',
    ].join('\n'),
  );
  const env: Record<string, string> = {
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('GIT_')) baseEnv[k] = v;
  }
  const fullEnv = { ...baseEnv, ...env };
  return {
    root,
    env,
    git: (cwd, ...args) => execFileSync('git', args, { cwd, env: fullEnv, encoding: 'utf8' }),
    sh: (cwd, script) =>
      execFileSync('sh', ['-c', script], { cwd, env: fullEnv, encoding: 'utf8' }),
  };
}

async function makeRepo(fx: Fixture, name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(fx.root, name);
  fx.git(fx.root, 'init', '-q', name);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  fx.git(dir, 'add', '-A');
  fx.git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

interface Started {
  daemon: Daemon;
  events: EventRecorder;
  /** getSummary calls so far, in total or for one worktree path. */
  summaries: (worktreePath?: string) => number;
  subscribed: string[];
}

async function start(fx: Fixture): Promise<Started> {
  const real = createGitCore({ env: fx.env });
  const summaries = new Map<string, number>();
  const gitCore: GitCore = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'getSummary') {
        return (...args: Parameters<GitCore['getSummary']>) => {
          summaries.set(args[0].path, (summaries.get(args[0].path) ?? 0) + 1);
          return target.getSummary(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const subscribed: string[] = [];
  const daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir: await tempDir(),
    logLevel: process.env.OCTOPUS_DIFF_TEST_LOGS ? 'debug' : 'silent',
    gitCore,
    watch: { debounceMs: 150 },
    internal: {
      subscribe: async (dir, fn, opts) => {
        subscribed.push(dir);
        return parcelWatcher.subscribe(dir, fn, opts);
      },
    },
  });
  onCleanup(async () => {
    await daemon.close();
    await real.dispose();
  });
  const events = recordEvents(daemon);
  await events.opened;
  const count = (worktreePath?: string) =>
    worktreePath === undefined
      ? [...summaries.values()].reduce((a, b) => a + b, 0)
      : (summaries.get(worktreePath) ?? 0);
  return { daemon, events, summaries: count, subscribed };
}

/** Waits for a `worktree.changed` of `worktreeId` recorded after `mark`. */
function changedAfter(events: EventRecorder, mark: number, worktreeId: string, timeoutMs = 5000) {
  return events.waitFor(
    (e: ServerEvent) =>
      events.events.indexOf(e) >= mark &&
      e.type === 'worktree.changed' &&
      e.worktreeId === worktreeId,
    timeoutMs,
  );
}

describe.skipIf(!GIT_CORE_IMPLEMENTED)(
  'watching with real git (review fixes)',
  {
    timeout: 30_000,
  },
  () => {
    it('F1: a worktree removed and re-added at the same path stays live; health is truthful', async () => {
      const fx = await makeFixture();
      const repo = await makeRepo(fx, 'alpha', { 'a.txt': 'one\n' });
      const wt = path.join(fx.root, 'alpha-wt');
      fx.git(repo, 'worktree', 'add', '-q', '-b', 'b1', wt);
      const { daemon, events } = await start(fx);
      const api = client(daemon);
      await api.addProject({ path: repo });
      await eventually(() => daemon.core.watcher.isWatched(hashId(wt)), 5000);
      await sleep(500);

      fx.sh(repo, `git worktree remove --force "${wt}" && git worktree add -q -b b2 "${wt}"`);
      await eventually(async () => {
        const health = await api.health();
        return health.watcher.mode === 'native' && health.watcher.warnings.length === 0;
      }, 5000);
      await sleep(500);

      const mark = events.events.length;
      await writeFile(path.join(wt, 'a.txt'), 'edited by agent\n');
      await changedAfter(events, mark, hashId(wt));
    });

    it('F3: a commit inside a submodule refreshes the superproject (no refresh loop)', async () => {
      const fx = await makeFixture();
      const lib = await makeRepo(fx, 'lib', { 'a.txt': 'v1\n' });
      const sup = await makeRepo(fx, 'super', { 'readme.md': 'r\n' });
      fx.git(sup, 'submodule', 'add', '-q', lib, 'sub');
      fx.git(sup, 'commit', '-q', '-m', 'add sub');
      const sub = path.join(sup, 'sub');
      const { daemon, events, summaries } = await start(fx);
      await client(daemon).addProject({ path: sup });
      await eventually(() => daemon.core.watcher.isWatched(hashId(sup)), 5000);
      await sleep(500);

      // Only the submodule's git dir (.git/modules/sub) changes: HEAD's branch moves.
      const mark = events.events.length;
      fx.git(sub, 'commit', '-q', '--allow-empty', '-m', 'inside the submodule');
      await changedAfter(events, mark, hashId(sup));

      // Our own `git status` must not write the submodule's index and trigger itself again.
      await sleep(800);
      const settled = summaries();
      await sleep(1500);
      expect(summaries()).toBe(settled);
    });

    it('F3: a submodule registered as its own project does not steal its superproject events', async () => {
      const fx = await makeFixture();
      const lib = await makeRepo(fx, 'lib', { 'a.txt': 'v1\n' });
      const sup = await makeRepo(fx, 'super', { 'readme.md': 'r\n' });
      fx.git(sup, 'submodule', 'add', '-q', lib, 'sub');
      fx.git(sup, 'commit', '-q', '-m', 'add sub');
      const sub = path.join(sup, 'sub');
      const { daemon, events, summaries } = await start(fx);
      const api = client(daemon);
      await api.addProject({ path: sup });
      const added = await api.addProject({ path: sub });
      expect(added.project.project.id).not.toBe(hashId(realpathSync(path.join(sup, '.git'))));
      // git 2.53 reports the submodule's git dir (.git/modules/sub) as its main worktree; a
      // git-core that reports the checkout (`sub`) instead exercises the nested-project path.
      const subWorktree = added.project.worktrees[0]?.worktree;
      if (!subWorktree) throw new Error('submodule project has no worktree');
      await eventually(() => daemon.core.watcher.isWatched(subWorktree.id), 5000);
      // Not refused as "too broad": the health stays clean.
      expect((await api.health()).watcher).toEqual({ mode: 'native', warnings: [] });
      await sleep(500);

      // An edit inside the submodule refreshes the superproject (its status ignores dirty
      // submodule content by design, so no event is expected for the edit alone).
      const before = summaries(sup);
      let mark = events.events.length;
      await writeFile(path.join(sub, 'a.txt'), 'edited inside the submodule\n');
      await eventually(() => summaries(sup) > before, 5000);
      if (subWorktree.path === sub) await changedAfter(events, mark, hashId(sub));

      // A commit inside the submodule moves the gitlink state: the superproject changes.
      await sleep(500);
      mark = events.events.length;
      fx.git(sub, 'commit', '-q', '-am', 'commit inside the submodule');
      await changedAfter(events, mark, hashId(sup));
    });

    it('F5: edits to tracked files under dist/ and tools/build/ are live', async () => {
      const fx = await makeFixture();
      const repo = await makeRepo(fx, 'action', {
        'src/main.ts': 'export {};\n',
        'dist/index.js': 'bundle v1\n',
        'tools/build/run.sh': 'echo build\n',
        '.gitignore': 'node_modules\n',
      });
      const { daemon, events } = await start(fx);
      await client(daemon).addProject({ path: repo });
      await eventually(() => daemon.core.watcher.isWatched(hashId(repo)), 5000);
      await sleep(500);

      let mark = events.events.length;
      await writeFile(path.join(repo, 'dist', 'index.js'), 'rebuilt by agent\n');
      await changedAfter(events, mark, hashId(repo));
      await sleep(500);
      mark = events.events.length;
      await writeFile(path.join(repo, 'tools', 'build', 'run.sh'), 'echo changed\n');
      await changedAfter(events, mark, hashId(repo));
    });

    it('F6: editing .git/info/exclude is picked up live', async () => {
      const fx = await makeFixture();
      const repo = await makeRepo(fx, 'beta', { 'a.txt': 'a\n' });
      await writeFile(path.join(repo, 'junk.log'), 'noise\n');
      const { daemon, events } = await start(fx);
      const api = client(daemon);
      await api.addProject({ path: repo });
      const id = hashId(repo);
      expect((await api.listFiles(id)).files.map((f) => f.path)).toEqual(['junk.log']);
      await sleep(500);

      const mark = events.events.length;
      await mkdir(path.join(repo, '.git', 'info'), { recursive: true });
      await writeFile(path.join(repo, '.git', 'info', 'exclude'), 'junk.log\n');
      await changedAfter(events, mark, id);
      expect((await api.listFiles(id)).files).toEqual([]);
    });

    it('SEC-07: a forged worktree record does not make the daemon watch its target', async () => {
      const fx = await makeFixture();
      const repo = await makeRepo(fx, 'gamma', { 'a.txt': 'a\n' });
      const victim = path.join(fx.root, 'victim');
      for (let i = 0; i < 20; i++) await mkdir(path.join(victim, `d${i}`), { recursive: true });
      const admin = path.join(repo, '.git', 'worktrees', 'evil');
      await mkdir(admin, { recursive: true });
      await writeFile(path.join(admin, 'gitdir'), `${victim}/.git\n`);
      await writeFile(path.join(admin, 'HEAD'), 'ref: refs/heads/main\n');
      await writeFile(path.join(admin, 'commondir'), '../..\n');
      expect(fx.git(repo, 'worktree', 'list', '--porcelain')).toContain(`worktree ${victim}`);

      const { daemon, subscribed } = await start(fx);
      await client(daemon).addProject({ path: repo });
      await eventually(() => daemon.core.watcher.isWatched(hashId(repo)), 5000);
      await sleep(300);
      expect(daemon.core.watcher.isWatched(hashId(victim))).toBe(false);
      expect(subscribed).not.toContain(victim);
    });
  },
);
