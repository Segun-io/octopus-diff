import type {
  DiffScope,
  GitChangedFile,
  ReviewRange,
  Worktree,
  WorktreeReview,
} from '@octopus-diff/contracts';

/**
 * Status flow v2 (docs/STATUS-FLOW.md): what a worktree has to review. Pure helpers; the
 * orchestration (git-core calls, caching, the store) lives in `core.ts`.
 */

/** One bookmark per (project, branch); per worktree when detached or unborn without a branch. */
export function bookmarkKey(worktree: Pick<Worktree, 'id' | 'branch' | 'detached'>): string {
  return worktree.branch && !worktree.detached
    ? `branch:${worktree.branch}`
    : `worktree:${worktree.id}`;
}

/** The file has a change that is not committed (index, worktree, untracked or a conflict). */
export function isUncommitted(file: Pick<GitChangedFile, 'staged' | 'unstaged' | 'status'>) {
  return (
    file.staged || file.unstaged || file.status === 'untracked' || file.status === 'conflicted'
  );
}

/** Review-mark form of a file's path (`rawPath ?? path`), as `CommitDetails.paths` uses. */
export function pathKey(file: Pick<GitChangedFile, 'path' | 'rawPath'>): string {
  return file.rawPath ?? file.path;
}

/**
 * A file of the review diff that only reviewed commits touched (§2.4): it has no uncommitted
 * change and no unreviewed commit in the range touched its path (or its rename source).
 * `uncovered === null` means coverage is unknown (no commit facts, or a truncated range).
 */
export function coveredByCommits(
  file: Pick<GitChangedFile, 'path' | 'rawPath' | 'oldPath' | 'staged' | 'unstaged' | 'status'>,
  uncovered: ReadonlySet<string> | null,
): boolean {
  if (uncovered === null || isUncommitted(file)) return false;
  if (uncovered.has(pathKey(file))) return false;
  return !(file.oldPath !== null && uncovered.has(file.oldPath));
}

/** The review state of one worktree at one summary state and one app-state version. */
export interface ReviewComputed {
  /** Cache key: summary stateHash, the project's review version, the default branch. */
  key: string;
  bookmarkKey: string;
  range: ReviewRange;
  /** The `review` scope with its base filled in (what `scope=review` resolves to). */
  scope: DiffScope;
  /** Paths touched by unreviewed commits in the range; null = every committed change counts. */
  uncovered: Set<string> | null;
  /** Unreviewed commits of the range (newest first). */
  unreviewedCommits: string[];
  info: WorktreeReview;
}
