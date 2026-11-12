import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type FileOriginInfo,
  type FileOriginInput,
  type FileOrigins,
  type FileOriginsOptions,
  type FileOriginVia,
  GitChangedFileSchema,
  GitCoreError,
  type WorktreeLocator,
} from '@octopus-diff/contracts';
import { bstrFromBuffer, decodeRepoPath } from './bstr.js';
import { isAncestor, mergeBase } from './commits.js';
import type { GitContext, RepoInfo } from './context.js';
import { readStatus } from './diff.js';
import type { ResolvedRef } from './discovery.js';
import { integrationBase, remoteTrackingOf, resolveTip } from './integration-base.js';
import { parseRawNumstat } from './parse/diff-output.js';
import { OID } from './ref-files.js';
import {
  headRef,
  isDefaultBranch,
  REVIEW_RANGE_MAX_COMMITS_DEFAULT,
  rangeCommits,
} from './review.js';
import { resolveDefaultBranch, resolveHead } from './scope.js';
import { detectInProgress } from './summary.js';

/**
 * Merge noise (#32): which files of a review list are the worktree's own work, which came from
 * the default branch (`base`) and which are both (`mixed`).
 *
 * Inputs: `O` (the list's start, normally the review range's base), `U` (the local default
 * branch and `origin/<d>`), `N` = the newest `U` commit HEAD has absorbed (#30), `TIP` = the newer
 * of the two `U` refs, `M0` = `merge-base O N`. Per file `p` (name-only diffs between commits,
 * `-r -z --no-renames`):
 *
 *  1. Uncommitted (from the listing's `git status` flags): untracked, unstaged or unmerged -> own.
 *     During a merge or cherry-pick of a `U` commit (`OP_HEAD`), a staged-only file that is not
 *     in `diff --cached OP_HEAD` (the index has `OP_HEAD`'s version) -> base (`in-progress`), else
 *     mixed. Any other uncommitted change -> own.
 *  2. `p` not in `diff-tree N HEAD` (HEAD has `N`'s version) and in `diff-tree M0 N` (the default
 *     branch changed it since `O`) -> base (merge, rebase or update).
 *  3. `p` not in `diff-tree TIP HEAD` (HEAD has the newest default-branch version) -> base,
 *     `same-as-base` (cherry-picks, squash-landed own work, the same fix).
 *  4. `p` (or a rename's old path) in `diff-tree M0 N` -> mixed (the default branch changed it too).
 *  5. Else own (also step 2's "HEAD has `N`'s version, but the default branch never changed it":
 *     own work that was reverted, DECISIONS #199).
 *
 * Not first-parent history (a rebase puts the default branch's commits on it) and not `diff O`
 * (that is what shows the noise). Committed content is never compared with the working tree
 * (1.06 s measured on a big repo): every diff here is between commits (memoized by their ids in
 * `GitContext.memo` with the history stamp, like the other commit facts) except the index-only
 * `diff --cached` during an operation.
 *
 * Conservative where it cannot tell (DECISIONS #199): the default branch's own worktree and a
 * detached HEAD are all own (decision 4 of #25: pulled upstream work cannot be told from own work
 * once it is reachable); merges and cherry-picks of other branches are own (decision 6); a revert
 * in progress is own; no default branch, no shared history or an unborn branch: own.
 */

const NUL = '\u0000';

const InputSchema = GitChangedFileSchema.pick({
  path: true,
  rawPath: true,
  oldPath: true,
  status: true,
  staged: true,
  unstaged: true,
});

const OWN: FileOriginInfo = Object.freeze({ origin: 'own', via: null }) as FileOriginInfo;

/** Review-mark key of a bstr path from git output (`rawPath ?? path`). */
function keyOf(bstrPath: string): string {
  const decoded = decodeRepoPath(bstrPath);
  return decoded.rawPath ?? decoded.path;
}

const inputKey = (file: { path: string; rawPath?: string | undefined }): string =>
  file.rawPath ?? file.path;

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Path keys that differ between two commits (`diff-tree -r -z --name-only --no-renames`),
 * memoized by their ids (only full ids are cached).
 */
