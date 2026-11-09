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
