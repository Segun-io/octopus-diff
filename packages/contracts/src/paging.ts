/**
 * Paged file lists (#42): the one order every file list is paged in, the page and cursor rules,
 * the per-list counts, and the file search's matcher. Pure and browser-safe: the daemon pages its
 * cached lists with it and the web mock pages its fixtures with it, so both answer alike.
 *
 * - **Order** (`compareFileOrder`): own and mixed files first, then the ones that came from the
 *   default branch (`origin: 'base'`, the list's "from main" group), each part by path in UTF-16
 *   code-unit order, then by `rawPath`. That is the web list's display order (`ownFirst(sortFiles())`).
 * - **A page** is a slice of the list's *view*: the ordered list after the filters (`unreviewed`,
 *   `origin`, `q`). It starts at the cursor's offset, after `after`, or at the top; it holds at
 *   most `limit` files and stops before its files' JSON passes `maxBytes` (never fewer than one
 *   file, so paging always moves on).
 * - **The cursor** is opaque to clients. It names the view (`fingerprint`: the list's state and
 *   order, the filters, and for `unreviewed` which files are reviewed) and the offset of the next
 *   page. A cursor for another view (the worktree changed, marks moved an `unreviewed` view, a
 *   daemon that lists the same state differently) answers with the view's first page and
 *   `restarted: true`: the client drops what it had and pages again. Paging a list in pages of any
 *   size therefore yields every file of one state exactly once.
 */
import type { ChangedFile, FileListCounts } from './domain.js';

/** Most files one `GET /files?limit=` page holds. */
export const FILES_PAGE_MAX = 2000;
/** The page size the web asks for. */
export const FILES_PAGE_DEFAULT = 500;
/**
 * Files a `GET /files` without `limit` (an older client) answers with at most: the first ones in
 * the list's order, with `truncated: true` when there are more. Above it a list is only paged.
 */
export const FILES_UNPAGED_MAX = 2000;
/**
 * Bytes of file rows (their JSON) one page carries at most, so a response stays under about 1 MB
 * with its envelope (`untrackedOmitted` is bounded too). Paths up to 4096 characters make the
 * row count alone no bound.
 */
export const FILES_PAGE_MAX_BYTES = 900_000;
/** Files one inbox row carries by default (`filesLimit`), the first page of its list. */
export const INBOX_FILES_PER_WORKTREE = 200;
/** Files one inbox response carries at most, over every row; later rows get fewer (or none). */
export const INBOX_FILES_MAX = 4000;
/** Bytes of file rows one inbox response carries at most (as `FILES_PAGE_MAX_BYTES`). */
export const INBOX_FILES_MAX_BYTES = 900_000;
/** Longest `q` (the file search) a `GET /files` takes. */
export const FILES_SEARCH_MAX_CHARS = 200;
/** Longest cursor a daemon hands out (and accepts). */
export const FILE_CURSOR_MAX_CHARS = 64;
/** What a cursor looks like: `<version>.<fingerprint>.<offset>`, opaque to clients. */
export const FILE_CURSOR_PATTERN = /^[0-9a-z]{1,4}\.[0-9a-f]{1,32}\.[0-9a-z]{1,12}$/;

type Ordered = Pick<ChangedFile, 'path' | 'rawPath' | 'origin'>;

