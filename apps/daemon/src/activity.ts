import {
  ACTIVITY_BULK_THRESHOLD,
  ACTIVITY_COALESCE_MS,
  ACTIVITY_GLOBAL_MAX,
  ACTIVITY_PATHS_MAX,
  ACTIVITY_RING_SIZE,
  type ActivityEntry,
  type ActivityHeadOp,
  type CommitInfo,
  type FileOrigin,
  type FileOriginVia,
  type InProgressOperation,
  type SummarySnapshot,
  type SummarySnapshotEntry,
  type WorktreeSummary,
} from '@octopus-diff/contracts';

/**
 * The live view's activity feed (#38): diffs consecutive summary snapshots of a worktree into
 * entries and keeps them in a ring **in memory only** (never written to the store or disk). The
 * first snapshot after start is a baseline: it produces no entries.
 *
 * Pure parts (`snapshotState`, `classifyHead`, `diffSnapshots`) do no I/O; `ActivityStore` holds
 * the rings, applies coalescing and the caps, and answers the routes.
 */

/** Estimated bytes of all rings together (V8 one-byte strings); the oldest entries go first above it. */
export const ACTIVITY_BYTES_MAX = 4 * 1024 * 1024;
/** Commits read to classify a HEAD move (`listCommits` limit): one `git log` per move. */
export const HEAD_CLASSIFY_COMMITS = 32;
/** Linear runs of new commits longer than this are reported as one `head` (`merge`) entry. */
const COMMIT_RUN_MAX = 10;

/** HEAD facts of one summary. */
export interface HeadState {
  sha: string | null;
  branch: string | null;
  detached: boolean;
  inProgress: InProgressOperation | null;
  aheadBehindRef: string | null;
  ahead: number | null;
  behind: number | null;
}

/** One summary's snapshot, keyed by path (`rawPath ?? path`), plus its HEAD facts. */
export interface SnapshotState {
  entries: ReadonlyMap<string, SummarySnapshotEntry>;
  total: number;
  truncated: boolean;
  head: HeadState;
}

export function entryKey(e: Pick<SummarySnapshotEntry, 'path' | 'rawPath'>): string {
  return e.rawPath ?? e.path;
}

export function snapshotState(
  summary: Pick<
    WorktreeSummary,
    'headSha' | 'branch' | 'detached' | 'inProgress' | 'aheadBehindRef' | 'ahead' | 'behind'
  >,
  snapshot: SummarySnapshot,
): SnapshotState {
  const entries = new Map<string, SummarySnapshotEntry>();
  for (const e of snapshot.entries) entries.set(entryKey(e), e);
  return {
    entries,
    total: snapshot.total,
    truncated: snapshot.truncated,
    head: {
      sha: summary.headSha,
      branch: summary.branch,
      detached: summary.detached,
      inProgress: summary.inProgress,
      aheadBehindRef: summary.aheadBehindRef,
      ahead: summary.ahead,
      behind: summary.behind,
    },
  };
}

/** Unmerged status letters (`git status` "unmerged" entries). */
function isUnmerged(xy: string): boolean {
  return xy.includes('U') || xy === 'AA' || xy === 'DD';
}

/** The path is deleted in the index or the working tree (not a conflict, not untracked). */
export function isDeletion(xy: string): boolean {
  return xy !== '??' && !isUnmerged(xy) && xy.includes('D');
}

/** Uncommitted tracked deletions of a snapshot (`counts.deleted`, state-based). */
export function countDeleted(snapshot: SummarySnapshot): number {
  let n = 0;
  for (const e of snapshot.entries) if (isDeletion(e.xy)) n++;
  return n;
}

// ---------------------------------------------------------------------------------------------
// HEAD moves
// ---------------------------------------------------------------------------------------------

/** What moved HEAD between two snapshots. */
export type HeadChange =
  | { kind: 'commit'; commits: Array<Pick<CommitInfo, 'sha' | 'subject'>> }
  | { kind: 'head'; op: ActivityHeadOp };

/** HEAD moved to another commit, branch or detached state, or an operation started or ended. */
export function headDiffers(prev: HeadState, cur: HeadState): boolean {
  return (
    prev.sha !== cur.sha ||
    prev.branch !== cur.branch ||
    prev.detached !== cur.detached ||
    prev.inProgress !== cur.inProgress
  );
}

