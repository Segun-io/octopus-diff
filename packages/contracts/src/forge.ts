import { z } from 'zod';
import { CommitShaSchema, IdSchema, TimestampSchema } from './common.js';

/**
 * Forge integration (docs/FORGES.md): pull requests (GitHub, via `gh`) and merge requests
 * (GitLab, via `glab`) for the branches of registered worktrees. Read-only: the daemon only runs
 * the forge CLIs' query commands, uses the logins those CLIs already hold, and never reads,
 * stores or sends a token itself.
 */

export const FORGE_KINDS = ['github', 'gitlab'] as const;
export const ForgeKindSchema = z.enum(FORGE_KINDS);
export type ForgeKind = z.infer<typeof ForgeKindSchema>;

/**
 * A bare hostname, optionally with a port (`github.com`, `gitlab.example.com:8443`), lower case.
 * Anything else could redirect a CLI's credentials, so hosts are always validated against this.
 */
export const ForgeHostSchema = z
  .string()
  .max(253)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/,
    'expected a lower-case hostname',
  );

/** Repository path on its forge: `owner/name` on GitHub, `group/sub/project` on GitLab. */
export const ForgeRepositoryPathSchema = z
  .string()
  .max(1024)
  .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/, 'expected owner/name')
  .refine((p) => p.split('/').every((s) => s !== '.' && s !== '..'), 'invalid path segment');

// ---------------------------------------------------------------------------------------------
// Settings (AppSettings.forges)
// ---------------------------------------------------------------------------------------------

/** What a host override says: treat the host as GitHub or GitLab, or never query it. */
export const ForgeHostOverrideSchema = z.enum(['github', 'gitlab', 'none']);
export type ForgeHostOverride = z.infer<typeof ForgeHostOverrideSchema>;

export const ForgeSettingsSchema = z.object({
  /**
   * Query the forges at all. Default true: nothing is queried unless a forge CLI is installed and
   * signed in to the remote's host, and only for projects with a non-default branch checked out.
   */
  enabled: z.boolean(),
  /**
   * Per-host overrides, keyed by hostname, for hosts the automatic detection gets wrong (a
   * self-hosted GitLab whose name says nothing and that `glab` is not signed in to) or that must
   * never be queried (`none`).
   */
  hosts: z.record(ForgeHostSchema, ForgeHostOverrideSchema),
  /**
   * Load images (avatars, pictures in descriptions and comments) from the forge hosts the CLIs
   * are signed in to. Relaxes the UI's Content-Security-Policy `img-src` to those hosts.
   * Effective default true; false restores the strict policy.
   */
  images: z.boolean().optional(),
});
export type ForgeSettings = z.infer<typeof ForgeSettingsSchema>;

export const DEFAULT_FORGE_SETTINGS: ForgeSettings = { enabled: true, hosts: {} };

/** Partial update of `ForgeSettings`. `hosts` replaces the whole map when present. */
export const ForgeSettingsPatchSchema = ForgeSettingsSchema.partial();
export type ForgeSettingsPatch = z.infer<typeof ForgeSettingsPatchSchema>;

// ---------------------------------------------------------------------------------------------
// CLI discovery
// ---------------------------------------------------------------------------------------------

export const ForgeAuthStatusSchema = z.enum(['authenticated', 'unauthenticated', 'unknown']);
export type ForgeAuthStatus = z.infer<typeof ForgeAuthStatusSchema>;

/** One host a forge CLI reports a login for. */
export const ForgeCliAccountSchema = z.object({
  host: ForgeHostSchema,
  /** Login name; null when the CLI did not say. */
  account: z.string().nullable(),
});
export type ForgeCliAccount = z.infer<typeof ForgeCliAccountSchema>;

