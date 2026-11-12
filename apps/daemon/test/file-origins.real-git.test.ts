/**
 * #33: the daemon attaches file origins (merge noise) to the To review, All on branch and
 * Uncommitted lists, fills the review summary's own/base counts, keeps default-branch commits out
 * of `newCommits` and out of what a bookmark move records, and never marks base files in bulk.
 * Real git in temp fixtures with isolated config; spawns are counted through a wrapper script and
 * `readFileOrigins` calls through a proxy around git-core.
 */
import { chmodSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ChangedFile,
  DiffScope,
  InboxResponse,
  WorktreeReview,
} from '@octopus-diff/contracts';
import { createGitCore, GIT_CORE_IMPLEMENTED } from '@octopus-diff/git-core';
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

const REVIEW: DiffScope = { kind: 'review' };
const BRANCH_ALL: DiffScope = { kind: 'branch', includeWorking: true };
const WORKING: DiffScope = { kind: 'working' };

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const SHARED = lines(20);

interface Counting {
  daemon: Daemon;
  api: ReturnType<typeof client>;
  /** Git processes started so far. */
  spawns: () => number;
  /** `readFileOrigins` calls so far, and the most that ran at once. */
  originCalls: () => number;
  peakOrigins: () => number;
  /** While `on`, `readFileOrigins` takes a moment and then fails. */
  failing: { on: boolean };
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
  let calls = 0;
  let active = 0;
  let peak = 0;
  const failing = { on: false };
  const counted = new Proxy(core, {
    get(target, prop, receiver) {
      if (prop === 'readFileOrigins') {
        return async (...args: Parameters<NonNullable<typeof core.readFileOrigins>>) => {
          calls++;
          active++;
          peak = Math.max(peak, active);
          try {
            if (failing.on) {
              await sleep(250);
              throw new Error('origins unavailable (test)');
            }
            return await target.readFileOrigins?.(...args);
          } finally {
            active--;
          }
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
    logLevel: process.env.OCTOPUS_DIFF_TEST_LOGS ? 'debug' : 'silent',
    gitCore: counted,
    watch: { debounceMs: 100, enabled: options.watch ?? true },
  });
  onCleanup(() => daemon.close());
  return {
    daemon,
    api: client(daemon),
    spawns: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).length,
    originCalls: () => calls,
    peakOrigins: () => peak,
    failing,
  };
}

function commit(
  fx: RealGitFixture,
  dir: string,
  files: Record<string, string>,
  message = 'change',
) {
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(dir, file), content);
  fx.git(dir, 'add', '-A');
  fx.git(dir, 'commit', '-q', '-m', message);
  return head(fx, dir);
}

const head = (fx: RealGitFixture, dir: string) => fx.git(dir, 'rev-parse', 'HEAD').trim();

interface Local {
  fx: RealGitFixture;
  repo: string;
  feature: string;
  projectId: string;
  mainId: string;
  featureId: string;
}

/** `app` on `main` (no remote: the local branch is the default branch) and a `feature` worktree. */
async function local(): Promise<Local> {
  const fx = await makeRealGitFixture();
  const repo = await makeRealRepo(fx, 'app', { 'base.txt': 'base\n', 'shared.txt': SHARED });
  const feature = path.join(fx.root, 'app-feature');
  fx.git(repo, 'worktree', 'add', '-q', '-b', 'feature', feature);
  return {
    fx,
    repo,
    feature,
    projectId: hashId(realpathSync(path.join(repo, '.git'))),
    mainId: hashId(repo),
    featureId: hashId(feature),
  };
}

/**
 * Waits until the daemon has started no git process for `quietMs` (at most `maxMs`): the refreshes
 * that the test's own setup caused (watcher events, `review.ready`) are over, so a count taken now
 * and compared after a repeat only sees what the repeat costs. A fixed sleep guessed that and
 * flaked under CPU load (#71: `expected 90 to be 89`).
 */
async function quietSpawns(c: Counting, quietMs = 600, maxMs = 15_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  let last = c.spawns();
  let since = Date.now();
  while (Date.now() < deadline) {
    await sleep(100);
    const now = c.spawns();
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return;
  }
}

type Api = Counting['api'];

async function review(api: Api, worktreeId: string): Promise<WorktreeReview> {
  const { summary } = await api.refreshWorktree(worktreeId);
  if (!summary.review) throw new Error('no review state');
  return summary.review;
}

/**
 * Adds the project and computes both review states right away, so both bookmarks start where the
 * feature branched (first sight), not wherever the watcher happens to compute them later.
 */
async function opened(api: Api, s: Local): Promise<void> {
  await api.addProject({ path: s.repo });
  await review(api, s.mainId);
  await review(api, s.featureId);
}

/** `{ path: 'own' | 'base:merge' | ... }` of a file list. */
function labels(files: readonly ChangedFile[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    out[f.path] = f.origin ? `${f.origin}${f.originVia ? `:${f.originVia}` : ''}` : 'own';
  }
  return out;
}

const inboxFiles = (inbox: InboxResponse, worktreeId: string) =>
  inbox.entries.find((e) => e.worktree.id === worktreeId)?.files ?? [];

/** /files, /inbox and the review summary agree on the To review list (and return its labels). */
async function agreeing(api: Api, worktreeId: string): Promise<Record<string, string>> {
  const r = await review(api, worktreeId);
  const files = (await api.listFiles(worktreeId, { scope: REVIEW })).files;
  const inbox = await api.inbox({ scope: REVIEW });
  expect(labels(inboxFiles(inbox, worktreeId))).toEqual(labels(files));
  expect(r.baseFiles).toBe(files.filter((f) => f.origin === 'base').length);
  expect(r.unreviewedOwnFiles).toBe(files.filter((f) => !f.reviewed && f.origin !== 'base').length);
  expect(r.unreviewedFiles).toBe(files.filter((f) => !f.reviewed).length);
  return labels(files);
}

describe.skipIf(!GIT_CORE_IMPLEMENTED)('file origins in the daemon (#33, real git)', () => {
  it('overlapping /files and /inbox requests all get the plain files when the origin read fails (PR #66 review)', async () => {
    const s = await local();
    const { api, failing } = await startCounting(s.fx);
    await opened(api, s);
    commit(s.fx, s.feature, { 'own.txt': 'own\n' });
    commit(s.fx, s.repo, { 'theirs.txt': 't\n' });
    s.fx.git(s.feature, 'merge', '-q', '--no-edit', 'main');
    await review(api, s.featureId);

    failing.on = true;
    // Both ask for the same list while the (failing) origin read is still running.
    const [files, inbox] = await Promise.all([
      api.listFiles(s.featureId, { scope: BRANCH_ALL }),
      api.inbox({ scope: BRANCH_ALL }),
    ]);
    // The failure costs the labels, nothing else: the list is there for both, all own.
    expect(files.files.map((f) => f.path)).toContain('own.txt');
    expect(inboxFiles(inbox, s.featureId).map((f) => f.path)).toContain('own.txt');
    expect(Object.values(labels(files.files)).every((l) => l === 'own')).toBe(true);
  });

  it('merging main in leaves the To review count unchanged; main files are base (merge)', async () => {
    const s = await local();
    const { api } = await startCounting(s.fx);
    await opened(api, s);
    commit(s.fx, s.feature, { 'own.txt': 'own\n' });
    const before = await review(api, s.featureId);
    expect(before).toMatchObject({
      newCommits: 1,
      unreviewedFiles: 1,
      unreviewedOwnFiles: 1,
      baseFiles: 0,
    });

    commit(s.fx, s.repo, { 'theirs.txt': 't\n' });
    commit(s.fx, s.repo, { 'theirs2.txt': 't\n' }, 'main again');
    s.fx.git(s.feature, 'merge', '-q', '--no-edit', 'main');

    // Own work only: the two main commits and the clean merge commit do not count.
    expect(await review(api, s.featureId)).toMatchObject({
      newCommits: 1,
      unreviewedOwnFiles: 1,
      baseFiles: 2,
      unreviewedFiles: 3,
      integrationRef: 'main',
    });
    expect(await agreeing(api, s.featureId)).toEqual({
      'own.txt': 'own',
      'theirs.txt': 'base:merge',
      'theirs2.txt': 'base:merge',
    });
    // All on branch is measured from N: main's files are not in it.
    const branch = await api.listFiles(s.featureId, { scope: BRANCH_ALL });
    expect(labels(branch.files)).toEqual({ 'own.txt': 'own' });
    expect(labels(inboxFiles(await api.inbox({ scope: BRANCH_ALL }), s.featureId))).toEqual(
      labels(branch.files),
    );
  });

  it('a file both sides changed is mixed and counts as own work', async () => {
    const s = await local();
    const { api } = await startCounting(s.fx);
    await opened(api, s);
    commit(s.fx, s.feature, { 'own.txt': 'own\n', 'shared.txt': SHARED.replace('line 2', 'own') });
    expect(await review(api, s.featureId)).toMatchObject({ newCommits: 1, unreviewedOwnFiles: 2 });
    commit(s.fx, s.repo, {
      'theirs.txt': 't\n',
      'shared.txt': SHARED.replace('line 18', 'theirs'),
    });
    s.fx.git(s.feature, 'merge', '-q', '--no-edit', 'main');
    // The file count is unchanged (mixed is own). The merge commit itself counts once: it changed
    // shared.txt against both parents, and its `--cc` name list cannot tell an automatic merge of
    // both sides from a resolution by hand (DECISIONS #203).
    expect(await review(api, s.featureId)).toMatchObject({
      newCommits: 2,
      unreviewedOwnFiles: 2,
      baseFiles: 1,
      unreviewedFiles: 3,
    });
    expect(await agreeing(api, s.featureId)).toEqual({
      'own.txt': 'own',
      'shared.txt': 'mixed:merge',
      'theirs.txt': 'base:merge',
    });
    // Measured from N (All on branch) the mixed file shows this branch's own patch: own.
    const branch = await api.listFiles(s.featureId, { scope: BRANCH_ALL });
    expect(labels(branch.files)).toEqual({ 'own.txt': 'own', 'shared.txt': 'own' });
  });

  it('rebase onto main: main files are base (rebase); the count is unchanged', async () => {
    const s = await local();
    const { api } = await startCounting(s.fx);
    await opened(api, s);
    commit(s.fx, s.feature, { 'own.txt': 'own\n' });
    expect(await review(api, s.featureId)).toMatchObject({ newCommits: 1, unreviewedOwnFiles: 1 });
    commit(s.fx, s.repo, { 'theirs.txt': 't\n' });
    s.fx.git(s.feature, 'rebase', '-q', 'main');
    // The bookmark (where feature started) is still an ancestor: the range holds main's commit.
    expect(await review(api, s.featureId)).toMatchObject({
      historyRewritten: false,
      newCommits: 1,
      unreviewedOwnFiles: 1,
      baseFiles: 1,
    });
    expect(await agreeing(api, s.featureId)).toEqual({
      'own.txt': 'own',
      'theirs.txt': 'base:rebase',
    });
  });

  it('Review all marks own and mixed files only, moves the bookmark, and main keeps its commit to review', async () => {
    const s = await local();
    const { api } = await startCounting(s.fx);
    await opened(api, s);
    expect(await review(api, s.mainId)).toMatchObject({ newCommits: 0 });
    commit(s.fx, s.feature, { 'own.txt': 'own\n', 'shared.txt': SHARED.replace('line 2', 'own') });
    commit(s.fx, s.repo, {
      'theirs.txt': 't\n',
      'shared.txt': SHARED.replace('line 18', 'theirs'),
    });
    expect(await review(api, s.mainId)).toMatchObject({ newCommits: 1, unreviewedFiles: 2 });
    s.fx.git(s.feature, 'merge', '-q', '--no-edit', 'main');
    const stateHash = (await api.refreshWorktree(s.featureId)).summary.stateHash;
    await review(api, s.featureId);

    const res = await api.bulkReview({
      target: { kind: 'worktree', worktreeId: s.featureId },
      scope: REVIEW,
      advanceBookmarks: true,
      expectedStateHashes: { [s.featureId]: stateHash },
    });
    // own.txt and the mixed shared.txt; theirs.txt (base) is not marked.
    expect(res).toMatchObject({ changed: 2, bookmarks: 1, stale: [] });
    expect(await review(api, s.featureId)).toMatchObject({
      bookmark: head(s.fx, s.feature),
      newCommits: 0,
      unreviewedFiles: 0,
      unreviewedOwnFiles: 0,
      baseFiles: 0,
    });
    expect((await api.listFiles(s.featureId, { scope: REVIEW })).files).toEqual([]);
    // The main worktree did not inherit main's commit from the feature review.
    expect(await review(api, s.mainId)).toMatchObject({ newCommits: 1, unreviewedFiles: 2 });
    const mainFiles = (await api.listFiles(s.mainId, { scope: REVIEW })).files;
    expect(mainFiles.map((f) => [f.path, f.reviewed, f.origin])).toEqual([
      ['shared.txt', false, undefined],
      ['theirs.txt', false, undefined],
    ]);

    // Undo restores the bookmark and the marks.
    if (!res.undoToken) throw new Error('undo token');
    await api.undoReview({ undoToken: res.undoToken });
    // F and the merge commit (it merged shared.txt from both sides, see the mixed-file test).
    expect(await review(api, s.featureId)).toMatchObject({ newCommits: 2, unreviewedOwnFiles: 2 });
  });

  it('bulk by project, and by paths naming a base file: base files are never marked', async () => {
    const s = await local();
    const { api } = await startCounting(s.fx);
    await opened(api, s);
    commit(s.fx, s.feature, { 'own.txt': 'own\n' });
    commit(s.fx, s.repo, { 'theirs.txt': 't\n' });
    s.fx.git(s.feature, 'merge', '-q', '--no-edit', 'main');
    await review(api, s.featureId);

    const byPaths = await api.bulkReview({
      target: { kind: 'worktree', worktreeId: s.featureId },
      scope: REVIEW,
      paths: [{ path: 'theirs.txt' }, { path: 'own.txt' }],
    });
    expect(byPaths).toMatchObject({ changed: 1, worktrees: 1 });
    const files = (await api.listFiles(s.featureId, { scope: REVIEW })).files;
    expect(files.map((f) => [f.path, f.reviewed, f.origin])).toEqual([
      ['own.txt', true, undefined],
      ['theirs.txt', false, 'base'],
    ]);
    if (byPaths.undoToken) await api.undoReview({ undoToken: byPaths.undoToken });

    // The project: main's own file (own there) and feature's own file; feature's copy of
    // theirs.txt is the same patch as main's, so it is marked through main, not through feature.
    await review(api, s.mainId);
    const byProject = await api.bulkReview({
      target: { kind: 'project', projectId: s.projectId },
      scope: REVIEW,
      advanceBookmarks: true,
    });
    expect(byProject).toMatchObject({ bookmarks: 2 });
    expect(await review(api, s.featureId)).toMatchObject({ newCommits: 0, unreviewedFiles: 0 });
    expect(await review(api, s.mainId)).toMatchObject({ newCommits: 0, unreviewedFiles: 0 });
  });

  it('a PUT bookmark to HEAD records the branch commits, not the default-branch ones', async () => {
    const s = await local();
    const { api } = await startCounting(s.fx);
    await opened(api, s);
    commit(s.fx, s.feature, { 'own.txt': 'own\n' });
    commit(s.fx, s.repo, { 'theirs.txt': 't\n' });
    commit(s.fx, s.repo, { 'theirs2.txt': 't\n' });
    s.fx.git(s.feature, 'merge', '-q', '--no-edit', 'main');
    await review(api, s.featureId);
    const put = await api.setBookmark({ worktreeId: s.featureId, to: head(s.fx, s.feature) });
    // The own commit, the merge commit and the own part's range patch-id (N..HEAD).
    expect(put.recorded).toBe(3);
    expect(await review(api, s.mainId)).toMatchObject({ newCommits: 2, unreviewedFiles: 2 });
  });

  it('labels in progress: a merge of main stopped on a conflict, in every scope that has origins', async () => {
    const s = await local();
    const { api } = await startCounting(s.fx);
    await opened(api, s);
    commit(s.fx, s.feature, { 'own.txt': 'own\n', 'conflict.txt': 'own\n' });
    commit(s.fx, s.repo, { 'theirs.txt': 't\n', 'conflict.txt': 'main\n' });
    try {
      s.fx.git(s.feature, 'merge', '-q', '--no-edit', 'main');
    } catch {
      // conflict expected
    }
    const r = await review(api, s.featureId);
    expect(r).toMatchObject({ baseFiles: 1, newCommits: 1 });
    expect(await agreeing(api, s.featureId)).toEqual({
      'conflict.txt': 'own',
      'own.txt': 'own',
      'theirs.txt': 'base:in-progress',
    });
    const working = await api.listFiles(s.featureId, { scope: WORKING });
    expect(labels(working.files)).toEqual({
      'conflict.txt': 'own',
      'theirs.txt': 'base:in-progress',
    });
    const branch = await api.listFiles(s.featureId, { scope: BRANCH_ALL });
    expect(labels(branch.files)).toMatchObject({ 'theirs.txt': 'base:in-progress' });
  });

  it('a cherry-pick of a newer main commit is "same as main" in To review and All on branch', async () => {
    const s = await local();
    const { api } = await startCounting(s.fx);
    await opened(api, s);
    commit(s.fx, s.feature, { 'own.txt': 'own\n' });
    const picked = commit(s.fx, s.repo, { 'picked.txt': 'p\n' });
    s.fx.git(s.feature, 'cherry-pick', picked);
    expect(await agreeing(api, s.featureId)).toEqual({
      'own.txt': 'own',
      'picked.txt': 'base:same-as-base',
    });
    const branch = await api.listFiles(s.featureId, { scope: BRANCH_ALL });
    expect(labels(branch.files)).toEqual({ 'own.txt': 'own', 'picked.txt': 'base:same-as-base' });
  });
});

describe.skipIf(!GIT_CORE_IMPLEMENTED)(
  'file origins: remote default branch and costs (#33, real git)',
  () => {
    interface Remote extends Local {
      other: string;
    }

    /** A bare `origin`, a clone `app` (main) with a `feature` worktree, and `other` that pushes. */
    async function remote(): Promise<Remote> {
      const fx = await makeRealGitFixture();
      const seed = await makeRealRepo(fx, 'seed', { 'base.txt': 'base\n', 'shared.txt': SHARED });
      const origin = path.join(fx.root, 'origin.git');
      fx.git(fx.root, 'clone', '-q', '--bare', seed, origin);
      const repo = path.join(fx.root, 'app');
      const other = path.join(fx.root, 'other');
      fx.git(fx.root, 'clone', '-q', origin, repo);
      fx.git(fx.root, 'clone', '-q', origin, other);
      const feature = path.join(fx.root, 'app-feature');
      fx.git(repo, 'worktree', 'add', '-q', '-b', 'feature', feature);
      return {
        fx,
        repo,
        other,
        feature,
        projectId: hashId(realpathSync(path.join(repo, '.git'))),
        mainId: hashId(repo),
        featureId: hashId(feature),
      };
    }

    function push(s: Remote, files: Record<string, string>): string {
      s.fx.git(s.other, 'pull', '-q', '--ff-only');
      const sha = commit(s.fx, s.other, files, 'upstream');
      s.fx.git(s.other, 'push', '-q', 'origin', 'main');
      return sha;
    }

    it('a fetch that moves origin/main relabels (no stale labels), and merging it labels origin/main', async () => {
      const s = await remote();
      const { daemon, api } = await startCounting(s.fx);
      const events = recordEvents(daemon);
      await events.opened;
      await api.addProject({ path: s.repo });
      commit(s.fx, s.feature, { 'fix.txt': 'fixed\n', 'own.txt': 'own\n' });
      expect(await agreeing(api, s.featureId)).toEqual({ 'fix.txt': 'own', 'own.txt': 'own' });
      // Local main and origin/main are the same commit: the label is the remote's.
      expect((await review(api, s.featureId)).integrationRef).toBe('origin/main');

      // The same fix lands on origin/main; a fetch moves only the remote-tracking ref.
      push(s, { 'fix.txt': 'fixed\n' });
      const mark = events.events.length;
      s.fx.git(s.repo, 'fetch', '-q', 'origin');
      // /files reads the default branch's refs on every call: relabeled before the watcher reacts.
      const files = (await api.listFiles(s.featureId, { scope: REVIEW })).files;
      expect(labels(files)).toEqual({ 'fix.txt': 'base:same-as-base', 'own.txt': 'own' });
      await eventually(
        () =>
          events.events
            .slice(mark)
            .find((e) => e.type === 'worktree.changed' && e.worktreeId === s.featureId),
        5000,
      );
      expect(await review(api, s.featureId)).toMatchObject({
        baseFiles: 1,
        unreviewedOwnFiles: 1,
        integrationRef: 'origin/main',
      });
      expect(await agreeing(api, s.featureId)).toEqual({
        'fix.txt': 'base:same-as-base',
        'own.txt': 'own',
      });

      // Merging origin/main with a stale local main: its files are base, labelled origin/main.
      push(s, { 'theirs.txt': 't\n' });
      s.fx.git(s.repo, 'fetch', '-q', 'origin');
      s.fx.git(s.feature, 'merge', '-q', '--no-edit', 'origin/main');
      expect(await review(api, s.featureId)).toMatchObject({
        newCommits: 1,
        unreviewedOwnFiles: 1,
        integrationRef: 'origin/main',
      });
      expect(await agreeing(api, s.featureId)).toEqual({
        'fix.txt': 'base:merge',
        'own.txt': 'own',
        'theirs.txt': 'base:merge',
      });
    });

    it('watcher off: the labels follow a fetch on the next request (the default-branch commits are in the key)', async () => {
      const s = await remote();
      const { api } = await startCounting(s.fx, { watch: false });
      await api.addProject({ path: s.repo });
      commit(s.fx, s.feature, { 'fix.txt': 'fixed\n', 'own.txt': 'own\n' });
      await review(api, s.featureId);
      for (const scope of [REVIEW, BRANCH_ALL]) {
        expect(labels((await api.listFiles(s.featureId, { scope })).files)).toEqual({
          'fix.txt': 'own',
          'own.txt': 'own',
        });
      }
      push(s, { 'fix.txt': 'fixed\n' });
      s.fx.git(s.repo, 'fetch', '-q', 'origin');
      // No summary refresh happened (no watcher): only the fresh default-branch refs can tell.
      for (const scope of [REVIEW, BRANCH_ALL]) {
        const files = (await api.listFiles(s.featureId, { scope })).files;
        expect(labels(files)).toEqual({ 'fix.txt': 'base:same-as-base', 'own.txt': 'own' });
        const inbox = await api.inbox({ scope });
        expect(labels(inboxFiles(inbox, s.featureId))).toEqual(labels(files));
      }
    });

    it('costs: nothing at startup, a repeat is 0 spawns and 0 calls, a fetch fan-out stays bounded', async () => {
      const s = await remote();
      const extra: string[] = [];
      for (const name of ['two', 'three', 'four']) {
        const dir = path.join(s.fx.root, `app-${name}`);
        s.fx.git(s.repo, 'worktree', 'add', '-q', '-b', name, dir);
        extra.push(dir);
      }
      for (const dir of [s.feature, ...extra]) {
        commit(s.fx, dir, { [`${path.basename(dir)}.txt`]: 'own\n' });
        await writeFile(path.join(dir, 'dirty.txt'), 'dirty\n');
      }
      push(s, { 'theirs.txt': 't\n' });
      s.fx.git(s.repo, 'fetch', '-q', 'origin');
      for (const dir of [s.feature, ...extra])
        s.fx.git(dir, 'merge', '-q', '--no-edit', 'origin/main');

      const c = await startCounting(s.fx);
      await c.api.addProject({ path: s.repo });
      await c.api.listProjects();
      await sleep(300);
      // Startup and first paint: summaries only (#10); no project opened, no origins.
      expect(c.originCalls()).toBe(0);

      // Open the project: review states (with origins) compute in the background.
      const events = recordEvents(c.daemon);
      await events.opened;
      await c.api.setFocus({ worktreeId: null, projectId: s.projectId });
      await eventually(() => events.events.find((e) => e.type === 'review.ready'), 5000);
      await c.api.listProjects();
      for (const id of [s.featureId, ...extra.map(hashId)]) {
        const item = (await c.api.listProjects()).projects[0]?.worktrees.find(
          (w) => w.worktree.id === id,
        );
        expect(item?.summary?.review).toMatchObject({
          newCommits: 1,
          baseFiles: 1,
          unreviewedOwnFiles: 2,
        });
      }
      // The three routes, every origin-carrying scope, once.
      for (const scope of [REVIEW, BRANCH_ALL, WORKING]) {
        await c.api.inbox({ scope });
        for (const id of [s.featureId, ...extra.map(hashId)]) await c.api.listFiles(id, { scope });
      }
      await quietSpawns(c);
      // One more pass before counting. The config scan git-core reuses is not stored while a config
      // file is younger than 2 s (the racy guard, DECISIONS #191), and this fixture wrote config a
      // moment ago (`worktree add`, merges): the first call after that window costs one more `config`
      // read, once. That is the scan's business, not the origins' (#71: `expected 90 to be 89`).
      for (const scope of [REVIEW, BRANCH_ALL, WORKING]) {
        await c.api.inbox({ scope });
        for (const id of [s.featureId, ...extra.map(hashId)]) await c.api.listFiles(id, { scope });
      }
      await quietSpawns(c);
      const spawns = c.spawns();
      const calls = c.originCalls();
      for (const scope of [REVIEW, BRANCH_ALL, WORKING]) {
        await c.api.inbox({ scope });
        for (const id of [s.featureId, ...extra.map(hashId)]) await c.api.listFiles(id, { scope });
      }
      await c.api.listProjects();
      expect(c.spawns()).toBe(spawns);
      expect(c.originCalls()).toBe(calls);

      // A fetch that moves origin/main relabels every worktree of the project: bounded fan-out.
      push(s, { 'theirs2.txt': 't\n' });
      const mark = events.events.length;
      s.fx.git(s.repo, 'fetch', '-q', 'origin');
      await eventually(
        () =>
          [s.featureId, ...extra.map(hashId)].every((id) =>
            events.events
              .slice(mark)
              .some((e) => e.type === 'worktree.changed' && e.worktreeId === id),
          ),
        10_000,
      );
      expect(c.originCalls()).toBeGreaterThan(calls);
      expect(c.peakOrigins()).toBeLessThanOrEqual(2);
    });

    it('an operation in progress: a repeat is still 0 spawns (git-core would diff the index again)', async () => {
      const s = await local();
      commit(s.fx, s.feature, { 'own.txt': 'own\n', 'conflict.txt': 'own\n' });
      commit(s.fx, s.repo, { 'theirs.txt': 't\n', 'conflict.txt': 'main\n' });
      try {
        s.fx.git(s.feature, 'merge', '-q', '--no-edit', 'main');
      } catch {
        // conflict expected
      }
      const c = await startCounting(s.fx, { watch: false });
      await c.api.addProject({ path: s.repo });
      await review(c.api, s.featureId);
      for (const scope of [REVIEW, BRANCH_ALL, WORKING]) {
        await c.api.listFiles(s.featureId, { scope });
        await c.api.inbox({ scope });
      }
      const spawns = c.spawns();
      const calls = c.originCalls();
      for (const scope of [REVIEW, BRANCH_ALL, WORKING]) {
        const files = (await c.api.listFiles(s.featureId, { scope })).files;
        expect(files.find((f) => f.path === 'theirs.txt')?.origin).toBe('base');
        await c.api.inbox({ scope });
      }
      expect(c.spawns()).toBe(spawns);
      expect(c.originCalls()).toBe(calls);
    });
  },
);
