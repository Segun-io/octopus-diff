/**
 * #74: with a remote, a warm reload must cost no git process once its data is known, and startup
 * must read config once per project for the scan plus once for the remote config. The layout is
 * the one of the `--after-fetch` bench: a bare `origin`, a feature worktree that committed its own
 * file and merged `origin/main`, and a stale local `main`. Spawns are counted (with their argv)
 * through a wrapper script around the real git; nothing here contacts a forge (fake client).
 */
import { chmodSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DiffScope } from '@octopus-diff/contracts';
import { createGitCore, GIT_CORE_IMPLEMENTED } from '@octopus-diff/git-core';
import { describe, expect, it } from 'vitest';
import { type Daemon, startDaemon } from '../src/daemon.js';
import type { ForgeClientLike } from '../src/forges.js';
import { hashId } from '../src/ids.js';
import {
  client,
  eventually,
  onCleanup,
  recordEvents,
  sleep,
  TEST_TOKEN,
  tempDir,
} from './helpers.js';
import { makeRealGitFixture, makeRealRepo, type RealGitFixture } from './real-git-fixture.js';

const REVIEW: DiffScope = { kind: 'review' };
const BRANCH_ALL: DiffScope = { kind: 'branch', includeWorking: true };
const WORKING: DiffScope = { kind: 'working' };

/** git-core never reuses a config file younger than this (the racy window, DECISIONS #191). */
const RACY_WAIT_MS = 2100;

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

/** The forge layer must never get this far: `origin` is a local path, not a forge host. */
const noForge: ForgeClientLike = {
  probe: () => Promise.reject(new Error('no forge CLI in this test')),
  fetchChangeRequests: () => Promise.reject(new Error('no forge CLI in this test')),
};

interface Layout {
  fx: RealGitFixture;
  repo: string;
  feature: string;
  second: string;
  projectId: string;
  mainId: string;
  featureId: string;
  secondId: string;
}

/**
 * `app` (a clone of the bare `origin`, local `main` left behind) with two linked worktrees that each
 * committed one own file and merged `origin/main` after a fetch moved it; `feature` is dirty.
 */
async function layout(): Promise<Layout> {
  const fx = await makeRealGitFixture();
  const seed = await makeRealRepo(fx, 'seed', { 'base.txt': 'base\n', 'shared.txt': lines(20) });
  const origin = path.join(fx.root, 'origin.git');
  fx.git(fx.root, 'clone', '-q', '--bare', seed, origin);
  const repo = path.join(fx.root, 'app');
  const other = path.join(fx.root, 'other');
  fx.git(fx.root, 'clone', '-q', origin, repo);
  fx.git(fx.root, 'clone', '-q', origin, other);
  const feature = path.join(fx.root, 'app-feature');
  const second = path.join(fx.root, 'app-second');
  fx.git(repo, 'worktree', 'add', '-q', '-b', 'feature', feature);
  fx.git(repo, 'worktree', 'add', '-q', '-b', 'second', second);
  for (const dir of [feature, second]) {
    writeFileSync(path.join(dir, `${path.basename(dir)}.txt`), 'own\n');
    fx.git(dir, 'add', '-A');
    fx.git(dir, 'commit', '-q', '-m', 'own work');
  }
  writeFileSync(path.join(other, 'upstream.txt'), 'upstream\n');
  fx.git(other, 'add', '-A');
  fx.git(other, 'commit', '-q', '-m', 'upstream');
  fx.git(other, 'push', '-q', 'origin', 'main');
  fx.git(repo, 'fetch', '-q', 'origin');
  for (const dir of [feature, second]) fx.git(dir, 'merge', '-q', '--no-edit', 'origin/main');
  await writeFile(path.join(feature, 'dirty.txt'), 'dirty\n');
  return {
    fx,
    repo,
    feature,
    second,
    projectId: hashId(realpathSync(path.join(repo, '.git'))),
    mainId: hashId(repo),
    featureId: hashId(feature),
    secondId: hashId(second),
  };
}

