import path from 'node:path';
import {
  type InProgressOperation,
  isGitCoreError,
  type ScopeOptions,
  type WorktreeLocator,
  type WorktreeSummary,
} from '@octopus-diff/contracts';
import { bstrFromBuffer, bstrToUtf8, compareBstr } from './bstr.js';
import type { GitContext, RepoInfo } from './context.js';
import type { DiffDeps } from './diff.js';
import {
  findUnreadable,
  inspectOptions,
  lstatSignature,
  pathspecsExcluding,
  readDiffAttributes,
  readStatus,
} from './diff.js';
import { exists, mapLimit } from './fs-utils.js';
import { hashParts, STATE_HASH_LENGTH } from './hash.js';
import { DiffOutputParser } from './parse/diff-output.js';
import type { StatusEntry } from './parse/status.js';
import { DIFF_PINS, resolveDefaultBranch } from './scope.js';
import { absolutePathBuffer, inspectUntracked, nestedRepoHead } from './untracked.js';

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
  };
}

/**
 * Cheap summary: one `git status`, plus `git diff --numstat` only when tracked files changed,
 * plus `for-each-ref` + `rev-list --count` only when there is no usable upstream.
 *
 * stateHash covers the raw status output (which includes HEAD/index object ids of every
 * changed entry, the branch, upstream and ahead/behind), the numstat output, the
 * ahead/behind reference, the in-progress operation, and the lstat signature (size, mtime,
 * ctime, inode, mode) of every file with worktree changes and every untracked file. The last
 * part matters: modifying an already-modified file again does not change `git status`.
 */
export async function getSummary(
  deps: DiffDeps,
  worktree: WorktreeLocator,
  options: ScopeOptions | undefined,
): Promise<WorktreeSummary> {
  const { ctx } = deps;
  await ctx.ensureSupported();
  const repo = await ctx.repo(worktree.path);
  if (repo.bare) return bareSummary(ctx, repo, worktree);

  const status = await readStatus(ctx, repo);
  const { branch } = status;
  const headSha = branch.oid;

  let staged = 0;
  let unstaged = 0;
  let conflicted = 0;
  const untrackedRaw: string[] = [];
  const dirtyKeys: string[] = [];
  /** dirtyKeys entries that are submodules (gitlinks) in the worktree. */
  const gitlinkKeys = new Set<string>();
  /** Paths git status reports as changed (incl. rename sources). */
  const statusPaths = new Set<string>();
  let tracked = 0;
  for (const entry of status.entries) {
    if (entry.kind !== 'untracked' && entry.kind !== 'ignored') statusPaths.add(entry.path);
    if (entry.kind === 'renamed') statusPaths.add(entry.origPath);
    switch (entry.kind) {
      case 'ordinary':
      case 'renamed':
        tracked += 1;
        if (entry.x !== '.') staged += 1;
        if (entry.y !== '.') {
          unstaged += 1;
          dirtyKeys.push(entry.path);
          if (entry.modeWorktree === '160000') gitlinkKeys.add(entry.path);
        }
        break;
      case 'unmerged':
        tracked += 1;
        conflicted += 1;
        dirtyKeys.push(entry.path);
        break;
      case 'untracked':
        untrackedRaw.push(entry.path);
        break;
      default:
        break;
    }
  }

  const upstream = branch.upstream ? bstrToUtf8(branch.upstream) : null;
  const branchName = branch.head ? bstrToUtf8(branch.head) : null;
  const hasUpstreamCounts = upstream !== null && branch.ahead !== null && branch.behind !== null;

  const numstatPromise =
    tracked > 0 ? trackedNumstat(ctx, repo, headSha, status.entries) : Promise.resolve(null);

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
    const counts = await ctx.git(repo, [
      'rev-list',
      '--left-right',
      '--count',
      `${headSha}...${base.oid}`,
      '--',
    ]);
    const [ahead, behind] = counts.stdout.toString('utf8').trim().split(/\s+/).map(Number);
    return {
      ref: base.name,
      oid: base.oid,
      ahead: Number.isFinite(ahead) ? (ahead as number) : null,
      behind: Number.isFinite(behind) ? (behind as number) : null,
    };
  })();

  const untrackedKeysSorted = [...untrackedRaw].sort(compareBstr);
  const untrackedPromise = readDiffAttributes(
    ctx,
    repo,
    untrackedKeysSorted,
    untrackedRaw.length,
  ).then(async (attributes) => ({
    attributes,
    infos: await inspectUntracked(
      repo.cwd,
      untrackedKeysSorted,
      deps.untrackedCache,
      inspectOptions(ctx, repo, untrackedRaw.length, attributes),
    ),
  }));
  const [numstatResult, aheadBehind, inProgress, signatures, untracked] = await Promise.all([
    numstatPromise,
    aheadBehindPromise,
    detectInProgress(repo.gitDir),
    mapLimit(dirtyKeys, STAT_CONCURRENCY, (key) =>
      dirtySignature(repo.cwd, key, gitlinkKeys.has(key)),
    ),
    untrackedPromise,
  ]);
  const untrackedInfos = untracked.infos;

  let additions = 0;
  let deletions = 0;
  const trackedPaths = new Set<string>();
  const numstatOutput = numstatResult?.output ?? '';
  if (numstatResult?.statusOnly) {
    // Degraded (F7): every tracked status entry counts as one changed file.
    for (const entry of status.entries) {
      if (entry.kind !== 'untracked' && entry.kind !== 'ignored') trackedPaths.add(entry.path);
    }
  } else if (numstatResult) {
    for (const key of numstatResult.unreadable) trackedPaths.add(key);
    const parser = new DiffOutputParser();
    parser.write(numstatOutput);
    parser.end();
    for (const entry of parser.numstat) {
      // Stat-dirty but unchanged binary files still get a `-\t-` numstat line (see
      // diff.ts isStatOnly); git status, which compares content, does not report them.
      if (!statusPaths.has(entry.path) && !(entry.srcPath && statusPaths.has(entry.srcPath))) {
        continue;
      }
      trackedPaths.add(entry.path);
      additions += entry.added ?? 0;
      deletions += entry.deleted ?? 0;
    }
  }
  let untrackedChanged = 0;
  for (const info of untrackedInfos) {
    if (trackedPaths.has(info.key)) continue;
    untrackedChanged += 1;
    additions += info.lines ?? 0;
  }

  const stateHash = hashParts(
    [
      'summary-v2',
      status.output,
      numstatOutput,
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
      numstatResult?.statusOnly ? 'status-only' : null,
      [...(numstatResult?.unreadable ?? [])].sort(compareBstr).join('\u0000'),
    ],
    STATE_HASH_LENGTH,
  );

  return {
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
  };
}
