import { lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  type InProgressOperation,
  isGitCoreError,
  type SummaryOptions,
  type SummaryRefresh,
  type SummaryResult,
  type WorktreeLocator,
  type WorktreeSummary,
} from '@octopus-diff/contracts';
import { bstrFromBuffer, bstrToUtf8, compareBstr } from './bstr.js';
import { aheadBehind as countAheadBehind } from './commits.js';
import type { GitContext, RepoInfo } from './context.js';
import type { DiffDeps } from './diff.js';
import {
  dropStaleLists,
  findUnreadable,
  forgetLists,
  inspectOptions,
  lstatSignature,
  pathspecsExcluding,
  readStatus,
  STATUS_ARGS,
  untrackedAttributes,
} from './diff.js';
import { exists, mapLimit } from './fs-utils.js';
import { hashParts, STATE_HASH_LENGTH } from './hash.js';
import {
  checkHint,
  foldsCase,
  keysInRegion,
  mergeSorted,
  type NumstatRecord,
  nextJournal,
  type Region,
  readStamp,
  regionFor,
  type Stamp,
  type SummaryTrack,
  stampChange,
  trackBlocker,
} from './incremental.js';
import { DiffOutputParser, DiffParseError } from './parse/diff-output.js';
import {
  parseStatusV2,
  type StatusBranch,
  type StatusEntry,
  StatusParseError,
} from './parse/status.js';
import { readHeadFromFiles } from './ref-files.js';
import { DIFF_PINS, resolveDefaultBranch } from './scope.js';
import { buildSnapshot, emptySnapshot, snapshotCap } from './snapshot.js';
import {
  absolutePathBuffer,
  inspectUntracked,
  nestedRepoHead,
  type UntrackedInfo,
} from './untracked.js';
import {
  type IgnoreContext,
  isOmitted,
  listedKeys,
  omissionOf,
  planUntracked,
  type UntrackedPlan,
  wantsIgnoreContext,
} from './untracked-plan.js';

const STAT_CONCURRENCY = 32;

/** Detects a merge/rebase/... in progress from marker files in the worktree's git dir. */
export async function detectInProgress(gitDir: string): Promise<InProgressOperation | null> {
  const has = (name: string): Promise<boolean> => exists(path.join(gitDir, name));
  const [rebaseMerge, rebaseApply, applying, merge, cherryPick, revert, bisect] = await Promise.all(
    [
      has('rebase-merge'),
      has('rebase-apply'),
      has(path.join('rebase-apply', 'applying')),
      has('MERGE_HEAD'),
      has('CHERRY_PICK_HEAD'),
      has('REVERT_HEAD'),
      has('BISECT_START'),
    ],
  );
  if (rebaseApply && applying) return 'am';
  if (rebaseMerge || rebaseApply) return 'rebase';
  if (merge) return 'merge';
  if (cherryPick) return 'cherry-pick';
  if (revert) return 'revert';
  if (bisect) return 'bisect';
  return null;
}

/**
 * Change detector of a path with worktree changes. For a submodule (gitlink) it includes the
 * submodule's HEAD: a commit inside the submodule changes the superproject's patch for it
 * (`Subproject commit <sha>`) but neither `git status` nor the directory's stat data (F3).
 */
async function dirtySignature(root: string, key: string, gitlink: boolean): Promise<string> {
  const sig = await lstatSignature(root, key);
  if (!gitlink) return sig;
  return `${sig}|${(await nestedRepoHead(absolutePathBuffer(root, key))).fingerprint}`;
}

interface TrackedNumstat {
  /** numstat output (bstr), or '' when not run or degraded to status only. */
  output: string;
  /** Tracked files whose worktree file cannot be read (F7). */
  unreadable: Set<string>;
  /** numstat could not run at all: line counts of tracked files are unknown. */
  statusOnly: boolean;
}

/**
 * `git diff --numstat` for the working scope. One unreadable tracked file makes it exit 128
 * (F7): then it is re-run for the other changed paths, and the unreadable ones count as
 * changed without line counts. If even that is impossible, only status-based counts remain.
 */
async function trackedNumstat(
  ctx: GitContext,
  repo: RepoInfo,
  headSha: string | null,
  entries: readonly StatusEntry[],
): Promise<TrackedNumstat> {
  const args = (pathspecs: readonly string[]): string[] => [
    'diff',
    ...DIFF_PINS,
    '--numstat',
    '-z',
    headSha ?? repo.emptyTree,
    '--',
    ...pathspecs,
  ];
  try {
    const result = await ctx.git(repo, args([]));
    return { output: bstrFromBuffer(result.stdout), unreadable: new Set(), statusOnly: false };
  } catch (error) {
    if (!isGitCoreError(error, 'git_failed')) throw error;
    const unreadable = await findUnreadable(repo.cwd, entries);
    if (unreadable.size === 0) throw error;
    ctx.settings.logger.warn('some changed files cannot be read; their line counts are unknown', {
      repo: repo.cwd,
      files: [...unreadable].slice(0, 20).map(bstrToUtf8),
    });
    const pathspecs = pathspecsExcluding(entries, unreadable);
    if (pathspecs === null) return { output: '', unreadable, statusOnly: true };
    if (pathspecs.length === 0) return { output: '', unreadable, statusOnly: false };
    try {
      const result = await ctx.git(repo, args(pathspecs));
      return { output: bstrFromBuffer(result.stdout), unreadable, statusOnly: false };
    } catch (retryError) {
      if (!isGitCoreError(retryError, 'git_failed')) throw retryError;
      return { output: '', unreadable, statusOnly: true };
    }
  }
}

/**
 * Index size above which a first summary runs numstat alongside its status (#43): about 30k
 * files. Mutable for tests.
 */
export const summaryLimits = {
  speculateIndexBytes: 4 * 1024 * 1024,
  /**
   * A path whose ctime is older than the summary's start by this much cannot have changed while
   * numstat and the status ran (covers coarse ctime granularity and small clock steps).
   */
  settleMs: 2000,
};

/** The index's size from its stamp signature (`size:mtimeNs:…`), 0 when unknown. */
function indexBytes(stamp: Stamp): number {
  const size = Number(stamp.index.split(':', 1)[0]);
  return Number.isFinite(size) ? size : 0;
}

