import {
  type DiffScope,
  DiffScopeSchema,
  GitCoreError,
  RefNameSchema,
  type ScopeOptions,
} from '@octopus-diff/contracts';
import { commitParents, mergeBase, verifyCommit } from './commits.js';
import type { GitContext, RepoInfo } from './context.js';
import { detectDefaultBranchRef, type ResolvedRef, resolveRefName } from './discovery.js';
import { OID, readHeadFromFiles } from './ref-files.js';

/**
 * Flags on every `git diff` git-core runs, so that output does not depend on user or repo
 * config: full object names, fixed prefixes, rename detection, Myers, no hunk merging, short
 * submodule format, submodules reported only when their commit changes, no orderfile.
 * Copy detection is added per scope (`ScopePlan.findCopies`).
 */
export const DIFF_PINS: readonly string[] = [
  '--no-abbrev',
  '--full-index',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--find-renames',
  '--diff-algorithm=myers',
  '--indent-heuristic',
  '--inter-hunk-context=0',
  '--ignore-submodules=dirty',
  '--submodule=short',
  '-O/dev/null',
  '--no-relative',
];

/** Context lines of the canonical patch (patchHash is always computed from it). */
export const CANONICAL_CONTEXT = 3;

/** How to produce the diff for one scope. */
export interface ScopePlan {
  kind: DiffScope['kind'];
  /** Revision arguments placed before `--`, e.g. `['HEAD']` or `['--cached', 'HEAD']`. */
  revArgs: string[];
  /** working / staged / unstaged: file flags and conflicts come from `git status`. */
  statusBased: boolean;
  /** working, review, branch with includeWorking: untracked files are part of the scope. */
  includeUntracked: boolean;
  /**
   * The working tree (index and untracked files included) against one commit: `working`,
   * `review` and `branch` with `includeWorking`. File flags (staged/unstaged) come from
   * `git status` (relative to HEAD) exactly as in `working`.
   */
  vsWorktree: boolean;
  /** Nothing can differ (e.g. branch scope on an unborn HEAD, or a bare repository). */
  empty: boolean;
  /** Revision args use `HEAD`, which fails on an unborn branch (retry with the empty tree). */
  usesHead: boolean;
  /**
   * Detect copies (`--find-copies`). Only for scopes that do not read the worktree: with
   * `diff.autoRefreshIndex=false`, stat-dirty but unchanged files count as modified and would
   * become copy sources, so results would depend on stat state rather than content.
   */
  findCopies: boolean;
}

