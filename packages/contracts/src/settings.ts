import { z } from 'zod';
import {
  IdSchema,
  RawPathSchema,
  RefNameSchema,
  RepoPathSchema,
  TimestampSchema,
} from './common.js';
import { DEFAULT_FORGE_SETTINGS, ForgeSettingsPatchSchema, ForgeSettingsSchema } from './forge.js';
import { DiffScopeSchema } from './scope.js';

/**
 * App settings and review controls (docs/COORDINATION.md "UX round 1").
 *
 * These are daemon-side app state (SQLite, outside the repositories), shared by every browser
 * that talks to the daemon. Per-browser UI preferences (theme, layout, density, ...) are NOT here:
 * they stay in the web app's localStorage `octopus-diff:prefs`.
 */

// ---------------------------------------------------------------------------------------------
// Review policy: is the review loop (reviewed marks, "unreviewed" badges, `n`) active here?
// ---------------------------------------------------------------------------------------------

/**
 * What an override attaches to. Resolution order for a worktree, most specific first:
 *
 *   worktree  >  branch (its current branch, within its project)  >  project  >  folder  >  default
 *
 * `folder` is a scan root: it applies to every project that scan root discovered
 * (`Project.scanRootId`). `branch` is keyed by (projectId, short branch name), so it survives
 * worktrees being deleted and recreated for the same branch, which is what agents do.
 * "Review on by default for new repos, worktrees and branches" is exactly the `default` level:
 * anything without its own override or an overridden ancestor inherits `review.defaultEnabled`.
 */
export const ReviewPolicyTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('folder'), scanRootId: IdSchema }),
  z.object({ kind: z.literal('project'), projectId: IdSchema }),
  z.object({ kind: z.literal('branch'), projectId: IdSchema, branch: RefNameSchema }),
  z.object({ kind: z.literal('worktree'), worktreeId: IdSchema }),
]);
export type ReviewPolicyTarget = z.infer<typeof ReviewPolicyTargetSchema>;
export type ReviewPolicyTargetKind = ReviewPolicyTarget['kind'];

/** Where an effective policy came from. `default` = `AppSettings.review.defaultEnabled`. */
export const ReviewPolicySourceSchema = z.enum([
  'worktree',
  'branch',
  'project',
  'folder',
  'default',
]);
export type ReviewPolicySource = z.infer<typeof ReviewPolicySourceSchema>;

/**
 * The resolved policy of one worktree. When `enabled` is false the worktree is out of the review
 * loop: the UI hides review controls and "unreviewed" badges for it, `onlyUnreviewed` inbox
 * queries leave it out, `n` skips it, and bulk review skips it unless `includeDisabled` is set.
 * Its changes are still listed and diffable (diff first): review is opt-out, visibility is not.
 */
export const EffectiveReviewPolicySchema = z.object({
  enabled: z.boolean(),
  source: ReviewPolicySourceSchema,
});
export type EffectiveReviewPolicy = z.infer<typeof EffectiveReviewPolicySchema>;

/** An explicit override as stored. There is at most one per target. */
export const ReviewOverrideSchema = z.object({
  target: ReviewPolicyTargetSchema,
  enabled: z.boolean(),
  updatedAt: TimestampSchema,
});
export type ReviewOverride = z.infer<typeof ReviewOverrideSchema>;

/** Stable string key of an override target (map keys, SQLite primary keys, React keys). */
export function reviewTargetKey(target: ReviewPolicyTarget): string {
  switch (target.kind) {
    case 'folder':
      return `folder:${target.scanRootId}`;
    case 'project':
      return `project:${target.projectId}`;
    case 'branch':
      return `branch:${target.projectId}:${target.branch}`;
    case 'worktree':
      return `worktree:${target.worktreeId}`;
  }
}

