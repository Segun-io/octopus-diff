/**
 * The file explorer foundation (#9, roadmap step 27): one directory of a worktree at a time.
 *
 * - **Views.** Without `ref`, the *working view*: HEAD's tree with the worktree's changes laid
 *   over it (the daemon's `working` file list of the same state, no extra git process). With `ref`
 *   (`HEAD`, a branch or tag, a commit id), the *tree view*: that commit's tree exactly, with no
 *   working-copy data at all.
 * - **Order.** git's tree order: entries by name bytes, a directory compared as `name/`
 *   (`compareTreeNames`). Entries that exist only in the working copy sort in at their place.
 * - **Working-view rules** (also in docs/DECISIONS.md):
 *   - A changed path carries its `status` (the working list's: `modified`, `added`, `deleted`,
 *     `renamed`, `copied`, `typechange`, `untracked`, `conflicted`) and `staged` / `unstaged`.
 *   - A deleted tracked file is still listed, `status: 'deleted'`; so is the old path of a rename
 *     (`status: 'deleted'`, `renamedTo`).
 *   - Files and directories that exist only in the working copy are listed: new directories get
 *     `status: 'untracked'` when everything below them is untracked, else `'added'`.
 *   - A directory of HEAD whose tracked files are all deleted (and that holds nothing new) gets
 *     `status: 'deleted'`.
 *   - A directory's `changes` counts the changed paths below it (a rename counts its two paths).
 *   - Untracked files above git-core's cap (#43) are not listed: a directory the summary names as
 *     omitted is listed with `status: 'untracked'` (when it is not in HEAD) and `untrackedOmitted`.
 *   - Ignored files are never listed (neither `ls-tree` nor the file list holds them); tracked files
 *     that match an ignore rule are, like any tracked file.
 *   - A sparse checkout lists HEAD's whole tree: paths outside the cone are listed as unchanged.
 * - **Paging** (`pageTreeEntries`): as `GET /files` (#42), a page is a slice of the directory's
 *   listing for one state, its cursor is opaque and bound to that listing; a cursor of another
 *   listing answers with the first page and `restarted: true`.
 *
 * Pure and browser-safe.
 */
import { z } from 'zod';
import {
  FileModeSchema,
  IdSchema,
  RawPathSchema,
  RefNameSchema,
  RepoPathSchema,
} from './common.js';
import { FileStatusSchema } from './domain.js';
import { GitObjectIdSchema } from './live.js';
import { FILE_CURSOR_MAX_CHARS, Hash64, utf8Length } from './paging.js';

const Count = z.number().int().min(0);

/** Most entries one `GET /tree` page holds. */
export const TREE_PAGE_MAX = 5000;
/** Entries a `GET /tree` page holds when the request has no `limit`. */
export const TREE_PAGE_DEFAULT = 2000;
/** Bytes of entry rows (their JSON) one page carries at most (as `FILES_PAGE_MAX_BYTES`). */
export const TREE_PAGE_MAX_BYTES = 900_000;
/** What a tree cursor looks like: `t1.<fingerprint>.<offset>`, opaque to clients. */
export const TREE_CURSOR_PATTERN = /^t1\.[0-9a-f]{16}\.[0-9a-z]{1,12}$/;
/** Most directories `worktree.changed` names in `dirs`; above it, `all: true`. */
export const WORKTREE_CHANGED_DIRS_MAX = 100;
/** Most characters of directory path text (`path` + `rawPath`) in `dirs`; above it, `all: true`. */
export const WORKTREE_CHANGED_DIRS_MAX_CHARS = 8000;

export const TREE_ENTRY_KINDS = ['file', 'dir', 'symlink', 'submodule'] as const;
export const TreeEntryKindSchema = z.enum(TREE_ENTRY_KINDS);
export type TreeEntryKind = z.infer<typeof TreeEntryKindSchema>;

/** A directory of a worktree: `''` is the root, else a repo-relative path without trailing `/`. */
export const TreeDirPathSchema = z.union([z.literal(''), RepoPathSchema]);

/** The `ref` of the tree view: `HEAD`, a branch or tag name, or a commit id (`RefNameSchema`). */
export const TreeRefSchema = RefNameSchema;