/**
 * `git diff --numstat` of the working scope against `commit`, without the unreadable-file
 * fallbacks of `trackedNumstat` (a failure is `ok: false`: the caller runs that instead).
 */
function plainNumstat(
  ctx: GitContext,
  repo: RepoInfo,
  commit: string,
  pathspecs: readonly string[] = [],
): Promise<{ ok: true; output: string } | { ok: false }> {
  return ctx.git(repo, ['diff', ...DIFF_PINS, '--numstat', '-z', commit, '--', ...pathspecs]).then(
    (run) => ({ ok: true as const, output: bstrFromBuffer(run.stdout) }),
    (error: unknown) => {
      if (isGitCoreError(error, 'git_failed')) return { ok: false as const };
      throw error;
    },
  );
}

/** Milliseconds from the mtime field of an `lstatSignature` / untracked `statSig` (`size:mtimeNs:…`). */
function sigMtimeMs(sig: string): number | null {
  const field = sig.split(':', 2)[1];
  if (!field || !/^\d+$/.test(field)) return null;
  return Number(BigInt(field) / 1_000_000n);
}

/** `sigMtimeMs` of an untracked file's inspection, once per inspection (they are reused). */
const infoMtimes = new WeakMap<UntrackedInfo, number | null>();
function infoMtimeMs(info: UntrackedInfo): number | null {
  let ms = infoMtimes.get(info);
  if (ms === undefined) {
    ms = sigMtimeMs(info.statSig);
    infoMtimes.set(info, ms);
  }
  return ms;
}

/**
 * When HEAD last moved in this worktree: the mtime of its reflog (`<gitDir>/logs/HEAD`, appended
 * on every commit, checkout, reset, merge or pull). Without a reflog (disabled, bare repos), the
 * HEAD commit's committer date (`known` reuses it for the same commit). Null on an unborn branch
 * without a reflog.
 */
async function headActivityMs(
  ctx: GitContext,
  repo: RepoInfo,
  headSha: string | null,
  known: { sha: string; ms: number | null } | null = null,
): Promise<{ ms: number | null; commit: { sha: string; ms: number | null } | null }> {
  try {
    return { ms: (await lstat(path.join(repo.gitDir, 'logs', 'HEAD'))).mtimeMs, commit: null };
  } catch {
    // No reflog: fall back to the commit date below.
  }
  if (!headSha) return { ms: null, commit: null };
  if (known?.sha === headSha) return { ms: known.ms, commit: known };
  try {
    const out = await ctx.git(repo, ['log', '-1', '--format=%ct', headSha, '--']);
    const seconds = Number(out.stdout.toString('utf8').trim());
    const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
    return { ms, commit: { sha: headSha, ms } };
  } catch (error) {
    if (isGitCoreError(error, 'git_failed')) return { ms: null, commit: null };
    throw error;
  }
}

/**
 * `WorktreeSummary.activityAt`: the newest of HEAD's activity and the given file mtimes,
 * clamped to now (a file stamped in the future must not pin a worktree to the top).
 */
function activityAt(headMs: number | null, fileMtimes: readonly (number | null)[]): string | null {
  let newest = headMs;
  for (const ms of fileMtimes) if (ms !== null && (newest === null || ms > newest)) newest = ms;
  if (newest === null) return null;
  return new Date(Math.min(newest, Date.now())).toISOString();
}

async function bareSummary(
  ctx: GitContext,
  repo: RepoInfo,
  worktree: WorktreeLocator,
): Promise<WorktreeSummary> {
  const [head, symref] = await Promise.all([
    ctx.git(repo, ['rev-parse', '--quiet', '--verify', 'HEAD^{commit}'], { okExitCodes: [0, 1] }),
    ctx.git(repo, ['symbolic-ref', '--quiet', 'HEAD'], { okExitCodes: [0, 1] }),
  ]);
  const headSha = head.exitCode === 0 ? head.stdout.toString('utf8').trim() || null : null;
  const ref = symref.exitCode === 0 ? symref.stdout.toString('utf8').trim() : '';
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref || null;
  return {
    worktreeId: worktree.worktreeId,
    projectId: worktree.projectId,
    branch,
    headSha,
    detached: branch === null,
    upstream: null,
    aheadBehindRef: null,
    ahead: null,
    behind: null,
    counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    changedFiles: 0,
    additions: 0,
    deletions: 0,
    inProgress: null,
    stateHash: hashParts(['bare-v1', headSha, branch], STATE_HASH_LENGTH),
    updatedAt: new Date().toISOString(),
    activityAt: activityAt((await headActivityMs(ctx, repo, headSha)).ms, []),
  };
}

/** The stamp of a summary that keeps no state (`incremental: false`): never compared. */
const UNSTAMPED: Stamp = {
  index: 'unstamped',
  ignore: 'unstamped',
  config: 'unstamped',
  sparse: true,
  submodules: true,
  gitlinks: true,
};

/** Everything a summary is computed from: a full status, or the last state with a hint merged in. */
interface Collected {
  mode: 'full' | 'incremental';
  stamp: Stamp;
  header: string[];
  branch: StatusBranch;
  tracked: Map<string, StatusEntry>;
  untracked: Map<string, StatusEntry>;
  /** Keys of `untracked`, sorted. */
  untrackedOrder: string[];
  /**
   * Incremental: untracked keys the refresh recomputed (removed from the last state, or listed by
   * the limited status). Every other untracked key keeps its record. Null for a full refresh.
   */
  untrackedTouched: Set<string> | null;
  /** Relevant numstat records by destination path (see `relevantRecords`). */
  numstat: Map<string, NumstatRecord[]>;
  unreadable: Set<string>;
  statusOnly: boolean;
  /** Incremental: the pathspecs whose records were recomputed. Null for a full refresh. */
  region: Region | null;
  /** Incremental: lstat signatures taken before git ran, by path. */
  presigs: Map<string, string> | null;
  /**
   * Full refresh with a kept state: each signed path's signature after the status and before the
   * numstat whose records are used. A path whose signature in `finish` differs changed after
   * those reads: the kept state gets `UNSETTLED` for it, so the next incremental refresh diffs it
   * again (the summary's own hash uses the real signature). Null: no such check.
   */
  expected: Map<string, string> | null;
  previous: SummaryTrack | undefined;
}

