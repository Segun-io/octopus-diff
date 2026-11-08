import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DiffResponseSchema,
  FilesResponseSchema,
  InboxResponseSchema,
  ProjectsResponseSchema,
} from '@octopus-diff/contracts';
import { GIT_CORE_IMPLEMENTED } from '@octopus-diff/git-core';
import { describe, expect, it } from 'vitest';
import { type Daemon, startDaemon } from '../src/daemon.js';
import { hashId } from '../src/ids.js';
import { client, onCleanup, recordEvents, TEST_TOKEN, tempDir } from './helpers.js';

/**
 * PLAN §6 WS2 "done when" against the REAL git-core and real repositories: start the daemon,
 * register fixture repos, mutate files externally, receive SSE `worktree.changed` within ~1 s;
 * restart preserves registry and review marks.
 *
 * Skipped while `@octopus-diff/git-core` is the Phase 0 placeholder; runs once WS1 is merged.
 * Fixtures live under os.tmpdir() and use an isolated git config (AGENTS.md).
 */

interface Fixture {
  root: string;
  env: Record<string, string>;
  git: (cwd: string, ...args: string[]) => string;
}

async function makeFixture(): Promise<Fixture> {
  const root = realpathSync(await tempDir('octopus-diff-it-'));
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
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: { ...baseEnv, ...env }, encoding: 'utf8' });
  return { root, env, git };
}

async function makeRepo(fx: Fixture, name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(fx.root, name);
  fx.git(fx.root, 'init', '-q', name);
  for (const [file, content] of Object.entries(files))
    await writeFile(path.join(dir, file), content);
  fx.git(dir, 'add', '-A');
  fx.git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

async function start(fx: Fixture, stateDir: string): Promise<Daemon> {
  const daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir,
    logLevel: process.env.OCTOPUS_DIFF_TEST_LOGS ? 'debug' : 'silent',
    git: { env: fx.env },
    watch: { debounceMs: 150 },
  });
  onCleanup(() => daemon.close());
  return daemon;
}

