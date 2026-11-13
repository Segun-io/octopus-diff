/**
 * The file explorer's working view (#9): HEAD's directory listing (git-core `listTree`) with the
 * worktree's changes laid over it, from the `working` file list the daemon already holds for the
 * state (no git process per request when warm). The rules are in `packages/contracts/src/tree.ts`
 * and docs/DECISIONS.md (#407).
 *
 * Paths are compared as raw bytes ("bstr": one char per byte, latin1), as git compares them: a
 * `rawPath` (base64) wins over `path`, as everywhere in the contracts.
 */
import {
  type ChangedDir,
  compareTreeNames,
  type FileStatus,
  type GitChangedFile,
  type GitTreeEntry,
  type GitTreeListing,
  type SummarySnapshot,
  type TreeEntry,
  treeEntryProblem,
  type UntrackedOmission,
  WORKTREE_CHANGED_DIRS_MAX,
  WORKTREE_CHANGED_DIRS_MAX_CHARS,
  type WorktreeChangedDirs,
} from '@octopus-diff/contracts';

const NON_ASCII = /[\u0080-\uffff]/;
const ASCII = { test: (value: string): boolean => !NON_ASCII.test(value) };
const utf8Fatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8Lossy = new TextDecoder('utf-8', { ignoreBOM: true });

/** A path's bytes as a bstr: `rawPath` (base64) when present, else the UTF-8 of `path`. */
export function bstrOf(p: { path: string; rawPath?: string | undefined }): string {
  if (p.rawPath !== undefined) return Buffer.from(p.rawPath, 'base64').toString('latin1');
  return ASCII.test(p.path) ? p.path : Buffer.from(p.path, 'utf8').toString('latin1');
}

/** A bstr as the contracts' `path` / `rawPath` pair. */
export function decodeBstr(value: string): { path: string; rawPath?: string } {
  if (ASCII.test(value)) return { path: value };
  const bytes = Buffer.from(value, 'latin1');
  try {
    return { path: utf8Fatal.decode(bytes) };
  } catch {
    return { path: utf8Lossy.decode(bytes), rawPath: bytes.toString('base64') };
  }
}

function splitParent(key: string): { parent: string; name: string } {
  const slash = key.lastIndexOf('/');
  return slash === -1
    ? { parent: '', name: key }
    : { parent: key.slice(0, slash), name: key.slice(slash + 1) };
}

/** One changed path, as the explorer shows it. */
interface PathOverlay {
  status: FileStatus;
  staged: boolean;
  unstaged: boolean;
  /** Display path of the rename / copy source, and its raw bytes when not UTF-8. */
  oldPath?: string;
  oldRawPath?: string;
  /** Display path of the rename target (on the source's record), and its raw bytes. */
  renamedTo?: string;
  renamedToRawPath?: string;
  newMode: string | null;
  /** The record comes from a rename's source, not from a file of the list. */
  derived: boolean;
}

/** What lies below a directory, for its row in its parent. */
interface DirAggregate {
  /** Changed paths below (rename sources included) plus omitted untracked files. */
  changes: number;
  /** Records below that are not deletions (exist in the working copy). */
  live: number;
  /** Deletions below (deleted files and rename sources). */
  deleted: number;
  /** Records below that are not untracked. */
  tracked: number;
  /** Untracked files below that no list holds (#43). */
  omitted: number;
}

interface DirOverlay {
  files: Map<string, PathOverlay>;
  dirs: Map<string, DirAggregate>;
}

/** The overlay of one working list, by directory (bstr keys; `''` is the root). */
export interface OverlayIndex {
  byDir: Map<string, DirOverlay>;
  /** Directories git-core omitted as a whole (untracked, #43), by bstr. */
  omittedDirs: Map<string, number>;
}

function dirOf(index: OverlayIndex, key: string): DirOverlay {
  let dir = index.byDir.get(key);
  if (!dir) {
    dir = { files: new Map(), dirs: new Map() };
    index.byDir.set(key, dir);
  }
  return dir;
}

