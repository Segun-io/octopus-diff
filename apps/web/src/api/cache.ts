/**
 * Cache maintenance: review-mark patches (optimistic updates and `review.changed` events) and
 * SSE-driven invalidation.
 */
import type {
  ChangedFile,
  DiffResponse,
  FilesResponse,
  InboxResponse,
  ProjectsResponse,
  ScopeKind,
  ServerEvent,
} from '@octopus-diff/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './queries.ts';

export interface ReviewPatch {
  projectId: string;
  scopeKind: ScopeKind;
  path: string;
  rawPath?: string | undefined;
  patchHash: string;
  reviewed: boolean;
}

function scopeKindOfKey(key: unknown): string | undefined {
  // scopeKey(scope) is `<kind>` or `<kind>:<detail>`.
  return typeof key === 'string' ? key.split(':')[0] : undefined;
}

function matches(
  file: Pick<ChangedFile, 'path' | 'rawPath' | 'patchHash'>,
  patch: ReviewPatch,
): boolean {
  return (
    file.patchHash === patch.patchHash &&
    (patch.rawPath ? file.rawPath === patch.rawPath : file.path === patch.path && !file.rawPath)
  );
}

/** worktreeId → projectId from the cached projects list. */
export function projectIdOf(queryClient: QueryClient, worktreeId: string): string | undefined {
  const projects = queryClient.getQueryData<ProjectsResponse>(queryKeys.projects());
  for (const item of projects?.projects ?? []) {
    if (item.worktrees.some((w) => w.worktree.id === worktreeId)) return item.project.id;
  }
  return undefined;
}

function patchFiles(files: ChangedFile[], patch: ReviewPatch): ChangedFile[] | null {
  let changed = false;
  const next = files.map((f) => {
    if (f.reviewed === patch.reviewed || !matches(f, patch)) return f;
    changed = true;
    return { ...f, reviewed: patch.reviewed };
  });
  return changed ? next : null;
}

/**
 * Sets the reviewed flag on every cached file that matches (projectId, scopeKind, path,
 * patchHash). Returns a function that restores the previous cache values (for rollback).
 */
export function applyReviewToCaches(queryClient: QueryClient, patch: ReviewPatch): () => void {
  const restore: (() => void)[] = [];

  for (const [key, data] of queryClient.getQueriesData<InboxResponse>({
    queryKey: queryKeys.inboxAll(),
  })) {
    if (!data || data.scope.kind !== patch.scopeKind) continue;
    let changed = false;
    const entries = data.entries.map((entry) => {
      if (entry.project.id !== patch.projectId) return entry;
      const files = patchFiles(entry.files, patch);
      if (!files) return entry;
      changed = true;
      return { ...entry, files };
    });
    if (!changed) continue;
    queryClient.setQueryData(key, { ...data, entries });
    restore.push(() => queryClient.setQueryData(key, data));
  }

  for (const [key, data] of queryClient.getQueriesData<FilesResponse>({ queryKey: ['files'] })) {
    if (!data || data.scope.kind !== patch.scopeKind) continue;
    const projectId = projectIdOf(queryClient, data.worktreeId);
    if (projectId !== undefined && projectId !== patch.projectId) continue;
    const files = patchFiles(data.files, patch);
    if (!files) continue;
    queryClient.setQueryData(key, { ...data, files });
    restore.push(() => queryClient.setQueryData(key, data));
  }

  for (const [key, data] of queryClient.getQueriesData<DiffResponse>({ queryKey: ['diff'] })) {
    if (!data || scopeKindOfKey(key[2]) !== patch.scopeKind) continue;
    if (data.diff.reviewed === patch.reviewed || !matches(data.diff, patch)) continue;
    const projectId = projectIdOf(queryClient, data.worktreeId);
    if (projectId !== undefined && projectId !== patch.projectId) continue;
    queryClient.setQueryData(key, { ...data, diff: { ...data.diff, reviewed: patch.reviewed } });
    restore.push(() => queryClient.setQueryData(key, data));
  }

  return () => {
    for (const fn of restore) fn();
  };
}

