/**
 * Pure view-model functions: sidebar grouping and filters, file ordering, keyboard navigation.
 * Kept free of React so they are easy to test and cheap to memoize.
 */
import type {
  ChangedFile,
  ChangeRequest,
  EffectiveReviewPolicy,
  InboxEntry,
  Project,
  ProjectListItem,
  ScanRoot,
  Worktree,
  WorktreeForge,
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

/**
 * The sidebar filter dropdown's selection. Picked projects and worktrees are one union (a row
 * shows when its project or the row itself is picked; nothing picked = every row); the status
 * options narrow that further.
 */
export interface SidebarFilters {
  projects: readonly string[];
  worktrees: readonly string[];
  onlyDirty: boolean;
  onlyUnreviewed: boolean;
}

export const NO_SIDEBAR_FILTERS: SidebarFilters = {
  projects: [],
  worktrees: [],
  onlyDirty: false,
  onlyUnreviewed: false,
};

export function hasSidebarFilters(filters: SidebarFilters): boolean {
  return (
    filters.projects.length > 0 ||
    filters.worktrees.length > 0 ||
    filters.onlyDirty ||
    filters.onlyUnreviewed
  );
}

export interface WorktreeRow {
  project: Project;
  worktree: Worktree;
  summary: WorktreeSummary | null;
  error: WorktreeListItem['error'];
  /**
   * Unreviewed files of what the worktree has to review (docs/STATUS-FLOW.md §2.1), never the
   * toolbar scope: `summary.review.unreviewedFiles` from daemons that send it, else the
   * unreviewed uncommitted files (the sidebar's own fixed inbox). 0 when out of the review loop.
   */
  unreviewed: number;
  /** Unreviewed commits after the review bookmark (0 from older daemons or review off). */
  newCommits: number;
  /** Files the sidebar's fixed status source lists for the worktree (reviewed or not). */
  scopeFiles: number;
  /** Effective review policy (absent from older daemons = enabled by default). */
  review: EffectiveReviewPolicy;
  /** The review stage (docs/STATUS-FLOW.md §2.2), before any manual hide. */
  stage: Stage;
  /** Where the row sits in the sidebar (see `rowState`). */
  state: RowState;
  /** The user hid ("Hide until it changes") or un-hid this worktree and that still holds. */
  settledBy: 'auto' | 'user';
  /** Pinned on this device: listed at the top under "Pinned", whatever its state. */
  pinned: boolean;
  /** The worktree's matched pull/merge request (forges on), or null. */
  request: ChangeRequest | null;
}

/**
 * The review stage of a worktree (docs/STATUS-FLOW.md §2.2), computed from a fixed source and
 * never from the toolbar scope. `blocked`: a conflict or an operation in progress. `review`:
 * unreviewed files or commits. `reviewed`: nothing new. `inPR` / `merged` / `closed`: from the
 * forge (step 4). `off`: review off, missing, failed or still loading (outside the loop).
 */
export type Stage = 'blocked' | 'review' | 'reviewed' | 'inPR' | 'merged' | 'closed' | 'off';

/**
 * A worktree's place in the sidebar (DECISIONS "UX round 4", status flow v2). `blocked` and
 * `attention` (To review) rows sit under their project; `active` rows too (an open PR, or a row
 * the user brought back by hand). `settled` rows sit in the shelf: reviewed, merged/closed,
 * outside the review loop, or hidden by hand until they change. Rows never reorder on activity.
 */
export type RowState = 'blocked' | 'attention' | 'active' | 'settled';

/**
 * "Hide until it changes" (or "Show" for a row the shelf holds), per device. It holds only while
 * the worktree's `stateHash` is the one it was made on: the next commit or edit drops it.
 */
export interface SettleOverride {
  worktreeId: string;
  state: 'settled' | 'active';
  stateHash: string;
}

export interface StageInput {
  summary: WorktreeSummary | null;
  worktree: Worktree;
  unreviewed: number;
  newCommits?: number;
  review?: Pick<EffectiveReviewPolicy, 'enabled'>;
  error?: WorktreeListItem['error'];
  /** The matched pull/merge request (forge data, docs/STATUS-FLOW.md §2.5). */
  forge?: Pick<WorktreeForge, 'changeRequest' | 'sync'> | null;
}

/**
 * The request is merged or closed **for this HEAD**: its head commit is HEAD (or the forge says
 * the local branch is in sync). A newer local commit means the work moved on.
 */
function finishedRequest(row: StageInput): 'merged' | 'closed' | null {
  const cr = row.forge?.changeRequest;
  if (!cr || cr.state === 'open' || !row.summary) return null;
  const same =
    (cr.headSha !== null && cr.headSha === row.summary.headSha) || row.forge?.sync === 'same';
  return same ? cr.state : null;
}

/** The review stage of a row (docs/STATUS-FLOW.md §2.2, forge stages §2.5). */
export function stageOf(row: StageInput): Stage {
  const s = row.summary;
  if (s && !row.worktree.missing && (s.counts.conflicted > 0 || s.inProgress !== null)) {
    return 'blocked';
  }
  if (row.worktree.missing || row.error || !s) return 'off';
  // Merged / closed with nothing uncommitted: the shelf, whatever it carried (unreviewed commits
  // it brought are counted on the target branch's bookmark). With uncommitted work left it stays
  // out of the shelf (see `placeOf`).
  const finished = finishedRequest(row);
  if (finished && (s.changedFiles === 0 || !(row.review?.enabled ?? true))) return finished;
  if (row.review && !row.review.enabled) return 'off';
  // A commit counts through its files: once every file of the review diff is reviewed (by hand,
  // or because only reviewed commits touched it) there is nothing left, bookmark moved or not.
  if (row.unreviewed > 0) return 'review';
  if (finished) return finished;
  // An open, non-draft request with nothing new: In PR, under its project. A draft is Reviewed.
  const cr = row.forge?.changeRequest;
  if (cr && cr.state === 'open' && !cr.draft) return 'inPR';
  return 'reviewed';
}

/**
 * Where a stage sits when nothing was hidden by hand. A merged/closed worktree with uncommitted
 * work left (`merged · 2 files`) stays under its project.
 */
export function placeOf(stage: Stage, uncommittedLeft = false): RowState {
  switch (stage) {
    case 'blocked':
      return 'blocked';
    case 'review':
      return 'attention';
    case 'inPR':
      return 'active';
    case 'merged':
    case 'closed':
      return uncommittedLeft ? 'active' : 'settled';
    default:
      return 'settled';
  }
}

export function autoRowState(row: StageInput): RowState {
  return placeOf(stageOf(row), (row.summary?.changedFiles ?? 0) > 0);
}

/** True while an override still applies to the worktree's current state. */
export function overrideHolds(
  override: SettleOverride | undefined,
  summary: WorktreeSummary | null,
): override is SettleOverride {
  return override !== undefined && summary !== null && override.stateHash === summary.stateHash;
}

export function rowState(
  row: StageInput,
  override?: SettleOverride,
): { state: RowState; settledBy: 'auto' | 'user' } {
  const auto = autoRowState(row);
  if (!overrideHolds(override, row.summary)) return { state: auto, settledBy: 'auto' };
  if (override.state === 'settled') {
    // Blocked work is never hidden, not even by hand.
    return auto === 'blocked'
      ? { state: auto, settledBy: 'auto' }
      : { state: 'settled', settledBy: 'user' };
  }
  return auto === 'settled'
    ? { state: 'active', settledBy: 'user' }
    : { state: auto, settledBy: 'auto' };
}

/** The one word a quiet row (reviewed, hidden, outside the loop) says instead of its counts. */
export type SettledWord =
  | 'reviewed'
  | 'clean'
  | 'merged'
  | 'closed'
  | 'review off'
  | 'missing'
  | 'error'
  | 'loading';

export function settledWord(
  row: Pick<WorktreeRow, 'summary' | 'worktree' | 'error' | 'review'> & { stage?: Stage },
): SettledWord {
  if (row.worktree.missing) return 'missing';
  if (row.error) return 'error';
  if (!row.summary) return 'loading';
  if (!row.review.enabled) return 'review off';
  if (row.stage === 'merged') return 'merged';
  if (row.stage === 'closed') return 'closed';
  return isDirtySummary(row.summary) ? 'reviewed' : 'clean';
}

export interface ProjectGroup {
  project: Project;
  /** Rows that pass the filters, in worktree order. */
  rows: WorktreeRow[];
  /** Visible rows listed under the project: not pinned, not settled. */
  active: WorktreeRow[];
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
  /** Pinned rows (filters applied), listed first, in project and worktree order. */
  pinned: WorktreeRow[];
  /** The Settled shelf, in project and worktree order. Filters applied. */
  settled: WorktreeRow[];
  /** Visible worktree ids in display order: pinned, then folders, then settled (for J/K). */
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

function matchesPicked(row: WorktreeRow, filters: SidebarFilters): boolean {
  if (filters.projects.length === 0 && filters.worktrees.length === 0) return true;
  return filters.projects.includes(row.project.id) || filters.worktrees.includes(row.worktree.id);
}

export function rowVisible(row: WorktreeRow, filters: SidebarFilters): boolean {
  if (filters.onlyDirty && !isDirtySummary(row.summary)) return false;
  if (filters.onlyUnreviewed && row.unreviewed === 0) return false;
  return matchesPicked(row, filters);
}

export function buildSidebar(
  projects: readonly ProjectListItem[],
  inbox: readonly InboxEntry[] | undefined,
  filters: SidebarFilters,
  scanRoots?: readonly ScanRoot[],
  pinned: readonly string[] = [],
  settle: readonly SettleOverride[] = [],
  forges?: ReadonlyMap<string, Pick<WorktreeForge, 'changeRequest' | 'sync'>>,
): SidebarModel {
  // Status never depends on the toolbar scope: `inbox` is the sidebar's own fixed source.
  const inboxStats = new Map<string, { unreviewed: number; files: number }>();
  for (const entry of inbox ?? []) {
    let unreviewed = 0;
    for (const f of entry.files) if (!f.reviewed) unreviewed++;
    inboxStats.set(entry.worktree.id, { unreviewed, files: entry.files.length });
  }
  const pinnedSet = new Set(pinned);
  const overrides = new Map(settle.map((o) => [o.worktreeId, o]));
  const groups: ProjectGroup[] = [];
  const byId = new Map<string, WorktreeRow>();
  const sorted = [...projects].sort((a, b) => compareProjects(a.project, b.project));
  for (const item of sorted) {
    const rows: WorktreeRow[] = [];
    const allRows: WorktreeRow[] = [];
    const worktrees = [...item.worktrees].sort((a, b) => compareWorktrees(a.worktree, b.worktree));
    for (const wt of worktrees) {
      const stats = inboxStats.get(wt.worktree.id);
      const review = effectivePolicy(wt.review);
      // Status flow v2 daemons send `summary.review`; older ones: the fixed inbox's count.
      const fromDaemon = wt.summary?.review;
      const unreviewed = !review.enabled
        ? 0
        : fromDaemon
          ? fromDaemon.unreviewedFiles
          : (stats?.unreviewed ?? 0);
      const newCommits = review.enabled && fromDaemon ? fromDaemon.newCommits : 0;
      const input: StageInput = {
        summary: wt.summary,
        worktree: wt.worktree,
        unreviewed,
        newCommits,
        review,
        error: wt.error,
        forge: forges?.get(wt.worktree.id) ?? null,
      };
      const stage = stageOf(input);
      const { state, settledBy } = rowState(input, overrides.get(wt.worktree.id));
      const row: WorktreeRow = {
        project: item.project,
        worktree: wt.worktree,
        summary: wt.summary,
        error: wt.error,
        unreviewed,
        newCommits,
        scopeFiles: stats?.files ?? 0,
        review,
        stage,
        state,
        settledBy,
        pinned: pinnedSet.has(wt.worktree.id),
        request: input.forge?.changeRequest ?? null,
      };
      byId.set(wt.worktree.id, row);
      allRows.push(row);
      if (rowVisible(row, filters)) rows.push(row);
    }
    // A project is shown only when at least one of its worktrees is visible.
    if (rows.length > 0) {
      groups.push({
        project: item.project,
        rows,
        active: rows.filter((r) => !r.pinned && r.state !== 'settled'),
        allRows,
      });
    }
  }
  const folders = buildFolders(groups, scanRoots);
  // Folder order (not the global project sort), so the shelf reads like the tree above it.
  const inFolderOrder = folders.flatMap((f) => f.groups.flatMap((g) => g.rows));
  const pinnedRows = inFolderOrder.filter((r) => r.pinned);
  const settled = inFolderOrder.filter((r) => !r.pinned && r.state === 'settled');
  const order = [
    ...pinnedRows,
    ...folders.flatMap((f) => f.groups.flatMap((g) => g.active)),
    ...settled,
  ].map((r) => r.worktree.id);
  return { groups, folders, pinned: pinnedRows, settled, order, byId };
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
