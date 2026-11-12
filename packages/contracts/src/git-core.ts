import type { Logger } from './common.js';
import type {
  CommitInfo,
  FileOrigin,
  FileOriginVia,
  FileSelector,
  GitChangedFile,
  GitFileDiff,
  GitProjectInfo,
  GitRepositoryInfo,
  Worktree,
  WorktreeSummary,
} from './domain.js';
import type { BlobRead, BlobReadOptions, SummarySnapshot } from './live.js';
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

  /**
   * Cheap status summary for one worktree (see `WorktreeSummary`). With `options.snapshot` the
   * result also carries the per-file snapshot the summary computed anyway (no extra git process);
   * without it the result is exactly what it was before the option existed.
   */
  getSummary(worktree: WorktreeLocator, options?: SummaryOptions): Promise<SummaryResult>;

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
  listCommits(
    worktree: WorktreeLocator,
    options?: { limit?: number } & CallOptions,
  ): Promise<CommitInfo[]>;

  /** Locations the daemon's watcher should observe for this worktree. */
  getWatchTargets(worktree: WorktreeLocator): Promise<WatchTargets>;

  /**
   * Remotes and branch tracking config of a project (forge integration, docs/FORGES.md): one
   * `git config --get-regexp` read; `url.<base>.insteadOf` rewrites are applied to remote URLs.
   * Optional so that test doubles and older implementations need not provide it.
   */
  readRemoteConfig?(project: ProjectLocator): Promise<GitRemoteConfig>;

  /**
   * Local facts for the Overview (docs/FORGES.md "Repository information"): default branch head
   * and its ahead/behind against its upstream (local refs only), branch and tag counts, remotes
   * (credentials stripped from URLs) and the latest commit date over all branches. Uses only
   * allowlisted reads. `defaultBranch` is the project's effective default branch; detected when
   * absent. Optional so that test doubles and older implementations need not provide it.
   */
  readRepositoryInfo?(
    project: ProjectLocator,
    options?: { defaultBranch?: string | null },
  ): Promise<GitRepositoryInfo>;

  /**
   * The commit range a worktree has to review (docs/STATUS-FLOW.md §2.1): where it starts and
   * the commits in `base..HEAD`. Uses `rev-parse`, `merge-base` (`--is-ancestor`) and
   * `rev-list` only. Optional so that test doubles and older implementations need not provide it.
   */
  readReviewRange?(worktree: WorktreeLocator, options: ReviewRangeOptions): Promise<ReviewRange>;

  /**
   * Per-commit facts for skipping already-reviewed work (§2.4): `git patch-id --stable` of each
   * commit's diff against its first parent, and the paths it touched. Commits are immutable, so
   * results may be cached. Order follows `shas`; unknown commits reject with `not_found`.
   * Optional (test doubles).
   */
  describeCommits?(worktree: WorktreeLocator, shas: readonly string[]): Promise<CommitDetails[]>;

  /**
   * `git patch-id --stable` of the whole diff `from..to` (a squash merge of that range has the
   * same patch-id); null when the diff is empty. Optional (test doubles).
   */
  rangePatchId?(worktree: WorktreeLocator, from: string, to: string): Promise<string | null>;

  /**
   * What a `branch` scope diffs against, for cache keys (#27): the base ref (`options.base`, else
   * the default branch) and the commit it points at. Read without spawning git where possible
   * (loose ref or `packed-refs`); a git process only for symbolic refs and reftable repositories.
   * Null when the ref does not exist or no default branch is known. For the same worktree state,
   * an equal result means the same branch-scope file list. Optional (test doubles, older
   * implementations): callers then do not cache branch scopes.
   */
  readBranchBase?(
    project: ProjectLocator,
    options?: ScopeOptions & { base?: string },
  ): Promise<BranchBase | null>;

  /**
   * Merge noise (#32): for each file of a review list, whether its change is the worktree's own
   * work, the default branch's (`base`: merged, rebased, updated or identical to it) or both
   * (`mixed`). Reads commits and trees only (name-only `diff-tree` between commits, `merge-base`,
   * `rev-list`), memoized by commit ids; one index-only `diff --cached` while a merge or
   * cherry-pick is in progress; never a working-tree diff for committed content. Optional (test
   * doubles, older implementations): callers then treat every file as `own`.
   */
  readFileOrigins?(worktree: WorktreeLocator, options: FileOriginsOptions): Promise<FileOrigins>;

  /**
   * One blob by full object id, size-capped (live feed, #37): `cat-file -t` must say `blob`, then
   * `cat-file blob`. The id comes from a snapshot entry (`hI` / `hH` of a deleted tracked file, so
   * its last content stays readable after a commit or reset until `git gc`). Rejects with
   * `invalid_argument` for anything but a full object id or an object that is not a blob, and
   * `not_found` for an unknown or collected id. Binary and oversized blobs come back flagged
   * without content. Untracked files have no object id and are never read from here. Optional
   * (test doubles, older implementations).
   */
  readBlob?(worktree: WorktreeLocator, options: BlobReadOptions & CallOptions): Promise<BlobRead>;

  /** Kills in-flight git processes and rejects queued work. */
  dispose(): Promise<void>;
}

