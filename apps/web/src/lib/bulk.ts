/**
 * Plans "Review all" (COORDINATION §3.1.5): which requests to send so the result
 * matches what the user is looking at, including the sidebar filters and "show reviewed".
 * Pure, so it is unit-tested; `state/bulk.ts` executes the plan.
 */
import type { BulkReviewRequest, DiffScope, FileListCounts } from '@octopus-diff/contracts';
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
  /** The groups the plan covers (the open worktree's, or every listed worktree's after the sidebar filters). */
  groups: readonly FileGroup[];
  entries: readonly NavEntry[];
  visible: VisiblePredicate;
  /** stateHash per worktree id, from the cached summaries. */
  stateHashes: ReadonlyMap<string, string>;
  /** Worktrees whose review is disabled (skipped unless `includeDisabled`). */
  disabled: ReadonlySet<string>;
  /** True when every dirty worktree is covered and no file is hidden: one `all` request. */
  allUnfiltered: boolean;
  includeDisabled?: boolean;
  /**
   * Paged lists (#42): worktrees whose loaded files are not their whole list, with the whole
   * list's counts (null: unknown). Their files are marked by the daemon from its whole list (a
   * request without `paths`), counted from `counts`, unless what the view hides would change.
   */
  partial?: ReadonlyMap<string, FileListCounts | null>;
  /** The eye: reviewed files are listed (default true). */
  showsReviewed?: boolean;
  /** The "From main" chip: only the default branch's files are listed (default false). */
  fromMainOnly?: boolean;
}

/** Own files of a whole list whose mark is not `reviewed` (`api/files.ts` `ownToChange`). */
function ownToChangeOf(counts: FileListCounts, reviewed: boolean): number {
  const own = counts.total - counts.base;
  const ownReviewed = counts.reviewed - counts.baseReviewed;
  return reviewed ? own - ownReviewed : ownReviewed;
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
  const partial = input.partial ?? new Map<string, FileListCounts | null>();
  // Partly loaded worktrees (#42): what a whole-worktree request would change, from the counts.
  const partialCounts = new Map<string, number>();
  for (const [worktreeId, counts] of partial) {
    if (disabled.has(worktreeId) && !input.includeDisabled) continue;
    if (!groups.some((g) => g.worktree.id === worktreeId)) continue;
    // The chip lists base files only, which are never marked in bulk; with the eye off, marking
    // unreviewed would change the reviewed files the list hides: nothing a click should change.
    if (input.fromMainOnly || (!reviewed && input.showsReviewed === false)) continue;
    let loaded = 0;
    for (const e of entries) {
      if (e.worktreeId === worktreeId && !isBaseFile(e.file) && e.file.reviewed !== reviewed) {
        loaded++;
      }
    }
    const change = counts ? ownToChangeOf(counts, reviewed) : loaded;
    if (change > 0) partialCounts.set(worktreeId, change);
    else if (advance && counts && counts.base > counts.baseReviewed) advanceOnly.add(worktreeId);
  }
  for (const e of entries) {
    if (partial.has(e.worktreeId)) continue;
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
  for (const n of partialCounts.values()) count += n;
  for (const id of byWorktree.keys()) advanceOnly.delete(id);
  for (const id of partialCounts.keys()) advanceOnly.delete(id);
  for (const id of hidesOwn) advanceOnly.delete(id);
  const base = { scope: scopeField, reviewed, includeDisabled: input.includeDisabled ?? false };
  // "Review all" in To review (docs/STATUS-FLOW.md §2.3) also moves the bookmark to HEAD. Hidden
  // files there are reviewed ones only, so the whole worktree is what the user sees: no `paths`.

  if (input.allUnfiltered) {
    const ids = groups.map((g) => g.worktree.id);
    return {
      target: 'all',
      count,
      worktrees: byWorktree.size + partialCounts.size + advanceOnly.size,
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
  // Partly loaded worktrees: the daemon marks its whole list (base files are skipped there too).
  for (const worktreeId of partialCounts.keys()) {
    requests.push({
      ...base,
      target: { kind: 'worktree', worktreeId },
      ...(advance ? { advanceBookmarks: true } : {}),
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
  return {
    target: 'worktree',
    count,
    worktrees: byWorktree.size + partialCounts.size + advanceOnly.size,
    requests,
  };
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
