/**
 * Plans "Review all" (COORDINATION §3.1.5): which requests to send so the result
 * matches what the user is looking at, including the sidebar filters and "show reviewed".
 * Pure, so it is unit-tested; `state/bulk.ts` executes the plan.
 */
import type { BulkReviewRequest, DiffScope } from '@octopus-diff/contracts';
import { type FileGroup, isBaseFile, type NavEntry, type VisiblePredicate } from './model.ts';

export interface BulkPlan {
  requests: BulkReviewRequest[];
  /** Files whose mark would change. */
  count: number;
  /** Distinct worktrees the plan touches. */
  worktrees: number;
  /** `all` | `folder` | `project` | `worktree` for the button's `data-target`. */
  target: BulkReviewRequest['target']['kind'];
}

export interface BulkPlanInput {
  scope: DiffScope;
  reviewed: boolean;
  /** Groups shown in the current view (inbox: after sidebar filters; worktree: one group). */
  groups: readonly FileGroup[];
  entries: readonly NavEntry[];
  visible: VisiblePredicate;
  /** stateHash per worktree id, from the cached summaries. */
  stateHashes: ReadonlyMap<string, string>;
  /** Worktrees whose review is disabled (skipped unless `includeDisabled`). */
  disabled: ReadonlySet<string>;
  /** True when every dirty worktree is shown and no file is hidden: one `all` request. */
  inboxUnfiltered: boolean;
  view: 'inbox' | 'worktree';
  includeDisabled?: boolean;
}

function hashesFor(ids: Iterable<string>, hashes: ReadonlyMap<string, string>) {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const h = hashes.get(id);
    if (h) out[id] = h;
  }
  return out;
}

export function planBulk(input: BulkPlanInput): BulkPlan {
  const { scope, reviewed, groups, entries, visible, stateHashes, disabled } = input;
  const scopeField = scope.kind === 'commit' ? { kind: 'working' as const } : scope;
  const byWorktree = new Map<string, NavEntry[]>();
  // "Review all" in To review also moves the bookmark of a worktree whose only unreviewed files are
  // base files (wrapped, so not in `byWorktree`): without it that group would stay behind.
  const advance = scope.kind === 'review' && reviewed;
  const advanceOnly = new Set<string>();
  // Worktrees with an own file the view hides that the request would change (the "From main" chip
  // lists base files only): a request without `paths` would mark it, so those get no bookmark-only
  // request. Bulk review with the chip on stays a no-op.
  const hidesOwn = new Set<string>();
  for (const e of entries) {
    if (advance && isBaseFile(e.file) && !(disabled.has(e.worktreeId) && !input.includeDisabled)) {
      advanceOnly.add(e.worktreeId);
    }
    if (!visible(e)) {
      if (!isBaseFile(e.file) && e.file.reviewed !== reviewed) hidesOwn.add(e.worktreeId);
      continue;
    }
    // Files from a merge, rebase or update of the default branch are never marked in bulk (the
    // daemon skips them too, DECISIONS #204): the count says what the click changes.
    if (isBaseFile(e.file)) continue;
    if (e.file.reviewed === reviewed) continue;
    if (disabled.has(e.worktreeId) && !input.includeDisabled) continue;
    const list = byWorktree.get(e.worktreeId);
    if (list) list.push(e);
    else byWorktree.set(e.worktreeId, [e]);
  }
  let count = 0;
  for (const list of byWorktree.values()) count += list.length;
  for (const id of byWorktree.keys()) advanceOnly.delete(id);
  for (const id of hidesOwn) advanceOnly.delete(id);
  const base = { scope: scopeField, reviewed, includeDisabled: input.includeDisabled ?? false };
  // "Review all" in To review (docs/STATUS-FLOW.md §2.3) also moves the bookmark to HEAD. Hidden
  // files there are reviewed ones only, so the whole worktree is what the user sees: no `paths`.

  if (input.view === 'inbox' && input.inboxUnfiltered) {
    const ids = groups.map((g) => g.worktree.id);
    return {
      target: 'all',
      count,
      worktrees: byWorktree.size + advanceOnly.size,
      requests: [
        {
          ...base,
          target: { kind: 'all' },
          expectedStateHashes: hashesFor(ids, stateHashes),
          ...(advance ? { advanceBookmarks: true } : {}),
        },
      ],
    };
  }
  const requests: BulkReviewRequest[] = [];
  for (const [worktreeId, list] of byWorktree) {
    requests.push({
      ...base,
      target: { kind: 'worktree', worktreeId },
      ...(advance
        ? { advanceBookmarks: true }
        : {
            paths: list.map((e) =>
              e.file.rawPath
                ? { path: e.file.path, rawPath: e.file.rawPath }
                : { path: e.file.path },
            ),
          }),
      expectedStateHashes: hashesFor([worktreeId], stateHashes),
    });
  }
  // Worktrees with base files only: nothing to mark, but the bookmark moves like the others'.
  for (const worktreeId of advanceOnly) {
    requests.push({
      ...base,
      target: { kind: 'worktree', worktreeId },
      advanceBookmarks: true,
      expectedStateHashes: hashesFor([worktreeId], stateHashes),
    });
  }
  return { target: 'worktree', count, worktrees: byWorktree.size + advanceOnly.size, requests };
}

/** A plan for a sidebar node (whole folder / project / worktree), ignoring UI filters. */
export function planBulkForTarget(
  target: BulkReviewRequest['target'],
  scope: DiffScope,
  reviewed: boolean,
  stateHashes: ReadonlyMap<string, string>,
  worktreeIds: readonly string[],
): BulkPlan {
  const scopeField = scope.kind === 'commit' ? { kind: 'working' as const } : scope;
  return {
    target: target.kind,
    count: -1,
    worktrees: worktreeIds.length,
    requests: [
      {
        target,
        scope: scopeField,
        reviewed,
        expectedStateHashes: hashesFor(worktreeIds, stateHashes),
        ...(scope.kind === 'review' && reviewed ? { advanceBookmarks: true } : {}),
      },
    ],
  };
}