export function parseScope(scope: unknown): DiffScope {
  const parsed = DiffScopeSchema.safeParse(scope);
  if (!parsed.success) {
    throw new GitCoreError('invalid_argument', `invalid diff scope: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function parseDefaultBranch(options: ScopeOptions | undefined): string | null {
  const value = options?.defaultBranch;
  if (value === undefined || value === null) return null;
  if (!RefNameSchema.safeParse(value).success) {
    throw new GitCoreError('invalid_argument', `invalid default branch: ${value}`);
  }
  return value;
}

/** Resolves `options.defaultBranch` (or auto-detects it) to a full ref; null if none exists. */
export async function resolveDefaultBranch(
  ctx: GitContext,
  repo: RepoInfo,
  options: ScopeOptions | undefined,
): Promise<ResolvedRef | null> {
  const name = parseDefaultBranch(options);
  if (name !== null) return resolveRefName(ctx, repo, name);
  return detectDefaultBranchRef(ctx, repo);
}

/**
 * Full HEAD commit id, or null for an unborn branch. From `<gitDir>/HEAD` and the ref files
 * when they can tell (#29), else `rev-parse`.
 */
export async function resolveHead(ctx: GitContext, repo: RepoInfo): Promise<string | null> {
  const fromFiles = await readHeadFromFiles(repo.gitDir, repo.commonDir);
  if (fromFiles !== undefined) return fromFiles.sha;
  const result = await ctx.git(repo, ['rev-parse', '--quiet', '--verify', 'HEAD^{commit}'], {
    okExitCodes: [0, 1],
  });
  const sha = result.stdout.toString('utf8').trim();
  return result.exitCode === 0 && sha ? sha : null;
}

/** Full id of the commit `rev` names (`rev-parse --verify <rev>^{commit}`); `not_found` if none. */
export async function resolveCommit(ctx: GitContext, repo: RepoInfo, rev: string): Promise<string> {
  // A full object id names the same commit forever: memoized per repository (#29).
  if (OID.test(rev)) return verifyCommit(ctx, repo, rev);
  const result = await ctx.git(
    repo,
    ['rev-parse', '--quiet', '--verify', '--end-of-options', `${rev}^{commit}`],
    { okExitCodes: [0, 1, 128] },
  );
  const sha = result.stdout.toString('utf8').trim();
  if (result.exitCode !== 0 || !sha)
    throw new GitCoreError('not_found', `commit not found: ${rev}`);
  return sha;
}

export async function planScope(
  ctx: GitContext,
  repo: RepoInfo,
  scope: DiffScope,
  options: ScopeOptions | undefined,
): Promise<ScopePlan> {
  const base: Omit<ScopePlan, 'kind' | 'revArgs'> = {
    statusBased: false,
    includeUntracked: false,
    vsWorktree: false,
    empty: false,
    usesHead: false,
    findCopies: true,
  };
  /** The working tree against `commit` (`HEAD`: with the unborn-branch fallback). */
  const worktreeAgainst = (kind: 'working' | 'review' | 'branch', commit: string): ScopePlan => ({
    ...base,
    kind,
    revArgs: [commit],
    statusBased: true,
    includeUntracked: true,
    vsWorktree: true,
    usesHead: commit === 'HEAD',
    empty: repo.bare,
    findCopies: false,
  });
  switch (scope.kind) {
    case 'working':
      return worktreeAgainst('working', 'HEAD');
    case 'review': {
      if (scope.base === undefined || repo.bare) return worktreeAgainst('review', 'HEAD');
      return worktreeAgainst('review', await resolveCommit(ctx, repo, scope.base));
    }
    case 'staged':
      return {
        ...base,
        kind: 'staged',
        revArgs: ['--cached', 'HEAD'],
        statusBased: true,
        usesHead: true,
        empty: repo.bare,
      };
    case 'unstaged':
      return {
        ...base,
        kind: 'unstaged',
        revArgs: [],
        statusBased: true,
        empty: repo.bare,
        findCopies: false,
      };
    case 'branch': {
      const [head, baseRef] = await Promise.all([
        resolveHead(ctx, repo),
        scope.base !== undefined
          ? resolveRefName(ctx, repo, scope.base)
          : resolveDefaultBranch(ctx, repo, options),
      ]);
      if (!baseRef) {
        const wanted = scope.base ?? parseDefaultBranch(options);
        throw wanted
          ? new GitCoreError('not_found', `base ref not found: ${wanted}`)
          : new GitCoreError(
              'invalid_argument',
              'branch scope needs a base: no default branch was given or detected',
            );
      }
      if (!head) {
        // Unborn: nothing is committed, so "All on branch" is the working tree.
        return scope.includeWorking && !repo.bare
          ? worktreeAgainst('branch', 'HEAD')
          : { ...base, kind: 'branch', revArgs: [], empty: true };
      }
      const mb = await mergeBase(ctx, repo, head, baseRef.oid);
      if (!mb) {
        throw new GitCoreError('not_found', `no merge base between HEAD and ${baseRef.name}`);
      }
      // A bare repository has no working tree: "All on branch" is the committed part.
      if (scope.includeWorking && !repo.bare) return worktreeAgainst('branch', mb);
      return { ...base, kind: 'branch', revArgs: [mb, head] };
    }
    case 'commit': {
      const [sha, parent] = await commitParents(ctx, repo, scope.sha);
      if (!sha) throw new GitCoreError('not_found', `commit not found: ${scope.sha}`);
      return { ...base, kind: 'commit', revArgs: [parent ?? repo.emptyTree, sha] };
    }
  }
}

/** Revision args with `HEAD` replaced by the empty tree (for unborn branches). */
export function unbornRevArgs(plan: ScopePlan, repo: RepoInfo): string[] {
  return plan.revArgs.map((arg) => (arg === 'HEAD' ? repo.emptyTree : arg));
}
