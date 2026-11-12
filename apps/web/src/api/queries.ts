import {
  type ApiClient,
  ApiClientError,
  createApiClient,
  type DiffResponse,
  type DiffScope,
  INBOX_PROJECTS_MAX,
  type InboxResponse,
  type ProjectsResponse,
  scopeKey,
} from '@octopus-diff/contracts';
import {
  keepPreviousData,
  QueryClient,
  experimental_streamedQuery as streamedQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import type { FileRef } from '../lib/fileRef.ts';
import { readToken } from './token.ts';

/**
 * The daemon serves the UI and the API from the same origin. Auth is the bearer token from
 * localStorage (see `token.ts`); no cookies are sent.
 */
export function createBrowserApiClient(token: string | null = readToken()): ApiClient {
  return createApiClient({ baseUrl: '', credentials: 'omit', ...(token ? { token } : {}) });
}

export const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error('ApiContext missing');
  return api;
}

/**
 * Query keys. Prefixes are chosen so SSE events can invalidate precisely:
 * `['files', worktreeId]`, `['diff', worktreeId]`, `['commits', worktreeId]`.
 */
export const queryKeys = {
  health: () => ['health'] as const,
  projects: () => ['projects'] as const,
  scanRoots: () => ['scan-roots'] as const,
  /** Folder picker listing; `''` is the daemon's default folder (home). */
  dirs: (path: string) => ['dirs', path] as const,
  inboxAll: () => ['inbox'] as const,
  inbox: (scope: DiffScope) => ['inbox', scopeKey(scope)] as const,
  filesAll: (worktreeId: string) => ['files', worktreeId] as const,
  files: (worktreeId: string, scope: DiffScope) => ['files', worktreeId, scopeKey(scope)] as const,
  diffAll: (worktreeId: string) => ['diff', worktreeId] as const,
  diff: (ref: FileRef, scope: DiffScope, opts: DiffViewParams) =>
    [
      'diff',
      ref.worktreeId,
      scopeKey(scope),
      ref.rawPath ?? ref.path,
      opts.ignoreWhitespace,
      opts.context ?? null,
      opts.full ?? false,
    ] as const,
  commits: (worktreeId: string) => ['commits', worktreeId] as const,
};

export interface DiffViewParams {
  ignoreWhitespace: boolean;
  context?: number | undefined;
  full?: boolean | undefined;
}

/** The view options a patch was fetched with, as a short stable string. */
export function diffViewKey(params: DiffViewParams): string {
  return `${params.ignoreWhitespace ? 'w' : '-'}:${params.context ?? ''}:${params.full ? 'f' : '-'}`;
}

/**
 * A diff response plus the view it was fetched for. While the view changes (more context,
 * whitespace) the query shows the previous view's patch as placeholder data; anything keyed by
 * the view (the highlighter's cache key) must use `view`, never the options currently asked for.
 */
export type DiffQueryData = DiffResponse & {
  /** `diffViewKey` of the options this patch was fetched with. */
  view: string;
  /** The options this patch was fetched with. */
  params: DiffViewParams;
};

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiClientError) {
    if (error.status >= 400 && error.status < 500) return false;
    if (error.code === 'invalid_response') return false;
  }
  return failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // SSE events drive invalidation; this is only a safety net.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: shouldRetry,
        retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 5000),
        refetchOnWindowFocus: false,
      },
    },
  });
}

/** The inbox scope: commit scope has no cross-worktree meaning, so the inbox uses `working`. */
export function inboxScopeFor(scope: DiffScope): DiffScope {
  return scope.kind === 'commit' ? { kind: 'working' } : scope;
}

export function useProjectsQuery() {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.projects(), queryFn: () => api.listProjects() });
}

/**
 * Inbox batches in flight at once. One: git-core runs four git processes in total, so batches in
 * parallel only interleave and the first one lands late (30 × 3: first file at 973 ms with four
 * in flight, 257 ms one at a time; the whole inbox 1.41 s vs 1.32 s).
 */
const INBOX_BATCH_PARALLEL = 1;
/** About this many batches per inbox: big enough to stream, few enough to stay cheap. */
const INBOX_BATCHES = 12;

/**
 * Inbox scopes that are still being filled in (more batches to come), by query key. Kept by key and
 * not on the response object: cache patches (a review mark, an event patch) replace the data with a
 * new object, and React Query's structural sharing does not keep the identity of what is written.
 * The flag is cleared just before the last batch is written, so the render that shows the complete
 * data already sees it clear.
 */
