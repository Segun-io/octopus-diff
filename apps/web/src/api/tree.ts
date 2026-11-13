/**
 * The file explorer's data layer (#9). No pane uses it yet: this is what a future explorer builds
 * on (docs/reports/file-explorer-foundation.md).
 *
 * - **One query per open directory**: `['tree', worktreeId, ref ?? '', rawPath ?? path]`. A
 *   directory's data is one `TreeResponse` whose `entries` is the *loaded prefix* of its listing
 *   (the `files.ts` pattern, #42): a refresh asks for as many entries as were loaded, so a long
 *   directory keeps what the user scrolled to. Pages after the first follow `nextCursor`; a
 *   `restarted` page (the state moved in between) starts over.
 * - **Lazy**: only directories someone expands are asked for (`useTree(..., { enabled })`); a
 *   tree component adds their entries to its model as they arrive (see
 *   `apps/web/scripts/tree-perf.ts` for the measured design).
 * - **Freshness**: the working view (no `ref`) never goes stale by time; `worktree.changed`
 *   invalidates exactly the directories its `dirs` names (`collectTreeDirs` / `flushTreeDirs`),
 *   every working-view directory of the worktree when it says `all` or carries no `dirs` (older
 *   daemons, replays). A tree view of a full commit id never changes; one of a branch or `HEAD`
 *   is refetched on focus after `TREE_REF_STALE_MS`.
 */
import {
  type ApiClient,
  type ServerEventOf,
  TREE_PAGE_MAX,
  type TreeResponse,
} from '@octopus-diff/contracts';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from './queries.ts';

export const treePaging = {
  /** Entries per page the web asks for (a directory rarely has more). */
  pageSize: 1000,
  /** Restarts (the state moved mid-paging) before the restarted page is kept as it is. */
  restarts: 3,
};

/** How long a tree view of a branch or `HEAD` is fresh. */
export const TREE_REF_STALE_MS = 30_000;

const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface TreeDir {
  path: string;
  rawPath?: string | undefined;
}

export const treeKeys = {
  /** Every directory of a worktree, in every view. */
  all: (worktreeId: string) => ['tree', worktreeId] as const,
  /** Every directory of a worktree's working view (`ref` absent). */
  working: (worktreeId: string) => ['tree', worktreeId, ''] as const,
  dir: (worktreeId: string, dir: TreeDir, ref?: string) =>
    ['tree', worktreeId, ref ?? '', dir.rawPath ?? dir.path] as const,
};

const wanted = new WeakMap<QueryClient, Map<string, number>>();

function wantedMap(queryClient: QueryClient): Map<string, number> {
  let map = wanted.get(queryClient);
  if (!map) {
    map = new Map();
    wanted.set(queryClient, map);
  }
  return map;
}

function wantKey(worktreeId: string, dir: TreeDir, ref?: string): string {
  return JSON.stringify(treeKeys.dir(worktreeId, dir, ref));
}

/**
 * The first `want` entries of a directory (at least one page), following cursors; starts over when
 * a page says its listing moved (`restarted`), at most `treePaging.restarts` times.
 */
