/**
 * Request tab data (docs/FORGES.md "Request tab"): the matched request's detail and its
 * conversation. Both are fetched only while the tab (or the section that needs them) is shown.
 *
 * Invalidation without polling: the query key includes the batch entry's `updatedAt`, `headSha`
 * and `checks.state`; when the 2-minute batch sees a change (`forge.updated`), the key changes and
 * the open tab refetches. Live refresh only while checks are running, the tab is visible, the
 * browser tab is in the foreground and the user did something in the last 20 minutes.
 */
import {
  ApiClientError,
  type ChangeRequest,
  type ChangeRequestConversationResponse,
  type ChangeRequestDetailResponse,
  FORGE_CHECKS_POLL_MS,
} from '@octopus-diff/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { checksRunning } from '../lib/request.ts';
import { useApi } from './queries.ts';

/** Live refresh stops after this long without user input (cost cap, DECISIONS #78). */
export const LIVE_REFRESH_IDLE_MS = 20 * 60_000;

let lastInput = Date.now();
if (typeof window !== 'undefined') {
  const mark = () => {
    lastInput = Date.now();
  };
  for (const type of ['pointerdown', 'keydown', 'wheel']) {
    window.addEventListener(type, mark, { passive: true, capture: true });
  }
}

/** For tests. */
export function markUserInput(at = Date.now()): void {
  lastInput = at;
}

export function userIdle(now = Date.now()): boolean {
  return now - lastInput > LIVE_REFRESH_IDLE_MS;
}

/** The polling rule: only while live, checks are running and the user is not idle. */
export function liveRefreshInterval(
  request: Parameters<typeof checksRunning>[0] | null | undefined,
  live: boolean,
  idle: boolean,
): number | false {
  if (!live || !request || !checksRunning(request) || idle) return false;
  return FORGE_CHECKS_POLL_MS;
}

export function requestFingerprint(cr: ChangeRequest | null | undefined): string {
  if (!cr) return 'none';
  return [cr.number, cr.updatedAt ?? '', cr.headSha ?? '', cr.checks?.state ?? ''].join('|');
}

export const requestKeys = {
  detail: (worktreeId: string, fingerprint: string) =>
    ['forge-request', worktreeId, 'detail', fingerprint] as const,
  conversation: (worktreeId: string, fingerprint: string) =>
    ['forge-request', worktreeId, 'conversation', fingerprint] as const,
  all: (worktreeId: string) => ['forge-request', worktreeId] as const,
};

/** Older daemons have no route: treat as "unavailable" rather than an error state. */
function unsupported(error: unknown): boolean {
  return error instanceof ApiClientError && (error.status === 404 || error.status === 405);
}

export function useChangeRequestDetail(
  worktreeId: string,
  changeRequest: ChangeRequest | null | undefined,
  options: { enabled?: boolean; live?: boolean } = {},
) {
  const api = useApi();
  const fingerprint = requestFingerprint(changeRequest);
  return useQuery({
    queryKey: requestKeys.detail(worktreeId, fingerprint),
    queryFn: async (): Promise<ChangeRequestDetailResponse> => {
      try {
        return await api.getChangeRequest(worktreeId);
      } catch (error) {
        if (!unsupported(error)) throw error;
        return {
          worktreeId,
          status: 'unavailable',
          message: 'This daemon cannot show request details yet. Update octopus-diff.',
          request: null,
          fetchedAt: null,
          imageHosts: [],
        };
      }
    },
    enabled: (options.enabled ?? true) && !!changeRequest,
    // Keep showing the previous detail while a changed fingerprint refetches.
    placeholderData: (previous) => previous,
    staleTime: 30_000,
    retry: false,
    refetchInterval: (query) =>
      liveRefreshInterval(query.state.data?.request, options.live ?? false, userIdle()),
    // Paused while the browser tab is in the background (react-query's default, made explicit).
    refetchIntervalInBackground: false,
  });
}

export function useChangeRequestConversation(
  worktreeId: string,
  changeRequest: ChangeRequest | null | undefined,
  enabled: boolean,
) {
  const api = useApi();
  // The conversation does not change with CI: no checks state in its key.
  const fingerprint = changeRequest
    ? [changeRequest.number, changeRequest.updatedAt ?? '', changeRequest.headSha ?? ''].join('|')
    : 'none';
  return useQuery({
    queryKey: requestKeys.conversation(worktreeId, fingerprint),
    queryFn: async (): Promise<ChangeRequestConversationResponse> => {
      try {
        return await api.getChangeRequestConversation(worktreeId);
      } catch (error) {
        if (!unsupported(error)) throw error;
        return {
          worktreeId,
          status: 'unavailable',
          message: 'This daemon cannot show conversations yet. Update octopus-diff.',
          conversation: null,
          fetchedAt: null,
          imageHosts: [],
        };
      }
    },
    enabled: enabled && !!changeRequest,
    placeholderData: (previous) => previous,
    staleTime: 60_000,
    retry: false,
  });
}

/** "Refresh": refetches detail and conversation (the daemon spaces it to 15 s). */
export function useRefreshChangeRequest(worktreeId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshChangeRequest(worktreeId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: requestKeys.all(worktreeId) });
    },
  });
}