/** The file came from the default branch (merge noise, #31): the list's "from main" group. */
export function isBaseOrigin(file: Pick<ChangedFile, 'origin'>): boolean {
  return file.origin === 'base';
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** By path in UTF-16 code-unit order, then `rawPath` (no origin). The web's `compareFiles`. */
export function comparePaths(
  a: Pick<ChangedFile, 'path' | 'rawPath'>,
  b: Pick<ChangedFile, 'path' | 'rawPath'>,
): number {
  return cmp(a.path, b.path) || cmp(a.rawPath ?? '', b.rawPath ?? '');
}

/** The order every file list is paged in (see the module comment). */
export function compareFileOrder(a: Ordered, b: Ordered): number {
  const ab = isBaseOrigin(a) ? 1 : 0;
  const bb = isBaseOrigin(b) ? 1 : 0;
  return ab - bb || comparePaths(a, b);
}

/** A sorted copy in `compareFileOrder`. */
export function orderFiles<T extends Ordered>(files: readonly T[]): T[] {
  return [...files].sort(compareFileOrder);
}

/** A file's identity in a list: `rawPath` wins over `path`, as everywhere else. */
export function fileListEntryKey(file: Pick<ChangedFile, 'path' | 'rawPath'>): string {
  return file.rawPath === undefined ? `p:${file.path}` : `r:${file.rawPath}`;
}

/** Counts of a whole list (before any filter), for counts and plans that must not depend on pages. */
export function fileListCounts(
  files: readonly Pick<ChangedFile, 'reviewed' | 'origin'>[],
): FileListCounts {
  let reviewed = 0;
  let base = 0;
  let baseReviewed = 0;
  for (const f of files) {
    const isBase = isBaseOrigin(f);
    if (f.reviewed) reviewed++;
    if (isBase) {
      base++;
      if (f.reviewed) baseReviewed++;
    }
  }
  return { total: files.length, reviewed, base, baseReviewed };
}

// --- hashing (not cryptographic: a cursor only pages a list its holder may read anyway) --------

/** A small 64-bit string hash for list identities and cursors (also used by `tree.ts`, #9). */
export class Hash64 {
  #a = 0x811c9dc5;
  #b = 0x01000193 ^ 0x9e3779b9;
  update(text: string): this {
    let a = this.#a;
    let b = this.#b;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x5bd1e995);
      b ^= b >>> 15;
    }
    // A separator, so ["ab", "c"] and ["a", "bc"] differ.
    a = Math.imul(a ^ 0xff, 0x01000193);
    b = Math.imul(b ^ 0xff, 0x5bd1e995);
    this.#a = a;
    this.#b = b;
    return this;
  }
  hex(): string {
    return (
      (this.#a >>> 0).toString(16).padStart(8, '0') + (this.#b >>> 0).toString(16).padStart(8, '0')
    );
  }
}

/**
 * The identity of an ordered list for its cursors: the state it is of (`stateKey`, e.g. the
 * worktree's `stateHash` and the scope) and every file's place and group. Callers holding a list
 * for long memoize it per list.
 */
export function fileListKey(stateKey: string, ordered: readonly Ordered[]): string {
  const h = new Hash64().update(stateKey);
  for (const f of ordered) h.update(`${isBaseOrigin(f) ? 'b' : 'o'}${fileListEntryKey(f)}`);
  return h.hex();
}

// --- the file search (shared with the palette, #42) --------------------------------------------

export interface FuzzyMatch {
  score: number;
  /** Indexes of the matched characters in the haystack (for highlighting). */
  positions: number[];
}

/**
 * Small subsequence fuzzy matcher (the command palette's, moved here so the daemon's file search
 * ranks like the palette). Scores prefer matches at word starts, consecutive runs and shorter
 * haystacks; null when the query is not a subsequence.
 */
export function fuzzyMatch(query: string, haystack: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const h = haystack.toLowerCase();
  if (q.length === 0) return { score: 0, positions: [] };
  const positions: number[] = [];
  let score = 0;
  let hi = 0;
  let lastMatch = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi] as string;
    const found = h.indexOf(ch, hi);
    if (found === -1) return null;
    positions.push(found);
    const prev = found === 0 ? ' ' : (h[found - 1] as string);
    const wordStart = found === 0 || /[\s/\-_.:·]/.test(prev);
    score += wordStart ? 10 : 1;
    if (found === lastMatch + 1) score += 6;
    if (found === qi) score += 3; // prefix run
    lastMatch = found;
    hi = found + 1;
  }
  score -= Math.min(20, Math.floor(h.length / 8));
  return { score, positions };
}

// --- pages ----------------------------------------------------------------------------------

export type FileOriginFilter = 'own' | 'base';

/** What a page request asks for (the `GET /files` paging parameters). */
export interface FilePageRequest {
  /** Most files in the page; absent: the caller's default. */
  limit?: number | undefined;
  /** A cursor from an earlier page of the same view; wins over `after`. */
  cursor?: string | undefined;
  /** Start after this file (in the list's order); not in the list: where it would sort (as own). */
  after?: { path: string; rawPath?: string | undefined } | undefined;
  /** Only files not reviewed. */
  unreviewed?: boolean | undefined;
  /** Only own and mixed files (`own`), or only the ones from the default branch (`base`). */
  origin?: FileOriginFilter | undefined;
  /** File search: only files whose path matches (`fuzzyMatch`), best first; `after` is ignored. */
  q?: string | undefined;
}

export interface FilePage<T> {
  files: T[];
  /** Files in the view (the list after the filters). */
  total: number;
  /** Index of the first file of the page in the view. */
  offset: number;
  /** Index of the first file of the page in the whole ordered list; null for an empty page. */
  position: number | null;
  /** Cursor of the next page; null when the page ends the view. */
  nextCursor: string | null;
  /** The page is not the whole view. */
  truncated: boolean;
  /** The request's cursor was for another view: this is the view's first page. */
  restarted: boolean;
}

export interface FilePageOptions {
  /** `fileListKey` of the ordered list. */
  listKey: string;
  /** Files when the request has no `limit`. */
  defaultLimit: number;
  /** Bytes of the page's file rows (JSON) at most; at least one file is always returned. */
  maxBytes: number;
}