/** Adds `delta` to the aggregates of every directory on the way to `key` (a path below the root). */
function addBelow(
  index: OverlayIndex,
  key: string,
  delta: DirAggregate,
  includeSelf: boolean,
): void {
  const parts = key.split('/');
  const last = includeSelf ? parts.length : parts.length - 1;
  let parent = '';
  for (let i = 0; i < last; i++) {
    const name = parts[i] as string;
    const dir = dirOf(index, parent);
    const agg = dir.dirs.get(name) ?? { changes: 0, live: 0, deleted: 0, tracked: 0, omitted: 0 };
    agg.changes += delta.changes;
    agg.live += delta.live;
    agg.deleted += delta.deleted;
    agg.tracked += delta.tracked;
    agg.omitted += delta.omitted;
    dir.dirs.set(name, agg);
    parent = parent === '' ? name : `${parent}/${name}`;
  }
}

function addRecord(index: OverlayIndex, key: string, record: PathOverlay): void {
  const { parent, name } = splitParent(key);
  const dir = dirOf(index, parent);
  const existing = dir.files.get(name);
  // A file of the list wins over a rename source's derived record at the same path.
  if (existing && !existing.derived) return;
  if (existing) {
    // Replace the derived record: undo its contribution first.
    addBelow(index, key, contribution(existing, -1), false);
  }
  dir.files.set(name, record);
  addBelow(index, key, contribution(record, 1), false);
}

function contribution(record: PathOverlay, sign: 1 | -1): DirAggregate {
  const deleted = record.status === 'deleted';
  return {
    changes: sign,
    live: deleted ? 0 : sign,
    deleted: deleted ? sign : 0,
    tracked: record.status === 'untracked' ? 0 : sign,
    omitted: 0,
  };
}

const overlays = new WeakMap<readonly GitChangedFile[], { key: string; index: OverlayIndex }>();

/**
 * The overlay of a working list (memoized per list array, omission and conflicts). `conflicts`:
 * unmerged paths of the same state (bstr, from the summary's snapshot) that the list may lack: the
 * list holds diffs against HEAD, so a conflict whose working-tree content equals HEAD (`UD` kept as
 * ours) is not in it; such a path is listed as `conflicted` here.
 */
export function overlayIndex(
  files: readonly GitChangedFile[],
  omission: UntrackedOmission | undefined,
  conflicts: readonly string[] = [],
): OverlayIndex {
  const omittedKey = omission
    ? omission.directories.map((d) => `${d.rawPath ?? d.path}:${d.count}`).join('\u0000')
    : '';
  const memoKey = `${omittedKey}\u0001${conflicts.join('\u0000')}`;
  const cached = overlays.get(files);
  if (cached && cached.key === memoKey) return cached.index;
  const index: OverlayIndex = { byDir: new Map(), omittedDirs: new Map() };
  for (const f of files) {
    const key = bstrOf(f);
    if (key === '') continue;
    const record: PathOverlay = {
      status: f.status,
      staged: f.staged,
      unstaged: f.unstaged,
      newMode: f.newMode,
      derived: false,
    };
    if (f.oldPath !== null && (f.status === 'renamed' || f.status === 'copied')) {
      record.oldPath = f.oldPath;
      if (f.oldRawPath !== undefined) record.oldRawPath = f.oldRawPath;
    }
    addRecord(index, key, record);
    if (f.status === 'renamed' && f.oldPath !== null) {
      // The source no longer exists at its old path: listed there as deleted. Its key is its raw
      // bytes (`oldRawPath`), never the lossy display form (PR #99 review).
      addRecord(index, bstrOf({ path: f.oldPath, rawPath: f.oldRawPath }), {
        status: 'deleted',
        staged: f.staged,
        unstaged: f.unstaged,
        renamedTo: f.path,
        ...(f.rawPath !== undefined ? { renamedToRawPath: f.rawPath } : {}),
        newMode: null,
        derived: true,
      });
    }
  }
  for (const key of conflicts) {
    const { parent, name } = splitParent(key);
    if (key === '' || index.byDir.get(parent)?.files.has(name)) continue;
    addRecord(index, key, {
      status: 'conflicted',
      staged: false,
      unstaged: true,
      newMode: null,
      derived: false,
    });
  }
  for (const d of omission?.directories ?? []) {
    const key = bstrOf(d);
    if (key === '') continue;
    index.omittedDirs.set(key, d.count);
    addBelow(
      index,
      key,
      { changes: d.count, live: d.count, deleted: 0, tracked: 0, omitted: d.count },
      true,
    );
  }
  overlays.set(files, { key: memoKey, index });
  return index;
}

/** The overlay holds something at or below `dir` (bstr): the directory exists in the working copy. */
export function overlayHasDir(index: OverlayIndex, dir: string): boolean {
  if (dir === '') return true;
  const entry = index.byDir.get(dir);
  if (entry && (entry.files.size > 0 || entry.dirs.size > 0)) return true;
  return index.omittedDirs.has(dir);
}

