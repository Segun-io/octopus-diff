/**
 * "Review all" and undo (COORDINATION §2.2). The response carries what was skipped so
 * the toast can say it; `review.bulk` events refresh the caches (cache.ts).
 */
import type { BulkReviewRequest, BulkReviewResponse } from '@octopus-diff/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys, useApi } from './queries.ts';

export function useBulkReview() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: BulkReviewRequest) => api.bulkReview(body),
    onSuccess: () => {
      // The event does the precise work; this covers daemons that batch events late.
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll() });
      void queryClient.invalidateQueries({ queryKey: ['files'] });
      void queryClient.invalidateQueries({ queryKey: ['diff'] });
    },
  });
}

export function useUndoReview() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (undoToken: string) => api.undoReview({ undoToken }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll() });
      void queryClient.invalidateQueries({ queryKey: ['files'] });
      void queryClient.invalidateQueries({ queryKey: ['diff'] });
    },
  });
}

/** One line for the toast: "12 files marked reviewed · 2 skipped: review off · 1 changed meanwhile". */
export function describeBulkResult(res: BulkReviewResponse): string {
  const noun = res.changed === 1 ? 'file' : 'files';
  const parts = [
    res.changed === 0
      ? `Nothing to ${res.reviewed ? 'mark' : 'clear'}${res.unchanged > 0 ? ` (${res.unchanged} already ${res.reviewed ? 'reviewed' : 'unreviewed'})` : ''}`
      : `${res.changed} ${noun} marked ${res.reviewed ? 'reviewed' : 'unreviewed'}`,
  ];
  if (res.skippedDisabled.length > 0)
    parts.push(`${res.skippedDisabled.length} skipped: review off`);
  if (res.stale.length > 0) parts.push(`${res.stale.length} changed meanwhile`);
  // #43: untracked files above the daemon's cap have no row, so nothing could mark them.
  const omitted = res.untrackedOmitted ?? 0;
  if (omitted > 0) {
    parts.push(
      `${omitted} untracked ${omitted === 1 ? 'file is' : 'files are'} not listed and cannot be marked`,
    );
  }
  return parts.join(' · ');
}
