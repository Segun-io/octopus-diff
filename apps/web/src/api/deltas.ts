/**
 * Event deltas (#51): `worktree.changed` from a current daemon carries the worktree's row of
 * `GET /api/projects` (`worktree`, `summary`, `error`, `review`) and the changed paths it already
 * listed. The row goes straight into the cached projects list instead of a refetch of the list.
 *
 * Races: events arrive in order on one stream, but a projects request that was in flight while a
 * row was applied answers with what the daemon had when it ran, and would put the older row back.
 * Applied rows are remembered for a while and win over an older row in any projects answer
 * (`keepNewerRows`, used by the projects query). Rows are ordered by the daemon's `rev` (#51
 * review), which orders a row with a null summary (an error) too; `summary.updatedAt` is only the
 * fallback for rows without one. Remembered rows are forgotten on a reconnect (`forgetRows`).
 */
import type {
  ProjectsResponse,
  ServerEventOf,
  WorktreeListItem,
  WorktreeSummary,
} from '@octopus-diff/contracts';
import type { QueryClient } from '@tanstack/react-query';

export type WorktreeChangedEvent = ServerEventOf<'worktree.changed'>;

/** A `worktree.changed` that carries the worktree's row (a current daemon's, not a replay). */
export type WorktreeDeltaEvent = WorktreeChangedEvent & {
  worktree: NonNullable<WorktreeChangedEvent['worktree']>;
  summary: WorktreeSummary | null;
};

/** Feature test: an older daemon (and a replay after a reconnect) sends neither field. */
export function isDeltaEvent(event: WorktreeChangedEvent): event is WorktreeDeltaEvent {
  return event.worktree !== undefined && event.summary !== undefined;
}

/** The row the event describes, shaped like `ProjectListItem.worktrees[number]`. */
export function rowOf(event: WorktreeDeltaEvent): WorktreeListItem {
  return {
    worktree: event.worktree,
    summary: event.summary,
    error: event.error ?? null,
    ...(event.review ? { review: event.review } : {}),
    ...(event.rev !== undefined ? { rev: event.rev } : {}),
  };
}

/** How long an applied row is kept to outvote an older projects answer. */
export const DELTA_KEEP_MS = 60_000;

interface Remembered {
  projectId: string;
  row: WorktreeListItem;
  at: number;
}

const remembered = new WeakMap<QueryClient, Map<string, Remembered>>();

function memoryOf(queryClient: QueryClient): Map<string, Remembered> {
  let map = remembered.get(queryClient);
  if (!map) {
    map = new Map();
    remembered.set(queryClient, map);
  }
  return map;
}

function time(summary: WorktreeSummary | null | undefined): number | null {
  if (!summary) return null;
  const t = Date.parse(summary.updatedAt);
  return Number.isNaN(t) ? null : t;
}

/**
 * `a` describes a strictly later state of the worktree than `b`: by `rev` when both carry one
 * (whatever the summaries are, null included), else by `summary.updatedAt` when both have a
 * summary. Unknown order: false.
 */
export function newerRow(a: WorktreeListItem, b: WorktreeListItem): boolean {
  if (a.rev !== undefined && b.rev !== undefined) return a.rev > b.rev;
  const ta = time(a.summary);
  const tb = time(b.summary);
  return ta !== null && tb !== null && ta > tb;
}

/**
 * A row event whose `stateHash` equals the cached row's still brings something new when it is a
 * later state (`rev`), e.g. the review state that landed after a projects answer already showed
 * the summary. Without `rev`: when it has a review state the cached row lacks.
 */
export function bringsNews(event: WorktreeDeltaEvent, cached: WorktreeListItem): boolean {
  const row = rowOf(event);
  if (row.rev !== undefined && cached.rev !== undefined) return row.rev > cached.rev;
  return row.summary?.review !== undefined && cached.summary?.review === undefined;
}

/** Forgets the remembered rows (a reconnect: the daemon may have restarted, its `rev` with it). */
export function forgetRows(queryClient: QueryClient): void {
  remembered.delete(queryClient);
}

/** The worktree's row in the cached projects list. */
export function cachedRow(queryClient: QueryClient, worktreeId: string) {
  const projects = queryClient.getQueryData<ProjectsResponse>(['projects']);
  for (const item of projects?.projects ?? []) {
    const row = item.worktrees.find((w) => w.worktree.id === worktreeId);
    if (row) return row;
  }
  return undefined;
}

export type ApplyRowResult =
  /** Replaced; `previous` is the row it replaced. */
  | { kind: 'applied'; previous: WorktreeListItem }
  /** The cached row is newer (a list fetched after the event's state): kept. */
  | { kind: 'stale'; previous: WorktreeListItem }
  /** No cached list, or the worktree is not in it (added or removed meanwhile). */
  | { kind: 'unknown' };

/** Replaces the worktree's row in the cached projects list (see the module comment). */
export function applyRow(
  queryClient: QueryClient,
  event: WorktreeDeltaEvent,
  now: number = Date.now(),
): ApplyRowResult {
  const key = ['projects'] as const;
  const data = queryClient.getQueryData<ProjectsResponse>(key);
  if (!data) return { kind: 'unknown' };
  const pi = data.projects.findIndex((p) => p.project.id === event.projectId);
  const project = data.projects[pi];
  const wi = project ? project.worktrees.findIndex((w) => w.worktree.id === event.worktreeId) : -1;
  const previous = project?.worktrees[wi];
  if (!project || !previous) return { kind: 'unknown' };
  const row = rowOf(event);
  if (newerRow(previous, row)) return { kind: 'stale', previous };
  const worktrees = project.worktrees.slice();
  worktrees[wi] = row;
  const projects = data.projects.slice();
  projects[pi] = { ...project, worktrees };
  queryClient.setQueryData<ProjectsResponse>(key, { ...data, projects });
  const memory = memoryOf(queryClient);
  memory.set(event.worktreeId, { projectId: event.projectId, row, at: now });
  return { kind: 'applied', previous };
}

/**
 * A projects answer with every remembered row that is newer than the answer's put back (see the
 * module comment). Rows of worktrees the answer no longer has are not added back.
 */
export function keepNewerRows(
  queryClient: QueryClient,
  response: ProjectsResponse,
  now: number = Date.now(),
): ProjectsResponse {
  const memory = remembered.get(queryClient);
  if (!memory || memory.size === 0) return response;
  for (const [id, entry] of memory) if (now - entry.at > DELTA_KEEP_MS) memory.delete(id);
  let projects: ProjectsResponse['projects'] | null = null;
  response.projects.forEach((project, pi) => {
    let worktrees: typeof project.worktrees | null = null;
    project.worktrees.forEach((w, wi) => {
      const entry = memory.get(w.worktree.id);
      if (!entry || entry.projectId !== project.project.id) return;
      if (!newerRow(entry.row, w)) return;
      worktrees ??= project.worktrees.slice();
      worktrees[wi] = entry.row;
    });
    if (worktrees) {
      projects ??= response.projects.slice();
      projects[pi] = { ...project, worktrees };
    }
  });
  return projects ? { ...response, projects } : response;
}

/** Current stateHash of a worktree according to the cached projects list. */
export function cachedStateHash(queryClient: QueryClient, worktreeId: string): string | undefined {
  const projects = queryClient.getQueryData<ProjectsResponse>(['projects']);
  for (const item of projects?.projects ?? []) {
    for (const w of item.worktrees) {
      if (w.worktree.id === worktreeId) return w.summary?.stateHash;
    }
  }
  return undefined;
}