export const TreeEntrySchema = z.object({
  /** One path component (UTF-8, lossy with U+FFFD when `rawName` is present). */
  name: z.string().min(1).max(4096),
  /** Base64 of the name's raw bytes, only when they are not valid UTF-8. */
  rawName: RawPathSchema.optional(),
  /** Repo-relative path (UTF-8, lossy when `rawPath` is present). */
  path: RepoPathSchema,
  rawPath: RawPathSchema.optional(),
  kind: TreeEntryKindSchema,
  /**
   * The tree's mode (`100644`, `100755`, `120000`, `160000`, `040000`); for a path only in the
   * working copy its new mode when known, else null.
   */
  mode: FileModeSchema.nullable(),
  /** The tree's object id; null for a path that is not in the commit's tree. */
  oid: GitObjectIdSchema.nullable(),
  /** Blob size in the commit's tree (files and symlinks); null for directories, submodules and paths not in it. */
  size: Count.nullable(),
  /** Working view: this path's change (see the module comment). Absent: unchanged. */
  status: FileStatusSchema.optional(),
  /** Working view, files: the change is (partly) in the index / in the working tree. */
  staged: z.boolean().optional(),
  unstaged: z.boolean().optional(),
  /** Working view: a renamed or copied file's previous path. */
  oldPath: RepoPathSchema.optional(),
  /** Base64 of `oldPath`'s raw bytes, only when they are not valid UTF-8. */
  oldRawPath: RawPathSchema.optional(),
  /** Working view: the old path of a rename points at the new one. */
  renamedTo: RepoPathSchema.optional(),
  /** Base64 of `renamedTo`'s raw bytes, only when they are not valid UTF-8. */
  renamedToRawPath: RawPathSchema.optional(),
  /**
   * Working view: the working copy replaced what HEAD has at this name with another kind (a
   * tracked file `d` deleted and a directory `d/` created, or the reverse). The listing holds one
   * row per name, the working copy's; this says what HEAD's row was (#9 review).
   */
  replaces: TreeEntryKindSchema.optional(),
  /** Working view, directories: changed paths below it. Absent: none. */
  changes: Count.optional(),
  /** Working view, directories: untracked files below it that no list holds (#43). */
  untrackedOmitted: Count.optional(),
});
export type TreeEntry = z.infer<typeof TreeEntrySchema>;

export const TreeCursorSchema = z.string().max(FILE_CURSOR_MAX_CHARS).regex(TREE_CURSOR_PATTERN);

/** `GET /api/worktrees/:worktreeId/tree`. */
export const TreeQuerySchema = z.object({
  /** The directory (default the root). One trailing `/` is accepted and dropped. */
  path: z
    .string()
    .max(4097)
    .transform((v) => (v.endsWith('/') ? v.slice(0, -1) : v))
    .pipe(TreeDirPathSchema)
    .optional(),
  /** Base64 of the directory's raw bytes (a non-UTF-8 name); wins over `path`. */
  rawPath: RawPathSchema.optional(),
  /** Absent: the working view. Else the tree view of this ref (see the module comment). */
  ref: TreeRefSchema.optional(),
  limit: z.coerce.number().int().min(1).max(TREE_PAGE_MAX).optional(),
  cursor: TreeCursorSchema.optional(),
});
export type TreeQuery = z.output<typeof TreeQuerySchema>;

export const TreeResponseSchema = z.object({
  worktreeId: IdSchema,
  view: z.enum(['working', 'tree']),
  /** The `ref` asked for; null in the working view. */
  ref: z.string().nullable(),
  /** The commit listed (HEAD's in the working view); null on an unborn branch. */
  commit: GitObjectIdSchema.nullable(),
  /** The directory's tree object in that commit; null when the commit has no such directory. */
  tree: GitObjectIdSchema.nullable(),
  path: TreeDirPathSchema,
  rawPath: RawPathSchema.optional(),
  /** Working view: the summary state the overlay is of. Null in the tree view. */
  stateHash: z.string().min(1).nullable(),
  entries: z.array(TreeEntrySchema),
  /** Entries in the whole directory listing. */
  total: Count,
  /** Index of the page's first entry. */
  offset: Count,
  /** The next page's cursor; null at the end. */
  nextCursor: z.string().max(FILE_CURSOR_MAX_CHARS).nullable(),
  /** The page is not the whole listing. */
  truncated: z.boolean(),
  /** The request's cursor was for another listing: this is the first page. */
  restarted: z.boolean(),
  /**
   * Entries of the directory left out of the listing because no client could take them (#9
   * security review P3-2): a name git would never write (`..`, `.`, empty, with `/`), or a path
   * longer than the contracts allow. Absent when none were. `total` and the pages do not count them.
   */
  skipped: z.object({ invalidName: Count, tooLong: Count }).optional(),
});
export type TreeResponse = z.infer<typeof TreeResponseSchema>;

/**
 * Why an entry git-core read from a tree cannot be sent (`TreeEntrySchema` would reject it, and a
 * client would drop the whole page), or null: `invalid_name` for a name git never writes (empty,
 * `.`, `..`, with `/` or NUL) or a path with such a segment; `too_long` above the path and raw-path
 * limits (#9 security review P3-2). Cheap: no schema parse per entry.
 */
export function treeEntryProblem(
  entry: Pick<TreeEntry, 'name' | 'rawName' | 'path' | 'rawPath'>,
): 'invalid_name' | 'too_long' | null {
  const { name, path } = entry;
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\u0000')
  ) {
    return 'invalid_name';
  }
  if (path.length === 0 || path.startsWith('/') || path.includes('\u0000')) return 'invalid_name';
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '..') return 'invalid_name';
  }
  if (name.length > 4096 || path.length > 4096) return 'too_long';
  if ((entry.rawPath?.length ?? 0) > 8192 || (entry.rawName?.length ?? 0) > 8192) return 'too_long';
  return null;
}

