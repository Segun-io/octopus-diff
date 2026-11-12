import type { ForgeKind } from '@octopus-diff/contracts';
import { useMemo } from 'react';
import { reviewPending } from '../lib/model.ts';
import { useExpiring } from '../lib/useWait.ts';
import {
  budgetFor,
  forgeStale,
  LOCAL_WAIT,
  pendingForgeWait,
  REVIEW_WAIT_GIVE_UP_MS,
  type StaleInfo,
  type WaitSource,
} from '../lib/wait.ts';
import { useAppModel } from '../state/model.tsx';
import { useForgeIndex, useForgesQuery, useRefreshForges } from './forges.ts';

/** The budget of the forge host a request belongs to (null when unknown; `ok` when fine). */
export function useHostBudget(host: string | undefined, kind: ForgeKind | undefined) {
  const budgets = useForgesQuery().data?.budgets;
  return budgetFor(budgets, { host, kind });
}

/** The wait source of one forge request: its kind, and its host's budget (why it may be slow). */
export function useForgeWaitSource(kind: ForgeKind, host: string | undefined): WaitSource {
  const budget = useHostBudget(host, kind);
  return { kind: 'forge', forge: [kind], budget };
}

/**
 * The project the user opened (its Overview, or one of its worktrees) while the daemon is still
 * computing its review states (#10: `review.ready` follows). Read from the summaries themselves,
 * so it ends exactly when the sidebar refetch brings the states; `REVIEW_WAIT_GIVE_UP_MS` only
 * stops a daemon that never sends them from leaving the note up.
 */
export function useReviewComputing(): boolean {
  const model = useAppModel();
  const projectId =
    model.view.kind === 'project'
      ? model.view.projectId
      : model.view.kind === 'worktree'
        ? (model.sidebar.byId.get(model.view.worktreeId)?.project.id ?? null)
        : null;
  const pending = useMemo(() => {
    if (projectId === null) return false;
    for (const row of model.sidebar.byId.values()) {
      if (row.project.id === projectId && reviewPending(row)) return true;
    }
    return false;
  }, [model.sidebar, projectId]);
  return useExpiring(pending, projectId ?? '', REVIEW_WAIT_GIVE_UP_MS);
}

export interface SidebarNote {
  /** Present while something is slow: threshold-gated by the component. */
  wait: WaitSource | null;
  /** Present while forge data is old for a real reason. */
  stale: StaleInfo | null;
  refresh: () => void;
  refreshing: boolean;
}

/** What the sidebar's status slot should say: a forge lookup in flight, review states, stale data. */
export function useSidebarNote(): SidebarNote {
  const forges = useForgesQuery();
  const refresh = useRefreshForges();
  const computing = useReviewComputing();
  const forgeWait = useMemo(() => pendingForgeWait(forges.data), [forges.data]);
  const stale = useMemo(() => forgeStale(forges.data), [forges.data]);
  return {
    wait: forgeWait ?? (computing ? LOCAL_WAIT : null),
    stale,
    refresh: () => refresh.mutate({}),
    refreshing: refresh.isPending,
  };
}

/** The wait source of a worktree's request lookups: its forge kind and its host's budget. */
export function useWorktreeForgeWait(worktreeId: string, kind: ForgeKind): WaitSource {
  const host = useForgeIndex().get(worktreeId)?.project.forge?.host;
  return useForgeWaitSource(kind, host);
}
