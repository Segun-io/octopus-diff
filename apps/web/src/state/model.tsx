import type {
  DiffScope,
  EffectiveReviewPolicy,
  FileListCounts,
  InboxEntry,
  WorktreeForge,
} from '@octopus-diff/contracts';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react';
import { filesComplete, filesTotal } from '../api/files.ts';
import { useForgeIndex } from '../api/forges.ts';
import { isPartialInbox, useFilesQuery, useInboxQuery, useProjectsQuery } from '../api/queries.ts';
import { useScanRootsQuery } from '../api/settings.ts';
import { fileRefKey } from '../lib/fileRef.ts';
import {
  buildSidebar,
  type FileGroup,
  flattenGroups,
  hasSidebarFilters,
  isBaseFile,
  isMixedFile,
  listsReviewed,
  type NavEntry,
  type OriginStats,
  type OriginView,
  originStats,
  originVisibleIf,
  ownFirst,
  rowVisible,
  type SidebarFilters,
  type SidebarModel,
  shortRef,
  sortFiles,
  sortFilesTreeOrder,
  sortInboxEntries,
  type VisiblePredicate,
  visibleIf,
} from '../lib/model.ts';
import { effectivePolicy } from '../lib/policy.ts';
import { useUi, type View } from './ui.tsx';

/**
 * What a worktree's loaded files are of its whole list (#42): the open list's prefix, or an inbox
 * row's first page. `counts` are the whole list's (null from an older daemon, whose lists are
 * always complete).
 */
export interface ListInfo {
  complete: boolean;
  loaded: number;
  total: number;
  counts: FileListCounts | null;
}

export interface AppModel {
  view: View;
  scope: DiffScope;
  projects: ReturnType<typeof useProjectsQuery>;
  scanRoots: ReturnType<typeof useScanRootsQuery>;
  files: ReturnType<typeof useFilesQuery>;
  sidebar: SidebarModel;
  /** Every worktree's review data in sidebar order (unfiltered): what `n` and bulk "all" read. */
  inboxEntries: InboxEntry[];
  /** The open worktree's file group (empty when no worktree is open). */
  groups: FileGroup[];
  /** Every file of the open worktree, in display order. */
  entries: NavEntry[];
  /**
   * The groups "Review all worktrees" acts on: one per worktree of the list that passes the
   * sidebar filters and is in the review loop (the cross-worktree data, current scope).
   */
  allGroups: FileGroup[];
  /** Every file of `allGroups`, in display order. */
  allEntries: NavEntry[];
  /** Files across all worktrees for `n` (current scope; commit scope: current list only). */
  globalEntries: NavEntry[];
  /** The groups `globalEntries` is made of, rows without loaded files included (#42). */
  globalGroups: FileGroup[];
  /** What `j`/`k` reach and the list shows: the eye and the "from main" view (wrapped group, chip). */
  visible: VisiblePredicate;
  /** Only the origin part of `visible`; `n` honours it too (a collapsed group is skipped). */
  originVisible: VisiblePredicate;
  /** How the base files (merge noise) are treated right now. */
  originView: OriginView;
  /** Own, mixed and base files per worktree of the list, after the eye (`originStats`). */
  originStats: ReadonlyMap<string, OriginStats>;
  /** The default-branch ref a worktree's base files came from, for labels (`origin/main`). */
  originRefs: ReadonlyMap<string, string>;
  /** The chip: base files in the list, and the short ref it names (`main`). */
  fromMain: { count: number; ref: string };
  /** Mixed files in the list (the default branch changed them too): the toggle's reason. */
  mixedCount: number;
  /** The list shows reviewed files (`listsReviewed`: All on branch always, To review never, else the eye). */
  showsReviewed: boolean;
  /** True when the current view's file data is loaded for the current scope. */
  viewReady: boolean;
  selectedKey: string | null;
  selectedEntry: NavEntry | undefined;
  /** Unreviewed files across every worktree in the review loop (current scope). */
  unreviewedTotal: number;
  /** Worktrees whose review policy is disabled. */
  disabledWorktrees: ReadonlySet<string>;
  /**
   * The `stateHash` a bulk request for a worktree's own file list expects: the state of the files
   * it acts on (the open file list's, then the review data's row, then the sidebar's).
   */
  stateHashes: ReadonlyMap<string, string>;
  /**
   * The `stateHash` of each review data row (`inboxEntries`): the one snapshot `allGroups` /
   * `allEntries` were built from, so a plan over those files expects exactly their state.
   */
  inboxStateHashes: ReadonlyMap<string, string>;
  /**
   * The open worktree is a row of the list the sidebar shows (the filters apply). False for a
   * worktree the filters leave out, or that is gone: its pane is not shown and keys do not act on it.
   */
  viewListed: boolean;
  /**
   * The open worktree's row has moved on (an event carried its new state) but the file list on
   * screen is still the old one, for a moment: what a bulk mark would act on is not what the row
   * says. "Review all" waits (it would send the old list's hash and the daemon would skip it).
   */
  listBehind: boolean;
  /**
   * What the open list is doing about it: `refreshing` (a request is in flight, or about to be)
   * or `failed` (the refetch for this pair of states ended and the list is still behind: a failed
   * request, or a daemon that answers an older state). Null when the list is current.
   */
  listState: 'refreshing' | 'failed' | null;
  /**
   * The worktrees of the list the sidebar shows (the filters apply): the one predicate of what a
   * pane can show, used by the pane, `n`, `J`/`K`, the landing and the bulk plans (DECISIONS #281).
   */
  listedIds: ReadonlySet<string>;
  /** No sidebar filter and no hidden file: a bulk on every worktree is one `all` request. */
  allUnfiltered: boolean;
  /** Effective policy of the selected worktree view (null outside a worktree). */
  viewPolicy: EffectiveReviewPolicy | null;
  /**
   * Paged lists (#42), per worktree: the open list's prefix, else the inbox row's first page. A
   * worktree without an entry has its whole list loaded (or none).
   */
  lists: ReadonlyMap<string, ListInfo>;
  /** The open worktree's list (null outside a worktree or before it loads). */
  openList: ListInfo | null;
  /**
   * The open list is partly loaded (#42): whether files it would show are beyond the loaded ones
   * (from the counts and the eye / "from main" view), and whether its own files are all loaded.
   * Null when the list is complete.
   */
  openMore: { visibleMore: boolean; ownComplete: boolean } | null;
}

