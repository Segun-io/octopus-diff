/**
 * Forge integration (docs/FORGES.md): `GET /api/forges`, refetched on `forge.updated` events
 * (api/cache.ts). A daemon without the route (404) resolves to `null`; callers render nothing.
 */
import {
  type ApiClient,
  ApiClientError,
  type ForgesResponse,
  REPOSITORIES_MAX,
  type RefreshForgesRequest,
  type RepositoriesResponse,
  type RepositoryForgeResponse,
} from '@octopus-diff/contracts';

export type RepositoryEntry = RepositoriesResponse['repositories'][number];

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { type ForgeIndexEntry, indexForges } from '../lib/forge.ts';
import { useApi } from './queries.ts';

export const forgeKeys = {
  forges: () => ['forges'] as const,
};

export async function fetchForges(api: ApiClient): Promise<ForgesResponse | null> {
  try {
    return await api.getForges();
  } catch (error) {
    if (error instanceof ApiClientError && (error.status === 404 || error.status === 405)) {
      return null;
    }
    throw error;
  }
}

export function useForgesQuery() {
  const api = useApi();
  return useQuery({
    queryKey: forgeKeys.forges(),
    queryFn: () => fetchForges(api),
    // Freshness comes from `forge.updated` events; this only bounds a missed one.
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
}

/** Worktree id -> its project forge state and matched request. */
export function useForgeIndex(): Map<string, ForgeIndexEntry> {
  const query = useForgesQuery();
  return useMemo(() => indexForges(query.data), [query.data]);
}

export function useRefreshForges() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RefreshForgesRequest = {}) => api.refreshForges(body),
    onSuccess: (response) => queryClient.setQueryData(forgeKeys.forges(), response),
  });
}

// --- repository information (Overview) ------------------------------------------------------

/** 404/405 from an older daemon: the feature is absent, render nothing. */
function absent(error: unknown): boolean {
  return error instanceof ApiClientError && (error.status === 404 || error.status === 405);
}

/**
 * Forge facts for the project Overview. Fetched when the Overview opens (the daemon caches them
 * 10 minutes) and refetched on `forge.updated` with every other `['forges', …]` query.
 */
export function useRepositoryForge(projectId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ['forges', 'repository', projectId] as const,
    queryFn: async (): Promise<RepositoryForgeResponse | null> => {
      try {
        return await api.getRepositoryForge(projectId);
      } catch (error) {
        if (absent(error)) return null;
        throw error;
      }
    },
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function useRefreshRepositoryForge(projectId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshRepositoryForge(projectId),
    onSuccess: (response) =>
      queryClient.setQueryData(['forges', 'repository', projectId], response),
  });
}

/** Local git facts for the listed projects (one request for the whole Overview). */
export function useRepositories(projectIds: readonly string[]) {
  const api = useApi();
  const ids = [...projectIds].sort();
  return useQuery({
    queryKey: ['repositories', ids.join(',')] as const,
    queryFn: async (): Promise<Map<string, RepositoryEntry>> => {
      const map = new Map<string, RepositoryEntry>();
      for (let i = 0; i < ids.length; i += REPOSITORIES_MAX) {
        try {
          const body = await api.listRepositories(ids.slice(i, i + REPOSITORIES_MAX));
          for (const entry of body.repositories) map.set(entry.projectId, entry);
        } catch (error) {
          if (absent(error)) return map;
          throw error;
        }
      }
      return map;
    },
    enabled: ids.length > 0,
    staleTime: 30_000,
    retry: false,
  });
}
