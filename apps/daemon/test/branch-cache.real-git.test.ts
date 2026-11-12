/**
 * #27: the branch-scope inbox and files are cached by (stateHash, base commit). A repeat
 * `inbox?scope=branch&working=1` spawns no git process, and an edit, a commit, a default-branch
 * move and a forced refresh each invalidate exactly what they change (no stale data). Spawns are
 * counted by pointing git-core at a wrapper script that logs and then execs the real git.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DiffScope, InboxResponse } from '@octopus-diff/contracts';
import { createGitCore } from '@octopus-diff/git-core';
import { describe, expect, it } from 'vitest';
import { type Daemon, startDaemon } from '../src/daemon.js';
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

const BRANCH_ALL: DiffScope = { kind: 'branch', includeWorking: true };

interface Counting {
  daemon: Daemon;
  spawns: () => number;
  /** Number of branch-scope `listChangedFiles` calls git-core received. */
  listings: () => number;
}

async function startCounting(
  fx: RealGitFixture,
  options: { watch?: boolean } = {},
): Promise<Counting> {
  const log = path.join(await tempDir(), 'spawns.log');
  writeFileSync(log, '');
  const wrapper = path.join(path.dirname(log), 'git-wrapper.sh');
  writeFileSync(wrapper, `#!/bin/sh\necho x >> '${log}'\nexec git "$@"\n`);
  chmodSync(wrapper, 0o755);
  const core = createGitCore({ env: fx.env, gitBinary: wrapper });
  let listings = 0;
  const counted = new Proxy(core, {
    get(target, prop, receiver) {
      if (prop === 'listChangedFiles') {
        return (...args: Parameters<typeof core.listChangedFiles>) => {
          if (args[1].kind === 'branch') listings++;
          return target.listChangedFiles(...args);
        };
      }
      // The daemon lists through the variant that reports its state (Greptile on PR #95).
      if (prop === 'listChangedFilesWithState') {
        return (...args: Parameters<typeof core.listChangedFiles>) => {
          if (args[1].kind === 'branch') listings++;
          return target.listChangedFilesWithState?.(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir: await tempDir(),
    logLevel: 'silent',
    gitCore: counted,
    watch: { debounceMs: 100, enabled: options.watch ?? true },
  });
  onCleanup(() => daemon.close());
  return {
    daemon,
    spawns: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).length,
    listings: () => listings,
  };
}

interface Setup {
  fx: RealGitFixture;
  repo: string;
  feature: string;
  featureId: string;
  mainId: string;
  other: string;
}

/** `repo` (main, dirty), a linked worktree `feature` (one commit ahead, dirty), and `other`. */
async function setup(): Promise<Setup> {
  const fx = await makeRealGitFixture();
  const repo = await makeRealRepo(fx, 'repo', { 'a.txt': 'one\ntwo\n', 'b.txt': 'b\n' });
  const other = await makeRealRepo(fx, 'other', { 'o.txt': 'o\n' });
  const feature = path.join(fx.root, 'repo-feature');
  fx.git(repo, 'worktree', 'add', '-q', '-b', 'feature', feature);
  await writeFile(path.join(feature, 'f.txt'), 'f1\n');
  fx.git(feature, 'add', '-A');
  fx.git(feature, 'commit', '-q', '-m', 'feature work');
  await appendFile(path.join(feature, 'a.txt'), 'uncommitted\n');
  await appendFile(path.join(repo, 'b.txt'), 'main edit\n');
  await appendFile(path.join(other, 'o.txt'), 'other edit\n');
  return { fx, repo, feature, other, featureId: hashId(feature), mainId: hashId(repo) };
}

/** The next `worktree.changed` for a worktree after `mark` events (not one already seen). */
function changedAfter(events: ReturnType<typeof recordEvents>, mark: number, worktreeId: string) {
  return eventually(
    () =>
      events.events
        .slice(mark)
        .find((e) => e.type === 'worktree.changed' && e.worktreeId === worktreeId),
    5000,
  );
}

const entryOf = (inbox: InboxResponse, worktreeId: string) =>
  inbox.entries.find((e) => e.worktree.id === worktreeId);
const pathsOf = (inbox: InboxResponse, worktreeId: string) =>
  (entryOf(inbox, worktreeId)?.files ?? []).map((f) => f.path).sort();

describe('branch-scope inbox cache (#27)', () => {
  it('a repeat inbox?scope=branch&working=1 costs no git spawns and is fast', async () => {
    const s = await setup();
    const { daemon, spawns } = await startCounting(s.fx);
    const api = client(daemon);
    await api.addProject({ path: s.repo });
    await api.addProject({ path: s.other });
    await sleep(300); // the add's own refreshes settle

    const first = await api.inbox({ scope: BRANCH_ALL });
    expect(pathsOf(first, s.featureId)).toEqual(['a.txt', 'f.txt']);
    expect(spawns()).toBeGreaterThan(0);

    const before = spawns();
    const timings: number[] = [];
    let again: InboxResponse = first;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      again = await api.inbox({ scope: BRANCH_ALL });
      timings.push(performance.now() - t0);
    }
    expect(spawns()).toBe(before);
    expect(pathsOf(again, s.featureId)).toEqual(['a.txt', 'f.txt']);
    expect(Math.min(...timings)).toBeLessThan(60);

    // The same through /files, and with the explicit-base form of the scope.
    await api.listFiles(s.featureId, { scope: BRANCH_ALL });
    await api.listFiles(s.featureId, { scope: BRANCH_ALL });
    expect(spawns()).toBe(before);
  });

  it('an edit invalidates the edited worktree only (and then caches again)', async () => {
    const s = await setup();
    const { daemon, spawns, listings } = await startCounting(s.fx);
    const api = client(daemon);
    const events = recordEvents(daemon);
    await events.opened;
    await api.addProject({ path: s.repo });
    await api.addProject({ path: s.other });
    await sleep(300);
    const first = await api.inbox({ scope: BRANCH_ALL });
    const sizeBefore = entryOf(first, s.featureId)?.files.find((f) => f.path === 'a.txt');

    const listedBefore = listings();
    const mark = events.events.length;
    await appendFile(path.join(s.feature, 'a.txt'), 'another line\n');
    await changedAfter(events, mark, s.featureId);
    const after = await api.inbox({ scope: BRANCH_ALL });
    const edited = entryOf(after, s.featureId)?.files.find((f) => f.path === 'a.txt');
    expect(edited?.additions).toBe((sizeBefore?.additions ?? 0) + 1);
    expect(edited?.patchHash).not.toBe(sizeBefore?.patchHash);
    // Exactly one worktree was listed again; the other three came from the cache.
    expect(listings() - listedBefore).toBe(1);

    await sleep(300);
    const settled = spawns();
    await api.inbox({ scope: BRANCH_ALL });
    expect(spawns()).toBe(settled);
  });

  it('a commit invalidates: HEAD moved, the file list follows the committed state', async () => {
    const s = await setup();
    const { daemon, spawns } = await startCounting(s.fx);
    const api = client(daemon);
    const events = recordEvents(daemon);
    await events.opened;
    await api.addProject({ path: s.repo });
    await sleep(300);
    const first = await api.inbox({ scope: BRANCH_ALL });
    expect(pathsOf(first, s.featureId)).toEqual(['a.txt', 'f.txt']);
    const headBefore = entryOf(first, s.featureId)?.worktree.headSha;

    // Commit the uncommitted edit and add a new committed file: the diff against the merge base
    // gains `g.txt`; `a.txt` is now committed rather than modified in the working tree.
    const mark = events.events.length;
    await writeFile(path.join(s.feature, 'g.txt'), 'g\n');
    fxCommit(s);
    await changedAfter(events, mark, s.featureId);
    await sleep(300); // the summary refresh that follows the event settles
    const after = await api.inbox({ scope: BRANCH_ALL });
    expect(entryOf(after, s.featureId)?.worktree.headSha).not.toBe(headBefore);
    expect(pathsOf(after, s.featureId)).toEqual(['a.txt', 'f.txt', 'g.txt']);
    const settled = spawns();
    await api.inbox({ scope: BRANCH_ALL });
    expect(spawns()).toBe(settled);
  });

  it('an edit to .git/info/attributes invalidates (it changes how committed files are diffed)', async () => {
    const s = await setup();
    const { daemon } = await startCounting(s.fx, { watch: false });
    const api = client(daemon);
    await api.addProject({ path: s.repo });
    // `feature` has a clean tree after this commit: only committed changes are in its branch diff.
    s.fx.git(s.feature, 'add', '-A');
    s.fx.git(s.feature, 'commit', '-q', '-m', 'commit the edit');
    const first = await api.inbox({ scope: BRANCH_ALL });
    const before = entryOf(first, s.featureId)?.files.find((f) => f.path === 'a.txt');
    expect(before?.additions).toBeGreaterThan(0);
    expect(before?.binary).toBeFalsy();

    // Same HEAD, same index, same files: only the attributes source changed.
    await appendFile(path.join(s.repo, '.git', 'info', 'attributes'), 'a.txt -diff\n');
    const after = await api.inbox({ scope: BRANCH_ALL });
    const marked = entryOf(after, s.featureId)?.files.find((f) => f.path === 'a.txt');
    expect(marked?.binary).toBe(true);
    expect(marked?.patchHash).not.toBe(before?.patchHash);
  });

  it('a default-branch move invalidates, even before the watcher has noticed it', async () => {
    const s = await setup();
    // Watcher off: the summaries stay as they were, only the base ref changes.
    const { daemon, listings } = await startCounting(s.fx, { watch: false });
    const api = client(daemon);
    await api.addProject({ path: s.repo });
    const first = await api.inbox({ scope: BRANCH_ALL });
    expect(pathsOf(first, s.featureId)).toEqual(['a.txt', 'f.txt']);

    // main fast-forwards to feature's commit (as after merging it): `f.txt` is no longer "on the
    // branch" because the merge base is now feature's own HEAD.
    const featureHead = s.fx.git(s.feature, 'rev-parse', 'HEAD').trim();
    s.fx.git(s.repo, 'update-ref', 'refs/heads/main', featureHead);
    const listed = listings();
    const after = await api.inbox({ scope: BRANCH_ALL });
    expect(pathsOf(after, s.featureId)).toEqual(['a.txt']);
    expect(listings()).toBeGreaterThan(listed);
  });

  it('a move of the remote-tracking ref invalidates too (#30: the base follows both refs)', async () => {
    const s = await setup();
    // Watcher off: the summaries stay as they were; only a ref file changes, as `git fetch` does.
    const { daemon, listings } = await startCounting(s.fx, { watch: false });
    const mainHead = s.fx.git(s.repo, 'rev-parse', 'main').trim();
    s.fx.git(s.repo, 'update-ref', 'refs/remotes/origin/main', mainHead);
    const api = client(daemon);
    await api.addProject({ path: s.repo });
    const first = await api.inbox({ scope: BRANCH_ALL });
    expect(pathsOf(first, s.featureId)).toEqual(['a.txt', 'f.txt']);
    const listed = listings();
    await api.inbox({ scope: BRANCH_ALL });
    expect(listings()).toBe(listed); // cached: nothing moved

    // origin/main advances to the commit the feature branch is at (a fetch after someone else
    // merged it): local `main` is untouched, but the newest default-branch commit the feature
    // has absorbed is now its own HEAD, so `f.txt` is no longer "on the branch".
    const featureHead = s.fx.git(s.feature, 'rev-parse', 'HEAD').trim();
    s.fx.git(s.repo, 'update-ref', 'refs/remotes/origin/main', featureHead);
    const after = await api.inbox({ scope: BRANCH_ALL });
    expect(pathsOf(after, s.featureId)).toEqual(['a.txt']);
    expect(listings()).toBeGreaterThan(listed);
  });

  it("stale local main: origin/main-only files are not the branch's own change (#30)", async () => {
    const s = await setup();
    const { daemon } = await startCounting(s.fx, { watch: false });
    // Someone else's commit lands on origin/main; the feature branch merges it; local main stays.
    const scratch = path.join(s.fx.root, 'repo-theirs');
    s.fx.git(s.repo, 'worktree', 'add', '-q', '-b', 'theirs', scratch, 'main');
    await writeFile(path.join(scratch, 'theirs.txt'), 'theirs\n');
    s.fx.git(scratch, 'add', '-A');
    s.fx.git(scratch, 'commit', '-q', '-m', 'theirs');
    s.fx.git(s.repo, 'update-ref', 'refs/remotes/origin/main', 'theirs');
    s.fx.git(s.repo, 'worktree', 'remove', '--force', scratch);
    s.fx.git(s.repo, 'branch', '-D', 'theirs');
    s.fx.git(s.feature, 'merge', '-q', '--no-edit', 'origin/main');
    const api = client(daemon);
    await api.addProject({ path: s.repo });
    const all = await api.inbox({ scope: BRANCH_ALL });
    expect(pathsOf(all, s.featureId)).toEqual(['a.txt', 'f.txt']);
    const committed = await api.inbox({ scope: { kind: 'branch' } });
    expect(pathsOf(committed, s.featureId)).toEqual(['f.txt']);
  });

  it('a default-branch move announces worktree.changed (the UI refetches)', async () => {
    const s = await setup();
    const { daemon } = await startCounting(s.fx);
    const api = client(daemon);
    const events = recordEvents(daemon);
    await events.opened;
    await api.addProject({ path: s.repo });
    await sleep(300);
    const before = (await api.listProjects()).projects
      .flatMap((p) => p.worktrees)
      .find((w) => w.worktree.id === s.featureId)?.summary?.stateHash;
    const mark = events.events.length;
    const featureHead = s.fx.git(s.feature, 'rev-parse', 'HEAD').trim();
    s.fx.git(s.repo, 'update-ref', 'refs/heads/main', featureHead);
    const changed = await eventually(
      () =>
        events.events
          .slice(mark)
          .find((e) => e.type === 'worktree.changed' && e.worktreeId === s.featureId),
      5000,
    );
    expect(changed).toMatchObject({ type: 'worktree.changed' });
    if (changed.type === 'worktree.changed') expect(changed.stateHash).not.toBe(before);
    const inbox = await api.inbox({ scope: BRANCH_ALL });
    expect(pathsOf(inbox, s.featureId)).toEqual(['a.txt']);
  });

  it('a forced refresh drops the cached lists', async () => {
    const s = await setup();
    const { daemon, listings, spawns } = await startCounting(s.fx, { watch: false });
    const api = client(daemon);
    await api.addProject({ path: s.repo });
    await api.inbox({ scope: BRANCH_ALL });
    const settled = spawns();
    await api.inbox({ scope: BRANCH_ALL });
    expect(spawns()).toBe(settled);

    const listed = listings();
    await api.refreshWorktree(s.featureId);
    await api.inbox({ scope: BRANCH_ALL });
    expect(listings()).toBe(listed + 1);
  });

  it('identical concurrent inbox requests share one run (single-flight)', async () => {
    const s = await setup();
    const { daemon, listings } = await startCounting(s.fx, { watch: false });
    const api = client(daemon);
    await api.addProject({ path: s.repo });
    await api.addProject({ path: s.other });
    const before = listings();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => api.inbox({ scope: BRANCH_ALL })),
    );
    // Three dirty worktrees, listed once each, not once per request.
    expect(listings() - before).toBe(3);
    for (const r of results) expect(r.entries.length).toBe(3);

    // A different scope is a different run.
    const working = await api.inbox({ scope: { kind: 'working' } });
    expect(working.entries.length).toBe(3);
  });
});

function fxCommit(s: Setup): void {
  s.fx.git(s.feature, 'add', '-A');
  s.fx.git(s.feature, 'commit', '-q', '-m', 'second');
}
