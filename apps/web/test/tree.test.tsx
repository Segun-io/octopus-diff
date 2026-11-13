// @vitest-environment jsdom
/** The explorer's data layer (#9): `useTree`, paging into the cached prefix, event deltas. */
import {
  type ApiClient,
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
});
