import type { WorktreeRow } from '../lib/model.ts';
import { worktreeSource } from '../lib/source.ts';
import { ChangeRequestChip } from './ChangeRequest.tsx';

/**
 * `main` (off the default branch), the worktree source, an in-progress operation and, unless
 * `request` is false, its PR/MR chip. Shared by the sidebar rows and the context bar.
 */
export function RowChips({ row, request = true }: { row: WorktreeRow; request?: boolean }) {
  const { worktree, summary, project } = row;
  const source = worktree.isMain ? null : worktreeSource(worktree.path);
  // The main checkout on the default branch is the expected case; the chip speaks only when the
  // main checkout sits elsewhere, or when the project has no default branch to compare with.
  const mainChip = worktree.isMain && worktree.branch !== project.defaultBranch;
  return (
    <>
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
      {summary?.inProgress && (
        <span className="od-chip text-warn" title={`${summary.inProgress} in progress`}>
          {summary.inProgress}
        </span>
      )}
      {request && <ChangeRequestChip worktreeId={worktree.id} />}
    </>
  );
}
