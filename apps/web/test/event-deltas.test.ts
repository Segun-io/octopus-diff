/**
 * #51: `worktree.changed` carries the worktree's row and changed paths. The web applies the row to
 * the projects list (no `/api/projects` refetch), asks the daemon for just the changed inbox rows
 * (`/api/inbox?worktreeIds=`), refetches the open worktree's file list and only the diffs whose own
 * file moved, and falls back to the old invalidation for an older daemon. Requests are counted
 * against the mock backend through the real cache code.
 */
import {
  type ApiClient,
  createApiClient,
  type DiffScope,
  type FilesResponse,
  type InboxResponse,
  type ProjectsResponse,
  type ServerEvent,
  scopeKey,
} from '@octopus-diff/contracts';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { MockBackend, type MockBackendOptions } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { collectEventEffects, emptyEffects, flushEffects } from '../src/api/cache.ts';
import {
  type DiffQueryData,
  diffViewKey,
  inboxQueryOptions,
  projectsQueryOptions,
  queryKeys,
} from '../src/api/queries.ts';

const WORKING: DiffScope = { kind: 'working' };
const BRANCH_ALL: DiffScope = { kind: 'branch', includeWorking: true };

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

interface Gate {
  /** Holds the next response of a request whose URL includes `match` until `release()`. */
  hold(match: string): { release: () => void; started: Promise<void> };
}

function setup(options: MockBackendOptions = {}) {
  const backend = new MockBackend({ dataset: 'demo', ...options });
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const requests: string[] = [];
  const mockFetch = createMockFetch(backend);
  const holds: Array<{ match: string; wait: Promise<void>; started: () => void }> = [];
  const api: ApiClient = createApiClient({
    baseUrl: 'http://mock.local',
    fetch: async (input, init) => {
      const url = String(input);
      requests.push(url);
      // The answer is computed now (the daemon's state at request time) and delivered later.
      const response = await mockFetch(url, init);
      const i = holds.findIndex((h) => url.includes(h.match));
      if (i >= 0) {
        const [h] = holds.splice(i, 1);
        h?.started();
        await h?.wait;
      }
      return response;
    },
  });
  const gate: Gate = {
    hold(match) {
      let release = () => {};
      let started = () => {};
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const startedP = new Promise<void>((resolve) => {
        started = resolve;
      });
      holds.push({ match, wait, started });
      return { release, started: startedP };
    },
  };
  const events: ServerEvent[] = [];
  cleanups.push(backend.subscribe((e) => events.push(e)));
  /** Keeps a query on screen, as a mounted component would. */
  const observe = (options: ConstructorParameters<typeof QueryObserver>[1]) => {
    const observer = new QueryObserver(qc, options);
    cleanups.push(observer.subscribe(() => {}));
    return observer;
  };
  const projectsOnScreen = () => observe(projectsQueryOptions(api, qc));
  const inboxOnScreen = (scope: DiffScope) => observe(inboxQueryOptions(api, qc, scope));
  const filesOnScreen = (worktreeId: string, scope: DiffScope) =>
    observe({
      queryKey: queryKeys.files(worktreeId, scope),
      queryFn: ({ signal }) => api.listFiles(worktreeId, { scope, signal }),
    });
  const diffOnScreen = (worktreeId: string, path: string, scope: DiffScope) => {
    const params = { ignoreWhitespace: false };
    const observer = new QueryObserver<DiffQueryData>(qc, {
      queryKey: queryKeys.diff({ worktreeId, path }, scope, params),
      queryFn: async ({ signal }): Promise<DiffQueryData> => ({
        ...(await api.getDiff(worktreeId, { scope, path, signal })),
        view: diffViewKey(params),
        params,
      }),
    });
    cleanups.push(observer.subscribe(() => {}));
    return observer;
  };
  /** Mutates the backend and runs the events it emitted through the cache, as `useServerEvents`. */
  const edit = async (...args: Parameters<MockBackend['mutate']>) => {
    const mark = events.length;
    backend.mutate(...args);
    const batch = events.slice(mark);
    await deliver(batch);
    return batch;
  };
  const deliver = async (batch: ServerEvent[]) => {
    const effects = emptyEffects();
    for (const e of batch) collectEventEffects(qc, e, effects, { reconnect: false });
    await flushEffects(qc, effects, api);
  };
  const settle = async () => {
    for (let i = 0; i < 20 && qc.isFetching() > 0; i++) await new Promise((r) => setTimeout(r, 5));
  };
  const rowOf = (worktreeId: string) =>
    qc
      .getQueryData<ProjectsResponse>(queryKeys.projects())
      ?.projects.flatMap((p) => p.worktrees)
      .find((w) => w.worktree.id === worktreeId);
  const worktrees = backend.listProjects().projects.flatMap((p) => p.worktrees);
  const dirty = backend.inbox(WORKING, false).entries;
  return {
    backend,
    qc,
    api,
    gate,
    requests,
    events,
    projectsOnScreen,
    inboxOnScreen,
    filesOnScreen,
    diffOnScreen,
    edit,
    deliver,
    settle,
    rowOf,
    worktrees,
    dirty,
  };
}