/** Paths git status reports as changed (tracked entries and rename sources). */
function statusPathsOf(tracked: ReadonlyMap<string, StatusEntry>): Set<string> {
  const out = new Set<string>();
  for (const entry of tracked.values()) {
    out.add(entry.path);
    if (entry.kind === 'renamed') out.add(entry.origPath);
  }
  return out;
}

/**
 * numstat records that describe a change git status reports. Stat-dirty but unchanged binary
 * files still get a `-\t-` line (see diff.ts isStatOnly); git status, which compares content,
 * does not report them, so they are neither counted nor part of the state.
 */
function relevantRecords(
  output: string,
  statusPaths: ReadonlySet<string>,
  into: Map<string, NumstatRecord[]>,
  region: Region | null,
): boolean {
  const parser = new DiffOutputParser();
  parser.write(output);
  parser.end();
  for (const entry of parser.numstat) {
    if (!statusPaths.has(entry.path) && !(entry.srcPath && statusPaths.has(entry.srcPath))) {
      continue;
    }
    if (region && (!region.has(entry.path) || (entry.srcPath && !region.has(entry.srcPath)))) {
      return false;
    }
    const list = into.get(entry.path);
    if (list) list.push(entry);
    else into.set(entry.path, [entry]);
  }
  return true;
}

function splitEntries(entries: readonly StatusEntry[]): {
  tracked: Map<string, StatusEntry>;
  untracked: Map<string, StatusEntry>;
} {
  const tracked = new Map<string, StatusEntry>();
  const untracked = new Map<string, StatusEntry>();
  for (const entry of entries) {
    if (entry.kind === 'ignored') continue;
    if (entry.kind === 'untracked') untracked.set(entry.path, entry);
    else tracked.set(entry.path, entry);
  }
  return { tracked, untracked };
}

async function collectFull(
  deps: DiffDeps,
  repo: RepoInfo,
  previous: SummaryTrack | undefined,
): Promise<Collected> {
  const { ctx } = deps;
  // Without incremental refreshes nothing is kept, so nothing is stamped either: the kill switch
  // gives the old calls exactly (no index scan, PR #89 F3).
  const stamp = deps.incremental ? await readStamp(repo, envOf(ctx)) : UNSTAMPED;
  // A worktree that had tracked changes most likely still has them: numstat runs alongside the
  // status, at HEAD as the ref files say (the last state's when they cannot tell), which the status
  // header then confirms (#43: in a 100k-file worktree each one refreshes the index, 300-400 ms, so
  // in sequence they were most of a full summary). After a commit that is the new HEAD, so a commit
  // costs one numstat, not two (PR #91 P3-1). Only with a kept state (never with
  // `incremental: false`, which keeps the old calls). Without a kept state (the first summary in a
  // session), only where numstat is expensive: an index of `summaryLimits.speculateIndexBytes`.
  let speculated: string | null | undefined;
  if (previous !== undefined) {
    if (previous.tracked.size > 0) {
      const head = await readHeadFromFiles(repo.gitDir, repo.commonDir);
      speculated = head === undefined ? previous.branch.oid : head.sha;
    }
  } else if (deps.incremental && indexBytes(stamp) >= summaryLimits.speculateIndexBytes) {
    speculated = (await readHeadFromFiles(repo.gitDir, repo.commonDir))?.sha;
  }
  const root = repo.toplevel ?? repo.cwd;
  // Running side by side, numstat and the status read the files at different moments (Greptile on
  // PR #91): what they say about a path agrees only if the file did not change meanwhile. Proof
  // per path, checked once both are done: its signature before numstat started equals the one
  // after (paths the kept state signs), or its ctime is older than `startedAt` minus a margin
  // (any later change would have moved it). Paths without proof get a numstat of their own,
  // after the status.
  const startedAt = Date.now();
  const before =
    speculated !== undefined && previous !== undefined
      ? await signPaths(root, [...previous.signatures.keys()], gitlinksOf(previous.tracked))
      : new Map<string, SignedPath>();
  const early =
    speculated === undefined ? null : plainNumstat(ctx, repo, speculated ?? repo.emptyTree);
  early?.catch(() => {});
  const status = await readStatus(ctx, repo);
  const { tracked, untracked } = splitEntries(status.entries);
  const numstat = new Map<string, NumstatRecord[]>();
  let unreadable = new Set<string>();
  let statusOnly = false;
  /** Signatures after the status, before the numstat whose records are kept (kept states only). */
  let expected: Map<string, string> | null = null;
  if (tracked.size > 0) {
    const signed = signedKeys(tracked.values());
    const ready = early && speculated === status.branch.oid ? await early : null;
    // Taken after the status (and the early numstat) and before any numstat that runs now.
    const after = deps.incremental
      ? await signPaths(root, [...signed.keys, ...signed.sources], signed.gitlinks)
      : null;
    if (after) expected = new Map([...after].map(([key, value]) => [key, value.sig]));
    let result: TrackedNumstat | null = ready?.ok
      ? { output: ready.output, unreadable, statusOnly }
      : null;
    if (result && after) {
      const cutoff = startedAt - summaryLimits.settleMs;
      const unproven = [...after]
        .filter(([key, now]) => {
          if (before.get(key)?.sig === now.sig) return false;
          if (signed.gitlinks.has(key)) return true;
          return now.changedMs === null || now.changedMs >= cutoff;
        })
        .map(([key]) => key);
      if (unproven.length > 0) {
        speculationChecks.rerun++;
        // Limited runs equal a full one only where incremental refreshes are allowed (#287-#289):
        // conflicts, submodules or gitlinks and sparse checkouts get the whole numstat again.
        const limitedOk =
          !stamp.sparse &&
          !stamp.submodules &&
          !stamp.gitlinks &&
          ![...tracked.values()].some((entry) => entry.kind === 'unmerged');
        result = limitedOk
          ? await recheckNumstat(ctx, repo, tracked, status.branch.oid, result, unproven)
          : null;
      } else speculationChecks.trusted++;
    }
    result ??= await trackedNumstat(ctx, repo, status.branch.oid, status.entries);
    unreadable = result.unreadable;
    statusOnly = result.statusOnly;
    relevantRecords(result.output, statusPathsOf(tracked), numstat, null);
  } else if (early) {
    // Clean after all: the speculative run is not needed, and its failure is nobody's business.
    await early.catch(() => null);
  }
  return {
    mode: 'full',
    stamp,
    header: status.header,
    branch: status.branch,
    tracked,
    untracked,
    untrackedOrder: [...untracked.keys()].sort(compareBstr),
    untrackedTouched: null,
    numstat,
    unreadable,
    statusOnly,
    region: null,
    presigs: null,
    expected,
    previous,
  };
}

