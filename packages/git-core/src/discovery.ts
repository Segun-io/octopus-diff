import type { Dirent } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  GitCoreError,
  type GitProjectInfo,
  isGitCoreError,
  type ProjectLocator,
  RefNameSchema,
  type ResolvedProject,
  ScanDepthSchema,
  type ScanOptions,
  type ScanResult,
  type Worktree,
} from '@octopus-diff/contracts';
import { bstrFromBuffer, bstrToUtf8 } from './bstr.js';
import { assertAbsolute, type GitContext, type RepoInfo } from './context.js';
import { exists, realpathOrSelf } from './fs-utils.js';
import { hashId } from './hash.js';
import { forEachRefFormat, parseForEachRef } from './parse/refs.js';
import { parseWorktreeList } from './parse/worktrees.js';

/** Hard cap on directories visited by one scan. */
export const SCAN_MAX_DIRS = 100_000;
const SCAN_CONCURRENCY = 16;
const PROGRESS_EVERY = 50;

/** Resolves any path inside a repository to its project and worktrees. */
export async function resolveProject(ctx: GitContext, input: string): Promise<ResolvedProject> {
  assertAbsolute(input);
  let dir: string;
  try {
    dir = await realpath(input);
    const info = await stat(dir);
    if (!info.isDirectory()) dir = path.dirname(dir);
  } catch {
    throw new GitCoreError('not_a_repository', `path does not exist: ${input}`, { cwd: input });
  }

  let repo: RepoInfo;
  try {
    repo = await ctx.resolveRepo(dir);
  } catch (error) {
    if (isGitCoreError(error, 'git_failed') || isGitCoreError(error, 'not_found')) {
      throw new GitCoreError('not_a_repository', `not a git repository: ${input}`, error.details, {
        cause: error,
      });
    }
    throw error;
  }

  // The worktree containing the input, if any (none inside a git dir or a bare repository).
  const toplevel = repo.toplevel;

  const projectRepo: RepoInfo = { ...repo, cwd: repo.commonDir };
  const [worktrees, detectedDefaultBranch] = await Promise.all([
    listWorktreesIn(ctx, projectRepo),
    detectDefaultBranchIn(ctx, projectRepo),
  ]);
  const main = worktrees[0];
  const bare = main?.bare ?? repo.bare;
  const mainWorktreePath = main && !main.bare ? main.path : null;
  const project: GitProjectInfo = {
    id: hashId(repo.commonDir),
    name: projectName(repo.commonDir, mainWorktreePath),
    commonDir: repo.commonDir,
    mainWorktreePath,
    bare,
    detectedDefaultBranch,
  };
  const matched = toplevel ? worktrees.find((worktree) => worktree.path === toplevel) : undefined;
  return { project, worktrees, matchedWorktreeId: matched?.id ?? null };
}

function projectName(commonDir: string, mainWorktreePath: string | null): string {
  if (mainWorktreePath) return path.basename(mainWorktreePath) || mainWorktreePath;
  let base = path.basename(commonDir);
  if (base === '.git') base = path.basename(path.dirname(commonDir));
  else if (base.endsWith('.git') && base.length > 4) base = base.slice(0, -4);
  return base || commonDir;
}

function projectRepoFor(ctx: GitContext, project: ProjectLocator): Promise<RepoInfo> {
  assertAbsolute(project.commonDir);
  return ctx.repo(project.commonDir);
}

export async function listWorktrees(ctx: GitContext, project: ProjectLocator): Promise<Worktree[]> {
  return listWorktreesIn(ctx, await projectRepoFor(ctx, project));
}

