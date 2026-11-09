import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  type CommitInfo,
  type DiffOptions,
  type DiffScope,
  type FileSelector,
  type GitChangedFile,
  type GitCore,
  GitCoreError,
  type GitCoreErrorCode,
  type GitFileDiff,
  type GitRemoteConfig,
  type GitRepositoryInfo,
  type GitVersion,
  type ProjectLocator,
  type ResolvedProject,
  type ScanOptions,
  type ScanResult,
  type ScopeKind,
  type ScopeOptions,
  type WatchTargets,
  type Worktree,
  type WorktreeLocator,
  type WorktreeSummary,
} from '@octopus-diff/contracts';
import { hashId } from '../src/ids.js';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

export interface FakeWorktree {
  id: string;
  projectId: string;
  path: string;
  gitDir: string;
  branch: string | null;
  headSha: string;
  isMain: boolean;
  locked: boolean;
  /** Files per scope kind (explicit mode). */
  files: Map<ScopeKind, GitChangedFile[]>;
  /** Derive `working` files from the directory contents (every file = untracked). */
  fsBacked: boolean;
  /** Bumped to force a new stateHash. */
  generation: number;
  /** Reported as `prunable` by `git worktree list` (broken or forged record). */
  prunable?: boolean;
}

export interface FakeRepo {
  projectId: string;
  name: string;
  commonDir: string;
  mainPath: string;
  detectedDefaultBranch: string | null;
  worktrees: FakeWorktree[];
}

export interface FakeRepoOptions {
  linked?: string[];
  defaultBranch?: string | null;
  fsBacked?: boolean;
  branch?: string;
}

type Method = keyof GitCore;

/** Builds a contract-valid changed file. */
export function fakeFile(p: string, overrides: Partial<GitChangedFile> = {}): GitChangedFile {
  const content = overrides.patchHash ?? `v1:${p}`;
  return {
    path: p,
    oldPath: null,
    status: 'modified',
    binary: false,
    oldMode: '100644',
    newMode: '100644',
    additions: 1,
    deletions: 0,
    patchHash: sha1(content),
    staged: false,
    unstaged: true,
    ...overrides,
  };
}

const WALK_SKIP = new Set(['.git', 'node_modules']);

function walkFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (WALK_SKIP.has(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(root, childRel));
    else if (entry.isFile()) out.push(childRel);
  }
  return out.sort();
}

/**
 * In-memory GitCore for daemon tests. Repositories are real (empty) directories under a temp
 * dir, so the daemon's path checks and the watcher work; git state is simulated. Mutate
 * `setFiles`/`bump` (explicit mode) or edit files on disk (fsBacked mode).
 */
export class FakeGitCore implements GitCore {
  readonly repos: FakeRepo[] = [];
  readonly calls = new Map<Method, number>();
  /** Artificial latency for every call (ms). */
  delayMs = 0;
  /** Per-method latency (ms), added to `delayMs`. */
  readonly methodDelay = new Map<Method, number>();
  /** Errors to throw: persistent until deleted. */
  readonly failures = new Map<Method, GitCoreError>();
  lastDiffOptions: DiffOptions | undefined;
  lastScopeOptions: ScopeOptions | undefined;
  disposed = false;

