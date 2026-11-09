import {
  type BulkReviewTarget,
  type ReviewPolicyTarget,
  reviewTargetKey,
  TEST_IDS,
} from '@octopus-diff/contracts';
import { memo, type ReactNode, useEffect, useRef, useState } from 'react';
import {
  useRemoveProject,
  useRemoveScanRoot,
  useRescanScanRoot,
  useSetReviewPolicy,
  useSettingsQuery,
  useSettingsSupport,
} from '../api/settings.ts';
import {
  DIRECT_FOLDER_ID,
  type FolderNode,
  isDirtySummary,
  type ProjectGroup,
  settledWord,
  settleToggle,
  type WorktreeRow,
  worktreeLabel,
} from '../lib/model.ts';
import { worktreeSource } from '../lib/source.ts';
import { useCommandsContext } from '../state/commandsContext.tsx';
import { type CopyFn, copyAndReport } from '../state/copy.ts';
import { useAppModel } from '../state/model.tsx';
import { actions, useUi, useUiStore, type View } from '../state/ui.tsx';
import { ChangeRequestHoverBlock } from './ChangeRequest.tsx';
import { ContextMenu, type MenuItem, useContextMenu } from './ContextMenu.tsx';
import { separated, worktreeCopyItems } from './copyMenu.ts';
import { useFolderStart } from './FolderBrowser.tsx';
import { Wordmark } from './Mark.tsx';
import { SidebarFilter } from './SidebarFilter.tsx';
import { DefaultBranchChip, RowChips } from './WorktreeChips.tsx';

/**
 * The sidebar (DECISIONS "UX round 4", status flow v2 in docs/STATUS-FLOW.md): the Inbox;
 * **Pinned** worktrees; then every folder (scan root) with its projects, and under each project
 * the worktrees with something to do: blocked, To review (new commits or unreviewed files), in a
 * PR, or brought back by hand. The rest (reviewed, merged/closed, review off, missing, failed, or
 * hidden until they change) sit in the shelf at the bottom, closed by default. Status comes from
 * a fixed source, never from the toolbar scope, so switching the scope never moves a row. A
 * commit moves work into the bookmark range; it never settles it. Rows never reorder on activity.
 */