const AppModelContext = createContext<AppModel | null>(null);

export function useAppModel(): AppModel {
  const model = useContext(AppModelContext);
  if (!model) throw new Error('AppModelProvider missing');
  return model;
}

export function AppModelProvider({ children }: { children: ReactNode }) {
  const model = useBuildAppModel();
  return <AppModelContext value={model}>{children}</AppModelContext>;
}

function useBuildAppModel(): AppModel {
  const view = useUi((s) => s.view);
  const scope = useUi((s) => s.scope);
  const filterFolders = useUi((s) => s.filterFolders);
  const filterProjects = useUi((s) => s.filterProjects);
  const filterWorktrees = useUi((s) => s.filterWorktrees);
  const onlyDirty = useUi((s) => s.onlyDirty);
  const onlyUnreviewed = useUi((s) => s.onlyUnreviewed);
  const filters = useMemo<SidebarFilters>(
    () => ({
      folders: filterFolders,
      projects: filterProjects,
      worktrees: filterWorktrees,
      onlyDirty,
      onlyUnreviewed,
    }),
    [filterFolders, filterProjects, filterWorktrees, onlyDirty, onlyUnreviewed],
  );
  const showReviewed = useUi((s) => s.showReviewed);
  const showsReviewed = listsReviewed(showReviewed, scope.kind);
  const fromMainOnly = useUi((s) => s.fromMainOnly);
  const originOpen = useUi((s) => s.originOpen);
  const originView = useMemo<OriginView>(
    () => ({ fromMainOnly, expanded: new Set(originOpen) }),
    [fromMainOnly, originOpen],
  );
  const selected = useUi((s) => s.selected);
  const pinned = useUi((s) => s.pinned);
  const settle = useUi((s) => s.settle);

  const projects = useProjectsQuery();
  const scanRoots = useScanRootsQuery();
  // The sidebar's status never depends on the toolbar scope (docs/STATUS-FLOW.md §1.1), nor on
  // the review data: it comes from the projects list alone, so it paints first (#10).
  // The review data of every worktree (the daemon's inbox rows): `n` and bulk "all" read it.
  const inbox = useInboxQuery(scope);
  const worktreeId = view.kind === 'worktree' ? view.worktreeId : null;
  const files = useFilesQuery(worktreeId, scope);

  const projectList = projects.data?.projects;
  const inboxData = inbox.data;

  const scanRootList = scanRoots.data?.scanRoots;
  // Forge data moves rows only through stages (In PR, Merged/closed); never the toolbar scope.
  const forgeIndex = useForgeIndex();
  const forgeByWorktree = useMemo(() => {
    const out = new Map<string, WorktreeForge>();
    for (const [id, entry] of forgeIndex) out.set(id, entry.worktree);
    return out;
  }, [forgeIndex]);
  const sidebar = useMemo(
    () => buildSidebar(projectList ?? [], filters, scanRootList, pinned, settle, forgeByWorktree),
    [forgeByWorktree, projectList, filters, scanRootList, pinned, settle],
  );

  const inboxEntries = useMemo(() => sortInboxEntries(inboxData?.entries ?? []), [inboxData]);

  const sortedInboxFiles = useMemo(() => {
    const map = new Map<string, FileGroup>();
    for (const entry of inboxEntries) {
      map.set(entry.worktree.id, {
        project: entry.project,
        worktree: entry.worktree,
        files: ownFirst(sortFiles(entry.files)),
      });
    }
    return map;
  }, [inboxEntries]);

  const fileListLayout = useUi((s) => s.fileListLayout);
  const filesData = files.data;
  const allGroups = useMemo<FileGroup[]>(() => {
    const out: FileGroup[] = [];
    for (const entry of inboxEntries) {
      const row = sidebar.byId.get(entry.worktree.id);
      if (row && !rowVisible(row, filters)) continue;
      const group = sortedInboxFiles.get(entry.worktree.id);
      if (group) out.push(group);
    }
    return out;
  }, [inboxEntries, sortedInboxFiles, sidebar, filters]);
  const allEntries = useMemo(() => flattenGroups(allGroups), [allGroups]);

  const groups = useMemo<FileGroup[]>(() => {
    if (view.kind !== 'worktree') return [];
    const row = sidebar.byId.get(view.worktreeId);
    if (!row || !filesData) return [];
    // F10: in the tree layout, j/k/n follow the tree's displayed order. The list puts the files
    // that came from the default branch last (its collapsed group); the tree cannot host a group.
    const sorted =
      fileListLayout === 'tree'
        ? sortFilesTreeOrder(filesData.files)
        : ownFirst(sortFiles(filesData.files));
    return [{ project: row.project, worktree: row.worktree, files: sorted }];
  }, [view, sidebar, filesData, fileListLayout]);

  const entries = useMemo(() => flattenGroups(groups), [groups]);

  const disabledWorktrees = useMemo(() => {
    const out = new Set<string>();
    for (const row of sidebar.byId.values()) if (!row.review.enabled) out.add(row.worktree.id);
    for (const entry of inboxEntries) {
      if (!sidebar.byId.has(entry.worktree.id) && !effectivePolicy(entry.review).enabled) {
        out.add(entry.worktree.id);
      }
    }
    return out;
  }, [sidebar, inboxEntries]);

  // The state a bulk request expects (the daemon skips a worktree that moved on) is the state of
  // the files it acts on: the open file list's, then the review data's row, then the sidebar's. Since
  // #51 the sidebar row is applied from the event at once while those lists refetch, so the
  // sidebar's hash can be newer than the files on screen; sending it would defeat the stale check.
  const stateHashes = useMemo(() => {
    const out = new Map<string, string>();
    if (filesData) out.set(filesData.worktreeId, filesData.stateHash);
    for (const entry of inboxEntries) {
      if (!out.has(entry.worktree.id)) out.set(entry.worktree.id, entry.summary.stateHash);
    }
    for (const row of sidebar.byId.values()) {
      if (row.summary && !out.has(row.worktree.id)) {
        out.set(row.worktree.id, row.summary.stateHash);
      }
    }
    return out;
  }, [sidebar, inboxEntries, filesData]);

  const inboxStateHashes = useMemo(() => {
    const out = new Map<string, string>();
    for (const entry of inboxEntries) out.set(entry.worktree.id, entry.summary.stateHash);
    return out;
  }, [inboxEntries]);

  const openRow = view.kind === 'worktree' ? sidebar.byId.get(view.worktreeId) : undefined;
  // Not for a row with no summary or an error.
  const listBehind =
    filesData !== undefined &&
    filesData.worktreeId === openRow?.worktree.id &&
    openRow.summary !== null &&
    openRow.error === null &&
    filesData.stateHash !== openRow.summary.stateHash;

  // A list behind its row with nothing in flight is refetched, once per pair of states, so it can
  // never stay stuck behind a row nobody will move again. A refetch that ends with the list still
  // behind is `failed`: the button says so instead of claiming a refresh.
  const listBehindKey = listBehind
    ? `${openRow?.summary?.stateHash}|${filesData?.stateHash}`
    : null;
  const healedKey = useRef<string | null>(null);
  const refetchFiles = files.refetch;
  const filesFetching = files.isFetching;
  useEffect(() => {
    if (listBehindKey === null) {
      healedKey.current = null;
      return;
    }
    if (filesFetching || healedKey.current === listBehindKey) return;
    healedKey.current = listBehindKey;
    void refetchFiles();
  }, [listBehindKey, filesFetching, refetchFiles]);
  const listState: AppModel['listState'] = !listBehind
    ? null
    : filesFetching || healedKey.current !== listBehindKey
      ? 'refreshing'
      : 'failed';

  const listedIds = useMemo<ReadonlySet<string>>(() => new Set(sidebar.order), [sidebar.order]);
  const viewListed = view.kind !== 'worktree' || listedIds.has(view.worktreeId);

  // While its batches are still landing (#10) the data covers less than an "all" request does.
  const allUnfiltered =
    !isPartialInbox(scope) &&
    !hasSidebarFilters(filters) &&
    showsReviewed &&
    !fromMainOnly &&
    allGroups.length === inboxEntries.length;

  const viewPolicy =
    view.kind === 'worktree' ? (sidebar.byId.get(view.worktreeId)?.review ?? null) : null;

  const lists = useMemo(() => {
    const out = new Map<string, ListInfo>();
    for (const entry of inboxEntries) {
      const total = entry.filesTotal ?? entry.files.length;
      out.set(entry.worktree.id, {
        complete: entry.listing === 'overtaken' ? false : entry.files.length >= total,
        loaded: entry.files.length,
        total,
        counts: entry.fileCounts ?? null,
      });
    }
    if (filesData) {
      out.set(filesData.worktreeId, {
        complete: filesComplete(filesData),
        loaded: filesData.files.length,
        total: filesTotal(filesData),
        counts: filesData.counts ?? null,
      });
    }
    return out;
  }, [inboxEntries, filesData]);
  const openList =
    view.kind === 'worktree' && filesData?.worktreeId === view.worktreeId
      ? (lists.get(view.worktreeId) ?? null)
      : null;

  const globalGroups = useMemo(() => {
    if (scope.kind === 'commit') return groups;
    const all: FileGroup[] = [];
    for (const entry of inboxEntries) {
      if (view.kind === 'worktree' && entry.worktree.id === view.worktreeId && groups[0]) {
        all.push(groups[0]);
      } else {
        const group = sortedInboxFiles.get(entry.worktree.id);
        if (group) all.push(group);
      }
    }
    // The current worktree may not be in the inbox yet (e.g. just became dirty).
    if (view.kind === 'worktree' && groups[0] && !sortedInboxFiles.has(view.worktreeId)) {
      all.push(groups[0]);
    }
    return all;
  }, [scope.kind, inboxEntries, sortedInboxFiles, view, groups]);
  const globalEntries = useMemo(() => flattenGroups(globalGroups), [globalGroups]);

  const visible = useMemo(() => visibleIf(showsReviewed, originView), [showsReviewed, originView]);
  const originVisible = useMemo(() => originVisibleIf(originView), [originView]);
  // Lists come in pages (#42): the base files of a partly loaded list are counted from the
  // whole list's counts (the chip and the "from main" row), not from the loaded ones.
  const openCounts = openList && !openList.complete ? openList.counts : null;
  const originStatsByWorktree = useMemo(() => {
    const stats = originStats(entries, visibleIf(showsReviewed));
    if (openCounts && view.kind === 'worktree') {
      const s = stats.get(view.worktreeId) ?? { own: 0, base: 0, mixed: 0, vias: new Set() };
      s.base = showsReviewed ? openCounts.base : openCounts.base - openCounts.baseReviewed;
      stats.set(view.worktreeId, s);
    }
    return stats;
  }, [entries, showsReviewed, openCounts, view]);
  const openMore = useMemo<AppModel['openMore']>(() => {
    if (!openList || openList.complete || view.kind !== 'worktree') return null;
    const c = openList.counts;
    let ownLoaded = 0;
    for (const e of entries) if (!isBaseFile(e.file)) ownLoaded++;
    const ownComplete = c !== null && ownLoaded >= c.total - c.base;
    if (!c) return { visibleMore: true, ownComplete };
    // Would the list show more than it does? From the whole list's counts and what is on screen.
    const ownTotal = c.total - c.base;
    const ownUnreviewed = ownTotal - (c.reviewed - c.baseReviewed);
    const baseUnreviewed = c.base - c.baseReviewed;
    const ownShown = !fromMainOnly;
    const baseShown = fromMainOnly || originView.expanded.has(view.worktreeId);
    const full =
      (ownShown ? (showsReviewed ? ownTotal : ownUnreviewed) : 0) +
      (baseShown ? (showsReviewed ? c.base : baseUnreviewed) : 0);
    let shown = 0;
    for (const e of entries) if (visible(e)) shown++;
    return { visibleMore: full > shown, ownComplete };
  }, [openList, view, entries, fromMainOnly, originView, showsReviewed, visible]);
  const originRefs = useMemo(() => {
    const out = new Map<string, string>();
    for (const g of groups) {
      const id = g.worktree.id;
      const ref =
        sidebar.byId.get(id)?.summary?.review?.integrationRef ??
        inboxEntries.find((e) => e.worktree.id === id)?.summary.review?.integrationRef ??
        g.project.defaultBranch ??
        'main';
      out.set(id, ref);
    }
    return out;
  }, [groups, sidebar, inboxEntries]);
  const fromMain = useMemo(() => {
    let count = 0;
    const refs = new Set<string>();
    for (const [id, stats] of originStatsByWorktree) {
      if (stats.base === 0) continue;
      count += stats.base;
      refs.add(shortRef(originRefs.get(id) ?? 'main'));
    }
    const [only] = refs.size === 1 ? [...refs] : [];
    return { count, ref: only ?? 'main' };
  }, [originStatsByWorktree, originRefs]);
  const mixedCount = useMemo(() => {
    let n = 0;
    for (const e of entries) if (isMixedFile(e.file)) n++;
    return n;
  }, [entries]);

  const viewReady =
    view.kind === 'worktree'
      ? filesData !== undefined && sidebar.byId.has(view.worktreeId)
      : projectList !== undefined;

  const selectedKey = selected ? fileRefKey(selected) : null;
  const selectedEntry = useMemo(
    () =>
      selectedKey === null
        ? undefined
        : (entries.find((e) => e.key === selectedKey) ??
          globalEntries.find((e) => e.key === selectedKey)),
    [selectedKey, entries, globalEntries],
  );

  const unreviewedTotal = useMemo(() => {
    let n = 0;
    for (const row of sidebar.byId.values()) n += row.unreviewed;
    return n;
  }, [sidebar]);

  return {
    view,
    scope,
    projects,
    scanRoots,
    files,
    sidebar,
    unreviewedTotal,
    disabledWorktrees,
    stateHashes,
    inboxStateHashes,
    viewListed,
    listBehind,
    listState,
    listedIds,
    allUnfiltered,
    viewPolicy,
    lists,
    openList,
    openMore,
    inboxEntries,
    groups,
    entries,
    allGroups,
    allEntries,
    globalEntries,
    globalGroups,
    visible,
    originVisible,
    originView,
    originStats: originStatsByWorktree,
    originRefs,
    fromMain,
    mixedCount,
    showsReviewed,
    viewReady,
    selectedKey,
    selectedEntry,
  };
}
