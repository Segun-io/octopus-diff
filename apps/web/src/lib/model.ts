/**
 * Pure view-model functions: sidebar grouping and filters, file ordering, keyboard navigation.
 * Kept free of React so they are easy to test and cheap to memoize.
 */
import type {
  ChangedFile,
  InboxEntry,
  Project,
  ProjectListItem,
  Worktree,
  WorktreeListItem,
  WorktreeSummary,
} from '@octopus-diff/contracts';
import { fileRefKey, toFileRef } from './fileRef.ts';

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareProjects(a: Project, b: Project): number {
  return cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.id, b.id);
}

/** Main worktree first, then by branch (detached last), then by path. */
export function compareWorktrees(a: Worktree, b: Worktree): number {
  if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
  if ((a.branch === null) !== (b.branch === null)) return a.branch === null ? 1 : -1;
  return cmp(a.branch ?? '', b.branch ?? '') || cmp(a.path, b.path);
}

export function compareFiles(a: ChangedFile, b: ChangedFile): number {
  return cmp(a.path, b.path) || cmp(a.rawPath ?? '', b.rawPath ?? '');
}

export function sortFiles(files: readonly ChangedFile[]): ChangedFile[] {
  return [...files].sort(compareFiles);
}

// --- sidebar --------------------------------------------------------------------------------

export interface SidebarFilters {
  text: string;
  onlyDirty: boolean;
  onlyUnreviewed: boolean;
}

export interface WorktreeRow {
  project: Project;
  worktree: Worktree;
  summary: WorktreeSummary | null;
  error: WorktreeListItem['error'];
  /** Unreviewed files in the current scope (from the inbox), 0 if not in the inbox. */
  unreviewed: number;
  /** Changed files in the current scope (from the inbox), 0 if not in the inbox. */
  scopeFiles: number;
}

export interface ProjectGroup {
  project: Project;
  rows: WorktreeRow[];
}

export interface SidebarModel {
  groups: ProjectGroup[];
  /** Visible worktree ids in display order (for J/K). */
  order: string[];
  /** Every worktree row by id, regardless of filters. */
  byId: Map<string, WorktreeRow>;
}

export function isDirtySummary(summary: WorktreeSummary | null): boolean {
  return summary !== null && summary.changedFiles > 0;
}

function matchesText(row: WorktreeRow, needle: string): boolean {
  if (!needle) return true;
  return (
    row.project.name.toLowerCase().includes(needle) ||
    (row.worktree.branch ?? '').toLowerCase().includes(needle) ||
    row.worktree.path.toLowerCase().includes(needle)
  );
}

export function rowVisible(row: WorktreeRow, filters: SidebarFilters): boolean {
  if (filters.onlyDirty && !isDirtySummary(row.summary)) return false;
  if (filters.onlyUnreviewed && row.unreviewed === 0) return false;
  return matchesText(row, filters.text.trim().toLowerCase());
}

export function buildSidebar(
  projects: readonly ProjectListItem[],
  inbox: readonly InboxEntry[] | undefined,
  filters: SidebarFilters,
): SidebarModel {
  const inboxStats = new Map<string, { unreviewed: number; files: number }>();
  for (const entry of inbox ?? []) {
    let unreviewed = 0;
    for (const f of entry.files) if (!f.reviewed) unreviewed++;
    inboxStats.set(entry.worktree.id, { unreviewed, files: entry.files.length });
  }
  const groups: ProjectGroup[] = [];
  const order: string[] = [];
  const byId = new Map<string, WorktreeRow>();
  const sorted = [...projects].sort((a, b) => compareProjects(a.project, b.project));
  for (const item of sorted) {
    const rows: WorktreeRow[] = [];
    const worktrees = [...item.worktrees].sort((a, b) => compareWorktrees(a.worktree, b.worktree));
    for (const wt of worktrees) {
      const stats = inboxStats.get(wt.worktree.id);
      const row: WorktreeRow = {
        project: item.project,
        worktree: wt.worktree,
        summary: wt.summary,
        error: wt.error,
        unreviewed: stats?.unreviewed ?? 0,
        scopeFiles: stats?.files ?? 0,
      };
      byId.set(wt.worktree.id, row);
      if (rowVisible(row, filters)) rows.push(row);
    }
    // Project-name matches keep the project visible even when filters hide every worktree? No:
    // a project is shown only when at least one of its worktrees is visible.
    if (rows.length > 0) {
      groups.push({ project: item.project, rows });
      for (const r of rows) order.push(r.worktree.id);
    }
  }
  return { groups, order, byId };
}