export async function changedPaths(
  ctx: GitContext,
  repo: RepoInfo,
  from: string,
  to: string,
): Promise<ReadonlySet<string>> {
  if (from === to) return EMPTY;
  const run = async (): Promise<ReadonlySet<string>> => {
    const result = await ctx.git(repo, [
      'diff-tree',
      '-r',
      '-z',
      '--name-only',
      '--no-renames',
      '--no-commit-id',
      '--end-of-options',
      from,
      to,
      '--',
    ]);
    return parseNames(result.stdout);
  };
  if (!OID.test(from) || !OID.test(to)) return run();
  const stamp = await ctx.historyStamp(repo);
  const key = `names${NUL}${repo.commonDir}${NUL}${stamp}${NUL}${from}${NUL}${to}`;
  return (await ctx.memo(key, run)) ?? EMPTY;
}

/**
 * The renames between two commits as `new path key -> old path key` (`diff-tree -r -z --raw
 * --find-renames`, rename detection as in the review list), memoized by the commit ids like
 * `changedPaths`. Used to list `base..HEAD` the way a review list does when the caller gave no files.
 */
async function committedRenames(
  ctx: GitContext,
  repo: RepoInfo,
  from: string,
  to: string,
): Promise<ReadonlyMap<string, string>> {
  if (from === to) return new Map();
  const run = async (): Promise<ReadonlyMap<string, string>> => {
    const result = await ctx.git(repo, [
      'diff-tree',
      '-r',
      '-z',
      '--raw',
      '--find-renames',
      '--no-commit-id',
      '--end-of-options',
      from,
      to,
      '--',
    ]);
    const renames = new Map<string, string>();
    for (const entry of parseRawNumstat(bstrFromBuffer(result.stdout)).raw) {
      if (entry.status === 'R') renames.set(keyOf(entry.path), keyOf(entry.srcPath));
    }
    return renames;
  };
  if (!OID.test(from) || !OID.test(to)) return run();
  const stamp = await ctx.historyStamp(repo);
  const key = `renames${NUL}${repo.commonDir}${NUL}${stamp}${NUL}${from}${NUL}${to}`;
  return (await ctx.memo(key, run)) ?? new Map();
}

function parseNames(stdout: Buffer): ReadonlySet<string> {
  const names = new Set<string>();
  for (const name of bstrFromBuffer(stdout).split(NUL)) {
    if (name.length > 0) names.add(keyOf(name));
  }
  return names;
}

/** The commit a merge / cherry-pick in progress brings in (first line of `<gitDir>/<file>`). */
async function readOpHead(repo: RepoInfo, file: string): Promise<string | null> {
  try {
    const first = (await readFile(path.join(repo.gitDir, file), 'utf8')).split('\n')[0]?.trim();
    return first && OID.test(first) ? first : null;
  } catch {
    return null;
  }
}

/** `OP_HEAD` of a merge or cherry-pick in progress that brings in default-branch history. */
async function inProgressBase(
  ctx: GitContext,
  repo: RepoInfo,
  local: ResolvedRef,
  tip: ResolvedRef,
): Promise<string | null> {
  const op = await detectInProgress(repo.gitDir);
  // A revert's staged content is the reverted commit's parent, never the default branch's: own.
  const file = op === 'merge' ? 'MERGE_HEAD' : op === 'cherry-pick' ? 'CHERRY_PICK_HEAD' : null;
  if (file === null) return null;
  const opHead = await readOpHead(repo, file);
  if (opHead === null) return null;
  // Merges and cherry-picks of other branches count as own (decision 6 of #25).
  if (await isAncestor(ctx, repo, opHead, tip.oid)) return opHead;
  if (local.oid !== tip.oid && (await isAncestor(ctx, repo, opHead, local.oid))) return opHead;
  return null;
}

/** Path keys whose index version differs from `opHead` (`diff --cached --name-only`). */
async function indexDiffers(
  ctx: GitContext,
  repo: RepoInfo,
  opHead: string,
): Promise<ReadonlySet<string>> {
  const result = await ctx.git(repo, [
    'diff',
    '--cached',
    '-z',
    '--name-only',
    '--no-renames',
    '--ignore-submodules=dirty',
    '--end-of-options',
    opHead,
    '--',
  ]);
  return parseNames(result.stdout);
}

