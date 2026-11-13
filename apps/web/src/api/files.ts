/**
 * Paged file lists in the web (#42). The files query keeps one `FilesResponse` per (worktree,
 * scope) whose `files` is the *loaded prefix* of the daemon's list in the paging order
 * (`compareFileOrder`, the list's display order), `nextCursor` the next page and `total` / `counts`
 * the whole list's. Everything that reads `files` (the list, `j`/`k`, review patches, event deltas)
 * keeps working on the prefix; what must see the whole list asks the daemon (`n`: `nextOnServer`,
 * the palette: `q`, bulk review: no `paths`).
 *
 * - The query function fetches as many files as were loaded or asked for (`wantFiles`), at
 *   least one page: a refresh after an edit keeps what the user scrolled to and the selection.
 *   Pages after the first follow `nextCursor`; a `restarted` page (the state moved in between)
 *   starts over, so the prefix is always one state's.
 * - `ensureFiles` loads more pages into the cached prefix (scrolling, a jump to a file further
 *   down); a refresh that replaced the data meanwhile wins, and the load goes on from it.
 * - An older daemon (no `total`) answers with the whole list: nothing to page.
 */
import {
  type ApiClient,
  type DiffScope,
  FILES_PAGE_DEFAULT,
  FILES_PAGE_MAX,
  type FileListCounts,
  type FilesResponse,
  INBOX_FILES_PER_WORKTREE,
} from '@octopus-diff/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './queries.ts';

/**
 * The page size the web asks for, and the files per inbox row (the daemon's default unless a test
 * makes them small).
 */
export const filesPaging = {
  pageSize: FILES_PAGE_DEFAULT,
  restarts: 3,
  inboxFiles: INBOX_FILES_PER_WORKTREE,
  /** A page that fails is retried after these delays, then only on request (review of PR #97). */
  retryDelaysMs: [1000, 3000, 10_000] as readonly number[],
};

/** The inbox request's `filesLimit`: absent while it is the daemon's default. */
export function inboxFilesParam(): { filesLimit?: number } {
  return filesPaging.inboxFiles === INBOX_FILES_PER_WORKTREE
    ? {}
    : { filesLimit: filesPaging.inboxFiles };
}

/** The cached list holds every file of the list (an older daemon's always does). */
export function filesComplete(data: Pick<FilesResponse, 'nextCursor'> | undefined): boolean {
  return data !== undefined && !data.nextCursor;
}

/** Files of the whole list (the loaded count for an older daemon). */
export function filesTotal(data: Pick<FilesResponse, 'files' | 'total' | 'offset'>): number {
  return data.total ?? data.files.length;
}

const wanted = new WeakMap<QueryClient, Map<string, number>>();

function wantedMap(queryClient: QueryClient): Map<string, number> {
  let map = wanted.get(queryClient);
  if (!map) {
    map = new Map();
    wanted.set(queryClient, map);
  }
  return map;
}

function keyOf(worktreeId: string, scope: DiffScope): string {
  return JSON.stringify(queryKeys.files(worktreeId, scope));
}

/** At least `count` files of this list are wanted: the next fetch of its query loads them. */
export function wantFiles(
  queryClient: QueryClient,
  worktreeId: string,
  scope: DiffScope,
  count: number,
): void {
  const map = wantedMap(queryClient);
  const key = keyOf(worktreeId, scope);
  map.set(key, Math.max(map.get(key) ?? 0, count));
}

/**
 * The first `want` files of the list (at least one page), following cursors; starts over when a
 * page says the state moved (`restarted`), at most `filesPaging.restarts` times, then keeps the
 * restarted page's state.
 */
export async function fetchFileList(
  api: ApiClient,
  worktreeId: string,
  scope: DiffScope,
  want: number,
  signal?: AbortSignal,
): Promise<FilesResponse> {
  const target = Math.max(1, want);
  for (let attempt = 0; ; attempt++) {
    const first = await api.listFiles(worktreeId, {
      scope,
      limit: Math.min(target, FILES_PAGE_MAX),
      ...(signal ? { signal } : {}),
    });
    // An older daemon (no paging) answers with the whole list.
    if (first.total === undefined || !first.nextCursor || first.files.length >= target) {
      return first;
    }
    const files = [...first.files];
    let last = first;
    let restarted = false;
    while (files.length < target && last.nextCursor) {
      const page = await api.listFiles(worktreeId, {
        scope,
        limit: Math.min(target - files.length, FILES_PAGE_MAX),
        cursor: last.nextCursor,
        ...(signal ? { signal } : {}),
      });
      if (page.restarted) {
        restarted = true;
        last = page;
        break;
      }
      files.push(...page.files);
      last = page;
    }
    if (!restarted) {
      return {
        ...first,
        files,
        nextCursor: last.nextCursor ?? null,
        truncated: (last.nextCursor ?? null) !== null,
      };
    }
    if (attempt + 1 >= filesPaging.restarts) return { ...last, restarted: false };
  }
}

/**
 * The files query function: as many files as were wanted (every load past the first page goes
 * through `ensureFiles`, which records it), at least a page (see the module comment).
 */
