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
import { MoreIcon, ToggleButton } from './bits.tsx';
import { ContextMenu, type MenuItem, useContextMenu } from './ContextMenu.tsx';
import { Wordmark } from './Mark.tsx';

/**
 * The sidebar is an activity list, not a tree (DECISIONS "UX round 3", after T3 Code's
 * Sidebar V2): the Inbox, then a block of cards for worktrees that want attention (pinned,
 * blocked, unreviewed), then a settled tail of one-line rows (clean, verified, review off), then
 * a compact index of folders and projects. Review marks are the settle action: marking a
 * worktree's files verified moves it into the tail; a new patch brings it back as a card.
 * Rows never reorder on activity.
 */

/** Collapsed-state id of the settled tail (stored next to folder ids in the `collapsed` pref). */
export const SETTLED_SECTION_ID = 'settled';

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

type RowMenu = (event: React.MouseEvent | React.KeyboardEvent, row: WorktreeRow) => void;

interface RowProps {
  row: WorktreeRow;
  selected: boolean;
  now: number;
  onSelect: (id: string) => void;
  onMenu: RowMenu;
}

/** The data attributes the e2e suite reads (TEST_IDS.worktreeItem); same on cards and rows. */
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

function rowTitle(row: WorktreeRow): string {
  const ref = row.summary?.aheadBehindRef;
  return `${row.worktree.path}${ref ? `\nahead/behind ${ref}` : ''}`;
}

/**
 * A worktree's name: the project, then the branch, set apart by weight (IDENTITY.md §5). The
 * branch takes at most half the row, so a long branch name never hides the project.
 */
function RowName({ row }: { row: WorktreeRow }) {
  const { worktree } = row;
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="min-w-0 flex-1 truncate font-medium text-fg">{row.project.name}</span>
      <span
        className={`max-w-[55%] shrink-0 truncate ${worktree.branch ? 'text-muted' : 'italic text-muted'}`}
      >
        {worktreeLabel(worktree)}
      </span>
    </span>
  );
}

