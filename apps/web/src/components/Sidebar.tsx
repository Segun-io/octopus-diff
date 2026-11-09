import {
  type BulkReviewTarget,
  type ReviewPolicyTarget,
  reviewTargetKey,
  TEST_IDS,
} from '@octopus-diff/contracts';
import { memo, type ReactNode, useEffect, useState } from 'react';
import {
  useRemoveProject,
  useRemoveScanRoot,
  useRescanScanRoot,
  useSetReviewPolicy,
  useSettingsQuery,
  useSettingsSupport,
} from '../api/settings.ts';
import {
  autoRowState,
  DIRECT_FOLDER_ID,
  type FolderNode,
  isDirtySummary,
  type ProjectGroup,
  settledWord,
  type WorktreeRow,
  worktreeLabel,
} from '../lib/model.ts';
import { isRecentlyActive, worktreeSource } from '../lib/source.ts';
import { useCommandsContext } from '../state/commandsContext.tsx';
import { useAppModel } from '../state/model.tsx';
import { actions, useUi, useUiStore, type View } from '../state/ui.tsx';
import { CheckIcon, MoreIcon, ToggleButton } from './bits.tsx';
import { ContextMenu, type MenuItem, useContextMenu } from './ContextMenu.tsx';
import { useFolderStart } from './FolderBrowser.tsx';
import { Wordmark } from './Mark.tsx';

/**
 * The sidebar (DECISIONS "UX round 4", after T3 Code's folders sidebar): the Inbox; **Pinned**
 * worktrees; then every folder (scan root) with its projects, and under each project the
 * worktrees that are still open: blocked, with unreviewed files, or un-settled by hand. Settled
 * worktrees (clean, all verified, review off, missing, failed, or settled by hand) leave their
 * project for the **Settled** shelf at the bottom, closed by default: density is earned by
 * settling. Marking files verified settles; a new patch un-settles; the check on a row settles
 * by hand until the worktree changes again. Rows never reorder on activity.
 */

function attr(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Re-renders every 2 s so the activity pulse can expire (only while something is recent). */
function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(timer);
  }, [active]);
  return active ? now : Date.now();
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
  now: number;
  onSelect: (id: string) => void;
  onMenu: (event: RowEvent, row: WorktreeRow) => void;
  onSettle: (row: WorktreeRow) => void;
}

/** The data attributes the e2e suite reads (TEST_IDS.worktreeItem); the same in every variant. */
function rowAttributes(row: WorktreeRow, selected: boolean, active: boolean) {
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
    'data-active': String(active),
    'data-state': row.state,
    'data-pinned': String(row.pinned),
    'aria-current': selected ? ('true' as const) : undefined,
  };
}

/** The tooltip carries the facts the row no longer shows: path, files, lines, ahead/behind. */
function rowTitle(row: WorktreeRow): string {
  const { summary, error } = row;
  const lines = [row.worktree.path];
  if (summary) {
    const facts: string[] = [];
    if (isDirtySummary(summary)) facts.push(plural(summary.changedFiles, 'file'));
    if (summary.additions > 0 || summary.deletions > 0) {
      facts.push(`+${summary.additions} −${summary.deletions}`);
    }
    if (summary.ahead !== null && summary.behind !== null && summary.aheadBehindRef) {
      facts.push(`↑${summary.ahead} ↓${summary.behind} vs ${summary.aheadBehindRef}`);
    }
    if (facts.length > 0) lines.push(facts.join(' · '));
  }
  if (error) lines.push(error.message);
  if (row.settledBy === 'user') {
    lines.push(row.state === 'settled' ? 'Settled by hand' : 'Un-settled by hand');
  }
  return lines.join('\n');
}

/** `main`, the worktree source, an in-progress operation: the chips after the name. */
function RowChips({ row }: { row: WorktreeRow }) {
  const { worktree, summary, project } = row;
  const source = worktree.isMain ? null : worktreeSource(worktree.path);
  // The main checkout on the default branch is the expected case; the chip speaks only when the
  // main checkout sits elsewhere, or when the project has no default branch to compare with.
  const mainChip = worktree.isMain && worktree.branch !== project.defaultBranch;
  return (
    <>
      {mainChip && (
        <span className="od-chip" title="Main checkout">
          main
        </span>
      )}
      {source && (
        <span className="od-chip font-mono" title={source.title}>
          {source.label}
        </span>
      )}
      {summary?.inProgress && (
        <span className="od-chip text-warn" title={`${summary.inProgress} in progress`}>
          {summary.inProgress}
        </span>
      )}
    </>
  );
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
 * The status slot at the right of a row: the unreviewed pill (the one filled shape), `N
 * conflicts` for blocked work, or one word for a settled or un-settled row.
 */
function RowStatus({ row }: { row: WorktreeRow }) {
  const counts = row.summary?.counts;
  const word = settledWord(row);
  const quiet = row.state === 'settled' || row.state === 'active';
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px]">
      {!row.review.enabled && <ReviewOffBadge row={row} />}
      {counts && counts.conflicted > 0 && (
        <span className="text-danger">{plural(counts.conflicted, 'conflict')}</span>
      )}
      {row.unreviewed > 0 && (
        <span className="od-pill" title={`${row.unreviewed} unreviewed`}>
          {row.unreviewed}
        </span>
      )}
      {quiet && word !== 'review off' && (
        <span
          className={word === 'missing' || word === 'error' ? 'text-danger' : 'text-faint'}
          title={word === 'error' && row.error ? row.error.message : undefined}
        >
          {word === 'loading' ? '…' : word}
        </span>
      )}
    </span>
  );
}

