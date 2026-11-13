// @vitest-environment jsdom
/** The explorer's data layer (#9): `useTree`, paging into the cached prefix, event deltas. */
import {
  type ApiClient,
  ApiClientError,
  pageTreeEntries,
  type ServerEventOf,
  type TreeEntry,
  type TreeParams,
  type TreeResponse,
  treeDirIdentity,
  treeListingKey,
} from '@octopus-diff/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectEventEffects, emptyEffects, flushEffects } from '../src/api/cache.ts';
import { ApiContext } from '../src/api/queries.ts';
import {
  collectTreeDirs,
  fetchTreeDir,
  flushTreeDirs,
  loadMoreTree,
  type TreeDirEffects,
  treeKeys,
  treePaging,
  treeRetry,
  useTree,
} from '../src/api/tree.ts';

afterEach(() => {
  cleanup();
  treePaging.pageSize = 1000;
});

const W = '0123456789abcdef';

function entry(dir: string, name: string): TreeEntry {
  return {
    name,
    path: dir === '' ? name : `${dir}/${name}`,
    kind: 'file',
    mode: '100644',
    oid: 'a'.repeat(40),
    size: 1,
  };
}

/** Directories by display path (`p:` identities). */
function dirsOf(dirs: Record<string, TreeEntry[]>): Map<string, TreeEntry[]> {
  return new Map(Object.entries(dirs).map(([k, v]) => [`p:${k}`, v]));
}

/**
 * A fake daemon over in-memory directories (by `treeDirIdentity`), paging like the real one.
 * `state.pageCap` caps every page (as the daemon's byte bound does); `state.version` names the
 * listing's state, and `byVersion` gives the directories of each version.
 */
function fakeApi(
  dirs: Map<string, TreeEntry[]>,
  state: {
    version: number;
    pageCap?: number;
    byVersion?: Map<number, Map<string, TreeEntry[]>>;
  } = {
    version: 1,
  },
) {
  const calls: TreeParams[] = [];
  const answers: TreeResponse[] = [];
  const getTree = vi.fn(async (_id: string, params: TreeParams = {}): Promise<TreeResponse> => {
    calls.push(params);
    const path = params.path ?? '';
    const identity = treeDirIdentity({ path, rawPath: params.rawPath });
    const entries = (state.byVersion?.get(state.version) ?? dirs).get(identity) ?? [];
    const listKey = treeListingKey(`v${state.version}:${identity}`, entries);
    const limit = Math.min(params.limit ?? 1000, state.pageCap ?? Number.POSITIVE_INFINITY);
    const page = pageTreeEntries(entries, { ...params, limit }, { listKey });
    const response: TreeResponse = {
      worktreeId: W,
      view: params.ref ? 'tree' : 'working',
      ref: params.ref ?? null,
      commit: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      path,
      stateHash: params.ref ? null : `s${state.version}`,
      ...page,
    };
    answers.push(response);
    return response;
  });
  return { api: { getTree } as unknown as ApiClient, getTree, calls, answers, state };
}

function wrapperFor(api: ApiClient, queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
    </QueryClientProvider>
  );
}

function changed(
  dirs: ServerEventOf<'worktree.changed'>['dirs'],
): ServerEventOf<'worktree.changed'> {
  return {
    type: 'worktree.changed',
    projectId: 'fedcba9876543210',
    worktreeId: W,
    stateHash: 'next',
    ...(dirs ? { dirs } : {}),
  };
}

