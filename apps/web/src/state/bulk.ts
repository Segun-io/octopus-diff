/**
 * Executes bulk plans (lib/bulk.ts), shows the toast with undo and handles Ctrl/Cmd+Z.
 */
import type { BulkReviewResponse } from '@octopus-diff/contracts';
import { useCallback, useRef } from 'react';
import { describeBulkResult, useBulkReview, useUndoReview } from '../api/bulk.ts';
import type { BulkPlan } from '../lib/bulk.ts';
import { actions, type BulkToast, type UiStore, useUiStore } from './ui.tsx';

let toastId = 0;

/** Folds several responses (one per worktree) into one summary line. */
export function mergeResponses(list: BulkReviewResponse[]): BulkReviewResponse {
  const out: BulkReviewResponse = {
    ok: true,
    reviewed: list[0]?.reviewed ?? true,
    changed: 0,
    unchanged: 0,
    worktrees: 0,
    skippedDisabled: [],
    stale: [],
    undoToken: list[0]?.undoToken ?? null,
  };
  for (const r of list) {
    out.changed += r.changed;
    out.unchanged += r.unchanged;
    out.worktrees += r.worktrees;
    out.skippedDisabled.push(...r.skippedDisabled);
    out.stale.push(...r.stale);
  }
  return out;
}

export interface BulkActions {
  run(plan: BulkPlan): Promise<void>;
  undo(): Promise<void>;
  dismiss(): void;
}

export const BULK_TOAST_MS = 15_000;

export function useBulkActions(): BulkActions {
  const store = useUiStore();
  const bulk = useBulkReview();
  const undo = useUndoReview();
  const tokens = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = useCallback(
    (toast: Omit<BulkToast, 'id'>) => {
      if (timer.current !== undefined) clearTimeout(timer.current);
      const id = ++toastId;
      store.setState({ bulkToast: { id, ...toast } });
      timer.current = setTimeout(() => {
        if (store.getState().bulkToast?.id === id) store.setState({ bulkToast: null });
      }, BULK_TOAST_MS);
    },
    [store],
  );

  const run = useCallback(
    async (plan: BulkPlan) => {
      if (plan.requests.length === 0) {
        actions.notice(store, 'Nothing to mark here.');
        return;
      }
      try {
        const responses = await Promise.all(plan.requests.map((r) => bulk.mutateAsync(r)));
        tokens.current = responses.flatMap((r) => (r.undoToken ? [r.undoToken] : []));
        const merged = mergeResponses(responses);
        show({
          text: describeBulkResult(merged),
          undoToken: tokens.current[0] ?? null,
          reviewed: merged.reviewed,
          changed: merged.changed,
          state: 'done',
        });
      } catch (error) {
        actions.notice(
          store,
          `Could not mark files: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [bulk, show, store],
  );

  const doUndo = useCallback(async () => {
    const toast = store.getState().bulkToast;
    if (toast?.state !== 'done' || tokens.current.length === 0) return;
    store.setState({ bulkToast: { ...toast, state: 'undoing' } });
    try {
      const results = await Promise.all(tokens.current.map((t) => undo.mutateAsync(t)));
      tokens.current = [];
      const restored = results.reduce((n, r) => n + r.restored, 0);
      show({
        text: `Undone: ${restored} ${restored === 1 ? 'mark' : 'marks'} restored`,
        undoToken: null,
        reviewed: !toast.reviewed,
        changed: restored,
        state: 'undone',
      });
    } catch {
      show({ ...toast, text: 'Could not undo (expired or already undone).', state: 'failed' });
    }
  }, [show, store, undo]);

  const dismiss = useCallback(() => store.setState({ bulkToast: null }), [store]);

  return { run, undo: doUndo, dismiss };
}

export function hasUndoableToast(store: UiStore): boolean {
  const toast = store.getState().bulkToast;
  return toast !== null && toast.state === 'done' && toast.undoToken !== null;
}
