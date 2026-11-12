import {
  ACTIVITY_BULK_THRESHOLD,
  ACTIVITY_COALESCE_MS,
  ACTIVITY_GLOBAL_MAX,
  ACTIVITY_PATHS_MAX,
  ACTIVITY_RING_SIZE,
  type ActivityEntry,
  type ActivityHeadOp,
  type ActivityKind,
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
  /**
   * The snapshot's `contentHash`: it covers every changed path of the worktree, including those
   * beyond a truncated snapshot's cap, which neither `total` nor the retained entries can show
   * changing, and nothing about refs (a fetch or a commit elsewhere must not look like activity).
   */
  stateHash?: string;
  /**
   * `SummarySnapshot.omittedPlan` (#43): which untracked files the snapshot leaves out. Equal on
   * both sides, a listed path that is missing is gone; different, paths may have moved between
   * listed and omitted, so the comparison is coarse.
   */
  omittedPlan?: string;
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
    ...(snapshot.contentHash === undefined ? {} : { stateHash: snapshot.contentHash }),
    ...(snapshot.omittedPlan === undefined ? {} : { omittedPlan: snapshot.omittedPlan }),
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
  let reached = false;
  // A merge commit among the new ones only says `merge` once the previous HEAD is known to be below
  // it: a reset onto an older merge commit also lists one, and that is a reset.
  let merged = false;
  for (const c of commits) {
    if (c.sha === prev.sha) {
      reached = true;
      break;
    }
    if (c.parents.length > 1) merged = true;
    run.push(c);
    // The first commit of an unborn branch, or the list ends right above the previous HEAD (a
    // parent of this commit; a merge of the previous HEAD into another line has it second).
    if (prev.sha === null ? c.parents.length === 0 : c.parents.includes(prev.sha)) {
      reached = true;
      break;
    }
  }
  // A pull or fast-forward of the upstream lowers `behind`; own commits do not.
  const sameRef = prev.aheadBehindRef !== null && prev.aheadBehindRef === cur.aheadBehindRef;
  const pulled = sameRef && prev.behind !== null && cur.behind !== null && cur.behind < prev.behind;
  if (!reached) {
    // A full list that never met the previous HEAD says nothing: the run may simply be longer than
    // the list (a long pull or a rebase of many commits is a `merge`, not a reset). Only a list
    // that ended before its limit proves the previous HEAD is not an ancestor.
    if (commits.length >= HEAD_CLASSIFY_COMMITS) {
      return { kind: 'head', op: pulled ? 'merge' : 'moved' };
    }
    return { kind: 'head', op: cur.detached ? 'checkout' : 'reset' };
  }
  if (pulled || merged) return { kind: 'head', op: 'merge' };
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

function sample(paths: readonly string[]): { paths?: string[]; pathCount?: number } {
  if (paths.length === 0) return {};
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
 * on either side, or a change of which untracked files are omitted (#43), gives one coarse `bulk`
 * entry when anything differs. Omitted untracked files are never entries: new ones add nothing.
 */
export function diffSnapshots(
  prev: SnapshotState,
  cur: SnapshotState,
  head: HeadChange | null,
  origins: ReadonlyMap<string, OriginLabel> | null = null,
): ActivityDraft[] {
  const files: ActivityDraft[] = [];
  const left: string[] = [];
  // Another set of omitted untracked files (#43): a listed file that left may only be omitted now.
  const coarse = prev.truncated || cur.truncated || prev.omittedPlan !== cur.omittedPlan;
  // A truncated snapshot cannot see an edit to a path beyond its cap: neither `total` nor a retained
  // entry moves, but the whole-worktree state hash does.
  let coarseChanged =
    prev.total !== cur.total ||
    (coarse &&
      prev.stateHash !== undefined &&
      cur.stateHash !== undefined &&
      prev.stateHash !== cur.stateHash);
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
  // Sources of renames and copies in the new snapshot: they did not come back, they moved.
  const sources = new Set<string>();
  for (const c of cur.entries.values()) {
    if (c.oldPath !== undefined) sources.add(c.oldRawPath ?? c.oldPath);
  }
  for (const [key, p] of prev.entries) {
    if (cur.entries.has(key)) continue;
    if (sources.has(key) && head === null && !coarse) continue;
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
      out.push({ kind: 'bulk', truncated: true, pathCount: cur.total });
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

/**
 * Fields an entry carries besides the common ones, kept in one side object (absent for most
 * file entries, which keeps them small: memory is capped, see `ACTIVITY_BYTES_MAX`).
 */
type Rest = Omit<ActivityDraft, 'kind' | 'path' | 'rawPath' | 'xy' | 'added' | 'deleted' | 'oid'>;

/**
 * A flat copy of a string. Paths parsed from git output are often V8 sliced strings that keep the
 * whole output they were cut from alive (a `git status` of thousands of files, per entry kept),
 * and concatenations are cons strings; an entry must hold only its own characters.
 */
function own(s: string): string;
function own(s: string | undefined): string | undefined;
function own(s: string | null | undefined): string | null | undefined;
function own(s: string | null | undefined): string | null | undefined {
  return typeof s === 'string' && s.length > 0 ? (JSON.parse(JSON.stringify(s)) as string) : s;
}

/**
 * One stored entry. A fixed-shape class with times as milliseconds since the store started (small
 * integers) instead of an `ActivityEntry` with ISO strings: about 40% smaller (DECISIONS #220).
 * `toEntry` builds the API form on read.
 */
class Item {
  id: number;
  seq: number;
  kind: ActivityKind;
  at: number;
  updated: number;
  count: number;
  path: string | undefined;
  rawPath: string | undefined;
  xy: string | undefined;
  added: number | null | undefined;
  deleted: number | null | undefined;
  oid: string | null | undefined;
  rest: Rest | null;

  constructor(d: ActivityDraft, id: number, seq: number, at: number) {
    const { kind, path, rawPath, xy, added, deleted, oid, ...rest } = d;
    this.id = id;
    this.seq = seq;
    this.kind = kind;
    this.at = at;
    this.updated = at;
    this.count = 1;
    this.path = own(path);
    this.rawPath = own(rawPath);
    this.xy = own(xy);
    this.added = added;
    this.deleted = deleted;
    this.oid = own(oid);
    // Only the fields that are set (no `delete`: it would turn the object into a slow dictionary).
    let kept: Record<string, unknown> | null = null;
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue;
      kept ??= {};
      kept[key] =
        typeof value === 'string'
          ? own(value)
          : Array.isArray(value)
            ? value.map((v: string) => own(v))
            : value;
    }
    this.rest = kept as Rest | null;
  }

  get key(): string | undefined {
    return this.rawPath ?? this.path;
  }

  toEntry(epoch: number): ActivityEntry {
    const e: ActivityEntry = {
      id: this.id,
      seq: this.seq,
      kind: this.kind,
      at: new Date(epoch + this.at).toISOString(),
      updatedAt: new Date(epoch + this.updated).toISOString(),
      count: this.count,
    };
    if (this.path !== undefined) e.path = this.path;
    if (this.rawPath !== undefined) e.rawPath = this.rawPath;
    if (this.xy !== undefined) e.xy = this.xy;
    if (this.added !== undefined) e.added = this.added;
    if (this.deleted !== undefined) e.deleted = this.deleted;
    if (this.oid !== undefined) e.oid = this.oid;
    if (this.rest) Object.assign(e, this.rest);
    return e;
  }
}

/**
 * Rough V8 size of an item: its slots and array slot, one-byte strings (header + 1 byte per char),
 * the side object. Calibrated against the heap (the memory test in `activity.test.ts`: 90 x 200
 * file entries measure about 3.7 MB, this estimate gives about 3.9 MB).
 */
function estimateBytes(item: Item): number {
  const str = (s: string | null | undefined) => (typeof s === 'string' ? 16 + s.length : 0);
  let bytes = 130 + str(item.path) + str(item.rawPath) + str(item.xy) + str(item.oid);
  if (item.rest) {
    bytes += 48;
    for (const v of Object.values(item.rest)) {
      if (typeof v === 'string') bytes += 8 + str(v);
      else if (Array.isArray(v)) bytes += 24 + v.reduce((n: number, s) => n + 8 + str(s), 0);
      else if (v !== null && typeof v === 'object') bytes += 64;
      else bytes += 8;
    }
  }
  return bytes;
}

interface Ring {
  /** Oldest first (ascending `seq`). */
  items: Item[];
  /** Highest `seq` dropped by a cap (0 = none). */
  droppedSeq: number;
  seq: number;
  /** Snapshot of the last refresh (the baseline after start). */
  state: SnapshotState | null;
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
  /** Identifies this daemon run (see `ActivityQuery.run`). */
  run: string;
}

/**
 * Per-worktree rings of activity entries with one daemon-wide sequence. Memory only: nothing here
 * touches the store, the disk or git. Caps: `ringSize` per worktree, `globalMax` entries and
 * `bytesMax` estimated bytes over all rings (the globally oldest entry goes first).
 */
export class ActivityStore {
  readonly #rings = new Map<string, Ring>();
  readonly #limits: ActivityLimits;
  readonly #epoch: number;
  #seq = 0;
  #count = 0;
  #bytes = 0;

  constructor(limits: Partial<ActivityLimits> = {}, epoch: number = Date.now()) {
    this.#limits = {
      ringSize: limits.ringSize ?? ACTIVITY_RING_SIZE,
      globalMax: limits.globalMax ?? ACTIVITY_GLOBAL_MAX,
      bytesMax: limits.bytesMax ?? ACTIVITY_BYTES_MAX,
      coalesceMs: limits.coalesceMs ?? ACTIVITY_COALESCE_MS,
    };
    this.#epoch = epoch;
  }

  #ring(worktreeId: string): Ring {
    let ring = this.#rings.get(worktreeId);
    if (!ring) {
      ring = { items: [], droppedSeq: 0, seq: 0, state: null };
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
   * (`diffSnapshots`) with coalescing. Returns the number of drafts recorded.
   */
  observe(
    worktreeId: string,
    state: SnapshotState,
    drafts: readonly ActivityDraft[],
    now: Date,
  ): number {
    const ring = this.#ring(worktreeId);
    const baseline = ring.state === null;
    ring.state = state;
    if (baseline) return 0;
    const at = now.getTime() - this.#epoch;
    for (const d of drafts) this.#append(ring, d, at);
    this.#enforceGlobal();
    return drafts.length;
  }

  /**
   * The entry a draft folds into: the ring's newest entry for the same path (file kinds) or its
   * newest `head` entry, when it has the same kind (and `op`), is recent enough, and no commit,
   * HEAD change or bulk entry came after it (otherwise history would reorder).
   */
  #coalesceTarget(ring: Ring, d: ActivityDraft, at: number): Item | null {
    if (d.kind === 'commit' || d.kind === 'bulk') return null;
    const key = d.rawPath ?? d.path;
    if (d.kind !== 'head' && key === undefined) return null;
    for (let i = ring.items.length - 1; i >= 0; i--) {
      const item = ring.items[i] as Item;
      if (at - item.updated > this.#limits.coalesceMs) return null;
      if (item.kind === 'commit' || item.kind === 'bulk') return null;
      if (d.kind === 'head') {
        if (item.kind !== 'head') continue;
        return item.rest?.op === d.op ? item : null;
      }
      if (item.kind === 'head') return null;
      if (item.key !== key) continue;
      return item.kind === d.kind ? item : null;
    }
    return null;
  }

  #append(ring: Ring, d: ActivityDraft, at: number): void {
    const seq = ++this.#seq;
    ring.seq = seq;
    const target = this.#coalesceTarget(ring, d, at);
    if (target) {
      const index = ring.items.lastIndexOf(target);
      ring.items.splice(index, 1);
      this.#count--;
      this.#bytes -= estimateBytes(target);
      const item = new Item(d, target.id, seq, target.at);
      item.updated = at;
      item.count = target.count + 1;
      if (d.kind === 'head' && target.rest) {
        // A run of the same operation: from the first HEAD to the last, paths accumulated.
        const prev = target.rest;
        item.rest ??= {};
        const rest = item.rest;
        rest.from = prev.from ?? null;
        rest.fromBranch = prev.fromBranch ?? null;
        const paths = [...new Set([...(prev.paths ?? []), ...(rest.paths ?? [])])];
        if (paths.length > 0) {
          rest.paths = paths.slice(0, ACTIVITY_PATHS_MAX);
          rest.pathCount = (prev.pathCount ?? 0) + (rest.pathCount ?? 0);
        }
      }
      this.#push(ring, item);
      return;
    }
    this.#push(ring, new Item(d, seq, seq, at));
  }

  #push(ring: Ring, item: Item): void {
    ring.items.push(item);
    this.#count++;
    this.#bytes += estimateBytes(item);
    while (ring.items.length > this.#limits.ringSize) this.#evictFrom(ring);
  }

  #evictFrom(ring: Ring): void {
    const item = ring.items.shift();
    if (!item) return;
    this.#count--;
    this.#bytes -= estimateBytes(item);
    ring.droppedSeq = Math.max(ring.droppedSeq, item.seq);
  }

  #enforceGlobal(): void {
    while (this.#count > this.#limits.globalMax || this.#bytes > this.#limits.bytesMax) {
      let oldest: Ring | null = null;
      let oldestSeq = Number.POSITIVE_INFINITY;
      for (const ring of this.#rings.values()) {
        const first = ring.items[0];
        if (first && first.seq < oldestSeq) {
          oldest = ring;
          oldestSeq = first.seq;
        }
      }
      if (!oldest) return;
      this.#evictFrom(oldest);
    }
  }

  /** The run identifier a client sends back with its cursor (this store's start time). */
  get run(): string {
    return String(this.#epoch);
  }

  /**
   * Entries with `seq > after`, oldest first. A cursor from an earlier run is stale: when the
   * client says which run it came from (`run`) a different one is certain; otherwise it is
   * guessed from the counters, and a cursor beyond this worktree's own newest `seq` cannot have
   * come from this run either (the daemon-wide counter alone misses it when other worktrees have
   * advanced past the old cursor).
   */
  read(worktreeId: string, after: number, run?: string): ActivityRead {
    const ring = this.#rings.get(worktreeId);
    const stale =
      (run !== undefined && run !== this.run) || after > this.#seq || after > (ring?.seq ?? 0);
    if (!ring) return { entries: [], seq: 0, dropped: stale, live: false, run: this.run };
    const from = stale ? 0 : after;
    const entries: ActivityEntry[] = [];
    for (const item of ring.items) if (item.seq > from) entries.push(item.toEntry(this.#epoch));
    return {
      entries,
      seq: ring.seq,
      dropped: stale || after < ring.droppedSeq,
      live: ring.state !== null,
      run: this.run,
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
    for (const item of ring.items) if (item.oid === oid) return true;
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
    for (const item of ring.items) {
      this.#count--;
      this.#bytes -= estimateBytes(item);
    }
    this.#rings.delete(worktreeId);
  }

  stats(): { rings: number; entries: number; bytes: number; seq: number } {
    return { rings: this.#rings.size, entries: this.#count, bytes: this.#bytes, seq: this.#seq };
  }
}
