import { z } from 'zod';
import {
  API_VERSION,
  APP_NAME,
  IdSchema,
  InputPathSchema,
  OkResponseSchema,
  RawPathSchema,
  RefNameSchema,
  RepoPathSchema,
  TimestampSchema,
} from './common.js';
import {
  ChangedFileSchema,
  CommitInfoSchema,
  FileDiffSchema,
  GitRepositoryInfoSchema,
  InboxEntrySchema,
  ProjectListItemSchema,
  SCAN_DEPTH_DEFAULT,
  ScanDepthSchema,
  ScanRootSchema,
  WorktreeSummarySchema,
} from './domain.js';
import {
  DiffScopeSchema,
  refineScopeQuery,
  ScopeKindSchema,
  scopeFromQueryFields,
  scopeQueryShape,
} from './scope.js';

/**
 * HTTP routes. Paths use Hono-style `:param` placeholders. Every route except `/api/health`
 * requires auth. All bodies and responses are JSON except `/api/events` (text/event-stream).
 * Errors use `ApiErrorBodySchema` with a matching HTTP status.
 */
export const ROUTES = {
  health: { method: 'GET', path: '/api/health' },
  listProjects: { method: 'GET', path: '/api/projects' },
  addProject: { method: 'POST', path: '/api/projects' },
  updateProject: { method: 'PATCH', path: '/api/projects/:projectId' },
  removeProject: { method: 'DELETE', path: '/api/projects/:projectId' },
  listScanRoots: { method: 'GET', path: '/api/scan-roots' },
  addScanRoot: { method: 'POST', path: '/api/scan-roots' },
  removeScanRoot: { method: 'DELETE', path: '/api/scan-roots/:scanRootId' },
  rescanScanRoot: { method: 'POST', path: '/api/scan-roots/:scanRootId/rescan' },
  inbox: { method: 'GET', path: '/api/inbox' },
  listFiles: { method: 'GET', path: '/api/worktrees/:worktreeId/files' },
  getDiff: { method: 'GET', path: '/api/worktrees/:worktreeId/diff' },
  listCommits: { method: 'GET', path: '/api/worktrees/:worktreeId/commits' },
  refreshWorktree: { method: 'POST', path: '/api/worktrees/:worktreeId/refresh' },
  setReview: { method: 'PUT', path: '/api/review' },
  setFocus: { method: 'PUT', path: '/api/focus' },
  events: { method: 'GET', path: '/api/events' },
  // --- UX round 1 (additive; see settings.ts) ---
  getSettings: { method: 'GET', path: '/api/settings' },
  updateSettings: { method: 'PATCH', path: '/api/settings' },
  setReviewPolicy: { method: 'PUT', path: '/api/review-policy' },
  bulkReview: { method: 'POST', path: '/api/review/bulk' },
  undoReview: { method: 'POST', path: '/api/review/undo' },
  // --- status flow v2 (additive; docs/STATUS-FLOW.md) ---
  setBookmark: { method: 'PUT', path: '/api/review/bookmark' },
  // --- folder picker (additive; see "folder picker" below) ---
  listDirs: { method: 'GET', path: '/api/fs/dirs' },
  // --- forges (additive; see forge.ts) ---
  getForges: { method: 'GET', path: '/api/forges' },
  refreshForges: { method: 'POST', path: '/api/forges/refresh' },
  // --- request detail and repository information (additive; see forge.ts) ---
  getChangeRequest: { method: 'GET', path: '/api/forges/worktrees/:worktreeId/request' },
  getChangeRequestConversation: {
    method: 'GET',
    path: '/api/forges/worktrees/:worktreeId/request/conversation',
  },
  refreshChangeRequest: {
    method: 'POST',
    path: '/api/forges/worktrees/:worktreeId/request/refresh',
  },
  getRepositoryForge: { method: 'GET', path: '/api/forges/projects/:projectId/repository' },
  refreshRepositoryForge: {
    method: 'POST',
    path: '/api/forges/projects/:projectId/repository/refresh',
  },
  listRepositories: { method: 'GET', path: '/api/repositories' },
} as const;
export type RouteName = keyof typeof ROUTES;