/** A HEAD move that needs the commit list to classify (same branch, no operation either side). */
export function needsCommits(prev: HeadState, cur: HeadState): boolean {
  return (
    prev.sha !== cur.sha &&
    cur.sha !== null &&
    prev.branch === cur.branch &&
    prev.detached === cur.detached &&
    prev.inProgress === null &&
    cur.inProgress === null
  );
}

/**
 * Classifies a HEAD change from the two HEAD states and, for a move on the same branch, the newest
 * commits of the new HEAD (`listCommits`; null when not read or the read failed).
 */
export function classifyHead(
  prev: HeadState,
  cur: HeadState,
  commits: readonly CommitInfo[] | null,
): HeadChange | null {
  if (!headDiffers(prev, cur)) return null;
  const op = cur.inProgress ?? prev.inProgress;
  if (op !== null) return { kind: 'head', op };
  if (prev.branch !== cur.branch || prev.detached !== cur.detached) {
    return { kind: 'head', op: 'checkout' };
  }
  if (prev.sha === cur.sha) return null;
  if (commits === null || commits.length === 0 || commits[0]?.sha !== cur.sha) {
    return { kind: 'head', op: 'moved' };
  }
  // The new commits since the previous HEAD, newest first, while they form a linear run.
  const run: CommitInfo[] = [];
  for (const c of commits) {
    if (c.sha === prev.sha) break;
    if (c.parents.length > 1) return { kind: 'head', op: 'merge' };
    run.push(c);
    if (prev.sha === null && c.parents.length === 0) break; // the first commit of an unborn branch
  }
  const reached = prev.sha === null ? run.length > 0 : run.length < commits.length;
  if (!reached) return { kind: 'head', op: cur.detached ? 'checkout' : 'reset' };
  // A pull or fast-forward of the upstream lowers `behind`; own commits do not.
  const sameRef = prev.aheadBehindRef !== null && prev.aheadBehindRef === cur.aheadBehindRef;
  if (sameRef && prev.behind !== null && cur.behind !== null && cur.behind < prev.behind) {
    return { kind: 'head', op: 'merge' };
  }
  if (run.length > COMMIT_RUN_MAX) return { kind: 'head', op: 'merge' };
  return {
    kind: 'commit',
    commits: run.reverse().map((c) => ({ sha: c.sha, subject: c.subject })),
  };
}

// ---------------------------------------------------------------------------------------------
// Snapshot diff
// ---------------------------------------------------------------------------------------------

export type FileActivityKind = 'added' | 'modified' | 'deleted' | 'restored';

/** An entry before it gets an id, a sequence number and times. */
export type ActivityDraft = Omit<ActivityEntry, 'id' | 'seq' | 'at' | 'updatedAt' | 'count'>;

export interface OriginLabel {
  origin: FileOrigin;
  originVia?: FileOriginVia;
}

function sample(paths: readonly string[]): { paths: string[]; pathCount: number } {
  return { paths: paths.slice(0, ACTIVITY_PATHS_MAX), pathCount: paths.length };
}

function changedContent(a: SummarySnapshotEntry, b: SummarySnapshotEntry): boolean {
  return (
    a.sig !== b.sig ||
    isDeletion(a.xy) !== isDeletion(b.xy) ||
    a.added !== b.added ||
    a.deleted !== b.deleted
  );
}

function fileDraft(
  kind: FileActivityKind,
  e: SummarySnapshotEntry,
  extra: Partial<ActivityDraft> = {},
): ActivityDraft {
  const d: ActivityDraft = { kind, path: e.path };
  if (e.rawPath !== undefined) d.rawPath = e.rawPath;
  if (e.oldPath !== undefined && kind !== 'restored') d.oldPath = e.oldPath;
  if (kind !== 'restored') {
    d.xy = e.xy;
    d.added = e.added;
    d.deleted = e.deleted;
  }
  return Object.assign(d, extra);
}

/** The blob of a deleted tracked file: the index version, else HEAD's. */
function deletedOid(e: SummarySnapshotEntry): string | null {
  return e.hI ?? e.hH;
}

/**
 * The entries one refresh produces. Files that left the uncommitted set together with a HEAD change
 * are listed on the `commit` / `head` entry (committed, merged or checked out), not as restored.
 * More than `ACTIVITY_BULK_THRESHOLD` file changes fold into one `bulk` entry; a truncated snapshot
 * on either side gives one coarse `bulk` entry when anything differs.
 */