/**
 * How the default branch's changes arrived (one answer per worktree): `update` when HEAD sits on
 * default-branch history (fast-forward, pull, reset), `merge` when `O..HEAD` has a merge commit
 * (or is too long to tell), else `rebase`. The range is the review range's (`readReviewRange`
 * with the default cap), so it is usually already memoized.
 */
async function arrivalVia(
  ctx: GitContext,
  repo: RepoInfo,
  base: string,
  head: string,
  n: string,
): Promise<FileOriginVia> {
  if (head === n) return 'update';
  const { commits, truncated } = await rangeCommits(
    ctx,
    repo,
    base,
    head,
    REVIEW_RANGE_MAX_COMMITS_DEFAULT,
  );
  if (truncated || commits.some((c) => c.parents.length > 1)) return 'merge';
  return 'rebase';
}

/** Without `files`: `base..HEAD` (committed) plus `git status` (uncommitted), like a review list. */
async function listInputs(
  ctx: GitContext,
  repo: RepoInfo,
  base: string | null,
  head: string | null,
): Promise<FileOriginInput[]> {
  const byKey = new Map<string, FileOriginInput>();
  const committed: FileOriginInput = {
    path: '',
    oldPath: null,
    status: 'modified',
    staged: false,
    unstaged: false,
  };
  if (base !== null && head !== null) {
    // A rename is one entry (new path, with its old path), not a deleted and an added file: the
    // review list says so and the rules look at the old path too (a mixed rename).
    const renames = await committedRenames(ctx, repo, base, head);
    const sources = new Set(renames.values());
    for (const key of await changedPaths(ctx, repo, base, head)) {
      if (sources.has(key) && !renames.has(key)) continue; // the old name of a rename
      const oldPath = renames.get(key) ?? null;
      byKey.set(key, {
        ...committed,
        path: key,
        oldPath,
        status: oldPath === null ? committed.status : 'renamed',
      });
    }
  }
  if (!repo.bare) {
    const status = await readStatus(ctx, repo);
    for (const entry of status.entries) {
      if (entry.kind === 'ignored') continue;
      const key = keyOf(entry.path);
      const flags: FileOriginInput = { ...committed, path: key };
      if (entry.kind === 'untracked') flags.status = 'untracked';
      else if (entry.kind === 'unmerged') flags.status = 'conflicted';
      else {
        flags.staged = entry.x !== '.';
        flags.unstaged = entry.y !== '.';
        if (entry.kind === 'renamed') flags.oldPath = keyOf(entry.origPath);
      }
      byKey.set(key, flags);
    }
  }
  return [...byKey.values()];
}

function parseOptions(options: FileOriginsOptions): {
  base: string | null;
  files: readonly FileOriginInput[] | undefined;
} {
  const raw = options?.base;
  let base: string | null = null;
  if (raw !== null && raw !== undefined) {
    const value = typeof raw === 'string' ? raw.toLowerCase() : '';
    if (!OID.test(value)) {
      throw new GitCoreError('invalid_argument', `base must be a full commit id: ${String(raw)}`);
    }
    base = value;
  }
  const files = options?.files;
  if (files === undefined) return { base, files: undefined };
  if (!Array.isArray(files)) throw new GitCoreError('invalid_argument', 'files must be an array');
  for (const file of files) {
    const parsed = InputSchema.safeParse(file);
    if (!parsed.success) {
      throw new GitCoreError('invalid_argument', `invalid file: ${parsed.error.message}`);
    }
  }
  return { base, files };
}