/** A kept signature no file has: the next incremental refresh diffs the path again. */
const UNSETTLED = 'unsettled';

/** How full summaries that ran numstat alongside the status used it (tests, diagnostics). */
export const speculationChecks = { trusted: 0, rerun: 0 };

interface SignedPath {
  sig: string;
  /**
   * When the path last changed for sure, in ms: its ctime, or for a missing path the ctime of its
   * nearest existing directory (removing a file changes it). Null when unknown.
   */
  changedMs: number | null;
}

/** `sigCtimeMs` of an lstat signature (`size:mtimeNs:ctimeNs:…`). */
function sigCtimeMs(sig: string): number | null {
  const field = sig.split(':', 3)[2];
  if (!field || !/^\d+$/.test(field)) return null;
  return Number(BigInt(field) / 1_000_000n);
}

async function signPaths(
  root: string,
  keys: readonly string[],
  gitlinks: ReadonlySet<string>,
): Promise<Map<string, SignedPath>> {
  const unique = [...new Set(keys)];
  const signed = await mapLimit(unique, STAT_CONCURRENCY, async (key): Promise<SignedPath> => {
    const sig = await dirtySignature(root, key, gitlinks.has(key));
    if (sig !== 'missing') return { sig, changedMs: sigCtimeMs(sig) };
    for (let dir = path.posix.dirname(key); ; dir = path.posix.dirname(dir)) {
      const up = dir === '.' ? 'missing' : await lstatSignature(root, dir);
      if (up !== 'missing') return { sig, changedMs: sigCtimeMs(up) };
      if (dir === '.' || dir === '/') {
        try {
          return { sig, changedMs: (await lstat(root)).ctimeMs };
        } catch {
          return { sig, changedMs: null };
        }
      }
    }
  });
  return new Map(unique.map((key, i) => [key, signed[i] as SignedPath]));
}

/** Paths `finish` signs (worktree-dirty tracked paths, fully staged ones) and rename sources. */
function signedKeys(entries: Iterable<StatusEntry>): {
  keys: string[];
  sources: string[];
  gitlinks: Set<string>;
} {
  const keys: string[] = [];
  const sources: string[] = [];
  const gitlinks = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'unmerged') keys.push(entry.path);
    if (entry.kind !== 'ordinary' && entry.kind !== 'renamed') continue;
    if (entry.y !== '.' || entry.x !== '.') keys.push(entry.path);
    if (entry.y !== '.' && entry.modeWorktree === '160000') gitlinks.add(entry.path);
    if (entry.kind === 'renamed') sources.push(entry.origPath);
  }
  return { keys, sources, gitlinks };
}

function gitlinksOf(tracked: ReadonlyMap<string, StatusEntry>): Set<string> {
  const out = new Set<string>();
  for (const entry of tracked.values()) {
    if (
      (entry.kind === 'ordinary' || entry.kind === 'renamed') &&
      entry.modeWorktree === '160000'
    ) {
      out.add(entry.path);
    }
  }
  return out;
}

/**
 * The early numstat with the paths it cannot vouch for diffed again, after the status: one numstat
 * limited to them and every rename candidate (so renames pair as in a full run), whose records
 * replace the early ones inside that region. Anything unusual (too many or non-UTF-8 paths, a
 * failed run, output outside the region): the whole numstat again, after the status.
 */
async function recheckNumstat(
  ctx: GitContext,
  repo: RepoInfo,
  tracked: Map<string, StatusEntry>,
  headSha: string | null,
  early: TrackedNumstat,
  paths: readonly string[],
): Promise<TrackedNumstat | null> {
  const region = regionFor({ tracked }, paths);
  if (!region || region.size === 0) return null;
  const limited = await plainNumstat(
    ctx,
    repo,
    headSha ?? repo.emptyTree,
    region.specs.map(bstrToUtf8),
  );
  if (!limited.ok) return null;
  const statusPaths = statusPathsOf(tracked);
  const outside = new Map<string, NumstatRecord[]>();
  relevantRecords(early.output, statusPaths, outside, null);
  const inside = new Map<string, NumstatRecord[]>();
  try {
    if (!relevantRecords(limited.output, statusPaths, inside, region)) return null;
  } catch (error) {
    if (error instanceof DiffParseError) return null;
    throw error;
  }
  const records: NumstatRecord[] = [];
  for (const [key, list] of outside) {
    if (region.has(key) || list.some((r) => r.srcPath !== null && region.has(r.srcPath))) continue;
    records.push(...list);
  }
  for (const list of inside.values()) records.push(...list);
  return {
    output: records.map(serializeRecord).join(''),
    unreadable: early.unreadable,
    statusOnly: false,
  };
}

/**
 * The last state with the hinted paths recomputed by `git status -- <region>` and, when the
 * region holds tracked changes, `git diff --numstat HEAD -- <region>` (see incremental.ts for
 * why that equals a full refresh). A string: the reason it cannot be used.
 */
