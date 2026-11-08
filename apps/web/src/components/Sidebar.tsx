import { TEST_IDS } from '@octopus-diff/contracts';
import { memo } from 'react';
import { isDirtySummary, type WorktreeRow, worktreeLabel } from '../lib/model.ts';
import { useAppModel } from '../state/model.tsx';
import { actions, useUi, useUiStore } from '../state/ui.tsx';
import { ToggleButton } from './bits.tsx';

function attr(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

const WorktreeItem = memo(function WorktreeItem({
  row,
  selected,
  onSelect,
}: {
  row: WorktreeRow;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { worktree, summary, error } = row;
  const dirty = isDirtySummary(summary);
  const counts = summary?.counts;
  const title = `${worktree.path}${summary?.aheadBehindRef ? `\nahead/behind ${summary.aheadBehindRef}` : ''}`;
  return (
    <li>
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
        aria-current={selected ? 'true' : undefined}
        title={title}
        onClick={() => onSelect(worktree.id)}
        className={`flex w-full flex-col gap-0.5 rounded px-2 py-1 text-left ${
          selected ? 'bg-selected' : 'hover:bg-hover'
        }`}
      >
        <span className="flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${dirty ? 'bg-mod' : 'bg-line'}`}
            aria-hidden="true"
          />
          <span className={`truncate ${worktree.branch ? '' : 'italic text-muted'}`}>
            {worktreeLabel(worktree)}
          </span>
          {worktree.isMain && <span className="text-[10px] text-faint">main</span>}
          {summary?.inProgress && (
            <span className="rounded bg-raised px-1 text-[10px] text-warn">
              {summary.inProgress}
            </span>
          )}
          {!row.review.enabled && (
            <span
              data-testid={TEST_IDS.reviewOffBadge}
              data-source={row.review.source}
              className="ml-auto rounded-sm border border-line px-1 text-[10px] text-faint"
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
    </li>
  );
});

export function Sidebar() {
  const store = useUiStore();
  const model = useAppModel();
  const filterText = useUi((s) => s.filterText);
  const onlyDirty = useUi((s) => s.onlyDirty);
  const onlyUnreviewed = useUi((s) => s.onlyUnreviewed);
  const view = model.view;
  const selectedWorktree = view.kind === 'worktree' ? view.worktreeId : null;
  const inboxCount = model.inboxEntries.length;
  const onSelect = (id: string) => actions.setView(store, { kind: 'worktree', worktreeId: id });
  const totalWorktrees = model.sidebar.byId.size;

  return (
    <nav
      data-testid={TEST_IDS.sidebar}
      aria-label="Projects and worktrees"
      className="flex h-full min-h-0 flex-col border-r border-line bg-surface"
    >
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
          className="w-full rounded border border-line bg-canvas px-2 py-1 text-xs placeholder:text-faint"
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
          className={`mb-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-semibold ${
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
          {model.sidebar.groups.map((group) => (
            <li
              key={group.project.id}
              data-testid={TEST_IDS.projectItem}
              data-project-id={group.project.id}
              data-project-name={group.project.name}
            >
              <div
                className="flex items-center gap-1 px-2 pt-2 pb-0.5 text-[11px] font-semibold tracking-wide text-muted uppercase"
                title={group.project.mainWorktreePath ?? group.project.commonDir}
              >
                <span className="truncate">{group.project.name}</span>
              </div>
              <ul aria-label={`${group.project.name} worktrees`} className="flex flex-col">
                {group.rows.map((row) => (
                  <WorktreeItem
                    key={row.worktree.id}
                    row={row}
                    selected={selectedWorktree === row.worktree.id}
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-line p-2">
        <button
          type="button"
          data-testid={TEST_IDS.addProjectButton}
          onClick={() => store.setState({ addProjectOpen: true })}
          className="w-full rounded border border-line px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
        >
          + Add project or scan folder
        </button>
      </div>
    </nav>
  );
}
