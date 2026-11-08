/**
 * Cache maintenance: review-mark patches (optimistic updates and `review.changed` events) and
 * SSE-driven invalidation.
 */
import type {
  ApiClient,
  ChangedFile,
  DiffResponse,
  FilesResponse,
  InboxEntry,
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
  /**
   * The inbox needs a full refetch (worktrees or projects were added/removed/updated). When
   * only `worktree.changed` events arrived, the changed worktrees' entries are patched instead.
   */
  inboxFull: boolean;
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
    inboxFull: false,
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
      effects.inboxFull = true;
      break;
    case 'project.added':
    case 'project.updated':
    case 'project.removed':
      effects.projects = true;
      effects.inbox = true;
      effects.inboxFull = true;
      effects.scanRoots = true;
      break;
    case 'scan.progress':
      if (event.state !== 'scanning') {
        effects.projects = true;
        effects.inbox = true;
        effects.inboxFull = true;
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
    case 'settings.changed': {
      // Skip the refetch when this revision is the one a response already applied.
      const cached = queryClient.getQueryData<{ revision: number } | null>(['settings']);
      if (cached && cached.revision >= event.revision) break;
      effects.settings = true;
      effects.projects = true;
      effects.inbox = true;
      break;
    }
  }
  return effects;
}

/** Above this many changed worktrees in one batch, one inbox refetch is cheaper than patching. */
export const INBOX_PATCH_MAX_WORKTREES = 8;

const patchSeq = new WeakMap<QueryClient, { next: number; applied: Map<string, number> }>();

/**
 * Replaces the inbox entries of `worktreeIds` in every active inbox query, using
 * `GET /worktrees/:id/files` and the (already refetched) projects list, instead of refetching
 * the whole inbox (1.5 MB for 30 worktrees x 200 files). Builds exactly what `/api/inbox`
 * would return for those worktrees: `{project, worktree, summary, files}` when the list is
 * non-empty. Throws (caller falls back to a full refetch) if a worktree is unknown, a request
 * fails, or the file list is from another state than the projects list.
 */
async function patchInbox(
  queryClient: QueryClient,
  api: ApiClient,
  worktreeIds: string[],
): Promise<void> {
  const seqs = patchSeq.get(queryClient) ?? { next: 0, applied: new Map<string, number>() };
  patchSeq.set(queryClient, seqs);
  const seq = ++seqs.next;
  const projects = queryClient.getQueryData<ProjectsResponse>(queryKeys.projects());
  const locate = (id: string) => {
    for (const item of projects?.projects ?? []) {
      const w = item.worktrees.find((x) => x.worktree.id === id);
      if (w) return { project: item.project, ...w };
    }
    return null;
  };
  const queries = queryClient.getQueryCache().findAll({ queryKey: queryKeys.inboxAll() });
  for (const query of queries) {
    const data = query.state.data as InboxResponse | undefined;
    if (!data) continue;
    if (query.getObserversCount() === 0) {
      // Not on screen: mark stale, refetch when used again.
      await queryClient.invalidateQueries({ queryKey: query.queryKey, refetchType: 'none' });
      continue;
    }
    const scope = data.scope;
    const results = await Promise.all(
      worktreeIds.map(async (id) => {
        const loc = locate(id);
        if (!loc) throw new Error(`unknown worktree ${id}`);
        if (!loc.summary || loc.worktree.bare || loc.worktree.missing)
          return { id, loc, files: null };
        const response = await api.listFiles(id, { scope });
        if (response.stateHash !== loc.summary.stateHash) throw new Error('state moved on');
        queryClient.setQueryData(queryKeys.files(id, scope), response);
        return { id, loc, files: response.files };
      }),
    );
    // A later batch already patched these worktrees: keep its (newer) result.
    const fresh = results.filter((r) => (seqs.applied.get(r.id) ?? 0) < seq);
    for (const r of fresh) seqs.applied.set(r.id, seq);
    const current = queryClient.getQueryData<InboxResponse>(query.queryKey) ?? data;
    const replaced = new Map<string, InboxEntry | null>();
    for (const r of fresh) {
      replaced.set(
        r.id,
        r.files && r.files.length > 0 && r.loc.summary
          ? {
              project: r.loc.project,
              worktree: r.loc.worktree,
              summary: r.loc.summary,
              files: r.files,
              // Effective review policy comes from the (already refetched) projects list, as
              // the daemon attaches the same value to inbox entries. Dropping it would turn
              // review back on for a review-disabled worktree after any live update.
              ...(r.loc.review ? { review: r.loc.review } : {}),
            }
          : null,
      );
    }
    const entries: InboxEntry[] = [];
    for (const entry of current.entries) {
      const next = replaced.get(entry.worktree.id);
      if (next === undefined) entries.push(entry);
      else if (next) entries.push(next);
      replaced.delete(entry.worktree.id);
    }
    for (const next of replaced.values()) if (next) entries.push(next);
    queryClient.setQueryData<InboxResponse>(query.queryKey, {
      ...current,
      entries,
      generatedAt: new Date().toISOString(),
    });
  }
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

export async function flushEffects(
  queryClient: QueryClient,
  effects: EventEffects,
  api?: ApiClient,
): Promise<void> {
  if (effects.everything) {
    await queryClient.invalidateQueries();
    return;
  }
  const tasks: Promise<void>[] = [];
  if (effects.settings) tasks.push(queryClient.invalidateQueries({ queryKey: ['settings'] }));
  const projectsRefetch = effects.projects
    ? queryClient.invalidateQueries({ queryKey: queryKeys.projects() })
    : Promise.resolve();
  tasks.push(projectsRefetch);
  const canPatch =
    api !== undefined &&
    !effects.inboxFull &&
    effects.worktrees.size > 0 &&
    effects.worktrees.size <= INBOX_PATCH_MAX_WORKTREES &&
    queryClient.getQueryState(queryKeys.projects())?.status === 'success';
  if (effects.inbox && canPatch) {
    const ids = [...effects.worktrees];
    tasks.push(
      projectsRefetch
        .then(() => patchInbox(queryClient, api, ids))
        .catch(() => queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll() })),
    );
  } else if (effects.inbox) {
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll() }));
  }
  if (effects.scanRoots)
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.scanRoots() }));
  for (const id of effects.worktrees) {
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.filesAll(id) }));
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.diffAll(id) }));
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.commits(id) }));
  }
  await Promise.all(tasks);
}
