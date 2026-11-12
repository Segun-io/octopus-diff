/**
 * Cache maintenance: review-mark patches (optimistic updates and `review.changed` events) and
 * SSE-driven updates: event deltas applied in place (#51), invalidation otherwise.
 */
import {
  type ApiClient,
  type ChangedFile,
  type DiffResponse,
  type FilesResponse,
  INBOX_WORKTREES_MAX,
  type InboxEntry,
  type InboxResponse,
  type ProjectsResponse,
  type ScopeKind,
  type ServerEvent,
  scopeKey,
  type WorktreeChangedPaths,
  type WorktreeListItem,
} from '@octopus-diff/contracts';
import type { Query, QueryClient } from '@tanstack/react-query';
import {
  applyRow,
  bringsNews,
  cachedRow,
  cachedStateHash,
  forgetRows,
  isDeltaEvent,
  type WorktreeDeltaEvent,
} from './deltas.ts';
import { type DiffQueryData, queryKeys } from './queries.ts';

export interface ReviewPatch {
  projectId: string;
  scopeKind: ScopeKind;
  path: string;
  rawPath?: string | undefined;
  patchHash: string;
  reviewed: boolean;
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
 * Sets the reviewed flag on every cached file that matches (projectId, path, patchHash), in any
 * scope. Returns a function that restores the previous cache values (for rollback).
 */
export function applyReviewToCaches(queryClient: QueryClient, patch: ReviewPatch): () => void {
  const restore: (() => void)[] = [];

  for (const [key, data] of queryClient.getQueriesData<InboxResponse>({
    queryKey: queryKeys.inboxAll(),
  })) {
    // Marks do not depend on the scope kind (status flow v2): a (path, patchHash) mark applies
    // in every scope where the same patch appears.
    if (!data) continue;
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
    if (!data) continue;
    const projectId = projectIdOf(queryClient, data.worktreeId);
    if (projectId !== undefined && projectId !== patch.projectId) continue;
    const files = patchFiles(data.files, patch);
    if (!files) continue;
    queryClient.setQueryData(key, { ...data, files });
    restore.push(() => queryClient.setQueryData(key, data));
  }

  for (const [key, data] of queryClient.getQueriesData<DiffResponse>({ queryKey: ['diff'] })) {
    if (!data) continue;
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

export interface EventEffects {
  /** Worktrees whose files/diffs/commits must be refetched (no delta, or a delta that missed). */
  worktrees: Set<string>;
  projects: boolean;
  /** The whole inbox is refetched (older daemons, structural events). */
  inbox: boolean;
  /**
   * The inbox needs a full refetch (worktrees or projects were added/removed/updated). Kept for
   * callers and tests; a full refetch is what `inbox` means now (#51: no client-side patching).
   */
  inboxFull: boolean;
  scanRoots: boolean;
  /** `settings.changed`: refetch settings (effective policies may have moved). */
  settings: boolean;
  /** `forge.updated`: refetch pull/merge requests (api/forges.ts). */
  forges: boolean;
  /**
   * Worktrees whose activity feed moved (`worktree.changed.activitySeq`, #38): their feed is
   * invalidated, and fetched (incrementally) only when it is on screen.
   */
  activity: Set<string>;
  /**
   * `worktree.changed` events that carry the worktree's row (#51), the latest per worktree: the
   * row goes into the projects list, the inbox asks for just these rows, and the worktree's file
   * lists and diffs are refetched only where they moved.
   */
  deltas: Map<string, WorktreeDeltaEvent>;
  /**
   * Of `deltas`, the worktrees whose latest event has the cached `stateHash` but a later row (#51
   * review: e.g. its review state): only the row is applied, no list moved.
   */
  rowOnly: Set<string>;
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
    forges: false,
    activity: new Set(),
    deltas: new Map(),
    rowOnly: new Set(),
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
      // The feed moves with the state, but the projects list may already hold the new hash (any
      // refetch refreshes it), so this is decided before the hash check below.
      if (event.activitySeq !== undefined) effects.activity.add(event.worktreeId);
      if (cachedStateHash(queryClient, event.worktreeId) === event.stateHash) {
        // Same git state, but the row may be later (its review state landed after a projects
        // answer already showed the summary, #51 review): apply the row, refetch nothing.
        const row = cachedRow(queryClient, event.worktreeId);
        if (isDeltaEvent(event) && row && bringsNews(event, row)) {
          if (!effects.deltas.has(event.worktreeId)) effects.rowOnly.add(event.worktreeId);
          effects.deltas.set(event.worktreeId, event);
        }
        break;
      }
      if (isDeltaEvent(event)) {
        // Events arrive in order: the latest one per worktree is the one to apply.
        effects.deltas.set(event.worktreeId, event);
        effects.rowOnly.delete(event.worktreeId);
        break;
      }
      // An older daemon: refetch what may have moved.
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
      // Summaries carry review counts (status flow v2): the sidebar follows marks.
      effects.projects = true;
      break;
    case 'review.bulk':
      // Many marks at once: refetch the inbox and the files/diffs of the affected projects.
      effects.inbox = true;
      effects.projects = true;
      for (const id of worktreeIdsOfProjects(queryClient, event.projectIds)) {
        effects.worktrees.add(id);
      }
      break;
    case 'review.bookmark':
      // The To review range moved: counts, the review scope's files and diffs.
      effects.projects = true;
      effects.inbox = true;
      effects.worktrees.add(event.worktreeId);
      break;
    case 'review.ready':
      // First review states of an opened project (#10): only the sidebar's summaries change.
      effects.projects = true;
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
    case 'forge.updated':
      effects.forges = true;
      break;
  }
  return effects;
}

/** Above this many changed worktrees in one batch, the whole inbox is refetched instead. */
export const INBOX_DELTA_MAX_WORKTREES = INBOX_WORKTREES_MAX;

/** Per inbox query key and worktree: the newest delta batch whose rows were written. */
const inboxSeq = new WeakMap<QueryClient, { next: number; applied: Map<string, number> }>();

/**
 * Replaces the rows of `worktreeIds` in every inbox query on screen with the daemon's own rows for
 * them (`GET /api/inbox?worktreeIds=`, #51): one request per scope on screen, built by the daemon's
 * inbox rules (no reconstruction here). An inbox not on screen is only marked stale. A full inbox
 * fetch in flight would write older rows over these when it lands, so the rows are asked for after
 * it. Of two batches that overlap, the later one's rows are kept.
 */
async function applyInboxDelta(
  queryClient: QueryClient,
  api: ApiClient,
  worktreeIds: string[],
): Promise<void> {
  const seqs = inboxSeq.get(queryClient) ?? { next: 0, applied: new Map<string, number>() };
  inboxSeq.set(queryClient, seqs);
  const seq = ++seqs.next;
  const queries = queryClient.getQueryCache().findAll({ queryKey: queryKeys.inboxAll() });
  await Promise.all(
    queries.map(async (query) => {
      if (query.state.data === undefined) return;
      if (query.getObserversCount() === 0) {
        await queryClient.invalidateQueries({
          queryKey: query.queryKey,
          exact: true,
          refetchType: 'none',
        });
        return;
      }
      if (query.state.fetchStatus === 'fetching') await query.promise?.catch(() => undefined);
      const before = query.state.data as InboxResponse | undefined;
      if (!before) return;
      // Through React Query (its own key, dropped once done) so the refresh indicator
      // (`useIsFetching`) shows this fetch like any live refresh: since #51 it is often the only
      // request an edit causes, and a user watching the Inbox should see it.
      const response = await queryClient.fetchQuery({
        queryKey: queryKeys.inboxDelta(before.scope, worktreeIds, seq),
        queryFn: () => api.inbox({ scope: before.scope, worktreeIds }),
        staleTime: 0,
        gcTime: 0,
        retry: false,
      });
      const key = JSON.stringify(query.queryKey);
      const fresh = worktreeIds.filter((id) => (seqs.applied.get(`${key}\u0000${id}`) ?? 0) < seq);
      if (fresh.length === 0) return;
      for (const id of fresh) seqs.applied.set(`${key}\u0000${id}`, seq);
      const current = queryClient.getQueryData<InboxResponse>(query.queryKey) ?? before;
      const replaced = new Map<string, InboxEntry | null>(fresh.map((id) => [id, null]));
      for (const entry of response.entries) {
        if (replaced.has(entry.worktree.id)) replaced.set(entry.worktree.id, entry);
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
        generatedAt: response.generatedAt,
      });
    }),
  );
}

/** The file of a diff query, by `rawPath ?? path` (the diff key's own identity). */
function fileKeyOf(file: { path: string; rawPath?: string | undefined }): string {
  return file.rawPath ?? file.path;
}

/**
 * What the event's own path list says about a cached diff: `same` patch, `changed` (another patch,
 * or no longer changed), or `unknown` (no list, a truncated one, or one for another scope).
 */
function diffVerdict(
  data: DiffQueryData | undefined,
  paths: WorktreeChangedPaths | undefined,
): 'same' | 'changed' | 'unknown' {
  if (!data || !paths || paths.truncated) return 'unknown';
  if (scopeKey(paths.scope) !== scopeKey(data.scope)) return 'unknown';
  const key = fileKeyOf(data.diff);
  const listed = paths.files.find((f) => fileKeyOf(f) === key);
  return listed?.patchHash === data.diff.patchHash ? 'same' : 'changed';
}

/**
 * The file `fileKey` in a list that is current for the worktree's latest state (`stateHash`): the
 * file list query of the same view scope (`scopeKeyOf` = the query keys' scope part), else the
 * worktree's inbox row in that scope. Null: the current list does not have the file. Undefined: no
 * current list.
 */
function currentFile(
  queryClient: QueryClient,
  worktreeId: string,
  viewScopeKey: unknown,
  fileKey: unknown,
  stateHash: string | undefined,
): ChangedFile | null | undefined {
  if (stateHash === undefined) return undefined;
  const files = queryClient
    .getQueryCache()
    .find<FilesResponse>({ queryKey: ['files', worktreeId, viewScopeKey], exact: true });
  const state = files?.state;
  if (
    state?.data &&
    state.status === 'success' &&
    state.fetchStatus === 'idle' &&
    !state.isInvalidated &&
    state.data.stateHash === stateHash
  ) {
    return state.data.files.find((f) => fileKeyOf(f) === fileKey) ?? null;
  }
  const inbox = queryClient
    .getQueryCache()
    .find<InboxResponse>({ queryKey: ['inbox', viewScopeKey], exact: true });
  const entry = inbox?.state.data?.entries.find((e) => e.worktree.id === worktreeId);
  if (entry && !inbox?.state.isInvalidated && entry.summary.stateHash === stateHash) {
    return entry.files.find((f) => fileKeyOf(f) === fileKey) ?? null;
  }
  return undefined;
}

/**
 * A delta worktree's file lists, diffs and commits (#51). Its file lists are refetched (the ones on
 * screen; the others are marked stale). A diff is refetched only when its own file moved: at once
 * when the event's path list (same scope) says its patch changed, else once the current list (the
 * refetched file list, or the inbox row) is in, by `patchHash`; a diff that kept its patch keeps
 * its data (and takes the list's `reviewed`). Nothing current to compare with: invalidated, as
 * before. Commits only when HEAD or the branch moved.
 */
async function refreshDeltaLists(
  queryClient: QueryClient,
  event: WorktreeDeltaEvent,
  previous: WorktreeListItem | undefined,
  inboxDone: Promise<unknown>,
): Promise<void> {
  const id = event.worktreeId;
  const tasks: Promise<unknown>[] = [];
  const before = previous?.summary;
  const now = event.summary;
  if (!before || !now || before.headSha !== now.headSha || before.branch !== now.branch) {
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.commits(id) }));
  }
  const later: Query[] = [];
  for (const query of queryClient.getQueryCache().findAll({ queryKey: queryKeys.diffAll(id) })) {
    const verdict = diffVerdict(query.state.data as DiffQueryData | undefined, event.paths);
    if (verdict === 'changed') {
      tasks.push(queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }));
    } else {
      later.push(query);
    }
  }
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.filesAll(id) }),
    inboxDone.catch(() => undefined),
  ]);
  const stateHash = cachedStateHash(queryClient, id);
  for (const query of later) {
    const data = query.state.data as DiffQueryData | undefined;
    if (!data) continue;
    const file = currentFile(queryClient, id, query.queryKey[2], query.queryKey[3], stateHash);
    const kept =
      file === undefined
        ? diffVerdict(data, event.paths) === 'same'
        : file !== null && file.patchHash === data.diff.patchHash;
    if (!kept) {
      tasks.push(queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }));
    } else if (file && file.reviewed !== data.diff.reviewed) {
      queryClient.setQueryData<DiffQueryData>(query.queryKey, {
        ...data,
        diff: { ...data.diff, reviewed: file.reviewed },
      });
    }
  }
  await Promise.all(tasks);
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
    // A reconnect: the daemon may have restarted (its `rev` counts again); everything refetches.
    forgetRows(queryClient);
    await queryClient.invalidateQueries();
    return;
  }
  // Deltas first (#51): rows into the projects list. A worktree the cached list does not know (no
  // list yet, or added / removed meanwhile) falls back to a refetch, as does one that also had an
  // event without a delta in this batch.
  const deltas: Array<{ event: WorktreeDeltaEvent; previous: WorktreeListItem | undefined }> = [];
  for (const [id, event] of effects.deltas) {
    if (effects.worktrees.has(id)) continue;
    const applied = applyRow(queryClient, event);
    if (applied.kind === 'unknown') {
      effects.worktrees.add(id);
      effects.projects = true;
      effects.inbox = true;
      continue;
    }
    if (effects.rowOnly.has(id)) continue;
    deltas.push({ event, previous: applied.previous });
  }
  const tasks: Promise<unknown>[] = [];
  if (effects.settings) tasks.push(queryClient.invalidateQueries({ queryKey: ['settings'] }));
  if (effects.forges) tasks.push(queryClient.invalidateQueries({ queryKey: ['forges'] }));
  if (effects.projects) {
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.projects() }));
  }
  let inboxDone: Promise<unknown> = Promise.resolve();
  if (effects.inbox) {
    inboxDone = queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll() });
  } else if (deltas.length > 0) {
    const ids = deltas.map((d) => d.event.worktreeId);
    inboxDone =
      api && ids.length <= INBOX_DELTA_MAX_WORKTREES
        ? applyInboxDelta(queryClient, api, ids).catch(() =>
            queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll() }),
          )
        : queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll() });
  }
  tasks.push(inboxDone);
  if (effects.scanRoots)
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.scanRoots() }));
  for (const id of effects.activity) {
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.activity(id) }));
  }
  for (const id of effects.worktrees) {
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.filesAll(id) }));
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.diffAll(id) }));
    tasks.push(queryClient.invalidateQueries({ queryKey: queryKeys.commits(id) }));
  }
  for (const { event, previous } of deltas) {
    tasks.push(refreshDeltaLists(queryClient, event, previous, inboxDone));
  }
  await Promise.all(tasks);
}