function attr(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

type MenuTarget =
  | { kind: 'folder'; node: FolderNode }
  | { kind: 'project'; group: ProjectGroup }
  | { kind: 'worktree'; row: WorktreeRow };

type RowEvent = React.MouseEvent | React.KeyboardEvent;

/** Where a worktree row is listed; `folder` rows sit under their project and omit its name. */
type RowVariant = 'pinned' | 'folder' | 'settled';

interface RowProps {
  row: WorktreeRow;
  variant: RowVariant;
  selected: boolean;
  onSelect: (id: string) => void;
  onMenu: (event: RowEvent, row: WorktreeRow) => void;
  onSettle: (row: WorktreeRow) => void;
}

/** The data attributes the e2e suite reads (TEST_IDS.worktreeItem); the same in every variant. */
function rowAttributes(row: WorktreeRow, selected: boolean) {
  const { worktree, summary } = row;
  const counts = summary?.counts;
  const source = worktree.isMain ? null : worktreeSource(worktree.path);
  return {
    'data-testid': TEST_IDS.worktreeItem,
    'data-worktree-id': worktree.id,
    'data-project-id': worktree.projectId,
    'data-branch': worktree.branch ?? '',
    'data-dirty': String(isDirtySummary(summary)),
    'data-ahead': attr(summary?.ahead),
    'data-behind': attr(summary?.behind),
    'data-staged': attr(counts?.staged ?? 0),
    'data-unstaged': attr(counts?.unstaged ?? 0),
    'data-untracked': attr(counts?.untracked ?? 0),
    'data-conflicted': attr(counts?.conflicted ?? 0),
    'data-additions': attr(summary?.additions ?? 0),
    'data-deletions': attr(summary?.deletions ?? 0),
    'data-main': String(worktree.isMain),
    'data-source': source?.id ?? '',
    'data-state': row.state,
    'data-stage': row.stage,
    'data-unreviewed': String(row.unreviewed),
    'data-commits': String(row.newCommits),
    'data-pinned': String(row.pinned),
    'aria-current': selected ? ('true' as const) : undefined,
  };
}

function ReviewOffBadge({ row }: { row: WorktreeRow }) {
  return (
    <span
      data-testid={TEST_IDS.reviewOffBadge}
      data-source={row.review.source}
      className="od-chip shrink-0"
      title={`Review off (from ${row.review.source})`}
    >
      review off
    </span>
  );
}

/**
 * The status slot at the top right of a card: `N commits ·` and the unreviewed-files pill (the one
 * filled shape) for To review, `N conflicts` for blocked work, or one word for a quiet row. Hover
 * slides it left to make room for the action (the counts stay visible).
 */
function RowStatus({ row, makeRoom }: { row: WorktreeRow; makeRoom: boolean }) {
  const counts = row.summary?.counts;
  const word = settledWord(row);
  const quiet = row.state === 'settled' || row.state === 'active';
  return (
    <span
      className={`ml-auto flex shrink-0 items-center gap-1.5 text-[11px] ${
        makeRoom ? 'group-focus-within/wt:mr-14 group-hover/wt:mr-14' : ''
      }`}
    >
      {!row.review.enabled && <ReviewOffBadge row={row} />}
      {counts && counts.conflicted > 0 && (
        <span className="text-danger">{plural(counts.conflicted, 'conflict')}</span>
      )}
      {row.stage === 'review' && row.newCommits > 0 && (
        <span className="text-muted" title="Commits after the review bookmark">
          {plural(row.newCommits, 'commit')}
          {row.unreviewed > 0 ? ' ·' : ''}
        </span>
      )}
      {row.unreviewed > 0 && (
        <span className="od-pill" title={`${row.unreviewed} unreviewed`}>
          {row.unreviewed}
        </span>
      )}
      {row.stage === 'inPR' && row.request ? (
        <span
          className={row.request.review === 'changes_requested' ? 'text-warn' : 'text-faint'}
          title="Open request, nothing new to review"
        >
          {inPrText(row.request)}
        </span>
      ) : (
        quiet &&
        word !== 'review off' && (
          <span className={word === 'missing' || word === 'error' ? 'text-danger' : 'text-faint'}>
            {word === 'loading' ? '…' : word}
            {(word === 'merged' || word === 'closed') && (row.summary?.changedFiles ?? 0) > 0
              ? ` · ${plural(row.summary?.changedFiles ?? 0, 'file')}`
              : ''}
          </span>
        )
      )}
    </span>
  );
}

/** `#42 · checks ✓` / `changes requested` (one chip's worth of words for an In PR row). */
function inPrText(cr: NonNullable<WorktreeRow['request']>): string {
  const ref = `${cr.kind === 'github' ? '#' : '!'}${cr.number}`;
  if (cr.review === 'changes_requested') return `${ref} · changes requested`;
  const checks = cr.checks?.state;
  if (checks === 'success') return `${ref} · checks ✓`;
  if (checks === 'failure') return `${ref} · checks ✗`;
  if (checks === 'pending') return `${ref} · checks …`;
  return ref;
}

/** The facts of the meta line (and the hover card): files, lines, ahead/behind. */
function rowFacts(row: WorktreeRow): { files?: string; lines?: [number, number]; sync?: string } {
  const s = row.summary;
  if (!s) return {};
  return {
    ...(isDirtySummary(s) ? { files: plural(s.changedFiles, 'file') } : {}),
    ...(s.additions > 0 || s.deletions > 0
      ? { lines: [s.additions, s.deletions] as [number, number] }
      : {}),
    ...(s.ahead !== null && s.behind !== null && s.ahead + s.behind > 0
      ? { sync: `↑${s.ahead} ↓${s.behind}` }
      : {}),
  };
}

/** The meta line under the branch: chips, then the facts in mono. Omitted when it would be empty. */
function RowMeta({ row }: { row: WorktreeRow }) {
  const { worktree, summary, project } = row;
  const facts = rowFacts(row);
  const hasChip =
    (worktree.isMain && worktree.branch !== project.defaultBranch) ||
    (!worktree.isMain && worktreeSource(worktree.path) !== null) ||
    summary?.inProgress;
  if (!hasChip && !facts.files && !facts.lines && !facts.sync) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden font-mono text-[11px] whitespace-nowrap text-muted">
      <RowChips row={row} />
      {facts.files && <span>{facts.files}</span>}
      {facts.lines && (
        <span>
          <span className="text-add">+{facts.lines[0]}</span>{' '}
          <span className="text-del">−{facts.lines[1]}</span>
        </span>
      )}
      {facts.sync && (
        <span title={summary?.aheadBehindRef ? `vs ${summary.aheadBehindRef}` : undefined}>
          {facts.sync}
        </span>
      )}
    </span>
  );
}

