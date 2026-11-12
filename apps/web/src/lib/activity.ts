/**
 * The Activity feed in the browser (roadmap #39, DECISIONS #229): merging the daemon's incremental
 * answers (`GET /api/worktrees/:id/activity?after=`) into one list, and the words for its rows.
 * Pure; no React.
 */
import {
  ACTIVITY_RING_SIZE,
  type ActivityEntry,
  type ActivityResponse,
  type ActivityWatch,
} from '@octopus-diff/contracts';

/** What the browser holds for one worktree: the feed so far and the cursor to ask from. */
export interface ActivityFeed {
  worktreeId: string;
  /** Oldest first (ascending `seq`), at most `ACTIVITY_RING_SIZE`. */
  entries: ActivityEntry[];
  /** Cursor: the worktree's latest `seq` (send it back as `after`). */
  seq: number;
  /** The daemon run the cursor belongs to (send it back as `run`); absent from older daemons. */
  run: string | undefined;
  /** False until the daemon has a baseline for the worktree. */
  live: boolean;
  watch: ActivityWatch;
  /** The last answer replaced the list (a stale cursor): for the tests and the dev tools. */
  replaced: boolean;
}

/**
 * Folds an answer into what is held. A `dropped` answer (the cursor was stale: the ring moved past
 * it, or the daemon restarted) carries the whole ring and replaces the list; otherwise the
 * entries replace their earlier versions by `id` (a coalesced entry comes back with a new `seq`)
 * and new ones are appended. A held list from another daemon run is never merged into.
 */
export function mergeActivity(prev: ActivityFeed | undefined, res: ActivityResponse): ActivityFeed {
  const fresh =
    res.dropped ||
    prev === undefined ||
    prev.worktreeId !== res.worktreeId ||
    (prev.run !== undefined && res.run !== undefined && prev.run !== res.run);
  let entries: ActivityEntry[];
  if (fresh) {
    entries = [...res.entries];
  } else {
    const ids = new Set(res.entries.map((e) => e.id));
    entries = [...prev.entries.filter((e) => !ids.has(e.id)), ...res.entries];
  }
  entries.sort((a, b) => a.seq - b.seq);
  if (entries.length > ACTIVITY_RING_SIZE) entries = entries.slice(-ACTIVITY_RING_SIZE);
  return {
    worktreeId: res.worktreeId,
    entries,
    // An empty answer after a cursor keeps the cursor (`seq` 0 means "empty feed").
    seq: fresh ? res.seq : Math.max(res.seq, prev.seq),
    run: res.run ?? (fresh ? undefined : prev.run),
    live: res.live,
    watch: res.watch,
    replaced: fresh,
  };
}

/** The cursor and run to send for the next request (nothing for a first fetch). */
export function activityCursor(prev: ActivityFeed | undefined): {
  after?: number;
  run?: string;
} {
  if (!prev) return {};
  return { after: prev.seq, ...(prev.run !== undefined ? { run: prev.run } : {}) };
}

/** Newest first, for display. */
export function newestFirst(entries: readonly ActivityEntry[]): ActivityEntry[] {
  return [...entries].sort((a, b) => b.seq - a.seq);
}

/** `Ns` / `Nm` / `Nh` / `Nd` since `iso`; "now" under 3 s. */
export function ago(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 3) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** "polling every 5 s" for a worktree the daemon cannot watch natively; null for a native one. */
export function watchNote(watch: ActivityWatch): string | null {
  if (watch.mode === 'native') return null;
  const secs = watch.pollMs === null ? null : Math.max(1, Math.round(watch.pollMs / 1000));
  if (watch.mode === 'polling') return secs === null ? 'polling' : `polling every ${secs} s`;
  return secs === null ? 'watching is off' : `watching is off · checked every ${secs} s`;
}

/** Entries that name one file (what a click can select). */
export function isFileEntry(entry: ActivityEntry): boolean {
  return (
    (entry.kind === 'added' ||
      entry.kind === 'modified' ||
      entry.kind === 'deleted' ||
      entry.kind === 'restored') &&
    entry.path !== undefined
  );
}

const HEAD_OPS: Record<string, string> = {
  checkout: 'Checked out',
  merge: 'Merged',
  rebase: 'Rebase',
  reset: 'Reset',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert',
  am: 'Mailbox apply',
  bisect: 'Bisect',
  moved: 'HEAD moved',
};

/** One line for a `head` entry: "Checked out feat/auth (from main)". */
export function headLabel(entry: ActivityEntry): string {
  const op = entry.op ? (HEAD_OPS[entry.op] ?? 'HEAD moved') : 'HEAD moved';
  const branch = entry.branch ?? (entry.branch === null ? 'detached HEAD' : null);
  const from =
    entry.fromBranch && entry.fromBranch !== entry.branch ? ` (from ${entry.fromBranch})` : '';
  if (entry.op === 'checkout' && branch) return `${op} ${branch}${from}`;
  const running = entry.inProgress ? ` · ${entry.inProgress} in progress` : '';
  return `${op}${branch ? ` on ${branch}` : ''}${running}`;
}

/** "12 modified, 40 added" for a `bulk` entry's kinds (zeros left out). */
export function bulkKinds(entry: ActivityEntry): string {
  const k = entry.kinds;
  if (!k) return '';
  return (['modified', 'added', 'deleted', 'restored'] as const)
    .filter((kind) => k[kind] > 0)
    .map((kind) => `${k[kind]} ${kind}`)
    .join(', ');
}
