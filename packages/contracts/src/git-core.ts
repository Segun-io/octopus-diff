import type { Logger } from './common.js';
import type {
  CommitInfo,
  FileSelector,
  GitChangedFile,
  GitFileDiff,
  GitProjectInfo,
  Worktree,
  WorktreeSummary,
} from './domain.js';
import type { DiffScope } from './scope.js';

/**
 * The seam between `apps/daemon` and `packages/git-core`. The daemon codes against this
 * interface; git-core implements it with the git CLI under the read-only rules of PLAN §5.5:
 * one runner, subcommand allowlist, `--no-optional-locks`, argv arrays only, timeouts, output
 * caps, and a global concurrency limit with per-repo queues.
 *
 * All paths returned are realpaths. All methods reject with `GitCoreError`.
 */
export interface GitCore {
  /** Detected git version and feature flags. Cached after the first call. */
  version(): Promise<GitVersion>;

  /**
   * Resolves any path inside a repository (main checkout, linked worktree, subdirectory, or
   * a bare repo / git dir) to its project and all of its worktrees.
   * Rejects with `not_a_repository` if the path is not inside a git repository.
   */
  resolveProject(path: string): Promise<ResolvedProject>;

  /** Re-runs `git worktree list` for a project. */
  listWorktrees(project: ProjectLocator): Promise<Worktree[]>;

  /** origin/HEAD, then `main` / `master` / `trunk` if such a local branch exists; else null. */
  detectDefaultBranch(project: ProjectLocator): Promise<string | null>;

  /**
   * Walks `root` to `depth` levels looking for repositories. Skips `node_modules` and the
   * names in `ignore`, does not descend into found repositories' `.git`, never follows
   * symlink loops. Returns one path per repository found (pass each to `resolveProject`).
   */
  scan(root: string, options: ScanOptions): Promise<ScanResult>;

  /** Cheap status summary for one worktree (see `WorktreeSummary`). */
  getSummary(worktree: WorktreeLocator, options?: ScopeOptions): Promise<WorktreeSummary>;

  /** Changed files in `scope`, with per-file line counts and `patchHash`. */
  listChangedFiles(
    worktree: WorktreeLocator,
    scope: DiffScope,
    options?: ScopeOptions,
  ): Promise<GitChangedFile[]>;

  /**
   * The unified diff of one file in `scope`. `patchHash` must equal the value from
   * `listChangedFiles` for the same state, regardless of `ignoreWhitespace` / `contextLines`.
   * Rejects with `not_found` if the file is not changed in `scope`.
   */
  getFileDiff(
    worktree: WorktreeLocator,
    scope: DiffScope,
    file: FileSelector,
    options?: DiffOptions,
  ): Promise<GitFileDiff>;

  /** Recent commits reachable from HEAD, newest first (for the commit-scope picker). */
  listCommits(worktree: WorktreeLocator, options?: { limit?: number }): Promise<CommitInfo[]>;

  /** Locations the daemon's watcher should observe for this worktree. */
  getWatchTargets(worktree: WorktreeLocator): Promise<WatchTargets>;

  /**
   * Remotes and branch tracking config of a project (forge integration, docs/FORGES.md): one
   * `git config --get-regexp` read; `url.<base>.insteadOf` rewrites are applied to remote URLs.
   * Optional so that test doubles and older implementations need not provide it.
   */
  readRemoteConfig?(project: ProjectLocator): Promise<GitRemoteConfig>;

  /** Kills in-flight git processes and rejects queued work. */
  dispose(): Promise<void>;
}

export interface GitCoreOptions {
  /** Git executable; default `git` from PATH. */
  gitBinary?: string;
  /** Max concurrent git processes overall (default 4); work is queued per repository. */
  concurrency?: number;
  /** Per-invocation timeout in ms (default 15 000). */
  timeoutMs?: number;
  /** Hard cap on stdout bytes per invocation (default 64 MiB); exceeding it kills the process. */
  maxOutputBytes?: number;
  /** Soft per-file patch limit in bytes (default 1 MiB); larger patches return `tooLarge`. */
  maxPatchBytes?: number;
  /** Max untracked files to read for line counts / patch hashes per worktree (default 2 000). */
  maxUntrackedFiles?: number;
  /**
   * Extra environment for git processes (tests use this to isolate config, e.g.
   * `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`). Safety variables set by the runner always win.
   */
  env?: Record<string, string>;
  logger?: Logger;
}

/** `createGitCore` in `@octopus-diff/git-core` has this signature. */
export type CreateGitCore = (options?: GitCoreOptions) => GitCore;