/** Shows a card after a short hover, anchored to the right of the row (T3 Code's row tooltip). */
function useHoverCard(delayMs = 450) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const hide = () => {
    clear();
    setAt(null);
  };
  // Unmount while a timer is pending (a row that settles mid-hover): drop it.
  useEffect(() => {
    const pending = timer;
    return () => {
      if (pending.current) clearTimeout(pending.current);
    };
  }, []);
  const onPointerEnter = (e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType !== 'mouse') return;
    const rect = e.currentTarget.getBoundingClientRect();
    clear();
    timer.current = setTimeout(() => {
      setAt({ x: rect.right + 8, y: Math.max(8, Math.min(rect.top, window.innerHeight - 380)) });
    }, delayMs);
  };
  return { at, onPointerEnter, onPointerLeave: hide, onPointerDown: hide };
}

/**
 * The details a row does not show: branch, project, path, source, facts, review policy and the
 * manual settle. Fixed-positioned so the sidebar's scroll clip cannot cut it off.
 */
function RowHoverCard({ row, at }: { row: WorktreeRow; at: { x: number; y: number } }) {
  const { worktree, summary, error, project, review } = row;
  const source = worktree.isMain ? null : worktreeSource(worktree.path);
  const facts = rowFacts(row);
  const word = settledWord(row);
  const line = (label: string, value: ReactNode) => (
    <div className="flex gap-2">
      <dt className="w-14 shrink-0 text-faint">{label}</dt>
      <dd className="min-w-0 flex-1 break-all">{value}</dd>
    </div>
  );
  return (
    <div
      role="tooltip"
      className="od-overlay od-fade-in pointer-events-none fixed z-50 w-[320px] rounded-md p-2.5 text-xs text-fg"
      style={{ left: at.x, top: at.y }}
    >
      <div className="mb-1.5 flex items-baseline gap-1.5">
        <span className="min-w-0 truncate font-medium">{worktreeLabel(worktree)}</span>
        <span className="ml-auto shrink-0 text-[11px] text-muted">
          {row.state === 'blocked'
            ? 'blocked'
            : row.state === 'attention'
              ? toReviewText(row)
              : word}
        </span>
      </div>
      <dl className="flex flex-col gap-0.5">
        {line('Project', project.name)}
        {line('Path', <span className="font-mono text-[11px]">{worktree.path}</span>)}
        {source && line('Source', source.title)}
        {worktree.isMain && line('Checkout', 'main checkout')}
        {summary?.inProgress && line('Operation', `${summary.inProgress} in progress`)}
        {summary &&
          (facts.files || facts.lines) &&
          line(
            'Changes',
            <span className="font-mono text-[11px]">
              {facts.files ?? 'no files'}
              {facts.lines && (
                <>
                  {' '}
                  <span className="text-add">+{facts.lines[0]}</span>{' '}
                  <span className="text-del">−{facts.lines[1]}</span>
                </>
              )}
            </span>,
          )}
        {summary &&
          summary.ahead !== null &&
          summary.behind !== null &&
          line(
            'Sync',
            <span className="font-mono text-[11px]">
              ↑{summary.ahead} ↓{summary.behind}
              {summary.aheadBehindRef ? ` vs ${summary.aheadBehindRef}` : ''}
            </span>,
          )}
        {line('Review', review.enabled ? 'on' : `off (from ${review.source})`)}
        {summary?.review &&
          line(
            'Reviewed',
            <span className="font-mono text-[11px]">
              {summary.review.bookmark
                ? `up to ${summary.review.bookmark.slice(0, 7)}`
                : 'no commits yet'}
              {summary.review.historyRewritten ? ' · history rewritten' : ''}
            </span>,
          )}
        {row.settledBy === 'user' &&
          line('Hidden', row.state === 'settled' ? 'until it changes' : 'no, shown by hand')}
        {error && line('Error', <span className="text-danger">{error.message}</span>)}
      </dl>
      <ChangeRequestHoverBlock worktreeId={worktree.id} />
    </div>
  );
}

