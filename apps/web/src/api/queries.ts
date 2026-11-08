import {
  type ApiClient,
  ApiClientError,
  createApiClient,
  type DiffScope,
  scopeKey,
} from '@octopus-diff/contracts';
import { keepPreviousData, QueryClient, useQuery } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import type { FileRef } from '../lib/fileRef.ts';

/** The daemon serves the UI and the API from the same origin; auth is the cookie. */
export function createBrowserApiClient(): ApiClient {
  return createApiClient({ baseUrl: '', credentials: 'same-origin' });
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

export function useInboxQuery(scope: DiffScope) {
  const api = useApi();
  const inboxScope = inboxScopeFor(scope);
  return useQuery({
    queryKey: queryKeys.inbox(inboxScope),
    queryFn: () => api.inbox({ scope: inboxScope }),
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
    queryFn: () =>
      api.getDiff(ref?.worktreeId ?? '', {
        scope,
        path: ref?.path ?? '',
        ...(ref?.rawPath ? { rawPath: ref.rawPath } : {}),
        ignoreWhitespace: params.ignoreWhitespace,
        ...(params.context !== undefined ? { context: params.context } : {}),
        ...(params.full ? { full: true } : {}),
      }),
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
          'This page needs the access token. Open the tokenized URL printed by `octopus-diff serve` ' +
          '(it looks like http://127.0.0.1:7428/?token=…); the daemon then sets a cookie and this ' +
          'page works without the token.',
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
