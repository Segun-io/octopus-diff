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
import { EffectiveReviewPolicySchema } from './settings.js';

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

/**
 * What a worktree has to review (docs/STATUS-FLOW.md §2.1), attached by the daemon (git-core
 * never sets it): the commits after the branch's "reviewed up to" bookmark plus the unreviewed
 * uncommitted files. Absent from older daemons.
 */
export const WorktreeReviewSchema = z.object({
  /**
   * The last commit the user reviewed through on this branch (one per project and branch; per
   * worktree when detached). Null on an unborn branch.
   */
  bookmark: CommitShaSchema.nullable(),
  /**
   * Where the "To review" diff starts: the bookmark, or, when history was rewritten, the
   * fallback (merge-base with the default branch). Null on an unborn branch.
   */
  base: CommitShaSchema.nullable(),
  /** Commits after `base` that are not reviewed (by commit id or patch-id) and bring changes. */
  newCommits: Count,
  /** Files of the "To review" diff (`scope=review`) that are not reviewed. */
  unreviewedFiles: Count,
  /** The bookmark is not an ancestor of HEAD (rebase, reset, force-push). */
  historyRewritten: z.boolean(),
});
export type WorktreeReview = z.infer<typeof WorktreeReviewSchema>;

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
  /**
   * When the worktree last saw activity: the newest of HEAD's reflog (commit, checkout, reset,
   * pull), the HEAD commit's committer date when there is no reflog, and the mtime of any file
   * with uncommitted changes. Unlike `updatedAt` (the poll time) it does not move when nothing
   * happened. The sidebar sorts worktrees by it, newest first. Null when unknown (unborn
   * branch without reflog); absent from older daemons.
   */
  activityAt: TimestampSchema.nullable().optional(),
  /**
   * Review state (daemon app state, docs/STATUS-FLOW.md). Not part of `stateHash`, which stays a
   * hash of git state only. Absent until the daemon computed it (#10): it does so on demand
   * (the project was opened, a request needed it, or the worktree changed after startup), not
   * for every repository at startup; `review.ready` says when it lands. Older daemons never
   * send it. Without it a client shows the worktree's changes, not a review stage.
   */
  review: WorktreeReviewSchema.optional(),
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
  /**
   * App state: a review mark exists for (projectId, path, patchHash) (marks no longer depend on
   * the scope kind, docs/STATUS-FLOW.md §2.4), or, in the `review` scope, every commit that
   * touched the file is already reviewed and it has no uncommitted change.
   */
  reviewed: z.boolean(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

/** Bounded raster preview; SVG/HTML are never embedded. */
export const ImagePreviewSchema = z.object({
  mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']),
  base64: z.string().max(14_000_000),
  byteLength: Count,
});
export const ImageComparisonSchema = z.object({
  before: ImagePreviewSchema.nullable(),
  after: ImagePreviewSchema.nullable(),
  warning: z.string().optional(),
});

/** One file's diff as produced by git-core. */
export const GitFileDiffSchema = z.object({
  ...fileIdentityShape,
  images: ImageComparisonSchema.optional(),
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
  /**
   * Resolved review policy (settings.ts). Always sent by current daemons; absent means "enabled"
   * (older daemons), so clients must treat `undefined` as `{ enabled: true, source: 'default' }`.
   */
  review: EffectiveReviewPolicySchema.optional(),
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
  /** Same meaning as `WorktreeListItem.review`; absent = enabled. */
  review: EffectiveReviewPolicySchema.optional(),
});
export type InboxEntry = z.infer<typeof InboxEntrySchema>;

// --- repository information (Overview; docs/FORGES.md "Repository information") ------------

/** Cap on `GitRepositoryInfo.branches`. */
export const MAX_LISTED_BRANCHES = 500;

/** One local branch (`refs/heads/*`) of `GitRepositoryInfo.branches`; local refs only. */
export const GitBranchInfoSchema = z.object({
  name: z.string().min(1),
  /** The commit the branch points at. */
  sha: CommitShaSchema,
  subject: z.string(),
  /** Committer date of that commit (when the branch last moved, as far as git records it). */
  committerDate: TimestampSchema.nullable(),
  /** Short upstream name (`origin/feat`), or null. */
  upstream: z.string().nullable(),
  /** The configured upstream ref no longer exists (deleted on the remote and pruned). */
  upstreamGone: z.boolean(),
  /** Against the upstream, as of the last fetch; null without an upstream or when it is gone. */
  ahead: z.number().int().min(0).nullable(),
  behind: z.number().int().min(0).nullable(),
  /** Reachable from the default branch (merged into it); null when there is no default branch. */
  merged: z.boolean().nullable(),
});
export type GitBranchInfo = z.infer<typeof GitBranchInfoSchema>;

/** Local git facts about a project, from `GitCore.readRepositoryInfo` (local refs only). */
export const GitRepositoryInfoSchema = z.object({
  defaultBranch: z
    .object({
      name: z.string().min(1),
      head: z
        .object({
          sha: CommitShaSchema,
          subject: z.string(),
          authorName: z.string(),
          authorDate: TimestampSchema,
        })
        .nullable(),
      /** Short upstream name (`origin/main`), or null. */
      upstream: z.string().nullable(),
      /** Against the upstream, as of the last fetch (octopus-diff never fetches). */
      ahead: z.number().int().min(0).nullable(),
      behind: z.number().int().min(0).nullable(),
    })
    .nullable(),
  localBranches: z.number().int().min(0),
  tags: z.number().int().min(0),
  /** URLs with any `user:password@` removed. */
  remotes: z.array(
    z.object({
      name: z.string().min(1),
      url: z.string().nullable(),
      pushUrl: z.string().nullable(),
    }),
  ),
  /** Latest committer date over local branches, or null. */
  lastActivityAt: TimestampSchema.nullable(),
  /**
   * Local branches, newest commit first, at most `MAX_LISTED_BRANCHES` (`localBranches` is the
   * full count). The Overview lists the ones no worktree has checked out. Optional: older daemons
   * and test doubles omit it.
   */
  branches: z.array(GitBranchInfoSchema).optional(),
});
export type GitRepositoryInfo = z.infer<typeof GitRepositoryInfoSchema>;
