/**
 * Daemon settings, review policy, scan roots, projects and health (UX round 1). New hooks live
 * here, not in `hooks.ts` (reserved). A daemon without `/api/settings` (404) makes
 * `useSettingsQuery` resolve to `null`: callers hide the controls that need it (§2.4).
 */
import {
  type ApiClient,
  ApiClientError,
  type AppSettingsPatch,
  type SetReviewPolicyRequest,
  type SettingsResponse,
} from '@octopus-diff/contracts';
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys, useApi } from './queries.ts';

export const settingsKeys = {
  settings: () => ['settings'] as const,
};

function isUnsupported(error: unknown): boolean {
  return error instanceof ApiClientError && (error.status === 404 || error.status === 405);
}

export async function fetchSettings(api: ApiClient): Promise<SettingsResponse | null> {
  try {
    return await api.getSettings();
  } catch (error) {
    if (isUnsupported(error)) return null;
    throw error;
  }
}

/** `undefined` while loading, `null` when the daemon has no settings API, else the settings. */
export function useSettingsQuery() {
  const api = useApi();
  return useQuery({
    queryKey: settingsKeys.settings(),
    queryFn: () => fetchSettings(api),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export type SettingsSupport = 'loading' | 'unsupported' | 'ready';

export function useSettingsSupport(): SettingsSupport {
  const query = useSettingsQuery();
  if (query.data === undefined) return query.isError ? 'unsupported' : 'loading';
  return query.data === null ? 'unsupported' : 'ready';
}

/** Applies a settings response to the cache and refetches what effective policies touch. */
export function applySettingsResponse(queryClient: QueryClient, response: SettingsResponse) {
  const current = queryClient.getQueryData<SettingsResponse | null>(settingsKeys.settings());
  if (!current || response.revision >= current.revision) {
    queryClient.setQueryData(settingsKeys.settings(), response);
  }
  void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll() });
}

export function useUpdateSettings() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: AppSettingsPatch) => api.updateSettings(patch),
    onSuccess: (response) => applySettingsResponse(queryClient, response),
  });
}

export function useSetReviewPolicy() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SetReviewPolicyRequest) => api.setReviewPolicy(body),
    onSuccess: (response) => applySettingsResponse(queryClient, response),
  });
}

export function useHealthQuery(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.health(),
    queryFn: () => api.health(),
    enabled,
    staleTime: 60_000,
  });
}

export function useScanRootsQuery(enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.scanRoots(),
    queryFn: () => api.listScanRoots(),
    enabled,
  });
}

function invalidateRegistry(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.scanRoots() });
  void queryClient.invalidateQueries({ queryKey: settingsKeys.settings() });
}

export function useRemoveProject() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => api.removeProject(projectId),
    onSuccess: () => invalidateRegistry(queryClient),
  });
}

export function useUpdateProject() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { projectId: string; defaultBranchOverride: string | null }) =>
      api.updateProject(args.projectId, { defaultBranchOverride: args.defaultBranchOverride }),
    onSuccess: () => invalidateRegistry(queryClient),
  });
}

export function useRemoveScanRoot() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scanRootId: string) => api.removeScanRoot(scanRootId),
    onSuccess: () => invalidateRegistry(queryClient),
  });
}

export function useRescanScanRoot() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scanRootId: string) => api.rescanScanRoot(scanRootId),
    onSuccess: () => invalidateRegistry(queryClient),
  });
}