// Rows under a project line up with the project's name; rows outside a project need no indent.
const ROW_INDENT: Record<RowVariant, string> = {
  pinned: 'pl-2',
  folder: 'pl-9',
  settled: 'pl-2',
};

/** `2 commits · 3 files` (the To review text of the hover card). */
function toReviewText(row: WorktreeRow): string {
  const parts: string[] = [];
  if (row.newCommits > 0) parts.push(plural(row.newCommits, 'commit'));
  if (row.unreviewed > 0) parts.push(plural(row.unreviewed, 'file'));
  return parts.length > 0 ? `to review: ${parts.join(' · ')}` : 'to review';
}

/** The label of the hover action and of its menu item. */
function hideLabel(row: WorktreeRow): string {
  if (row.state !== 'settled') return 'Hide until it changes';
  return row.settledBy === 'user' ? 'Show again' : 'Keep under its project';
}

/**
 * One worktree as a card (T3 Code's row anatomy). Under a project: the branch with the status
 * slot, then the meta line. Pinned and settled rows sit outside their project, so they start
 * with a project line (repo glyph and name). Hover or focus shows the hide / show action
 * beside the status slot and, after a moment, shows the hover card. Right-click (or the keyboard's menu
 * key) opens the actions, as on folder and project headers; there is no `⋯`.
 */
const WorktreeItem = memo(function WorktreeItem({
  row,
  variant,
  selected,
  onSelect,
  onMenu,
  onSettle,
}: RowProps) {
  const { worktree, summary } = row;
  const settled = row.state === 'settled';
  const blocked = row.state === 'blocked';
  const canSettle = summary !== null && !blocked;
  const settleLabel = hideLabel(row);
  const inFolder = variant === 'folder';
  const hover = useHoverCard();
  return (
    <li
      className="group/wt relative"
      data-section={variant}
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
      onPointerDown={hover.onPointerDown}
    >
      <button
        type="button"
        {...rowAttributes(row, selected)}
        onClick={() => onSelect(worktree.id)}
        onContextMenu={(e) => onMenu(e, row)}
        className={`flex w-full flex-col gap-0.5 rounded-md py-1.5 pr-2 text-left ${
          ROW_INDENT[variant]
        } ${selected ? 'bg-selected text-fg' : 'hover:bg-hover'} ${
          settled && !selected ? 'text-muted hover:text-fg' : ''
        }`}
      >
        {!inFolder && (
          <span className="flex w-full items-center gap-1.5 text-[11px] text-muted">
            <RepoIcon />
            <span className="min-w-0 truncate">{row.project.name}</span>
            <RowStatus row={row} makeRoom={canSettle} />
          </span>
        )}
        <span className="relative flex w-full items-center gap-1.5">
          <span
            className={`min-w-0 truncate ${inFolder ? 'font-medium' : ''} ${
              worktree.branch ? '' : 'italic'
            }`}
          >
            {worktreeLabel(worktree)}
          </span>
          <DefaultBranchChip row={row} />
          {inFolder && <RowStatus row={row} makeRoom={canSettle} />}
        </span>
        <RowMeta row={row} />
      </button>
      <span className="absolute top-1.5 right-1.5 flex h-4 items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/wt:opacity-100">
        {canSettle && (
          <button
            type="button"
            aria-label={settleLabel}
            onClick={() => onSettle(row)}
            className="flex h-5 items-center gap-1 rounded-sm px-1 text-[11px] text-muted hover:bg-raised hover:text-fg"
          >
            {settled ? <UndoIcon /> : <HideIcon />}
            {settled ? 'Show' : 'Hide'}
          </button>
        )}
      </span>
      {hover.at && <RowHoverCard row={row} at={hover.at} />}
    </li>
  );
});

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width="10"
      height="10"
      aria-hidden="true"
      className={`shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function ChevronButton({
  open,
  what,
  onToggle,
  onContextMenu,
}: {
  open: boolean;
  what: string;
  onToggle: () => void;
  /** The header's menu, so a right-click on the chevron opens it like the rest of the header. */
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${open ? 'Collapse' : 'Expand'} ${what}`}
      aria-expanded={open}
      onClick={onToggle}
      onContextMenu={onContextMenu}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm hover:bg-raised"
    >
      <Chevron open={open} />
    </button>
  );
}