/** Inbox entries sorted like the sidebar (project name, then worktree order). */
export function sortInboxEntries(entries: readonly InboxEntry[]): InboxEntry[] {
  return [...entries].sort(
    (a, b) => compareProjects(a.project, b.project) || compareWorktrees(a.worktree, b.worktree),
  );
}

// --- file list ------------------------------------------------------------------------------

export interface FileGroup {
  project: Project;
  worktree: Worktree;
  /** All files in display order. */
  files: ChangedFile[];
}

export interface NavEntry {
  key: string;
  worktreeId: string;
  projectId: string;
  file: ChangedFile;
}

/** Flattens groups into navigation entries (every file, visible or not). */
export function flattenGroups(groups: readonly FileGroup[]): NavEntry[] {
  const out: NavEntry[] = [];
  for (const g of groups) {
    for (const file of g.files) {
      out.push({
        key: fileRefKey(toFileRef(g.worktree.id, file)),
        worktreeId: g.worktree.id,
        projectId: g.project.id,
        file,
      });
    }
  }
  return out;
}

export type VisiblePredicate = (entry: NavEntry) => boolean;

export function visibleIf(showReviewed: boolean): VisiblePredicate {
  return showReviewed ? () => true : (e) => !e.file.reviewed;
}

/**
 * `j`/`k`: the next/previous visible entry relative to the selection. The selection may itself
 * be hidden (e.g. just marked reviewed while reviewed files are hidden); its position in the
 * full list is still used. With no selection, `j` picks the first visible entry and `k` the last.
 */
export function stepFile(
  entries: readonly NavEntry[],
  selectedKey: string | null,
  delta: 1 | -1,
  visible: VisiblePredicate,
): NavEntry | null {
  const index = selectedKey === null ? -1 : entries.findIndex((e) => e.key === selectedKey);
  if (index === -1) {
    if (delta === 1) return entries.find(visible) ?? null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e && visible(e)) return e;
    }
    return null;
  }
  for (let i = index + delta; i >= 0 && i < entries.length; i += delta) {
    const e = entries[i];
    if (e && visible(e)) return e;
  }
  return null;
}

/**
 * `n`: the next unreviewed entry after the selection, wrapping around, never the selection
 * itself. Returns null when nothing else is unreviewed.
 */
export function nextUnreviewed(
  entries: readonly NavEntry[],
  selectedKey: string | null,
): NavEntry | null {
  const n = entries.length;
  if (n === 0) return null;
  const index = selectedKey === null ? -1 : entries.findIndex((e) => e.key === selectedKey);
  for (let step = 1; step <= n; step++) {
    const e = entries[(index + step + n) % n];
    if (e && !e.file.reviewed && e.key !== selectedKey) return e;
  }
  return null;
}

/**
 * Selection repair after a refresh: keep the selection if it still exists; otherwise pick the
 * visible entry closest to its previous index (so a reverted file hands over to its neighbor).
 */
export function repairSelection(
  entries: readonly NavEntry[],
  selectedKey: string | null,
  previousIndex: number,
  visible: VisiblePredicate,
): NavEntry | null {
  if (selectedKey !== null) {
    const current = entries.find((e) => e.key === selectedKey);
    if (current) return current;
  }
  const visibleEntries = entries.filter(visible);
  if (visibleEntries.length === 0) return null;
  const at = Math.max(0, Math.min(previousIndex, visibleEntries.length - 1));
  return visibleEntries[at] ?? null;
}

/** `J`/`K`: list is [inbox, ...worktrees]; returns the next view id (`null` = inbox). */
export function stepWorktree(
  order: readonly string[],
  current: string | null,
  delta: 1 | -1,
): { changed: boolean; worktreeId: string | null } {
  const items: (string | null)[] = [null, ...order];
  const index = items.indexOf(current);
  const nextIndex = index === -1 ? (delta === 1 ? 1 : 0) : index + delta;
  if (nextIndex < 0 || nextIndex >= items.length) return { changed: false, worktreeId: current };
  const next = items[nextIndex] ?? null;
  return { changed: next !== current, worktreeId: next };
}

// --- formatting -----------------------------------------------------------------------------

export function splitPath(path: string): { dir: string; base: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1
    ? { dir: '', base: path }
    : { dir: path.slice(0, slash + 1), base: path.slice(slash + 1) };
}

export function worktreeLabel(worktree: Worktree): string {
  if (worktree.branch) return worktree.branch;
  if (worktree.headSha) return `detached @ ${worktree.headSha.slice(0, 7)}`;
  return 'detached';
}