describe.skipIf(!GIT_CORE_IMPLEMENTED)('daemon + real git-core (integration)', () => {
  it('registers real repos, streams live changes, keeps review marks across restarts', async () => {
    const fx = await makeFixture();
    const stateDir = await tempDir();
    const alpha = await makeRepo(fx, 'alpha', { 'a.txt': 'one\ntwo\nthree\n', 'keep.txt': 'k\n' });
    const beta = await makeRepo(fx, 'beta', { 'b.txt': 'b\n' });
    const feature = path.join(fx.root, 'alpha-feature');
    fx.git(alpha, 'worktree', 'add', '-q', '-b', 'feature', feature);

    const projectId = hashId(realpathSync(path.join(alpha, '.git')));
    const mainId = hashId(alpha);
    const featureId = hashId(feature);

    const daemon = await start(fx, stateDir);
    const api = client(daemon);
    const health = await api.health();
    expect(health.git.supported).toBe(true);

    // Register by path; a linked-worktree path resolves to the same project.
    const added = await api.addProject({ path: alpha });
    expect(added.created).toBe(true);
    expect(added.project.project.id).toBe(projectId);
    const again = await api.addProject({ path: feature });
    expect(again).toMatchObject({ created: false, project: { project: { id: projectId } } });
    await api.addProject({ path: beta });

    const projects = ProjectsResponseSchema.parse(await api.listProjects());
    const alphaItem = projects.projects.find((p) => p.project.id === projectId);
    expect(alphaItem?.project.defaultBranch).toBe('main');
    expect(
      alphaItem?.worktrees.map((w) => [w.worktree.id, w.worktree.branch, w.worktree.isMain]),
    ).toEqual([
      [mainId, 'main', true],
      [featureId, 'feature', false],
    ]);
    for (const w of alphaItem?.worktrees ?? []) {
      expect(w.error).toBeNull();
      expect(w.summary?.changedFiles).toBe(0);
    }
    expect((await api.inbox()).entries).toEqual([]);

    // An "agent" edits a file in the linked worktree: worktree.changed within ~1 s.
    const events = recordEvents(daemon);
    await events.opened;
    const t0 = Date.now();
    await writeFile(path.join(feature, 'a.txt'), 'one\nTWO\nthree\n');
    await events.waitFor((e) => e.type === 'worktree.changed' && e.worktreeId === featureId, 3000);
    expect(Date.now() - t0).toBeLessThan(1500);

    const files = FilesResponseSchema.parse(await api.listFiles(featureId));
    expect(files.files.map((f) => [f.path, f.status, f.reviewed])).toEqual([
      ['a.txt', 'modified', false],
    ]);
    const fileA = files.files[0];
    if (!fileA) throw new Error('missing a.txt');
    const diff = DiffResponseSchema.parse(await api.getDiff(featureId, { path: 'a.txt' }));
    expect(diff.diff.patch).toContain('-two');
    expect(diff.diff.patch).toContain('+TWO');
    expect(diff.diff.patchHash).toBe(fileA.patchHash);
    const wsDiff = await api.getDiff(featureId, {
      path: 'a.txt',
      ignoreWhitespace: true,
      context: 0,
    });
    expect(wsDiff.diff.patchHash).toBe(fileA.patchHash);

    // Review it: it leaves the unreviewed inbox; edit again: it comes back.
    await api.setReview({
      projectId,
      scopeKind: 'working',
      path: 'a.txt',
      patchHash: fileA.patchHash,
      reviewed: true,
    });
    expect((await api.listFiles(featureId)).files[0]?.reviewed).toBe(true);
    expect(InboxResponseSchema.parse(await api.inbox({ onlyUnreviewed: true })).entries).toEqual(
      [],
    );
    expect((await api.inbox()).entries.map((e) => e.worktree.id)).toEqual([featureId]);

    const seen = events.events.length;
    await appendFile(path.join(feature, 'a.txt'), 'four\n');
    await events.waitFor(
      (e) =>
        e.type === 'worktree.changed' &&
        e.worktreeId === featureId &&
        events.events.indexOf(e) >= seen,
      3000,
    );
    const reedited = (await api.listFiles(featureId)).files[0];
    expect(reedited?.reviewed).toBe(false);
    expect((await api.inbox({ onlyUnreviewed: true })).entries.map((e) => e.worktree.id)).toEqual([
      featureId,
    ]);

    // Untracked file in the main worktree.
    await writeFile(path.join(alpha, 'new.txt'), 'hello\n');
    await events.waitFor((e) => e.type === 'worktree.changed' && e.worktreeId === mainId, 3000);
    const mainFiles = await api.listFiles(mainId);
    expect(mainFiles.files.map((f) => [f.path, f.status])).toEqual([['new.txt', 'untracked']]);

    // A new linked worktree appears (an agent creates one).
    const agent = path.join(fx.root, 'alpha-agent');
    fx.git(alpha, 'worktree', 'add', '-q', '-b', 'agent', agent);
    const agentId = hashId(agent);
    await events.waitFor((e) => e.type === 'worktree.added' && e.worktreeId === agentId, 5000);

    // Mark the current a.txt state reviewed, then restart on the same state dir.
    if (!reedited) throw new Error('missing');
    await api.setReview({
      projectId,
      scopeKind: 'working',
      path: 'a.txt',
      patchHash: reedited.patchHash,
      reviewed: true,
    });
    await daemon.close();

    const restarted = await start(fx, stateDir);
    const api2 = client(restarted);
    const after = await api2.listProjects();
    expect(after.projects.map((p) => p.project.name)).toEqual(['alpha', 'beta']);
    expect(after.projects[0]?.worktrees.map((w) => w.worktree.id)).toEqual(
      [mainId, agentId, featureId].sort((x, y) => {
        const order = [mainId, ...[agent, feature].sort().map((p) => hashId(p))];
        return order.indexOf(x) - order.indexOf(y);
      }),
    );
    expect((await api2.listFiles(featureId)).files[0]?.reviewed).toBe(true);

    // Reading through the daemon never touches the repository's index or refs.
    const indexBefore = statSync(path.join(alpha, '.git', 'index')).mtimeMs;
    const headBefore = fx.git(alpha, 'rev-parse', 'HEAD');
    await api2.listFiles(mainId);
    await api2.listFiles(featureId, { scope: { kind: 'branch' } });
    await api2.inbox();
    await api2.refreshWorktree(mainId);
    expect(statSync(path.join(alpha, '.git', 'index')).mtimeMs).toBe(indexBefore);
    expect(fx.git(alpha, 'rev-parse', 'HEAD')).toBe(headBefore);
  }, 30_000);

  it('discovers repositories through a scan root', async () => {
    const fx = await makeFixture();
    await makeRepo(fx, 'one', { 'x.txt': 'x\n' });
    await makeRepo(fx, 'two', { 'y.txt': 'y\n' });
    const daemon = await start(fx, await tempDir());
    const api = client(daemon);
    const events = recordEvents(daemon);
    await events.opened;
    const { scanRoot } = await api.addScanRoot({ path: fx.root, depth: 1 });
    await events.waitFor(
      (e) => e.type === 'scan.progress' && e.scanRootId === scanRoot.id && e.state === 'done',
      10_000,
    );
    const names = (await api.listProjects()).projects.map((p) => p.project.name);
    expect(names).toEqual(['one', 'two']);
    expect((await api.listScanRoots()).scanRoots[0]?.projectCount).toBe(2);
  }, 30_000);
});
