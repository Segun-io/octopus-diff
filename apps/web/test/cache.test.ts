import {
  createApiClient,
  type DiffResponse,
  type FilesResponse,
  type InboxResponse,
  type ServerEvent,
} from '@octopus-diff/contracts';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import {
  applyReviewToCaches,
  collectEventEffects,
  emptyEffects,
  flushEffects,
} from '../src/api/cache.ts';
import { queryKeys } from '../src/api/queries.ts';

function seeded() {
  const backend = new MockBackend({ dataset: 'demo' });
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const projects = backend.listProjects();
  const inbox = backend.inbox({ kind: 'working' }, false);
  qc.setQueryData(queryKeys.projects(), projects);
  qc.setQueryData(queryKeys.inbox({ kind: 'working' }), inbox);
  const staged = backend.inbox({ kind: 'staged' }, false);
  qc.setQueryData(queryKeys.inbox({ kind: 'staged' }), staged);
  const entries = inbox.entries;
  const [a, b] = entries;
  if (!a || !b) throw new Error('need two inbox entries');
  for (const entry of [a, b]) {
    qc.setQueryData(
      queryKeys.files(entry.worktree.id, { kind: 'working' }),
      backend.listFiles(entry.worktree.id, { kind: 'working' }),
    );
  }
  const file = a.files[0];
  if (!file) throw new Error('no file');
  const diffKey = queryKeys.diff(
    { worktreeId: a.worktree.id, path: file.path },
    { kind: 'working' },
    { ignoreWhitespace: false },
  );
  qc.setQueryData(
    diffKey,
    backend.getDiff(a.worktree.id, {
      scope: { kind: 'working' },
      path: file.path,
      ignoreWhitespace: false,
      full: false,
    }),
  );
  return { backend, qc, a, b, file, diffKey };
}

describe('review marks in the cache', () => {
  it('patches inbox, files and diff caches for the same scope kind, and rolls back', () => {
    const { qc, a, file, diffKey } = seeded();
    const rollback = applyReviewToCaches(qc, {
      projectId: a.project.id,
      scopeKind: 'working',
      path: file.path,
      patchHash: file.patchHash,
      reviewed: true,
    });
    const inbox = qc.getQueryData<InboxResponse>(queryKeys.inbox({ kind: 'working' }));
    expect(
      inbox?.entries
        .find((e) => e.worktree.id === a.worktree.id)
        ?.files.find((f) => f.path === file.path)?.reviewed,
    ).toBe(true);
    const files = qc.getQueryData<FilesResponse>(
      queryKeys.files(a.worktree.id, { kind: 'working' }),
    );
    expect(files?.files.find((f) => f.path === file.path)?.reviewed).toBe(true);
    expect(qc.getQueryData<DiffResponse>(diffKey)?.diff.reviewed).toBe(true);
    // Other scope kinds are untouched (marks are keyed by scope kind).
    const staged = qc.getQueryData<InboxResponse>(queryKeys.inbox({ kind: 'staged' }));
    expect(staged?.entries.flatMap((e) => e.files).every((f) => !f.reviewed)).toBe(true);

    rollback();
    expect(
      qc
        .getQueryData<FilesResponse>(queryKeys.files(a.worktree.id, { kind: 'working' }))
        ?.files.find((f) => f.path === file.path)?.reviewed,
    ).toBe(false);
    expect(qc.getQueryData<DiffResponse>(diffKey)?.diff.reviewed).toBe(false);
  });

  it('ignores marks for another patchHash (edited files come back unreviewed)', () => {
    const { qc, a, file } = seeded();
    applyReviewToCaches(qc, {
      projectId: a.project.id,
      scopeKind: 'working',
      path: file.path,
      patchHash: 'stale-hash',
      reviewed: true,
    });
    const files = qc.getQueryData<FilesResponse>(
      queryKeys.files(a.worktree.id, { kind: 'working' }),
    );
    expect(files?.files.find((f) => f.path === file.path)?.reviewed).toBe(false);
  });

  it('applies review.changed events without refetching', () => {
    const { qc, a, file } = seeded();
    const event: ServerEvent = {
      type: 'review.changed',
      projectId: a.project.id,
      scopeKind: 'working',
      path: file.path,
      patchHash: file.patchHash,
      reviewed: true,
    };
    const effects = collectEventEffects(qc, event, emptyEffects(), { reconnect: false });
    expect(effects.projects || effects.inbox || effects.worktrees.size > 0).toBe(false);
    const files = qc.getQueryData<FilesResponse>(
      queryKeys.files(a.worktree.id, { kind: 'working' }),
    );
    expect(files?.files.find((f) => f.path === file.path)?.reviewed).toBe(true);
  });
});