function kindOfMode(mode: string | null): TreeEntry['kind'] {
  if (mode === '120000') return 'symlink';
  if (mode === '160000') return 'submodule';
  return 'file';
}

function withName(
  nameKey: string,
  dirKey: string,
): Pick<TreeEntry, 'name' | 'rawName' | 'path' | 'rawPath'> {
  const name = decodeBstr(nameKey);
  const full = decodeBstr(dirKey === '' ? nameKey : `${dirKey}/${nameKey}`);
  return {
    name: name.path,
    ...(name.rawPath !== undefined ? { rawName: name.rawPath } : {}),
    path: full.path,
    ...(full.rawPath !== undefined ? { rawPath: full.rawPath } : {}),
  };
}

function fromGit(entry: GitTreeEntry): TreeEntry {
  return {
    name: entry.name,
    ...(entry.rawName !== undefined ? { rawName: entry.rawName } : {}),
    path: entry.path,
    ...(entry.rawPath !== undefined ? { rawPath: entry.rawPath } : {}),
    kind: entry.kind,
    mode: entry.mode,
    oid: entry.oid,
    size: entry.size,
  };
}

/** The tree view: the commit's entries as they are. */
export function treeEntries(listing: GitTreeListing): TreeEntry[] {
  return listing.entries.map(fromGit);
}

function applyFile(entry: TreeEntry, record: PathOverlay): void {
  entry.status = record.status;
  entry.staged = record.staged;
  entry.unstaged = record.unstaged;
  if (record.oldPath !== undefined) entry.oldPath = record.oldPath;
  if (record.oldRawPath !== undefined) entry.oldRawPath = record.oldRawPath;
  if (record.renamedTo !== undefined) entry.renamedTo = record.renamedTo;
  if (record.renamedToRawPath !== undefined) entry.renamedToRawPath = record.renamedToRawPath;
}

function applyDir(entry: TreeEntry, agg: DirAggregate): void {
  if (agg.changes > 0) entry.changes = agg.changes;
  if (agg.omitted > 0) entry.untrackedOmitted = agg.omitted;
}

/**
 * How many files HEAD directories hold, for the `deleted` status: one directory's
 * (`file(treeOid)`, one `ls-tree -r` of it) or every child directory's of the listed one
 * (`children()`, one `ls-tree -r` of the listed tree; bstr name → count). Null: unknown.
 */
export interface FileCounts {
  file(tree: string): Promise<number | null>;
  children(): Promise<Map<string, number> | null>;
}

/** Up to this many directories to check are counted one by one; more, with one run (P3-3). */
export const COUNT_ONE_BY_ONE_MAX = 4;

/**
 * The working view of one directory (bstr `dirKey`): `listing` (HEAD's, or null when HEAD has no
 * such directory) with the overlay, in tree order. `counts` say how many files a HEAD directory
 * holds; asked only for directories whose every change below is a deletion: one by one for a few,
 * with one run over the listed tree for more (security review P3-3: 2000 such siblings cost 2000
 * processes before).
 */