async function collectIncremental(
  deps: DiffDeps,
  repo: RepoInfo,
  previous: SummaryTrack | undefined,
  hint: readonly string[],
  options: SummaryOptions | undefined,
): Promise<Collected | string> {
  const { ctx } = deps;
  if (!previous) return 'no-state';
  const check = checkHint(hint);
  if (!check.ok) return check.reason;
  const blocker = trackBlocker(previous);
  if (blocker) return blocker;
  if (previous.defaultBranch !== (options?.defaultBranch ?? null)) return 'default-branch';
  const root = repo.toplevel ?? repo.cwd;
  if (await foldsCase(root)) return 'case-insensitive';
  const stamp = await readStamp(repo, envOf(ctx));
  const stampChanged = stampChange(previous.stamp, stamp);
  if (stampChanged) return stampChanged;
  // A directory appeared (or a file became one): what is inside may predate the events.
  const kinds = await mapLimit(check.keys, STAT_CONCURRENCY, async (key) => {
    try {
      return (await lstat(absolutePathBuffer(root, key))).isDirectory();
    } catch {
      return false;
    }
  });
  if (kinds.some(Boolean)) return 'directory';
  // A path inside a nested repository (its own `.git` in an ancestor directory): the
  // superproject sees that repository as one entry whose state no event of ours describes.
  const ancestors = new Set<string>();
  for (const key of check.keys) {
    for (let slash = key.indexOf('/'); slash >= 0; slash = key.indexOf('/', slash + 1)) {
      ancestors.add(key.slice(0, slash));
    }
  }
  const nested = await mapLimit([...ancestors], STAT_CONCURRENCY, (dir) =>
    lstat(absolutePathBuffer(root, `${dir}/.git`)).then(
      () => true,
      () => false,
    ),
  );
  if (nested.some(Boolean)) return 'nested-repository';
  // A changed file whose event never came still shows in its signature: recompute it too.
  const presigs = new Map<string, string>();
  const missed: string[] = [];
  const known = [...previous.signatures.keys()];
  const sigs = await mapLimit(known, STAT_CONCURRENCY, (key) => lstatSignature(root, key));
  for (const [i, key] of known.entries()) {
    const value = sigs[i] as string;
    presigs.set(key, value);
    if (value !== previous.signatures.get(key)) missed.push(key);
  }
  const region = regionFor(previous, [...check.keys, ...missed]);
  if (!region) return 'too-many-candidates';
  // No pathspec at all would mean the whole worktree to git.
  if (region.size === 0) return 'empty-hint';
  const pathspecs = region.specs.map(bstrToUtf8);

  // numstat runs alongside the status unless the hint names only known untracked files and the
  // region holds nothing tracked (a new file being written); otherwise after it, when needed.
  // Its commit is the last state's HEAD, which the status header then confirms.
  type Numstat = { ok: true; output: string } | { ok: false };
  const runNumstat = (): Promise<Numstat> =>
    ctx
      .git(repo, [
        'diff',
        ...DIFF_PINS,
        '--numstat',
        '-z',
        previous.branch.oid ?? repo.emptyTree,
        '--',
        ...pathspecs,
      ])
      .then(
        (run): Numstat => ({ ok: true, output: bstrFromBuffer(run.stdout) }),
        (error: unknown): Numstat => {
          // An unreadable file (F7) and its fallbacks are the full refresh's business.
          if (isGitCoreError(error, 'git_failed')) return { ok: false };
          throw error;
        },
      );
  let likelyTracked = check.keys.some((key) => !previous.untracked.has(key));
  for (const entry of previous.tracked.values()) {
    if (likelyTracked) break;
    likelyTracked =
      region.has(entry.path) || (entry.kind === 'renamed' && region.has(entry.origPath));
  }
  const early = likelyTracked ? runNumstat() : null;
  // Settled by whoever awaits it below; an early return must not leave a rejection unhandled.
  early?.catch(() => {});

  const result = await ctx.git(repo, [...STATUS_ARGS, '--', ...pathspecs]);
  let status: ReturnType<typeof parseStatusV2>;
  try {
    status = parseStatusV2(bstrFromBuffer(result.stdout));
  } catch (error) {
    if (error instanceof StatusParseError) return 'parse';
    throw error;
  }
  // HEAD, the branch, the upstream or its ahead/behind moved: many paths may have changed.
  if (status.header.join('\u0000') !== previous.header.join('\u0000')) return 'head';
  const tracked = new Map<string, StatusEntry>();
  for (const [key, entry] of previous.tracked) {
    if (region.has(key) || (entry.kind === 'renamed' && region.has(entry.origPath))) continue;
    tracked.set(key, entry);
  }
  // Tens of thousands of untracked files: found by binary search, not by a scan per refresh.
  const untracked = new Map(previous.untracked);
  const removed = new Set(keysInRegion(previous.untrackedOrder, region));
  for (const key of removed) untracked.delete(key);
  const listed: string[] = [];
  let regionTracked = false;
  for (const entry of status.entries) {
    if (entry.kind === 'ignored') continue;
    // Anything outside the pathspecs means git matched differently than assumed.
    if (!region.has(entry.path)) return 'outside-region';
    if (entry.kind === 'renamed' && !region.has(entry.origPath)) return 'outside-region';
    if (entry.kind === 'untracked') {
      if (entry.path.endsWith('/')) return 'nested-repository';
      if (!untracked.has(entry.path)) listed.push(entry.path);
      untracked.set(entry.path, entry);
    } else {
      if (tracked.has(entry.path)) return 'outside-region';
      tracked.set(entry.path, entry);
      regionTracked = true;
    }
  }
  const numstat = new Map<string, NumstatRecord[]>();
  for (const [key, records] of previous.numstat) {
    if (region.has(key) || records.some((r) => r.srcPath !== null && region.has(r.srcPath))) {
      continue;
    }
    numstat.set(key, records);
  }
  if (regionTracked) {
    const run = await (early ?? runNumstat());
    if (!run.ok) return 'numstat-failed';
    const output = run.output;
    try {
      if (!relevantRecords(output, statusPathsOf(tracked), numstat, region)) {
        return 'outside-region';
      }
    } catch (error) {
      if (error instanceof DiffParseError) return 'parse';
      throw error;
    }
  }
  listed.sort(compareBstr);
  return {
    mode: 'incremental',
    stamp,
    header: status.header,
    branch: status.branch,
    tracked,
    untracked,
    untrackedOrder: mergeSorted(previous.untrackedOrder, removed, listed),
    untrackedTouched: new Set([...removed, ...listed]),
    numstat,
    unreadable: new Set(),
    statusOnly: false,
    region,
    presigs,
    expected: null,
    previous,
  };
}

/** Directories of the tracked files, per index file, while its stat signature holds. */
const trackedDirScans = new Map<
  string,
  { signature: string; dirs: Set<string>; names: Set<string> } | null
>();

/**
 * What a broader `.gitignore` line would cover (PR #91 P2-3): the listed untracked files and the
 * directories of the tracked files, from one `git ls-files -z` per index write (memoized by the
 * index's stat signature). Null (exact lines only) when the index cannot be listed.
 */