export interface SummaryOptions extends ScopeOptions {
  /**
   * Also return the per-file snapshot (`SummaryResult.snapshot`). `true` = the default cap
   * (`SNAPSHOT_MAX_ENTRIES_DEFAULT`); `{ maxEntries }` sets it (1..`SNAPSHOT_MAX_ENTRIES_LIMIT`).
   */
  snapshot?: boolean | { maxEntries?: number };
  /**
   * Paths (worktree-relative, `/`-separated) that may have changed since the previous
   * `getSummary` of this worktree, as a file watcher reported them (#40). git-core may then run
   * `status` / `diff --numstat` limited to them (plus what they depend on) and merge the result
   * into the previous state; the summary means the same as a full refresh would. git-core still
   * refreshes fully whenever it cannot trust the hint (no previous state, HEAD / index / refs /
   * config changed, ignore or attribute files among the paths, directories, submodules, too
   * many paths, ...). Absent: a full refresh. Ignored when `GitCoreOptions.incremental` is false.
   */
  changedPaths?: readonly string[];
  /**
   * Drop git-core's kept state and file lists of this worktree first, then refresh in full (an
   * explicit refresh by the user; PR #89 review). Default false.
   */
  forgetState?: boolean;
}

/** How a summary was computed (#40): diagnostics, tests and the daemon's reconciliation timer. */
export interface SummaryRefresh {
  /** `incremental`: limited to `SummaryOptions.changedPaths` and merged into the last state. */
  mode: 'full' | 'incremental';
  /** Why a refresh with `changedPaths` was full (e.g. `index`, `head`, `directory`); else null. */
  reason: string | null;
  /** Paths passed to the pathspec-limited git calls (0 for a full refresh). */
  pathspecs: number;
}

/**
 * `WorktreeSummary`, plus `snapshot` when `SummaryOptions.snapshot` asked for it, plus `refresh`
 * (git-core always sets it since #40; test doubles may not).
 */
export type SummaryResult = WorktreeSummary & {
  snapshot?: SummarySnapshot;
  refresh?: SummaryRefresh;
};

/** A file to classify: the fields of a listed `GitChangedFile` that `readFileOrigins` reads. */
export type FileOriginInput = Pick<
  GitChangedFile,
  'path' | 'rawPath' | 'oldPath' | 'status' | 'staged' | 'unstaged'
>;

export interface FileOriginsOptions extends ScopeOptions {
  /**
   * `O`: where the list's committed part starts, normally `ReviewRange.base` (a full commit id
   * that HEAD contains). Null: nothing committed is in the list (an unborn branch).
   */
  base: string | null;
  /**
   * The files to classify, as listed (their `staged` / `unstaged` / `status` must come from the
   * same `git status` as the list: `review`, `working` and `branch` + `includeWorking` scopes).
   * Absent: git-core lists `base..HEAD` (committed) and `git status` (uncommitted) itself, at the
   * cost of one `diff-tree` and one `status`.
   */
  files?: readonly FileOriginInput[];
}

/** One file's origin (see `FileOrigin`, `FileOriginVia`). */
export interface FileOriginInfo {
  origin: FileOrigin;
  /** Null for `own`; set for `base` and `mixed`. */
  via: FileOriginVia | null;
}

export interface FileOrigins {
  /**
   * Display name of the default-branch ref base files come from (the newer of the local default
   * branch and `origin/<name>`, the remote when they are equal), e.g. `origin/main`; null when no
   * default branch is known.
   */
  integrationRef: string | null;
  /**
   * `N`: the newest default-branch commit HEAD has absorbed (the branch scope's base, #30). Null
   * when unknown (unborn branch, no default branch, no shared history). The "only this branch's
   * changes" view of a mixed file is the file in the branch scope (against `N`).
   */
  n: string | null;
  /** `TIP`: the newer of the two default-branch refs (commit id); null when no default branch. */
  tip: string | null;
  /**
   * By review-mark path key (`rawPath ?? path`), one entry per input file (with `files`) or per
   * listed file. A file missing from the map is `own`.
   */
  origins: Map<string, FileOriginInfo>;
}

/** The ref a branch scope is measured against (see `GitCore.readBranchBase`). */
export interface BranchBase {
  /** Display name, e.g. `main` or `origin/main`. */
  name: string;
  /** Full ref name, e.g. `refs/heads/main`. */
  ref: string;
  /** The commit (or tag object) the ref points to. */
  oid: string;
  /**
   * The default branch's remote-tracking ref (`origin/<name>`, `refs/remotes/origin/<name>`),
   * when the base is the default branch (not an explicit `base`) and that ref exists. A branch
   * scope is measured against the newest default-branch commit HEAD has absorbed from either ref
   * (#30), so the cache identity of its file list is both commits (`ref`/`oid` and this).
   */
  remote?: { name: string; ref: string; oid: string };
}