export function diffSnapshots(
  prev: SnapshotState,
  cur: SnapshotState,
  head: HeadChange | null,
  origins: ReadonlyMap<string, OriginLabel> | null = null,
): ActivityDraft[] {
  const files: ActivityDraft[] = [];
  const left: string[] = [];
  const coarse = prev.truncated || cur.truncated;
  let coarseChanged = prev.total !== cur.total;
  for (const [key, c] of cur.entries) {
    const p = prev.entries.get(key);
    if (coarse) {
      if (!p || changedContent(p, c)) coarseChanged = true;
      continue;
    }
    let draft: ActivityDraft | null = null;
    if (!p) {
      if (isDeletion(c.xy)) draft = fileDraft('deleted', c, { oid: deletedOid(c) });
      else if (c.xy === '??' || c.xy[0] === 'A' || c.xy[0] === 'R' || c.xy[0] === 'C') {
        draft = fileDraft('added', c);
      } else draft = fileDraft('modified', c);
    } else if (changedContent(p, c)) {
      const was = isDeletion(p.xy);
      const is = isDeletion(c.xy);
      if (!was && is) draft = fileDraft('deleted', c, { oid: deletedOid(c) ?? deletedOid(p) });
      else if (was && !is) draft = fileDraft('added', c);
      else draft = fileDraft('modified', c);
    }
    if (draft) files.push(draft);
  }
  for (const [key, p] of prev.entries) {
    if (cur.entries.has(key)) continue;
    if (coarse) {
      coarseChanged = true;
      continue;
    }
    if (head !== null) {
      left.push(p.path);
    } else if (p.xy === '??') {
      files.push(fileDraft('deleted', p, { xy: '??', oid: null, untracked: true }));
    } else if (p.hH === null && p.hI !== null && !isDeletion(p.xy)) {
      // Added to the index, never committed, now gone without a commit: deleted (or unstaged and
      // ignored); its staged content is still a blob.
      files.push(fileDraft('deleted', p, { xy: p.xy, oid: p.hI, added: null, deleted: null }));
    } else {
      files.push(fileDraft('restored', p));
    }
  }

  const out: ActivityDraft[] = [];
  if (head?.kind === 'commit') {
    head.commits.forEach((c, i) => {
      const last = i === head.commits.length - 1;
      out.push({
        kind: 'commit',
        sha: c.sha,
        subject: c.subject,
        from: i === 0 ? prev.head.sha : (head.commits[i - 1]?.sha ?? null),
        to: c.sha,
        ...(last && !coarse ? sample(left) : {}),
      });
    });
  } else if (head?.kind === 'head') {
    out.push({
      kind: 'head',
      op: head.op,
      from: prev.head.sha,
      to: cur.head.sha,
      branch: cur.head.detached ? null : cur.head.branch,
      fromBranch: prev.head.detached ? null : prev.head.branch,
      inProgress: cur.head.inProgress,
      ...(coarse ? {} : sample(left)),
    });
  }

  const label = (d: ActivityDraft): ActivityDraft => {
    const o = origins?.get(d.rawPath ?? d.path ?? '');
    if (!o) return d;
    d.origin = o.origin;
    if (o.originVia !== undefined) d.originVia = o.originVia;
    return d;
  };

  if (coarse) {
    if (coarseChanged) {
      out.push({ kind: 'bulk', truncated: true, paths: [], pathCount: cur.total });
    }
  } else if (files.length > ACTIVITY_BULK_THRESHOLD) {
    const kinds = { added: 0, modified: 0, deleted: 0, restored: 0 };
    let base = origins !== null;
    for (const f of files) {
      kinds[f.kind as FileActivityKind]++;
      if (base && origins?.get(f.rawPath ?? f.path ?? '')?.origin !== 'base') base = false;
    }
    out.push({
      kind: 'bulk',
      kinds,
      ...sample(files.map((f) => f.path ?? '')),
      ...(base ? { origin: 'base' as const } : {}),
    });
  } else {
    for (const f of files) out.push(label(f));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The rings
// ---------------------------------------------------------------------------------------------

interface StoredEntry {
  entry: ActivityEntry;
  /** `updatedAt` in ms (coalescing window). */
  updatedMs: number;
  bytes: number;
}

interface Ring {
  entries: StoredEntry[];
  /** The latest entry per path (file kinds) and the latest `head` entry, for coalescing. */
  latestByPath: Map<string, StoredEntry>;
  latestHead: StoredEntry | null;
  /** Highest `seq` dropped by a cap (0 = none). */
  droppedSeq: number;
  seq: number;
  /** Snapshot of the last refresh (the baseline after start). */
  state: SnapshotState | null;
}

/** Rough V8 size of an entry: object slots plus one-byte strings (header + 1 byte per char). */
function estimateBytes(e: ActivityEntry): number {
  let bytes = 160;
  for (const v of Object.values(e)) {
    if (typeof v === 'string') bytes += 16 + v.length;
    else if (Array.isArray(v))
      bytes += 16 + v.length * 8 + v.reduce((n, s) => n + 16 + s.length, 0);
    else if (v !== null && typeof v === 'object') bytes += 64;
  }
  return bytes;
}

export interface ActivityLimits {
  ringSize: number;
  globalMax: number;
  bytesMax: number;
  coalesceMs: number;
}

export interface ActivityRead {
  entries: ActivityEntry[];
  seq: number;
  dropped: boolean;
  live: boolean;
}

/**
 * Per-worktree rings of activity entries with one daemon-wide sequence. Memory only: nothing here
 * touches the store, the disk or git. Caps: `ringSize` per worktree, `globalMax` entries and
 * `bytesMax` estimated bytes over all rings (the globally oldest entry goes first).
 */
export class ActivityStore {
  readonly #rings = new Map<string, Ring>();
  readonly #limits: ActivityLimits;
  #seq = 0;
  #count = 0;
  #bytes = 0;

  constructor(limits: Partial<ActivityLimits> = {}) {
    this.#limits = {
      ringSize: limits.ringSize ?? ACTIVITY_RING_SIZE,
      globalMax: limits.globalMax ?? ACTIVITY_GLOBAL_MAX,
      bytesMax: limits.bytesMax ?? ACTIVITY_BYTES_MAX,
      coalesceMs: limits.coalesceMs ?? ACTIVITY_COALESCE_MS,
    };
  }

  #ring(worktreeId: string): Ring {
    let ring = this.#rings.get(worktreeId);
    if (!ring) {
      ring = {
        entries: [],
        latestByPath: new Map(),
        latestHead: null,
        droppedSeq: 0,
        seq: 0,
        state: null,
      };
      this.#rings.set(worktreeId, ring);
    }
    return ring;
  }

  /** The snapshot of the worktree's last refresh (null before its baseline). */
  previous(worktreeId: string): SnapshotState | null {
    return this.#rings.get(worktreeId)?.state ?? null;
  }

  /**
   * Records a refresh: the first one is the baseline (no entries); later ones append the drafts
   * (`diffSnapshots`) with coalescing. Returns the number of entries added or updated.
   */
  observe(worktreeId: string, state: SnapshotState, drafts: readonly ActivityDraft[], now: Date) {
    const ring = this.#ring(worktreeId);
    const baseline = ring.state === null;
    ring.state = state;
    if (baseline) return 0;
    for (const d of drafts) this.#append(ring, d, now);
    this.#enforceGlobal();
    return drafts.length;
  }

  #coalesceTarget(ring: Ring, d: ActivityDraft, nowMs: number): StoredEntry | null {
    let candidate: StoredEntry | null = null;
    if (d.kind === 'head') candidate = ring.latestHead;
    else if (d.kind !== 'commit' && d.kind !== 'bulk' && d.path !== undefined) {
      candidate = ring.latestByPath.get(d.rawPath ?? d.path) ?? null;
    }
    if (!candidate || candidate.entry.kind !== d.kind) return null;
    if (d.kind === 'head' && candidate.entry.op !== d.op) return null;
    if (nowMs - candidate.updatedMs > this.#limits.coalesceMs) return null;
    // Only the newest entry of the ring for this path / HEAD (otherwise history would reorder).
    return candidate;
  }

  #append(ring: Ring, d: ActivityDraft, now: Date): void {
    const nowMs = now.getTime();
    const iso = now.toISOString();
    const seq = ++this.#seq;
    ring.seq = seq;
    const target = this.#coalesceTarget(ring, d, nowMs);
    if (target) {
      const prev = target.entry;
      const merged: ActivityEntry = {
        ...prev,
        ...d,
        id: prev.id,
        seq,
        at: prev.at,
        updatedAt: iso,
        count: prev.count + 1,
      };
      if (d.kind === 'head') {
        merged.from = prev.from ?? null;
        merged.fromBranch = prev.fromBranch ?? null;
        const paths = [...new Set([...(prev.paths ?? []), ...(d.paths ?? [])])];
        merged.paths = paths.slice(0, ACTIVITY_PATHS_MAX);
        merged.pathCount = (prev.pathCount ?? 0) + (d.pathCount ?? 0);
      }
      const index = ring.entries.indexOf(target);
      if (index >= 0) ring.entries.splice(index, 1);
      this.#bytes -= target.bytes;
      this.#count--;
      this.#push(ring, merged, nowMs);
      return;
    }
    this.#push(ring, { ...d, id: seq, seq, at: iso, updatedAt: iso, count: 1 }, nowMs);
  }

  #push(ring: Ring, entry: ActivityEntry, nowMs: number): void {
    const stored: StoredEntry = { entry, updatedMs: nowMs, bytes: estimateBytes(entry) };
    ring.entries.push(stored);
    this.#count++;
    this.#bytes += stored.bytes;
    if (entry.kind === 'head') ring.latestHead = stored;
    else if (entry.path !== undefined) ring.latestByPath.set(entry.rawPath ?? entry.path, stored);
    // A commit, checkout or bulk change ends every coalescing run before it.
    if (entry.kind === 'commit' || entry.kind === 'bulk') {
      ring.latestByPath.clear();
      ring.latestHead = null;
    } else if (entry.kind === 'head') {
      ring.latestByPath.clear();
    }
    while (ring.entries.length > this.#limits.ringSize) this.#evictFrom(ring);
  }

  #evictFrom(ring: Ring): void {
    const stored = ring.entries.shift();
    if (!stored) return;
    this.#count--;
    this.#bytes -= stored.bytes;
    ring.droppedSeq = Math.max(ring.droppedSeq, stored.entry.seq);
    const e = stored.entry;
    if (ring.latestHead === stored) ring.latestHead = null;
    if (e.path !== undefined) {
      const key = e.rawPath ?? e.path;
      if (ring.latestByPath.get(key) === stored) ring.latestByPath.delete(key);
    }
  }

  #enforceGlobal(): void {
    while (this.#count > this.#limits.globalMax || this.#bytes > this.#limits.bytesMax) {
      let oldest: Ring | null = null;
      for (const ring of this.#rings.values()) {
        const first = ring.entries[0];
        if (first && (!oldest || first.entry.seq < (oldest.entries[0]?.entry.seq ?? 0))) {
          oldest = ring;
        }
      }
      if (!oldest) return;
      this.#evictFrom(oldest);
    }
  }

  /** Entries with `seq > after`, oldest first. */
  read(worktreeId: string, after: number): ActivityRead {
    const ring = this.#rings.get(worktreeId);
    // An `after` beyond this daemon's sequence comes from an earlier run.
    const stale = after > this.#seq;
    if (!ring) return { entries: [], seq: 0, dropped: stale, live: false };
    const from = stale ? 0 : after;
    const entries: ActivityEntry[] = [];
    for (const s of ring.entries) if (s.entry.seq > from) entries.push(s.entry);
    return {
      entries,
      seq: ring.seq,
      dropped: stale || after < ring.droppedSeq,
      live: ring.state !== null,
    };
  }

  /** The worktree's latest `seq` (0 while its feed is empty). */
  seqOf(worktreeId: string): number {
    return this.#rings.get(worktreeId)?.seq ?? 0;
  }

  /**
   * The blob route's allow-list: an oid of a `deleted` entry still in the ring, or a blob of the
   * worktree's current snapshot (HEAD or index version of a changed path).
   */
  allowsBlob(worktreeId: string, oid: string): boolean {
    const ring = this.#rings.get(worktreeId);
    if (!ring) return false;
    for (const s of ring.entries) if (s.entry.oid === oid) return true;
    if (ring.state) {
      for (const e of ring.state.entries.values()) if (e.hH === oid || e.hI === oid) return true;
    }
    return false;
  }

  /** The next snapshot of this worktree is a new baseline (it went missing, or was replaced). */
  resetBaseline(worktreeId: string): void {
    const ring = this.#rings.get(worktreeId);
    if (ring) ring.state = null;
  }

  /** Drops a worktree's ring and baseline (it was removed). */
  forget(worktreeId: string): void {
    const ring = this.#rings.get(worktreeId);
    if (!ring) return;
    for (const s of ring.entries) {
      this.#count--;
      this.#bytes -= s.bytes;
    }
    this.#rings.delete(worktreeId);
  }

  stats(): { rings: number; entries: number; bytes: number; seq: number } {
    return { rings: this.#rings.size, entries: this.#count, bytes: this.#bytes, seq: this.#seq };
  }
}
