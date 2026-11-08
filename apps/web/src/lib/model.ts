/**
 * Pure view-model functions: sidebar grouping and filters, file ordering, keyboard navigation.
 * Kept free of React so they are easy to test and cheap to memoize.
 */
import type {
  ChangedFile,
  EffectiveReviewPolicy,
  InboxEntry,
  Project,
  ProjectListItem,
  ScanRoot,
  Worktree,
  WorktreeListItem,
  WorktreeSummary,
} from '@octopus-diff/contracts';
import { fileRefKey, toFileRef } from './fileRef.ts';
import { effectivePolicy } from './policy.ts';

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

/**
 * The tree view's display order (`@pierre/trees` default comparator, review F10): at the first
 * differing level, folders before files, dot-items first, then case-insensitive by name.
 */
export function compareTreeOrder(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  const depth = Math.min(as.length, bs.length);
  for (let i = 0; i < depth; i++) {
    const an = as[i] ?? '';
    const bn = bs[i] ?? '';
    if (an === bn) continue;
    const aFolder = i < as.length - 1;
    const bFolder = i < bs.length - 1;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    const aDot = an.startsWith('.');
    const bDot = bn.startsWith('.');
    if (aDot !== bDot) return aDot ? -1 : 1;
    const c = an.toLowerCase().localeCompare(bn.toLowerCase());
    if (c !== 0) return c;
    return cmp(an, bn);
  }
  return as.length - bs.length;
}

export function sortFilesTreeOrder(files: readonly ChangedFile[]): ChangedFile[] {
  return [...files].sort((a, b) => compareTreeOrder(a.path, b.path) || compareFiles(a, b));
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
  /**
   * Unreviewed files in the current scope (from the inbox), 0 if not in the inbox or when the
   * worktree is out of the review loop.
   */
  unreviewed: number;
  /** Changed files in the current scope (from the inbox), 0 if not in the inbox. */
  scopeFiles: number;
  /** Effective review policy (absent from older daemons = enabled by default). */
  review: EffectiveReviewPolicy;
}

export interface ProjectGroup {
  project: Project;
  rows: WorktreeRow[];
  /** All rows of the project, filters ignored (for aggregates and bulk targets). */
  allRows: WorktreeRow[];
}

export interface NodeStats {
  projects: number;
  worktrees: number;
  dirty: number;
  unreviewed: number;
  additions: number;
  deletions: number;
}

/** A scan root (folder) with the projects it discovered; `root === null` = added directly. */
export interface FolderNode {
  id: string;
  root: ScanRoot | null;
  label: string;
  groups: ProjectGroup[];
  stats: NodeStats;
}

export interface SidebarModel {
  groups: ProjectGroup[];
  /** Folder tier: scan roots (sorted by path) then "Added directly", only non-empty ones. */
  folders: FolderNode[];
  /** Visible worktree ids in display order (for J/K). */
  order: string[];
  /** Every worktree row by id, regardless of filters. */
  byId: Map<string, WorktreeRow>;
}

export function emptyStats(): NodeStats {
  return { projects: 0, worktrees: 0, dirty: 0, unreviewed: 0, additions: 0, deletions: 0 };
}

export function statsOfRows(rows: readonly WorktreeRow[]): NodeStats {
  const stats = emptyStats();
  stats.worktrees = rows.length;
  for (const row of rows) {
    if (isDirtySummary(row.summary)) stats.dirty++;
    stats.unreviewed += row.unreviewed;
    stats.additions += row.summary?.additions ?? 0;
    stats.deletions += row.summary?.deletions ?? 0;
  }
  return stats;
}

export function statsOfGroups(groups: readonly ProjectGroup[]): NodeStats {
  const stats = emptyStats();
  stats.projects = groups.length;
  for (const g of groups) {
    const s = statsOfRows(g.allRows);
    stats.worktrees += s.worktrees;
    stats.dirty += s.dirty;
    stats.unreviewed += s.unreviewed;
    stats.additions += s.additions;
    stats.deletions += s.deletions;
  }
  return stats;
}

export const DIRECT_FOLDER_ID = 'direct';

function shortHome(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~');
}

/** Groups project groups under their scan root; projects without one go to "Added directly". */
export function buildFolders(
  groups: readonly ProjectGroup[],
  scanRoots: readonly ScanRoot[] | undefined,
): FolderNode[] {
  const roots = [...(scanRoots ?? [])].sort((a, b) => cmp(a.path, b.path));
  const byRoot = new Map<string, ProjectGroup[]>();
  const direct: ProjectGroup[] = [];
  for (const g of groups) {
    const id = g.project.scanRootId;
    if (id === null) {
      direct.push(g);
      continue;
    }
    const list = byRoot.get(id);
    if (list) list.push(g);
    else byRoot.set(id, [g]);
  }
  const out: FolderNode[] = [];
  for (const root of roots) {
    const list = byRoot.get(root.id);
    if (!list || list.length === 0) continue;
    byRoot.delete(root.id);
    out.push({
      id: root.id,
      root,
      label: shortHome(root.path),
      groups: list,
      stats: statsOfGroups(list),
    });
  }
  // Scan roots the scan-roots query does not know (yet): show them by id.
  for (const [id, list] of byRoot) {
    out.push({
      id,
      root: null,
      label: `folder ${id.slice(0, 6)}`,
      groups: list,
      stats: statsOfGroups(list),
    });
  }
  if (direct.length > 0) {
    out.push({
      id: DIRECT_FOLDER_ID,
      root: null,
      label: 'Added directly',
      groups: direct,
      stats: statsOfGroups(direct),
    });
  }
  return out;
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
  scanRoots?: readonly ScanRoot[],
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
    const allRows: WorktreeRow[] = [];
    const worktrees = [...item.worktrees].sort((a, b) => compareWorktrees(a.worktree, b.worktree));
    for (const wt of worktrees) {
      const stats = inboxStats.get(wt.worktree.id);
      const review = effectivePolicy(wt.review);
      const row: WorktreeRow = {
        project: item.project,
        worktree: wt.worktree,
        summary: wt.summary,
        error: wt.error,
        unreviewed: review.enabled ? (stats?.unreviewed ?? 0) : 0,
        scopeFiles: stats?.files ?? 0,
        review,
      };
      byId.set(wt.worktree.id, row);
      allRows.push(row);
      if (rowVisible(row, filters)) rows.push(row);
    }
    // A project is shown only when at least one of its worktrees is visible.
    if (rows.length > 0) {
      groups.push({ project: item.project, rows, allRows });
      for (const r of rows) order.push(r.worktree.id);
    }
  }
  return { groups, folders: buildFolders(groups, scanRoots), order, byId };
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
  eligible: (entry: NavEntry) => boolean = () => true,
): NavEntry | null {
  const n = entries.length;
  if (n === 0) return null;
  const index = selectedKey === null ? -1 : entries.findIndex((e) => e.key === selectedKey);
  for (let step = 1; step <= n; step++) {
    const e = entries[(index + step + n) % n];
    if (e && !e.file.reviewed && e.key !== selectedKey && eligible(e)) return e;
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
