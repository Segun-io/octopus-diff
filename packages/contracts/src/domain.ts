import { z } from 'zod';
import {
  AbsolutePathSchema,
  ApiErrorBodySchema,
  CommitShaSchema,
  FileModeSchema,
  IdSchema,
  RawPathSchema,
  RefNameSchema,
  RepoPathSchema,
  TimestampSchema,
} from './common.js';

const Count = z.number().int().min(0);

// ---------------------------------------------------------------------------------------------
// Projects and worktrees
// ---------------------------------------------------------------------------------------------

/** What git-core knows about a repository. The daemon adds app state to build a `Project`. */
export const GitProjectInfoSchema = z.object({
  id: IdSchema,
  /** Display name: basename of the main worktree, or of the common dir minus `.git`. */
  name: z.string().min(1),
  /** Realpath of the common git dir (`git rev-parse --git-common-dir`). */
  commonDir: AbsolutePathSchema,
  /** Realpath of the main worktree; null for bare repositories. */
  mainWorktreePath: AbsolutePathSchema.nullable(),
  bare: z.boolean(),
  /** Auto-detected default branch short name (origin/HEAD, then main/master/trunk), or null. */
  detectedDefaultBranch: RefNameSchema.nullable(),
});
export type GitProjectInfo = z.infer<typeof GitProjectInfoSchema>;

/** A registered repository, identified by its common git dir. */
export const ProjectSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  commonDir: AbsolutePathSchema,
  mainWorktreePath: AbsolutePathSchema.nullable(),
  bare: z.boolean(),
  /** Effective default branch: `defaultBranchOverride ?? detectedDefaultBranch`. */
  defaultBranch: RefNameSchema.nullable(),
  /** User override (app state, set via PATCH /api/projects/:id). */
  defaultBranchOverride: RefNameSchema.nullable(),
  /** Scan root that discovered this project, or null if added explicitly. */
  scanRootId: IdSchema.nullable(),
  addedAt: TimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

/** Main checkout or linked worktree of a project (from `git worktree list --porcelain`). */
export const WorktreeSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  /** Realpath of the worktree root (for a bare repo entry: the git dir). */
  path: AbsolutePathSchema,
  /** Short branch name (`feature/x`, not `refs/heads/feature/x`); null when detached or bare. */
  branch: z.string().min(1).nullable(),
  /** Full HEAD commit id; null for an unborn branch (no commits yet). */
  headSha: CommitShaSchema.nullable(),
  detached: z.boolean(),
  isMain: z.boolean(),
  bare: z.boolean(),
  locked: z.boolean(),
  prunable: z.boolean(),
  /**
   * The worktree path no longer exists on disk, or is not a valid worktree of this project (its
   * `.git` does not link back to the admin dir; forged records are reported this way).
   */
  missing: z.boolean(),
});
export type Worktree = z.infer<typeof WorktreeSchema>;

export const InProgressOperationSchema = z.enum([
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'bisect',
  'am',
]);
export type InProgressOperation = z.infer<typeof InProgressOperationSchema>;

export const ChangeCountsSchema = z.object({
  staged: Count,
  unstaged: Count,
  untracked: Count,
  conflicted: Count,
});
export type ChangeCounts = z.infer<typeof ChangeCountsSchema>;

/** Cheap per-worktree status, computed from `git status --porcelain=v2 -z --branch` + numstat. */
export const WorktreeSummarySchema = z.object({
  worktreeId: IdSchema,
  projectId: IdSchema,
  branch: z.string().min(1).nullable(),
  headSha: CommitShaSchema.nullable(),
  detached: z.boolean(),
  /** Upstream tracking ref (e.g. `origin/main`), or null. Local refs only: never fetched. */
  upstream: z.string().min(1).nullable(),
  /**
   * Ref that ahead/behind is measured against: the upstream if set, otherwise the project's
   * default branch (if it differs from the current branch). Null when neither applies.
   */
  aheadBehindRef: z.string().min(1).nullable(),
  ahead: Count.nullable(),
  behind: Count.nullable(),
  counts: ChangeCountsSchema,
  /** Distinct paths changed in the `working` scope (tracked changes + untracked files). */
  changedFiles: Count,
  /** Line totals for the `working` scope. Untracked files count when under git-core's caps. */
  additions: Count,
  deletions: Count,
  inProgress: InProgressOperationSchema.nullable(),
  /**
   * Opaque hash that changes whenever HEAD, the branch, ahead/behind, any changed file, or any
   * file's patch changes. Equal hashes mean "nothing to refetch".
   */
  stateHash: z.string().min(1),
  updatedAt: TimestampSchema,
});
export type WorktreeSummary = z.infer<typeof WorktreeSummarySchema>;

/** True if the worktree has any change in the `working` scope. */
export function isDirty(summary: Pick<WorktreeSummary, 'changedFiles'>): boolean {
  return summary.changedFiles > 0;
}

// ---------------------------------------------------------------------------------------------
// Files and diffs
// ---------------------------------------------------------------------------------------------

export const FILE_STATUSES = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'typechange',
  'untracked',
  'conflicted',
] as const;
export const FileStatusSchema = z.enum(FILE_STATUSES);
export type FileStatus = z.infer<typeof FileStatusSchema>;