/** Fills `:param` placeholders with URI-encoded values. */
export function buildPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`missing path parameter: ${name}`);
    return encodeURIComponent(value);
  });
}

const QueryBool = z.stringbool();

// --- health ----------------------------------------------------------------------------------

export const WatcherModeSchema = z.enum(['native', 'polling', 'mixed', 'disabled']);
export type WatcherMode = z.infer<typeof WatcherModeSchema>;

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  name: z.literal(APP_NAME),
  version: z.string(),
  apiVersion: z.literal(API_VERSION),
  git: z.object({ version: z.string().nullable(), supported: z.boolean() }),
  watcher: z.object({ mode: WatcherModeSchema, warnings: z.array(z.string()) }),
  startedAt: TimestampSchema,
  uptimeMs: z.number().int().min(0),
  /** Present when the request had `?challenge=`: see `healthProofMessage` in common.ts. */
  proof: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** `challenge`: 32–128 lowercase hex chars (a random nonce chosen by the client). */
export const HealthQuerySchema = z.object({
  challenge: z
    .string()
    .regex(/^[0-9a-f]{32,128}$/)
    .optional(),
});
export type HealthQuery = z.infer<typeof HealthQuerySchema>;

// --- projects --------------------------------------------------------------------------------

export const ProjectsResponseSchema = z.object({ projects: z.array(ProjectListItemSchema) });
export type ProjectsResponse = z.infer<typeof ProjectsResponseSchema>;

/** `path` may be any directory inside a repo, including a linked worktree. */
export const AddProjectRequestSchema = z.object({ path: InputPathSchema });
export type AddProjectRequest = z.infer<typeof AddProjectRequestSchema>;

export const AddProjectResponseSchema = z.object({
  project: ProjectListItemSchema,
  /** False if the project was already registered (the call is idempotent). */
  created: z.boolean(),
});
export type AddProjectResponse = z.infer<typeof AddProjectResponseSchema>;