export async function readFileOrigins(
  ctx: GitContext,
  worktree: WorktreeLocator,
  options: FileOriginsOptions,
): Promise<FileOrigins> {
  await ctx.ensureSupported();
  const { base, files: given } = parseOptions(options);
  const repo = await ctx.repo(worktree.path);
  const [head, defaultRef, ref] = await Promise.all([
    resolveHead(ctx, repo),
    resolveDefaultBranch(ctx, repo, options),
    headRef(ctx, repo),
  ]);
  const files = given ?? (await listInputs(ctx, repo, base, head));
  const origins = new Map<string, FileOriginInfo>();
  const allOwn = (): void => {
    for (const file of files) origins.set(inputKey(file), OWN);
  };

  if (defaultRef === null) {
    allOwn();
    return { integrationRef: null, n: null, tip: null, origins };
  }
  const remote = await remoteTrackingOf(ctx, repo, defaultRef);
  const tipRef = await resolveTip(ctx, repo, defaultRef, remote);
  const integrationRef = remote !== null && tipRef.oid === remote.oid ? remote.name : tipRef.name;
  const tip = tipRef.oid;
  // The default branch's own worktree and a detached HEAD: all own (see the module comment).
  if (head === null || ref === null || isDefaultBranch(ref, defaultRef)) {
    allOwn();
    return { integrationRef, n: null, tip, origins };
  }
  const n = await integrationBase(ctx, repo, head, defaultRef, remote);
  if (n === null) {
    allOwn();
    return { integrationRef, n: null, tip, origins };
  }

  // Rule 1 inputs: only computed when some file is staged without unstaged changes.
  const stagedOnly = (f: FileOriginInput) =>
    f.status !== 'untracked' && f.status !== 'conflicted' && f.staged && !f.unstaged;
  let opDiffers: ReadonlySet<string> | null = null;
  if (!repo.bare && files.some(stagedOnly)) {
    const opHead = await inProgressBase(ctx, repo, defaultRef, tipRef);
    if (opHead !== null) opDiffers = await indexDiffers(ctx, repo, opHead);
  }

  // Rules 2-5 inputs (A = N..HEAD, B = TIP..HEAD, C = M0..N), only when a committed file needs them.
  const committed = files.filter(
    (f) => f.status !== 'untracked' && f.status !== 'conflicted' && !f.staged && !f.unstaged,
  );
  let ownSide: ReadonlySet<string> = EMPTY;
  let vsTip: ReadonlySet<string> = EMPTY;
  let baseSide: ReadonlySet<string> = EMPTY;
  let via: FileOriginVia | null = null;
  // `oldPath` of a listed file is a display string (lossy for a non-UTF-8 name), but the sets above
  // hold review-mark keys: the old name's key comes from the committed rename pairs themselves.
  let renames: ReadonlyMap<string, string> = new Map();
  const oldKeyOf = (f: FileOriginInput): string | null =>
    f.oldPath === null ? null : (renames.get(inputKey(f)) ?? f.oldPath);
  const touchedByBase = (f: FileOriginInput): boolean => {
    const old = oldKeyOf(f);
    return baseSide.has(inputKey(f)) || (old !== null && baseSide.has(old));
  };
  if (committed.length > 0 && base !== null) {
    if (committed.some((f) => f.oldPath !== null))
      renames = await committedRenames(ctx, repo, base, head);
    const m0 = await mergeBase(ctx, repo, base, n);
    const [a, b, c] = await Promise.all([
      changedPaths(ctx, repo, n, head),
      tip === n ? null : changedPaths(ctx, repo, tip, head),
      m0 === null ? EMPTY : changedPaths(ctx, repo, m0, n),
    ]);
    ownSide = a;
    vsTip = b ?? a;
    baseSide = c;
    if (committed.some(touchedByBase)) via = await arrivalVia(ctx, repo, base, head, n);
  }

  for (const file of files) {
    const key = inputKey(file);
    if (file.status === 'untracked' || file.status === 'conflicted' || file.unstaged) {
      origins.set(key, OWN);
    } else if (file.staged) {
      // Staged only: base when the index has OP_HEAD's version, mixed when it differs.
      if (opDiffers === null) origins.set(key, OWN);
      else if (opDiffers.has(key)) origins.set(key, { origin: 'mixed', via: 'in-progress' });
      else origins.set(key, { origin: 'base', via: 'in-progress' });
    } else if (base === null) {
      origins.set(key, OWN);
    } else {
      const fromBase = touchedByBase(file);
      if (!ownSide.has(key)) {
        origins.set(key, fromBase && via !== null ? { origin: 'base', via } : OWN);
      } else if (!vsTip.has(key)) {
        origins.set(key, { origin: 'base', via: 'same-as-base' });
      } else if (fromBase && via !== null) {
        origins.set(key, { origin: 'mixed', via });
      } else {
        origins.set(key, OWN);
      }
    }
  }
  return { integrationRef, n, tip, origins };
}