/** A directory named by `worktree.changed.dirs`. */
export const ChangedDirSchema = z.object({
  path: TreeDirPathSchema,
  rawPath: RawPathSchema.optional(),
});
export type ChangedDir = z.infer<typeof ChangedDirSchema>;

/**
 * Directories whose working-view listing may have changed with this event (#9): every ancestor of
 * a path whose status, rename pairing or presence moved (a content edit of a modified file moves
 * none), the root included. `all: true` (HEAD moved, the previous state is unknown, or more than
 * `WORKTREE_CHANGED_DIRS_MAX` directories): refresh every open directory. Tree views (`ref`) are
 * never named: a commit's tree does not change.
 */
export const WorktreeChangedDirsSchema = z.object({
  all: z.boolean(),
  dirs: z.array(ChangedDirSchema).max(WORKTREE_CHANGED_DIRS_MAX),
});
export type WorktreeChangedDirs = z.infer<typeof WorktreeChangedDirsSchema>;

// --- order and paging --------------------------------------------------------------------------

/**
 * git's tree order on names given as byte strings (one char per byte, e.g. `latin1`): bytes
 * compared unsigned, a directory compared as if its name ended in `/`.
 */
export function compareTreeNames(a: string, aDir: boolean, b: string, bDir: boolean): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  const ca = a.length > n ? a.charCodeAt(n) : aDir ? 0x2f : -1;
  const cb = b.length > n ? b.charCodeAt(n) : bDir ? 0x2f : -1;
  return ca - cb;
}

export interface TreePageRequest {
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface TreePage<T> {
  entries: T[];
  total: number;
  offset: number;
  nextCursor: string | null;
  truncated: boolean;
  restarted: boolean;
}

/** The identity of one directory listing for its cursors (callers memoize it per listing). */
/**
 * A directory's (or entry's) identity: `r:<base64>` for a raw (non-UTF-8) path, `p:<path>` for a
 * display path. Never `rawPath ?? path`: a directory literally named like the base64 of another's
 * bytes (`ZP8=` and the bytes `64 ff`) would share it (#9 review). Use it for cache keys.
 */
export function treeDirIdentity(dir: { path: string; rawPath?: string | undefined }): string {
  return dir.rawPath !== undefined ? `r:${dir.rawPath}` : `p:${dir.path}`;
}

export function treeListingKey(stateKey: string, entries: readonly TreeEntry[]): string {
  const h = new Hash64().update(stateKey);
  for (const e of entries) {
    h.update(
      `${treeDirIdentity(e)}\u0001${e.replaces ?? ''}\u0001${e.kind}\u0001${e.oid ?? ''}\u0001${e.status ?? ''}\u0001${e.changes ?? ''}\u0001${e.untrackedOmitted ?? ''}\u0001${e.staged ? 1 : 0}${e.unstaged ? 1 : 0}`,
    );
  }
  return h.hex();
}

function decodeTreeCursor(cursor: string): { fingerprint: string; offset: number } | null {
  if (!TREE_CURSOR_PATTERN.test(cursor)) return null;
  const [, fingerprint, offset] = cursor.split('.');
  if (!fingerprint || !offset) return null;
  const n = Number.parseInt(offset, 36);
  return Number.isSafeInteger(n) && n >= 0 ? { fingerprint, offset: n } : null;
}

/**
 * One page of a directory listing (already in tree order): at most `limit` entries (default
 * `TREE_PAGE_DEFAULT`) and `maxBytes` of their JSON (never fewer than one entry), from the
 * cursor's offset when the cursor is of this listing (`listKey`), else from the top with
 * `restarted`.
 */
export function pageTreeEntries<T extends TreeEntry>(
  entries: readonly T[],
  request: TreePageRequest,
  options: { listKey: string; maxBytes?: number },
): TreePage<T> {
  const total = entries.length;
  const fingerprint = new Hash64().update(options.listKey).update('tree').hex();
  let start = 0;
  let restarted = false;
  if (request.cursor !== undefined) {
    const decoded = decodeTreeCursor(request.cursor);
    if (decoded && decoded.fingerprint === fingerprint && decoded.offset <= total) {
      start = decoded.offset;
    } else restarted = true;
  }
  const limit = Math.max(1, Math.min(request.limit ?? TREE_PAGE_DEFAULT, TREE_PAGE_MAX));
  const maxBytes = options.maxBytes ?? TREE_PAGE_MAX_BYTES;
  const out: T[] = [];
  let bytes = 0;
  let end = start;
  while (end < total && out.length < limit) {
    const entry = entries[end] as T;
    const size = utf8Length(JSON.stringify(entry)) + 1;
    if (out.length > 0 && bytes + size > maxBytes) break;
    out.push(entry);
    bytes += size;
    end++;
  }
  return {
    entries: out,
    total,
    offset: start,
    nextCursor: end < total ? `t1.${fingerprint}.${end.toString(36)}` : null,
    truncated: start > 0 || end < total,
    restarted,
  };
}