export function filesQueryFn(
  api: ApiClient,
  queryClient: QueryClient | undefined,
  worktreeId: string,
  scope: DiffScope,
) {
  return ({ signal }: { signal: AbortSignal }): Promise<FilesResponse> => {
    const wantedCount = queryClient
      ? (wantedMap(queryClient).get(keyOf(worktreeId, scope)) ?? 0)
      : 0;
    return fetchFileList(
      api,
      worktreeId,
      scope,
      Math.max(filesPaging.pageSize, wantedCount),
      signal,
    );
  };
}

const loading = new WeakMap<QueryClient, Map<string, Promise<FilesResponse | undefined>>>();

/**
 * Loads the list's cached prefix to at least `count` files (or its end). Single-flight per list;
 * returns the cached data once done (undefined: nothing cached and nothing could be fetched).
 */
export function ensureFiles(
  queryClient: QueryClient,
  api: ApiClient,
  worktreeId: string,
  scope: DiffScope,
  count: number,
): Promise<FilesResponse | undefined> {
  wantFiles(queryClient, worktreeId, scope, count);
  let map = loading.get(queryClient);
  if (!map) {
    map = new Map();
    loading.set(queryClient, map);
  }
  const key = keyOf(worktreeId, scope);
  const running = map.get(key);
  if (running) return running.then(() => ensureFiles(queryClient, api, worktreeId, scope, count));
  const run = loadThrough(queryClient, api, worktreeId, scope, count).finally(() => {
    map.delete(key);
  });
  map.set(key, run);
  return run;
}

async function loadThrough(
  queryClient: QueryClient,
  api: ApiClient,
  worktreeId: string,
  scope: DiffScope,
  count: number,
): Promise<FilesResponse | undefined> {
  const queryKey = queryKeys.files(worktreeId, scope);
  for (let round = 0; round < 1000; round++) {
    const query = queryClient.getQueryCache().find<FilesResponse>({ queryKey, exact: true });
    // A fetch in flight (the first one, or a refresh) loads what was wanted: wait for it.
    if (query?.state.fetchStatus === 'fetching') {
      await query.promise?.catch(() => undefined);
      continue;
    }
    const data = queryClient.getQueryData<FilesResponse>(queryKey);
    if (!data) {
      await queryClient
        .fetchQuery({ queryKey, queryFn: filesQueryFn(api, queryClient, worktreeId, scope) })
        .catch(() => undefined);
      const fetched = queryClient.getQueryData<FilesResponse>(queryKey);
      if (!fetched) return undefined;
      continue;
    }
    if (data.files.length >= count || !data.nextCursor) return data;
    const cursor = data.nextCursor;
    const page = await api.listFiles(worktreeId, {
      scope,
      limit: Math.min(FILES_PAGE_MAX, Math.max(filesPaging.pageSize, count - data.files.length)),
      cursor,
    });
    const current = queryClient.getQueryData<FilesResponse>(queryKey);
    // Replaced meanwhile (a refresh landed): go on from the new data.
    if (!current || current.nextCursor !== cursor) continue;
    if (page.restarted) {
      // The state moved: the refresh it causes loads what was wanted.
      await queryClient.invalidateQueries({ queryKey, exact: true });
      continue;
    }
    queryClient.setQueryData<FilesResponse>(queryKey, {
      ...current,
      files: [...current.files, ...page.files],
      nextCursor: page.nextCursor ?? null,
      truncated: (page.nextCursor ?? null) !== null,
      ...(page.counts ? { counts: page.counts } : {}),
    });
  }
  return queryClient.getQueryData<FilesResponse>(queryKey);
}

/** One more page of the cached list (scrolling near its end). */
export function loadMoreFiles(
  queryClient: QueryClient,
  api: ApiClient,
  worktreeId: string,
  scope: DiffScope,
): Promise<FilesResponse | undefined> {
  const data = queryClient.getQueryData<FilesResponse>(queryKeys.files(worktreeId, scope));
  const loaded = data?.files.length ?? 0;
  return ensureFiles(queryClient, api, worktreeId, scope, loaded + filesPaging.pageSize);
}

/**
 * Where a file sits in the daemon's list (its index), from one small request: the page after it
 * starts at its index + 1. Null when the daemon does not page (an older one: its list is loaded
 * whole). A file that is not in the list gets where it would sort, minus one.
 */
export async function locateFile(
  api: ApiClient,
  worktreeId: string,
  scope: DiffScope,
  file: { path: string; rawPath?: string | undefined },
): Promise<number | null> {
  const res = await api.listFiles(worktreeId, {
    scope,
    limit: 1,
    after:
      file.rawPath === undefined ? { path: file.path } : { path: file.path, rawPath: file.rawPath },
  });
  if (res.total === undefined) return null;
  return (res.position ?? res.total) - 1;
}

/** Own files of the whole list whose mark is not `reviewed` (what a bulk mark would change). */
export function ownToChange(counts: FileListCounts, reviewed: boolean): number {
  const own = counts.total - counts.base;
  const ownReviewed = counts.reviewed - counts.baseReviewed;
  return reviewed ? own - ownReviewed : ownReviewed;
}

/** Unreviewed files of the whole list, by origin view (`own`, `base`, or all). */
export function unreviewedIn(counts: FileListCounts, origin: 'own' | 'base' | undefined): number {
  if (origin === 'own') return ownToChange(counts, true);
  if (origin === 'base') return counts.base - counts.baseReviewed;
  return counts.total - counts.reviewed;
}