async function listWorktreesIn(ctx: GitContext, repo: RepoInfo): Promise<Worktree[]> {
  const version = await ctx.version();
  const useZ = version.features.worktreeListZ === true;
  const result = await ctx.git(repo, ['worktree', 'list', '--porcelain', ...(useZ ? ['-z'] : [])]);
  const records = parseWorktreeList(result.stdout.toString('utf8'), useZ);
  const projectId = hashId(repo.commonDir);
  return Promise.all(
    records.map(async (record, index): Promise<Worktree> => {
      const present = await exists(record.path);
      const worktreePath = present ? await realpathOrSelf(record.path) : record.path;
      const branch = record.branch
        ? record.branch.startsWith('refs/heads/')
          ? record.branch.slice('refs/heads/'.length)
          : record.branch
        : null;
      return {
        id: hashId(worktreePath),
        projectId,
        path: worktreePath,
        branch: record.bare || record.detached ? null : branch || null,
        headSha: record.head,
        detached: record.detached,
        isMain: index === 0,
        bare: record.bare,
        locked: record.locked,
        prunable: record.prunable,
        missing: !present,
      };
    }),
  );
}

export async function detectDefaultBranch(
  ctx: GitContext,
  project: ProjectLocator,
): Promise<string | null> {
  return detectDefaultBranchIn(ctx, await projectRepoFor(ctx, project));
}

export interface ResolvedRef {
  /** Display name, e.g. `main` or `origin/main`. */
  name: string;
  /** Full ref name, e.g. `refs/heads/main`. */
  ref: string;
  /** Object the ref points to. */
  oid: string;
}

/**
 * `refs/remotes/origin/HEAD` → `origin/<b>` (reported as `<b>` when a local branch `<b>`
 * exists, since agent worktrees usually branch from the local one), then local `main`,
 * `master`, `trunk`. Local refs only; never fetches.
 */
export async function detectDefaultBranchRef(
  ctx: GitContext,
  repo: RepoInfo,
): Promise<ResolvedRef | null> {
  const result = await ctx.git(repo, [
    'for-each-ref',
    `--format=${forEachRefFormat(['refname', 'symref', 'objectname'])}`,
    'refs/remotes/origin/HEAD',
    'refs/heads/',
  ]);
  const rows = parseForEachRef(bstrToUtf8(bstrFromBuffer(result.stdout)), 3);
  const refs = new Map<string, string>();
  let originHead: string | null = null;
  for (const [refname = '', symref = '', oid = ''] of rows) {
    if (refname === 'refs/remotes/origin/HEAD') originHead = symref || null;
    else refs.set(refname, oid);
  }
  if (originHead?.startsWith('refs/remotes/origin/')) {
    const short = originHead.slice('refs/remotes/origin/'.length);
    const local = `refs/heads/${short}`;
    const localOid = refs.get(local);
    if (localOid && RefNameSchema.safeParse(short).success) {
      return { name: short, ref: local, oid: localOid };
    }
    const remote = await resolveRefName(ctx, repo, `origin/${short}`);
    if (remote) return remote;
  }
  for (const name of ['main', 'master', 'trunk']) {
    const oid = refs.get(`refs/heads/${name}`);
    if (oid) return { name, ref: `refs/heads/${name}`, oid };
  }
  return null;
}

async function detectDefaultBranchIn(ctx: GitContext, repo: RepoInfo): Promise<string | null> {
  return (await detectDefaultBranchRef(ctx, repo))?.name ?? null;
}

/**
 * Resolves a user-facing ref name (already validated by `RefNameSchema`) to a full ref:
 * exact `refs/...`, else `refs/heads/<n>`, `refs/remotes/<n>`, `refs/tags/<n>` in that order.
 */
export async function resolveRefName(
  ctx: GitContext,
  repo: RepoInfo,
  name: string,
): Promise<ResolvedRef | null> {
  if (!RefNameSchema.safeParse(name).success) {
    throw new GitCoreError('invalid_argument', `invalid ref name: ${name}`);
  }
  const candidates = name.startsWith('refs/')
    ? [name]
    : [`refs/heads/${name}`, `refs/remotes/${name}`, `refs/tags/${name}`];
  const result = await ctx.git(repo, [
    'for-each-ref',
    `--format=${forEachRefFormat(['refname', 'objectname'])}`,
    ...candidates,
  ]);
  const rows = parseForEachRef(bstrToUtf8(bstrFromBuffer(result.stdout)), 2);
  const found = new Map(rows.map(([refname = '', oid = '']) => [refname, oid]));
  for (const candidate of candidates) {
    const oid = found.get(candidate);
    if (oid) return { name, ref: candidate, oid };
  }
  return null;
}

