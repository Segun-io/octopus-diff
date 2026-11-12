import { GitCoreError, isGitCoreError } from '@octopus-diff/contracts';
import type { GitContext, RepoInfo } from './context.js';
import { OID } from './ref-files.js';
import { Flight } from './runner/call-context.js';

/**
 * Facts about commits, shared by every worktree of a repository (#29). Objects are immutable, so
 * a result for given commit ids never changes: they are cached by `(commonDir, ids)` in
 * `GitContext.memo`. Only positive results are stored (a commit missing today may arrive with a
 * fetch). What a shallow clone shows of the history is not immutable: facts that depend on
 * parents or reachability also carry `GitContext.historyStamp` in their key. Every git call still
 * goes through the runner and its allowlist.
 */

const NUL = '\u0000';

/**
 * Only full object ids are cached: an abbreviation (`CommitShaSchema` accepts four characters) is
 * resolved by git on every call, because a fetch can make it ambiguous, and git must then say so.
 * Results are cached under the full ids that came out of it.
 */
const full = (...ids: string[]): boolean => ids.every((id) => OID.test(id));

/** `memo` when the key is made of full ids, a plain call otherwise. */
const memoIf = <T>(
  ctx: GitContext,
  cacheable: boolean,
  key: string,
  compute: () => Promise<T | undefined>,
): Promise<T | undefined> => (cacheable ? ctx.memo(key, compute) : compute());

export interface AheadBehind {
  ahead: number;
  behind: number;
}

/** `merge-base a b`, or null when there is none (or an object is missing). */
export async function mergeBase(
  ctx: GitContext,
  repo: RepoInfo,
  a: string,
  b: string,
): Promise<string | null> {
  if (a === b && OID.test(a)) return a;
  const stamp = await ctx.historyStamp(repo);
  const key = `merge-base${NUL}${repo.commonDir}${NUL}${stamp}${NUL}${a}${NUL}${b}`;
  const sha = await memoIf(ctx, full(a, b), key, async () => {
    const result = await ctx.git(repo, ['merge-base', '--end-of-options', a, b], {
      okExitCodes: [0, 1, 128],
    });
    const out = result.stdout.toString('utf8').trim();
    return result.exitCode === 0 && out ? out : undefined;
  });
  return sha ?? null;
}

/**
 * `merge-base <head> <tip>...` (git's "hypothetical merge of the tips"): the newest commit that
 * `head` shares with the history of any of the tips. Null when there is none (or an object is
 * missing). Memoized like `mergeBase`.
 */
export async function mergeBaseOfTips(
  ctx: GitContext,
  repo: RepoInfo,
  head: string,
  tips: readonly string[],
): Promise<string | null> {
  if (tips.length === 0) return null;
  const stamp = await ctx.historyStamp(repo);
  const key = `merge-base-tips${NUL}${repo.commonDir}${NUL}${stamp}${NUL}${head}${NUL}${tips.join(NUL)}`;
  const sha = await memoIf(ctx, full(head, ...tips), key, async () => {
    const result = await ctx.git(repo, ['merge-base', '--end-of-options', head, ...tips], {
      okExitCodes: [0, 1, 128],
    });
    const out = result.stdout.toString('utf8').trim();
    return result.exitCode === 0 && out ? out : undefined;
  });
  return sha ?? null;
}

/** `merge-base --is-ancestor`: exit 0 yes, 1 no; a missing object (128) counts as no. */
export async function isAncestor(
  ctx: GitContext,
  repo: RepoInfo,
  ancestor: string,
  head: string,
): Promise<boolean> {
  if (ancestor === head) return true;
  const stamp = await ctx.historyStamp(repo);
  const key = `is-ancestor${NUL}${repo.commonDir}${NUL}${stamp}${NUL}${ancestor}${NUL}${head}`;
  const answer = await memoIf(ctx, full(ancestor, head), key, async () => {
    const result = await ctx.git(
      repo,
      ['merge-base', '--is-ancestor', '--end-of-options', ancestor, head],
      { okExitCodes: [0, 1, 128] },
    );
    // 128 (missing object) is not stored: the object may arrive later.
    return result.exitCode === 128 ? undefined : result.exitCode === 0;
  });
  return answer === true;
}

/** Full id of the commit `sha` names (a full object id), memoized; `not_found` if none. */
export async function verifyCommit(ctx: GitContext, repo: RepoInfo, sha: string): Promise<string> {
  const key = `commit${NUL}${repo.commonDir}${NUL}${sha}`;
  const found = await memoIf(ctx, full(sha), key, async () => {
    const result = await ctx.git(
      repo,
      ['rev-parse', '--quiet', '--verify', '--end-of-options', `${sha}^{commit}`],
      { okExitCodes: [0, 1, 128] },
    );
    const out = result.stdout.toString('utf8').trim();
    return result.exitCode === 0 && out ? out : undefined;
  });
  if (found === undefined) throw new GitCoreError('not_found', `commit not found: ${sha}`);
  return found;
}