export const UpdateProjectRequestSchema = z.object({
  /** Null clears the override and returns to auto-detection. */
  defaultBranchOverride: RefNameSchema.nullable().optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

export const UpdateProjectResponseSchema = z.object({ project: ProjectListItemSchema });
export type UpdateProjectResponse = z.infer<typeof UpdateProjectResponseSchema>;

// --- scan roots ------------------------------------------------------------------------------

export const ScanRootsResponseSchema = z.object({ scanRoots: z.array(ScanRootSchema) });
export type ScanRootsResponse = z.infer<typeof ScanRootsResponseSchema>;

export const AddScanRootRequestSchema = z.object({
  path: InputPathSchema,
  depth: ScanDepthSchema.default(SCAN_DEPTH_DEFAULT),
});
export type AddScanRootRequest = z.input<typeof AddScanRootRequestSchema>;

/** Scanning runs in the background; progress arrives as `scan.progress` events. */
export const AddScanRootResponseSchema = z.object({
  scanRoot: ScanRootSchema,
  created: z.boolean(),
});
export type AddScanRootResponse = z.infer<typeof AddScanRootResponseSchema>;

export const RescanResponseSchema = z.object({ scanRoot: ScanRootSchema });
export type RescanResponse = z.infer<typeof RescanResponseSchema>;

// --- folder picker ---------------------------------------------------------------------------

/**
 * What a directory is, judged only from its entries (no git process runs): `repo` has a `.git`
 * directory or is a bare repository (`HEAD`, `objects/`, `refs/`), `gitfile` has a `.git` file (a
 * linked worktree or a submodule), `dir` is neither.
 */
export const DirKindSchema = z.enum(['dir', 'repo', 'gitfile']);
export type DirKind = z.infer<typeof DirKindSchema>;

export const DIRS_ENTRIES_MAX = 2000;

/** `path` defaults to the daemon user's home; `~` is expanded, relative paths use the daemon's cwd. */
export const DirsQuerySchema = z.object({ path: InputPathSchema.optional() });
export type DirsQuery = z.infer<typeof DirsQuerySchema>;

export const DirEntrySchema = z.object({
  name: z.string(),
  /** Absolute: the listed directory joined with `name` (symlinks are not resolved). */
  path: z.string(),
  kind: DirKindSchema,
  /** Name starts with `.`. */
  hidden: z.boolean(),
  symlink: z.boolean(),
});
export type DirEntry = z.infer<typeof DirEntrySchema>;

/**
 * Subdirectories of one directory, for the folder picker. Names only: no file names, no file
 * contents, no git process. Sorted by name (case-insensitive).
 */
export const DirsResponseSchema = z.object({
  /** The listed directory: absolute, symlinks resolved. */
  path: z.string(),
  /** Null at the filesystem root. */
  parent: z.string().nullable(),
  kind: DirKindSchema,
  /** Path separator of the daemon's platform. */
  sep: z.enum(['/', '\\']),
  /** The daemon user's home directory (for `~` display). */
  home: z.string(),
  entries: z.array(DirEntrySchema),
  /** More than `DIRS_ENTRIES_MAX` subdirectories: the rest were dropped. */
  truncated: z.boolean(),
  /** Starting points: home, the daemon's working directory, the filesystem root. */
  places: z.array(z.object({ label: z.string(), path: z.string() })),
});
export type DirsResponse = z.infer<typeof DirsResponseSchema>;

// --- inbox, files, diff, commits -------------------------------------------------------------

/** Most projects one `GET /api/inbox?projectIds=` names (a client filling the inbox in batches). */
export const INBOX_PROJECTS_MAX = 200;

export const InboxQuerySchema = z
  .object({
    ...scopeQueryShape,
    onlyUnreviewed: QueryBool.default(false),
    /**
     * Only these projects (comma-separated ids; unknown ids are ignored). Absent = every project.
     * Lets a client fill the inbox in batches, first rows first (#10).
     */
    projectIds: z
      .string()
      .max(INBOX_PROJECTS_MAX * 17)
      .transform((v) => [...new Set(v.split(',').filter((s) => s.length > 0))])
      .pipe(z.array(IdSchema).min(1).max(INBOX_PROJECTS_MAX))
      .optional(),
  })
  .superRefine(refineScopeQuery)
  .transform(({ scope, base, sha, working, ...rest }) => ({
    ...rest,
    scope: scopeFromQueryFields({ scope, base, sha, working }),
  }));
export type InboxQuery = z.output<typeof InboxQuerySchema>;

export const InboxResponseSchema = z.object({
  scope: DiffScopeSchema,
  /**
   * Worktrees with at least one changed file in `scope` (after `onlyUnreviewed` filtering).
   * With `onlyUnreviewed`, worktrees whose review policy is disabled are left out entirely.
   */
  entries: z.array(InboxEntrySchema),
  generatedAt: TimestampSchema,
});
export type InboxResponse = z.infer<typeof InboxResponseSchema>;

export const FilesQuerySchema = z
  .object({ ...scopeQueryShape })
  .superRefine(refineScopeQuery)
  .transform((fields) => ({ scope: scopeFromQueryFields(fields) }));
export type FilesQuery = z.output<typeof FilesQuerySchema>;

export const FilesResponseSchema = z.object({
  worktreeId: IdSchema,
  scope: DiffScopeSchema,
  /** The worktree summary's stateHash at the time the list was computed. */
  stateHash: z.string().min(1),
  files: z.array(ChangedFileSchema),
});
export type FilesResponse = z.infer<typeof FilesResponseSchema>;

export const DIFF_CONTEXT_MAX = 1_000_000;

export const DiffQuerySchema = z
  .object({
    ...scopeQueryShape,
    path: RepoPathSchema,
    rawPath: RawPathSchema.optional(),
    /** Ignore all whitespace (`git diff -w`). Does not change `patchHash`. */
    ignoreWhitespace: QueryBool.default(false),
    /** Context lines (`-U<n>`); default 3. Does not change `patchHash`. */
    context: z.coerce.number().int().min(0).max(DIFF_CONTEXT_MAX).optional(),
    /** Return the patch even above the soft size limit (still bounded by the hard cap). */
    full: QueryBool.default(false),
  })
  .superRefine(refineScopeQuery)
  .transform(({ scope, base, sha, working, ...rest }) => ({
    ...rest,
    scope: scopeFromQueryFields({ scope, base, sha, working }),
  }));
export type DiffQuery = z.output<typeof DiffQuerySchema>;

export const DiffResponseSchema = z.object({
  worktreeId: IdSchema,
  scope: DiffScopeSchema,
  diff: FileDiffSchema,
});
export type DiffResponse = z.infer<typeof DiffResponseSchema>;

export const COMMITS_LIMIT_DEFAULT = 50;
export const COMMITS_LIMIT_MAX = 500;

export const CommitsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(COMMITS_LIMIT_MAX).default(COMMITS_LIMIT_DEFAULT),
});
export type CommitsQuery = z.output<typeof CommitsQuerySchema>;