const fileIdentityShape = {
  /** Repo-relative display path (UTF-8; lossy with U+FFFD if `rawPath` is present). */
  path: RepoPathSchema,
  /** Base64 of the raw path bytes, present only when the path is not valid UTF-8. */
  rawPath: RawPathSchema.optional(),
  /** Previous path for renames and copies, else null. */
  oldPath: RepoPathSchema.nullable(),
  status: FileStatusSchema,
  binary: z.boolean(),
  /** Git modes; 120000 = symlink, 160000 = submodule (gitlink). Null when the side is absent. */
  oldMode: FileModeSchema.nullable(),
  newMode: FileModeSchema.nullable(),
  /** Line counts; null for binary files or when not computed (over caps). */
  additions: Count.nullable(),
  deletions: Count.nullable(),
  /**
   * Hash of this file's canonical patch text in this scope (whitespace-sensitive, default
   * context). Stable for identical patches. Review marks are keyed by it, so the same file in
   * the same state must always produce the same patchHash across listChangedFiles/getFileDiff.
   */
  patchHash: z.string().min(1),
};

/** A changed file as reported by git-core (no app state). */
export const GitChangedFileSchema = z.object({
  ...fileIdentityShape,
  /** Has index changes (for scopes where that is meaningful; false otherwise). */
  staged: z.boolean(),
  /** Has working-tree changes (for scopes where that is meaningful; false otherwise). */
  unstaged: z.boolean(),
});
export type GitChangedFile = z.infer<typeof GitChangedFileSchema>;

export const ChangedFileSchema = GitChangedFileSchema.extend({
  /** App state: a review mark exists for (projectId, scopeKind, path, patchHash). */
  reviewed: z.boolean(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

/** One file's diff as produced by git-core. */
export const GitFileDiffSchema = z.object({
  ...fileIdentityShape,
  /**
   * Raw unified diff for this one file (`diff --git` header included), possibly produced with
   * `-w` or a custom context when requested. Empty when `tooLarge` or for a binary file.
   */
  patch: z.string(),
  /** Patch omitted because it exceeds the soft size limit; request again with `full=true`. */
  tooLarge: z.boolean(),
  /** Patch text was cut at the hard output cap. */
  truncated: z.boolean(),
  /** Size in bytes of the full canonical patch, when known. */
  byteLength: Count.nullable(),
});
export type GitFileDiff = z.infer<typeof GitFileDiffSchema>;

export const FileDiffSchema = GitFileDiffSchema.extend({ reviewed: z.boolean() });
export type FileDiff = z.infer<typeof FileDiffSchema>;

/** Identifies one file within a scope. `rawPath` wins over `path` when present. */
export const FileSelectorSchema = z.object({
  path: RepoPathSchema,
  rawPath: RawPathSchema.optional(),
});
export type FileSelector = z.infer<typeof FileSelectorSchema>;

// ---------------------------------------------------------------------------------------------
// Commits and scan roots
// ---------------------------------------------------------------------------------------------

export const CommitInfoSchema = z.object({
  sha: CommitShaSchema,
  shortSha: z.string().min(4),
  parents: z.array(CommitShaSchema),
  subject: z.string(),
  authorName: z.string(),
  authorEmail: z.string(),
  authorDate: TimestampSchema,
  committerDate: TimestampSchema,
});
export type CommitInfo = z.infer<typeof CommitInfoSchema>;

export const SCAN_DEPTH_DEFAULT = 3;
export const SCAN_DEPTH_MAX = 8;
export const ScanDepthSchema = z.number().int().min(0).max(SCAN_DEPTH_MAX);

/** A directory scanned to depth N for repositories. */
export const ScanRootSchema = z.object({
  id: IdSchema,
  path: AbsolutePathSchema,
  depth: ScanDepthSchema,
  addedAt: TimestampSchema,
  lastScannedAt: TimestampSchema.nullable(),
  /** Number of registered projects discovered through this scan root. */
  projectCount: Count,
});
export type ScanRoot = z.infer<typeof ScanRootSchema>;

// ---------------------------------------------------------------------------------------------
// Composite views
// ---------------------------------------------------------------------------------------------

export const WorktreeListItemSchema = z.object({
  worktree: WorktreeSchema,
  /** Null until the first summary is computed, or when computing it failed (see `error`). */
  summary: WorktreeSummarySchema.nullable(),
  error: ApiErrorBodySchema.shape.error.nullable(),
});
export type WorktreeListItem = z.infer<typeof WorktreeListItemSchema>;

export const ProjectListItemSchema = z.object({
  project: ProjectSchema,
  worktrees: z.array(WorktreeListItemSchema),
});
export type ProjectListItem = z.infer<typeof ProjectListItemSchema>;

/** One dirty worktree in the cross-project inbox. */
export const InboxEntrySchema = z.object({
  project: ProjectSchema,
  worktree: WorktreeSchema,
  summary: WorktreeSummarySchema,
  files: z.array(ChangedFileSchema),
});
export type InboxEntry = z.infer<typeof InboxEntrySchema>;
