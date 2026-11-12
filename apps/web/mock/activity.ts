/**
 * The mock daemon's live view (roadmap #39): per-worktree activity rings with one sequence, the
 * `run` id, coalescing and the blob allow-list, shaped like `apps/daemon/src/activity.ts` (#38) so
 * the web UI, `pnpm dev:mock` and the tests run without a daemon. Dev/test only.
 */
import {
  ACTIVITY_COALESCE_MS,
  ACTIVITY_RING_SIZE,
  type ActivityEntry,
  type ActivityResponse,
  type ActivityWatch,
  type BlobRead,
} from '@octopus-diff/contracts';

/** An entry before it gets its ids and times. */
export type ActivityDraft = Omit<ActivityEntry, 'id' | 'seq' | 'at' | 'updatedAt' | 'count'>;

interface Ring {
  /** Oldest first. */
  entries: ActivityEntry[];
  seq: number;
  droppedSeq: number;
}

export class MockActivity {
  private readonly rings = new Map<string, Ring>();
  private readonly blobs = new Map<string, Map<string, string>>();
  private readonly watches = new Map<string, ActivityWatch>();
  private seq = 0;
  /** Identifies this "daemon run"; `restart()` changes it. */
  run = 'mock-run-1';
  private runCount = 1;
  ringSize = ACTIVITY_RING_SIZE;

  private ring(worktreeId: string): Ring {
    let ring = this.rings.get(worktreeId);
    if (!ring) {
      ring = { entries: [], seq: 0, droppedSeq: 0 };
      this.rings.set(worktreeId, ring);
    }
    return ring;
  }

  /** The worktree's latest sequence number (0 = nothing recorded). */
  seqOf(worktreeId: string): number {
    return this.rings.get(worktreeId)?.seq ?? 0;
  }

  /**
   * The entry a draft folds into, by the daemon's rules: walking back from the newest, stop at one
   * older than the window, at a commit or bulk entry, and (for a file) at a HEAD move; a file
   * entry for another path is skipped, the first one for this path folds only when the kind is
   * the same (an edit, a delete and a second edit stay three rows).
   */
  private coalesceTarget(
    entries: readonly ActivityEntry[],
    draft: ActivityDraft,
    nowMs: number,
  ): ActivityEntry | undefined {
    if (draft.kind === 'commit' || draft.kind === 'bulk') return undefined;
    const key = draft.rawPath ?? draft.path;
    if (draft.kind !== 'head' && key === undefined) return undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as ActivityEntry;
      if (nowMs - Date.parse(e.updatedAt) > ACTIVITY_COALESCE_MS) return undefined;
      if (e.kind === 'commit' || e.kind === 'bulk') return undefined;
      if (draft.kind === 'head') {
        if (e.kind !== 'head') continue;
        return e.op === draft.op ? e : undefined;
      }
      if (e.kind === 'head') return undefined;
      if ((e.rawPath ?? e.path) !== key) continue;
      return e.kind === draft.kind ? e : undefined;
    }
    return undefined;
  }

  /**
   * Records a draft. A repeat of the same path and kind within `ACTIVITY_COALESCE_MS` updates the
   * earlier entry (same `id`, new `seq`, moved to the end), like the daemon.
   */
  record(worktreeId: string, draft: ActivityDraft, nowMs: number): ActivityEntry {
    const ring = this.ring(worktreeId);
    const at = new Date(nowMs).toISOString();
    const prev = this.coalesceTarget(ring.entries, draft, nowMs);
    const seq = ++this.seq;
    ring.seq = seq;
    if (prev) {
      ring.entries.splice(ring.entries.indexOf(prev), 1);
      const next: ActivityEntry = { ...prev, ...draft, seq, updatedAt: at, count: prev.count + 1 };
      ring.entries.push(next);
      return next;
    }
    const entry: ActivityEntry = { ...draft, id: seq, seq, at, updatedAt: at, count: 1 };
    ring.entries.push(entry);
    while (ring.entries.length > this.ringSize) {
      const old = ring.entries.shift();
      if (old) ring.droppedSeq = Math.max(ring.droppedSeq, old.seq);
    }
    this.pruneBlobs(worktreeId, ring.entries);
    return entry;
  }

  /** How many saved contents a worktree holds (tests: expired ones are dropped). */
  blobCount(worktreeId: string): number {
    return this.blobs.get(worktreeId)?.size ?? 0;
  }

  /** Drops saved content that no entry of the feed holds any more (it cannot be served). */
  private pruneBlobs(worktreeId: string, entries: readonly ActivityEntry[]): void {
    const map = this.blobs.get(worktreeId);
    if (!map) return;
    const held = new Set(entries.map((e) => e.oid).filter((oid) => oid != null));
    for (const oid of map.keys()) if (!held.has(oid)) map.delete(oid);
  }

  /** Remembers a removed file's content under its blob id (the route's allow-list). */
  keepBlob(worktreeId: string, oid: string, content: string): void {
    let map = this.blobs.get(worktreeId);
    if (!map) {
      map = new Map();
      this.blobs.set(worktreeId, map);
    }
    map.set(oid, content);
  }

  /** `GET /api/worktrees/:id/activity`: entries with `seq > after`; stale cursors are `dropped`. */
  read(worktreeId: string, after: number, run?: string): ActivityResponse {
    const ring = this.ring(worktreeId);
    // The daemon's rules: a foreign run or a cursor beyond this ring is stale; a cursor behind
    // what the ring already dropped lost entries. Either way the answer is the whole ring.
    const stale = (run !== undefined && run !== this.run) || after > this.seq || after > ring.seq;
    const from = stale ? 0 : after;
    return {
      worktreeId,
      entries: ring.entries.filter((e) => e.seq > from).map((e) => ({ ...e })),
      seq: ring.seq,
      dropped: stale || after < ring.droppedSeq,
      live: true,
      run: this.run,
      watch: this.watches.get(worktreeId) ?? { mode: 'native', pollMs: null },
    };
  }

  /** `GET /api/worktrees/:id/blob/:oid`: text only, and only for an oid of the worktree's feed. */
  blob(worktreeId: string, oid: string, maxBytes: number): BlobRead | null {
    // Only an oid some entry of the worktree's feed still holds (the daemon's allow-list): a
    // deletion that left the ring is gone, and so is its saved content.
    const held = this.rings.get(worktreeId)?.entries.some((e) => e.oid === oid) ?? false;
    const content = held ? this.blobs.get(worktreeId)?.get(oid) : undefined;
    if (content === undefined) return null;
    const size = new TextEncoder().encode(content).length;
    if (size > maxBytes) return { oid, kind: 'too_large', size, maxBytes, content: null };
    return { oid, kind: 'text', size, maxBytes, content };
  }

  /** How the worktree is watched (what the strip words as "polling every N s"). */
  setWatch(worktreeId: string, watch: ActivityWatch): void {
    this.watches.set(worktreeId, watch);
  }

  /** A daemon restart: a new run, every ring and blob gone (the next old cursor is `dropped`). */
  restart(): void {
    this.runCount += 1;
    this.run = `mock-run-${this.runCount}`;
    this.rings.clear();
    this.blobs.clear();
    this.seq = 0;
  }
}
