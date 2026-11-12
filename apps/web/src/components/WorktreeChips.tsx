import { TEST_IDS } from '@octopus-diff/contracts';
import { isDefaultBranch, type WorktreeRow } from '../lib/model.ts';
import { worktreeSource } from '../lib/source.ts';
import { ChangeRequestChip } from './ChangeRequest.tsx';

/**
 * `N deleted`, `main` (off the default branch), the worktree source, an in-progress operation and,
 * unless `request` is false, its PR/MR chip. Shared by the sidebar rows and the context bar. A
 * `compact` list (the sidebar's second line) leaves out the source and the operation: the row says
 * those elsewhere (its hover card, the status slot), and a second line has little room.
 */
export function RowChips({
  row,
  request = true,
  compact = false,
}: {
  row: WorktreeRow;
  request?: boolean;
  compact?: boolean;
}) {
  const { worktree, summary, project } = row;
  const source = worktree.isMain || compact ? null : worktreeSource(worktree.path);
  // The main checkout on the default branch is the expected case; the chip speaks only when the
  // main checkout sits elsewhere, or when the project has no default branch to compare with.
  const mainChip = worktree.isMain && worktree.branch !== project.defaultBranch;
  return (
    <>
      <DeletedChip row={row} />
      {mainChip && (
        <span className="od-chip" title="Main checkout">
          main
        </span>
      )}
      {source && (
        <span className="od-chip font-mono" title={source.title}>
          {source.label}
        </span>
      )}
      {summary?.inProgress && !compact && (
        <span className="od-chip text-warn" title={`${summary.inProgress} in progress`}>
          {summary.inProgress}
        </span>
      )}
      {request && <ChangeRequestChip worktreeId={worktree.id} />}
    </>
  );
}

/** The testid of the "N deleted" chip. */
export const DELETED_CHIP_TEST_ID = 'deleted-chip';

/** How many tracked files are deleted and not committed (0 when none or unknown: an older daemon). */
export function deletedCount(row: Pick<WorktreeRow, 'summary'>): number {
  return row.summary?.counts.deleted ?? 0;
}

/**
 * "3 deleted": tracked files removed and not yet committed. State-based, not time-based: it is
 * there while the deletions are, and gone when they are committed or undone (the daemon's
 * `counts.deleted`, #38; absent from an older daemon, then no chip).
 */
export function DeletedChip({ row }: { row: WorktreeRow }) {
  const n = deletedCount(row);
  if (n <= 0) return null;
  return (
    <span
      data-testid={DELETED_CHIP_TEST_ID}
      className="od-chip font-sans text-del"
      title={`${n} tracked ${n === 1 ? 'file is' : 'files are'} deleted and not committed`}
    >
      {n} deleted
    </span>
  );
}

/**
 * `default` beside the branch name of the worktree that has the project's default branch checked
 * out: an outlined ink chip (`.od-chip-default`), the one chip that is not a grey fact.
 */
export function DefaultBranchChip({ row }: { row: WorktreeRow }) {
  if (!isDefaultBranch(row.worktree, row.project)) return null;
  return (
    <span
      data-testid={TEST_IDS.defaultBranchChip}
      className="od-chip od-chip-default shrink-0 font-sans"
      title={`${row.worktree.branch} is the default branch of ${row.project.name}: the baseline the other branches are compared with`}
    >
      default
    </span>
  );
}
