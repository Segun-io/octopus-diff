import {
  type CommitDetails,
  CommitShaSchema,
  GitCoreError,
  isGitCoreError,
  type ReviewRange,
  type ReviewRangeCommit,
  type ReviewRangeOptions,
  type WorktreeLocator,
} from '@octopus-diff/contracts';
import { bstrFromBuffer, decodeRepoPath } from './bstr.js';
import { isAncestor, mergeBase } from './commits.js';
import type { GitContext, RepoInfo } from './context.js';
import type { ResolvedRef } from './discovery.js';
import { LruCache } from './fs-utils.js';
import { readHeadFromFiles } from './ref-files.js';
import {
  CANONICAL_CONTEXT,
  DIFF_PINS,
  resolveCommit,
  resolveDefaultBranch,
  resolveHead,
} from './scope.js';

/** Default and maximum `maxCommits` of `readReviewRange`. */
export const REVIEW_RANGE_MAX_COMMITS_DEFAULT = 500;
export const REVIEW_RANGE_MAX_COMMITS_LIMIT = 100_000;

/** Shas per `git log` invocation in `describeCommits` (keeps argv small). */
const DESCRIBE_BATCH = 200;

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Per-commit details by `<commonDir>\0<sha>`; commits are immutable, so entries never go stale. */
export type CommitDetailsCache = LruCache<string, CommitDetails>;

export function createCommitDetailsCache(): CommitDetailsCache {
  return new LruCache<string, CommitDetails>(20_000);
}

export interface ReviewDeps {
  ctx: GitContext;
  commitCache: CommitDetailsCache;
}

function fullSha(value: unknown, what: string): string {
  const sha = typeof value === 'string' ? value.toLowerCase() : '';
  if (!FULL_SHA.test(sha)) {
    throw new GitCoreError(
      'invalid_argument',
      `${what} must be a full commit id: ${String(value)}`,
    );
  }
  return sha;
}

// ---------------------------------------------------------------------------------------------
// readReviewRange
// ---------------------------------------------------------------------------------------------

/** The full ref HEAD points at, or null when detached (from the files when they can tell). */
async function headRef(ctx: GitContext, repo: RepoInfo): Promise<string | null> {
  const fromFiles = await readHeadFromFiles(repo.gitDir, repo.commonDir);
  if (fromFiles !== undefined) return fromFiles.ref;
  const result = await ctx.git(repo, ['symbolic-ref', '-q', 'HEAD'], { okExitCodes: [0, 1] });
  const ref = result.stdout.toString('utf8').trim();
  return result.exitCode === 0 && ref ? ref : null;
}

/** HEAD's branch is the default branch (its local branch, when the default is remote-tracking). */
function isDefaultBranch(ref: string, defaultRef: ResolvedRef | null): boolean {
  if (!defaultRef) return false;
  if (ref === defaultRef.ref) return true;
  const remote = /^refs\/remotes\/[^/]+\/(.+)$/.exec(defaultRef.ref);
  return remote !== null && ref === `refs/heads/${remote[1]}`;
}

/** Ranges with at most this many commits are memoized (by common dir, base, head and limit). */
const RANGE_MEMO_MAX_COMMITS = 5000;

/** `rev-list --parents base..head`, at most `maxCommits` (+1 to detect truncation). */
async function rangeCommits(
  ctx: GitContext,
  repo: RepoInfo,
  base: string,
  head: string,
  maxCommits: number,
): Promise<{ commits: ReviewRangeCommit[]; truncated: boolean }> {
  const compute = async () => {
    const result = await ctx.git(repo, [
      'rev-list',
      '--parents',
      `--max-count=${maxCommits + 1}`,
      '--end-of-options',
      `${base}..${head}`,
      '--',
    ]);
    let commits = result.stdout
      .toString('utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [sha = '', ...parents] = line.split(' ');
        return { sha, parents };
      });
    let truncated = false;
    if (commits.length > maxCommits) {
      truncated = true;
      commits = commits.slice(0, maxCommits);
    }
    return { commits, truncated };
  };
  // Both ends are full commit ids (HEAD and a merge base / bookmark): the range never changes.
  if (!FULL_SHA.test(base) || !FULL_SHA.test(head) || maxCommits > RANGE_MEMO_MAX_COMMITS) {
    return compute();
  }
  const key = `range\u0000${repo.commonDir}\u0000${base}\u0000${head}\u0000${maxCommits}`;
  const range = (await ctx.memo(key, compute)) as {
    commits: ReviewRangeCommit[];
    truncated: boolean;
  };
  return {
    commits: range.commits.map((c) => ({ sha: c.sha, parents: [...c.parents] })),
    truncated: range.truncated,
  };
}

