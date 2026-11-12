import type {
  DiffScope,
  EffectiveReviewPolicy,
  InboxEntry,
  WorktreeForge,
} from '@octopus-diff/contracts';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { useForgeIndex } from '../api/forges.ts';
import {
  inboxScopeFor,
  isPartialInbox,
  useFilesQuery,
  useInboxQuery,
  useProjectsQuery,
} from '../api/queries.ts';
import { useScanRootsQuery } from '../api/settings.ts';
import { fileRefKey } from '../lib/fileRef.ts';
import {
  buildSidebar,
  type FileGroup,
  flattenGroups,
  hasSidebarFilters,
  listsReviewed,
  type NavEntry,
  rowVisible,
  type SidebarFilters,
  type SidebarModel,
  sortFiles,
  sortFilesTreeOrder,
  sortInboxEntries,
  type VisiblePredicate,
  visibleIf,
} from '../lib/model.ts';
import { effectivePolicy } from '../lib/policy.ts';
import { useUi, type View } from './ui.tsx';

export interface AppModel {
  view: View;
  scope: DiffScope;
  projects: ReturnType<typeof useProjectsQuery>;
  scanRoots: ReturnType<typeof useScanRootsQuery>;
  inbox: ReturnType<typeof useInboxQuery>;
  files: ReturnType<typeof useFilesQuery>;
  sidebar: SidebarModel;
  /** Inbox entries in sidebar order (unfiltered). */
  inboxEntries: InboxEntry[];
  /** File groups for the current view (inbox: one per visible dirty worktree). */
  groups: FileGroup[];
  /** Every file of the current view, in display order. */
  entries: NavEntry[];
  /** Files across all worktrees for `n` (current scope; commit scope: current list only). */
  globalEntries: NavEntry[];
  visible: VisiblePredicate;
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
  /** Current `stateHash` per worktree (from the projects list), for bulk `expectedStateHashes`. */
  stateHashes: ReadonlyMap<string, string>;
  /** Inbox view with no sidebar filter and no hidden file: a bulk "all" matches what is shown. */
  inboxUnfiltered: boolean;
  /** Effective policy of the selected worktree view (null in the Inbox). */
  viewPolicy: EffectiveReviewPolicy | null;
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
  const filterProjects = useUi((s) => s.filterProjects);
  const filterWorktrees = useUi((s) => s.filterWorktrees);
  const onlyDirty = useUi((s) => s.onlyDirty);
  const onlyUnreviewed = useUi((s) => s.onlyUnreviewed);
  const filters = useMemo<SidebarFilters>(
    () => ({ projects: filterProjects, worktrees: filterWorktrees, onlyDirty, onlyUnreviewed }),
    [filterProjects, filterWorktrees, onlyDirty, onlyUnreviewed],
  );
  const showReviewed = useUi((s) => s.showReviewed);
  const showsReviewed = listsReviewed(showReviewed, scope.kind);
  const selected = useUi((s) => s.selected);
  const pinned = useUi((s) => s.pinned);
  const settle = useUi((s) => s.settle);

  const projects = useProjectsQuery();
  const scanRoots = useScanRootsQuery();
  // The sidebar's status never depends on the toolbar scope (docs/STATUS-FLOW.md §1.1), nor on
  // an inbox: it comes from the projects list alone, so it paints first (#10).
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
        files: sortFiles(entry.files),
      });
    }
    return map;
  }, [inboxEntries]);

  const reviewOffDisplay = useUi((s) => s.reviewOffDisplay);
  const fileListLayout = useUi((s) => s.fileListLayout);
  const filesData = files.data;
  const groups = useMemo<FileGroup[]>(() => {
    if (view.kind === 'inbox') {
      const out: FileGroup[] = [];
      for (const entry of inboxEntries) {
        const row = sidebar.byId.get(entry.worktree.id);
        if (row && !rowVisible(row, filters)) continue;
        const enabled = row ? row.review.enabled : effectivePolicy(entry.review).enabled;
        if (!enabled && reviewOffDisplay === 'hide') continue;
        const group = sortedInboxFiles.get(entry.worktree.id);
        if (group) out.push(group);
      }
      return out;
    }
    if (view.kind !== 'worktree') return [];
    const row = sidebar.byId.get(view.worktreeId);
    if (!row || !filesData) return [];
    // F10: in the tree layout, j/k/n follow the tree's displayed order.
    const sorted =
      fileListLayout === 'tree' ? sortFilesTreeOrder(filesData.files) : sortFiles(filesData.files);
    return [{ project: row.project, worktree: row.worktree, files: sorted }];
  }, [
    view,
    inboxEntries,
    sortedInboxFiles,
    sidebar,
    filesData,
    filters,
    reviewOffDisplay,
    fileListLayout,
  ]);

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

  const stateHashes = useMemo(() => {
    const out = new Map<string, string>();
    for (const row of sidebar.byId.values()) {
      if (row.summary) out.set(row.worktree.id, row.summary.stateHash);
    }
    for (const entry of inboxEntries) {
      if (!out.has(entry.worktree.id)) out.set(entry.worktree.id, entry.summary.stateHash);
    }
    return out;
  }, [sidebar, inboxEntries]);

  // While its batches are still landing (#10) the Inbox shows less than an "all" request covers.
  const inboxUnfiltered =
    view.kind === 'inbox' &&
    !isPartialInbox(inboxData) &&
    !hasSidebarFilters(filters) &&
    showsReviewed &&
    groups.length === inboxEntries.length;

  const viewPolicy =
    view.kind === 'worktree' ? (sidebar.byId.get(view.worktreeId)?.review ?? null) : null;

  const globalEntries = useMemo(() => {
    if (scope.kind === 'commit') return entries;
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
    return flattenGroups(all);
  }, [scope.kind, entries, inboxEntries, sortedInboxFiles, view, groups]);

  const visible = useMemo(() => visibleIf(showsReviewed), [showsReviewed]);

  const viewReady =
    view.kind === 'inbox'
      ? inboxData !== undefined &&
        !inbox.isPlaceholderData &&
        inboxScopeFor(scope).kind === inboxData.scope.kind
      : view.kind === 'worktree'
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
    inbox,
    files,
    sidebar,
    unreviewedTotal,
    disabledWorktrees,
    stateHashes,
    inboxUnfiltered,
    viewPolicy,
    inboxEntries,
    groups,
    entries,
    globalEntries,
    visible,
    showsReviewed,
    viewReady,
    selectedKey,
    selectedEntry,
  };
}