/** `rev-list --parents --max-count=1 <sha>^{commit}` (commit and its parents), memoized. */
export async function commitParents(
  ctx: GitContext,
  repo: RepoInfo,
  sha: string,
): Promise<string[]> {
  const stamp = await ctx.historyStamp(repo);
  const key = `parents${NUL}${repo.commonDir}${NUL}${stamp}${NUL}${sha}`;
  const line = await memoIf(ctx, full(sha), key, async () => {
    try {
      const result = await ctx.git(repo, [
        'rev-list',
        '--parents',
        '--max-count=1',
        `${sha}^{commit}`,
        '--',
      ]);
      return result.stdout.toString('utf8').trim() || undefined;
    } catch (error) {
      if (isGitCoreError(error, 'git_failed')) {
        throw new GitCoreError('not_found', `commit not found: ${sha}`, error.details);
      }
      throw error;
    }
  });
  return line ? line.split(' ') : [];
}

const abKey = (repo: RepoInfo, stamp: string, head: string, base: string): string =>
  `ahead-behind${NUL}${repo.commonDir}${NUL}${stamp}${NUL}${head}${NUL}${base}`;

/** Patterns `for-each-ref` takes literally: plain branch refs (no glob characters). */
const BRANCH_PATTERN = /^refs\/heads\/[^*?[\\\s]+$/;

const batches = new WeakMap<GitContext, Map<string, Flight<void>>>();

/**
 * Ahead/behind counts of `head` against `base` (both object ids): `rev-list --left-right
 * --count head...base`. On git >= 2.41 one `for-each-ref --format=%(ahead-behind:<base>)` over
 * the branches checked out in the project's worktrees answers all of them at once (one call per
 * project and base commit, single-flight); a head that no listed branch points at (detached, or
 * moved since) falls back to `rev-list`. Null when git cannot count (missing objects).
 */
export async function aheadBehind(
  ctx: GitContext,
  repo: RepoInfo,
  head: string,
  base: string,
  branchRef: string | null,
): Promise<AheadBehind | null> {
  const stamp = await ctx.historyStamp(repo);
  const key = abKey(repo, stamp, head, base);
  const hit = ctx.recall<AheadBehind>(key);
  if (hit) return hit;
  const version = await ctx.version();
  if (version.features.forEachRefAheadBehind === true && OID.test(base)) {
    await batchAheadBehind(ctx, repo, stamp, base, branchRef);
    const batched = ctx.recall<AheadBehind>(key);
    if (batched) return batched;
  }
  const counted = await memoIf(ctx, full(head, base), key, async () => {
    const result = await ctx.git(
      repo,
      ['rev-list', '--left-right', '--count', `${head}...${base}`, '--'],
      { okExitCodes: [0, 128] },
    );
    const match = /^(\d+)\s+(\d+)/.exec(result.stdout.toString('utf8'));
    if (result.exitCode !== 0 || !match) return undefined;
    return { ahead: Number(match[1]), behind: Number(match[2]) };
  });
  return counted ?? null;
}

async function batchAheadBehind(
  ctx: GitContext,
  repo: RepoInfo,
  stamp: string,
  base: string,
  branchRef: string | null,
): Promise<void> {
  let running = batches.get(ctx);
  if (!running) {
    running = new Map();
    batches.set(ctx, running);
  }
  const runKey = `${repo.commonDir}${NUL}${stamp}${NUL}${base}`;
  const inFlight = running.get(runKey);
  if (inFlight) {
    await inFlight.join();
    return;
  }
  const patterns = new Set(ctx.checkedOutBranches(repo.commonDir));
  if (branchRef) patterns.add(branchRef);
  const list = [...patterns].filter((p) => BRANCH_PATTERN.test(p)).sort();
  if (list.length === 0) return;
  const table = running;
  // Shared by every summary of the project that asks meanwhile (#44: cancelled only when all of
  // them aborted).
  const run: Flight<void> = new Flight(
    async () => {
      try {
        const result = await ctx.git(repo, [
          'for-each-ref',
          `--format=%(objectname)%00%(ahead-behind:${base})`,
          ...list,
        ]);
        for (const line of result.stdout.toString('utf8').split('\n')) {
          const [oid = '', counts = ''] = line.split(NUL);
          const match = /^(\d+) (\d+)$/.exec(counts.trim());
          if (!OID.test(oid) || !match) continue;
          ctx.remember(abKey(repo, stamp, oid, base), {
            ahead: Number(match[1]),
            behind: Number(match[2]),
          });
        }
      } catch (error) {
        // A base git cannot read, or an old git that slipped past the version gate: rev-list
        // answers each head instead.
        if (!isGitCoreError(error, 'git_failed')) throw error;
      }
    },
    () => {
      if (table.get(runKey) === run) table.delete(runKey);
    },
  );
  table.set(runKey, run);
  // Dropped when the work settles or loses its last waiter, not when this caller stops waiting.
  void run.settled.then(() => {
    if (table.get(runKey) === run) table.delete(runKey);
  });
  await run.join();
}
