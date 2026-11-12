import { RefNameSchema } from '@octopus-diff/contracts';
import { isAncestor, mergeBase, mergeBaseOfTips } from './commits.js';
import type { GitContext, RepoInfo } from './context.js';
import { type ResolvedRef, resolveRefName } from './discovery.js';

/**
 * The integration base of a branch (#30): which default-branch commit a branch diff is measured
 * against.
 *
 * `U` is the default branch as the project knows it: the local branch (`refs/heads/<d>`) and its
 * remote-tracking ref (`refs/remotes/origin/<d>`). The local one is often stale (`git fetch`, then
 * `git merge origin/<d>` into the feature branch moves only the remote-tracking ref), so diffing
 * against it alone shows other people's default-branch files as the branch's own change.
 *
 *  - `N` = `merge-base HEAD <local> <remote>`: the newest default-branch commit HEAD has absorbed
 *    (git computes it against a hypothetical merge of the two refs). The branch scope and "All on
 *    branch" diff against `N`. With no remote-tracking ref it is the plain `merge-base HEAD <local>`.
 *  - `TIP` = the newer of the two refs (`resolveTip`; the remote when they have diverged). Not used
 *    by the scopes; it is the second default-branch point #32 needs ("same as main").
 *
 * Both refs come from the ref files (`resolveRefName`, #189): no process, and nothing per worktree
 * except the one memoized `merge-base` when HEAD is neither of the two refs. The daemon never
 * fetches, so a remote-tracking ref nobody refreshed leaves `N` where it was (documented limit).
 * Only `origin` is paired with the local branch; a fork workflow whose default lives on
 * `upstream` keeps the old behaviour.
 */

const REMOTE = 'origin';
const HEADS = 'refs/heads/';

/** `refs/remotes/origin/<d>` for a local default branch ref `refs/heads/<d>`; null otherwise. */
export function remoteTrackingRefOf(baseRef: string): string | null {
  if (!baseRef.startsWith(HEADS)) return null;
  const ref = `refs/remotes/${REMOTE}/${baseRef.slice(HEADS.length)}`;
  return RefNameSchema.safeParse(ref).success ? ref : null;
}

/**
 * The remote-tracking counterpart of a default branch resolved to a local branch, or null when
 * the base is not a local branch (a remote-tracking ref, a tag) or the remote ref does not exist.
 */
export async function remoteTrackingOf(
  ctx: GitContext,
  repo: RepoInfo,
  base: ResolvedRef,
): Promise<ResolvedRef | null> {
  const ref = remoteTrackingRefOf(base.ref);
  if (ref === null) return null;
  const found = await resolveRefName(ctx, repo, ref);
  return found ? { name: ref.slice('refs/remotes/'.length), ref, oid: found.oid } : null;
}

/**
 * `N`: the commit a branch scope diffs `head` against (see the module comment), or null when
 * `head` shares no history with the default branch.
 */
export async function integrationBase(
  ctx: GitContext,
  repo: RepoInfo,
  head: string,
  base: ResolvedRef,
  remote: ResolvedRef | null,
): Promise<string | null> {
  if (remote === null || remote.oid === base.oid) return mergeBase(ctx, repo, head, base.oid);
  // HEAD is one of the refs (the default branch's own worktree, or a branch merged and not moved):
  // it has absorbed itself, and everything older.
  if (head === base.oid || head === remote.oid) return head;
  const merged = await mergeBaseOfTips(ctx, repo, head, [base.oid, remote.oid]);
  // A remote-tracking ref whose object is missing (pruned, shallow) must not break the scope.
  return merged ?? mergeBase(ctx, repo, head, base.oid);
}

/**
 * `TIP`: the newer of the two default-branch refs; the local one when the remote is missing or
 * behind, the remote one when it is ahead. When they have diverged the remote wins: it is the
 * shared line, and the local-only commits are the user's own unpushed ones. One memoized
 * `merge-base --is-ancestor` (two when they diverge).
 */
export async function resolveTip(
  ctx: GitContext,
  repo: RepoInfo,
  base: ResolvedRef,
  remote: ResolvedRef | null,
): Promise<ResolvedRef> {
  if (remote === null || remote.oid === base.oid) return base;
  if (await isAncestor(ctx, repo, remote.oid, base.oid)) return base;
  return remote;
}
