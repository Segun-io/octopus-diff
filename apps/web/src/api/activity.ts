/**
 * The Activity feed and a deleted file's content (roadmap #39). One query per worktree, observed
 * only while its strip is on screen (the open worktree), so no other worktree's feed is fetched.
 * It is refreshed by the `worktree.changed` event's `activitySeq` (api/cache.ts invalidates it),
 * and every fetch is incremental: `after` is the cursor the held feed ends at, `run` the daemon
 * run it came from. A `dropped` answer replaces the list (lib/activity.ts `mergeActivity`).
 */
import type { BlobRead } from '@octopus-diff/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ActivityFeed, activityCursor, mergeActivity } from '../lib/activity.ts';
import { queryKeys, useApi } from './queries.ts';

export function useActivityQuery(worktreeId: string | null) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.activity(worktreeId ?? ''),
    enabled: worktreeId !== null,
    // Events decide when it is stale (invalidation); a remount asks again, which is one small
    // incremental request.
    staleTime: 0,
    queryFn: async ({ signal }): Promise<ActivityFeed> => {
      const id = worktreeId ?? '';
      const key = queryKeys.activity(id);
      // Read the held feed when the request is made, not when the query was created: an event may
      // have moved the cursor since.
      const prev = queryClient.getQueryData<ActivityFeed>(key);
      const res = await api.getActivity(id, { ...activityCursor(prev), signal });
      // Another fetch may have landed while this one was in flight: merge into the latest.
      return mergeActivity(queryClient.getQueryData<ActivityFeed>(key) ?? prev, res);
    },
  });
}

/** What the blob route returned for a deleted file's `oid`. Fetched when "view content" opens. */
export function useBlobQuery(worktreeId: string, oid: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.blob(worktreeId, oid ?? ''),
    enabled: oid !== null,
    // A blob never changes; its absence (404: it left the feed, or was pruned) is not retried.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async ({ signal }): Promise<BlobRead> =>
      (await api.getBlob(worktreeId, oid ?? '', { signal })).blob,
  });
}