export const CommitsResponseSchema = z.object({ commits: z.array(CommitInfoSchema) });
export type CommitsResponse = z.infer<typeof CommitsResponseSchema>;

export const RefreshResponseSchema = z.object({ summary: WorktreeSummarySchema });
export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

// --- app state: review marks, focus ----------------------------------------------------------

/**
 * Review marks are keyed by (projectId, rawPath ?? path, patchHash). `scopeKind` is still sent and
 * stored (where the mark was made) but no longer part of the key (docs/STATUS-FLOW.md §2.4).
 */
export const ReviewRequestSchema = z.object({
  projectId: IdSchema,
  scopeKind: ScopeKindSchema,
  path: RepoPathSchema,
  rawPath: RawPathSchema.optional(),
  patchHash: z.string().min(1).max(256),
  reviewed: z.boolean(),
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export const ReviewResponseSchema = z.object({ ok: z.literal(true), reviewed: z.boolean() });
export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

/**
 * Tells the daemon which worktree the UI is looking at, so it can poll that one more often
 * (30 s focused vs 5 min for the rest). Null when nothing is focused or the tab is hidden.
 */
/**
 * `PUT /api/focus`: the worktree the user looks at (watch priority, null when the tab is hidden)
 * and, optionally, the project they have open (its Overview, or the focused worktree's project).
 * An open project gets its worktrees' review states computed (#10; `review.ready` follows).
 */
export const FocusRequestSchema = z.object({
  worktreeId: IdSchema.nullable(),
  projectId: IdSchema.nullable().optional(),
  /**
   * Whether the tab is visible. Absent (older clients): inferred from the other fields, as before
   * (nothing selected means hidden). A visible Inbox or folder Overview selects nothing but is
   * still looked at, so newer clients say so; the forge polling pace depends on it (DECISIONS #197).
   */
  visible: z.boolean().optional(),
});
export type FocusRequest = z.infer<typeof FocusRequestSchema>;

export { OkResponseSchema };

// --- repository information (Overview) -------------------------------------------------------

export const REPOSITORIES_MAX = 200;

/** `GET /api/repositories?projectIds=a,b,c`: local facts for up to `REPOSITORIES_MAX` projects. */
export const RepositoriesQuerySchema = z.object({
  projectIds: z
    .string()
    .max(REPOSITORIES_MAX * 17)
    .transform((v) => [...new Set(v.split(',').filter((s) => s.length > 0))])
    .pipe(z.array(IdSchema).min(1).max(REPOSITORIES_MAX)),
});
export type RepositoriesQuery = z.output<typeof RepositoriesQuerySchema>;

export const RepositoriesResponseSchema = z.object({
  repositories: z.array(
    z.object({
      projectId: IdSchema,
      info: GitRepositoryInfoSchema.nullable(),
      /** Why `info` is null (unknown project, git failed). */
      error: z.string().nullable(),
    }),
  ),
  generatedAt: TimestampSchema,
});
export type RepositoriesResponse = z.infer<typeof RepositoriesResponseSchema>;