const only = (requests: string[], part: string) => requests.filter((r) => r.includes(part));

describe('worktree.changed with a delta (#51)', () => {
  it('applies the row to the projects list: an edit elsewhere costs no request', async () => {
    const t = setup();
    t.projectsOnScreen();
    await t.settle();
    const [a] = t.dirty;
    if (!a) throw new Error('no dirty worktree');
    t.requests.length = 0;
    const [event] = await t.edit(a.worktree.id, 'edit');
    expect(event?.type === 'worktree.changed' && event.summary).toBeTruthy();
    expect(t.requests).toEqual([]);
    const expected = t.backend
      .listProjects()
      .projects.flatMap((p) => p.worktrees)
      .find((w) => w.worktree.id === a.worktree.id);
    expect(t.rowOf(a.worktree.id)).toEqual(expected);
    expect(t.qc.getQueryState(queryKeys.projects())?.isInvalidated).toBe(false);
  });

  it("asks the daemon for just the changed worktree's inbox row", async () => {
    const t = setup();
    t.projectsOnScreen();
    t.inboxOnScreen(WORKING);
    await t.settle();
    const [a] = t.dirty;
    if (!a) throw new Error('no dirty worktree');
    t.requests.length = 0;
    await t.edit(a.worktree.id, 'edit');
    await t.settle();
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).toContain('/api/inbox?');
    expect(t.requests[0]).toContain(`worktreeIds=${a.worktree.id}`);
    const byId = (r: InboxResponse | undefined) =>
      Object.fromEntries((r?.entries ?? []).map((e) => [e.worktree.id, e]));
    expect(byId(t.qc.getQueryData<InboxResponse>(queryKeys.inbox(WORKING)))).toEqual(
      byId(t.backend.inbox(WORKING, false)),
    );
  });

  it('a worktree that became clean leaves the inbox; one that became dirty joins it', async () => {
    const t = setup();
    t.projectsOnScreen();
    t.inboxOnScreen(WORKING);
    await t.settle();
    const clean = t.worktrees.find((w) => !t.dirty.some((d) => d.worktree.id === w.worktree.id));
    const [a] = t.dirty;
    if (!clean || !a) throw new Error('fixture');
    await t.edit(clean.worktree.id, 'add');
    // Revert every file of `a`, one edit each.
    for (const f of [...a.files]) await t.edit(a.worktree.id, 'revert', f.path);
    await t.settle();
    const ids = (t.qc.getQueryData<InboxResponse>(queryKeys.inbox(WORKING))?.entries ?? []).map(
      (e) => e.worktree.id,
    );
    expect(ids).toContain(clean.worktree.id);
    expect(
      t.backend
        .inbox(WORKING, false)
        .entries.map((e) => e.worktree.id)
        .sort(),
    ).toEqual([...ids].sort());
  });

  it('the open worktree: the file list refetches once; the open diff only when its file moved', async () => {
    const t = setup();
    const [a] = t.dirty;
    const open = a?.files.find((f) => f.status !== 'untracked' && !f.binary);
    const other = a?.files.find((f) => f !== open && f.status !== 'untracked' && !f.binary);
    if (!a || !open || !other) throw new Error('fixture');
    const wid = a.worktree.id;
    t.projectsOnScreen();
    t.filesOnScreen(wid, WORKING);
    const diff = t.diffOnScreen(wid, open.path, WORKING);
    await t.settle();
    const before = diff.getCurrentResult().data;
    expect(before?.diff.path).toBe(open.path);

    // Another file of the open worktree: its list moves, the open diff does not.
    t.requests.length = 0;
    await t.edit(wid, 'edit', other.path);
    await t.settle();
    expect(only(t.requests, `/api/worktrees/${wid}/files`)).toHaveLength(1);
    expect(only(t.requests, '/diff')).toHaveLength(0);
    expect(only(t.requests, '/api/projects')).toHaveLength(0);
    expect(diff.getCurrentResult().data).toBe(before);

    // The open file itself: that diff refetches.
    t.requests.length = 0;
    await t.edit(wid, 'edit', open.path);
    await t.settle();
    expect(only(t.requests, `/api/worktrees/${wid}/files`)).toHaveLength(1);
    expect(only(t.requests, `/api/worktrees/${wid}/diff`)).toHaveLength(1);
    expect(only(t.requests, '/api/projects')).toHaveLength(0);
    expect(diff.getCurrentResult().data?.diff.patchHash).not.toBe(before?.diff.patchHash);
    const listed = t.qc
      .getQueryData<FilesResponse>(queryKeys.files(wid, WORKING))
      ?.files.find((f) => f.path === open.path);
    expect(diff.getCurrentResult().data?.diff.patchHash).toBe(listed?.patchHash);
  });

  it('a scope the event has no paths for decides by the refetched list (All on branch)', async () => {
    const t = setup();
    // A worktree with a committed file to open and an uncommitted text file to edit.
    const pick = t.dirty
      .map((e) => {
        const listed = t.backend.listFiles(e.worktree.id, BRANCH_ALL).files;
        const open = listed.find((f) => !f.binary);
        const other = e.files.find(
          (f) =>
            !f.binary &&
            f.status === 'modified' &&
            !listed.some((l) => l.path === f.path) &&
            !f.path.endsWith('.png'),
        );
        return { wid: e.worktree.id, open, other };
      })
      .find((x) => x.open && x.other);
    if (!pick?.open || !pick.other) throw new Error('fixture');
    const { wid, open, other } = pick;
    t.projectsOnScreen();
    t.filesOnScreen(wid, BRANCH_ALL);
    const diff = t.diffOnScreen(wid, open.path, BRANCH_ALL);
    await t.settle();
    const before = diff.getCurrentResult().data;
    t.requests.length = 0;
    const [event] = await t.edit(wid, 'edit', other.path);
    // The mock's paths are for `working`, not this scope: no shortcut, the list decides.
    expect(event?.type === 'worktree.changed' && scopeKey(event.paths?.scope ?? WORKING)).toBe(
      'working',
    );
    await t.settle();
    expect(only(t.requests, `/api/worktrees/${wid}/files`)).toHaveLength(1);
    expect(only(t.requests, '/diff')).toHaveLength(0);
    expect(diff.getCurrentResult().data).toBe(before);
  });

  it('an older projects answer that lands after the row was applied does not undo it', async () => {
    const t = setup();
    t.projectsOnScreen();
    await t.settle();
    const [a] = t.dirty;
    if (!a) throw new Error('fixture');
    // A projects refetch (another event's) is in flight with the state before the edit.
    const held = t.gate.hold('/api/projects');
    const refetch = t.qc.invalidateQueries({ queryKey: queryKeys.projects() });
    await held.started;
    await new Promise((r) => setTimeout(r, 5)); // a later `updatedAt` for the edit
    await t.edit(a.worktree.id, 'edit');
    const applied = t.rowOf(a.worktree.id);
    held.release();
    await refetch;
    expect(t.rowOf(a.worktree.id)?.summary?.stateHash).toBe(applied?.summary?.stateHash);
  });

  it('drops a row older than the cached one (events delivered out of order)', async () => {
    const t = setup();
    t.projectsOnScreen();
    await t.settle();
    const [a] = t.dirty;
    if (!a) throw new Error('fixture');
    const mark = t.events.length;
    t.backend.mutate(a.worktree.id, 'edit');
    await new Promise((r) => setTimeout(r, 5));
    t.backend.mutate(a.worktree.id, 'edit');
    const [first, second] = t.events.slice(mark);
    if (!first || !second) throw new Error('no events');
    await t.deliver([second]);
    await t.deliver([first]);
    expect(t.rowOf(a.worktree.id)?.summary?.stateHash).toBe(
      second.type === 'worktree.changed' ? second.stateHash : '',
    );
  });

  it('a worktree the cached list does not have (removed meanwhile) falls back to a refetch', async () => {
    const t = setup();
    t.projectsOnScreen();
    await t.settle();
    const [a] = t.dirty;
    if (!a) throw new Error('fixture');
    // The cached list no longer has the worktree.
    t.qc.setQueryData<ProjectsResponse>(queryKeys.projects(), (data) =>
      data
        ? {
            projects: data.projects.map((p) => ({
              ...p,
              worktrees: p.worktrees.filter((w) => w.worktree.id !== a.worktree.id),
            })),
          }
        : data,
    );
    t.requests.length = 0;
    await t.edit(a.worktree.id, 'edit');
    expect(only(t.requests, '/api/projects')).toHaveLength(1);
  });

  it('the inbox delta waits for a full inbox fetch in flight, then lands on top of it', async () => {
    const t = setup();
    t.projectsOnScreen();
    t.inboxOnScreen(WORKING);
    await t.settle();
    const [a] = t.dirty;
    if (!a) throw new Error('fixture');
    const held = t.gate.hold('/api/inbox');
    const full = t.qc.invalidateQueries({ queryKey: queryKeys.inboxAll() });
    await held.started;
    t.requests.length = 0;
    const flushed = t.edit(a.worktree.id, 'edit');
    await new Promise((r) => setTimeout(r, 20));
    // Not asked while the full fetch (the state before the edit) is still out.
    expect(only(t.requests, 'worktreeIds=')).toHaveLength(0);
    held.release();
    await full;
    await flushed;
    await t.settle();
    expect(only(t.requests, 'worktreeIds=')).toHaveLength(1);
    const entry = t.qc
      .getQueryData<InboxResponse>(queryKeys.inbox(WORKING))
      ?.entries.find((e) => e.worktree.id === a.worktree.id);
    expect(entry?.summary.stateHash).toBe(t.rowOf(a.worktree.id)?.summary?.stateHash);
  });
});

describe('worktree.changed from an older daemon (no delta)', () => {
  it('refetches the projects list and the whole inbox, as before', async () => {
    const t = setup({ legacyEvents: true });
    t.projectsOnScreen();
    t.inboxOnScreen(WORKING);
    await t.settle();
    const [a] = t.dirty;
    if (!a) throw new Error('fixture');
    t.requests.length = 0;
    const [event] = await t.edit(a.worktree.id, 'edit');
    await t.settle();
    expect(event?.type === 'worktree.changed' && event.summary).toBeUndefined();
    expect(only(t.requests, '/api/projects')).toHaveLength(1);
    expect(only(t.requests, '/api/inbox')).toHaveLength(1);
    expect(only(t.requests, 'worktreeIds=')).toHaveLength(0);
    expect(t.rowOf(a.worktree.id)?.summary?.stateHash).toBe(
      event?.type === 'worktree.changed' ? event.stateHash : '',
    );
  });
});