export async function fetchTreeDir(
  api: ApiClient,
  worktreeId: string,
  dir: TreeDir,
  options: { ref?: string; want?: number; signal?: AbortSignal } = {},
): Promise<TreeResponse> {
  const target = Math.max(1, options.want ?? treePaging.pageSize);
  const base = {
    path: dir.path,
    ...(dir.rawPath !== undefined ? { rawPath: dir.rawPath } : {}),
    ...(options.ref !== undefined ? { ref: options.ref } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  for (let attempt = 0; ; attempt++) {
    const first = await api.getTree(worktreeId, {
      ...base,
      limit: Math.min(target, TREE_PAGE_MAX),
    });
    if (!first.nextCursor || first.entries.length >= target) return first;
    const entries = [...first.entries];
    let last = first;
    let restarted = false;
    while (entries.length < target && last.nextCursor) {
      const page = await api.getTree(worktreeId, {
        ...base,
        limit: Math.min(target - entries.length, TREE_PAGE_MAX),
        cursor: last.nextCursor,
      });
      if (page.restarted) {
        restarted = true;
        last = page;
        break;
      }
      entries.push(...page.entries);
      last = page;
    }
    if (!restarted) {
      return {
        ...first,
        entries,
        nextCursor: last.nextCursor,
        truncated: last.nextCursor !== null,
      };
    }
    if (attempt + 1 >= treePaging.restarts) return { ...last, restarted: false };
  }
}

export function treeQueryOptions(
  api: ApiClient,
  queryClient: QueryClient,
  worktreeId: string,
  dir: TreeDir,
  ref?: string,
) {
  return {
    queryKey: treeKeys.dir(worktreeId, dir, ref),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      fetchTreeDir(api, worktreeId, dir, {
        ...(ref !== undefined ? { ref } : {}),
        want: Math.max(
          treePaging.pageSize,
          wantedMap(queryClient).get(wantKey(worktreeId, dir, ref)) ?? 0,
        ),
        signal,
      }),
    // The working view follows events; a commit's tree never changes; a ref's may move.
    staleTime:
      ref === undefined || FULL_OID.test(ref) ? Number.POSITIVE_INFINITY : TREE_REF_STALE_MS,
  };
}

/**
 * One directory of the file explorer: the working view, or `ref`'s tree. `enabled: false` for a
 * collapsed directory: nothing is fetched until it opens.
 */
export function useTree(
  worktreeId: string | null,
  dir: TreeDir,
  options: { ref?: string; enabled?: boolean } = {},
) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useQuery({
    ...treeQueryOptions(api, queryClient, worktreeId ?? '', dir, options.ref),
    enabled: worktreeId !== null && (options.enabled ?? true),
  });
}

/**
 * Loads more of a directory into its cached prefix (scrolling a long directory). Records the
 * wanted count, so a refresh keeps it. Returns the cached data.
 */
export async function loadMoreTree(
  queryClient: QueryClient,
  api: ApiClient,
  worktreeId: string,
  dir: TreeDir,
  options: { ref?: string; count?: number } = {},
): Promise<TreeResponse | undefined> {
  const key = treeKeys.dir(worktreeId, dir, options.ref);
  const data = queryClient.getQueryData<TreeResponse>(key);
  if (!data?.nextCursor) return data;
  const want = data.entries.length + (options.count ?? treePaging.pageSize);
  const map = wantedMap(queryClient);
  const k = wantKey(worktreeId, dir, options.ref);
  map.set(k, Math.max(map.get(k) ?? 0, want));
  const page = await api.getTree(worktreeId, {
    path: dir.path,
    ...(dir.rawPath !== undefined ? { rawPath: dir.rawPath } : {}),
    ...(options.ref !== undefined ? { ref: options.ref } : {}),
    limit: Math.min(want - data.entries.length, TREE_PAGE_MAX),
    cursor: data.nextCursor,
  });
  const current = queryClient.getQueryData<TreeResponse>(key);
  // A refresh replaced the data meanwhile: it wins (and fetches the wanted count itself).
  if (current !== data) return current;
  const next: TreeResponse = page.restarted
    ? page
    : {
        ...data,
        entries: [...data.entries, ...page.entries],
        nextCursor: page.nextCursor,
        truncated: page.nextCursor !== null,
      };
  queryClient.setQueryData(key, next);
  return next;
}

// --- events -------------------------------------------------------------------------------------

/** Directories to refresh per worktree, from the events of one batch: a set of keys, or `all`. */
export type TreeDirEffects = Map<string, Set<string> | 'all'>;

/**
 * Folds one `worktree.changed` into the batch's tree effects. Every event of the batch counts
 * (not only the latest per worktree): two edits in one batch may name different directories.
 */
export function collectTreeDirs(
  effects: TreeDirEffects,
  event: ServerEventOf<'worktree.changed'>,
): void {
  const id = event.worktreeId;
  const held = effects.get(id);
  if (held === 'all') return;
  if (!event.dirs || event.dirs.all) {
    effects.set(id, 'all');
    return;
  }
  const set = held ?? new Set<string>();
  for (const d of event.dirs.dirs) set.add(d.rawPath ?? d.path);
  effects.set(id, set);
}

/**
 * Refetches the working-view directories the batch named (only those someone observes refetch
 * now; the rest are marked stale). Tree views (`ref`) are left alone: a commit does not change,
 * and a branch's view has its own staleness.
 */
export async function flushTreeDirs(
  queryClient: QueryClient,
  effects: TreeDirEffects,
): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  for (const [worktreeId, dirs] of effects) {
    if (dirs === 'all') {
      tasks.push(queryClient.invalidateQueries({ queryKey: treeKeys.working(worktreeId) }));
      continue;
    }
    for (const dir of dirs) {
      tasks.push(
        queryClient.invalidateQueries({
          queryKey: ['tree', worktreeId, '', dir],
          exact: true,
        }),
      );
    }
  }
  await Promise.all(tasks);
}