interface Counting {
  daemon: Daemon;
  api: ReturnType<typeof client>;
  /** Argv (after the wrapper) of every git process started so far. */
  spawns: () => string[];
}

async function startCounting(fx: RealGitFixture, stateDir: string): Promise<Counting> {
  const dir = await tempDir();
  const log = path.join(dir, 'spawns.log');
  writeFileSync(log, '');
  const wrapper = path.join(dir, 'git-wrapper.sh');
  // One short line per process (an O_APPEND write of a line this size is not interleaved).
  writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec git "$@"\n`);
  chmodSync(wrapper, 0o755);
  const daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir,
    logLevel: process.env.OCTOPUS_DIFF_TEST_LOGS ? 'debug' : 'silent',
    gitCore: createGitCore({ env: fx.env, gitBinary: wrapper }),
    watch: { debounceMs: 150 },
    internal: {
      forges: {
        client: noForge,
        debounceMs: 20,
        pollMs: 300,
        hotPollMs: 300,
        readSshConfig: async () => null,
      },
    },
  });
  onCleanup(() => daemon.close());
  return {
    daemon,
    api: client(daemon),
    spawns: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}

/** Waits until no git process has started for `quietMs` (the daemon finished what it was doing). */
async function quietSpawns(c: Counting, quietMs = 600, maxMs = 15_000): Promise<string[]> {
  const deadline = Date.now() + maxMs;
  let seen = c.spawns().length;
  let since = Date.now();
  while (Date.now() < deadline) {
    await sleep(50);
    const now = c.spawns().length;
    if (now !== seen) {
      seen = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return c.spawns();
  }
  const last = c.spawns().slice(-6).map(spawnLabel).join(', ');
  throw new Error(`git kept spawning for ${maxMs} ms (last: ${last})`);
}

const configReads = (argv: readonly string[]) => {
  const config = argv.filter((a) => /(^| )config --null /.test(a));
  return {
    scan: config.filter((a) => a.includes('--show-scope')).length,
    remote: config.filter((a) => a.includes('remote\\.')).length,
    total: config.length,
  };
};

/** `<subcommand> <worktree dir>` of a logged argv; config reads as `config scan` / `config remote`. */
function spawnLabel(argv: string): string {
  const words = argv.split(' ');
  const workTree = words.find((w) => w.startsWith('--work-tree='))?.slice('--work-tree='.length);
  const gitDir = words.find((w) => w.startsWith('--git-dir='))?.slice('--git-dir='.length);
  let i = 0;
  while (i < words.length) {
    const w = words[i] as string;
    if (w === '-c' || w === '-C') i += 2;
    else if (w.startsWith('-')) i += 1;
    else break;
  }
  const sub = words[i] ?? '?';
  if (sub === 'config') return argv.includes('--show-scope') ? 'config scan' : 'config remote';
  return `${sub} ${path.basename(workTree ?? gitDir ?? '?')}`;
}

/** What the web app asks for when it loads with the To review default (and a worktree open). */
async function reload(s: Layout, api: Counting['api']): Promise<void> {
  await api.setFocus({ worktreeId: s.featureId, projectId: s.projectId, visible: true });
  await api.listProjects();
  await api.getForges();
  for (const scope of [REVIEW, WORKING, BRANCH_ALL]) await api.inbox({ scope });
  for (const id of [s.mainId, s.featureId, s.secondId]) {
    for (const scope of [REVIEW, BRANCH_ALL, WORKING]) await api.listFiles(id, { scope });
  }
  await api.listRepositories([s.projectId]);
}

describe.skipIf(!GIT_CORE_IMPLEMENTED)('remote layout: git spawns (#74, real git)', () => {
  it('startup reads config twice per project; a warm reload and every repeat cost 0 spawns', async () => {
    const s = await layout();
    // Register the project with a first daemon, then measure a real startup with a second one.
    const stateDir = await tempDir();
    const first = await startCounting(s.fx, stateDir);
    await first.api.addProject({ path: s.repo });
    await quietSpawns(first);
    await first.daemon.close();
    // The clones wrote their config just now: let it leave the racy window, as a user's has.
    await sleep(RACY_WAIT_MS);

    const c = await startCounting(s.fx, stateDir);
    const events = recordEvents(c.daemon);
    await events.opened;
    await eventually(async () => {
      const item = (await c.api.listProjects()).projects[0];
      expect(item?.worktrees.every((w) => w.summary !== null)).toBe(true);
      return true;
    }, 10_000);
    const startup = await quietSpawns(c);
    // One config scan for the three worktrees and one remote config read (forge service and
    // repository info share it); was one more per forge refresh and, while racy, one per worktree.
    expect(configReads(startup)).toEqual({ scan: 1, remote: 1, total: 2 });

    // The first load computes review states and labels (cold work), then nothing is left to do.
    await reload(s, c.api);
    await eventually(() => events.events.find((e) => e.type === 'review.ready'), 10_000);
    for (const id of [s.featureId, s.secondId]) {
      const item = (await c.api.listProjects()).projects[0]?.worktrees.find(
        (w) => w.worktree.id === id,
      );
      expect(item?.summary?.review).toMatchObject({
        baseFiles: 1,
        integrationRef: 'origin/main',
      });
    }
    await reload(s, c.api);
    let seen = (await quietSpawns(c)).length;
    /** Processes started since the last call, as `<subcommand> <worktree dir>`. */
    const since = async (): Promise<string[]> => {
      const all = await quietSpawns(c);
      const fresh = all.slice(seen);
      seen = all.length;
      return fresh.map(spawnLabel);
    };

    // A warm reload (the same worktree open): every route answers from what the daemon knows.
    await reload(s, c.api);
    await reload(s, c.api);
    expect(await since()).toEqual([]);

    // The tab hidden and shown again: the forge service looks at the project again (one remote
    // config read each time before #74), and focusing a worktree re-checks it with one `status`
    // (on purpose: it catches what a degraded watcher missed). Nothing else: no config, no labels.
    await c.api.setFocus({ worktreeId: null, projectId: null, visible: false });
    await reload(s, c.api);
    expect(await since()).toEqual(['status app-feature']);
    await c.api.setFocus({ worktreeId: s.secondId, projectId: s.projectId, visible: true });
    await reload(s, c.api);
    expect((await since()).sort()).toEqual(['status app-feature', 'status app-second']);

    // A forced forge refresh, a git change the forge service hears about and its polls (every
    // 300 ms here) read the remote config again only when it changed.
    await c.api.refreshForges({ projectIds: [s.projectId] });
    c.daemon.forges?.gitChanged(s.projectId);
    await sleep(1000);
    expect(await since()).toEqual([]);

    // A push -u writes the branch's upstream into the config: the next look reads it again.
    s.fx.git(s.feature, 'config', 'branch.feature.remote', 'origin');
    c.daemon.forges?.gitChanged(s.projectId);
    await sleep(100);
    expect((await since()).filter((d) => d.startsWith('config remote')).length).toBeGreaterThan(0);
  }, 60_000);

  it('a config written just before startup is still read once for the worktrees of a project', async () => {
    const s = await layout();
    const stateDir = await tempDir();
    const first = await startCounting(s.fx, stateDir);
    await first.api.addProject({ path: s.repo });
    await quietSpawns(first);
    await first.daemon.close();
    // `git remote add`, `push -u` or `git config` right before the daemon starts: the config file is
    // younger than two seconds, so no read is reused across operations (DECISIONS #191) and before
    // #74 every worktree's summary read its own.
    s.fx.git(s.repo, 'remote', 'add', 'upstream', path.join(s.fx.root, 'origin.git'));
    const c = await startCounting(s.fx, stateDir);
    await eventually(async () => {
      const item = (await c.api.listProjects()).projects[0];
      expect(item?.worktrees.every((w) => w.summary !== null)).toBe(true);
      return true;
    }, 10_000);
    const startup = configReads(await quietSpawns(c));
    expect(startup.scan).toBe(1);
  }, 60_000);
});
