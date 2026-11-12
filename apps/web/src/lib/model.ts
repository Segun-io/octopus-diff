/**
 * Pure view-model functions: sidebar grouping and filters, file ordering, keyboard navigation.
 * Kept free of React so they are easy to test and cheap to memoize.
 */
import type {
  ChangedFile,
  ChangeRequest,
  EffectiveReviewPolicy,
  FileOrigin,
  FileOriginVia,
  InboxEntry,
  Project,
  ProjectListItem,
  ScanRoot,
  ScopeKind,
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

/** `summary.activityAt` in ms, or null (no summary yet, an older daemon, or unknown). */
export function activityMs(summary: Pick<WorktreeSummary, 'activityAt'> | null): number | null {
  const at = summary?.activityAt;
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The sidebar's worktree order: most recent activity first (`summary.activityAt`: commits,
 * checkouts, edits), worktrees without one after, ties and the rest by `compareWorktrees`.
 */
export function compareByActivity(
  a: { worktree: Worktree; summary: Pick<WorktreeSummary, 'activityAt'> | null },
  b: { worktree: Worktree; summary: Pick<WorktreeSummary, 'activityAt'> | null },
): number {
  const am = activityMs(a.summary);
  const bm = activityMs(b.summary);
  if (am !== bm) {
    if (am === null) return 1;
    if (bm === null) return -1;
    return bm - am;
  }
  return compareWorktrees(a.worktree, b.worktree);
}

/**
 * The flat sidebar's order (#13): pinned first, then most recent activity first across every
 * project, ties by project name and then `compareWorktrees`.
 */
export function compareRows(
  a: Pick<WorktreeRow, 'pinned' | 'worktree' | 'summary' | 'project'>,
  b: Pick<WorktreeRow, 'pinned' | 'worktree' | 'summary' | 'project'>,
): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const am = activityMs(a.summary);
  const bm = activityMs(b.summary);
  if (am !== bm) {
    if (am === null) return 1;
    if (bm === null) return -1;
    return bm - am;
  }
  return compareProjects(a.project, b.project) || compareWorktrees(a.worktree, b.worktree);
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
 * The sidebar filter dropdown's selection. Picked folders, projects and worktrees are one union (a
 * row shows when its folder, its project or the row itself is picked; nothing picked = every
 * row); the status options narrow that further.
 */
export interface SidebarFilters {
  /** Picked folders (scan root ids, `DIRECT_FOLDER_ID` for "Added directly"). Absent = none. */
  folders?: readonly string[];
  projects: readonly string[];
  worktrees: readonly string[];
  onlyDirty: boolean;
  onlyUnreviewed: boolean;
}

export const NO_SIDEBAR_FILTERS: SidebarFilters = {
  folders: [],
  projects: [],
  worktrees: [],
  onlyDirty: false,
  onlyUnreviewed: false,
};

