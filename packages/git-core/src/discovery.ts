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
import {
  assertAbsolute,
  dotGitTarget,
  type GitContext,
  type RepoInfo,
  readSmallFile,
} from './context.js';
import { exists, realpathOrSelf } from './fs-utils.js';
import { hashId } from './hash.js';
import { forEachRefFormat, parseForEachRef } from './parse/refs.js';
import { parseWorktreeList, type WorktreeRecord } from './parse/worktrees.js';
import { readRefOid, readSymrefTarget, refCandidates, resolveRefFromFiles } from './ref-files.js';

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

  // Project-level commands (worktree list, refs) run against the common dir, without a work tree.
  const projectRepo: RepoInfo = {
    ...repo,
    cwd: repo.commonDir,
    gitDir: repo.commonDir,
    toplevel: null,
  };
  // What git just discovered also answers later `repo()` lookups of the same paths (#29).
  ctx.seedRepo(dir, repo);
  await ctx.seedProjectRepo(repo);
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

export function projectRepoFor(ctx: GitContext, project: ProjectLocator): Promise<RepoInfo> {
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
  const adminRoot = await realpathOrSelf(path.join(repo.commonDir, 'worktrees'));
  const mainWorkTree = await linkedMainWorkTree(ctx, repo, records[0]);
  const worktrees = await Promise.all(
    records.map(async (record, index): Promise<Worktree> => {
      const recordPath = index === 0 && mainWorkTree !== null ? mainWorkTree : record.path;
      const present = await exists(recordPath);
      const worktreePath = present ? await realpathOrSelf(recordPath) : recordPath;
      const branch = record.branch
        ? record.branch.startsWith('refs/heads/')
          ? record.branch.slice('refs/heads/'.length)
          : record.branch
        : null;
      // Linked worktree records come from `<common>/worktrees/<id>/gitdir`, which anything that
      // can write the repository can forge (SEC-07). Only trust a record whose directory points
      // back at an admin dir of this repository that points at it; otherwise report it as
      // prunable and missing, so it is neither watched nor summarized.
      const linked = index > 0 && !record.bare;
      const valid = !linked || !present || (await pointsBack(worktreePath, adminRoot));
      // git reports the common dir itself as the main entry when the work tree is set only by
      // `core.worktree`. Unless that work tree links back (see linkedMainWorkTree), git-core
      // never uses it (SEC-06), and the entry is reported as bare.
      const bare = record.bare || (index === 0 && worktreePath === repo.commonDir);
      return {
        id: hashId(worktreePath),
        projectId,
        path: worktreePath,
        branch: record.bare || record.detached ? null : branch || null,
        headSha: record.head,
        detached: record.detached,
        isMain: index === 0,
        bare,
        locked: record.locked,
        prunable: record.prunable || !valid,
        missing: !present || !valid,
      };
    }),
  );
  // Two records for the same directory (a copied admin dir): keep the first.
  const seen = new Set<string>();
  const unique = worktrees.filter((worktree) => {
    if (seen.has(worktree.id)) return false;
    seen.add(worktree.id);
    return true;
  });
  // Per-project facts for the worktrees' own lookups (#29): their repository info, derived from
  // the files git just listed (no `rev-parse` per worktree), and the branches checked out, so
  // one `for-each-ref` can count ahead/behind for all of them.
  ctx.noteCheckedOutBranches(
    repo.commonDir,
    unique.flatMap((w) => (w.branch && !w.missing ? [`refs/heads/${w.branch}`] : [])),
  );
  await Promise.all(
    unique
      .filter((w) => !w.bare && !w.missing && !w.prunable)
      .map((w) => ctx.seedWorktreeRepo(w.path, repo)),
  );
  return unique;
}

/**
 * For a main entry that git reports as the common dir although it is not bare (its work tree
 * comes from `core.worktree`, e.g. an absorbed submodule's `.git/modules/<name>`), the work
 * tree, if it links back: its `.git` entry must refer to this common dir. A `core.worktree`
 * pointing anywhere else (SEC-06: `/home/user`, `../..`) is ignored. Null otherwise.
 */