export async function readReviewRange(
  deps: ReviewDeps,
  worktree: WorktreeLocator,
  options: ReviewRangeOptions,
): Promise<ReviewRange> {
  const { ctx } = deps;
  await ctx.ensureSupported();
  const bookmark =
    options?.bookmark === null || options?.bookmark === undefined
      ? null
      : fullSha(options.bookmark, 'bookmark');
  const maxCommits = options?.maxCommits ?? REVIEW_RANGE_MAX_COMMITS_DEFAULT;
  if (
    !Number.isInteger(maxCommits) ||
    maxCommits < 1 ||
    maxCommits > REVIEW_RANGE_MAX_COMMITS_LIMIT
  ) {
    throw new GitCoreError(
      'invalid_argument',
      `maxCommits must be 1..${REVIEW_RANGE_MAX_COMMITS_LIMIT}`,
    );
  }
  const repo = await ctx.repo(worktree.path);
  const head = await resolveHead(ctx, repo);
  if (head === null) {
    return {
      head: null,
      startsAtHead: false,
      bookmarkReachable: false,
      initial: null,
      base: null,
      commits: [],
      truncated: false,
    };
  }

  // The default branch is resolved at most once, and only when needed.
  let defaultRef: Promise<ResolvedRef | null> | null = null;
  const getDefault = (): Promise<ResolvedRef | null> => {
    defaultRef ??= resolveDefaultBranch(ctx, repo, options);
    return defaultRef;
  };
  const [ref, bookmarkReachable] = await Promise.all([
    headRef(ctx, repo),
    bookmark === null ? Promise.resolve(false) : isAncestor(ctx, repo, bookmark, head),
  ]);
  const startsAtHead = ref === null || isDefaultBranch(ref, await getDefault());
  const mergeBaseWithDefault = async (): Promise<string> => {
    const target = await getDefault();
    return (target ? await mergeBase(ctx, repo, head, target.oid) : null) ?? head;
  };

  let initial: string | null = null;
  let base: string;
  if (bookmark === null) {
    initial = startsAtHead ? head : await mergeBaseWithDefault();
    base = initial;
  } else if (bookmarkReachable) {
    base = bookmark;
  } else if (startsAtHead) {
    base = (await mergeBase(ctx, repo, head, bookmark)) ?? head;
  } else {
    base = await mergeBaseWithDefault();
  }

  let commits: ReviewRangeCommit[] = [];
  let truncated = false;
  if (base !== head) {
    ({ commits, truncated } = await rangeCommits(ctx, repo, base, head, maxCommits));
  }
  return { head, startsAtHead, bookmarkReachable, initial, base, commits, truncated };
}

// ---------------------------------------------------------------------------------------------
// describeCommits
// ---------------------------------------------------------------------------------------------

interface CommitPaths {
  parents: string[];
  paths: string[];
}

/**
 * Parses `git log --no-walk --cc --name-only -z --format=%x01%H %P` output (bstr). Records
 * start with \x01; the header ends at the first NUL; then a "\n" (single-parent commits) or a
 * NUL (merges) when paths follow, and NUL-terminated paths.
 */
export function parseCommitPaths(output: string): Map<string, CommitPaths> {
  const commits = new Map<string, CommitPaths>();
  for (const record of output.split('\u0001')) {
    if (record.length === 0) continue;
    const headerEnd = record.indexOf('\u0000');
    const header = headerEnd < 0 ? record : record.slice(0, headerEnd);
    let rest = headerEnd < 0 ? '' : record.slice(headerEnd + 1);
    if (rest.startsWith('\n') || rest.startsWith('\u0000')) rest = rest.slice(1);
    const [sha = '', ...parents] = header.trim().split(' ');
    if (!sha) continue;
    const paths = rest
      .split('\u0000')
      .filter((value) => value.length > 0)
      .map((value) => {
        const decoded = decodeRepoPath(value);
        return decoded.rawPath ?? decoded.path;
      });
    commits.set(sha, { parents: parents.filter((p) => p.length > 0), paths: [...new Set(paths)] });
  }
  return commits;
}

/** Parses `git patch-id --stable` output: `<patch-id> <commit-id>` per line. */
export function parsePatchIds(output: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const line of output.split('\n')) {
    const [patchId, sha] = line.trim().split(' ');
    if (patchId && sha) ids.set(sha, patchId);
  }
  return ids;
}

