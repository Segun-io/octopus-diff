import {
  type ApiClient,
  ApiClientError,
  createApiClient,
  DiffResponseSchema,
  FILE_STATUSES,
  type ServerEvent,
  ServerEventSchema,
} from '@octopus-diff/contracts';
import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch, sideOf } from '../mock/router.ts';
import { forgeSimFromEnv } from '../mock/server.ts';

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

  it('settings, review policy and effective policies follow the contract resolver', async () => {
    const backend = new MockBackend({ dataset: 'demo' });
    const api = clientFor(backend);
    const initial = await api.getSettings();
    expect(initial.settings.review.defaultEnabled).toBe(true);
    expect(initial.overrides).toHaveLength(2);
    const { projects } = await api.listProjects();
    const legacy = projects.find((p) => p.project.name === 'legacy-tool');
    expect(legacy?.worktrees[0]?.review).toEqual({ enabled: false, source: 'project' });
    const web = projects.find((p) => p.project.name === 'web-dashboard');
    const agent = web?.worktrees.find((w) => w.worktree.branch === 'agent/codex-123');
    expect(agent?.review).toEqual({ enabled: false, source: 'branch' });
    const main = web?.worktrees.find((w) => w.worktree.isMain);
    expect(main?.review).toEqual({ enabled: true, source: 'default' });

    const events: ServerEvent[] = [];
    backend.subscribe((e) => events.push(e));
    // worktree override wins over the project default; revision increases.
    const wt = main?.worktree.id ?? '';
    const after = await api.setReviewPolicy({
      target: { kind: 'worktree', worktreeId: wt },
      enabled: false,
    });
    expect(after.revision).toBe(initial.revision + 1);
    expect(events.at(-1)).toEqual({ type: 'settings.changed', revision: after.revision });
    const inbox = await api.inbox({ onlyUnreviewed: true });
    expect(inbox.entries.some((e) => e.worktree.id === wt)).toBe(false);
    const inboxAll = await api.inbox();
    expect(inboxAll.entries.find((e) => e.worktree.id === wt)?.review).toEqual({
      enabled: false,
      source: 'worktree',
    });
    // inherit again
    const cleared = await api.setReviewPolicy({
      target: { kind: 'worktree', worktreeId: wt },
      enabled: null,
    });
    expect(cleared.overrides.some((o) => o.target.kind === 'worktree')).toBe(false);
    // no-op changes keep the revision and emit nothing (like the daemon)
    const eventsBefore = events.length;
    const same = await api.updateSettings({ review: { defaultEnabled: true } });
    expect(same.revision).toBe(cleared.revision);
    const sameAgain = await api.setReviewPolicy({
      target: { kind: 'worktree', worktreeId: wt },
      enabled: null,
    });
    expect(sameAgain.revision).toBe(cleared.revision);
    expect(events.length).toBe(eventsBefore);
    // overrides are ordered folder, project, branch, worktree
    const kinds = cleared.overrides.map((o) => o.target.kind);
    expect(kinds).toEqual(
      [...kinds].sort(
        (a, b) =>
          ['folder', 'project', 'branch', 'worktree'].indexOf(a) -
          ['folder', 'project', 'branch', 'worktree'].indexOf(b),
      ),
    );
    // default off makes everything without an override opt-in
    const off = await api.updateSettings({ review: { defaultEnabled: false } });
    expect(off.settings.review.defaultEnabled).toBe(false);
    const list = await api.listProjects();
    expect(
      list.projects.find((p) => p.project.name === 'web-dashboard')?.worktrees[0]?.review,
    ).toEqual({
      enabled: false,
      source: 'default',
    });
    // targets must exist; branch targets only need the project
    await expect(
      api.setReviewPolicy({
        target: { kind: 'worktree', worktreeId: 'f'.repeat(16) },
        enabled: true,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      api.setReviewPolicy({
        target: { kind: 'branch', projectId: web?.project.id ?? '', branch: 'no/such' },
        enabled: true,
      }),
    ).resolves.toMatchObject({ revision: expect.any(Number) });
    // removing the project removes its overrides
    await api.removeProject(web?.project.id ?? '');
    const last = await api.getSettings();
    expect(
      last.overrides.filter(
        (o) =>
          o.target.kind !== 'folder' &&
          'projectId' in o.target &&
          o.target.projectId === web?.project.id,
      ),
    ).toHaveLength(0);
  });

  it('bulk review marks the current state, respects stale/disabled/paths, and undoes exactly', async () => {
    const backend = new MockBackend({ dataset: 'demo' });
    const api = clientFor(backend);
    const events: ServerEvent[] = [];
    backend.subscribe((e) => events.push(e));
    const { projects } = await api.listProjects();
    const auth = projects
      .flatMap((p) => p.worktrees)
      .find((w) => w.worktree.branch === 'feat/auth');
    const authId = auth?.worktree.id ?? '';
    const files = await api.listFiles(authId);

    // paths only with worktree targets
    await expect(
      api.bulkReview({ target: { kind: 'all' }, paths: [{ path: 'README.md' }] }),
    ).rejects.toMatchObject({ code: 'bad_request' });

    // stale: the user never saw this state
    const stale = await api.bulkReview({
      target: { kind: 'worktree', worktreeId: authId },
      expectedStateHashes: { [authId]: 'deadbeef' },
    });
    expect(stale).toMatchObject({ changed: 0, stale: [authId], undoToken: null });

    // two files of one worktree
    const two = files.files.slice(0, 2);
    const res = await api.bulkReview({
      target: { kind: 'worktree', worktreeId: authId },
      paths: two.map((f) => ({ path: f.path, ...(f.rawPath ? { rawPath: f.rawPath } : {}) })),
      expectedStateHashes: { [authId]: files.stateHash },
    });
    expect(res).toMatchObject({
      changed: 2,
      unchanged: 0,
      worktrees: 1,
      stale: [],
      skippedDisabled: [],
    });
    expect(res.undoToken).toBeTruthy();
    expect(events.filter((e) => e.type === 'review.bulk')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'review.changed')).toHaveLength(0);
    const after = await api.listFiles(authId);
    expect(
      after.files
        .filter((f) => f.reviewed)
        .map((f) => f.path)
        .sort(),
    ).toEqual(two.map((f) => f.path).sort());

    // again: unchanged
    const again = await api.bulkReview({
      target: { kind: 'worktree', worktreeId: authId },
      paths: two.map((f) => ({ path: f.path, ...(f.rawPath ? { rawPath: f.rawPath } : {}) })),
    });
    expect(again).toMatchObject({ changed: 0, unchanged: 2, undoToken: null });

    // all: disabled worktrees are skipped unless includeDisabled
    const all = await api.bulkReview({ target: { kind: 'all' } });
    expect(all.changed).toBeGreaterThan(0);
    expect(all.skippedDisabled.length).toBe(0); // the disabled worktrees in the demo have no files
    const inbox = await api.inbox({ onlyUnreviewed: true });
    expect(inbox.entries).toHaveLength(0);

    // undo the "all" call: exactly its rows; the two earlier marks stay
    const undone = await api.undoReview({ undoToken: all.undoToken ?? '' });
    expect(undone.restored).toBe(all.changed);
    const afterUndo = await api.listFiles(authId);
    expect(afterUndo.files.filter((f) => f.reviewed)).toHaveLength(2);
    await expect(api.undoReview({ undoToken: all.undoToken ?? '' })).rejects.toMatchObject({
      code: 'not_found',
    });

    // mark all unreviewed (inverse), then undo restores the marks
    const clear = await api.bulkReview({
      target: { kind: 'worktree', worktreeId: authId },
      reviewed: false,
    });
    expect(clear.changed).toBe(2);
    await api.undoReview({ undoToken: clear.undoToken ?? '' });
    expect((await api.listFiles(authId)).files.filter((f) => f.reviewed)).toHaveLength(2);

    // expired tokens are gone
    const t = await api.bulkReview({
      target: { kind: 'project', projectId: auth?.worktree.projectId ?? '' },
      reviewed: false,
    });
    backend.now = () => Date.now() + 11 * 60 * 1000;
    await expect(api.undoReview({ undoToken: t.undoToken ?? '' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('mock knobs for slow and held-back forges (#11)', () => {
  it('tells which side answers a route slowly', () => {
    expect(sideOf('/api/forges/worktrees/w/request', 'GET')).toBe('forge');
    expect(sideOf('/api/forges/worktrees/w/request/conversation', 'GET')).toBe('forge');
    expect(sideOf('/api/forges/projects/p/repository', 'GET')).toBe('forge');
    expect(sideOf('/api/forges/refresh', 'POST')).toBe('forge');
    // Reads of the daemon's own cache are local, like everything git.
    expect(sideOf('/api/forges', 'GET')).toBe('local');
    expect(sideOf('/api/projects', 'GET')).toBe('local');
    expect(sideOf('/api/worktrees/w/diff', 'GET')).toBe('local');
  });

  it('calls the gate with the side before answering, and waits for it', async () => {
    const backend = new MockBackend({ dataset: 'demo' });
    const seen: string[] = [];
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const fetch = createMockFetch(backend, {
      gate: async ({ path, side }) => {
        seen.push(`${side} ${path}`);
        if (side === 'forge') await held;
      },
    });
    const api = createApiClient({ baseUrl: 'http://mock.local', fetch });
    await api.listProjects();
    const refresh = api.refreshForges({});
    let done = false;
    void refresh.then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    release();
    await refresh;
    expect(seen).toEqual(['local /api/projects', 'forge /api/forges/refresh']);
  });

  it('delays only the chosen side', async () => {
    vi.useFakeTimers();
    try {
      const backend = new MockBackend({ dataset: 'demo' });
      const fetch = createMockFetch(backend, { forgeLatencyMs: 1000 });
      const api = createApiClient({ baseUrl: 'http://mock.local', fetch });
      await api.listProjects(); // local: no delay
      await api.getForges(); // the daemon's cache: no delay
      let done = false;
      const request = api.refreshForges({}).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await request;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports pending lookups, a held-back budget and a failed fetch, contract-valid', async () => {
    const backend = new MockBackend({ dataset: 'demo' });
    const api = clientFor(backend);
    const plain = await api.getForges();
    expect(plain.projects.every((p) => p.status === 'ok' || p.status === 'idle')).toBe(true);
    expect(plain.budgets?.[0]?.state).toBe('ok');

    backend.setForgeSim({ pending: true });
    const pending = await api.getForges();
    expect(pending.projects.every((p) => p.status === 'pending' && p.fetchedAt === null)).toBe(
      true,
    );

    backend.setForgeSim({ budget: 'backoff', fetchedAgoMs: 180_000 });
    const held = await api.getForges();
    expect(held.budgets?.[0]).toMatchObject({ state: 'backoff' });
    expect(held.budgets?.[0]?.resumeAt).not.toBeNull();
    const age = Date.parse(held.generatedAt) - Date.parse(held.projects[0]?.fetchedAt ?? '');
    expect(age).toBe(180_000);

    backend.setForgeSim({ error: 'boom' });
    const failed = await api.getForges();
    expect(failed.projects.some((p) => p.status === 'error' && p.message === 'boom')).toBe(true);
    // The last good requests are kept (docs/FORGES.md 3b).
    expect(failed.projects.some((p) => p.worktrees.length > 0)).toBe(true);
  });

  it('changes the state through the control endpoint and tells clients', async () => {
    const backend = new MockBackend({ dataset: 'demo' });
    const events: ServerEvent[] = [];
    backend.subscribe((e) => events.push(e));
    const fetch = createMockFetch(backend);
    await fetch('/api/__mock/forge-sim?pending=1&budget=low&error=x&fetchedAgoMs=5000', {
      method: 'POST',
    });
    expect(events.some((e) => e.type === 'forge.updated')).toBe(true);
    const api = createApiClient({ baseUrl: 'http://mock.local', fetch });
    expect((await api.getForges()).budgets?.[0]?.state).toBe('low');
    await fetch('/api/__mock/forge-sim', { method: 'POST' }); // no parameters: reset
    expect((await api.getForges()).budgets?.[0]?.state).toBe('ok');
  });

  it('reads MOCK_FORGE_SIM', () => {
    expect(forgeSimFromEnv(undefined)).toEqual({});
    expect(forgeSimFromEnv('pending')).toEqual({ pending: true });
    expect(forgeSimFromEnv('backoff,error')).toMatchObject({
      budget: 'backoff',
      fetchedAgoMs: 180_000,
      error: expect.any(String),
    });
  });
});