async function linkedMainWorkTree(
  ctx: GitContext,
  repo: RepoInfo,
  main: WorktreeRecord | undefined,
): Promise<string | null> {
  if (!main || main.bare) return null;
  if ((await realpathOrSelf(main.path)) !== repo.commonDir) return null;
  // With an explicit --git-dir and no --work-tree, git computes the work tree from
  // core.worktree (or takes the cwd, the common dir, which never links back).
  let candidate = '';
  try {
    const result = await ctx.git(repo, ['rev-parse', '--show-toplevel'], {
      okExitCodes: [0, 128],
    });
    if (result.exitCode === 0) candidate = result.stdout.toString('utf8').trim();
  } catch (error) {
    if (!isGitCoreError(error, 'git_failed')) throw error;
  }
  if (!candidate || !path.isAbsolute(candidate)) return null;
  const real = await realpathOrSelf(candidate);
  if (real === repo.commonDir) return null;
  return (await dotGitTarget(real)) === repo.commonDir ? real : null;
}

/**
 * True if `worktreePath/.git` refers to an admin dir directly under `adminRoot`
 * (`<common>/worktrees`) whose `gitdir` file refers back to `worktreePath/.git`: the two-way
 * link `git worktree add` creates.
 */
async function pointsBack(worktreePath: string, adminRoot: string): Promise<boolean> {
  const admin = await dotGitTarget(worktreePath);
  if (admin === null || path.dirname(admin) !== adminRoot) return false;
  const content = await readSmallFile(path.join(admin, 'gitdir'));
  if (content === null) return false;
  const target = content.toString('utf8').replace(/[\r\n]+$/, '');
  if (target.length === 0 || target.includes('\n') || target.includes('\u0000')) return false;
  const back = await realpathOrSelf(path.resolve(admin, target));
  return back === (await realpathOrSelf(path.join(worktreePath, '.git')));
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
  const fromFiles = await detectDefaultFromFiles(ctx, repo);
  if (fromFiles !== undefined) return fromFiles;
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

/**
 * `detectDefaultBranchRef` from the ref files (no git process, #29); undefined when they cannot
 * tell, and then the `for-each-ref` above decides. Same rules: a dangling `origin/HEAD` is
 * skipped, as `for-each-ref` skips broken refs.
 */
async function detectDefaultFromFiles(
  ctx: GitContext,
  repo: RepoInfo,
): Promise<ResolvedRef | null | undefined> {
  const { commonDir } = repo;
  let originHead = await readSymrefTarget(commonDir, 'refs/remotes/origin/HEAD');
  if (originHead === undefined) return undefined;
  if (originHead !== null) {
    const target = await readRefOid(commonDir, originHead);
    if (target === undefined) return undefined;
    if (target === null) originHead = null;
  }
  if (originHead?.startsWith('refs/remotes/origin/')) {
    const short = originHead.slice('refs/remotes/origin/'.length);
    const local = `refs/heads/${short}`;
    const localOid = await readRefOid(commonDir, local);
    if (localOid === undefined) return undefined;
    if (localOid && RefNameSchema.safeParse(short).success) {
      return { name: short, ref: local, oid: localOid };
    }
    const remote = await resolveRefName(ctx, repo, `origin/${short}`);
    if (remote) return remote;
  }
  for (const name of ['main', 'master', 'trunk']) {
    const oid = await readRefOid(commonDir, `refs/heads/${name}`);
    if (oid === undefined) return undefined;
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
 * The one base lookup of git-core (branch scope, summary ahead/behind, review range and
 * `readBranchBase`): the ref files first, `for-each-ref` when they cannot tell (`ref-files.ts`).
 */
export async function resolveRefName(
  ctx: GitContext,
  repo: RepoInfo,
  name: string,
): Promise<ResolvedRef | null> {
  if (!RefNameSchema.safeParse(name).success) {
    throw new GitCoreError('invalid_argument', `invalid ref name: ${name}`);
  }
  const fromFiles = await resolveRefFromFiles(repo.commonDir, name);
  if (fromFiles !== undefined) return fromFiles;
  const candidates = refCandidates(name);
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
          // Never leave the scan root through a link (SEC-08): `-> /` or `-> ../../elsewhere`
          // would register repositories the user did not choose and walk the whole disk.
          if (!isSameOrInside(rootReal, target)) continue;
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

function isSameOrInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function looksLikeGitDir(names: Map<string, Dirent>): boolean {
  const head = names.get('HEAD');
  const objects = names.get('objects');
  const refs = names.get('refs');
  return Boolean(head?.isFile() && objects?.isDirectory() && refs?.isDirectory());
}