describe('fetchTreeDir', () => {
  const big = Array.from({ length: 50 }, (_, i) => entry('d', `f${String(i).padStart(2, '0')}`));

  it('follows cursors page by page up to the wanted count', async () => {
    // Pages of 20 (the daemon's byte bound, say) for a directory of 50: three requests.
    const fake = fakeApi(dirsOf({ d: big }), { version: 1, pageCap: 20 });
    const all = await fetchTreeDir(fake.api, W, { path: 'd' }, { want: 50 });
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[0]?.cursor).toBeUndefined();
    expect(fake.calls[1]?.cursor).toBe(fake.answers[0]?.nextCursor);
    expect(fake.calls[2]?.cursor).toBe(fake.answers[1]?.nextCursor);
    expect(fake.calls.map((c) => c.limit)).toEqual([50, 30, 10]);
    expect(all.entries).toEqual(big);
    expect(all.nextCursor).toBeNull();
    expect(all.truncated).toBe(false);
    // Fewer wanted than the directory holds: stops there, with the cursor of the rest.
    const some = await fetchTreeDir(
      fakeApi(dirsOf({ d: big }), { version: 1, pageCap: 20 }).api,
      W,
      { path: 'd' },
      { want: 30 },
    );
    expect(some.entries).toEqual(big.slice(0, 30));
    expect(some.nextCursor).not.toBeNull();
  });

  it('starts over when the listing moved between two pages, and ends with the new listing', async () => {
    const v2 = Array.from({ length: 45 }, (_, i) => entry('d', `g${String(i).padStart(2, '0')}`));
    const state = {
      version: 1,
      pageCap: 20,
      byVersion: new Map([
        [1, dirsOf({ d: big })],
        [2, dirsOf({ d: v2 })],
      ]),
    };
    const fake = fakeApi(new Map(), state);
    const original = fake.getTree.getMockImplementation();
    if (!original) throw new Error('no implementation');
    // The state moves right after the first page is answered.
    fake.getTree.mockImplementationOnce(async (id, params) => {
      const page = await original(id, params);
      state.version = 2;
      return page;
    });
    const result = await fetchTreeDir(fake.api, W, { path: 'd' }, { want: 50 });
    // Page 1 of v1, page 2 restarted (v2), then v2 from the top: 20 + 20 + 5.
    expect(fake.answers.map((a) => a.restarted)).toEqual([false, true, false, false, false]);
    expect(fake.calls[1]?.cursor).toBe(fake.answers[0]?.nextCursor);
    expect(fake.calls[2]?.cursor).toBeUndefined();
    expect(result.entries).toEqual(v2);
    expect(result.restarted).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
});

describe('useTree', () => {
  it('loads a directory, and nothing while disabled', async () => {
    const fake = fakeApi(dirsOf({ '': [entry('', 'a'), entry('', 'b')] }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = wrapperFor(fake.api, queryClient);
    const closed = renderHook(() => useTree(W, { path: 'src' }, { enabled: false }), { wrapper });
    const open = renderHook(() => useTree(W, { path: '' }), { wrapper });
    await waitFor(() =>
      expect(open.result.current.data?.entries.map((e) => e.name)).toEqual(['a', 'b']),
    );
    expect(closed.result.current.data).toBeUndefined();
    expect(fake.calls.map((c) => c.path ?? '')).toEqual(['']);
    // The working view does not go stale by time; a ref view of a branch does.
    expect(
      queryClient
        .getQueryCache()
        .find({ queryKey: treeKeys.dir(W, { path: '' }) })
        ?.isStale(),
    ).toBe(false);
  });

  it('loadMoreTree appends the next page, and a refresh keeps the loaded count', async () => {
    treePaging.pageSize = 10;
    const big = Array.from({ length: 35 }, (_, i) => entry('', `f${String(i).padStart(2, '0')}`));
    const fake = fakeApi(dirsOf({ '': big }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const hook = renderHook(() => useTree(W, { path: '' }), {
      wrapper: wrapperFor(fake.api, queryClient),
    });
    await waitFor(() => expect(hook.result.current.data?.entries).toHaveLength(10));
    await loadMoreTree(queryClient, fake.api, W, { path: '' });
    await waitFor(() => expect(hook.result.current.data?.entries).toHaveLength(20));
    expect(hook.result.current.data?.entries).toEqual(big.slice(0, 20));
    await queryClient.invalidateQueries({ queryKey: treeKeys.all(W) });
    await waitFor(() => expect(fake.calls.at(-1)?.limit).toBe(20));
    expect(hook.result.current.data?.entries).toEqual(big.slice(0, 20));
    // The listing moved: the next page restarts, and the data is that first page.
    fake.state.version = 2;
    await loadMoreTree(queryClient, fake.api, W, { path: '' });
    expect(queryClient.getQueryData<TreeResponse>(treeKeys.dir(W, { path: '' }))?.offset).toBe(0);
  });
});

describe('tree deltas', () => {
  it('collects every event of a batch and stops at all', () => {
    const effects: TreeDirEffects = new Map();
    collectTreeDirs(effects, changed({ all: false, dirs: [{ path: '' }, { path: 'src' }] }));
    collectTreeDirs(
      effects,
      changed({ all: false, dirs: [{ path: 'docs' }, { path: 'r', rawPath: 'cv8=' }] }),
    );
    expect(effects.get(W)).toEqual(new Set(['p:', 'p:src', 'p:docs', 'r:cv8=']));
    collectTreeDirs(effects, changed(undefined));
    expect(effects.get(W)).toBe('all');
    collectTreeDirs(effects, changed({ all: false, dirs: [{ path: 'x' }] }));
    expect(effects.get(W)).toBe('all');
  });

  it('refetches only the named open directories of the working view', async () => {
    const fake = fakeApi(
      dirsOf({ '': [entry('', 'a')], src: [entry('src', 's')], docs: [entry('docs', 'd')] }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = wrapperFor(fake.api, queryClient);
    const hooks = [
      renderHook(() => useTree(W, { path: '' }), { wrapper }),
      renderHook(() => useTree(W, { path: 'src' }), { wrapper }),
      renderHook(() => useTree(W, { path: 'docs' }), { wrapper }),
      renderHook(() => useTree(W, { path: 'src' }, { ref: 'b'.repeat(40) }), { wrapper }),
    ];
    for (const h of hooks) await waitFor(() => expect(h.result.current.data).toBeDefined());
    fake.calls.length = 0;
    const effects = emptyEffects();
    collectEventEffects(
      queryClient,
      changed({ all: false, dirs: [{ path: '' }, { path: 'src' }] }),
      effects,
      {
        reconnect: false,
      },
    );
    await flushEffects(queryClient, effects);
    await waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(fake.calls.map((c) => `${c.ref ?? 'working'}:${c.path ?? ''}`).sort()).toEqual([
      'working:',
      'working:src',
    ]);

    fake.calls.length = 0;
    const map: TreeDirEffects = new Map([[W, 'all']]);
    await flushTreeDirs(queryClient, map);
    await waitFor(() => expect(fake.calls).toHaveLength(3));
    expect(fake.calls.every((c) => c.ref === undefined)).toBe(true);
  });

  it('a raw directory and one literally named like its base64 never share a cache or an event', async () => {
    // The bytes `64 ff` are base64 `ZP8=`; a sibling directory is literally named `ZP8=`.
    const raw = { path: 'd\ufffd', rawPath: 'ZP8=' };
    const literal = { path: 'ZP8=' };
    const dirs = new Map([
      ['r:ZP8=', [entry('d\ufffd', 'inside-raw')]],
      ['p:ZP8=', [entry('ZP8=', 'inside-literal')]],
    ]);
    const fake = fakeApi(dirs);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = wrapperFor(fake.api, queryClient);
    const a = renderHook(() => useTree(W, raw), { wrapper });
    const b = renderHook(() => useTree(W, literal), { wrapper });
    await waitFor(() =>
      expect(a.result.current.data?.entries.map((e) => e.name)).toEqual(['inside-raw']),
    );
    await waitFor(() =>
      expect(b.result.current.data?.entries.map((e) => e.name)).toEqual(['inside-literal']),
    );
    expect(treeKeys.dir(W, raw)).not.toEqual(treeKeys.dir(W, literal));
    expect(fake.calls).toHaveLength(2);
    // An event naming the raw directory refetches it only.
    fake.calls.length = 0;
    const effects: TreeDirEffects = new Map();
    collectTreeDirs(effects, changed({ all: false, dirs: [raw] }));
    await flushTreeDirs(queryClient, effects);
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0]).toMatchObject({ path: 'd\ufffd', rawPath: 'ZP8=' });
    // And the literal one only.
    fake.calls.length = 0;
    const other: TreeDirEffects = new Map();
    collectTreeDirs(other, changed({ all: false, dirs: [literal] }));
    await flushTreeDirs(queryClient, other);
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0]?.rawPath).toBeUndefined();
    expect(fake.calls[0]?.path).toBe('ZP8=');
  });

  it('retries the retryable 409 of a worktree that changed while it was listed, not other 4xx', async () => {
    const fake = fakeApi(dirsOf({ '': [entry('', 'a')] }));
    const original = fake.getTree.getMockImplementation();
    if (!original) throw new Error('no implementation');
    const conflict = () =>
      new ApiClientError('conflict', 'the worktree changed while it was listed; retry', 409, {
        retryable: true,
      });
    fake.getTree.mockRejectedValueOnce(conflict()).mockRejectedValueOnce(conflict());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const hook = renderHook(() => useTree(W, { path: '' }), {
      wrapper: wrapperFor(fake.api, queryClient),
    });
    await waitFor(
      () => expect(hook.result.current.data?.entries.map((e) => e.name)).toEqual(['a']),
      {
        timeout: 4000,
      },
    );
    expect(fake.getTree).toHaveBeenCalledTimes(3);
    expect(original).toBeDefined();
    expect(treeRetry(0, conflict())).toBe(true);
    expect(treeRetry(3, conflict())).toBe(false);
    expect(treeRetry(0, new ApiClientError('not_found', 'no such directory', 404))).toBe(false);
    expect(treeRetry(0, new ApiClientError('conflict', 'other', 409, {}))).toBe(false);
    expect(treeRetry(0, new Error('network'))).toBe(true);
  });

  it('on all, the views of HEAD and of a branch refetch too; a commit id view does not (P3-5)', async () => {
    const fake = fakeApi(dirsOf({ '': [entry('', 'a')] }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = wrapperFor(fake.api, queryClient);
    const hooks = [
      renderHook(() => useTree(W, { path: '' }), { wrapper }),
      renderHook(() => useTree(W, { path: '' }, { ref: 'HEAD' }), { wrapper }),
      renderHook(() => useTree(W, { path: '' }, { ref: 'main' }), { wrapper }),
      renderHook(() => useTree(W, { path: '' }, { ref: 'b'.repeat(40) }), { wrapper }),
      renderHook(() => useTree('fedcba9876543210', { path: '' }, { ref: 'HEAD' }), { wrapper }),
    ];
    for (const h of hooks) await waitFor(() => expect(h.result.current.data).toBeDefined());
    fake.calls.length = 0;
    const effects = emptyEffects();
    collectEventEffects(queryClient, changed({ all: true, dirs: [] }), effects, {
      reconnect: false,
    });
    await flushEffects(queryClient, effects);
    await waitFor(() => expect(fake.calls).toHaveLength(3));
    expect(fake.calls.map((c) => c.ref ?? 'working').sort()).toEqual(['HEAD', 'main', 'working']);
    // A named-directories event leaves the ref views alone.
    fake.calls.length = 0;
    const named = emptyEffects();
    collectEventEffects(queryClient, changed({ all: false, dirs: [{ path: '' }] }), named, {
      reconnect: false,
    });
    await flushEffects(queryClient, named);
    await waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0]?.ref).toBeUndefined();
  });

  describe('an edit during a directory’s first fetch is not lost (Greptile, PR #99 round 4)', () => {
    /**
     * A fake daemon whose requests made while `gate.held` is set wait for `gate.release()`, and
     * answer the listing of the version current when they *started* (as a real request would).
     */
    function gated() {
      const v1 = dirsOf({ '': [entry('', 'old')], src: [entry('src', 'old')] });
      const v2 = dirsOf({ '': [entry('', 'new')], src: [entry('src', 'new')] });
      const state = {
        version: 1,
        byVersion: new Map([
          [1, v1],
          [2, v2],
        ]),
      };
      const fake = fakeApi(new Map(), state);
      const original = fake.getTree.getMockImplementation();
      if (!original) throw new Error('no implementation');
      const gate = { held: true, waiting: [] as Array<() => void> };
      fake.getTree.mockImplementation(async (id, params) => {
        const version = state.version;
        if (gate.held) await new Promise<void>((resolve) => gate.waiting.push(resolve));
        // Answer as of the start: the fake reads the version synchronously, so swap it back at once
        // (another request may start while this one is awaited).
        const now = state.version;
        state.version = version;
        const answer = original(id, params);
        state.version = now;
        return answer;
      });
      const release = () => {
        gate.held = false;
        for (const resolve of gate.waiting.splice(0)) resolve();
      };
      return { fake, state, gate, release };
    }

    const names = (data: TreeResponse | undefined) => data?.entries.map((e) => e.name);

    it('named directories: the held first request answers the old listing, the cache ends on the new one', async () => {
      const { fake, state, gate, release } = gated();
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrapper = wrapperFor(fake.api, queryClient);
      const hook = renderHook(() => useTree(W, { path: 'src' }), { wrapper });
      await waitFor(() => expect(gate.waiting).toHaveLength(1));
      // The edit lands and its event names `src`, while the first fetch is still running.
      state.version = 2;
      const flushed = flushTreeDirs(queryClient, new Map([[W, new Set(['p:src'])]]));
      release();
      await flushed;
      await waitFor(() => expect(names(hook.result.current.data)).toEqual(['new']));
      expect(fake.getTree.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('all: the working view and the views of HEAD and a branch end on the new listing', async () => {
      const { fake, state, gate, release } = gated();
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrapper = wrapperFor(fake.api, queryClient);
      const hooks = [
        renderHook(() => useTree(W, { path: '' }), { wrapper }),
        renderHook(() => useTree(W, { path: '' }, { ref: 'HEAD' }), { wrapper }),
        renderHook(() => useTree(W, { path: '' }, { ref: 'main' }), { wrapper }),
      ];
      await waitFor(() => expect(gate.waiting).toHaveLength(3));
      state.version = 2;
      const effects = emptyEffects();
      collectEventEffects(queryClient, changed({ all: true, dirs: [] }), effects, {
        reconnect: false,
      });
      const flushed = flushEffects(queryClient, effects);
      release();
      await flushed;
      for (const [i, h] of hooks.entries()) {
        await waitFor(() => expect(names(h.result.current.data), `view ${i}`).toEqual(['new']));
      }
    });

    it('a refetch over existing data is replaced as before (the old answer never wins)', async () => {
      const { fake, state, gate, release } = gated();
      gate.held = false;
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const hook = renderHook(() => useTree(W, { path: 'src' }), {
        wrapper: wrapperFor(fake.api, queryClient),
      });
      await waitFor(() => expect(names(hook.result.current.data)).toEqual(['old']));
      gate.held = true;
      void queryClient.invalidateQueries({ queryKey: treeKeys.dir(W, { path: 'src' }) });
      await waitFor(() => expect(gate.waiting).toHaveLength(1));
      state.version = 2;
      const flushed = flushTreeDirs(queryClient, new Map([[W, new Set(['p:src'])]]));
      release();
      await flushed;
      await waitFor(() => expect(names(hook.result.current.data)).toEqual(['new']));
    });

    it('load more during an edit: the old page never wins, and the loaded count is kept', async () => {
      treePaging.pageSize = 10;
      const many = (tag: string) =>
        Array.from({ length: 35 }, (_, i) => entry('', `${tag}${String(i).padStart(2, '0')}`));
      const state = {
        version: 1,
        byVersion: new Map([
          [1, dirsOf({ '': many('old') })],
          [2, dirsOf({ '': many('new') })],
        ]),
      };
      const fake = fakeApi(new Map(), state);
      const original = fake.getTree.getMockImplementation();
      if (!original) throw new Error('no implementation');
      const gate = { held: false, waiting: [] as Array<() => void> };
      fake.getTree.mockImplementation(async (id, params) => {
        const version = state.version;
        if (gate.held) await new Promise<void>((resolve) => gate.waiting.push(resolve));
        const now = state.version;
        state.version = version;
        const answer = original(id, params);
        state.version = now;
        return answer;
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const hook = renderHook(() => useTree(W, { path: '' }), {
        wrapper: wrapperFor(fake.api, queryClient),
      });
      await waitFor(() => expect(hook.result.current.data?.entries).toHaveLength(10));
      gate.held = true;
      const more = loadMoreTree(queryClient, fake.api, W, { path: '' });
      await waitFor(() => expect(gate.waiting).toHaveLength(1));
      state.version = 2;
      const flushed = flushTreeDirs(queryClient, new Map([[W, new Set(['p:'])]]));
      await waitFor(() => expect(gate.waiting).toHaveLength(2));
      gate.held = false;
      for (const resolve of gate.waiting.splice(0)) resolve();
      await Promise.all([more, flushed]);
      await waitFor(() => {
        const data = hook.result.current.data;
        expect(data?.entries.map((e) => e.name)).toEqual(
          many('new')
            .slice(0, 20)
            .map((e) => e.name),
        );
      });
    });

    it('load more answered after the refresh: the refresh stays', async () => {
      treePaging.pageSize = 10;
      const many = (tag: string) =>
        Array.from({ length: 35 }, (_, i) => entry('', `${tag}${String(i).padStart(2, '0')}`));
      const state = {
        version: 1,
        byVersion: new Map([
          [1, dirsOf({ '': many('old') })],
          [2, dirsOf({ '': many('new') })],
        ]),
      };
      const fake = fakeApi(new Map(), state);
      const original = fake.getTree.getMockImplementation();
      if (!original) throw new Error('no implementation');
      const gate = { held: false, waiting: [] as Array<() => void> };
      fake.getTree.mockImplementation(async (id, params) => {
        const version = state.version;
        if (gate.held) await new Promise<void>((resolve) => gate.waiting.push(resolve));
        const now = state.version;
        state.version = version;
        const answer = original(id, params);
        state.version = now;
        return answer;
      });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const hook = renderHook(() => useTree(W, { path: '' }), {
        wrapper: wrapperFor(fake.api, queryClient),
      });
      await waitFor(() => expect(hook.result.current.data?.entries).toHaveLength(10));
      gate.held = true;
      const more = loadMoreTree(queryClient, fake.api, W, { path: '' });
      await waitFor(() => expect(gate.waiting).toHaveLength(1));
      state.version = 2;
      const flushed = flushTreeDirs(queryClient, new Map([[W, new Set(['p:'])]]));
      await waitFor(() => expect(gate.waiting).toHaveLength(2));
      const [page, refresh] = gate.waiting.splice(0);
      gate.held = false;
      refresh?.();
      const fresh = many('new')
        .slice(0, 20)
        .map((e) => e.name);
      await waitFor(() =>
        expect(hook.result.current.data?.entries.map((e) => e.name)).toEqual(fresh),
      );
      page?.();
      await Promise.all([more, flushed]);
      expect(hook.result.current.data?.entries.map((e) => e.name)).toEqual(fresh);
      expect(
        queryClient
          .getQueryData<TreeResponse>(treeKeys.dir(W, { path: '' }))
          ?.entries.map((e) => e.name),
      ).toEqual(fresh);
    });
  });
});
