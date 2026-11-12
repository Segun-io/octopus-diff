import path from 'node:path';
import {
  COMMITS_LIMIT_DEFAULT,
  COMMITS_LIMIT_MAX,
  type CommitInfo,
  type CreateGitCore,
  type GitCore,
  GitCoreError,
  type GitCoreOptions,
  isGitCoreError,
  noopLogger,
  type WatchTargets,
  type WorktreeLocator,
} from '@octopus-diff/contracts';
import { readBranchBase } from './branch-base.js';
import { GitContext } from './context.js';
import { createAttributeCache, type DiffDeps, getFileDiff, listChangedFiles } from './diff.js';
import { detectDefaultBranch, listWorktrees, resolveProject, scan } from './discovery.js';
import { LOG_FORMAT, parseLog } from './parse/log.js';
import { readRemoteConfig } from './remotes.js';
import { readRepositoryInfo } from './repository.js';
import {
  createCommitDetailsCache,
  describeCommits,
  type ReviewDeps,
  rangePatchId,
  readReviewRange,
} from './review.js';
import { defaultBigFileThreshold, GitRunner } from './runner/runner.js';
import { getSummary } from './summary.js';
import { createUntrackedCache } from './untracked.js';

const DEFAULTS = {
  concurrency: 4,
  timeoutMs: 15_000,
  maxOutputBytes: 64 * 1024 * 1024,
  maxPatchBytes: 1024 * 1024,
  maxUntrackedFiles: 2000,
};

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new GitCoreError('invalid_argument', `${name} must be a positive number`);
  }
  return Math.floor(value);
}

async function listCommits(
  ctx: GitContext,
  worktree: WorktreeLocator,
  options: { limit?: number } | undefined,
): Promise<CommitInfo[]> {
  await ctx.ensureSupported();
  const limit = options?.limit ?? COMMITS_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > COMMITS_LIMIT_MAX) {
    throw new GitCoreError('invalid_argument', `limit must be 1..${COMMITS_LIMIT_MAX}`);
  }
  const repo = await ctx.repo(worktree.path);
  try {
    const result = await ctx.git(repo, [
      'log',
      '-z',
      `--format=${LOG_FORMAT}`,
      `--max-count=${limit}`,
      'HEAD',
      '--',
    ]);
    return parseLog(result.stdout.toString('utf8'));
  } catch (error) {
    if (
      isGitCoreError(error, 'git_failed') &&
      /does not have any commits|bad default revision|unknown revision|bad revision 'HEAD'/i.test(
        error.details.stderr ?? '',
      )
    ) {
      return [];
    }
    throw error;
  }
}

async function getWatchTargets(ctx: GitContext, worktree: WorktreeLocator): Promise<WatchTargets> {
  await ctx.ensureSupported();
  const repo = await ctx.repo(worktree.path);
  const { gitDir, commonDir } = repo;
  const gitPaths = [
    path.join(gitDir, 'HEAD'),
    path.join(gitDir, 'index'),
    path.join(gitDir, 'MERGE_HEAD'),
    path.join(gitDir, 'CHERRY_PICK_HEAD'),
    path.join(gitDir, 'REVERT_HEAD'),
    path.join(gitDir, 'BISECT_START'),
    path.join(gitDir, 'rebase-merge'),
    path.join(gitDir, 'rebase-apply'),
    path.join(gitDir, 'config.worktree'),
    path.join(commonDir, 'refs'),
    path.join(commonDir, 'packed-refs'),
    path.join(commonDir, 'reftable'),
    path.join(commonDir, 'worktrees'),
    path.join(commonDir, 'config'),
    path.join(commonDir, 'info', 'exclude'),
    path.join(commonDir, 'info', 'attributes'),
    // Git dirs of absorbed submodules (`modules/<name>`, nested for nested submodules). A
    // commit or checkout inside a submodule changes the superproject's patch for its gitlink
    // (F3); what matters below these is `HEAD`, `refs/**`, `packed-refs` and `reftable/**`,
    // not `objects`, `logs` or `index`.
    path.join(gitDir, 'modules'),
    path.join(commonDir, 'modules'),
  ];
  if (gitDir !== commonDir) gitPaths.push(path.join(gitDir, 'refs'));
  return {
    worktreeRoot: repo.bare ? gitDir : worktree.path,
    gitDir,
    commonDir,
    gitPaths: [...new Set(gitPaths)],
  };
}