const partialInboxKeys = new Set<string>();

/** True while a streamed inbox is still missing batches (bulk "all" must not act on it yet). */
export function isPartialInbox(scope: DiffScope): boolean {
  return partialInboxKeys.has(JSON.stringify(queryKeys.inbox(inboxScopeFor(scope))));
}

/** Marks `key` partial while `source` still has batches to give; always cleared when it ends. */
async function* trackPartial(
  key: string,
  source: AsyncGenerator<{ response: InboxResponse; last: boolean }>,
  streamed: boolean,
): AsyncGenerator<{ response: InboxResponse; last: boolean }> {
  if (streamed) partialInboxKeys.add(key);
  try {
    for await (const item of source) {
      if (item.last) partialInboxKeys.delete(key);
      yield item;
    }
  } finally {
    partialInboxKeys.delete(key);
  }
}

/**
 * The projects split into inbox batches (#10): projects with uncommitted changes first, then the
 * rest, in sidebar order, so the first rows land first. Null = one request for everything.
 */
export function inboxBatches(projects: ProjectsResponse | undefined): string[][] | null {
  const items = (projects?.projects ?? []).filter((p) => p.worktrees.length > 0);
  if (items.length < 2) return null;
  const dirty = (p: (typeof items)[number]) =>
    p.worktrees.some((w) => (w.summary?.changedFiles ?? 0) > 0);
  const byName = (a: (typeof items)[number], b: (typeof items)[number]) =>
    a.project.name.toLowerCase().localeCompare(b.project.name.toLowerCase());
  const ordered = [
    ...items.filter(dirty).sort(byName),
    ...items.filter((p) => !dirty(p)).sort(byName),
  ];
  const size = Math.min(INBOX_PROJECTS_MAX, Math.max(1, Math.ceil(ordered.length / INBOX_BATCHES)));
  const out: string[][] = [];
  for (let i = 0; i < ordered.length; i += size) {
    out.push(ordered.slice(i, i + size).map((p) => p.project.id));
  }
  return out;
}

/**
 * The projects list to batch by: the cached one, or the request in flight (the sidebar's own on
 * first load, or a refetch after a project was added), so no project is left out of the batches.
 * Undefined when it cannot be had: the inbox is then one request.
 */
async function currentProjects(
  api: ApiClient,
  queryClient: QueryClient,
): Promise<ProjectsResponse | undefined> {
  const key = queryKeys.projects();
  const state = queryClient.getQueryState<ProjectsResponse>(key);
  if (state?.data !== undefined && state.fetchStatus === 'idle' && !state.isInvalidated) {
    return state.data;
  }
  return queryClient
    .fetchQuery({ queryKey: key, queryFn: () => api.listProjects(), staleTime: 0 })
    .catch(() => undefined);
}

/** Inbox batches, a few in flight, yielded as each lands; `last` marks the final one. */
async function* streamInbox(
  api: ApiClient,
  scope: DiffScope,
  batches: string[][] | null,
): AsyncGenerator<{ response: InboxResponse; last: boolean }> {
  if (batches === null) {
    yield { response: await api.inbox({ scope }), last: true };
    return;
  }
  const pending = new Map<number, Promise<[number, InboxResponse]>>();
  let next = 0;
  const start = () => {
    const i = next++;
    const request = api
      .inbox({ scope, projectIds: batches[i] ?? [] })
      .then((r): [number, InboxResponse] => [i, r]);
    // Rejections surface through `Promise.race`; a batch still in flight after one failed must
    // not turn into an unhandled rejection.
    request.catch(() => {});
    pending.set(i, request);
  };
  while (next < batches.length && pending.size < INBOX_BATCH_PARALLEL) start();
  while (pending.size > 0) {
    const [i, response] = await Promise.race(pending.values());
    pending.delete(i);
    if (next < batches.length) start();
    yield { response, last: pending.size === 0 };
  }
}

/** Adds a batch's entries; a worktree already present (an event patched it) is replaced. */
function mergeInbox(
  acc: InboxResponse,
  { response }: { response: InboxResponse; last: boolean },
): InboxResponse {
  const ids = new Set(response.entries.map((e) => e.worktree.id));
  return {
    scope: response.scope,
    entries: [...acc.entries.filter((e) => !ids.has(e.worktree.id)), ...response.entries],
    generatedAt: response.generatedAt,
  };
}