/** Current stateHash of a worktree according to the cached projects list. */
function cachedStateHash(queryClient: QueryClient, worktreeId: string): string | undefined {
  const projects = queryClient.getQueryData<ProjectsResponse>(queryKeys.projects());
  for (const item of projects?.projects ?? []) {
    for (const w of item.worktrees) {
      if (w.worktree.id === worktreeId) return w.summary?.stateHash;
    }
  }
  return undefined;
}

export interface EventEffects {
  /** Worktrees whose files/diffs/commits must be refetched. */
  worktrees: Set<string>;
  projects: boolean;
  inbox: boolean;
  scanRoots: boolean;
  /** `settings.changed`: refetch settings (effective policies may have moved). */
  settings: boolean;
  everything: boolean;
}

export function emptyEffects(): EventEffects {
  return {
    worktrees: new Set(),
    projects: false,
    inbox: false,
    scanRoots: false,
    settings: false,
    everything: false,
  };
}

/**
 * Folds one server event into pending invalidations (applied in a batch by `flushEffects`).
 * `review.changed` is applied to the caches directly: it needs no refetch.
 */
export function collectEventEffects(
  queryClient: QueryClient,
  event: ServerEvent,
  effects: EventEffects,
  opts: { reconnect: boolean },
): EventEffects {
  switch (event.type) {
    case 'hello':
      // Events may have been missed while disconnected: refetch everything.
      if (opts.reconnect) effects.everything = true;
      break;
    case 'worktree.changed':
      if (cachedStateHash(queryClient, event.worktreeId) === event.stateHash) break;
      effects.worktrees.add(event.worktreeId);
      effects.projects = true;
      effects.inbox = true;
      break;
    case 'worktree.added':
    case 'worktree.removed':
      effects.worktrees.add(event.worktreeId);
      effects.projects = true;
      effects.inbox = true;
      break;
    case 'project.added':
    case 'project.updated':
    case 'project.removed':
      effects.projects = true;
      effects.inbox = true;
      effects.scanRoots = true;
      break;
    case 'scan.progress':
      if (event.state !== 'scanning') {
        effects.projects = true;
        effects.inbox = true;
        effects.scanRoots = true;
      }
      break;
    case 'review.changed':
      applyReviewToCaches(queryClient, event);
      break;
    case 'review.bulk':
      // Many marks at once: refetch the inbox and the files/diffs of the affected projects.
      effects.inbox = true;
      for (const id of worktreeIdsOfProjects(queryClient, event.projectIds)) {
        effects.worktrees.add(id);
      }
      break;
    case 'settings.changed':
      effects.settings = true;
      effects.projects = true;
      effects.inbox = true;
      break;
  }
  return effects;
}

/** Worktree ids of the given projects according to the cached projects list. */
function worktreeIdsOfProjects(queryClient: QueryClient, projectIds: readonly string[]): string[] {
  const projects = queryClient.getQueryData<ProjectsResponse>(queryKeys.projects());
  const out: string[] = [];
  for (const item of projects?.projects ?? []) {
    if (!projectIds.includes(item.project.id)) continue;
    for (const w of item.worktrees) out.push(w.worktree.id);
  }
  return out;
}

export async function flushEffects(queryClient: QueryClient, effects: EventEffects): Promise<void> {
  if (effects.everything) {
    await queryClient.invalidateQueries();
    return;
  }
  const tasks: Promise<void>[] = [];
  if (effects.settings) tasks.push(queryClient.invalidateQueries({ queryKey: ['settings'] }));
  if (effects.projects)
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.projects() }));
  if (effects.inbox) tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll() }));
  if (effects.scanRoots)
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.scanRoots() }));
  for (const id of effects.worktrees) {
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.filesAll(id) }));
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.diffAll(id) }));
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.commits(id) }));
  }
  await Promise.all(tasks);
}