  #count(method: Method): void {
    this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
  }

  callCount(method: Method): number {
    return this.calls.get(method) ?? 0;
  }

  async #enter(method: Method, signal?: AbortSignal): Promise<void> {
    this.#count(method);
    if (this.disposed) throw new GitCoreError('disposed', 'disposed');
    const delay = this.delayMs + (this.methodDelay.get(method) ?? 0);
    if (delay > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new GitCoreError('aborted', 'aborted'));
          },
          { once: true },
        );
      });
    }
    const failure = this.failures.get(method);
    if (failure) throw failure;
  }

  fail(method: Method, code: GitCoreErrorCode, message = `${method} failed`): void {
    this.failures.set(method, new GitCoreError(code, message, { stderr: 'fatal: simulated' }));
  }

  /** Creates `<base>/<name>` (+ `.git`) and linked worktrees `<base>/<name>-<wt>`. */
  async createRepo(base: string, name: string, options: FakeRepoOptions = {}): Promise<FakeRepo> {
    const mainPath = path.join(base, name);
    const commonDir = path.join(mainPath, '.git');
    await mkdir(path.join(commonDir, 'refs', 'heads'), { recursive: true });
    const realMain = await realpath(mainPath);
    const realCommon = await realpath(commonDir);
    const projectId = hashId(realCommon);
    const repo: FakeRepo = {
      projectId,
      name,
      commonDir: realCommon,
      mainPath: realMain,
      detectedDefaultBranch: options.defaultBranch === undefined ? 'main' : options.defaultBranch,
      worktrees: [],
    };
    repo.worktrees.push(
      this.#makeWorktree(
        repo,
        realMain,
        realCommon,
        options.branch ?? 'main',
        true,
        options.fsBacked ?? false,
      ),
    );
    for (const wt of options.linked ?? [])
      await this.addLinkedWorktree(repo, wt, options.fsBacked ?? false);
    this.repos.push(repo);
    return repo;
  }

  async addLinkedWorktree(repo: FakeRepo, wtName: string, fsBacked = false): Promise<FakeWorktree> {
    const wtPath = path.join(path.dirname(repo.mainPath), `${repo.name}-${wtName}`);
    const gitDir = path.join(repo.commonDir, 'worktrees', wtName);
    await mkdir(wtPath, { recursive: true });
    await mkdir(gitDir, { recursive: true });
    const wt = this.#makeWorktree(repo, await realpath(wtPath), gitDir, wtName, false, fsBacked);
    repo.worktrees.push(wt);
    return wt;
  }

  #makeWorktree(
    repo: FakeRepo,
    wtPath: string,
    gitDir: string,
    branch: string,
    isMain: boolean,
    fsBacked: boolean,
  ): FakeWorktree {
    return {
      id: hashId(wtPath),
      projectId: repo.projectId,
      path: wtPath,
      gitDir,
      branch,
      headSha: sha1(`${wtPath}:head`),
      isMain,
      locked: false,
      files: new Map(),
      fsBacked,
      generation: 0,
    };
  }

  worktree(id: string): FakeWorktree {
    for (const repo of this.repos) {
      const wt = repo.worktrees.find((w) => w.id === id);
      if (wt) return wt;
    }
    throw new Error(`fake: unknown worktree ${id}`);
  }

  setFiles(worktreeId: string, scopeKind: ScopeKind, files: GitChangedFile[]): void {
    this.worktree(worktreeId).files.set(scopeKind, files);
  }

  bump(worktreeId: string): void {
    this.worktree(worktreeId).generation++;
  }

  removeWorktree(repo: FakeRepo, worktreeId: string): void {
    repo.worktrees = repo.worktrees.filter((w) => w.id !== worktreeId);
  }

  #repoById(id: string): FakeRepo {
    const repo = this.repos.find((r) => r.projectId === id);
    if (!repo) throw new GitCoreError('not_a_repository', `unknown project ${id}`);
    return repo;
  }

  #toWorktree(wt: FakeWorktree): Worktree {
    return {
      id: wt.id,
      projectId: wt.projectId,
      path: wt.path,
      branch: wt.branch,
      headSha: wt.headSha,
      detached: wt.branch === null,
      isMain: wt.isMain,
      bare: false,
      locked: wt.locked,
      prunable: wt.prunable ?? false,
      missing: !existsSync(wt.path),
    };
  }

  #filesFor(wt: FakeWorktree, kind: ScopeKind): GitChangedFile[] {
    if (kind === 'working' && wt.fsBacked) {
      return walkFiles(wt.path).map((rel) => {
        let content = '';
        try {
          content = readFileSync(path.join(wt.path, rel), 'utf8');
        } catch {
          // raced with a delete
        }
        const lines = content === '' ? 0 : content.split('\n').length;
        return fakeFile(rel, {
          status: 'untracked',
          oldMode: null,
          additions: lines,
          patchHash: sha1(`${rel}\u0000${content}`),
          unstaged: true,
        });
      });
    }
    return wt.files.get(kind) ?? [];
  }

  // --- GitCore --------------------------------------------------------------------------------

  async version(): Promise<GitVersion> {
    await this.#enter('version');
    return { raw: 'git version 2.53.0', major: 2, minor: 53, patch: 0, features: {} };
  }

  async resolveProject(p: string): Promise<ResolvedProject> {
    await this.#enter('resolveProject');
    let real: string;
    try {
      real = realpathSync(p);
    } catch {
      throw new GitCoreError('not_a_repository', `not a git repository: ${p}`);
    }
    const inside = (root: string) => real === root || real.startsWith(root + path.sep);
    for (const repo of this.repos) {
      if (!existsSync(repo.commonDir)) continue;
      const matched = repo.worktrees.find((w) => inside(w.path));
      if (matched || inside(repo.commonDir)) {
        return {
          project: {
            id: repo.projectId,
            name: repo.name,
            commonDir: repo.commonDir,
            mainWorktreePath: repo.mainPath,
            bare: false,
            detectedDefaultBranch: repo.detectedDefaultBranch,
          },
          worktrees: repo.worktrees.map((w) => this.#toWorktree(w)),
          matchedWorktreeId: matched?.id ?? null,
        };
      }
    }
    throw new GitCoreError('not_a_repository', `not a git repository: ${p}`);
  }

  async listWorktrees(project: ProjectLocator): Promise<Worktree[]> {
    await this.#enter('listWorktrees');
    const repo = this.#repoById(project.id);
    if (!existsSync(repo.commonDir)) throw new GitCoreError('not_a_repository', 'gone');
    return repo.worktrees.map((w) => this.#toWorktree(w));
  }

  async detectDefaultBranch(project: ProjectLocator): Promise<string | null> {
    await this.#enter('detectDefaultBranch');
    return this.#repoById(project.id).detectedDefaultBranch;
  }

  async scan(root: string, options: ScanOptions): Promise<ScanResult> {
    await this.#enter('scan', options.signal);
    const realRoot = realpathSync(root);
    const repositories: string[] = [];
    let scannedDirs = 0;
    for (const repo of this.repos) {
      if (options.signal?.aborted) throw new GitCoreError('aborted', 'aborted');
      if (!repo.mainPath.startsWith(realRoot + path.sep) && repo.mainPath !== realRoot) continue;
      const depth = path.relative(realRoot, repo.mainPath).split(path.sep).filter(Boolean).length;
      scannedDirs++;
      if (depth > options.depth) continue;
      repositories.push(repo.mainPath);
      options.onProgress?.({
        scannedDirs,
        foundRepos: repositories.length,
        currentPath: repo.mainPath,
      });
    }
    return { repositories, scannedDirs, truncated: false };
  }

  async getSummary(loc: WorktreeLocator, options?: ScopeOptions): Promise<WorktreeSummary> {
    await this.#enter('getSummary');
    this.lastScopeOptions = options;
    const wt = this.worktree(loc.worktreeId);
    if (!existsSync(wt.path)) throw new GitCoreError('not_found', `worktree missing: ${wt.path}`);
    const files = this.#filesFor(wt, 'working');
    const staged = files.filter((f) => f.staged).length;
    const untracked = files.filter((f) => f.status === 'untracked').length;
    const conflicted = files.filter((f) => f.status === 'conflicted').length;
    const unstaged = files.filter((f) => f.unstaged && f.status !== 'untracked').length;
    const stateHash = sha1(
      JSON.stringify({
        b: wt.branch,
        h: wt.headSha,
        g: wt.generation,
        d: options?.defaultBranch ?? null,
        f: files.map((f) => [f.path, f.status, f.patchHash]),
      }),
    );
    return {
      worktreeId: wt.id,
      projectId: wt.projectId,
      branch: wt.branch,
      headSha: wt.headSha,
      detached: wt.branch === null,
      upstream: null,
      aheadBehindRef:
        options?.defaultBranch && options.defaultBranch !== wt.branch
          ? options.defaultBranch
          : null,
      ahead: options?.defaultBranch && options.defaultBranch !== wt.branch ? 1 : null,
      behind: options?.defaultBranch && options.defaultBranch !== wt.branch ? 0 : null,
      counts: { staged, unstaged, untracked, conflicted },
      changedFiles: files.length,
      additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
      deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
      inProgress: null,
      stateHash,
      updatedAt: new Date().toISOString(),
    };
  }

  async listChangedFiles(
    loc: WorktreeLocator,
    scope: DiffScope,
    options?: ScopeOptions,
  ): Promise<GitChangedFile[]> {
    await this.#enter('listChangedFiles');
    this.lastScopeOptions = options;
    return this.#filesFor(this.worktree(loc.worktreeId), scope.kind);
  }

  async getFileDiff(
    loc: WorktreeLocator,
    scope: DiffScope,
    file: FileSelector,
    options?: DiffOptions,
  ): Promise<GitFileDiff> {
    await this.#enter('getFileDiff');
    this.lastDiffOptions = options;
    const files = this.#filesFor(this.worktree(loc.worktreeId), scope.kind);
    const match = files.find((f) =>
      file.rawPath !== undefined ? f.rawPath === file.rawPath : f.path === file.path,
    );
    if (!match) throw new GitCoreError('not_found', `${file.path} is not changed in ${scope.kind}`);
    const { staged: _s, unstaged: _u, ...identity } = match;
    const patch = `diff --git a/${match.path} b/${match.path}\n--- a/${match.path}\n+++ b/${match.path}\n@@ -1 +1 @@\n+${match.patchHash}\n`;
    return { ...identity, patch, tooLarge: false, truncated: false, byteLength: patch.length };
  }

  async listCommits(loc: WorktreeLocator, options?: { limit?: number }): Promise<CommitInfo[]> {
    await this.#enter('listCommits');
    const wt = this.worktree(loc.worktreeId);
    const n = Math.min(options?.limit ?? 50, 3);
    return Array.from({ length: n }, (_, i) => {
      const sha = sha1(`${wt.headSha}:${i}`);
      return {
        sha,
        shortSha: sha.slice(0, 7),
        parents: i < n - 1 ? [sha1(`${wt.headSha}:${i + 1}`)] : [],
        subject: `commit ${i}`,
        authorName: 'Test',
        authorEmail: 'test@example.com',
        authorDate: '2026-11-08T00:00:00.000Z',
        committerDate: '2026-11-08T00:00:00.000Z',
      };
    });
  }

  /** Remote config per common dir (forge tests); default: no remotes. */
  readonly remoteConfigs = new Map<string, GitRemoteConfig>();

  async readRemoteConfig(project: ProjectLocator): Promise<GitRemoteConfig> {
    return (
      this.remoteConfigs.get(project.commonDir) ?? { remotes: [], branches: {}, pushDefault: null }
    );
  }

  /** Repository facts (Overview tests); default: the branch count of the fake repo. */
  repositoryInfo: ((project: ProjectLocator) => Promise<GitRepositoryInfo>) | null = null;
  repositoryInfoCalls = 0;

  async readRepositoryInfo(project: ProjectLocator): Promise<GitRepositoryInfo> {
    this.repositoryInfoCalls += 1;
    if (this.repositoryInfo) return this.repositoryInfo(project);
    return {
      defaultBranch: null,
      localBranches: 1,
      tags: 0,
      remotes: (await this.readRemoteConfig(project)).remotes.map((r) => ({
        name: r.name,
        url: r.url,
        pushUrl: r.pushUrl,
      })),
      lastActivityAt: null,
    };
  }

  async getWatchTargets(loc: WorktreeLocator): Promise<WatchTargets> {
    await this.#enter('getWatchTargets');
    const wt = this.worktree(loc.worktreeId);
    const repo = this.#repoById(wt.projectId);
    return {
      worktreeRoot: wt.path,
      gitDir: wt.gitDir,
      commonDir: repo.commonDir,
      gitPaths: [
        path.join(wt.gitDir, 'HEAD'),
        path.join(wt.gitDir, 'index'),
        path.join(repo.commonDir, 'refs'),
        path.join(repo.commonDir, 'packed-refs'),
        path.join(repo.commonDir, 'worktrees'),
      ],
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
