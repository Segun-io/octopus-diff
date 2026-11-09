import path from 'node:path';
import {
  AddProjectResponseSchema,
  type ApiClient,
  ApiClientError,
  CommitsResponseSchema,
  DiffResponseSchema,
  FilesResponseSchema,
  InboxResponseSchema,
  ProjectsResponseSchema,
  RefreshResponseSchema,
  ReviewResponseSchema,
  UpdateProjectResponseSchema,
} from '@octopus-diff/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Daemon } from '../src/daemon.js';
import { FakeGitCore, type FakeRepo, fakeFile } from './fake-git-core.js';
import { client, errorOf, http, recordEvents, startTestDaemon, tempDir } from './helpers.js';

function expectApiError(promise: Promise<unknown>, code: string, status: number) {
  return expect(promise).rejects.toSatisfy((e: unknown) => {
    return e instanceof ApiClientError && e.code === code && e.status === status;
  });
}

describe('API routes (fake git-core)', () => {
  let fake: FakeGitCore;
  let base: string;
  let daemon: Daemon;
  let api: ApiClient;
  let alpha: FakeRepo;
  let beta: FakeRepo;

  beforeEach(async () => {
    fake = new FakeGitCore();
    base = await tempDir();
    alpha = await fake.createRepo(base, 'alpha', { linked: ['feat'] });
    beta = await fake.createRepo(base, 'beta');
    daemon = await startTestDaemon({ fake, stateDir: await tempDir() });
    api = client(daemon);
  });

  const mainOf = (repo: FakeRepo) => repo.worktrees[0]?.id ?? '';
  const linkedOf = (repo: FakeRepo) => repo.worktrees[1]?.id ?? '';

  it('adds projects by path (validated responses) and lists them with summaries', async () => {
    fake.setFiles(mainOf(alpha), 'working', [
      fakeFile('src/a.ts'),
      fakeFile('README.md', { status: 'untracked', unstaged: true }),
    ]);
    const added = AddProjectResponseSchema.parse(await api.addProject({ path: alpha.mainPath }));
    expect(added.created).toBe(true);
    expect(added.project.project).toMatchObject({
      id: alpha.projectId,
      name: 'alpha',
      commonDir: alpha.commonDir,
      defaultBranch: 'main',
      defaultBranchOverride: null,
      scanRootId: null,
    });
    expect(added.project.worktrees.map((w) => w.worktree.id)).toEqual([
      mainOf(alpha),
      linkedOf(alpha),
    ]);
    expect(added.project.worktrees[0]?.summary?.changedFiles).toBe(2);

    await api.addProject({ path: beta.mainPath });
    const listed = ProjectsResponseSchema.parse(await api.listProjects());
    expect(listed.projects.map((p) => p.project.name)).toEqual(['alpha', 'beta']);
    for (const p of listed.projects) {
      for (const w of p.worktrees) {
        expect(w.summary).not.toBeNull();
        expect(w.error).toBeNull();
      }
    }
  });

  it('is idempotent and resolves a linked worktree path (and subdirectories) to its project', async () => {
    await api.addProject({ path: alpha.mainPath });
    const linkedPath = alpha.worktrees[1]?.path ?? '';
    const again = await api.addProject({ path: linkedPath });
    expect(again.created).toBe(false);
    expect(again.project.project.id).toBe(alpha.projectId);
    const res = await http(daemon, '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.join(alpha.mainPath, '.git') }),
    });
    expect(res.status).toBe(200);
    expect((await api.listProjects()).projects).toHaveLength(1);
  });

  it('expands ~ in paths', async () => {
    const home = process.env.HOME;
    process.env.HOME = base;
    try {
      const added = await api.addProject({ path: '~/beta' });
      expect(added.project.project.id).toBe(beta.projectId);
    } finally {
      process.env.HOME = home;
    }
  });

  it('validates add-project input and maps errors', async () => {
    await expectApiError(api.addProject({ path: path.join(base, 'nope') }), 'not_found', 404);
    await expectApiError(api.addProject({ path: base }), 'not_a_repository', 422);
    const bad = await http(daemon, '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '' }),
    });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe('bad_request');
    const notJson = await http(daemon, '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(notJson.status).toBe(400);
    const wrongType = await http(daemon, '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ path: alpha.mainPath }),
    });
    expect(wrongType.status).toBe(415);
    const tooBig = await http(daemon, '/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(tooBig.status).toBe(413);
  });

  it('removes projects (404 afterwards) and emits project events', async () => {
    const events = recordEvents(daemon);
    await events.opened;
    await api.addProject({ path: alpha.mainPath });
    await events.waitFor((e) => e.type === 'project.added' && e.projectId === alpha.projectId);
    await expect(api.removeProject(alpha.projectId)).resolves.toEqual({ ok: true });
    await events.waitFor((e) => e.type === 'project.removed' && e.projectId === alpha.projectId);
    expect((await api.listProjects()).projects).toHaveLength(0);
    await expectApiError(api.removeProject(alpha.projectId), 'not_found', 404);
    await expectApiError(api.listFiles(mainOf(alpha)), 'not_found', 404);
    const badId = await http(daemon, '/api/projects/NOT-AN-ID', { method: 'DELETE' });
    expect(badId.status).toBe(400);
  });

  it('sets and clears the default-branch override (PATCH) and passes it to git-core', async () => {
    await api.addProject({ path: alpha.mainPath });
    const updated = UpdateProjectResponseSchema.parse(
      await api.updateProject(alpha.projectId, { defaultBranchOverride: 'develop' }),
    );
    expect(updated.project.project.defaultBranch).toBe('develop');
    expect(updated.project.project.defaultBranchOverride).toBe('develop');
    await api.listFiles(linkedOf(alpha), { scope: { kind: 'branch' } });
    expect(fake.lastScopeOptions?.defaultBranch).toBe('develop');
    const cleared = await api.updateProject(alpha.projectId, { defaultBranchOverride: null });
    expect(cleared.project.project.defaultBranch).toBe('main');
    expect(cleared.project.project.defaultBranchOverride).toBeNull();
    const unchanged = await api.updateProject(alpha.projectId, {});
    expect(unchanged.project.project.defaultBranch).toBe('main');
    const bad = await http(daemon, `/api/projects/${alpha.projectId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultBranchOverride: '--upload-pack=evil' }),
    });
    expect(bad.status).toBe(400);
  });

  it('lists files with reviewed flags, serves diffs, and invalidates marks when the patch changes', async () => {
    const wt = mainOf(alpha);
    fake.setFiles(wt, 'working', [fakeFile('a.ts'), fakeFile('b.ts')]);
    await api.addProject({ path: alpha.mainPath });
    const events = recordEvents(daemon);
    await events.opened;

    const files = FilesResponseSchema.parse(await api.listFiles(wt));
    expect(files.files.map((f) => [f.path, f.reviewed])).toEqual([
      ['a.ts', false],
      ['b.ts', false],
    ]);
    const a = files.files[0];
    if (!a) throw new Error('missing file');

    const marked = ReviewResponseSchema.parse(
      await api.setReview({
        projectId: alpha.projectId,
        scopeKind: 'working',
        path: 'a.ts',
        patchHash: a.patchHash,
        reviewed: true,
      }),
    );
    expect(marked).toEqual({ ok: true, reviewed: true });
    await events.waitFor((e) => e.type === 'review.changed' && e.path === 'a.ts' && e.reviewed);
    expect((await api.listFiles(wt)).files.map((f) => f.reviewed)).toEqual([true, false]);

    const diff = DiffResponseSchema.parse(
      await api.getDiff(wt, { path: 'a.ts', ignoreWhitespace: true, context: 10 }),
    );
    expect(diff.diff.reviewed).toBe(true);
    expect(diff.diff.patchHash).toBe(a.patchHash);
    expect(fake.lastDiffOptions).toMatchObject({
      ignoreWhitespace: true,
      contextLines: 10,
      full: false,
    });

    // Same file and patch in another scope kind: reviewed there too (status flow v2, marks are
    // keyed by path and patch hash only).
    fake.setFiles(wt, 'staged', [fakeFile('a.ts', { staged: true, unstaged: false })]);
    expect((await api.listFiles(wt, { scope: { kind: 'staged' } })).files[0]?.reviewed).toBe(true);

    // The agent edits a.ts again: new patch hash -> unreviewed again.
    fake.setFiles(wt, 'working', [fakeFile('a.ts', { patchHash: 'v2:a.ts' }), fakeFile('b.ts')]);
    await api.refreshWorktree(wt);
    expect((await api.listFiles(wt)).files.map((f) => f.reviewed)).toEqual([false, false]);

    // Unmark the old hash: idempotent, ok.
    await expect(
      api.setReview({
        projectId: alpha.projectId,
        scopeKind: 'working',
        path: 'a.ts',
        patchHash: a.patchHash,
        reviewed: false,
      }),
    ).resolves.toEqual({ ok: true, reviewed: false });
  });

  it('keys review marks by rawPath when present', async () => {
    const wt = mainOf(beta);
    const raw = Buffer.from([0x66, 0xff, 0x2e, 0x74]).toString('base64');
    fake.setFiles(wt, 'working', [fakeFile('f�.t', { rawPath: raw }), fakeFile('f�.t2')]);
    await api.addProject({ path: beta.mainPath });
    const files = (await api.listFiles(wt)).files;
    const target = files[0];
    if (!target) throw new Error('missing');
    await api.setReview({
      projectId: beta.projectId,
      scopeKind: 'working',
      path: target.path,
      rawPath: raw,
      patchHash: target.patchHash,
      reviewed: true,
    });
    expect((await api.listFiles(wt)).files.map((f) => f.reviewed)).toEqual([true, false]);
    // The same display path without rawPath is a different key.
    await api.setReview({
      projectId: beta.projectId,
      scopeKind: 'working',
      path: target.path,
      patchHash: target.patchHash,
      reviewed: false,
    });
    expect((await api.listFiles(wt)).files[0]?.reviewed).toBe(true);
  });

  it('validates review and diff input', async () => {
    await api.addProject({ path: alpha.mainPath });
    await expectApiError(
      api.setReview({
        projectId: '0000000000000000',
        scopeKind: 'working',
        path: 'a',
        patchHash: 'h',
        reviewed: true,
      }),
      'not_found',
      404,
    );
    for (const body of [
      {
        projectId: alpha.projectId,
        scopeKind: 'working',
        path: '../etc/passwd',
        patchHash: 'h',
        reviewed: true,
      },
      { projectId: alpha.projectId, scopeKind: 'nope', path: 'a', patchHash: 'h', reviewed: true },
      {
        projectId: alpha.projectId,
        scopeKind: 'working',
        path: '/abs',
        patchHash: 'h',
        reviewed: true,
      },
      {
        projectId: alpha.projectId,
        scopeKind: 'working',
        path: 'a',
        patchHash: '',
        reviewed: true,
      },
    ]) {
      const res = await http(daemon, '/api/review', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const wt = mainOf(alpha);
    for (const query of [
      '',
      'path=../x',
      'path=a&scope=commit',
      'path=a&scope=branch&base=-x',
      'path=a&context=-1',
      'path=a&scope=bogus',
    ]) {
      const res = await http(daemon, `/api/worktrees/${wt}/diff?${query}`);
      expect(res.status, query).toBe(400);
      const err = await errorOf(res);
      expect(err.code).toBe('bad_request');
    }
    await expectApiError(api.getDiff(wt, { path: 'not-changed.ts' }), 'not_found', 404);
  });

  it('serves inbox entries for dirty worktrees only, with onlyUnreviewed filtering', async () => {
    fake.setFiles(mainOf(alpha), 'working', [fakeFile('a.ts'), fakeFile('b.ts')]);
    fake.setFiles(linkedOf(alpha), 'working', []);
    fake.setFiles(mainOf(beta), 'working', [fakeFile('c.ts')]);
    await api.addProject({ path: beta.mainPath });
    await api.addProject({ path: alpha.mainPath });

    const inbox = InboxResponseSchema.parse(await api.inbox());
    expect(inbox.scope).toEqual({ kind: 'working' });
    expect(inbox.entries.map((e) => [e.project.name, e.worktree.id, e.files.length])).toEqual([
      ['alpha', mainOf(alpha), 2],
      ['beta', mainOf(beta), 1],
    ]);

    const c = inbox.entries[1]?.files[0];
    if (!c) throw new Error('missing');
    await api.setReview({
      projectId: beta.projectId,
      scopeKind: 'working',
      path: 'c.ts',
      patchHash: c.patchHash,
      reviewed: true,
    });
    const unreviewed = await api.inbox({ onlyUnreviewed: true });
    expect(unreviewed.entries.map((e) => e.project.name)).toEqual(['alpha']);
    const all = await api.inbox({ onlyUnreviewed: false });
    expect(all.entries).toHaveLength(2);
    expect(all.entries[1]?.files[0]?.reviewed).toBe(true);

    fake.setFiles(linkedOf(alpha), 'branch', [fakeFile('feature.ts')]);
    const branch = await api.inbox({ scope: { kind: 'branch' } });
    expect(branch.entries.map((e) => e.worktree.id)).toEqual([linkedOf(alpha)]);
  });

  it('lists commits with a validated limit', async () => {
    await api.addProject({ path: alpha.mainPath });
    const commits = CommitsResponseSchema.parse(await api.listCommits(mainOf(alpha), { limit: 2 }));
    expect(commits.commits).toHaveLength(2);
    const bad = await http(daemon, `/api/worktrees/${mainOf(alpha)}/commits?limit=0`);
    expect(bad.status).toBe(400);
    const tooMany = await http(daemon, `/api/worktrees/${mainOf(alpha)}/commits?limit=501`);
    expect(tooMany.status).toBe(400);
  });

  it('refreshes a worktree on demand and emits worktree.changed only when stateHash changes', async () => {
    const wt = mainOf(alpha);
    await api.addProject({ path: alpha.mainPath });
    const events = recordEvents(daemon);
    await events.opened;
    const first = RefreshResponseSchema.parse(await api.refreshWorktree(wt));
    await api.refreshWorktree(wt);
    fake.setFiles(wt, 'working', [fakeFile('new.ts')]);
    const second = await api.refreshWorktree(wt);
    expect(second.summary.stateHash).not.toBe(first.summary.stateHash);
    await events.waitFor(
      (e) => e.type === 'worktree.changed' && e.stateHash === second.summary.stateHash,
    );
    const changed = events.events.filter(
      (e) => e.type === 'worktree.changed' && e.worktreeId === wt,
    );
    expect(changed).toHaveLength(1);
  });

  it('maps git-core errors to API errors', async () => {
    await api.addProject({ path: alpha.mainPath });
    const wt = mainOf(alpha);
    fake.fail('listCommits', 'timeout');
    await expectApiError(api.listCommits(wt), 'timeout', 504);
    fake.fail('listCommits', 'git_failed');
    const res = await http(daemon, `/api/worktrees/${wt}/commits`);
    expect(res.status).toBe(500);
    const err = await errorOf(res);
    expect(err.code).toBe('git_error');
    expect(err.details).toMatchObject({ gitCode: 'git_failed', stderr: 'fatal: simulated' });
    fake.fail('getFileDiff', 'output_too_large');
    await expectApiError(api.getDiff(wt, { path: 'x' }), 'too_large', 413);
    fake.fail('getSummary', 'git_failed');
    await expectApiError(api.refreshWorktree(wt), 'git_error', 500);
    const projects = await api.listProjects();
    expect(projects.projects[0]?.worktrees[0]?.summary).toBeNull();
    expect(projects.projects[0]?.worktrees[0]?.error?.code).toBe('git_error');
  });

  it('single-flights summary computation under concurrent requests', async () => {
    fake.methodDelay.set('getSummary', 50);
    await api.addProject({ path: alpha.mainPath });
    const before = fake.callCount('getSummary');
    const wt = mainOf(alpha);
    await Promise.all(Array.from({ length: 10 }, () => api.refreshWorktree(wt)));
    // One in-flight run plus at most one coalesced follow-up.
    expect(fake.callCount('getSummary') - before).toBeLessThanOrEqual(2);
  });

  it('caches file lists by stateHash', async () => {
    const wt = mainOf(alpha);
    fake.setFiles(wt, 'working', [fakeFile('a.ts')]);
    await api.addProject({ path: alpha.mainPath });
    await api.listFiles(wt);
    const calls = fake.callCount('listChangedFiles');
    await api.listFiles(wt);
    await api.inbox();
    expect(fake.callCount('listChangedFiles')).toBe(calls);
    fake.setFiles(wt, 'working', [fakeFile('a.ts', { patchHash: 'v2' })]);
    await api.refreshWorktree(wt);
    await api.listFiles(wt);
    expect(fake.callCount('listChangedFiles')).toBe(calls + 1);
  });

  it('accepts focus updates', async () => {
    await api.addProject({ path: alpha.mainPath });
    await expect(api.setFocus({ worktreeId: mainOf(alpha) })).resolves.toEqual({ ok: true });
    expect(daemon.core.watcher.focus).toBe(mainOf(alpha));
    await expect(api.setFocus({ worktreeId: null })).resolves.toEqual({ ok: true });
    const bad = await http(daemon, '/api/focus', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worktreeId: 'x' }),
    });
    expect(bad.status).toBe(400);
  });

  it('returns JSON 404 for unknown API routes and when no web UI is configured', async () => {
    const res = await http(daemon, '/api/nope');
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe('not_found');
    const ui = await http(daemon, '/');
    expect(ui.status).toBe(404);
  });
});