const ROW_INDENT: Record<RowVariant, string> = {
  pinned: 'pl-2',
  folder: 'pl-9',
  settled: 'pl-2',
};

/**
 * One worktree. Under a project it says only its branch; pinned and settled rows, which sit
 * outside their project, say project then branch. Hover (or focus) reveals the settle check and
 * the `⋯` menu at the right; the status slot stays where it is.
 */
const WorktreeItem = memo(function WorktreeItem({
  row,
  variant,
  selected,
  now,
  onSelect,
  onMenu,
  onSettle,
}: RowProps) {
  const { worktree, summary } = row;
  const active = isRecentlyActive(summary?.updatedAt, now);
  const settled = row.state === 'settled';
  const blocked = row.state === 'blocked';
  const canSettle = summary !== null && !blocked;
  const settleLabel = settled ? 'Un-settle worktree' : 'Settle worktree';
  return (
    <li className="group/wt relative" data-section={variant}>
      <button
        type="button"
        {...rowAttributes(row, selected, active)}
        title={rowTitle(row)}
        onClick={() => onSelect(worktree.id)}
        onContextMenu={(e) => onMenu(e, row)}
        className={`flex h-[var(--od-row)] w-full items-center gap-1.5 rounded-sm pr-[52px] text-left ${
          ROW_INDENT[variant]
        } ${selected ? 'bg-selected text-fg' : 'hover:bg-hover'} ${
          settled && !selected ? 'text-muted hover:text-fg' : ''
        }`}
      >
        <span className="relative flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
          {active && <span className="od-pulse" aria-hidden="true" />}
          {variant !== 'folder' && (
            <span className="min-w-0 shrink truncate font-medium">{row.project.name}</span>
          )}
          <span
            className={`min-w-[3rem] truncate ${
              variant === 'folder' ? 'shrink text-fg' : 'shrink-[2] text-muted'
            } ${worktree.branch ? '' : 'italic'}`}
          >
            {worktreeLabel(worktree)}
          </span>
          <RowChips row={row} />
        </span>
        <RowStatus row={row} />
      </button>
      <span className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/wt:opacity-100">
        {canSettle && (
          <button
            type="button"
            aria-label={settleLabel}
            title={settleLabel}
            onClick={() => onSettle(row)}
            className="flex h-5 w-5 items-center justify-center rounded-sm text-faint hover:bg-raised hover:text-fg"
          >
            {settled ? <UndoIcon /> : <CheckIcon />}
          </button>
        )}
        <MoreButton
          label={`Actions for ${row.project.name} ${worktreeLabel(worktree)}`}
          onOpen={(e) => onMenu(e, row)}
        />
      </span>
    </li>
  );
});

/** Keyboard-reachable "⋯" that opens the same menu as right-click. */
function MoreButton({ label, onOpen }: { label: string; onOpen: (event: RowEvent) => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      onClick={onOpen}
      className="flex h-5 w-5 items-center justify-center rounded-sm text-faint hover:bg-raised hover:text-fg"
    >
      <MoreIcon size={12} />
    </button>
  );
}

