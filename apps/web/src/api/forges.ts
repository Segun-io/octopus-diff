/**
 * Forge integration (docs/FORGES.md): `GET /api/forges`, refetched on `forge.updated` events
 * (api/cache.ts). A daemon without the route (404) resolves to `null`; callers render nothing.
 */
import {
  type ApiClient,
  ApiClientError,
  type ForgesResponse,
  type RefreshForgesRequest,
} from '@octopus-diff/contracts';
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
