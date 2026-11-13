// @vitest-environment jsdom
/** The explorer's data layer (#9): `useTree`, paging into the cached prefix, event deltas. */
import {
  type ApiClient,
  pageTreeEntries,
  type ServerEventOf,
  type TreeEntry,
  type TreeParams,
  type TreeResponse,
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

/** A fake daemon over in-memory directories, paging like the real one. */
function fakeApi(dirs: Map<string, TreeEntry[]>, state = { version: 1 }) {
  const calls: TreeParams[] = [];
  const getTree = vi.fn(async (_id: string, params: TreeParams = {}): Promise<TreeResponse> => {
    calls.push(params);
    const path = params.path ?? '';
    const entries = dirs.get(path) ?? [];
    const listKey = treeListingKey(`v${state.version}:${path}`, entries);
    const page = pageTreeEntries(entries, params, { listKey });
    return {
      worktreeId: W,
      view: params.ref ? 'tree' : 'working',
      ref: params.ref ?? null,
      commit: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      path,
      stateHash: params.ref ? null : `s${state.version}`,
      ...page,
    };
  });
  return { api: { getTree } as unknown as ApiClient, getTree, calls, state };
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
  it('follows cursors up to the wanted count and starts over when the listing moved', async () => {
    const big = Array.from({ length: 50 }, (_, i) => entry('d', `f${String(i).padStart(2, '0')}`));
    const fake = fakeApi(new Map([['d', big]]));
    const all = await fetchTreeDir(fake.api, W, { path: 'd' }, { want: 50 });
    expect(all.entries).toEqual(big);
    expect(all.nextCursor).toBeNull();

    // The listing moves between the first and second page: one restart, then a whole answer.
    let n = 0;
    const moving = fakeApi(new Map([['d', big]]));
    moving.getTree.mockImplementationOnce(async (id, params) => {
      n++;
      const first = await fakeApi(new Map([['d', big]]), { version: 0 }).api.getTree(id, params);
      return first;
    });
    const restarted = await fetchTreeDir(moving.api, W, { path: 'd' }, { want: 50 });
    expect(n).toBe(1);
    expect(restarted.entries).toEqual(big);
  });
});

describe('useTree', () => {
  it('loads a directory, and nothing while disabled', async () => {
    const fake = fakeApi(new Map([['', [entry('', 'a'), entry('', 'b')]]]));
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
    const fake = fakeApi(new Map([['', big]]));
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
    expect(effects.get(W)).toEqual(new Set(['', 'src', 'docs', 'cv8=']));
    collectTreeDirs(effects, changed(undefined));
    expect(effects.get(W)).toBe('all');
    collectTreeDirs(effects, changed({ all: false, dirs: [{ path: 'x' }] }));
    expect(effects.get(W)).toBe('all');
  });

  it('refetches only the named open directories of the working view', async () => {
    const dirs = new Map([
      ['', [entry('', 'a')]],
      ['src', [entry('src', 's')]],
      ['docs', [entry('docs', 'd')]],
    ]);
    const fake = fakeApi(dirs);
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
});
