import type { DiffScope, InboxEntry } from '@octopus-diff/contracts';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { inboxScopeFor, useFilesQuery, useInboxQuery, useProjectsQuery } from '../api/queries.ts';
import { fileRefKey } from '../lib/fileRef.ts';
import {
  buildSidebar,
  type FileGroup,
  flattenGroups,
  type NavEntry,
  rowVisible,
  type SidebarModel,
  sortFiles,
  sortInboxEntries,
  type VisiblePredicate,
  visibleIf,
} from '../lib/model.ts';
import { useUi, type View } from './ui.tsx';

export interface AppModel {
  view: View;
  scope: DiffScope;
  projects: ReturnType<typeof useProjectsQuery>;
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
  /** True when the current view's file data is loaded for the current scope. */
  viewReady: boolean;
  selectedKey: string | null;
  selectedEntry: NavEntry | undefined;
  /** Unreviewed files across every worktree in the review loop (current scope). */
  unreviewedTotal: number;
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
  const filterText = useUi((s) => s.filterText);
  const onlyDirty = useUi((s) => s.onlyDirty);
  const onlyUnreviewed = useUi((s) => s.onlyUnreviewed);
  const showReviewed = useUi((s) => s.showReviewed);
  const selected = useUi((s) => s.selected);

  const projects = useProjectsQuery();
  const inbox = useInboxQuery(scope);
  const worktreeId = view.kind === 'worktree' ? view.worktreeId : null;
  const files = useFilesQuery(worktreeId, scope);

  const projectList = projects.data?.projects;
  const inboxData = inbox.data;
  // While the inbox for a new scope loads, the previous scope's data is only a placeholder.
  const inboxMatchesScope = inboxData !== undefined && !inbox.isPlaceholderData;

  const sidebar = useMemo(
    () =>
      buildSidebar(projectList ?? [], inboxMatchesScope ? inboxData?.entries : undefined, {
        text: filterText,
        onlyDirty,
        onlyUnreviewed,
      }),
    [projectList, inboxData, inboxMatchesScope, filterText, onlyDirty, onlyUnreviewed],
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

  const filesData = files.data;
  const groups = useMemo<FileGroup[]>(() => {
    if (view.kind === 'inbox') {
      const filters = { text: filterText, onlyDirty, onlyUnreviewed };
      const out: FileGroup[] = [];
      for (const entry of inboxEntries) {
        const row = sidebar.byId.get(entry.worktree.id);
        if (row && !rowVisible(row, filters)) continue;
        const group = sortedInboxFiles.get(entry.worktree.id);
        if (group) out.push(group);
      }
      return out;
    }
    const row = sidebar.byId.get(view.worktreeId);
    if (!row || !filesData) return [];
    return [{ project: row.project, worktree: row.worktree, files: sortFiles(filesData.files) }];
  }, [
    view,
    inboxEntries,
    sortedInboxFiles,
    sidebar,
    filesData,
    filterText,
    onlyDirty,
    onlyUnreviewed,
  ]);

  const entries = useMemo(() => flattenGroups(groups), [groups]);

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

  const visible = useMemo(() => visibleIf(showReviewed), [showReviewed]);

  const viewReady =
    view.kind === 'inbox'
      ? inboxData !== undefined &&
        !inbox.isPlaceholderData &&
        inboxScopeFor(scope).kind === inboxData.scope.kind
      : filesData !== undefined && sidebar.byId.has(view.worktreeId);

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
    inbox,
    files,
    sidebar,
    unreviewedTotal,
    inboxEntries,
    groups,
    entries,
    globalEntries,
    visible,
    viewReady,
    selectedKey,
    selectedEntry,
  };
}
