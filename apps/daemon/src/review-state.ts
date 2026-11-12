import type {
  DiffScope,
  FileOrigin,
  FileOriginVia,
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

/**
 * Merge noise (#33): the commits of a review range that are default-branch history, i.e. `N` (the
 * newest default-branch commit HEAD has absorbed, `FileOrigins.n`) and its ancestors inside the
 * range. A merge or rebase of the default branch brings them in; they are reviewed on the default
 * branch's own worktree, not here. Walked in memory over the range's parent links (no git process):
 * every ancestor of `N` that is in `base..HEAD` is reached through commits that are in it too (a
 * commit on the path that `base` contained would make its ancestors `base`'s as well). Equal to
 * "reachable from the local default branch or `origin/<d>`" whenever that merge base is unique
 * (criss-cross histories: DECISIONS #200). `n` null (unknown, the default branch's own worktree, a
 * detached HEAD): none. A truncated range only knows its listed commits.
 */
export function defaultBranchCommits(
  range: Pick<ReviewRange, 'commits'>,
  n: string | null,
): ReadonlySet<string> {
  const found = new Set<string>();
  if (n === null || range.commits.length === 0) return found;
  const parents = new Map<string, readonly string[]>();
  for (const c of range.commits) parents.set(c.sha, c.parents);
  const stack = [n];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (found.has(sha)) continue;
    const up = parents.get(sha);
    if (up === undefined) continue;
    found.add(sha);
    for (const p of up) stack.push(p);
  }
  return found;
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
  /** Unreviewed commits of the range (newest first), default-branch commits excluded (#33). */
  unreviewedCommits: string[];
  /**
   * Commits of the range that are default-branch history (`defaultBranchCommits`): never counted
   * in `newCommits` and never recorded as reviewed by a bookmark move here (#33).
   */
  baseCommits: ReadonlySet<string>;
  /** `N` from the file origins (null when unknown or not computed). */
  integrationBase: string | null;
  /**
   * Non-own origins of the listed files by `rawPath ?? path` (null when not labeled), reused to
   * label live activity entries (#38).
   */
  origins?: ReadonlyMap<string, { origin: FileOrigin; originVia?: FileOriginVia }> | null;
  info: WorktreeReview;
}