async function ignoreContext(
  deps: DiffDeps,
  repo: RepoInfo,
  listed: readonly string[],
): Promise<IgnoreContext | null> {
  const index = path.join(repo.gitDir, 'index');
  let signature = 'missing';
  try {
    const info = await lstat(index, { bigint: true });
    signature = `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`;
  } catch {
    // No index: nothing tracked, or an odd repository; listed below either way.
  }
  let scan = trackedDirScans.get(index);
  if (scan === undefined || scan === null || scan.signature !== signature) {
    try {
      const out = await deps.ctx.git(repo, ['ls-files', '-z']);
      const dirs = new Set<string>();
      const names = new Set<string>();
      for (const file of bstrToUtf8(bstrFromBuffer(out.stdout)).split('\u0000')) {
        for (let slash = file.indexOf('/'); slash >= 0; slash = file.indexOf('/', slash + 1)) {
          dirs.add(file.slice(0, slash));
          names.add(file.slice(file.lastIndexOf('/', slash - 1) + 1, slash));
        }
      }
      scan = { signature, dirs, names };
    } catch (error) {
      if (!isGitCoreError(error, 'git_failed')) throw error;
      scan = null;
    }
    trackedDirScans.set(index, scan);
    if (trackedDirScans.size > 256) {
      const oldest = trackedDirScans.keys().next().value;
      if (oldest !== undefined) trackedDirScans.delete(oldest);
    }
  }
  if (scan === null) return null;
  return {
    listed: listed.map(bstrToUtf8),
    trackedDirs: scan.dirs,
    trackedNames: scan.names,
  };
}

/**
 * The omission plan of a set of untracked keys (sorted), reusing the last state's while the set
 * is the same (an incremental refresh that touched no untracked path, or a full one that found
 * the same paths): computing it walks every path's directories.
 */
