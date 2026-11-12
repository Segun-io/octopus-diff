import { z } from 'zod';
import { CommitShaSchema, IdSchema, RawPathSchema, TimestampSchema } from './common.js';
import { FileOriginSchema, FileOriginViaSchema, InProgressOperationSchema } from './domain.js';
import { BLOB_MAX_BYTES_DEFAULT, BlobReadSchema, GitObjectIdSchema } from './live.js';

/**
 * Live view (roadmap step 19, #38): what changed in a worktree while you watched, derived by the
 * daemon from consecutive summary snapshots (#37). The feed lives **in daemon memory only**: it is
 * never persisted, starts empty on every daemon start (the first snapshot is a baseline), and keeps
 * at most `ACTIVITY_RING_SIZE` entries per worktree and `ACTIVITY_GLOBAL_MAX` overall.
 *
 * Granularity is the summary refresh (about one per second while files change, the poll interval
 * for polled worktrees): a file created and deleted inside one refresh is never seen. The content
 * of a deleted **tracked** file is its last staged or committed version (`oid`, read through
 * `GET /api/worktrees/:id/blob/:oid`); unstaged edits made just before the delete, and every
 * untracked file, were never in git, so their content is unavailable.
 */

/** Entries kept per worktree (oldest dropped first). */
export const ACTIVITY_RING_SIZE = 200;
/** Entries kept over all worktrees together (the oldest anywhere is dropped first). */
export const ACTIVITY_GLOBAL_MAX = 20_000;
/** A repeat of the same path and kind (or the same HEAD operation) within this window updates one entry. */
export const ACTIVITY_COALESCE_MS = 10_000;
/** A single refresh changing more paths than this folds them into one `bulk` entry. */
export const ACTIVITY_BULK_THRESHOLD = 50;
/** Paths listed on a `commit`, `head` or `bulk` entry (`pathCount` has the real number). */
export const ACTIVITY_PATHS_MAX = 20;

/**
 * - `added`: a new file (untracked or added to the index), or a deleted file that came back.
 * - `modified`: the file's content changed (`added` / `deleted` = its latest +/- against HEAD).
 * - `deleted`: the file is gone from the working tree (`oid` = its last staged or committed content).
 * - `restored`: an uncommitted change was undone without a commit (`git restore`, an edit back).
 * - `commit`: HEAD advanced by a commit on top of the previous HEAD (`sha`, `subject`, `paths` it
 *   took out of the uncommitted set).
 * - `head`: HEAD moved otherwise, or an operation started or ended (`op`).
 * - `bulk`: more than `ACTIVITY_BULK_THRESHOLD` paths in one refresh (`kinds`, sample `paths`), or a
 *   change in a worktree whose snapshot is truncated (`truncated`).
 */
export const ActivityKindSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'restored',
  'commit',
  'head',
  'bulk',
]);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

/**
 * What moved HEAD (`head` entries): `checkout` (the branch or detached state changed), `merge`
 * (a merge, a fast-forward or pull), `rebase`, `reset` (HEAD moved to a commit that does not descend
 * from the previous one: a reset, an amend, a rewrite), the other in-progress operations by name,
 * and `moved` when the daemon could not tell. Clients must tolerate values added later.
 */
export const ActivityHeadOpSchema = z.enum([
  'checkout',
  'merge',
  'rebase',
  'reset',
  'cherry-pick',
  'revert',
  'am',
  'bisect',
  'moved',
]);
export type ActivityHeadOp = z.infer<typeof ActivityHeadOpSchema>;

const Count = z.number().int().min(0);

