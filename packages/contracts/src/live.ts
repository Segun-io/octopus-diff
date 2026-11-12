import { z } from 'zod';

/**
 * Live feed building blocks (roadmap step 18, #37): the per-file snapshot `getSummary` can return
 * from the `git status` / numstat it already runs, and a size-capped blob read by object id.
 * Everything here is additive and optional; the default `getSummary` result is unchanged.
 */

/** A full object id: 40 (sha1) or 64 (sha256) lowercase hex digits, never the all-zero null id. */
export const GitObjectIdSchema = z
  .string()
  .regex(
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
    'expected a full 40 or 64 digit lowercase hex object id',
  )
  .refine((oid) => !/^0+$/.test(oid), 'the null object id is not an object');
export type GitObjectId = z.infer<typeof GitObjectIdSchema>;

// ---------------------------------------------------------------------------------------------
// Summary snapshot
// ---------------------------------------------------------------------------------------------

/** Entries a snapshot holds unless `maxEntries` says otherwise. */
export const SNAPSHOT_MAX_ENTRIES_DEFAULT = 2000;
/** The largest `maxEntries` git-core accepts (a snapshot is an in-memory object, keep it small). */
export const SNAPSHOT_MAX_ENTRIES_LIMIT = 20_000;

/**
 * `SummaryOptions.snapshot`: `true` (default cap), `false`, or `{ maxEntries }`. git-core parses what
 * a caller passes with this schema before reading any field, so `null`, a number or an unknown key
 * is an `invalid_argument`, not a silently enabled snapshot or a crash.
 */
export const SummarySnapshotOptionSchema = z.union([
  z.boolean(),
  z
    .object({ maxEntries: z.number().int().min(1).max(SNAPSHOT_MAX_ENTRIES_LIMIT).optional() })
    .strict(),
]);

/**
 * One changed path of a worktree, as the summary's own `git status --porcelain=v2` and numstat
 * saw it. Untracked files appear with `xy` `??` and no oids (their content is never available
 * through git: a deleted untracked file is gone).
 */
export const SummarySnapshotEntrySchema = z.object({
  /** Repo-relative path (UTF-8, lossy when `rawPath` is present). */
  path: z.string(),
  /** Base64 of the raw bytes, only when the name is not valid UTF-8. */
  rawPath: z.string().optional(),
  /** Rename or copy source (display form), when status paired one. */
  oldPath: z.string().optional(),
  oldRawPath: z.string().optional(),
  /**
   * Two status letters, index then worktree (`.` = unchanged, e.g. `.M`, `D.`, `.D`, `R.`, `A.`,
   * `UU`), or `??` for an untracked file.
   */
  xy: z.string().length(2),
  /**
   * Blob id in HEAD, null when the path is not in HEAD (added, untracked). Unmerged paths: the
   * "ours" (stage 2) blob.
   */
  hH: GitObjectIdSchema.nullable(),
  /** Blob id in the index, null when the path is not in the index (`D.`, untracked, unmerged). */
  hI: GitObjectIdSchema.nullable(),
  /**
   * The lstat-based signature of the worktree path that is hashed into `stateHash`
   * (`size:mtimeNs:ctimeNs:ino:mode`, `missing` when gone; for a submodule also its HEAD). Opaque:
   * only compare for equality.
   */
  sig: z.string(),
  /** Lines added / removed against HEAD; null when unknown (binary, not read, no numstat). */
  added: z.number().int().nonnegative().nullable(),
  deleted: z.number().int().nonnegative().nullable(),
});
export type SummarySnapshotEntry = z.infer<typeof SummarySnapshotEntrySchema>;

export const SummarySnapshotSchema = z.object({
  /** Tracked entries in `git status` order, then untracked ones in path order, up to the cap. */
  entries: z.array(SummarySnapshotEntrySchema),
  /** Changed paths in the worktree (entries that were cut off included). */
  total: z.number().int().nonnegative(),
  /**
   * `total` exceeded `maxEntries`; `entries` holds the first `maxEntries`. Untracked files omitted
   * above git-core's cap (`untrackedOmitted`, #43) are in `total` but are never entries and do not
   * set it: it says that the entry cap cut listed paths off.
   */
  truncated: z.boolean(),
  /**
   * A hash of every changed path's state (status codes, object ids, content signatures, counts),
   * including paths beyond the cap. Unlike `WorktreeSummary.stateHash` it holds nothing about
   * refs (the upstream, the default branch): it moves only when a file of this worktree changes.
   */
  contentHash: z.string().optional(),
  /**
   * Untracked files above git-core's cap (#43, `WorktreeSummary.untrackedOmitted`): counted in
   * `total`, never in `entries`, and not what `truncated` is about (`truncated` says the cap of
   * entries cut listed paths off). Their paths are in `contentHash` (appearing or disappearing
   * moves it); their contents are not. Absent when nothing was omitted.
   */
  untrackedOmitted: z.number().int().positive().optional(),
  /**
   * Opaque identity of which untracked files were omitted (the omitted directories and the cut in
   * path order), present with `untrackedOmitted`. Two snapshots with the same value omit the same
   * paths, so a listed untracked path missing from the later one is gone; with different values a
   * path may have moved between listed and omitted (compare coarsely).
   */
  omittedPlan: z.string().min(1).optional(),
});
export type SummarySnapshot = z.infer<typeof SummarySnapshotSchema>;

// ---------------------------------------------------------------------------------------------
// Blob read
// ---------------------------------------------------------------------------------------------

export const BLOB_MAX_BYTES_DEFAULT = 1024 * 1024;
export const BLOB_MAX_BYTES_LIMIT = 16 * 1024 * 1024;

export const BlobReadOptionsSchema = z.object({
  oid: GitObjectIdSchema,
  /** Largest blob returned (default `BLOB_MAX_BYTES_DEFAULT`, at most `BLOB_MAX_BYTES_LIMIT`). */
  maxBytes: z.number().int().min(1).max(BLOB_MAX_BYTES_LIMIT).optional(),
});
export type BlobReadOptions = z.infer<typeof BlobReadOptionsSchema>;

/**
 * - `text`: `content` is the blob decoded as UTF-8 (invalid sequences replaced).
 * - `binary`: git's heuristic (a NUL byte in the first 8000 bytes); `content` is null.
 * - `too_large`: `size` is above `maxBytes`; `content` is null.
 */
export const BlobReadKindSchema = z.enum(['text', 'binary', 'too_large']);
export type BlobReadKind = z.infer<typeof BlobReadKindSchema>;

export const BlobReadSchema = z.object({
  oid: GitObjectIdSchema,
  kind: BlobReadKindSchema,
  /** Size of the blob in bytes (`cat-file -s`; for text and binary, the bytes read). */
  size: z.number().int().nonnegative(),
  /** The cap that applied. */
  maxBytes: z.number().int().min(1),
  content: z.string().nullable(),
});
export type BlobRead = z.infer<typeof BlobReadSchema>;
