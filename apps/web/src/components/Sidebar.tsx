import {
  type BulkReviewTarget,
  type ReviewPolicyTarget,
  reviewTargetKey,
  TEST_IDS,
} from '@octopus-diff/contracts';
import { memo, useEffect, useState } from 'react';
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
  type WorktreeRow,
  worktreeLabel,
} from '../lib/model.ts';
import { isRecentlyActive, worktreeSource } from '../lib/source.ts';
import { useCommandsContext } from '../state/commandsContext.tsx';
import { useAppModel } from '../state/model.tsx';
import { actions, useUi, useUiStore, type View } from '../state/ui.tsx';
import { Dot, MoreIcon, ToggleButton } from './bits.tsx';
import { ContextMenu, type MenuItem, useContextMenu } from './ContextMenu.tsx';
import { Wordmark } from './Mark.tsx';

function attr(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
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

const WorktreeItem = memo(function WorktreeItem({
  row,
  selected,
  now,
  onSelect,
  onMenu,
}: {
  row: WorktreeRow;
  selected: boolean;
  now: number;
  onSelect: (id: string) => void;
  onMenu: (event: React.MouseEvent | React.KeyboardEvent, row: WorktreeRow) => void;
}) {
  const { worktree, summary, error } = row;
  const dirty = isDirtySummary(summary);
  const counts = summary?.counts;
  const source = worktree.isMain ? null : worktreeSource(worktree.path);
  const active = isRecentlyActive(summary?.updatedAt, now);
  const title = `${worktree.path}${summary?.aheadBehindRef ? `\nahead/behind ${summary.aheadBehindRef}` : ''}`;
  return (
    <li className="group/wt relative">
      <button
        type="button"
        data-testid={TEST_IDS.worktreeItem}
        data-worktree-id={worktree.id}
        data-project-id={worktree.projectId}
        data-branch={worktree.branch ?? ''}
        data-dirty={String(dirty)}
        data-ahead={attr(summary?.ahead)}
        data-behind={attr(summary?.behind)}
        data-staged={attr(counts?.staged ?? 0)}
        data-unstaged={attr(counts?.unstaged ?? 0)}
        data-untracked={attr(counts?.untracked ?? 0)}
        data-conflicted={attr(counts?.conflicted ?? 0)}
        data-additions={attr(summary?.additions ?? 0)}
        data-deletions={attr(summary?.deletions ?? 0)}
        data-main={String(worktree.isMain)}
        data-source={source?.id ?? ''}
        data-active={String(active)}
        aria-current={selected ? 'true' : undefined}
        title={title}
        onClick={() => onSelect(worktree.id)}
        onContextMenu={(e) => onMenu(e, row)}
        className={`flex w-full flex-col gap-0.5 rounded-sm py-1 pr-6 pl-[var(--od-pad-x)] text-left ${
          selected ? 'bg-selected' : 'hover:bg-hover'
        } ${row.review.enabled ? '' : 'text-muted'}`}
      >
        <span className="flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${dirty ? 'bg-mod' : 'bg-line-strong'} ${
              active ? 'od-pulse' : ''
            }`}
            aria-hidden="true"
          />
          <span
            className={`min-w-0 truncate ${worktree.branch ? '' : 'italic text-muted'} ${
              worktree.isMain ? 'font-medium' : ''
            }`}
          >
            {worktreeLabel(worktree)}
          </span>
          {worktree.isMain && (
            <span
              className="rounded-sm border border-line px-1 text-[10px] text-faint"
              title="Main checkout"
            >
              main
            </span>
          )}
          {source && (
            <span
              className="rounded-sm bg-raised px-1 font-mono text-[10px] text-muted"
              title={source.title}
            >
              {source.label}
            </span>
          )}
          {summary?.inProgress && (
            <span className="rounded-sm bg-raised px-1 text-[10px] text-warn">
              {summary.inProgress}
            </span>
          )}
          {!row.review.enabled && (
            <span
              data-testid={TEST_IDS.reviewOffBadge}
              data-source={row.review.source}
              className="ml-auto shrink-0 rounded-sm border border-line px-1 text-[10px] whitespace-nowrap text-faint"
              title={`Review off (from ${row.review.source})`}
            >
              review off
            </span>
          )}
          {row.unreviewed > 0 && (
            <span
              className="ml-auto rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-fg"
              title={`${row.unreviewed} unreviewed`}
            >
              {row.unreviewed}
            </span>
          )}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 pl-3 font-mono text-[10.5px] text-muted">
          {summary && summary.ahead !== null && summary.behind !== null && (
            <span title={`ahead/behind ${summary.aheadBehindRef ?? ''}`}>
              ↑{summary.ahead} ↓{summary.behind}
            </span>
          )}
          {counts && counts.staged > 0 && <span title="staged">S{counts.staged}</span>}
          {counts && counts.unstaged > 0 && <span title="unstaged">M{counts.unstaged}</span>}
          {counts && counts.untracked > 0 && <span title="untracked">?{counts.untracked}</span>}
          {counts && counts.conflicted > 0 && (
            <span className="text-danger" title="conflicted">
              !{counts.conflicted}
            </span>
          )}
          {summary && (summary.additions > 0 || summary.deletions > 0) && (
            <span>
              <span className="text-add">+{summary.additions}</span>{' '}
              <span className="text-del">−{summary.deletions}</span>
            </span>
          )}
          {summary && !dirty && <span className="text-faint">clean</span>}
          {worktree.missing && <span className="text-danger">missing</span>}
          {worktree.locked && <span className="text-faint">locked</span>}
          {error && (
            <span className="truncate text-danger" title={error.message}>
              error: {error.message}
            </span>
          )}
          {!summary && !error && !worktree.missing && <span className="text-faint">…</span>}
        </span>
      </button>
      <MoreButton
        label={`Actions for ${worktreeLabel(worktree)}`}
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

function StatsBadges({
  dirty,
  unreviewed,
  repos,
}: {
  dirty: number;
  unreviewed: number;
  repos?: number;
}) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10px] text-faint">
      {repos !== undefined && <span title={`${repos} repositories`}>{repos}</span>}
      {dirty > 0 && (
        <span
          className="inline-flex items-center gap-0.5 text-mod"
          title={`${dirty} dirty worktrees`}
        >
          <Dot />
          {dirty}
        </span>
      )}
      {unreviewed > 0 && (
        <span
          className="rounded-full bg-accent px-1.5 font-sans font-semibold text-accent-fg"
          title={`${unreviewed} unreviewed`}
        >
          {unreviewed}
        </span>
      )}
    </span>
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
  const overrides = new Map(
    (settings.data?.overrides ?? []).map((o) => [reviewTargetKey(o.target), o.enabled]),
  );

  const policyItems = (target: ReviewPolicyTarget | null, label: string): MenuItem[] => {
    if (support !== 'ready' || !target) return [];
    const key = reviewTargetKey(target);
    const state = overrides.has(key) ? (overrides.get(key) ? 'on' : 'off') : 'inherit';
    return [
      {
        id: 'policy-h',
        heading: true,
        // The heading style is upper case; a project or branch name keeps its own case.
        label: (
          <>
            Review for <span className="tracking-normal normal-case">{label}</span>
          </>
        ),
      },
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
          ...bulkItems({ kind: 'worktree', worktreeId: id }, [id]),
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

  return (
    <nav
      data-testid={TEST_IDS.sidebar}
      aria-label="Folders, projects and worktrees"
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
          className="rounded-sm px-1 py-0.5 text-muted hover:bg-hover hover:text-fg"
        >
          <GearIcon />
        </button>
      </div>
      <div className="flex flex-col gap-1.5 border-b border-line p-2">
        <input
          data-testid={TEST_IDS.sidebarFilter}
          data-filter-input=""
          type="search"
          placeholder="Filter worktrees  ( / )"
          aria-label="Filter projects and worktrees"
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
          className="w-full rounded-md border border-line bg-canvas px-2 py-1 text-xs placeholder:text-faint focus:border-line-strong"
        />
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
          className={`mb-1 flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-semibold ${
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
          <span className="ml-auto rounded-full bg-raised px-1.5 text-[11px] font-normal text-muted">
            {inboxCount}
          </span>
        </button>

        {model.sidebar.groups.length === 0 && totalWorktrees > 0 && (
          <p className="px-2 py-3 text-xs text-muted">No worktrees match the filters.</p>
        )}

        <ul className="flex flex-col gap-1">
          {model.sidebar.folders.map((node) => {
            const open = !isCollapsed(node.id);
            const current = view.kind === 'folder' && view.scanRootId === node.id;
            return (
              <li key={node.id} data-folder-id={node.id}>
                <div
                  className={`group/folder relative flex items-center gap-1 rounded-sm pr-6 ${current ? 'bg-selected' : 'hover:bg-hover'}`}
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
                    onClick={() => actions.setView(store, { kind: 'folder', scanRootId: node.id })}
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
                    <StatsBadges
                      repos={node.stats.projects}
                      dirty={node.stats.dirty}
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
                      const pOpen = !isCollapsed(group.project.id);
                      const pCurrent =
                        view.kind === 'project' && view.projectId === group.project.id;
                      const stats = {
                        dirty: group.allRows.filter((r) => isDirtySummary(r.summary)).length,
                        unreviewed: group.allRows.reduce((n, r) => n + r.unreviewed, 0),
                      };
                      return (
                        <li
                          key={group.project.id}
                          data-testid={TEST_IDS.projectItem}
                          data-project-id={group.project.id}
                          data-project-name={group.project.name}
                        >
                          <div
                            className={`group/proj relative flex items-center gap-1 rounded-sm pr-6 ${pCurrent ? 'bg-selected' : 'hover:bg-hover'}`}
                          >
                            <button
                              type="button"
                              aria-label={pOpen ? 'Collapse project' : 'Expand project'}
                              aria-expanded={pOpen}
                              onClick={() => actions.toggleCollapsed(store, group.project.id)}
                              className="rounded-sm p-1"
                            >
                              <Chevron open={pOpen} />
                            </button>
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
                              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left font-semibold"
                            >
                              <span className="truncate">{group.project.name}</span>
                              <StatsBadges dirty={stats.dirty} unreviewed={stats.unreviewed} />
                            </button>
                            <MoreButton
                              label={`Actions for ${group.project.name}`}
                              group="proj"
                              onOpen={(e) => menu.open(e, { kind: 'project', group })}
                            />
                          </div>
                          {pOpen && (
                            <ul
                              aria-label={`${group.project.name} worktrees`}
                              className="flex flex-col"
                            >
                              {group.rows.map((row) => (
                                <WorktreeItem
                                  key={row.worktree.id}
                                  row={row}
                                  now={now}
                                  selected={selectedWorktree === row.worktree.id}
                                  onSelect={onSelect}
                                  onMenu={(e, r) => menu.open(e, { kind: 'worktree', row: r })}
                                />
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="border-t border-line p-2">
        <button
          type="button"
          data-testid={TEST_IDS.addProjectButton}
          onClick={() => store.setState({ addProjectOpen: true })}
          className="w-full rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
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