function untrackedPlanOf(
  previous: SummaryTrack | undefined,
  order: readonly string[],
  limit: number,
): UntrackedPlan | null {
  if (order.length <= limit) return null;
  const held = previous?.untrackedPlan;
  if (held && held.limit === limit && sameKeys(previous.untrackedOrder, order)) return held;
  return planUntracked(order, limit);
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function envOf(ctx: GitContext): (name: string) => string | undefined {
  return (name) => ctx.runner.envValue(name) || undefined;
}

/**
 * The status output rebuilt from its header and entries (changed entries by path, unmerged ones
 * by path, then untracked by path): git's own `status --porcelain=v2 -z` output when it is sorted the same way.
 */
export function canonicalStatusOutput(
  header: readonly string[],
  entries: readonly StatusEntry[],
): string {
  return [...header, ...entries.map((entry) => entry.line)]
    .map((token) => `${token}\u0000`)
    .join('');
}

function serializeRecord(record: NumstatRecord): string {
  const counts = `${record.added ?? '-'}\t${record.deleted ?? '-'}\t`;
  return record.srcPath === null
    ? `${counts}${record.path}\u0000`
    : `${counts}\u0000${record.srcPath}\u0000${record.path}\u0000`;
}

/**
 * Cheap summary: one `git status`, plus `git diff --numstat` only when tracked files changed;
 * with `options.changedPaths`, both limited to those paths when the last state allows it (#40).
 * Without a usable upstream, ahead/behind is counted against the default branch (resolved from
 * the ref files), shared per project and commit (`commits.ts`: one `for-each-ref` per project,
 * or `rev-list --count` on old git).
 *
 * stateHash covers the status output (which includes HEAD/index object ids of every changed
 * entry, the branch, upstream and ahead/behind), the numstat output, the ahead/behind
 * reference, the in-progress operation, and the lstat signature (size, mtime, ctime, inode,
 * mode) of every file with worktree changes and every untracked file. The last part matters:
 * modifying an already-modified file again does not change `git status`.
 *
 * Both outputs are hashed in a canonical form rebuilt from the per-path records (the header,
 * changed, unmerged and untracked entries, each by path; numstat lines by destination path, only
 * those of paths git status reports), so a full and an incremental refresh of the same state
 * give the same hash. For git's own output, sorted by path the same way, the canonical form is
 * the output itself (asserted in `test/incremental-fuzz.test.ts`).
 */
export async function getSummary(
  deps: DiffDeps,
  worktree: WorktreeLocator,
  options: SummaryOptions | undefined,
): Promise<SummaryResult> {
  const { ctx } = deps;
  const snapshotLimit = snapshotCap(options);
  await ctx.ensureSupported();
  const repo = await ctx.repo(worktree.path);
  if (repo.bare) {
    const summary = await bareSummary(ctx, repo, worktree);
    const refresh: SummaryRefresh = { mode: 'full', reason: null, pathspecs: 0 };
    return snapshotLimit === null
      ? { ...summary, refresh }
      : { ...summary, snapshot: emptySnapshot(), refresh };
  }
  const hint = options?.changedPaths;
  return deps.tracks.serial(repo.cwd, async () => {
    let reason: string | null = null;
    if (options?.forgetState) {
      deps.tracks.delete(repo.cwd);
      forgetLists(deps, repo.cwd);
      reason = 'forget';
    }
    const previous = deps.tracks.get(repo.cwd);
    let collected: Collected | null = null;
    if (hint !== undefined && deps.incremental && reason === null) {
      const attempt = await collectIncremental(deps, repo, previous, hint, options);
      if (typeof attempt === 'string') reason = attempt;
      else collected = attempt;
    }
    collected ??= await collectFull(deps, repo, previous);
    const { result, track } = await finish(deps, repo, worktree, options, collected, snapshotLimit);
    if (deps.incremental) {
      deps.tracks.set(repo.cwd, track);
      // A full refresh is the ground truth: lists it does not explain are seeded again.
      if (collected.mode === 'full') dropStaleLists(deps, repo.cwd, track);
    }
    return {
      ...result,
      refresh: {
        mode: collected.mode,
        reason,
        pathspecs: collected.region?.size ?? 0,
      },
    };
  });
}

async function finish(
  deps: DiffDeps,
  repo: RepoInfo,
  worktree: WorktreeLocator,
  options: SummaryOptions | undefined,
  c: Collected,
  snapshotLimit: number | null,
): Promise<{ result: SummaryResult; track: SummaryTrack }> {
  const { ctx } = deps;
  const { branch, previous, region } = c;
  const headSha = branch.oid;
  const byPath = (a: StatusEntry, b: StatusEntry): number => compareBstr(a.path, b.path);
  // git's order: changed entries by path, then unmerged ones by path, then untracked by path.
  const changed = [...c.tracked.values()].filter((entry) => entry.kind !== 'unmerged');
  const unmerged = [...c.tracked.values()].filter((entry) => entry.kind === 'unmerged');
  const trackedEntries = [...changed.sort(byPath), ...unmerged.sort(byPath)];
  const untrackedEntries = c.untrackedOrder.map((key) => c.untracked.get(key) as StatusEntry);
  const entries: StatusEntry[] = [...trackedEntries, ...untrackedEntries];

  let staged = 0;
  let unstaged = 0;
  let conflicted = 0;
  const untrackedRaw: string[] = untrackedEntries.map((entry) => entry.path);
  const dirtyKeys: string[] = [];
  /** dirtyKeys entries that are submodules (gitlinks) in the worktree. */
  const gitlinkKeys = new Set<string>();
  /**
   * Fully staged paths (index changed, worktree matches it). Not in the stateHash (git status
   * already reports them); only their mtimes feed `activityAt`, so staging an edit before the next
   * refresh does not drop it from the activity time.
   */
  const stagedOnlyKeys: string[] = [];
  for (const entry of trackedEntries) {
    switch (entry.kind) {
      case 'ordinary':
      case 'renamed':
        if (entry.x !== '.') staged += 1;
        if (entry.y !== '.') {
          unstaged += 1;
          dirtyKeys.push(entry.path);
          if (entry.modeWorktree === '160000') gitlinkKeys.add(entry.path);
        } else if (entry.x !== '.') {
          stagedOnlyKeys.push(entry.path);
        }
        break;
      case 'unmerged':
        conflicted += 1;
        dirtyKeys.push(entry.path);
        break;
      default:
        break;
    }
  }

  const upstream = branch.upstream ? bstrToUtf8(branch.upstream) : null;
  const branchName = branch.head ? bstrToUtf8(branch.head) : null;
  const hasUpstreamCounts = upstream !== null && branch.ahead !== null && branch.behind !== null;

  const aheadBehindPromise = (async (): Promise<{
    ref: string | null;
    oid: string | null;
    ahead: number | null;
    behind: number | null;
  }> => {
    if (hasUpstreamCounts) {
      return { ref: upstream, oid: null, ahead: branch.ahead, behind: branch.behind };
    }
    if (!headSha) return { ref: null, oid: null, ahead: null, behind: null };
    const base = await resolveDefaultBranch(ctx, repo, options);
    if (!base || (branchName !== null && base.ref === `refs/heads/${branchName}`)) {
      return { ref: null, oid: null, ahead: null, behind: null };
    }
    // Shared by every worktree of the project at the same commit (#29).
    const counts = await countAheadBehind(
      ctx,
      repo,
      headSha,
      base.oid,
      branchName === null ? null : `refs/heads/${branchName}`,
    );
    return {
      ref: base.name,
      oid: base.oid,
      ahead: counts?.ahead ?? null,
      behind: counts?.behind ?? null,
    };
  })();

  /** A signature measured before git ran, for a path the incremental refresh did not touch. */
  const signatureOf = (key: string, gitlink: boolean): Promise<string> => {
    const early = region && !region.has(key) ? c.presigs?.get(key) : undefined;
    return early !== undefined ? Promise.resolve(early) : dirtySignature(repo.cwd, key, gitlink);
  };
  // Above the cap, only the listed untracked files are inspected (#43, `untracked-plan.ts`).
  const plan = untrackedPlanOf(previous, c.untrackedOrder, ctx.settings.maxListedUntracked);
  const listedRaw = plan === null ? untrackedRaw : listedKeys(plan, untrackedRaw);
  const untrackedPromise = untrackedAttributes(deps, repo, untrackedRaw, plan, entries).then(
    async (attributes) => {
      const inspect = inspectOptions(ctx, repo, untrackedRaw.length, attributes);
      const touched = c.untrackedTouched;
      const reuse =
        touched !== null && previous !== undefined && previous.readContent === inspect.readContent;
      const fresh: string[] = [];
      const kept = new Map<string, UntrackedInfo>();
      for (const raw of listedRaw) {
        const key = raw.endsWith('/') ? raw.slice(0, -1) : raw;
        const old = reuse && !touched.has(raw) ? previous.untrackedInfos.get(key) : undefined;
        if (old && old.attribute === (attributes.get(key) ?? '')) kept.set(raw, old.info);
        else fresh.push(raw);
      }
      const inspected = await inspectUntracked(repo.cwd, fresh, deps.untrackedCache, inspect);
      const byRaw = new Map<string, UntrackedInfo>();
      for (const [i, raw] of fresh.entries()) byRaw.set(raw, inspected[i] as UntrackedInfo);
      const infos = listedRaw.map((raw) => (kept.get(raw) ?? byRaw.get(raw)) as UntrackedInfo);
      return { attributes, infos, readContent: inspect.readContent, fresh: reuse ? fresh : null };
    },
  );
  const [aheadBehind, inProgress, signatures, untracked, headMs, stagedSigs] = await Promise.all([
    aheadBehindPromise,
    detectInProgress(repo.gitDir),
    mapLimit(dirtyKeys, STAT_CONCURRENCY, (key) => signatureOf(key, gitlinkKeys.has(key))),
    untrackedPromise,
    headActivityMs(ctx, repo, headSha, previous?.headCommitMs ?? null),
    mapLimit(stagedOnlyKeys, STAT_CONCURRENCY, (key) => signatureOf(key, false)),
  ]);
  const untrackedInfos = untracked.infos;

  let additions = 0;
  let deletions = 0;
  const trackedPaths = new Set<string>();
  const recordKeys = [...c.numstat.keys()].sort(compareBstr);
  const numstatParts: string[] = [];
  /** Per-path counts for the snapshot (only collected when one was asked for). */
  const snapshotCounts = new Map<string, { added: number | null; deleted: number | null }>();
  if (c.statusOnly) {
    // Degraded (F7): every tracked status entry counts as one changed file.
    for (const entry of trackedEntries) trackedPaths.add(entry.path);
  } else {
    for (const key of c.unreadable) trackedPaths.add(key);
    for (const key of recordKeys) {
      for (const entry of c.numstat.get(key) ?? []) {
        numstatParts.push(serializeRecord(entry));
        trackedPaths.add(entry.path);
        additions += entry.added ?? 0;
        deletions += entry.deleted ?? 0;
        if (snapshotLimit !== null) {
          snapshotCounts.set(entry.path, { added: entry.added, deleted: entry.deleted });
        }
      }
    }
  }
  let untrackedChanged = 0;
  for (const info of untrackedInfos) {
    if (trackedPaths.has(info.key)) continue;
    untrackedChanged += 1;
    additions += info.lines ?? 0;
  }
  // Omitted untracked files count as changed files (git status lists them); their lines are
  // unknown and stay out of `additions`. A path that is also a tracked change counts once.
  let omittedCount = plan?.omitted ?? 0;
  /** Omitted raw keys counted as tracked changes instead (left out of every omitted count). */
  const omittedDuplicates: string[] = [];
  if (plan !== null) {
    for (const key of trackedPaths) {
      const raw = c.untracked.has(key) ? key : c.untracked.has(`${key}/`) ? `${key}/` : null;
      if (raw !== null && isOmitted(plan, raw)) omittedDuplicates.push(raw);
    }
    omittedCount -= omittedDuplicates.length;
    untrackedChanged += omittedCount;
  }

  // The untracked parts of the hashed text are rebuilt only when an untracked record changed (the
  // same bytes either way: `canonicalStatusOutput(c.header, entries)`).
  const untrackedSame =
    c.untrackedTouched !== null &&
    c.untrackedTouched.size === 0 &&
    untracked.fresh !== null &&
    untracked.fresh.length === 0 &&
    previous?.untrackedText !== undefined;
  const untrackedText =
    untrackedSame && previous?.untrackedText
      ? previous.untrackedText
      : {
          lines: canonicalStatusOutput([], untrackedEntries),
          infos: untrackedInfos
            .map((info) => {
              const attribute = untracked.attributes.get(info.key) ?? '';
              return `${info.key}\u0000${info.statSig}\u0000${attribute}`;
            })
            .join('\u0000'),
        };
  const statusOutput = canonicalStatusOutput(c.header, trackedEntries) + untrackedText.lines;
  const stateHash = hashParts(
    [
      'summary-v2',
      statusOutput,
      numstatParts.join(''),
      aheadBehind.ref,
      aheadBehind.oid,
      aheadBehind.ahead,
      aheadBehind.behind,
      inProgress,
      dirtyKeys.map((key, i) => `${key}\u0000${signatures[i]}`).join('\u0000'),
      untrackedText.infos,
      c.statusOnly ? 'status-only' : null,
      [...c.unreadable].sort(compareBstr).join('\u0000'),
    ],
    STATE_HASH_LENGTH,
  );

  const summary: WorktreeSummary = {
    worktreeId: worktree.worktreeId,
    projectId: worktree.projectId,
    branch: branchName,
    headSha,
    detached: branch.detached,
    upstream,
    aheadBehindRef: aheadBehind.ref,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    counts: { staged, unstaged, untracked: untrackedRaw.length, conflicted },
    changedFiles: trackedPaths.size + untrackedChanged,
    additions,
    deletions,
    inProgress,
    ...(plan !== null && omittedCount > 0
      ? {
          untrackedOmitted: omissionOf(
            plan,
            omittedCount,
            wantsIgnoreContext(plan, omittedDuplicates)
              ? await ignoreContext(
                  deps,
                  repo,
                  untrackedInfos.map((info) => info.key),
                )
              : null,
            omittedDuplicates,
          ),
        }
      : {}),
    stateHash,
    updatedAt: new Date().toISOString(),
    activityAt: activityAt(headMs.ms, [
      ...signatures.map(sigMtimeMs),
      ...stagedSigs.map(sigMtimeMs),
      ...untrackedInfos.map(infoMtimeMs),
    ]),
  };

  // The signatures computed above for the stateHash and activityAt: no new lstat, no new git.
  const signatureByKey = new Map<string, string>();
  for (const [i, key] of stagedOnlyKeys.entries()) signatureByKey.set(key, stagedSigs[i] as string);
  for (const [i, key] of dirtyKeys.entries()) signatureByKey.set(key, signatures[i] as string);
  // The kept state never holds a signature newer than the reads its records came from.
  const keptSignatures = new Map(signatureByKey);
  if (c.expected) {
    for (const [key, sig] of keptSignatures) {
      if (c.expected.get(key) !== sig) keptSignatures.set(key, UNSETTLED);
    }
  }
  const infosByKey = new Map<string, { info: UntrackedInfo; attribute: string }>();
  for (const info of untrackedInfos) {
    infosByKey.set(info.key, { info, attribute: untracked.attributes.get(info.key) ?? '' });
  }
  const track: SummaryTrack = {
    version: deps.tracks.nextVersion(),
    stateHash,
    stamp: c.stamp,
    header: c.header,
    branch,
    tracked: c.tracked,
    untracked: c.untracked,
    untrackedOrder: c.untrackedOrder,
    untrackedText,
    numstat: c.numstat,
    degraded: c.statusOnly || c.unreadable.size > 0,
    untrackedInfos: infosByKey,
    readContent: untracked.readContent,
    untrackedPlan: plan,
    signatures: keptSignatures,
    defaultBranch: options?.defaultBranch ?? null,
    headCommitMs: headMs.commit,
    fullAt: c.mode === 'full' ? Date.now() : (previous?.fullAt ?? Date.now()),
    journal: [],
  };
  // Incremental: untracked records changed only where the refresh recomputed them.
  track.journal = nextJournal(
    previous,
    track,
    c.untrackedTouched && untracked.fresh ? [...c.untrackedTouched, ...untracked.fresh] : null,
    c.mode === 'incremental' ? c.region : null,
  );
  if (snapshotLimit === null) return { result: summary, track };
  return {
    result: {
      ...summary,
      snapshot: buildSnapshot({
        entries,
        signatureOf: (key) => signatureByKey.get(key),
        counts: snapshotCounts,
        untracked: untrackedInfos,
        cap: snapshotLimit,
        omitted:
          plan === null || omittedCount === 0
            ? null
            : {
                plan: plan.id,
                keys: untrackedRaw
                  .filter((raw) => isOmitted(plan, raw))
                  .map((raw) => (raw.endsWith('/') ? raw.slice(0, -1) : raw))
                  .filter((key) => !trackedPaths.has(key)),
              },
      }),
    },
    track,
  };
}