export interface GitVersion {
  /** Output of `git --version`, e.g. `git version 2.53.0`. */
  raw: string;
  major: number;
  minor: number;
  patch: number;
  /** Feature flags detected from the version (e.g. `worktreeListZ`, `endOfOptions`). */
  features: Record<string, boolean>;
}

export interface ProjectLocator {
  id: string;
  /** Realpath of the common git dir. */
  commonDir: string;
}

export interface WorktreeLocator {
  projectId: string;
  worktreeId: string;
  /** Realpath of the worktree root. */
  path: string;
}

/** One configured remote (`remote.<name>.*`). */
export interface GitRemote {
  name: string;
  /** `remote.<name>.url` with `url.<base>.insteadOf` applied; null when unset. */
  url: string | null;
  /** `remote.<name>.pushurl` with `pushInsteadOf` / `insteadOf` applied; null when unset. */
  pushUrl: string | null;
  /** `remote.<name>.gh-resolved` (written by `gh repo set-default`): `base` or `owner/name`. */
  ghResolved: string | null;
}

/** `branch.<name>.*` tracking config of one local branch. */
export interface GitBranchConfig {
  remote: string | null;
  /** Full ref, e.g. `refs/heads/feature/x`. */
  merge: string | null;
  pushRemote: string | null;
}

export interface GitRemoteConfig {
  remotes: GitRemote[];
  /** By short branch name. */
  branches: Record<string, GitBranchConfig>;
  /** `remote.pushDefault`, or null. */
  pushDefault: string | null;
}

export interface ResolvedProject {
  project: GitProjectInfo;
  worktrees: Worktree[];
  /** The worktree containing the input path, or null (e.g. the input was the common dir). */
  matchedWorktreeId: string | null;
}

export interface ScopeOptions {
  /**
   * Default branch used for `branch` scope when `scope.base` is absent, and as the fallback
   * ahead/behind reference when there is no upstream. If null/undefined, git-core detects it.
   */
  defaultBranch?: string | null;
}

export interface DiffOptions extends ScopeOptions {
  /** `git diff -w`. */
  ignoreWhitespace?: boolean;
  /** `-U<n>` context lines (default 3). */
  contextLines?: number;
  /** Ignore the soft `maxPatchBytes` limit (the hard output cap still applies). */
  full?: boolean;
}

export interface ScanProgress {
  scannedDirs: number;
  foundRepos: number;
  currentPath: string;
}

export interface ScanOptions {
  /** 0 = only `root` itself; 1 = root and its children; ... */
  depth: number;
  /** Directory names to skip in addition to `node_modules`. */
  ignore?: string[];
  signal?: AbortSignal;
  onProgress?: (progress: ScanProgress) => void;
}

export interface ScanResult {
  /** One path per repository found (a worktree root, or a git dir for bare repos). */
  repositories: string[];
  scannedDirs: number;
  /** Stopped early (abort or internal directory cap). */
  truncated: boolean;
}

export interface WatchTargets {
  worktreeRoot: string;
  /** This worktree's git dir (`<common>/worktrees/<name>` for linked worktrees). */
  gitDir: string;
  commonDir: string;
  /**
   * Files and directories whose changes mean git state changed: e.g. `<gitDir>/HEAD`,
   * `<gitDir>/index`, `<commonDir>/refs`, `<commonDir>/packed-refs`, `<commonDir>/worktrees`.
   */
  gitPaths: string[];
  // May also include submodule git dirs (`<gitDir>/modules`, `<commonDir>/modules`): watch their
  // HEAD and refs and attribute events to this worktree (review finding F3).
}

export const GIT_CORE_ERROR_CODES = [
  'not_a_repository',
  'not_found',
  'invalid_argument',
  'command_not_allowed',
  'git_not_found',
  'git_unsupported',
  'git_failed',
  'timeout',
  'output_too_large',
  'aborted',
  'disposed',
  'not_implemented',
] as const;
export type GitCoreErrorCode = (typeof GIT_CORE_ERROR_CODES)[number];

export interface GitCoreErrorDetails {
  /** argv passed to git (never includes secrets; safe to log). */
  args?: string[];
  cwd?: string;
  exitCode?: number | null;
  signal?: string | null;
  /** First few KiB of stderr. */
  stderr?: string;
  [key: string]: unknown;
}

export class GitCoreError extends Error {
  readonly code: GitCoreErrorCode;
  readonly details: GitCoreErrorDetails;

  constructor(
    code: GitCoreErrorCode,
    message: string,
    details: GitCoreErrorDetails = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'GitCoreError';
    this.code = code;
    this.details = details;
  }
}

export function isGitCoreError(error: unknown, code?: GitCoreErrorCode): error is GitCoreError {
  return error instanceof GitCoreError && (code === undefined || error.code === code);
}