/** `gh` / `glab` as found on the daemon's PATH. */
export const ForgeCliStatusSchema = z.object({
  kind: ForgeKindSchema,
  /** `gh` or `glab`. */
  executable: z.string().min(1),
  available: z.boolean(),
  /** First line of `--version`, when available. */
  version: z.string().nullable(),
  auth: ForgeAuthStatusSchema,
  /** Hosts the CLI is signed in to. Only these hosts are ever queried. */
  accounts: z.array(ForgeCliAccountSchema),
  /** How to install or sign in, shown when the CLI is missing or signed out. */
  hint: z.string(),
  /** Short diagnostic (never a token), or null. */
  detail: z.string().nullable(),
  checkedAt: TimestampSchema,
});
export type ForgeCliStatus = z.infer<typeof ForgeCliStatusSchema>;

// ---------------------------------------------------------------------------------------------
// Projects and change requests
// ---------------------------------------------------------------------------------------------

/** How the forge of a project's remote was recognised. */
export const ForgeDetectionSchema = z.enum([
  /** The hostname says so (`github.com`, `*.ghe.com`, a `gitlab` label, ...). */
  'hostname',
  /** The hostname says nothing, but `gh` or `glab` is signed in to it. */
  'cli-login',
  /** `AppSettings.forges.hosts`. */
  'setting',
]);
export type ForgeDetection = z.infer<typeof ForgeDetectionSchema>;

/** The forge repository a project's pull/merge requests live in. */
export const ProjectForgeSchema = z.object({
  kind: ForgeKindSchema,
  host: ForgeHostSchema,
  /** Where requests are opened against (the upstream for forks). */
  repository: ForgeRepositoryPathSchema,
  /** Web page of `repository`. */
  webUrl: z.url(),
  /** The git remote `repository` came from. */
  remoteName: z.string().min(1),
  detectedBy: ForgeDetectionSchema,
});
export type ProjectForge = z.infer<typeof ProjectForgeSchema>;

export const ChangeRequestStateSchema = z.enum(['open', 'merged', 'closed']);
export type ChangeRequestState = z.infer<typeof ChangeRequestStateSchema>;

/** Combined CI state of the request's head commit. */
export const ChecksStateSchema = z.enum(['success', 'failure', 'pending', 'neutral']);
export type ChecksState = z.infer<typeof ChecksStateSchema>;

export const ChangeRequestChecksSchema = z.object({
  state: ChecksStateSchema,
  /** Counts, when the forge reports them (GitHub); null otherwise (GitLab reports one pipeline). */
  passed: z.number().int().min(0).nullable(),
  failed: z.number().int().min(0).nullable(),
  pending: z.number().int().min(0).nullable(),
  total: z.number().int().min(0).nullable(),
});
export type ChangeRequestChecks = z.infer<typeof ChangeRequestChecksSchema>;

export const ChangeRequestReviewSchema = z.enum([
  'approved',
  'changes_requested',
  'review_required',
]);
export type ChangeRequestReview = z.infer<typeof ChangeRequestReviewSchema>;

/**
 * Mergeability of an open request, as the forge computes it. GitHub `mergeStateStatus`,
 * GitLab `detailedMergeStatus`, mapped to one vocabulary.
 */
export const MERGE_STATES = [
  'clean',
  'blocked',
  'behind',
  'conflicts',
  'unstable',
  'draft',
  'unknown',
] as const;
export const MergeStateSchema = z.enum(MERGE_STATES);
export type MergeState = z.infer<typeof MergeStateSchema>;