/**
 * The inbox in `scope`, filled in project batches after the first paint (#10): the first batches
 * show while the rest load. A refetch replaces the data once all its batches are in.
 */
export function inboxQueryOptions(api: ApiClient, queryClient: QueryClient, scope: DiffScope) {
  const inboxScope = inboxScopeFor(scope);
  const queryKey = queryKeys.inbox(inboxScope);
  return {
    queryKey,
    queryFn: streamedQuery({
      streamFn: async () => {
        // A refetch writes its result once at the end ('replace'): one request is enough.
        if (queryClient.getQueryData(queryKey) !== undefined) {
          return streamInbox(api, inboxScope, null);
        }
        const batches = inboxBatches(await currentProjects(api, queryClient));
        return trackPartial(
          JSON.stringify(queryKey),
          streamInbox(api, inboxScope, batches),
          batches !== null,
        );
      },
      reducer: mergeInbox,
      initialValue: { scope: inboxScope, entries: [], generatedAt: new Date(0).toISOString() },
      refetchMode: 'replace',
    }),
  };
}

export function useInboxQuery(scope: DiffScope) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useQuery({
    ...inboxQueryOptions(api, queryClient, scope),
    placeholderData: keepPreviousData,
  });
}

export function useFilesQuery(worktreeId: string | null, scope: DiffScope) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.files(worktreeId ?? '', scope),
    queryFn: () => api.listFiles(worktreeId ?? '', { scope }),
    enabled: worktreeId !== null,
  });
}

export function useDiffQuery(ref: FileRef | null, scope: DiffScope, params: DiffViewParams) {
  const api = useApi();
  const fileKey = ref ? (ref.rawPath ?? ref.path) : '';
  return useQuery({
    queryKey: queryKeys.diff(ref ?? { worktreeId: '', path: '' }, scope, params),
    queryFn: async (): Promise<DiffQueryData> => {
      const response = await api.getDiff(ref?.worktreeId ?? '', {
        scope,
        path: ref?.path ?? '',
        ...(ref?.rawPath ? { rawPath: ref.rawPath } : {}),
        ignoreWhitespace: params.ignoreWhitespace,
        ...(params.context !== undefined ? { context: params.context } : {}),
        ...(params.full ? { full: true } : {}),
      });
      return { ...response, view: diffViewKey(params), params };
    },
    enabled: ref !== null,
    // Keep showing the same file's previous diff while view options change (whitespace,
    // context); never show another file's diff as a placeholder.
    placeholderData: (previous, previousQuery) =>
      previousQuery &&
      previousQuery.queryKey[1] === ref?.worktreeId &&
      previousQuery.queryKey[3] === fileKey
        ? previous
        : undefined,
    staleTime: 5 * 60_000,
  });
}

export function useCommitsQuery(worktreeId: string | null, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.commits(worktreeId ?? ''),
    queryFn: () => api.listCommits(worktreeId ?? '', { limit: 100 }),
    enabled: enabled && worktreeId !== null,
  });
}

/** A human explanation for a failed request. */
export function describeError(error: unknown): {
  title: string;
  detail: string;
  kind: 'auth' | 'offline' | 'other';
} {
  if (error instanceof ApiClientError) {
    if (error.code === 'unauthorized' || error.status === 401) {
      return {
        kind: 'auth',
        title: 'Not authorized',
        detail:
          'This page needs the access token. Open the URL printed by `octopus-diff serve` ' +
          '(it looks like http://127.0.0.1:7428/#token=…); this browser then keeps the token for ' +
          'this address. Run `octopus-diff status` to print the URL again.',
      };
    }
    if (error.code === 'forbidden' || error.status === 403) {
      return {
        kind: 'auth',
        title: 'Forbidden',
        detail:
          'The daemon rejected this request (Host/Origin check). Open the UI at the exact URL ' +
          'printed by `octopus-diff serve`.',
      };
    }
    if (error.code === 'network') {
      return {
        kind: 'offline',
        title: 'Daemon unreachable',
        detail: 'Cannot reach the octopus-diff daemon. Is `octopus-diff serve` running?',
      };
    }
    return { kind: 'other', title: `Request failed (${error.code})`, detail: error.message };
  }
  return {
    kind: 'other',
    title: 'Unexpected error',
    detail: error instanceof Error ? error.message : String(error),
  };
}