/** The hover slot of folder and project headers: only the `⋯` menu. */
function HeaderActions({ group, children }: { group: 'folder' | 'proj'; children: ReactNode }) {
  const reveal =
    group === 'folder' ? 'group-hover/folder:opacity-100' : 'group-hover/proj:opacity-100';
  return (
    <span
      className={`absolute top-0 right-1 flex h-[var(--od-row)] items-center opacity-0 focus-within:opacity-100 ${reveal}`}
    >
      {children}
    </span>
  );
}

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
}: {
  open: boolean;
  what: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${open ? 'Collapse' : 'Expand'} ${what}`}
      aria-expanded={open}
      onClick={onToggle}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm hover:bg-raised"
    >
      <Chevron open={open} />
    </button>
  );
}

/** A shelf header (Pinned, Settled): a label, a muted count, optionally a chevron. */
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
  const filterText = useUi((s) => s.filterText);
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
  const anyRecent = [...model.sidebar.byId.values()].some((r) =>
    isRecentlyActive(r.summary?.updatedAt, Date.now()),
  );
  const now = useClock(anyRecent);
  const filtering = filterText.trim() !== '' || onlyDirty || onlyUnreviewed;
  // Filters open everything: a hit must never hide behind a closed folder or shelf.
  const isCollapsed = (id: string) => !filtering && collapsed.includes(id);
  const shelfOpen = filtering || settledOpen;
  const overrides = new Map(
    (settings.data?.overrides ?? []).map((o) => [reviewTargetKey(o.target), o.enabled]),
  );
  const { sidebar } = model;

  // A manual settle holds only while the worktree's state hash is the one it was made on.
  useEffect(() => {
    actions.pruneSettle(store, (o) => {
      const row = sidebar.byId.get(o.worktreeId);
      return !row || row.summary === null || row.summary.stateHash === o.stateHash;
    });
  }, [sidebar.byId, store]);

  const onSettle = (row: WorktreeRow) => {
    const hash = row.summary?.stateHash;
    if (!hash || row.state === 'blocked') return;
    const auto = autoRowState(row);
    const id = row.worktree.id;
    if (row.state === 'settled') {
      actions.setSettle(store, id, auto === 'settled' ? 'active' : null, hash);
    } else {
      actions.setSettle(store, id, auto === 'settled' ? null : 'settled', hash);
    }
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
            id: 'mark-verified',
            label: 'Mark all as verified',
            onSelect: () => commands.markAllFor(target, true, ids),
          },
          {
            id: 'mark-unreviewed',
            label: 'Mark all as unreviewed',
            onSelect: () => commands.markAllFor(target, false, ids),
          },
        ];
  const goto = (v: View, label: string): MenuItem => ({
    id: 'open',
    label,
    onSelect: () => actions.setView(store, v),
  });

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
        const settled = row.state === 'settled';
        return [
          goto({ kind: 'worktree', worktreeId: id }, 'Open changes'),
          {
            id: 'settle',
            label: settled ? 'Un-settle' : row.state === 'blocked' ? 'Settle (blocked)' : 'Settle',
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
        ];
      }
    }
  };

  const rowProps = (row: WorktreeRow, variant: RowVariant) => ({
    row,
    variant,
    now,
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
      <div className="flex flex-col gap-1.5 border-b border-line p-2">
        <div className="relative">
          <input
            data-testid={TEST_IDS.sidebarFilter}
            data-filter-input=""
            type="search"
            name="filter"
            autoComplete="off"
            placeholder="Filter worktrees"
            aria-label="Filter projects and worktrees"
            aria-keyshortcuts="/"
            value={filterText}
            onChange={(e) => store.setState({ filterText: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                if (filterText) store.setState({ filterText: '' });
                else (e.target as HTMLInputElement).blur();
              } else if (e.key === 'Enter') {
                (e.target as HTMLInputElement).blur();
              }
            }}
            className="od-input w-full pr-7"
          />
          {filterText === '' && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2"
            >
              <kbd className="text-faint">/</kbd>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 px-0.5">
          <ToggleButton
            variant="chip"
            pressed={onlyDirty}
            onClick={() => store.setState({ onlyDirty: !onlyDirty })}
            title="Only worktrees with changes"
            testId={TEST_IDS.onlyDirtyToggle}
          >
            Only dirty
          </ToggleButton>
          <ToggleButton
            variant="chip"
            pressed={onlyUnreviewed}
            onClick={() => store.setState({ onlyUnreviewed: !onlyUnreviewed })}
            title="Only worktrees with unreviewed files in the current scope"
            testId={TEST_IDS.onlyUnreviewedToggle}
          >
            Only unreviewed
          </ToggleButton>
        </div>
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
                <li key={node.id} data-folder-id={node.id} className="group/folder relative mt-2">
                  <div
                    className={`flex h-[var(--od-row)] items-center gap-0.5 rounded-sm pr-7 ${
                      current ? 'bg-selected' : 'hover:bg-hover'
                    }`}
                  >
                    <ChevronButton
                      open={open}
                      what="folder"
                      onToggle={() => actions.toggleCollapsed(store, node.id)}
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
                  <HeaderActions group="folder">
                    <MoreButton
                      label={`Actions for ${node.label}`}
                      onOpen={(e) => menu.open(e, { kind: 'folder', node })}
                    />
                  </HeaderActions>
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
                  label="Settled"
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
      className="group/proj relative"
    >
      <div
        className={`flex h-[var(--od-row)] items-center gap-0.5 rounded-sm pr-7 pl-4 ${
          current ? 'bg-selected' : 'hover:bg-hover'
        }`}
      >
        <ChevronButton open={open} what="project" onToggle={onToggle} />
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
              title={`${plural(settledCount, 'worktree')}, all settled`}
            >
              settled
            </span>
          ) : null}
        </button>
      </div>
      <HeaderActions group="proj">
        <MoreButton label={`Actions for ${project.name}`} onOpen={onMenu} />
      </HeaderActions>
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