/** A GitHub pull request or GitLab merge request, normalised. */
export const ChangeRequestSchema = z.object({
  kind: ForgeKindSchema,
  /** PR number / MR iid. */
  number: z.number().int().min(1),
  title: z.string(),
  url: z.url(),
  state: ChangeRequestStateSchema,
  draft: z.boolean(),
  author: z.string().nullable(),
  /** Target branch (`main`). */
  baseBranch: z.string().min(1),
  /** Source branch on the head repository. */
  headBranch: z.string().min(1),
  /** The request's current head commit, when reported. */
  headSha: CommitShaSchema.nullable(),
  /** Opened from a fork (another repository than `ProjectForge.repository`). */
  crossRepository: z.boolean(),
  /** `owner/name` (GitHub) or full path (GitLab) of the head repository, when known. */
  headRepository: z.string().nullable(),
  updatedAt: TimestampSchema.nullable(),
  /** Null when the forge reports no CI for the head commit. */
  checks: ChangeRequestChecksSchema.nullable(),
  /** Null when no review is required or the forge did not say. */
  review: ChangeRequestReviewSchema.nullable(),
  /** True when the request has merge conflicts; null when unknown (still being computed). */
  conflicts: z.boolean().nullable(),
  /** Comment count (GitHub: comments + review comments; GitLab: user notes), when reported. */
  comments: z.number().int().min(0).nullable(),
  // --- added with the Request tab (optional: older daemons do not send them) ---
  createdAt: TimestampSchema.nullable().optional(),
  additions: z.number().int().min(0).nullable().optional(),
  deletions: z.number().int().min(0).nullable().optional(),
  changedFiles: z.number().int().min(0).nullable().optional(),
  mergeState: MergeStateSchema.nullable().optional(),
});
export type ChangeRequest = z.infer<typeof ChangeRequestSchema>;

/**
 * The request's head commit compared with the worktree's HEAD: `same`, `differs` (local commits
 * not pushed, or pushed commits not pulled; local refs only, nothing is fetched), `unknown`.
 */
export const ChangeRequestSyncSchema = z.enum(['same', 'differs', 'unknown']);
export type ChangeRequestSync = z.infer<typeof ChangeRequestSyncSchema>;

export const WorktreeForgeSchema = z.object({
  worktreeId: IdSchema,
  /** The branch the request was matched on (the upstream branch name when it has one). */
  branch: z.string().min(1),
  /** The best match: an open request first, else the most recently updated merged/closed one. */
  changeRequest: ChangeRequestSchema.nullable(),
  sync: ChangeRequestSyncSchema,
});
export type WorktreeForge = z.infer<typeof WorktreeForgeSchema>;

export const ProjectForgeStatusSchema = z.enum([
  /** Requests were fetched (`fetchedAt`). */
  'ok',
  /** Not fetched yet, or a fetch is running. */
  'pending',
  /** `forges.enabled` is false. */
  'disabled',
  /** No remote, or no remote on a recognised forge. */
  'no-forge',
  /** A host override says `none`. */
  'ignored',
  /** Only the default branch (or detached HEADs) are checked out: nothing to look up. */
  'idle',
  /** The forge's CLI is not installed. */
  'cli-missing',
  /** The CLI is not signed in to the remote's host. */
  'unauthenticated',
  /** The last fetch failed (`message`); older results, if any, are kept. */
  'error',
]);
export type ProjectForgeStatus = z.infer<typeof ProjectForgeStatusSchema>;

export const ProjectForgeStateSchema = z.object({
  projectId: IdSchema,
  forge: ProjectForgeSchema.nullable(),
  status: ProjectForgeStatusSchema,
  /** Human-readable reason for non-`ok` statuses, or null. */
  message: z.string().nullable(),
  /** One entry per worktree that has a non-default branch checked out. */
  worktrees: z.array(WorktreeForgeSchema),
  /** When the requests were last fetched successfully. */
  fetchedAt: TimestampSchema.nullable(),
});
export type ProjectForgeState = z.infer<typeof ProjectForgeStateSchema>;

/** `GET /api/forges` and `POST /api/forges/refresh`. */
export const ForgesResponseSchema = z.object({
  enabled: z.boolean(),
  clis: z.array(ForgeCliStatusSchema),
  projects: z.array(ProjectForgeStateSchema),
  generatedAt: TimestampSchema,
});
export type ForgesResponse = z.infer<typeof ForgesResponseSchema>;

/** `POST /api/forges/refresh`: re-probe the CLIs and refetch (all projects, or the listed ones). */
export const RefreshForgesRequestSchema = z.object({
  projectIds: z.array(IdSchema).max(1000).optional(),
});
export type RefreshForgesRequest = z.infer<typeof RefreshForgesRequestSchema>;

/** Minimum time between two fetches of the same project, whatever triggers them. */
export const FORGE_MIN_REFETCH_MS = 15_000;
/** Background refresh interval while forges are enabled. */
export const FORGE_POLL_INTERVAL_MS = 120_000;

