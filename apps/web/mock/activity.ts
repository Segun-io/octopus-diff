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
   * Records a draft. A repeat of the same path and kind within `ACTIVITY_COALESCE_MS` updates the
   * earlier entry (same `id`, new `seq`, moved to the end), like the daemon.
   */
  record(worktreeId: string, draft: ActivityDraft, nowMs: number): ActivityEntry {
    const ring = this.ring(worktreeId);
    const at = new Date(nowMs).toISOString();
    const prev =
      draft.path === undefined
        ? undefined
        : [...ring.entries]
            .reverse()
            .find(
              (e) =>
                e.kind === draft.kind &&
                e.path === draft.path &&
                nowMs - Date.parse(e.updatedAt) <= ACTIVITY_COALESCE_MS,
            );
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
    return entry;
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
    const content = this.blobs.get(worktreeId)?.get(oid);
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
