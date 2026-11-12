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
  findUnreadable,
  inspectOptions,
  lstatSignature,
  pathspecsExcluding,
  readDiffAttributes,
  readStatus,
  STATUS_ARGS,
} from './diff.js';
import { exists, mapLimit } from './fs-utils.js';
import { hashParts, STATE_HASH_LENGTH } from './hash.js';
import {
  checkHint,
  foldsCase,
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
import { DIFF_PINS, resolveDefaultBranch } from './scope.js';
import { buildSnapshot, emptySnapshot, snapshotCap } from './snapshot.js';
import {
  absolutePathBuffer,
  inspectUntracked,
  nestedRepoHead,
  type UntrackedInfo,
} from './untracked.js';

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

/** Milliseconds from the mtime field of an `lstatSignature` / untracked `statSig` (`size:mtimeNs:…`). */
function sigMtimeMs(sig: string): number | null {
  const field = sig.split(':', 2)[1];
  if (!field || !/^\d+$/.test(field)) return null;
  return Number(BigInt(field) / 1_000_000n);
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

/** Everything a summary is computed from: a full status, or the last state with a hint merged in. */
interface Collected {
  mode: 'full' | 'incremental';
  stamp: Stamp;
  header: string[];
  branch: StatusBranch;
  tracked: Map<string, StatusEntry>;
  untracked: Map<string, StatusEntry>;
  /** Relevant numstat records by destination path (see `relevantRecords`). */
  numstat: Map<string, NumstatRecord[]>;
  unreadable: Set<string>;
  statusOnly: boolean;
  /** Incremental: the pathspecs whose records were recomputed. Null for a full refresh. */
  region: Region | null;
  /** Incremental: lstat signatures taken before git ran, by path. */
  presigs: Map<string, string> | null;
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
  const stamp = await readStamp(repo, envOf(ctx));
  const status = await readStatus(ctx, repo);
  const { tracked, untracked } = splitEntries(status.entries);
  const numstat = new Map<string, NumstatRecord[]>();
  let unreadable = new Set<string>();
  let statusOnly = false;
  if (tracked.size > 0) {
    const result = await trackedNumstat(ctx, repo, status.branch.oid, status.entries);
    unreadable = result.unreadable;
    statusOnly = result.statusOnly;
    relevantRecords(result.output, statusPathsOf(tracked), numstat, null);
  }
  return {
    mode: 'full',
    stamp,
    header: status.header,
    branch: status.branch,
    tracked,
    untracked,
    numstat,
    unreadable,
    statusOnly,
    region: null,
    presigs: null,
    previous,
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
  const untracked = new Map<string, StatusEntry>();
  for (const [key, entry] of previous.untracked) {
    if (!region.has(key)) untracked.set(key, entry);
  }
  let regionTracked = false;
  for (const entry of status.entries) {
    if (entry.kind === 'ignored') continue;
    // Anything outside the pathspecs means git matched differently than assumed.
    if (!region.has(entry.path)) return 'outside-region';
    if (entry.kind === 'renamed' && !region.has(entry.origPath)) return 'outside-region';
    if (entry.kind === 'untracked') {
      if (entry.path.endsWith('/')) return 'nested-repository';
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
    let output: string;
    try {
      const run = await ctx.git(repo, [
        'diff',
        ...DIFF_PINS,
        '--numstat',
        '-z',
        status.branch.oid ?? repo.emptyTree,
        '--',
        ...pathspecs,
      ]);
      output = bstrFromBuffer(run.stdout);
    } catch (error) {
      // An unreadable file (F7) and its fallbacks are the full refresh's business.
      if (isGitCoreError(error, 'git_failed')) return 'numstat-failed';
      throw error;
    }
    try {
      if (!relevantRecords(output, statusPathsOf(tracked), numstat, region)) {
        return 'outside-region';
      }
    } catch (error) {
      if (error instanceof DiffParseError) return 'parse';
      throw error;
    }
  }
  return {
    mode: 'incremental',
    stamp,
    header: status.header,
    branch: status.branch,
    tracked,
    untracked,
    numstat,
    unreadable: new Set(),
    statusOnly: false,
    region,
    presigs,
    previous,
  };
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
    const previous = deps.tracks.get(repo.cwd);
    let reason: string | null = null;
    let collected: Collected | null = null;
    if (hint !== undefined && deps.incremental) {
      const attempt = await collectIncremental(deps, repo, previous, hint, options);
      if (typeof attempt === 'string') reason = attempt;
      else collected = attempt;
    }
    collected ??= await collectFull(deps, repo, previous);
    const { result, track } = await finish(deps, repo, worktree, options, collected, snapshotLimit);
    if (deps.incremental) deps.tracks.set(repo.cwd, track);
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
  const untrackedEntries = [...c.untracked.values()].sort(byPath);
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
  const untrackedPromise = readDiffAttributes(deps, repo, untrackedRaw, entries).then(
    async (attributes) => {
      const inspect = inspectOptions(ctx, repo, untrackedRaw.length, attributes);
      const reuse =
        region !== null && previous !== undefined && previous.readContent === inspect.readContent;
      const fresh: string[] = [];
      const kept = new Map<string, UntrackedInfo>();
      for (const raw of untrackedRaw) {
        const key = raw.endsWith('/') ? raw.slice(0, -1) : raw;
        const old = reuse && !region.has(raw) ? previous.untrackedInfos.get(key) : undefined;
        if (old && old.attribute === (attributes.get(key) ?? '')) kept.set(raw, old.info);
        else fresh.push(raw);
      }
      const inspected = await inspectUntracked(repo.cwd, fresh, deps.untrackedCache, inspect);
      const byRaw = new Map<string, UntrackedInfo>();
      for (const [i, raw] of fresh.entries()) byRaw.set(raw, inspected[i] as UntrackedInfo);
      const infos = untrackedRaw.map((raw) => (kept.get(raw) ?? byRaw.get(raw)) as UntrackedInfo);
      return { attributes, infos, readContent: inspect.readContent };
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

  const statusOutput = canonicalStatusOutput(c.header, entries);
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
      untrackedInfos
        .map((info) => {
          const attribute = untracked.attributes.get(info.key) ?? '';
          return `${info.key}\u0000${info.statSig}\u0000${attribute}`;
        })
        .join('\u0000'),
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
    stateHash,
    updatedAt: new Date().toISOString(),
    activityAt: activityAt(headMs.ms, [
      ...signatures.map(sigMtimeMs),
      ...stagedSigs.map(sigMtimeMs),
      ...untrackedInfos.map((info) => sigMtimeMs(info.statSig)),
    ]),
  };

  // The signatures computed above for the stateHash and activityAt: no new lstat, no new git.
  const signatureByKey = new Map<string, string>();
  for (const [i, key] of stagedOnlyKeys.entries()) signatureByKey.set(key, stagedSigs[i] as string);
  for (const [i, key] of dirtyKeys.entries()) signatureByKey.set(key, signatures[i] as string);
  const infosByKey = new Map<string, { info: UntrackedInfo; attribute: string }>();
  for (const info of untrackedInfos) {
    infosByKey.set(info.key, { info, attribute: untracked.attributes.get(info.key) ?? '' });
  }
  const track: SummaryTrack = {
    version: (previous?.version ?? 0) + 1,
    stateHash,
    stamp: c.stamp,
    header: c.header,
    branch,
    tracked: c.tracked,
    untracked: c.untracked,
    numstat: c.numstat,
    degraded: c.statusOnly || c.unreadable.size > 0,
    untrackedInfos: infosByKey,
    readContent: untracked.readContent,
    signatures: signatureByKey,
    defaultBranch: options?.defaultBranch ?? null,
    headCommitMs: headMs.commit,
    fullAt: c.mode === 'full' ? Date.now() : (previous?.fullAt ?? Date.now()),
    journal: [],
  };
  track.journal = nextJournal(previous, track);
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
      }),
    },
    track,
  };
}