/** Walks `root` looking for repositories (no git processes are spawned). */
export async function scan(root: string, options: ScanOptions): Promise<ScanResult> {
  assertAbsolute(root);
  const depthCheck = ScanDepthSchema.safeParse(options.depth);
  if (!depthCheck.success) {
    throw new GitCoreError('invalid_argument', `invalid scan depth: ${String(options.depth)}`);
  }
  const maxDepth = depthCheck.data;
  const skip = new Set(['node_modules', '.git', ...(options.ignore ?? [])]);
  let rootReal: string;
  try {
    rootReal = await realpath(root);
    if (!(await stat(rootReal)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new GitCoreError('not_found', `scan root does not exist or is not a directory: ${root}`);
  }

  const visited = new Set<string>([rootReal]);
  const repositories = new Set<string>();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootReal, depth: 0 }];
  let scannedDirs = 0;
  let truncated = false;
  let lastPath = rootReal;

  let failure: unknown = null;
  const report = (): void => {
    if (failure !== null) return;
    try {
      options.onProgress?.({
        scannedDirs,
        foundRepos: repositories.size,
        currentPath: lastPath,
      });
    } catch (error) {
      failure = error; // A throwing callback stops the scan; scan() rejects with it.
    }
  };

  const visit = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory (permissions, vanished): skip.
    }
    scannedDirs += 1;
    lastPath = dir;
    if (scannedDirs % PROGRESS_EVERY === 0) report();

    const names = new Map(entries.map((entry) => [entry.name, entry]));
    const dotGit = names.get('.git');
    if (dotGit && (dotGit.isDirectory() || dotGit.isFile() || dotGit.isSymbolicLink())) {
      repositories.add(dir);
    } else if (looksLikeGitDir(names)) {
      repositories.add(dir);
      return; // A bare repository / git dir: nothing to find inside.
    }
    if (depth >= maxDepth) return;

    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      let key: string;
      if (entry.isDirectory()) {
        key = child;
      } else if (entry.isSymbolicLink()) {
        try {
          const target = await realpath(child);
          if (!(await stat(target)).isDirectory()) continue;
          key = target;
        } catch {
          continue; // Dangling link.
        }
      } else {
        continue;
      }
      if (visited.has(key)) continue; // Symlink loops and duplicate targets.
      visited.add(key);
      queue.push({ dir: key, depth: depth + 1 });
    }
  };

  let active = 0;
  await new Promise<void>((resolve) => {
    const pump = (): void => {
      while (active < SCAN_CONCURRENCY && queue.length > 0) {
        if (options.signal?.aborted || scannedDirs >= SCAN_MAX_DIRS) {
          truncated = true;
          queue.length = 0;
          break;
        }
        if (failure !== null) {
          queue.length = 0;
          break;
        }
        const item = queue.shift() as { dir: string; depth: number };
        active += 1;
        visit(item.dir, item.depth)
          .catch((error: unknown) => {
            failure ??= error;
          })
          .finally(() => {
            active -= 1;
            pump();
          });
      }
      if (active === 0 && queue.length === 0) resolve();
    };
    pump();
  });
  if (options.signal?.aborted) truncated = true;
  report();
  if (failure !== null) {
    throw failure instanceof GitCoreError
      ? failure
      : new GitCoreError('aborted', `scan stopped: ${String(failure)}`, {}, { cause: failure });
  }
  return {
    repositories: [...repositories].sort(),
    scannedDirs,
    truncated,
  };
}

function looksLikeGitDir(names: Map<string, Dirent>): boolean {
  const head = names.get('HEAD');
  const objects = names.get('objects');
  const refs = names.get('refs');
  return Boolean(head?.isFile() && objects?.isDirectory() && refs?.isDirectory());
}