/** Labels for a forge's requests: "PR" / "pull request", "MR" / "merge request". */
export function changeRequestNoun(kind: ForgeKind): { short: string; long: string } {
  return kind === 'github'
    ? { short: 'PR', long: 'pull request' }
    : { short: 'MR', long: 'merge request' };
}

// ---------------------------------------------------------------------------------------------
// Request detail, conversation and repository information (docs/FORGES.md "Request tab",
// DECISIONS #71-). All read-only, fetched on demand through the same CLIs and allowlist.
// ---------------------------------------------------------------------------------------------

/** A forge account (user, bot or app). */
export const ForgeActorSchema = z.object({
  login: z.string().min(1).max(256),
  name: z.string().max(256).nullable(),
  /** https only; the UI shows it only when the host is in `imageHosts`. */
  avatarUrl: z.url().nullable(),
  bot: z.boolean(),
});
export type ForgeActor = z.infer<typeof ForgeActorSchema>;

export const ChangeRequestLabelSchema = z.object({
  name: z.string().min(1).max(256),
  /** Six hex digits without `#`, or null. */
  color: z
    .string()
    .regex(/^[0-9a-f]{6}$/)
    .nullable(),
});
export type ChangeRequestLabel = z.infer<typeof ChangeRequestLabelSchema>;

export const REVIEWER_STATES = [
  'approved',
  'changes_requested',
  'commented',
  'dismissed',
  /** Requested, not reviewed yet. */
  'pending',
] as const;
export const ReviewerStateSchema = z.enum(REVIEWER_STATES);
export type ReviewerState = z.infer<typeof ReviewerStateSchema>;

export const ChangeRequestReviewerSchema = z.object({
  actor: ForgeActorSchema,
  state: ReviewerStateSchema,
  /** The verdict was given on an older commit than the request's head. */
  stale: z.boolean(),
});
export type ChangeRequestReviewer = z.infer<typeof ChangeRequestReviewerSchema>;

export const CHECK_STATUSES = [
  'success',
  'failure',
  'pending',
  'cancelled',
  'skipped',
  'neutral',
  'action_required',
] as const;
export const CheckStatusSchema = z.enum(CHECK_STATUSES);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const ChangeRequestCheckSchema = z.object({
  name: z.string().min(1).max(512),
  /** Workflow (GitHub Actions) or stage (GitLab), when known. */
  group: z.string().max(512).nullable(),
  status: CheckStatusSchema,
  description: z.string().max(2048).nullable(),
  /** https only. */
  url: z.url().nullable(),
});
export type ChangeRequestCheck = z.infer<typeof ChangeRequestCheckSchema>;

export const ChangeRequestCommitSchema = z.object({
  sha: CommitShaSchema,
  headline: z.string(),
  committedAt: TimestampSchema.nullable(),
  authorName: z.string().nullable(),
  authorLogin: z.string().nullable(),
});
export type ChangeRequestCommit = z.infer<typeof ChangeRequestCommitSchema>;

export const ChangeRequestFileChangeSchema = z.enum([
  'added',
  'modified',
  'removed',
  'renamed',
  'copied',
  /** The forge does not say (GitLab diff stats). */
  'changed',
]);
export type ChangeRequestFileChange = z.infer<typeof ChangeRequestFileChangeSchema>;

export const ChangeRequestFileSchema = z.object({
  path: z.string().min(1).max(4096),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  change: ChangeRequestFileChangeSchema,
});
export type ChangeRequestFile = z.infer<typeof ChangeRequestFileSchema>;

/** Caps applied by the daemon (first page only; the UI links to the forge for the rest). */
export const CHANGE_REQUEST_LIMITS = {
  bodyBytes: 64 * 1024,
  commentBodyBytes: 20 * 1024,
  commits: 100,
  files: 100,
  checks: 100,
  comments: 50,
  reviews: 50,
  threads: 50,
  threadComments: 10,
  repositoryRequests: 20,
  topics: 8,
} as const;