export function hasSidebarFilters(filters: SidebarFilters): boolean {
  return (
    (filters.folders?.length ?? 0) > 0 ||
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
   * toolbar scope: `summary.review.unreviewedOwnFiles`, else `unreviewedFiles` (an older daemon:
   * every file is its own). 0 when out of the review loop, and while the
   * daemon has not computed the review state yet (stage `changed`, #10).
   */
  unreviewed: number;
  /** Unreviewed commits after the review bookmark (0 without a review state or review off). */
  newCommits: number;
  /** Changed files of the worktree (uncommitted, from the summary). */
  scopeFiles: number;
  /** Effective review policy (absent from older daemons = enabled by default). */
  review: EffectiveReviewPolicy;
  /** The review stage (docs/STATUS-FLOW.md §2.2), before any manual hide. */
  stage: Stage;
  /** Where the row sits in the sidebar (see `rowState`). */
  state: RowState;
  /** The user hid ("Hide until it changes") or un-hid this worktree and that still holds. */
  settledBy: 'auto' | 'user';
  /**
   * Hidden by hand (and the hide still holds, see `SettleOverride`): the row sits in the closed
   * "Hidden" section at the end of the sidebar instead of the flat list. Nothing else hides a row.
   */
  hidden: boolean;
  /** Pinned on this device: listed first in the flat list, whatever its state. */
  pinned: boolean;
  /** The worktree's matched pull/merge request (forges on), or null. */
  request: ChangeRequest | null;
}

/**
 * The review stage of a worktree (docs/STATUS-FLOW.md §2.2), computed from a fixed source and
 * never from the toolbar scope. `blocked`: a conflict or an operation in progress. `review`:
 * unreviewed files or commits. `changed`: uncommitted changes whose review state the daemon has
 * not computed yet (#10: computed when the project is opened, not inherited at startup).
 * `reviewed`: nothing new. `inPR` / `merged` / `closed`: from the forge (step 4). `off`: review
 * off, missing, failed or still loading (outside the loop).
 */
export type Stage =
  | 'blocked'
  | 'review'
  | 'changed'
  | 'reviewed'
  | 'inPR'
  | 'merged'
  | 'closed'
  | 'off';

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
  /** Unreviewed files; ignored while the summary carries no `review` (stage `changed`). */
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
  // No review state yet (#10): uncommitted changes are shown as changes, not as "to review"
  // inherited from whatever the repository held at startup. Opening the project computes it.
  if (!s.review && s.changedFiles > 0) return 'changed';
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
    case 'changed':
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

/**
 * The override the row's Hide / Show action sets: `'settled'` hides a visible row, `null` removes
 * the override of a hidden one. `undefined` when the row cannot be hidden (blocked, or no summary
 * yet, so there is no state hash to pin the hide to).
 */
export function hideToggle(
  row: Pick<WorktreeRow, 'stage' | 'summary' | 'hidden'>,
): 'settled' | null | undefined {
  if (!row.summary || row.stage === 'blocked') return undefined;
  return row.hidden ? null : 'settled';
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

/** Counts in a sidebar row stop at 99 (`99+`): the exact number is in the tooltip and the hover card. */
export const COUNT_CLAMP = 99;

export function countLabel(n: number): string {
  return n > COUNT_CLAMP ? `${COUNT_CLAMP}+` : String(n);
}

/**
 * What a sidebar row's state indicator shows (#14), one kind per look, so a test can walk every
 * status and the row never has to guess. Shapes differ per kind (colour is never the only signal)
 * and `label` is the sentence screen readers and the tooltip get.
 *
 * - `missing`, `error`, `loading`: the worktree could not be read (yet).
 * - `conflicts`, `operation`: blocked work (`operation` = a rebase, merge, ... without conflicts).
 * - `merged`, `closed`: the request is finished for this HEAD.
 * - `reviewOff`: outside the review loop by policy.
 * - `review`: unreviewed own files (never merge noise); `changed`: changes whose review state is
 *   not computed yet; `request`: an open request with nothing new to review.
 * - `reviewed`: changes, all reviewed; `clean`: nothing changed. Neither has a word on the row:
 *   the indicator is a tick or a faint dot (informative without saying "clean").
 */
export type RowIndicatorKind =
  | 'missing'
  | 'error'
  | 'loading'
  | 'conflicts'
  | 'operation'
  | 'merged'
  | 'closed'
  | 'reviewOff'
  | 'review'
  | 'changed'
  | 'request'
  | 'reviewed'
  | 'clean';

export interface RowIndicator {
  kind: RowIndicatorKind;
  label: string;
}

function countOf(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function rowIndicator(
  row: Pick<
    WorktreeRow,
    'summary' | 'worktree' | 'error' | 'review' | 'stage' | 'unreviewed' | 'newCommits' | 'request'
  >,
): RowIndicator {
  const { summary, stage } = row;
  if (row.worktree.missing) return { kind: 'missing', label: 'missing: the folder is gone' };
  if (row.error) return { kind: 'error', label: `error: ${row.error.message}` };
  if (!summary) return { kind: 'loading', label: 'loading' };
  const conflicts = summary.counts.conflicted;
  if (conflicts > 0) return { kind: 'conflicts', label: countOf(conflicts, 'conflict') };
  if (summary.inProgress) return { kind: 'operation', label: `${summary.inProgress} in progress` };
  if (stage === 'merged') return { kind: 'merged', label: 'request merged' };
  if (stage === 'closed') return { kind: 'closed', label: 'request closed' };
  if (!row.review.enabled) return { kind: 'reviewOff', label: 'review off' };
  if (row.unreviewed > 0) {
    return { kind: 'review', label: `${countOf(row.unreviewed, 'unreviewed file')} to review` };
  }
  if (stage === 'changed') return { kind: 'changed', label: 'changes, open to review' };
  if (stage === 'inPR') {
    return {
      kind: 'request',
      label:
        row.request?.review === 'changes_requested'
          ? 'open request, changes requested'
          : 'open request, nothing new to review',
    };
  }
  return isDirtySummary(summary)
    ? { kind: 'reviewed', label: 'reviewed' }
    : { kind: 'clean', label: 'no changes' };
}

export interface ProjectGroup {
  project: Project;
  /** Rows that pass the filters, in worktree order. */
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
  /**
   * The flat list (#13): every worktree that passes the filters and was not hidden by hand,
   * across all projects and folders, pinned rows first, then most recent activity first.
   */
  flat: WorktreeRow[];
  /** The rows hidden by hand ("Hide until it changes"), same order: the closed section at the end. */
  hidden: WorktreeRow[];
  /** Per project, for the Overviews (filters applied). Not a sidebar structure any more. */
  groups: ProjectGroup[];
  /** Per folder, for the Overviews and the palette: scan roots (by path) then "Added directly". */
  folders: FolderNode[];
  /** Visible worktree ids in display order: the flat list, then the hidden ones (for J/K). */
  order: string[];
  /** Every worktree row by id, regardless of filters. */
  byId: Map<string, WorktreeRow>;
  /** Every folder that holds a project, regardless of filters, for the filter picker. */
  folderOptions: FolderOption[];
}

/** A folder the filter picker offers. */
export interface FolderOption {
  id: string;
  label: string;
  /** Worktrees in it, filters ignored. */
  worktrees: number;
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

/** The id of the folder a project belongs to: its scan root, else `DIRECT_FOLDER_ID`. */
export function folderIdOf(project: Pick<Project, 'scanRootId'>): string {
  return project.scanRootId ?? DIRECT_FOLDER_ID;
}

function matchesPicked(row: WorktreeRow, filters: SidebarFilters): boolean {
  const folders = filters.folders ?? [];
  if (folders.length === 0 && filters.projects.length === 0 && filters.worktrees.length === 0) {
    return true;
  }
  return (
    folders.includes(folderIdOf(row.project)) ||
    filters.projects.includes(row.project.id) ||
    filters.worktrees.includes(row.worktree.id)
  );
}

/**
 * A row with changes whose review state the daemon has not computed yet (#10): it may well have
 * something to review, so it stays listed, and the UI says it is being worked out (#11).
 */
export function reviewPending(row: Pick<WorktreeRow, 'review' | 'summary'>): boolean {
  return row.review.enabled && !!row.summary && !row.summary.review && row.summary.changedFiles > 0;
}

export function rowVisible(row: WorktreeRow, filters: SidebarFilters): boolean {
  if (filters.onlyDirty && !isDirtySummary(row.summary)) return false;
  if (filters.onlyUnreviewed && row.unreviewed === 0 && !reviewPending(row)) return false;
  return matchesPicked(row, filters);
}

export function buildSidebar(
  projects: readonly ProjectListItem[],
  filters: SidebarFilters,
  scanRoots?: readonly ScanRoot[],
  pinned: readonly string[] = [],
  settle: readonly SettleOverride[] = [],
  forges?: ReadonlyMap<string, Pick<WorktreeForge, 'changeRequest' | 'sync'>>,
): SidebarModel {
  // Status never depends on the toolbar scope, nor on any inbox: only on the projects list
  // (summaries with their `review`), so the sidebar paints before the inbox (#10).
  const pinnedSet = new Set(pinned);
  const overrides = new Map(settle.map((o) => [o.worktreeId, o]));
  const groups: ProjectGroup[] = [];
  const byId = new Map<string, WorktreeRow>();
  const sorted = [...projects].sort((a, b) => compareProjects(a.project, b.project));
  for (const item of sorted) {
    const rows: WorktreeRow[] = [];
    const allRows: WorktreeRow[] = [];
    const worktrees = [...item.worktrees].sort(compareByActivity);
    for (const wt of worktrees) {
      const review = effectivePolicy(wt.review);
      // `summary.review` is computed on demand (#10); without it the row shows its changes.
      const fromDaemon = wt.summary?.review;
      // Files that came from a merge, rebase or update of the default branch are wrapped, not
      // counted (docs/STATUS-FLOW.md §2.4a): `unreviewedOwnFiles` when the daemon sends it.
      const unreviewed =
        review.enabled && fromDaemon
          ? (fromDaemon.unreviewedOwnFiles ?? fromDaemon.unreviewedFiles)
          : 0;
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
        scopeFiles: wt.summary?.changedFiles ?? 0,
        review,
        stage,
        state,
        settledBy,
        hidden: state === 'settled' && settledBy === 'user',
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
        allRows,
      });
    }
  }
  const folders = buildFolders(groups, scanRoots);
  // The flat list: every visible row across projects, newest activity first (pinned rows on top).
  // Only a row hidden by hand leaves it; a pinned row stays up top even then.
  const visibleRows = groups.flatMap((g) => g.rows).sort(compareRows);
  const flat = visibleRows.filter((r) => r.pinned || !r.hidden);
  const hidden = visibleRows.filter((r) => !r.pinned && r.hidden);
  const order = [...flat, ...hidden].map((r) => r.worktree.id);
  return {
    flat,
    hidden,
    groups,
    folders,
    order,
    byId,
    folderOptions: folderOptionsOf(byId, scanRoots),
  };
}

function folderOptionsOf(
  byId: ReadonlyMap<string, WorktreeRow>,
  scanRoots: readonly ScanRoot[] | undefined,
): FolderOption[] {
  const counts = new Map<string, number>();
  for (const row of byId.values()) {
    const id = folderIdOf(row.project);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const options: FolderOption[] = [];
  for (const root of [...(scanRoots ?? [])].sort((a, b) => cmp(a.path, b.path))) {
    const worktrees = counts.get(root.id);
    if (worktrees === undefined) continue;
    counts.delete(root.id);
    options.push({ id: root.id, label: shortHome(root.path), worktrees });
  }
  for (const [id, worktrees] of counts) {
    if (id === DIRECT_FOLDER_ID) continue;
    options.push({ id, label: `folder ${id.slice(0, 6)}`, worktrees });
  }
  const direct = counts.get(DIRECT_FOLDER_ID);
  if (direct !== undefined) {
    options.push({ id: DIRECT_FOLDER_ID, label: 'Added directly', worktrees: direct });
  }
  return options;
}

/** Inbox entries sorted like the sidebar (project name, then most recent activity first). */
export function sortInboxEntries(entries: readonly InboxEntry[]): InboxEntry[] {
  return [...entries].sort(
    (a, b) => compareProjects(a.project, b.project) || compareByActivity(a, b),
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

/**
 * Whether the eye ("Show reviewed") applies to a scope. All on branch lists everything on the
 * branch and To review only what is left, so neither has the eye: their names say what they show.
 */
export function eyeApplies(kind: ScopeKind): boolean {
  return kind !== 'branch' && kind !== 'review';
}

/** Whether the list shows reviewed files: All on branch always, To review never, else the eye. */
export function listsReviewed(showReviewed: boolean, kind: ScopeKind): boolean {
  if (kind === 'branch') return true;
  if (kind === 'review') return false;
  return showReviewed;
}

/**
 * Files that came from a merge, rebase or update of the default branch are **wrapped, not
 * hidden** (DECISIONS #205): own and mixed files first, the `base` ones in a collapsed group at
 * the end of each worktree's list. This is how the list reads `origin` (absent = own, so an older
 * daemon has no group and no chip).
 */
export function fileOrigin(file: Pick<ChangedFile, 'origin'>): FileOrigin {
  return file.origin ?? 'own';
}

/** The file's change came from the default branch alone (a "from main" file, wrapped by default). */
export function isBaseFile(file: Pick<ChangedFile, 'origin'>): boolean {
  return file.origin === 'base';
}

/** The default branch changed this file too, but so did the branch: shown with a `+main` tag. */
export function isMixedFile(file: Pick<ChangedFile, 'origin'>): boolean {
  return file.origin === 'mixed';
}

/** Own and mixed files, in order, then the base files, in order (a stable partition). */
export function ownFirst<T extends Pick<ChangedFile, 'origin'>>(files: readonly T[]): T[] {
  const own: T[] = [];
  const base: T[] = [];
  for (const f of files) (isBaseFile(f) ? base : own).push(f);
  return base.length === 0 ? own : [...own, ...base];
}

/** How the list treats the base files: only them (the chip), or wrapped unless the group is open. */
export interface OriginView {
  /** The "From main" chip is on: only the base files are listed. */
  fromMainOnly: boolean;
  /** Worktree ids whose "from main" group is expanded. */
  expanded: ReadonlySet<string>;
}

export const NO_ORIGIN_VIEW: OriginView = { fromMainOnly: false, expanded: new Set() };

/**
 * Which entries the origin view lists: with the chip only base files, else every file but the
 * base ones of a worktree whose group is collapsed. `j`/`k`/`n` skip what it hides.
 */
export function originVisibleIf(view: OriginView): VisiblePredicate {
  if (view.fromMainOnly) return (e) => isBaseFile(e.file);
  return (e) => !isBaseFile(e.file) || view.expanded.has(e.worktreeId);
}

export function visibleIf(showReviewed: boolean, origin?: OriginView): VisiblePredicate {
  const reviewed: VisiblePredicate = showReviewed ? () => true : (e) => !e.file.reviewed;
  if (!origin) return reviewed;
  const byOrigin = originVisibleIf(origin);
  return (e) => reviewed(e) && byOrigin(e);
}

/** Own + mixed files: what the counts, the scope counts and "Review N shown" are made of. */
export function countOwn(files: readonly Pick<ChangedFile, 'origin'>[]): number {
  let n = 0;
  for (const f of files) if (!isBaseFile(f)) n++;
  return n;
}

/** `origin/main` -> `main` (a remote prefix says nothing the chip needs); other refs unchanged. */
export function shortRef(ref: string): string {
  return ref.replace(/^origin\//, '');
}

const VIA_LABELS: Record<FileOriginVia, string> = {
  merge: 'merge',
  rebase: 'rebase',
  'cherry-pick': 'cherry-pick',
  update: 'update',
  'same-as-base': 'same as main',
  'in-progress': 'in progress',
};

/** How the default branch's part arrived, in words (`merge`, `same as main`, `in progress`...). */
export function viaLabel(via: FileOriginVia | undefined): string | null {
  return via ? VIA_LABELS[via] : null;
}

/** The tag a row carries: `+main` for a mixed file, the via for a base one, else none. */
export function originTag(file: Pick<ChangedFile, 'origin' | 'originVia'>): string | null {
  if (isMixedFile(file)) return '+main';
  if (isBaseFile(file)) return viaLabel(file.originVia) ?? 'main';
  return null;
}

/**
 * The collapsed group's label: `From origin/main - merge (5 files)`. When the group's files
 * arrived in different ways it says `From origin/main (5 files)` and each row carries its own via.
 */
export function noiseGroupLabel(
  ref: string,
  vias: ReadonlySet<FileOriginVia | undefined>,
  count: number,
): string {
  const [only] = vias.size === 1 ? [...vias] : [];
  const via = only ? viaLabel(only) : null;
  const files = `${count} ${count === 1 ? 'file' : 'files'}`;
  return via ? `From ${ref} - ${via} (${files})` : `From ${ref} (${files})`;
}

export interface OriginStats {
  /** Own + mixed files passing `reviewedOk`. */
  own: number;
  /** Base files passing `reviewedOk`, expanded or not. */
  base: number;
  /** Mixed files passing `reviewedOk`. */
  mixed: number;
  /** How the base files arrived. */
  vias: Set<FileOriginVia | undefined>;
}

/** Per worktree: how many files are own, mixed and base (`reviewedOk` = what the eye shows). */
export function originStats(
  entries: readonly NavEntry[],
  reviewedOk: VisiblePredicate,
): Map<string, OriginStats> {
  const out = new Map<string, OriginStats>();
  for (const e of entries) {
    if (!reviewedOk(e)) continue;
    let s = out.get(e.worktreeId);
    if (!s) {
      s = { own: 0, base: 0, mixed: 0, vias: new Set() };
      out.set(e.worktreeId, s);
    }
    if (isBaseFile(e.file)) {
      s.base++;
      s.vias.add(e.file.originVia);
    } else {
      s.own++;
      if (isMixedFile(e.file)) s.mixed++;
    }
  }
  return out;
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

/**
 * `J`/`K`: the next worktree of `order` (the list, then the hidden ones). From a view that is no
 * worktree (an Overview) either key goes to the first one; at either end nothing changes.
 */
export function stepWorktree(
  order: readonly string[],
  current: string | null,
  delta: 1 | -1,
): { changed: boolean; worktreeId: string | null } {
  const index = current === null ? -1 : order.indexOf(current);
  const nextIndex = index === -1 ? 0 : index + delta;
  const next = order[nextIndex];
  if (next === undefined) return { changed: false, worktreeId: current };
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

/** The worktree has the project's default branch checked out (the baseline of the others). */
export function isDefaultBranch(worktree: Worktree, project: Project): boolean {
  return worktree.branch !== null && worktree.branch === project.defaultBranch;
}

/**
 * Overview order: the default-branch worktree first (the reference every other row compares
 * with, so pagination never hides it), then the given (recency) order.
 */
export function defaultBranchFirst(rows: readonly WorktreeRow[]): WorktreeRow[] {
  const index = rows.findIndex((r) => isDefaultBranch(r.worktree, r.project));
  if (index <= 0) return [...rows];
  return [rows[index] as WorktreeRow, ...rows.slice(0, index), ...rows.slice(index + 1)];
}

/** Local branches that no worktree of the project has checked out, in the given order. */
export function branchesWithoutWorktree<B extends { name: string }>(
  branches: readonly B[],
  rows: readonly WorktreeRow[],
): B[] {
  const checkedOut = new Set(rows.map((r) => r.worktree.branch).filter((b) => b !== null));
  return branches.filter((b) => !checkedOut.has(b.name));
}