export interface ResolveReviewPolicyInput {
  /** `AppSettings.review.defaultEnabled`. */
  defaultEnabled: boolean;
  /** All explicit overrides (any order). */
  overrides: readonly Pick<ReviewOverride, 'target' | 'enabled'>[];
  worktreeId: string;
  projectId: string;
  /** Current short branch name; null when detached (the branch level is then skipped). */
  branch: string | null;
  /** `Project.scanRootId`; null for explicitly added projects (the folder level is skipped). */
  scanRootId: string | null;
}

/**
 * THE precedence rule, shared by the daemon and the web mock so they cannot drift:
 * worktree > branch > project > folder > default. Pure and allocation-light enough to call per
 * worktree; for hot paths build the key->enabled map once with `reviewOverrideMap`.
 */
export function resolveReviewPolicy(input: ResolveReviewPolicyInput): EffectiveReviewPolicy {
  return resolveReviewPolicyFromMap(input, reviewOverrideMap(input.overrides));
}

export function reviewOverrideMap(
  overrides: readonly Pick<ReviewOverride, 'target' | 'enabled'>[],
): ReadonlyMap<string, boolean> {
  return new Map(overrides.map((o) => [reviewTargetKey(o.target), o.enabled]));
}

export function resolveReviewPolicyFromMap(
  input: Omit<ResolveReviewPolicyInput, 'overrides'>,
  map: ReadonlyMap<string, boolean>,
): EffectiveReviewPolicy {
  const levels: Array<[ReviewPolicySource, string | null]> = [
    ['worktree', `worktree:${input.worktreeId}`],
    ['branch', input.branch === null ? null : `branch:${input.projectId}:${input.branch}`],
    ['project', `project:${input.projectId}`],
    ['folder', input.scanRootId === null ? null : `folder:${input.scanRootId}`],
  ];
  for (const [source, key] of levels) {
    if (key === null) continue;
    const enabled = map.get(key);
    if (enabled !== undefined) return { enabled, source };
  }
  return { enabled: input.defaultEnabled, source: 'default' };
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export const ReviewSettingsSchema = z.object({
  /**
   * Review on or off for everything that has no override of its own and no overridden ancestor,
   * which includes every newly discovered repo, worktree and branch. Default true.
   */
  defaultEnabled: z.boolean(),
});
export type ReviewSettings = z.infer<typeof ReviewSettingsSchema>;

export const AppSettingsSchema = z.object({
  review: ReviewSettingsSchema,
  /**
   * Forge integration (forge.ts, docs/FORGES.md). Always sent by daemons that have it; absent
   * means the daemon predates it (treat as `DEFAULT_FORGE_SETTINGS`, but there is no data).
   */
  forges: ForgeSettingsSchema.optional(),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  review: { defaultEnabled: true },
  forges: DEFAULT_FORGE_SETTINGS,
};

/** Partial update: omitted fields keep their value. */
export const AppSettingsPatchSchema = z.object({
  review: ReviewSettingsSchema.partial().optional(),
  forges: ForgeSettingsPatchSchema.optional(),
});
export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>;

/**
 * Settings plus every explicit override. `revision` increases on every change (settings,
 * overrides); a `settings.changed` event carries the new revision so clients can skip refetches
 * they already applied from a response. `overrides` is ordered folder, project, branch, worktree,
 * then by target key; clients must not rely on anything stricter.
 */
export const SettingsResponseSchema = z.object({
  settings: AppSettingsSchema,
  overrides: z.array(ReviewOverrideSchema),
  revision: z.number().int().min(0),
});
export type SettingsResponse = z.infer<typeof SettingsResponseSchema>;

/** `enabled: null` removes the override so the target inherits again. Returns the new state. */
export const SetReviewPolicyRequestSchema = z.object({
  target: ReviewPolicyTargetSchema,
  enabled: z.boolean().nullable(),
});
export type SetReviewPolicyRequest = z.infer<typeof SetReviewPolicyRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Bulk review ("Mark all as verified") with undo
// ---------------------------------------------------------------------------------------------

export const BulkReviewTargetSchema = z.discriminatedUnion('kind', [
  /** Every worktree of every project (the Inbox). */
  z.object({ kind: z.literal('all') }),
  /** Every project discovered by this scan root. */
  z.object({ kind: z.literal('folder'), scanRootId: IdSchema }),
  z.object({ kind: z.literal('project'), projectId: IdSchema }),
  z.object({ kind: z.literal('worktree'), worktreeId: IdSchema }),
]);
export type BulkReviewTarget = z.infer<typeof BulkReviewTargetSchema>;

export const BULK_REVIEW_PATHS_MAX = 50_000;

/**
 * Marks (or unmarks) the changed files of the target in `scope`, resolved **on the server** from
 * the current state, so the client never has to send hundreds of patch hashes.
 *
 * Safety against marking what the user has not seen: `expectedStateHashes` maps worktree id to
 * the `stateHash` of the summary the user was looking at. A worktree whose current stateHash
 * differs is skipped and listed in the response's `stale`. Omit it to mark whatever is current.
 */
export const BulkReviewRequestSchema = z.object({
  target: BulkReviewTargetSchema,
  scope: DiffScopeSchema.default({ kind: 'working' }),
  /** True = mark verified (default); false = clear marks ("mark all unreviewed"). */
  reviewed: z.boolean().default(true),
  /**
   * Only for `worktree` targets: restrict to these files (for example the ones visible after the
   * user's filters). `rawPath` wins over `path`, as everywhere else.
   */
  paths: z
    .array(z.object({ path: RepoPathSchema, rawPath: RawPathSchema.optional() }))
    .max(BULK_REVIEW_PATHS_MAX)
    .optional(),
  expectedStateHashes: z.record(IdSchema, z.string().min(1)).optional(),
  /** Also act on worktrees where review is disabled. Default false (they are skipped). */
  includeDisabled: z.boolean().default(false),
});
export type BulkReviewRequest = z.input<typeof BulkReviewRequestSchema>;
export type BulkReviewRequestParsed = z.output<typeof BulkReviewRequestSchema>;

export const BulkReviewResponseSchema = z.object({
  ok: z.literal(true),
  reviewed: z.boolean(),
  /** Marks created (or removed when `reviewed` is false). Already-in-state files are not counted. */
  changed: z.number().int().min(0),
  /** Files that already had the requested state. */
  unchanged: z.number().int().min(0),
  /** Worktrees that had at least one file considered. */
  worktrees: z.number().int().min(0),
  /**
   * Review-disabled worktrees that had changed files in `scope` and were therefore skipped (clean
   * worktrees are not listed even when review is off for them).
   */
  skippedDisabled: z.array(IdSchema),
  /**
   * Worktrees skipped because their `stateHash` no longer matched `expectedStateHashes`
   * (reported whether or not they have changed files: the user saw a different state).
   */
  stale: z.array(IdSchema),
  /** Pass to `POST /api/review/undo`; null when nothing changed. Valid for `BULK_UNDO_TTL_MS`. */
  undoToken: z.string().min(1).nullable(),
});
export type BulkReviewResponse = z.infer<typeof BulkReviewResponseSchema>;

export const BULK_UNDO_TTL_MS = 10 * 60 * 1000;
export const BULK_UNDO_MAX_ENTRIES = 20;

/** Reverses exactly the marks one bulk call changed. `not_found` once expired or already used. */
export const UndoReviewRequestSchema = z.object({ undoToken: z.string().min(1).max(256) });
export type UndoReviewRequest = z.infer<typeof UndoReviewRequestSchema>;

export const UndoReviewResponseSchema = z.object({
  ok: z.literal(true),
  /** Marks restored to their previous state. Marks changed again since then are left alone. */
  restored: z.number().int().min(0),
});
export type UndoReviewResponse = z.infer<typeof UndoReviewResponseSchema>;