/** `main`, the worktree source, an in-progress operation, `pinned`: the chips on a card's facts line. */
function NameChips({ row }: { row: WorktreeRow }) {
  const { worktree, summary } = row;
  const source = worktree.isMain ? null : worktreeSource(worktree.path);
  return (
    <>
      {worktree.isMain && (
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
      {row.pinned && (
        <span className="od-chip" title="Pinned to the top on this device">
          pinned
        </span>
      )}
    </>
  );
}

function ReviewOffBadge({ row, className = '' }: { row: WorktreeRow; className?: string }) {
  return (
    <span
      data-testid={TEST_IDS.reviewOffBadge}
      data-source={row.review.source}
      className={`od-chip shrink-0 ${className}`}
      title={`Review off (from ${row.review.source})`}
    >
      review off
    </span>
  );
}

/**
 * A card: a worktree that wants attention. Two lines: the name (project, branch, chips, the
 * unreviewed count), then the facts (files, lines, ahead/behind, conflicts).
 */
const WorktreeCard = memo(function WorktreeCard({
  row,
  selected,
  now,
  onSelect,
  onMenu,
}: RowProps) {
  const { worktree, summary, error } = row;
  const counts = summary?.counts;
  const active = isRecentlyActive(summary?.updatedAt, now);
  const dirty = isDirtySummary(summary);
  const word = settledWord(row);
  return (
    <li className="group/wt relative">
      <button
        type="button"
        {...rowAttributes(row, selected, active)}
        title={rowTitle(row)}
        onClick={() => onSelect(worktree.id)}
        onContextMenu={(e) => onMenu(e, row)}
        className={`flex w-full flex-col gap-0.5 rounded-md border py-1.5 pr-7 pl-[22px] text-left ${
          selected ? 'border-line-strong bg-selected' : 'border-line bg-canvas hover:bg-hover'
        }`}
      >
        <span className="relative flex min-w-0 items-center gap-1.5">
          {active && <span className="od-pulse" aria-hidden="true" />}
          <RowName row={row} />
          <span className="ml-auto" />
          {!row.review.enabled && <ReviewOffBadge row={row} />}
          {row.unreviewed > 0 && (
            <span className="od-pill shrink-0" title={`${row.unreviewed} unreviewed`}>
              {row.unreviewed}
            </span>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-muted">
          <NameChips row={row} />
          {counts && counts.conflicted > 0 && (
            <span className="text-danger">{plural(counts.conflicted, 'conflict')}</span>
          )}
          {summary && dirty && <span>{plural(summary.changedFiles, 'file')}</span>}
          {summary && (summary.additions > 0 || summary.deletions > 0) && (
            <span>
              <span className="text-add">+{summary.additions}</span>{' '}
              <span className="text-del">−{summary.deletions}</span>
            </span>
          )}
          {summary &&
            summary.ahead !== null &&
            summary.behind !== null &&
            summary.ahead + summary.behind > 0 && (
              <span title={`ahead/behind ${summary.aheadBehindRef ?? ''}`}>
                ↑{summary.ahead} ↓{summary.behind}
              </span>
            )}
          {row.state === 'settled' && word !== 'review off' && word !== 'loading' && (
            <span className={word === 'missing' || word === 'error' ? 'text-danger' : 'text-faint'}>
              {word === 'error' && error ? `error: ${error.message}` : word}
            </span>
          )}
          {word === 'loading' && <span className="text-faint">…</span>}
        </span>
      </button>
      <MoreButton
        label={`Actions for ${row.project.name} ${worktreeLabel(worktree)}`}
        group="wt"
        onOpen={(e) => onMenu(e, row)}
      />
    </li>
  );
});

/** A settled row: one dimmed line, the name and one word. Density is earned by settling. */
const SettledRow = memo(function SettledRow({ row, selected, now, onSelect, onMenu }: RowProps) {
  const { worktree, summary, error } = row;
  const active = isRecentlyActive(summary?.updatedAt, now);
  const word = settledWord(row);
  return (
    <li className="group/wt relative">
      <button
        type="button"
        {...rowAttributes(row, selected, active)}
        title={rowTitle(row)}
        onClick={() => onSelect(worktree.id)}
        onContextMenu={(e) => onMenu(e, row)}
        className={`flex w-full items-center gap-1.5 rounded-sm py-1 pr-7 pl-[22px] text-left text-muted hover:text-fg ${
          selected ? 'bg-selected text-fg' : 'hover:bg-hover'
        }`}
      >
        <span className="relative flex min-w-0 flex-1 items-center gap-1.5">
          {active && <span className="od-pulse" aria-hidden="true" />}
          <RowName row={row} />
        </span>
        {row.pinned && <span className="od-chip">pinned</span>}
        {!row.review.enabled && <ReviewOffBadge row={row} />}
        {word !== 'review off' && (
          <span
            className={`shrink-0 text-[11px] ${
              word === 'missing' || word === 'error' ? 'text-danger' : 'text-faint'
            }`}
            title={word === 'error' && error ? error.message : undefined}
          >
            {word === 'loading' ? '…' : word}
          </span>
        )}
      </button>
      <MoreButton
        label={`Actions for ${row.project.name} ${worktreeLabel(worktree)}`}
        group="wt"
        onOpen={(e) => onMenu(e, row)}
      />
    </li>
  );
});

/** Only the nearest hovered row reveals its button (named groups, one per tier). */
const MORE_VISIBILITY = {
  wt: 'group-hover/wt:opacity-100',
  proj: 'group-hover/proj:opacity-100',
  folder: 'group-hover/folder:opacity-100',
} as const;

/** Keyboard-reachable "⋯" that opens the same menu as right-click. */
function MoreButton({
  label,
  group,
  onOpen,
}: {
  label: string;
  group: keyof typeof MORE_VISIBILITY;
  onOpen: (event: React.MouseEvent | React.KeyboardEvent) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      onClick={onOpen}
      className={`absolute top-1 right-1 flex items-center rounded-sm p-0.5 text-faint opacity-0 hover:bg-raised hover:text-fg focus:opacity-100 ${MORE_VISIBILITY[group]}`}
    >
      <MoreIcon size={12} />
    </button>
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

/** Section label with a count; optionally collapsible. */
function SectionHeader({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string;
  count?: number | undefined;
  open?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}) {
  const inner = (
    <>
      <span className="od-label">{label}</span>
      {count !== undefined && <span className="text-[11px] tabular-nums text-faint">{count}</span>}
    </>
  );
  return (
    <div className="mt-3 mb-1 flex h-6 items-center gap-1.5 px-1">
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
      {children}
    </div>
  );
}

export function Sidebar() {
  const store = useUiStore();
  const model = useAppModel();
  const commands = useCommandsContext();
  const filterText = useUi((s) => s.filterText);
  const onlyDirty = useUi((s) => s.onlyDirty);
  const onlyUnreviewed = useUi((s) => s.onlyUnreviewed);
  const collapsed = useUi((s) => s.collapsed);
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
  const isCollapsed = (id: string) => !filtering && collapsed.includes(id);
  const settledOpen = !isCollapsed(SETTLED_SECTION_ID);
  const overrides = new Map(
    (settings.data?.overrides ?? []).map((o) => [reviewTargetKey(o.target), o.enabled]),
  );

  // J/K or a palette jump can land on a settled worktree: the tail opens to show it.
  const selectedIsSettled =
    selectedWorktree !== null &&
    model.sidebar.settled.some((r) => r.worktree.id === selectedWorktree);
  useEffect(() => {
    if (selectedIsSettled && !settledOpen) actions.toggleCollapsed(store, SETTLED_SECTION_ID);
  }, [selectedIsSettled, settledOpen, store]);

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
        const id = t.row.worktree.id;
        const branch = t.row.worktree.branch;
        return [
          goto({ kind: 'worktree', worktreeId: id }, 'Open changes'),
          {
            id: 'pin',
            label: t.row.pinned ? 'Unpin' : 'Pin to the top',
            onSelect: () => actions.togglePinned(store, id),
          },
          goto(
            { kind: 'project', projectId: t.row.project.id },
            `Overview of ${t.row.project.name}`,
          ),
          ...bulkItems({ kind: 'worktree', worktreeId: id }, [id]).map((item, i) =>
            i === 0 ? { ...item, separator: true } : item,
          ),
          ...policyItems({ kind: 'worktree', worktreeId: id }, 'this worktree'),
          ...(branch
            ? policyItems(
                { kind: 'branch', projectId: t.row.project.id, branch },
                `branch ${branch}`,
              )
            : []),
        ];
      }
    }
  };

  const rowProps = (row: WorktreeRow) => ({
    row,
    now,
    selected: selectedWorktree === row.worktree.id,
    onSelect,
    onMenu: (e: React.MouseEvent | React.KeyboardEvent, r: WorktreeRow) =>
      menu.open(e, { kind: 'worktree', row: r }),
  });

  return (
    <nav
      data-testid={TEST_IDS.sidebar}
      aria-label="Worktrees, projects and folders"
      className="flex h-full min-h-0 flex-col border-r border-line bg-surface"
    >
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <Wordmark size={16} />
        <span className="ml-auto" />
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
        <div className="flex gap-1">
          <ToggleButton
            pressed={onlyDirty}
            onClick={() => store.setState({ onlyDirty: !onlyDirty })}
            title="Only worktrees with changes"
            testId={TEST_IDS.onlyDirtyToggle}
          >
            Only dirty
          </ToggleButton>
          <ToggleButton
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

        {model.sidebar.groups.length === 0 && totalWorktrees > 0 && (
          <p className="px-2 py-3 text-xs text-muted">No worktrees match the filters.</p>
        )}

        {totalWorktrees > 0 && model.sidebar.groups.length > 0 && (
          <>
            <SectionHeader label="To review" count={model.sidebar.cards.length} />
            {model.sidebar.cards.length === 0 ? (
              <p className="px-2 pb-1 text-[11px] text-faint">Nothing to review in this scope.</p>
            ) : (
              <ul data-section="cards" className="flex flex-col gap-1">
                {model.sidebar.cards.map((row) => (
                  <WorktreeCard key={row.worktree.id} {...rowProps(row)} />
                ))}
              </ul>
            )}

            {model.sidebar.settled.length > 0 && (
              <>
                <SectionHeader
                  label="Settled"
                  count={model.sidebar.settled.length}
                  open={settledOpen}
                  onToggle={() => actions.toggleCollapsed(store, SETTLED_SECTION_ID)}
                />
                {settledOpen && (
                  <ul data-section="settled" className="flex flex-col">
                    {model.sidebar.settled.map((row) => (
                      <SettledRow key={row.worktree.id} {...rowProps(row)} />
                    ))}
                  </ul>
                )}
              </>
            )}
          </>
        )}

        {model.sidebar.folders.length > 0 && (
          <>
            <SectionHeader label="Projects" count={model.sidebar.groups.length} />
            <ul data-section="projects" className="flex flex-col gap-0.5">
              {model.sidebar.folders.map((node) => {
                const open = !isCollapsed(node.id);
                const current = view.kind === 'folder' && view.scanRootId === node.id;
                return (
                  <li key={node.id} data-folder-id={node.id}>
                    <div
                      className={`group/folder relative flex items-center gap-1 rounded-sm pr-6 ${
                        current ? 'bg-selected' : 'hover:bg-hover'
                      }`}
                    >
                      <button
                        type="button"
                        aria-label={open ? 'Collapse folder' : 'Expand folder'}
                        aria-expanded={open}
                        onClick={() => actions.toggleCollapsed(store, node.id)}
                        className="rounded-sm p-1"
                      >
                        <Chevron open={open} />
                      </button>
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
                        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
                      >
                        <FolderIcon direct={node.id === DIRECT_FOLDER_ID} />
                        <span className="truncate font-mono text-[11px] text-fg">{node.label}</span>
                        <IndexStats
                          worktrees={node.stats.worktrees}
                          unreviewed={node.stats.unreviewed}
                        />
                      </button>
                      <MoreButton
                        label={`Actions for ${node.label}`}
                        group="folder"
                        onOpen={(e) => menu.open(e, { kind: 'folder', node })}
                      />
                    </div>
                    {open && (
                      <ul className="ml-2 flex flex-col border-l border-line pl-1">
                        {node.groups.map((group) => {
                          const pCurrent =
                            view.kind === 'project' && view.projectId === group.project.id;
                          const unreviewed = group.allRows.reduce((n, r) => n + r.unreviewed, 0);
                          return (
                            <li
                              key={group.project.id}
                              data-testid={TEST_IDS.projectItem}
                              data-project-id={group.project.id}
                              data-project-name={group.project.name}
                              className={`group/proj relative flex items-center rounded-sm pr-6 ${
                                pCurrent ? 'bg-selected' : 'hover:bg-hover'
                              }`}
                            >
                              <button
                                type="button"
                                aria-current={pCurrent ? 'true' : undefined}
                                onClick={() =>
                                  actions.setView(store, {
                                    kind: 'project',
                                    projectId: group.project.id,
                                  })
                                }
                                onContextMenu={(e) => menu.open(e, { kind: 'project', group })}
                                title={group.project.mainWorktreePath ?? group.project.commonDir}
                                className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-2 text-left"
                              >
                                <span className="truncate font-medium">{group.project.name}</span>
                                <IndexStats
                                  worktrees={group.allRows.length}
                                  unreviewed={unreviewed}
                                />
                              </button>
                              <MoreButton
                                label={`Actions for ${group.project.name}`}
                                group="proj"
                                onOpen={(e) => menu.open(e, { kind: 'project', group })}
                              />
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      <div className="border-t border-line p-2">
        <button
          type="button"
          data-testid={TEST_IDS.addProjectButton}
          onClick={() => store.setState({ addProjectOpen: true })}
          className="od-btn w-full"
        >
          Watch a folder or add a repository
        </button>
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

/** Folder and project index rows: how many worktrees, and the unreviewed count if any. */
function IndexStats({ worktrees, unreviewed }: { worktrees: number; unreviewed: number }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] font-normal tabular-nums">
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