export async function workingEntries(
  listing: GitTreeListing | null,
  dirKey: string,
  index: OverlayIndex,
  counts: FileCounts | ((tree: string) => Promise<number | null>),
): Promise<TreeEntry[]> {
  const fileCounts: FileCounts =
    typeof counts === 'function' ? { file: counts, children: async () => null } : counts;
  const checks: Array<{ key: string; oid: string; entry: TreeEntry; deleted: number }> = [];
  const overlay = index.byDir.get(dirKey);
  const out: Array<{ key: string; dir: boolean; entry: TreeEntry }> = [];
  const seenFiles = new Set<string>();
  const seenDirs = new Set<string>();
  for (const git of listing?.kind === 'dir' ? listing.entries : []) {
    const entry = fromGit(git);
    const key = bstrOf({ path: git.name, rawPath: git.rawName });
    if (git.kind === 'dir') {
      seenDirs.add(key);
      const agg = overlay?.dirs.get(key);
      if (agg) {
        applyDir(entry, agg);
        if (agg.live === 0 && agg.deleted > 0) {
          checks.push({ key, oid: git.oid, entry, deleted: agg.deleted });
        }
      }
    } else {
      seenFiles.add(key);
      const record = overlay?.files.get(key);
      if (record) applyFile(entry, record);
    }
    out.push({ key, dir: git.kind === 'dir', entry });
  }
  for (const [key, record] of overlay?.files ?? []) {
    if (seenFiles.has(key)) continue;
    const entry: TreeEntry = {
      ...withName(key, dirKey),
      kind: kindOfMode(record.newMode),
      mode: record.newMode,
      oid: null,
      size: null,
    };
    applyFile(entry, record);
    out.push({ key, dir: false, entry });
  }
  for (const [key, agg] of overlay?.dirs ?? []) {
    if (seenDirs.has(key)) continue;
    const entry: TreeEntry = {
      ...withName(key, dirKey),
      kind: 'dir',
      mode: null,
      oid: null,
      size: null,
      status: agg.tracked === 0 ? 'untracked' : agg.live > 0 ? 'added' : 'deleted',
    };
    applyDir(entry, agg);
    out.push({ key, dir: true, entry });
  }
  if (checks.length > COUNT_ONE_BY_ONE_MAX) {
    const byChild = await fileCounts.children();
    for (const c of checks) {
      const count = byChild?.get(c.key);
      if (count !== undefined && count === c.deleted) c.entry.status = 'deleted';
    }
  } else {
    await Promise.all(
      checks.map((c) =>
        fileCounts.file(c.oid).then((count) => {
          if (count !== null && count === c.deleted) c.entry.status = 'deleted';
        }),
      ),
    );
  }
  // One row per name (PR #99 review): when the working copy replaced HEAD's file `d` with a
  // directory `d/` (or a directory with a file), HEAD's row and the working copy's would both be
  // named `d`. The row that exists in the working copy wins and says what it `replaces`.
  const byName = new Map<string, Array<{ key: string; dir: boolean; entry: TreeEntry }>>();
  for (const o of out) {
    const same = byName.get(o.key);
    if (same) same.push(o);
    else byName.set(o.key, [o]);
  }
  const rows: Array<{ key: string; dir: boolean; entry: TreeEntry }> = [];
  for (const same of byName.values()) {
    if (same.length === 1) {
      rows.push(same[0] as (typeof same)[number]);
      continue;
    }
    // At most two: a directory and a non-directory of the same name. A row that exists only in
    // the working copy (no object id) and is live wins; else a live HEAD row; else HEAD's.
    const winner =
      same.find((o) => o.entry.oid === null && live(o.entry)) ??
      same.find((o) => live(o.entry)) ??
      same[0];
    if (!winner) continue;
    const loser = same.find((o) => o !== winner);
    if (loser && loser.entry.oid !== null) winner.entry.replaces = loser.entry.kind;
    rows.push(winner);
  }
  rows.sort((a, b) => compareTreeNames(a.key, a.dir, b.key, b.dir));
  return rows.map((o) => o.entry);
}

/** The row's path exists in the working copy, as far as the row says (`deleted` does not). */
function live(entry: TreeEntry): boolean {
  return entry.status !== 'deleted';
}

// --- directory deltas on `worktree.changed` (#9) ------------------------------------------------

/** What the deltas compare between two summaries: HEAD and each changed path's overlay inputs. */
export interface TreeBasis {
  /** The summary's `stateHash`: `conflicts` describe that state only. */
  stateHash: string;
  head: string | null;
  /** Unmerged paths (bstr), sorted; null when the snapshot was cut by its cap. */
  conflicts: string[] | null;
  truncated: boolean;
  /** bstr path → what its working-view row depends on. */
  paths: Map<string, string>;
  /** The omitted untracked directories (bstr → count), #43. */
  omitted: Map<string, number>;
  /**
   * Paths the working list may pair as a rename (bstr): sources (deleted: `D` in either column, a
   * rename's or copy's old path) and targets (new in the index: `A`, `R`, `C`). Greptile, round 3:
   * `git diff HEAD --find-renames` pairs them by content, so a pair can appear or go while the
   * summary entry of one side (an unstaged ` D`) stays the same.
   */
  candidates: Set<string>;
}

/** Status letters of a path the working list's rename detection may take as a source / target. */
function renameRole(xy: string): { source: boolean; target: boolean } {
  const x = xy[0] ?? '.';
  const y = xy[1] ?? '.';
  return {
    source: x === 'D' || y === 'D',
    target: x === 'A' || x === 'R' || x === 'C' || y === 'A',
  };
}

/** Unmerged status pairs (`git status`): both sides touched the path. */
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