const CURSOR_VERSION = '1';

/** UTF-8 length of a string, without allocating it. */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

function filterKey(request: FilePageRequest): string {
  return `u${request.unreviewed ? 1 : 0}|o${request.origin ?? ''}|q${request.q ?? ''}`;
}

function decodeCursor(cursor: string): { fingerprint: string; offset: number } | null {
  if (!FILE_CURSOR_PATTERN.test(cursor)) return null;
  const [version, fingerprint, offset] = cursor.split('.');
  if (version !== CURSOR_VERSION || !fingerprint || !offset) return null;
  const n = Number.parseInt(offset, 36);
  return Number.isSafeInteger(n) && n >= 0 ? { fingerprint, offset: n } : null;
}

function encodeCursor(fingerprint: string, offset: number): string {
  return `${CURSOR_VERSION}.${fingerprint}.${offset.toString(36)}`;
}

/** Where `after` sits in the ordered list: the index of the first file that comes after it. */
function indexAfter(ordered: readonly Ordered[], after: NonNullable<FilePageRequest['after']>) {
  const key = fileListEntryKey(after);
  for (let i = 0; i < ordered.length; i++) {
    if (fileListEntryKey(ordered[i] as Ordered) === key) return i + 1;
  }
  // Not in the list (gone meanwhile): where it would sort, as an own file.
  const probe: Ordered = { path: after.path, rawPath: after.rawPath, origin: 'own' };
  let lo = 0;
  let hi = ordered.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareFileOrder(ordered[mid] as Ordered, probe) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * One page of `ordered` (already in `compareFileOrder`, with `reviewed` attached) for `request`
 * (see the module comment).
 */
export function pageFileList<T extends Ordered & Pick<ChangedFile, 'reviewed'>>(
  ordered: readonly T[],
  request: FilePageRequest,
  options: FilePageOptions,
): FilePage<T> {
  const q = request.q?.trim() ? request.q : undefined;
  const filtered = request.unreviewed === true || request.origin !== undefined || q !== undefined;
  // The view, as indexes into `ordered`.
  let view: number[] | null = null;
  if (filtered) {
    const keep: Array<{ index: number; score: number }> = [];
    for (let i = 0; i < ordered.length; i++) {
      const f = ordered[i] as T;
      if (request.unreviewed && f.reviewed) continue;
      if (request.origin === 'own' && isBaseOrigin(f)) continue;
      if (request.origin === 'base' && !isBaseOrigin(f)) continue;
      if (q !== undefined) {
        const match = fuzzyMatch(q, f.path);
        if (!match) continue;
        keep.push({ index: i, score: match.score });
      } else keep.push({ index: i, score: 0 });
    }
    if (q !== undefined) keep.sort((a, b) => b.score - a.score || a.index - b.index);
    view = keep.map((k) => k.index);
  }
  const total = view ? view.length : ordered.length;
  const at = (i: number): number => (view ? (view[i] as number) : i);

  const hash = new Hash64().update(options.listKey).update(filterKey(request));
  // An `unreviewed` view changes with the marks: which files are reviewed is part of it.
  if (request.unreviewed) {
    let bits = '';
    for (let i = 0; i < ordered.length; i++) {
      bits += (ordered[i] as T).reviewed ? '1' : '0';
      if (bits.length >= 4096) {
        hash.update(bits);
        bits = '';
      }
    }
    hash.update(bits);
  }
  const fingerprint = hash.hex();

  let start = 0;
  let restarted = false;
  if (request.cursor !== undefined) {
    const decoded = decodeCursor(request.cursor);
    if (decoded && decoded.fingerprint === fingerprint && decoded.offset <= total) {
      start = decoded.offset;
    } else restarted = true;
  } else if (request.after !== undefined && q === undefined) {
    const from = indexAfter(ordered, request.after);
    if (view) {
      let lo = 0;
      let hi = view.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((view[mid] as number) < from) lo = mid + 1;
        else hi = mid;
      }
      start = lo;
    } else start = from;
  }

  const limit = Math.max(0, request.limit ?? options.defaultLimit);
  const files: T[] = [];
  let bytes = 0;
  let end = start;
  while (end < total && files.length < limit) {
    const file = ordered[at(end)] as T;
    const size = utf8Length(JSON.stringify(file)) + 1;
    if (files.length > 0 && bytes + size > options.maxBytes) break;
    files.push(file);
    bytes += size;
    end++;
  }
  return {
    files,
    total,
    offset: start,
    position: files.length > 0 ? at(start) : null,
    nextCursor: end < total ? encodeCursor(fingerprint, end) : null,
    truncated: start > 0 || end < total,
    restarted,
  };
}
