import {
  type BulkReviewTarget,
  type ReviewPolicyTarget,
  reviewTargetKey,
  TEST_IDS,
} from '@octopus-diff/contracts';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSetReviewPolicy, useSettingsQuery, useSettingsSupport } from '../api/settings.ts';
import { useSidebarNote } from '../api/wait.ts';
import { folderIdOf, hideToggle, type WorktreeRow } from '../lib/model.ts';
import { useDelayedFlag } from '../lib/useWait.ts';
import { waitText } from '../lib/wait.ts';
import { useCommandsContext } from '../state/commandsContext.tsx';
import { type CopyFn, copyAndReport } from '../state/copy.ts';
import { useAppModel } from '../state/model.tsx';
import { actions, useUi, useUiStore, type View } from '../state/ui.tsx';
import { ContextMenu, type MenuItem, useContextMenu } from './ContextMenu.tsx';
import { separated, worktreeCopyItems } from './copyMenu.ts';
import { useDesktopMenu } from './desktopMenu.ts';
import { useFolderStart } from './FolderBrowser.tsx';
import { Wordmark } from './Mark.tsx';
import { SidebarFilter } from './SidebarFilter.tsx';
import { type SidebarItem, SidebarList } from './SidebarList.tsx';
import { hideLabel, type RowEvent } from './SidebarRow.tsx';
import { FloatPill, FloatSlot, StaleNote } from './WaitNote.tsx';

/**
 * The sidebar (#13, DECISIONS #241): one flat list of the worktrees of every folder (filtered by
 * the picker above it), pinned first, then the most recent activity first. No Inbox entry, no
 * folder or project headers, no On review / Hidden split: a worktree that needs nothing simply has
 * no special state. Only what the user hid by hand ("Hide until it changes") sits in a "Hidden"
 * section at the end, closed by default. The list is virtualised (`SidebarList`): a few hundred
 * worktrees mount a window of rows, not thousands of DOM nodes. Status comes from a fixed source,
 * never from the toolbar scope, so switching the scope never moves a row.
 */

type MenuTarget = { kind: 'worktree'; row: WorktreeRow };

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
    <div className="flex h-9 items-end gap-1.5 px-1 pb-1">
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

