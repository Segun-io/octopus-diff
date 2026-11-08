import {
  type ApiClient,
  ApiClientError,
  createApiClient,
  DiffResponseSchema,
  FILE_STATUSES,
  type ServerEvent,
  ServerEventSchema,
} from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';

function clientFor(backend: MockBackend, token?: string): ApiClient {
  // The contract client validates every response with the zod schemas (validate: true).
  return createApiClient({
    baseUrl: 'http://mock.local',
    fetch: createMockFetch(backend, token ? { token } : {}),
    validate: true,
  });
}

describe('mock backend implements the contract', () => {
  it('serves contract-valid projects, inbox, files, diffs and commits (demo dataset)', async () => {
    const backend = new MockBackend({ dataset: 'demo' });
    const api = clientFor(backend);
    await expect(api.health()).resolves.toMatchObject({ ok: true });
    const { projects } = await api.listProjects();
    expect(projects.length).toBeGreaterThanOrEqual(5);

    for (const scope of [
      { kind: 'working' },
      { kind: 'staged' },
      { kind: 'unstaged' },
      { kind: 'branch' },
    ] as const) {
      const inbox = await api.inbox({ scope });
      expect(inbox.scope.kind).toBe(scope.kind);
    }

    const inbox = await api.inbox();
    const statuses = new Set<string>();
    let checked = 0;
    for (const entry of inbox.entries) {
      const files = await api.listFiles(entry.worktree.id);
      expect(files.files.map((f) => f.path)).toEqual(entry.files.map((f) => f.path));
      for (const file of files.files) {
        statuses.add(file.status);
        const res = await api.getDiff(entry.worktree.id, {
          path: file.path,
          ...(file.rawPath ? { rawPath: file.rawPath } : {}),
        });
        expect(DiffResponseSchema.safeParse(res).success).toBe(true);
        // patchHash is the same across listFiles and getDiff (review marks depend on it).
        expect(res.diff.patchHash).toBe(file.patchHash);
        checked++;
      }
      const commits = await api.listCommits(entry.worktree.id, { limit: 5 });
      expect(commits.commits).toHaveLength(5);
      const sha = commits.commits[1]?.sha ?? '';
      const commitFiles = await api.listFiles(entry.worktree.id, {
        scope: { kind: 'commit', sha },
      });
      expect(commitFiles.files.length).toBeGreaterThan(0);
    }
    expect(checked).toBeGreaterThan(20);
    // Every file status appears somewhere in the demo data.
    for (const status of FILE_STATUSES) expect(statuses).toContain(status);
  });

  it('covers every special diff case', async () => {
    const backend = new MockBackend({ dataset: 'demo' });
    const api = clientFor(backend);
    const inbox = await api.inbox();
    const auth = inbox.entries.find((e) => e.worktree.branch === 'feat/auth');
    if (!auth) throw new Error('feat/auth missing');
    const get = (path: string, extra = {}) => api.getDiff(auth.worktree.id, { path, ...extra });

    expect((await get('assets/logo.png')).diff).toMatchObject({ binary: true, patch: '' });
    expect((await get('vendor/libgit')).diff).toMatchObject({
      oldMode: '160000',
      newMode: '160000',
    });
    expect((await get('config/current.json')).diff.newMode).toBe('120000');
    const huge = await get('data/fixtures.min.json');
    expect(huge.diff).toMatchObject({ tooLarge: true, truncated: false, patch: '' });
    const full = await get('data/fixtures.min.json', { full: true });
    expect(full.diff).toMatchObject({ tooLarge: false, truncated: true });
    expect(full.diff.patchHash).toBe(huge.diff.patchHash);
    const ws = await get('src/format.ts');
    const wsHidden = await get('src/format.ts', { ignoreWhitespace: true });
    expect(ws.diff.patch).toMatch(/^@@ /m);
    expect(wsHidden.diff.patch).not.toMatch(/^@@ /m);
    expect(wsHidden.diff.patchHash).toBe(ws.diff.patchHash);
    const more = await get('src/auth/session.ts', { context: 50 });
    expect(more.diff.patch.length).toBeGreaterThan(
      (await get('src/auth/session.ts')).diff.patch.length,
    );
    expect(auth.files.some((f) => f.rawPath)).toBe(true);
  });

  it('validates the large dataset (30 worktrees × 200 files)', async () => {
    const backend = new MockBackend({ dataset: 'large' });
    const api = clientFor(backend);
    const { projects } = await api.listProjects();
    expect(projects.flatMap((p) => p.worktrees)).toHaveLength(30);
    const inbox = await api.inbox();
    expect(inbox.entries).toHaveLength(30);
    expect(inbox.entries.every((e) => e.files.length === 200)).toBe(true);
  });

  it('emits contract-valid events for mutations, reviews, projects and scans', async () => {
    const backend = new MockBackend({ dataset: 'demo' });
    const api = clientFor(backend);
    const events: ServerEvent[] = [];
    backend.subscribe((e) => events.push(e));
    const [entry] = (await api.inbox()).entries;
    if (!entry) throw new Error('empty inbox');
    const before = (await api.listFiles(entry.worktree.id)).stateHash;
    backend.mutate(entry.worktree.id, 'edit');
    const after = (await api.listFiles(entry.worktree.id)).stateHash;
    expect(after).not.toBe(before);
    const file = entry.files[0];
    if (!file) throw new Error('no file');
    await api.setReview({
      projectId: entry.project.id,
      scopeKind: 'working',
      path: file.path,
      patchHash: file.patchHash,
      reviewed: true,
    });
    await api.addProject({ path: '/home/dev/code/new-repo' });
    backend.addScanRoot('/home/dev/scan', 2, 0);
    for (const e of events) expect(ServerEventSchema.safeParse(e).success).toBe(true);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'worktree.changed',
        'review.changed',
        'project.added',
        'scan.progress',
      ]),
    );
    const changed = events.find((e) => e.type === 'worktree.changed');
    expect(changed).toMatchObject({ worktreeId: entry.worktree.id, stateHash: after });
  });

  it('rejects invalid input and missing auth like the daemon', async () => {
    const backend = new MockBackend({ dataset: 'demo' });
    const api = clientFor(backend);
    const [entry] = (await api.inbox()).entries;
    if (!entry) throw new Error('empty inbox');
    await expect(api.getDiff(entry.worktree.id, { path: '../etc/passwd' })).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
    await expect(api.addProject({ path: '/tmp/not-a-repo' })).rejects.toMatchObject({
      code: 'not_a_repository',
    });
    const locked = clientFor(backend, 'secret');
    const err = await locked.listProjects().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect((err as ApiClientError).status).toBe(401);
    await expect(locked.health()).resolves.toMatchObject({ ok: true });
  });
});