async function patchIdOf(ctx: GitContext, repo: RepoInfo, patch: Buffer): Promise<string> {
  if (patch.length === 0) return '';
  const result = await ctx.git(repo, ['patch-id', '--stable'], { input: patch });
  return result.stdout.toString('utf8');
}

function notFoundCommit(shas: readonly string[], error?: GitCoreError): GitCoreError {
  return new GitCoreError(
    'not_found',
    `commit not found: ${shas.slice(0, 5).join(', ')}${shas.length > 5 ? ', ...' : ''}`,
    error?.details ?? {},
  );
}

async function describeBatch(
  ctx: GitContext,
  repo: RepoInfo,
  shas: readonly string[],
): Promise<CommitDetails[]> {
  let pathsOutput: string;
  try {
    const result = await ctx.git(repo, [
      'log',
      '--no-walk=unsorted',
      '--root',
      '--cc',
      '--name-only',
      '-z',
      '--no-renames',
      '--format=%x01%H %P',
      '--end-of-options',
      ...shas,
      '--',
    ]);
    pathsOutput = bstrFromBuffer(result.stdout);
  } catch (error) {
    if (isGitCoreError(error, 'git_failed')) throw notFoundCommit(shas, error);
    throw error;
  }
  const described = parseCommitPaths(pathsOutput);
  const missing = shas.filter((sha) => !described.has(sha));
  if (missing.length > 0) throw notFoundCommit(missing);

  const single = shas.filter((sha) => (described.get(sha)?.parents.length ?? 0) <= 1);
  let patchIds = new Map<string, string>();
  if (single.length > 0) {
    const patches = await ctx.git(repo, [
      'log',
      '-p',
      '--no-walk=unsorted',
      '--root',
      '--format=commit %H',
      ...DIFF_PINS,
      `-U${CANONICAL_CONTEXT}`,
      '--end-of-options',
      ...single,
      '--',
    ]);
    patchIds = parsePatchIds(await patchIdOf(ctx, repo, patches.stdout));
  }
  return shas.map((sha) => {
    const info = described.get(sha) as CommitPaths;
    return {
      sha,
      patchId: info.parents.length > 1 ? null : (patchIds.get(sha) ?? null),
      paths: info.paths,
    };
  });
}

export async function describeCommits(
  deps: ReviewDeps,
  worktree: WorktreeLocator,
  shasInput: readonly string[],
): Promise<CommitDetails[]> {
  const { ctx, commitCache } = deps;
  await ctx.ensureSupported();
  if (!Array.isArray(shasInput)) {
    throw new GitCoreError('invalid_argument', 'shas must be an array of commit ids');
  }
  const shas = shasInput.map((sha) => fullSha(sha, 'sha'));
  if (shas.length === 0) return [];
  const repo = await ctx.repo(worktree.path);
  const cacheKey = (sha: string): string => `${repo.commonDir}\u0000${sha}`;
  const found = new Map<string, CommitDetails>();
  const wanted: string[] = [];
  for (const sha of new Set(shas)) {
    const cached = commitCache.get(cacheKey(sha));
    if (cached) found.set(sha, cached);
    else wanted.push(sha);
  }
  for (let i = 0; i < wanted.length; i += DESCRIBE_BATCH) {
    for (const details of await describeBatch(ctx, repo, wanted.slice(i, i + DESCRIBE_BATCH))) {
      found.set(details.sha, details);
      commitCache.set(cacheKey(details.sha), details);
    }
  }
  return shas.map((sha) => {
    const details = found.get(sha) as CommitDetails;
    return { sha: details.sha, patchId: details.patchId, paths: [...details.paths] };
  });
}

// ---------------------------------------------------------------------------------------------
// rangePatchId
// ---------------------------------------------------------------------------------------------

export async function rangePatchId(
  deps: ReviewDeps,
  worktree: WorktreeLocator,
  from: string,
  to: string,
): Promise<string | null> {
  const { ctx } = deps;
  await ctx.ensureSupported();
  for (const [name, value] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (!CommitShaSchema.safeParse(value).success) {
      throw new GitCoreError('invalid_argument', `${name} must be a commit id: ${String(value)}`);
    }
  }
  const repo = await ctx.repo(worktree.path);
  const [a, b] = await Promise.all([resolveCommit(ctx, repo, from), resolveCommit(ctx, repo, to)]);
  if (a === b) return null;
  const diff = await ctx.git(repo, [
    'diff',
    ...DIFF_PINS,
    '-p',
    `-U${CANONICAL_CONTEXT}`,
    a,
    b,
    '--',
  ]);
  const output = await patchIdOf(ctx, repo, diff.stdout);
  const [patchId] = output.trim().split(' ');
  return patchId ? patchId : null;
}
