import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type {
  InProgressOperation,
  ScopeOptions,
  WorktreeLocator,
  WorktreeSummary,
} from '@octopus-diff/contracts';
import { bstrFromBuffer, bstrToUtf8, compareBstr } from './bstr.js';
import type { GitContext, RepoInfo } from './context.js';
import type { DiffDeps } from './diff.js';
import { inspectOptions, readStatus } from './diff.js';
import { exists, mapLimit } from './fs-utils.js';
import { hashParts, STATE_HASH_LENGTH } from './hash.js';
import { DiffOutputParser } from './parse/diff-output.js';
import { DIFF_PINS, resolveDefaultBranch } from './scope.js';
import { absolutePathBuffer, inspectUntracked } from './untracked.js';

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

async function statSignature(root: string, key: string): Promise<string> {
  try {
    const info = await lstat(absolutePathBuffer(root, key), { bigint: true });
    return `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}:${info.mode}`;
  } catch {
    return 'missing';
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
    tracked > 0
      ? ctx.git(repo, ['diff', ...DIFF_PINS, '--numstat', '-z', headSha ?? repo.emptyTree, '--'])
      : Promise.resolve(null);

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
  const [numstatResult, aheadBehind, inProgress, signatures, untrackedInfos] = await Promise.all([
    numstatPromise,
    aheadBehindPromise,
    detectInProgress(repo.gitDir),
    mapLimit(dirtyKeys, STAT_CONCURRENCY, (key) => statSignature(repo.cwd, key)),
    inspectUntracked(
      repo.cwd,
      untrackedKeysSorted.map((key, index) => ({ key, index })),
      deps.untrackedCache,
      inspectOptions(ctx),
    ),
  ]);

  let additions = 0;
  let deletions = 0;
  const trackedPaths = new Set<string>();
  let numstatOutput = '';
  if (numstatResult) {
    numstatOutput = bstrFromBuffer(numstatResult.stdout);
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
      'summary-v1',
      status.output,
      numstatOutput,
      aheadBehind.ref,
      aheadBehind.oid,
      aheadBehind.ahead,
      aheadBehind.behind,
      inProgress,
      dirtyKeys.map((key, i) => `${key}\u0000${signatures[i]}`).join('\u0000'),
      untrackedInfos.map((info) => `${info.key}\u0000${info.statSig}`).join('\u0000'),
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