export function Sidebar() {
  const store = useUiStore();
  const folderStart = useFolderStart();
  const model = useAppModel();
  const commands = useCommandsContext();
  const filterFolders = useUi((s) => s.filterFolders);
  const filterProjects = useUi((s) => s.filterProjects);
  const filterWorktrees = useUi((s) => s.filterWorktrees);
  const onlyDirty = useUi((s) => s.onlyDirty);
  const onlyUnreviewed = useUi((s) => s.onlyUnreviewed);
  const settledOpen = useUi((s) => s.settledOpen);
  const support = useSettingsSupport();
  const settings = useSettingsQuery();
  const setPolicy = useSetReviewPolicy();
  const menu = useContextMenu<MenuTarget>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const view = model.view;
  const selectedWorktree = view.kind === 'worktree' ? view.worktreeId : null;
  const onSelect = useCallback(
    (id: string) => actions.setView(store, { kind: 'worktree', worktreeId: id }),
    [store],
  );
  const totalWorktrees = model.sidebar.byId.size;
  const filtering =
    filterFolders.length > 0 ||
    filterProjects.length > 0 ||
    filterWorktrees.length > 0 ||
    onlyDirty ||
    onlyUnreviewed;
  // Filters open the Hidden section: a hit must never hide behind a closed one.
  const hiddenOpen = filtering || settledOpen;
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

  const onHide = useCallback(
    (row: WorktreeRow) => {
      const next = hideToggle(row);
      if (next === undefined || !row.summary) return;
      actions.setSettle(store, row.worktree.id, next, row.summary.stateHash);
    },
    [store],
  );
  // A stable callback keeps the memoised rows from re-rendering; `menu.open` is a fresh closure.
  const openMenu = useRef(menu.open);
  openMenu.current = menu.open;
  const onMenu = useCallback(
    (e: RowEvent, row: WorktreeRow) => openMenu.current(e, { kind: 'worktree', row }),
    [],
  );

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
  const desktopItems = useDesktopMenu();
  // The folder and project headers are gone; their Overviews open from the worktree's menu.
  const menuItems = (t: MenuTarget): MenuItem[] => {
    const { row } = t;
    const id = row.worktree.id;
    const branch = row.worktree.branch;
    const folderId = folderIdOf(row.project);
    const folder = sidebar.folderOptions.find((f) => f.id === folderId);
    return [
      goto({ kind: 'worktree', worktreeId: id }, 'Open changes'),
      {
        id: 'settle',
        label: row.stage === 'blocked' ? 'Hide (blocked)' : hideLabel(row),
        disabled: row.summary === null || row.stage === 'blocked',
        onSelect: () => onHide(row),
      },
      {
        id: 'pin',
        label: row.pinned ? 'Unpin' : 'Pin to the top',
        onSelect: () => actions.togglePinned(store, id),
      },
      goto({ kind: 'project', projectId: row.project.id }, `Overview of ${row.project.name}`),
      ...(folder
        ? [goto({ kind: 'folder', scanRootId: folderId }, `Overview of folder ${folder.label}`)]
        : []),
      ...bulkItems({ kind: 'worktree', worktreeId: id }, [id]).map((item, i) =>
        i === 0 ? { ...item, separator: true } : item,
      ),
      ...policyItems({ kind: 'worktree', worktreeId: id }, 'this worktree'),
      ...(branch
        ? policyItems({ kind: 'branch', projectId: row.project.id, branch }, `branch ${branch}`)
        : []),
      ...separated(worktreeCopyItems(row.worktree, copy, menu.state?.position)),
      ...desktopItems({ worktreeId: id, deleted: row.worktree.missing }),
    ];
  };

  // The list: the flat rows, then the Hidden header and, while it is open, its rows. A closed
  // section still shows the selected worktree, so J/K and palette jumps have a row to land on.
  const items = useMemo<SidebarItem[]>(() => {
    const out: SidebarItem[] = sidebar.flat.map((row) => ({ kind: 'row', section: 'flat', row }));
    if (sidebar.hidden.length > 0) {
      out.push({ kind: 'hiddenHeader', count: sidebar.hidden.length, open: hiddenOpen });
      for (const row of sidebar.hidden) {
        if (hiddenOpen || row.worktree.id === selectedWorktree) {
          out.push({ kind: 'row', section: 'hidden', row });
        }
      }
    }
    return out;
  }, [sidebar.flat, sidebar.hidden, hiddenOpen, selectedWorktree]);

  return (
    <nav
      data-testid={TEST_IDS.sidebar}
      aria-label="Worktrees"
      className="relative flex h-full min-h-0 flex-col border-r border-line bg-surface"
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

      <div
        ref={scrollRef}
        data-testid="sidebar-scroll"
        className="od-scroll min-h-0 flex-1 overflow-y-auto p-1.5"
      >
        {items.length === 0 && totalWorktrees > 0 && (
          <p className="px-2 py-3 text-xs text-muted">No worktrees match the filters.</p>
        )}
        {items.length > 0 && (
          <SidebarList
            items={items}
            scrollRef={scrollRef}
            selectedId={selectedWorktree}
            menuId={
              menu.state?.target.kind === 'worktree' ? menu.state.target.row.worktree.id : null
            }
            onSelect={onSelect}
            onMenu={onMenu}
            onHide={onHide}
            renderHeader={(header) => (
              <ShelfHeader
                label="Hidden"
                count={header.count}
                open={header.open}
                onToggle={() => actions.toggleSettledOpen(store)}
              />
            )}
          />
        )}
      </div>

      <SidebarStatus />
      {menu.state && (
        <ContextMenu
          items={menuItems(menu.state.target)}
          position={menu.state.position}
          onClose={menu.close}
          label="Actions"
        />
      )}
    </nav>
  );
}

/**
 * The sidebar's status slot (#11), floating over the foot of the list so nothing moves: which
 * forge the PR chips are waiting for, the daemon working out review states after a project was
 * opened, or, when forge data is old for a real reason, "Last updated 3 min ago · Refresh". A wait
 * is named only after `WAIT_NOTE_DELAY_MS`; the stale note is a state, so it is not delayed.
 */
function SidebarStatus() {
  const note = useSidebarNote();
  const waiting = useDelayedFlag(note.wait !== null) && note.wait !== null;
  const warn =
    note.wait?.kind === 'forge' &&
    (note.wait.budget?.state === 'backoff' || note.wait.budget?.state === 'low');
  return (
    <FloatSlot
      role="status"
      aria-live="polite"
      data-testid="sidebar-status"
      data-state={waiting ? 'waiting' : note.stale ? 'stale' : 'idle'}
    >
      {waiting && note.wait ? (
        <FloatPill className={warn ? 'text-warn' : ''}>{waitText(note.wait)}</FloatPill>
      ) : note.stale ? (
        <FloatPill>
          <StaleNote
            updatedAt={note.stale.updatedAt}
            reason={note.stale.reason}
            title={note.stale.detail ?? undefined}
            onRefresh={note.refresh}
            refreshing={note.refreshing}
          />
        </FloatPill>
      ) : null}
    </FloatSlot>
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