/** Everything the Request tab's Summary, Checks, Commits and Files need, from one query. */
export const ChangeRequestDetailSchema = ChangeRequestSchema.extend({
  /** Markdown, capped at `CHANGE_REQUEST_LIMITS.bodyBytes`. */
  body: z.string(),
  bodyTruncated: z.boolean(),
  mergedAt: TimestampSchema.nullable(),
  closedAt: TimestampSchema.nullable(),
  mergedBy: ForgeActorSchema.nullable(),
  /** The author as an actor (avatar, bot flag), when reported. */
  authorActor: ForgeActorSchema.nullable().optional(),
  labels: z.array(ChangeRequestLabelSchema),
  assignees: z.array(ForgeActorSchema),
  reviewers: z.array(ChangeRequestReviewerSchema),
  /** Individual checks (`checkList`, not `checks`: that name is the summary on `ChangeRequest`). */
  checkList: z.array(ChangeRequestCheckSchema),
  checksTruncated: z.boolean(),
  /** Oldest first; the newest `CHANGE_REQUEST_LIMITS.commits`. */
  commits: z.array(ChangeRequestCommitSchema),
  commitsTotal: z.number().int().min(0),
  files: z.array(ChangeRequestFileSchema),
  filesTotal: z.number().int().min(0),
});
export type ChangeRequestDetail = z.infer<typeof ChangeRequestDetailSchema>;

export const ChangeRequestCommentSchema = z.object({
  id: z.string().min(1).max(256),
  author: ForgeActorSchema.nullable(),
  body: z.string(),
  bodyTruncated: z.boolean(),
  createdAt: TimestampSchema.nullable(),
  editedAt: TimestampSchema.nullable(),
  url: z.url().nullable(),
});
export type ChangeRequestComment = z.infer<typeof ChangeRequestCommentSchema>;

export const ChangeRequestReviewEntrySchema = ChangeRequestCommentSchema.extend({
  state: ReviewerStateSchema,
});
export type ChangeRequestReviewEntry = z.infer<typeof ChangeRequestReviewEntrySchema>;

export const ChangeRequestThreadSchema = z.object({
  id: z.string().min(1).max(256),
  path: z.string().max(4096),
  line: z.number().int().min(0).nullable(),
  side: z.enum(['left', 'right']),
  resolved: z.boolean(),
  outdated: z.boolean(),
  comments: z.array(ChangeRequestCommentSchema),
  commentsTotal: z.number().int().min(0),
});
export type ChangeRequestThread = z.infer<typeof ChangeRequestThreadSchema>;

export const ChangeRequestConversationSchema = z.object({
  /** Top-level comments, oldest first; hidden (minimised) and system comments are dropped. */
  comments: z.array(ChangeRequestCommentSchema),
  /** Reviews with a verdict or a body, oldest first. */
  reviews: z.array(ChangeRequestReviewEntrySchema),
  /** Review threads on lines, oldest first. */
  threads: z.array(ChangeRequestThreadSchema),
  commentsTotal: z.number().int().min(0),
  reviewsTotal: z.number().int().min(0),
  threadsTotal: z.number().int().min(0),
  /** Only the first page was loaded (or a thread lost replies): open it on the forge. */
  truncated: z.boolean(),
});
export type ChangeRequestConversation = z.infer<typeof ChangeRequestConversationSchema>;

export const ChangeRequestDetailStatusSchema = z.enum([
  'ok',
  /** The worktree has no matched request (or forges are off): nothing to show. */
  'no-request',
  /** The forge could not be asked (CLI missing, signed out, fetch failed): `message`. */
  'unavailable',
]);
export type ChangeRequestDetailStatus = z.infer<typeof ChangeRequestDetailStatusSchema>;

/** `GET /api/forges/worktrees/:worktreeId/request`. */
export const ChangeRequestDetailResponseSchema = z.object({
  worktreeId: IdSchema,
  status: ChangeRequestDetailStatusSchema,
  message: z.string().nullable(),
  request: ChangeRequestDetailSchema.nullable(),
  fetchedAt: TimestampSchema.nullable(),
  /**
   * Hosts the UI's Content-Security-Policy allows images from (empty when `forges.images` is
   * off). The UI renders `<img>` only for https URLs on these hosts.
   */
  imageHosts: z.array(z.string().max(300)),
});
export type ChangeRequestDetailResponse = z.infer<typeof ChangeRequestDetailResponseSchema>;