export function treeBasis(
  stateHash: string,
  head: string | null,
  snapshot: SummarySnapshot,
  omission: UntrackedOmission | undefined,
): TreeBasis {
  const paths = new Map<string, string>();
  const conflicts: string[] = [];
  const candidates = new Set<string>();
  for (const e of snapshot.entries) {
    if (e.xy !== '??' && !UNMERGED.has(e.xy)) {
      const role = renameRole(e.xy);
      if (role.source || role.target) candidates.add(bstrOf({ path: e.path, rawPath: e.rawPath }));
      if (e.oldPath !== undefined)
        candidates.add(bstrOf({ path: e.oldPath, rawPath: e.oldRawPath }));
    }
    if (UNMERGED.has(e.xy)) conflicts.push(bstrOf({ path: e.path, rawPath: e.rawPath }));
    const old = e.oldRawPath !== undefined ? `r:${e.oldRawPath}` : `p:${e.oldPath ?? ''}`;
    // Every field of the entry (PR #99 review): a content edit alone can move a row. An `MM` path
    // whose working content goes back to HEAD's leaves the working list (`git diff HEAD`) with the
    // same status letters; an added or deleted path can pair up as a rename; a submodule's commit
    // is in its signature. The cost is a refresh of the edited file's open ancestors, which are
    // warm listings.
    paths.set(
      bstrOf({ path: e.path, rawPath: e.rawPath }),
      `${e.xy}\u0000${old}\u0000${e.sig}\u0000${e.hH ?? ''}\u0000${e.hI ?? ''}`,
    );
    if (e.oldPath !== undefined) {
      const oldKey = bstrOf({ path: e.oldPath, rawPath: e.oldRawPath });
      if (!paths.has(oldKey)) paths.set(oldKey, `source\u0000${e.path}`);
    }
  }
  const omitted = new Map<string, number>();
  for (const d of omission?.directories ?? []) omitted.set(bstrOf(d), d.count);
  return {
    stateHash,
    head,
    conflicts: snapshot.truncated ? null : conflicts.sort(),
    truncated: snapshot.truncated,
    paths,
    omitted,
    candidates,
  };
}

function addAncestors(out: Set<string>, key: string, self: boolean): void {
  let at = self ? key.length : key.lastIndexOf('/');
  while (at > 0) {
    out.add(key.slice(0, at));
    at = key.lastIndexOf('/', at - 1);
  }
  out.add('');
}

/**
 * The directories whose working-view listing may differ between `prev` and `cur`: the ancestors of
 * every path whose overlay inputs moved (the root included), and of every omitted directory that
 * appeared, went or changed its count. `all` when HEAD moved, a snapshot was cut by its cap, or
 * there are more than the caps allow.
 */
export function treeDelta(prev: TreeBasis, cur: TreeBasis): WorktreeChangedDirs {
  const all: WorktreeChangedDirs = { all: true, dirs: [] };
  if (prev.head !== cur.head || prev.truncated || cur.truncated) return all;
  const dirs = new Set<string>();
  let pairing = false;
  const moved = (key: string) => {
    addAncestors(dirs, key, false);
    if (prev.candidates.has(key) || cur.candidates.has(key)) pairing = true;
  };
  for (const [key, value] of cur.paths) {
    if (prev.paths.get(key) !== value) moved(key);
  }
  for (const key of prev.paths.keys()) {
    if (!cur.paths.has(key)) moved(key);
  }
  // A rename candidate moved: the working list may pair (or unpair) it with any other candidate,
  // whose own entry did not change. Every candidate's directories, of both states (Greptile, round 3).
  if (pairing) {
    for (const key of prev.candidates) addAncestors(dirs, key, false);
    for (const key of cur.candidates) addAncestors(dirs, key, false);
  }
  for (const [key, count] of cur.omitted) {
    if (prev.omitted.get(key) !== count) addAncestors(dirs, key, true);
  }
  for (const key of prev.omitted.keys()) {
    if (!cur.omitted.has(key)) addAncestors(dirs, key, true);
  }
  if (dirs.size > WORKTREE_CHANGED_DIRS_MAX) return all;
  const out: ChangedDir[] = [];
  let chars = 0;
  for (const key of [...dirs].sort()) {
    const dir = decodeBstr(key);
    chars += dir.path.length + (dir.rawPath?.length ?? 0);
    if (chars > WORKTREE_CHANGED_DIRS_MAX_CHARS) return all;
    out.push(dir);
  }
  return { all: false, dirs: out };
}