/** Creates the git-core implementation of the `GitCore` contract. */
export const createGitCore: CreateGitCore = (options: GitCoreOptions = {}): GitCore => {
  const settings = {
    timeoutMs: positiveInt(options.timeoutMs, DEFAULTS.timeoutMs, 'timeoutMs'),
    maxOutputBytes: positiveInt(options.maxOutputBytes, DEFAULTS.maxOutputBytes, 'maxOutputBytes'),
    maxPatchBytes: positiveInt(options.maxPatchBytes, DEFAULTS.maxPatchBytes, 'maxPatchBytes'),
    maxUntrackedFiles:
      options.maxUntrackedFiles === undefined
        ? DEFAULTS.maxUntrackedFiles
        : Math.max(0, Math.floor(options.maxUntrackedFiles)),
    logger: options.logger ?? noopLogger,
    bigFileThreshold: 0,
  };
  settings.bigFileThreshold = defaultBigFileThreshold(settings.maxOutputBytes);
  const runner = new GitRunner({
    bigFileThreshold: settings.bigFileThreshold,
    gitBinary: options.gitBinary,
    concurrency: positiveInt(options.concurrency, DEFAULTS.concurrency, 'concurrency'),
    timeoutMs: settings.timeoutMs,
    maxOutputBytes: settings.maxOutputBytes,
    env: options.env,
    logger: settings.logger,
  });
  const ctx = new GitContext(runner, settings);
  const deps: DiffDeps = {
    ctx,
    untrackedCache: createUntrackedCache(),
    attributeCache: createAttributeCache(),
  };
  const reviewDeps: ReviewDeps = { ctx, commitCache: createCommitDetailsCache() };
  let disposed = false;

  /** Rejects after dispose, and maps unexpected errors to `GitCoreError`. */
  const guard = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => {
    return async (...args: A): Promise<R> => {
      if (disposed) throw new GitCoreError('disposed', 'git-core has been disposed');
      try {
        return await fn(...args);
      } catch (error) {
        if (error instanceof GitCoreError) throw error;
        throw new GitCoreError(
          'git_failed',
          `unexpected git-core error: ${String(error)}`,
          {},
          {
            cause: error,
          },
        );
      }
    };
  };

  return {
    version: guard(() => ctx.version()),
    resolveProject: guard(async (input: string) => {
      await ctx.ensureSupported();
      return resolveProject(ctx, input);
    }),
    listWorktrees: guard(async (project) => {
      await ctx.ensureSupported();
      return listWorktrees(ctx, project);
    }),
    detectDefaultBranch: guard(async (project) => {
      await ctx.ensureSupported();
      return detectDefaultBranch(ctx, project);
    }),
    scan: guard((root, scanOptions) => scan(root, scanOptions)),
    getSummary: guard((worktree, scopeOptions) => getSummary(deps, worktree, scopeOptions)),
    listChangedFiles: guard((worktree, scope, scopeOptions) =>
      listChangedFiles(deps, worktree, scope, scopeOptions),
    ),
    getFileDiff: guard((worktree, scope, file, diffOptions) =>
      getFileDiff(deps, worktree, scope, file, diffOptions),
    ),
    listCommits: guard((worktree, commitOptions) => listCommits(ctx, worktree, commitOptions)),
    getWatchTargets: guard((worktree) => getWatchTargets(ctx, worktree)),
    readRemoteConfig: guard(async (project) => {
      await ctx.ensureSupported();
      return readRemoteConfig(ctx, project);
    }),
    readRepositoryInfo: guard(async (project, infoOptions) => {
      await ctx.ensureSupported();
      return readRepositoryInfo(ctx, project, infoOptions);
    }),
    readBranchBase: guard((project, baseOptions) => readBranchBase(ctx, project, baseOptions)),
    readReviewRange: guard((worktree, rangeOptions) =>
      readReviewRange(reviewDeps, worktree, rangeOptions),
    ),
    describeCommits: guard((worktree, shas) => describeCommits(reviewDeps, worktree, shas)),
    rangePatchId: guard((worktree, from, to) => rangePatchId(reviewDeps, worktree, from, to)),
    dispose: async () => {
      disposed = true;
      reviewDeps.commitCache.clear();
      deps.untrackedCache.clear();
      deps.attributeCache.clear();
      await runner.dispose();
    },
  };
};