/** A shelf header (Pinned, Hidden): a label, a muted count, optionally a chevron. */
function ShelfHeader({
  label,
  count,
  open,
  onToggle,
}: {
  label: string;
  count?: number | undefined;
  open?: boolean;
  onToggle?: () => void;
}) {
  const inner = (
    <>
      <span className="od-label">{label}</span>
      {count !== undefined && <span className="text-[11px] tabular-nums text-faint">{count}</span>}
    </>
  );
  return (
    <div className="mt-3 mb-0.5 flex h-6 items-center gap-1.5 px-1">
      {onToggle ? (
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${label.toLowerCase()}`}
          onClick={onToggle}
          className="flex items-center gap-1.5 rounded-sm pr-1 hover:bg-hover"
        >
          <Chevron open={open ?? true} />
          {inner}
        </button>
      ) : (
        inner
      )}
    </div>
  );
}

/** A closed folder or project still says how much it hides: a faint count and the pill. */
function HiddenStats({ worktrees, unreviewed }: { worktrees: number; unreviewed: number }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px] font-normal tabular-nums">
      <span className="text-faint" title={plural(worktrees, 'worktree')}>
        {worktrees}
      </span>
      {unreviewed > 0 && (
        <span className="od-pill" title={`${unreviewed} unreviewed`}>
          {unreviewed}
        </span>
      )}
    </span>
  );
}

export function Sidebar() {
  const store = useUiStore();
  const folderStart = useFolderStart();
  const model = useAppModel();
  const commands = useCommandsContext();
  const filterProjects = useUi((s) => s.filterProjects);
  const filterWorktrees = useUi((s) => s.filterWorktrees);
  const onlyDirty = useUi((s) => s.onlyDirty);
  const onlyUnreviewed = useUi((s) => s.onlyUnreviewed);
  const collapsed = useUi((s) => s.collapsed);
  const settledOpen = useUi((s) => s.settledOpen);
  const support = useSettingsSupport();
  const settings = useSettingsQuery();
  const setPolicy = useSetReviewPolicy();
  const rescan = useRescanScanRoot();
  const removeRoot = useRemoveScanRoot();
  const removeProject = useRemoveProject();
  const menu = useContextMenu<MenuTarget>();
  const view = model.view;
  const selectedWorktree = view.kind === 'worktree' ? view.worktreeId : null;
  const inboxCount = model.inboxEntries.length;
  const onSelect = (id: string) => actions.setView(store, { kind: 'worktree', worktreeId: id });
  const totalWorktrees = model.sidebar.byId.size;
  const filtering =
    filterProjects.length > 0 || filterWorktrees.length > 0 || onlyDirty || onlyUnreviewed;
  // Filters open everything: a hit must never hide behind a closed folder or shelf.
  const isCollapsed = (id: string) => !filtering && collapsed.includes(id);
  const shelfOpen = filtering || settledOpen;
  const overrides = new Map(
    (settings.data?.overrides ?? []).map((o) => [reviewTargetKey(o.target), o.enabled]),
  );
  const { sidebar } = model;

  // "Hide until it changes" holds only while the worktree's state hash is the one it was made on.
  useEffect(() => {
    actions.pruneSettle(store, (o) => {
      const row = sidebar.byId.get(o.worktreeId);
      return !row || row.summary === null || row.summary.stateHash === o.stateHash;
    });
  }, [sidebar.byId, store]);

  const onSettle = (row: WorktreeRow) => {
    const next = settleToggle(row);
    if (next === undefined || !row.summary) return;
    actions.setSettle(store, row.worktree.id, next, row.summary.stateHash);
  };

  const policyItems = (target: ReviewPolicyTarget | null, label: string): MenuItem[] => {
    if (support !== 'ready' || !target) return [];
    const key = reviewTargetKey(target);
    const state = overrides.has(key) ? (overrides.get(key) ? 'on' : 'off') : 'inherit';
    return [
      { id: 'policy-h', heading: true, label: `Review for ${label}` },
      ...(['on', 'off', 'inherit'] as const).map<MenuItem>((choice) => ({
        id: `policy-${choice}`,
        label: choice === 'inherit' ? 'Inherit' : choice === 'on' ? 'On' : 'Off',
        checked: state === choice,
        testId: TEST_IDS.reviewPolicyItem,
        data: { 'data-target': target.kind, 'data-state': choice },
        onSelect: () =>
          setPolicy.mutate({ target, enabled: choice === 'inherit' ? null : choice === 'on' }),
      })),
    ];
  };
  const bulkItems = (target: BulkReviewTarget, ids: string[]): MenuItem[] =>
    support !== 'ready'
      ? []
      : [
          {
            id: 'mark-reviewed',
            label: 'Mark all reviewed',
            onSelect: () => commands.markAllFor(target, true, ids),
          },
          {
            id: 'mark-unreviewed',
            label: 'Mark all unreviewed',
            onSelect: () => commands.markAllFor(target, false, ids),
          },
        ];
  const goto = (v: View, label: string): MenuItem => ({
    id: 'open',
    label,
    onSelect: () => actions.setView(store, v),
  });

  const copy: CopyFn = (text, options) => void copyAndReport(store, text, options);
  const menuItems = (t: MenuTarget): MenuItem[] => {
    switch (t.kind) {
      case 'folder': {
        const ids = t.node.groups.flatMap((g) => g.allRows.map((r) => r.worktree.id));
        const root = t.node.root;
        return [
          goto({ kind: 'folder', scanRootId: t.node.id }, 'Overview'),
          ...bulkItems(root ? { kind: 'folder', scanRootId: root.id } : { kind: 'all' }, ids),
          ...policyItems(root ? { kind: 'folder', scanRootId: root.id } : null, 'this folder'),
          ...(root
            ? [
                {
                  id: 'rescan',
                  label: 'Rescan folder',
                  separator: true,
                  onSelect: () => rescan.mutate(root.id),
                },
                {
                  id: 'remove',
                  label: 'Remove folder and its repositories…',
                  danger: true,
                  onSelect: () => actions.openSettings(store, 'folders'),
                },
              ]
            : []),
        ];
      }
      case 'project': {
        const ids = t.group.allRows.map((r) => r.worktree.id);
        const projectId = t.group.project.id;
        return [
          goto({ kind: 'project', projectId }, 'Overview'),
          ...bulkItems({ kind: 'project', projectId }, ids),
          ...policyItems({ kind: 'project', projectId }, t.group.project.name),
          {
            id: 'remove',
            label: 'Remove repository…',
            danger: true,
            separator: true,
            onSelect: () => actions.openSettings(store, 'folders'),
          },
        ];
      }
      case 'worktree': {
        const { row } = t;
        const id = row.worktree.id;
        const branch = row.worktree.branch;
        return [
          goto({ kind: 'worktree', worktreeId: id }, 'Open changes'),
          {
            id: 'settle',
            label: row.state === 'blocked' ? 'Hide (blocked)' : hideLabel(row),
            disabled: row.summary === null || row.state === 'blocked',
            onSelect: () => onSettle(row),
          },
          {
            id: 'pin',
            label: row.pinned ? 'Unpin' : 'Pin to the top',
            onSelect: () => actions.togglePinned(store, id),
          },
          goto({ kind: 'project', projectId: row.project.id }, `Overview of ${row.project.name}`),
          ...bulkItems({ kind: 'worktree', worktreeId: id }, [id]).map((item, i) =>
            i === 0 ? { ...item, separator: true } : item,
          ),
          ...policyItems({ kind: 'worktree', worktreeId: id }, 'this worktree'),
          ...(branch
            ? policyItems({ kind: 'branch', projectId: row.project.id, branch }, `branch ${branch}`)
            : []),
          ...separated(worktreeCopyItems(row.worktree, copy, menu.state?.position)),
        ];
      }
    }
  };

  const rowProps = (row: WorktreeRow, variant: RowVariant) => ({
    row,
    variant,
    selected: selectedWorktree === row.worktree.id,
    onSelect,
    onMenu: (e: RowEvent, r: WorktreeRow) => menu.open(e, { kind: 'worktree', row: r }),
    onSettle,
  });

  // A closed shelf still shows the selected worktree, so J/K and palette jumps have a row.
  const shelfRows = shelfOpen
    ? sidebar.settled
    : sidebar.settled.filter((r) => r.worktree.id === selectedWorktree);

  return (
    <nav
      data-testid={TEST_IDS.sidebar}
      aria-label="Worktrees, projects and folders"
      className="flex h-full min-h-0 flex-col border-r border-line bg-surface"
    >
      <div className="flex items-center gap-0.5 border-b border-line px-2 py-1.5">
        <Wordmark size={16} />
        <span className="ml-auto" />
        <button
          type="button"
          data-testid={TEST_IDS.addProjectButton}
          onClick={() => {
            // Load the start folder first so the picker opens with its list (T3 Code does this).
            void folderStart.prefetch().then(() => store.setState({ addProjectOpen: true }));
          }}
          title="Watch a folder or add a repository"
          aria-label="Watch a folder or add a repository"
          className="od-btn od-btn-ghost"
        >
          <PlusIcon />
        </button>
        <button
          type="button"
          data-testid={TEST_IDS.settingsOpenButton}
          onClick={() => commands.openSettings()}
          title="Settings (,)"
          aria-label="Settings"
          className="od-btn od-btn-ghost"
        >
          <GearIcon />
        </button>
      </div>
      <div className="border-b border-line p-2">
        <SidebarFilter />
      </div>

      <div className="od-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
        <button
          type="button"
          data-testid={TEST_IDS.inboxItem}
          data-count={String(inboxCount)}
          aria-current={view.kind === 'inbox' ? 'true' : undefined}
          onClick={() => actions.setView(store, { kind: 'inbox' })}
          className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-semibold ${
            view.kind === 'inbox' ? 'bg-selected' : 'hover:bg-hover'
          }`}
          title="Every dirty worktree of every project (g i)"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="text-muted">
            <path
              d="M2 9.5V13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.5M2 9.5 4 3h8l2 6.5M2 9.5h3.5l1 1.5h3l1-1.5H14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
          <span>Inbox</span>
          <span className="ml-auto text-[11px] font-normal tabular-nums text-muted">
            {inboxCount}
          </span>
        </button>

        {sidebar.groups.length === 0 && totalWorktrees > 0 && (
          <p className="px-2 py-3 text-xs text-muted">No worktrees match the filters.</p>
        )}

        {sidebar.groups.length > 0 && (
          <ul aria-label="Worktrees" className="flex flex-col">
            {sidebar.pinned.length > 0 && (
              <li role="presentation">
                <ShelfHeader label="Pinned" />
              </li>
            )}
            {sidebar.pinned.map((row) => (
              <WorktreeItem key={row.worktree.id} {...rowProps(row, 'pinned')} />
            ))}

            {sidebar.folders.map((node) => {
              const open = !isCollapsed(node.id);
              const current = view.kind === 'folder' && view.scanRootId === node.id;
              const visibleRows = node.groups.flatMap((g) => g.rows);
              return (
                <li key={node.id} data-folder-id={node.id} className="relative mt-2">
                  <div
                    className={`flex h-[var(--od-row)] items-center gap-0.5 rounded-sm pr-2 ${
                      current ? 'bg-selected' : 'hover:bg-hover'
                    }`}
                  >
                    <ChevronButton
                      open={open}
                      what="folder"
                      onToggle={() => actions.toggleCollapsed(store, node.id)}
                      onContextMenu={(e) => menu.open(e, { kind: 'folder', node })}
                    />
                    <button
                      type="button"
                      aria-current={current ? 'true' : undefined}
                      onClick={() =>
                        actions.setView(store, { kind: 'folder', scanRootId: node.id })
                      }
                      onContextMenu={(e) => menu.open(e, { kind: 'folder', node })}
                      title={
                        node.root
                          ? `${node.root.path} (depth ${node.root.depth})`
                          : 'Projects added without a folder'
                      }
                      className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
                      <FolderIcon direct={node.id === DIRECT_FOLDER_ID} />
                      <span className="od-label truncate font-mono">{node.label}</span>
                      {!open && (
                        <HiddenStats
                          worktrees={visibleRows.length}
                          unreviewed={visibleRows.reduce((n, r) => n + r.unreviewed, 0)}
                        />
                      )}
                    </button>
                  </div>
                  {open && (
                    <ul className="flex flex-col">
                      {node.groups.map((group) => (
                        <ProjectFolder
                          key={group.project.id}
                          group={group}
                          open={!isCollapsed(group.project.id)}
                          current={view.kind === 'project' && view.projectId === group.project.id}
                          onToggle={() => actions.toggleCollapsed(store, group.project.id)}
                          onOpen={() =>
                            actions.setView(store, { kind: 'project', projectId: group.project.id })
                          }
                          onMenu={(e) => menu.open(e, { kind: 'project', group })}
                        >
                          {group.active.map((row) => (
                            <WorktreeItem key={row.worktree.id} {...rowProps(row, 'folder')} />
                          ))}
                        </ProjectFolder>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}

            {sidebar.settled.length > 0 && (
              <li role="presentation">
                <ShelfHeader
                  label="Hidden"
                  count={sidebar.settled.length}
                  open={shelfOpen}
                  onToggle={() => actions.toggleSettledOpen(store)}
                />
              </li>
            )}
            {shelfRows.map((row) => (
              <WorktreeItem key={row.worktree.id} {...rowProps(row, 'settled')} />
            ))}
          </ul>
        )}
      </div>

      {menu.state && (
        <ContextMenu
          items={menuItems(menu.state.target)}
          position={menu.state.position}
          onClose={menu.close}
          label="Actions"
        />
      )}
      {removeRoot.isPending || removeProject.isPending ? (
        <span className="sr-only" aria-live="polite">
          Removing…
        </span>
      ) : null}
    </nav>
  );
}

/**
 * A project under its folder (T3 Code's project folder header): chevron, name, and, while
 * closed or when every worktree has settled, what it hides. Its open worktrees follow as rows.
 */
function ProjectFolder({
  group,
  open,
  current,
  onToggle,
  onOpen,
  onMenu,
  children,
}: {
  group: ProjectGroup;
  open: boolean;
  current: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onMenu: (event: RowEvent) => void;
  children: ReactNode;
}) {
  const { project, rows, active } = group;
  const unreviewed = rows.reduce((n, r) => n + r.unreviewed, 0);
  const settledCount = rows.length - active.length;
  return (
    <li
      data-testid={TEST_IDS.projectItem}
      data-project-id={project.id}
      data-project-name={project.name}
      className="relative"
    >
      <div
        className={`flex h-[var(--od-row)] items-center gap-0.5 rounded-sm pr-2 pl-4 ${
          current ? 'bg-selected' : 'hover:bg-hover'
        }`}
      >
        <ChevronButton open={open} what="project" onToggle={onToggle} onContextMenu={onMenu} />
        <button
          type="button"
          aria-current={current ? 'true' : undefined}
          onClick={onOpen}
          onContextMenu={onMenu}
          title={project.mainWorktreePath ?? project.commonDir}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <RepoIcon />
          <span className="truncate font-medium">{project.name}</span>
          {!open ? (
            <HiddenStats worktrees={rows.length} unreviewed={unreviewed} />
          ) : active.length === 0 ? (
            <span
              className="ml-auto shrink-0 text-[11px] text-faint"
              title={`${plural(settledCount, 'worktree')}, nothing to do (in Hidden below)`}
            >
              hidden
            </span>
          ) : null}
        </button>
      </div>
      {open && active.length > 0 && <ul className="flex flex-col">{children}</ul>}
    </li>
  );
}

function FolderIcon({ direct }: { direct: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      aria-hidden="true"
      className="shrink-0 text-muted"
    >
      {direct ? (
        <path
          d="M3 4.5h10v8H3zM3 4.5l2-2h3l1 2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeDasharray="2 1.5"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M2 4a1 1 0 0 1 1-1h3.2l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/** A repository: the branch glyph, one weight, `currentColor`. */
function RepoIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      aria-hidden="true"
      className="shrink-0 text-muted"
    >
      <circle cx="4.5" cy="3.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4.5" cy="12.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="11.5" cy="5.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M4.5 5.1v5.8M11.5 7.1c0 2.2-2.5 2.6-4.5 2.9-1 .2-2 .5-2.5 1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** An eye with a stroke: hide until it changes. */
function HideIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8zM2.5 13.5l11-11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M5.5 3.5 2.5 6.5l3 3M2.5 6.5H10a3.5 3.5 0 0 1 0 7H7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M8 3v10M3 8h10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M6.6 1.5h2.8l.4 1.9 1.6.9 1.8-.6 1.4 2.4-1.4 1.3v1.8l1.4 1.3-1.4 2.4-1.8-.6-1.6.9-.4 1.9H6.6l-.4-1.9-1.6-.9-1.8.6L1.4 11l1.4-1.3V7.9L1.4 6.6l1.4-2.4 1.8.6 1.6-.9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8.4" r="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