describe('SSE → cache invalidation', () => {
  it('worktree.changed invalidates only that worktree plus projects and inbox', async () => {
    const { backend, qc, a, b, diffKey } = seeded();
    backend.mutate(a.worktree.id, 'edit');
    const stateHash = backend.listFiles(a.worktree.id, { kind: 'working' }).stateHash;
    const effects = collectEventEffects(
      qc,
      { type: 'worktree.changed', projectId: a.project.id, worktreeId: a.worktree.id, stateHash },
      emptyEffects(),
      { reconnect: false },
    );
    await flushEffects(qc, effects);
    const invalid = (key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated;
    expect(invalid(queryKeys.projects())).toBe(true);
    expect(invalid(queryKeys.inbox({ kind: 'working' }))).toBe(true);
    expect(invalid(queryKeys.files(a.worktree.id, { kind: 'working' }))).toBe(true);
    expect(invalid(diffKey)).toBe(true);
    expect(invalid(queryKeys.files(b.worktree.id, { kind: 'working' }))).toBe(false);
  });

  it('patches the changed worktree into the inbox instead of refetching the whole inbox', async () => {
    const { backend, qc, a } = seeded();
    const requests: string[] = [];
    const mockFetch = createMockFetch(backend);
    const api = createApiClient({
      baseUrl: 'http://mock.local',
      fetch: (input, init) => {
        requests.push(String(input));
        return mockFetch(input, init);
      },
    });
    // Active observers, as in the app (the patch only touches inbox queries on screen).
    const unsubscribe = [
      new QueryObserver(qc, { queryKey: queryKeys.projects(), queryFn: () => api.listProjects() }),
      new QueryObserver(qc, {
        queryKey: queryKeys.inbox({ kind: 'working' }),
        queryFn: () => api.inbox({ scope: { kind: 'working' } }),
      }),
    ].map((observer) => observer.subscribe(() => {}));
    requests.length = 0;
    backend.mutate(a.worktree.id, 'edit');
    const stateHash = backend.listFiles(a.worktree.id, { kind: 'working' }).stateHash;
    const effects = collectEventEffects(
      qc,
      { type: 'worktree.changed', projectId: a.project.id, worktreeId: a.worktree.id, stateHash },
      emptyEffects(),
      { reconnect: false },
    );
    await flushEffects(qc, effects, api);
    const patched = qc.getQueryData<InboxResponse>(queryKeys.inbox({ kind: 'working' }));
    const expected = backend.inbox({ kind: 'working' }, false);
    const byId = (r: InboxResponse | undefined) =>
      Object.fromEntries((r?.entries ?? []).map((e) => [e.worktree.id, e]));
    expect(byId(patched)).toEqual(byId(expected));
    expect(requests.some((r) => r.includes('/api/inbox'))).toBe(false);
    expect(requests.some((r) => r.includes(`/api/worktrees/${a.worktree.id}/files`))).toBe(true);
    for (const fn of unsubscribe) fn();
  });

  it('skips worktree.changed when the cached stateHash already matches', () => {
    const { qc, a } = seeded();
    const projects = qc.getQueryData<{
      projects: {
        worktrees: { worktree: { id: string }; summary: { stateHash: string } | null }[];
      }[];
    }>(queryKeys.projects());
    const current =
      projects?.projects.flatMap((p) => p.worktrees).find((w) => w.worktree.id === a.worktree.id)
        ?.summary?.stateHash ?? '';
    const effects = collectEventEffects(
      qc,
      {
        type: 'worktree.changed',
        projectId: a.project.id,
        worktreeId: a.worktree.id,
        stateHash: current,
      },
      emptyEffects(),
      { reconnect: false },
    );
    expect(effects.worktrees.size).toBe(0);
    expect(effects.projects).toBe(false);
  });

  it('project and scan events refresh lists; a reconnect hello refreshes everything', () => {
    const { qc } = seeded();
    const fx = emptyEffects();
    collectEventEffects(qc, { type: 'project.added', projectId: '0123456789abcdef' }, fx, {
      reconnect: false,
    });
    expect(fx).toMatchObject({ projects: true, inbox: true, scanRoots: true, everything: false });
    const scanning = collectEventEffects(
      qc,
      {
        type: 'scan.progress',
        scanRootId: '0123456789abcdef',
        state: 'scanning',
        scannedDirs: 1,
        foundRepos: 0,
        message: null,
      },
      emptyEffects(),
      { reconnect: false },
    );
    expect(scanning.projects).toBe(false);
    const hello = { type: 'hello', version: '1', startedAt: '2026-11-08T00:00:00.000Z' } as const;
    expect(collectEventEffects(qc, hello, emptyEffects(), { reconnect: false }).everything).toBe(
      false,
    );
    expect(collectEventEffects(qc, hello, emptyEffects(), { reconnect: true }).everything).toBe(
      true,
    );
  });
});