export const ActivityEntrySchema = z.object({
  /** Stable id of the entry: the sequence number it was created with. */
  id: z.number().int().positive(),
  /**
   * Sequence number of the entry's latest update (coalescing gives an entry a new `seq` and moves
   * it to the end of the feed). Daemon-wide and increasing; restarts at 1 with the daemon.
   */
  seq: z.number().int().positive(),
  kind: ActivityKindSchema,
  /** When the entry was first seen. */
  at: TimestampSchema,
  /** When it was last updated (equal to `at` unless coalesced). */
  updatedAt: TimestampSchema,
  /** Refreshes folded into this entry (1 = not coalesced). */
  count: z.number().int().min(1),

  // --- file entries: added, modified, deleted, restored ---------------------------------------
  /** Repo-relative path (UTF-8, lossy when `rawPath` is present). */
  path: z.string().optional(),
  rawPath: RawPathSchema.optional(),
  /** Rename source, when git paired one. */
  oldPath: z.string().optional(),
  /** The two status letters after the change (`.M`, `.D`, `??`, ...); absent for `restored`. */
  xy: z.string().length(2).optional(),
  /** Latest lines added / removed against HEAD; null when unknown (binary, not read). */
  added: Count.nullable().optional(),
  deleted: Count.nullable().optional(),
  /**
   * `deleted`: the blob of the file's last staged or committed content, readable through the blob
   * route while it stays in the feed; null when there is none (`untracked`, a submodule).
   */
  oid: GitObjectIdSchema.nullable().optional(),
  /** `deleted`: the file was untracked, so git never had its content ("content unavailable"). */
  untracked: z.boolean().optional(),
  /**
   * Merge noise (#33): the change came from the default branch (`base`) or both (`mixed`), as far
   * as the daemon had already labeled the file for the review state; absent = own or not labeled.
   * A `bulk` entry is `base` when all of its paths are.
   */
  origin: FileOriginSchema.optional(),
  originVia: FileOriginViaSchema.optional(),

  // --- commit and head entries ----------------------------------------------------------------
  /** `commit`: the new commit. */
  sha: CommitShaSchema.optional(),
  /** `commit`: its subject line. */
  subject: z.string().optional(),
  /** `head`: what moved HEAD. */
  op: ActivityHeadOpSchema.optional(),
  /** `head` / `commit`: HEAD before (first one of a coalesced run) and after; null when unborn. */
  from: CommitShaSchema.nullable().optional(),
  to: CommitShaSchema.nullable().optional(),
  /** `head`: the branch after the change (null when detached) and before. */
  branch: z.string().nullable().optional(),
  fromBranch: z.string().nullable().optional(),
  /** `head`: the operation in progress after the change (null when none). */
  inProgress: InProgressOperationSchema.nullable().optional(),

  // --- commit, head and bulk entries ----------------------------------------------------------
  /**
   * Paths involved, at most `ACTIVITY_PATHS_MAX` (`pathCount` is the real number). For `commit`
   * and `head`: the uncommitted paths that left the uncommitted set in the same refresh (they were
   * committed, merged or checked out, not reverted). For `bulk`: a sample of the changed paths.
   */
  paths: z.array(z.string()).optional(),
  pathCount: Count.optional(),
  /** `bulk`: how many paths of each kind. */
  kinds: z.object({ added: Count, modified: Count, deleted: Count, restored: Count }).optional(),
  /**
   * `bulk`: the worktree has more changed paths than the snapshot holds, so the feed for it is
   * coarse (one entry per refresh, no per-file detail).
   */
  truncated: z.boolean().optional(),
});
export type ActivityEntry = z.infer<typeof ActivityEntrySchema>;

/**
 * How the worktree is watched, so the UI can word how fresh the feed is: `native` (file events,
 * refresh within about a second), `polling` (no file events: refreshed every `pollMs`), `disabled`
 * (watching is off: only manual refreshes and the slow poll).
 */
export const ActivityWatchSchema = z.object({
  mode: z.enum(['native', 'polling', 'disabled']),
  /** Current poll interval for this worktree (it depends on focus); null when not polled. */
  pollMs: z.number().int().positive().nullable(),
});
export type ActivityWatch = z.infer<typeof ActivityWatchSchema>;

/** `GET /api/worktrees/:worktreeId/activity?after=<seq>`. */
export const ActivityQuerySchema = z.object({
  /** Return entries with `seq` greater than this (default 0: the whole ring). */
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  /**
   * The `run` an earlier response carried. A different one means the daemon restarted since (its
   * sequence numbers start over and may overlap with `after`), so the answer is `dropped`.
   */
  run: z.string().max(64).optional(),
});
export type ActivityQuery = z.output<typeof ActivityQuerySchema>;

export const ActivityResponseSchema = z.object({
  worktreeId: IdSchema,
  /** Entries with `seq > after`, oldest first. */
  entries: z.array(ActivityEntrySchema),
  /** The worktree's latest `seq` (0 when the feed is empty): pass it as `after` next time. */
  seq: z.number().int().min(0),
  /**
   * Entries newer than `after` were dropped from the ring (cap reached), or `after` comes from an
   * earlier daemon run: refetch from 0 and replace what you have.
   */
  dropped: z.boolean(),
  /** False until the worktree's baseline snapshot exists (nothing can be reported before it). */
  live: z.boolean(),
  /**
   * Identifies this daemon run: send it back as `run` with `after`, and a restart is detected even
   * when the new run's sequence numbers overlap the old cursor. Absent from older daemons.
   */
  run: z.string().optional(),
  watch: ActivityWatchSchema,
});
export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;

/** Largest blob the blob route returns (it may ask for less with `?maxBytes=`). */
export const ACTIVITY_BLOB_MAX_BYTES = BLOB_MAX_BYTES_DEFAULT;

/**
 * `GET /api/worktrees/:worktreeId/blob/:oid?maxBytes=`: the content of a blob that appears in the
 * worktree's activity feed or current snapshot (a deleted file's `oid`), never an arbitrary object.
 */
export const BlobQuerySchema = z.object({
  maxBytes: z.coerce.number().int().min(1).max(ACTIVITY_BLOB_MAX_BYTES).optional(),
});
export type BlobQuery = z.output<typeof BlobQuerySchema>;

export const BlobResponseSchema = z.object({
  worktreeId: IdSchema,
  blob: BlobReadSchema,
});
export type BlobResponse = z.infer<typeof BlobResponseSchema>;