// --- sendable entries and the composed-listing cache (security review P3-2, P2-2) --------------

/**
 * The entries a client can take, and how many were left out (`treeEntryProblem`): a hostile tree
 * (`hash-object -t tree --literally`) with a `..` or `a/b` entry, or paths past the limits, must not
 * make the whole page fail the client's schema.
 */
export function sendableEntries(entries: TreeEntry[]): {
  entries: TreeEntry[];
  skipped: { invalidName: number; tooLong: number } | null;
} {
  let invalidName = 0;
  let tooLong = 0;
  const kept: TreeEntry[] = [];
  for (const e of entries) {
    const problem = treeEntryProblem(e);
    if (problem === 'invalid_name') invalidName++;
    else if (problem === 'too_long') tooLong++;
    else kept.push(e);
  }
  return {
    entries: invalidName + tooLong === 0 ? entries : kept,
    skipped: invalidName + tooLong === 0 ? null : { invalidName, tooLong },
  };
}

/** A directory key a listing can name (the checks git-core makes, also where it is not asked). */
export function dirKeyProblem(dirKey: string): string | null {
  if (dirKey === '') return null;
  if (dirKey.length > 4096) return 'path is too long';
  for (const part of dirKey.split('/')) {
    if (part === '' || part === '.' || part === '..' || part.includes('\u0000')) {
      return 'path must be a repo-relative directory without empty, "." or ".." components';
    }
  }
  return null;
}

/** A composed `GET /tree` listing (#9) and what it is of. */
export interface TreeListingMemo {
  entries: TreeEntry[];
  listKey: string;
  commit: string | null;
  tree: string | null;
  skipped: { invalidName: number; tooLong: number } | null;
  /** Estimated bytes held (`estimateListingBytes`). */
  bytes: number;
}

const TREE_ENTRY_OVERHEAD_BYTES = 200;

/** An estimate of the memory a composed listing holds: its strings (UTF-16) and per-entry objects. */
export function estimateListingBytes(entries: readonly TreeEntry[]): number {
  let bytes = 0;
  for (const e of entries) {
    bytes +=
      TREE_ENTRY_OVERHEAD_BYTES +
      2 *
        (e.name.length +
          e.path.length +
          (e.rawName?.length ?? 0) +
          (e.rawPath?.length ?? 0) +
          (e.oldPath?.length ?? 0) +
          (e.oldRawPath?.length ?? 0) +
          (e.renamedTo?.length ?? 0) +
          (e.renamedToRawPath?.length ?? 0));
  }
  return bytes;
}

/** Default bound of the daemon's composed listings (as git-core's tree cache). */
export const TREE_LISTINGS_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The daemon's composed listings, an LRU bounded by bytes (security review P2-2: it was bounded by
 * count, 64 listings of a 100k-entry directory held about 0.6 GB). A listing above the bound is
 * served, not kept. `dropOlderStates` drops a worktree's working-view listings of other states when
 * a new summary lands: an agent churning a worktree no longer piles up a copy per state.
 */
export class TreeListingCache {
  readonly #map = new Map<string, TreeListingMemo>();
  #bytes = 0;

  constructor(readonly maxBytes = TREE_LISTINGS_MAX_BYTES) {}

  get bytes(): number {
    return this.#bytes;
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: string): TreeListingMemo | undefined {
    const hit = this.#map.get(key);
    if (hit) {
      this.#map.delete(key);
      this.#map.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: TreeListingMemo): void {
    this.delete(key);
    if (value.bytes > this.maxBytes) return;
    this.#map.set(key, value);
    this.#bytes += value.bytes;
    while (this.#bytes > this.maxBytes) {
      const oldest = this.#map.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  delete(key: string): void {
    const old = this.#map.get(key);
    if (!old) return;
    this.#bytes -= old.bytes;
    this.#map.delete(key);
  }

  /** Drops the working-view listings of `worktreeId` that are not of `stateHash` (all with null). */
  dropOlderStates(worktreeId: string, stateHash: string | null): void {
    const prefix = `w\u0000${worktreeId}\u0000`;
    const keep = stateHash === null ? null : `${prefix}${stateHash}\u0000`;
    for (const key of [...this.#map.keys()]) {
      if (key.startsWith(prefix) && (keep === null || !key.startsWith(keep))) this.delete(key);
    }
  }
}