/** `GET /api/forges/worktrees/:worktreeId/request/conversation`. */
export const ChangeRequestConversationResponseSchema = z.object({
  worktreeId: IdSchema,
  status: ChangeRequestDetailStatusSchema,
  message: z.string().nullable(),
  conversation: ChangeRequestConversationSchema.nullable(),
  fetchedAt: TimestampSchema.nullable(),
  imageHosts: z.array(z.string().max(300)),
});
export type ChangeRequestConversationResponse = z.infer<
  typeof ChangeRequestConversationResponseSchema
>;

export const ForgeVisibilitySchema = z.enum(['public', 'private', 'internal']);
export type ForgeVisibility = z.infer<typeof ForgeVisibilitySchema>;

/** One open request of a repository (the Overview's "Open pull requests"). */
export const ForgeRepositoryRequestSchema = z.object({
  number: z.number().int().min(1),
  title: z.string(),
  url: z.url(),
  draft: z.boolean(),
  author: z.string().nullable(),
  headBranch: z.string().min(1),
  baseBranch: z.string().min(1),
  crossRepository: z.boolean(),
  updatedAt: TimestampSchema.nullable(),
  checks: ChecksStateSchema.nullable(),
  review: ChangeRequestReviewSchema.nullable(),
  /** The local worktree this request is matched to, joined by the daemon. */
  worktreeId: IdSchema.nullable(),
});
export type ForgeRepositoryRequest = z.infer<typeof ForgeRepositoryRequestSchema>;

/** Forge facts about a project's repository (`GET /api/forges/projects/:projectId/repository`). */
export const ForgeRepositoryInfoSchema = z.object({
  kind: ForgeKindSchema,
  host: ForgeHostSchema,
  repository: ForgeRepositoryPathSchema,
  webUrl: z.url(),
  description: z.string().max(4096).nullable(),
  visibility: ForgeVisibilitySchema.nullable(),
  archived: z.boolean(),
  forkOf: z.string().max(1024).nullable(),
  defaultBranch: z.string().nullable(),
  defaultBranchHead: z
    .object({
      sha: CommitShaSchema,
      headline: z.string(),
      committedAt: TimestampSchema.nullable(),
      checks: ChecksStateSchema.nullable(),
    })
    .nullable(),
  license: z.string().max(256).nullable(),
  language: z.string().max(256).nullable(),
  topics: z.array(z.string().max(256)).max(8),
  pushedAt: TimestampSchema.nullable(),
  openRequests: z.number().int().min(0).nullable(),
  openIssues: z.number().int().min(0).nullable(),
  /** The newest open requests (at most `CHANGE_REQUEST_LIMITS.repositoryRequests`). */
  requests: z.array(ForgeRepositoryRequestSchema).max(20),
  requestsTruncated: z.boolean(),
});
export type ForgeRepositoryInfo = z.infer<typeof ForgeRepositoryInfoSchema>;

export const RepositoryForgeResponseSchema = z.object({
  projectId: IdSchema,
  status: ProjectForgeStatusSchema,
  message: z.string().nullable(),
  forge: ProjectForgeSchema.nullable(),
  repository: ForgeRepositoryInfoSchema.nullable(),
  fetchedAt: TimestampSchema.nullable(),
});
export type RepositoryForgeResponse = z.infer<typeof RepositoryForgeResponseSchema>;

/** Detail and conversation caches: while open, and for merged/closed requests. */
export const FORGE_DETAIL_TTL_MS = 60_000;
export const FORGE_DETAIL_CLOSED_TTL_MS = 10 * 60_000;
/** Repository info cache. */
export const FORGE_REPOSITORY_TTL_MS = 10 * 60_000;
/** Live refresh of checks while the Request tab is visible and a check is running. */
export const FORGE_CHECKS_POLL_MS = 45_000;