export interface ReviewRangeOptions extends ScopeOptions {
  /** The stored bookmark (full commit id), or null on first sight of the branch. */
  bookmark: string | null;
  /** Cap on the commits returned (default 500); `truncated` says when more exist. */
  maxCommits?: number;
}

export interface ReviewRange {
  /** Full HEAD commit id; null on an unborn branch (then everything else is empty/null). */
  head: string | null;
  /** HEAD is the project's default branch, or detached (bookmarks start at HEAD there). */
  startsAtHead: boolean;
  /** `options.bookmark` is HEAD or an ancestor of it. False when it is null or unknown. */
  bookmarkReachable: boolean;
  /**
   * First sight (`options.bookmark` null): where the bookmark should start: HEAD when
   * `startsAtHead`, else the merge-base of HEAD and the default branch (HEAD when there is none).
   * Null otherwise.
   */
  initial: string | null;
  /**
   * Where the range starts: the bookmark when reachable; `initial` on first sight; when history
   * was rewritten (bookmark set but not reachable): the merge-base of HEAD and the default branch
   * for other branches, the merge-base of HEAD and the bookmark when `startsAtHead` (HEAD when
   * none can be computed).
   */
  base: string | null;
  /** `base..HEAD` (`rev-list` order: newest first), with parents. */
  commits: ReviewRangeCommit[];
  /** More than `maxCommits` commits exist in the range. */
  truncated: boolean;
}

export interface ReviewRangeCommit {
  sha: string;
  parents: string[];
}

export interface CommitDetails {
  sha: string;
  /**
   * `git patch-id --stable` of the commit's diff against its first parent (git-core's pinned
   * diff options). Null for merge commits and commits without a textual diff.
   */
  patchId: string | null;
  /**
   * Paths the commit touched, both sides of renames, in review-mark form (`rawPath ?? path`:
   * base64 of the raw bytes when not UTF-8). Merge commits: only the paths that differ from
   * every parent (`--cc`), i.e. conflict resolutions and evil-merge edits.
   */
  paths: string[];
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
   * Max untracked files a summary inspects and a file list returns per worktree (#43, default
   * `UNTRACKED_LISTED_DEFAULT`, 2 000; at least 1). Above it the rest are counted but neither
   * inspected nor listed: `WorktreeSummary.untrackedOmitted` says how many and where.
   */
  maxListedUntracked?: number;
  /**
   * Extra environment for git processes (tests use this to isolate config, e.g.
   * `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`). Safety variables set by the runner always win.
   */
  env?: Record<string, string>;
  logger?: Logger;
  /**
   * Incremental refreshes (#40, default true): `getSummary` honours `SummaryOptions.changedPaths`,
   * and file lists of the scopes that read the worktree are updated from the paths that changed
   * since the last list. False: every summary and list is computed in full (kill switch, bench A/B).
   */
  incremental?: boolean;
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

/**
 * Scheduling lane of a call's git processes (#44). `interactive`: a request the user is waiting
 * on (the open diff, the selected worktree's file list, a blob read); it starts ahead of queued
 * `background` work (summaries, relists, forge and review work), which still gets a turn after a
 * bounded number of interactive starts. Default `background`.
 */
export type GitPriority = 'interactive' | 'background';

/**
 * Per-call controls (#44), accepted by the calls whose options extend this (every `ScopeOptions`
 * call, `listCommits`, `readBlob`). Optional: without them a call behaves as before.
 */
export interface CallOptions {
  /**
   * Cancels the call. The call rejects at once with `GitCoreError` code `aborted`; its git
   * processes that are still queued never start, and running ones are stopped (SIGTERM, then
   * SIGKILL after a short grace). Work the call shares with other callers inside git-core (version
   * probe, repository discovery, config reads, memoized commit facts) is not cancelled by it.
   */
  signal?: AbortSignal;
  /** Lane for the call's git processes (default `background`). */
  priority?: GitPriority;
}

export interface ScopeOptions extends CallOptions {
  /**
   * Default branch used for `branch` scope when `scope.base` is absent, and as the fallback
   * ahead/behind reference when there is no upstream. If null/undefined, git-core detects it.
   */
  defaultBranch?: string | null;
  /**
   * `listChangedFiles` (#40): the `stateHash` of this worktree's latest `getSummary` that the
   * caller holds, meaning "the list for that state". When it is git-core's own latest summary of
   * the worktree, a scope that reads the worktree may be answered by updating git-core's last
   * list for it from the paths whose records changed in the summaries since (one pathspec-limited
   * `git diff`, the summary's status), instead of a full status and diff. Absent: a full list.
   */
  summaryState?: string;
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
