import { TEST_IDS } from '@octopus-diff/contracts';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { fuzzyMatch } from '../lib/fuzzy.ts';
import { compareByActivity, type WorktreeRow, worktreeLabel } from '../lib/model.ts';
import { useAppModel } from '../state/model.tsx';
import { useUi, useUiStore } from '../state/ui.tsx';
import { CheckIcon } from './bits.tsx';

interface FilterOption {
  id: string;
  group: 'Status' | 'Folders' | 'Projects' | 'Worktrees';
  label: string;
  /** Faint text after the label (a project's worktree count, a worktree's project). */
  hint?: string;
  /** What the search matches. */
  text: string;
  selected: boolean;
  toggle: () => void;
  testId: string;
  data?: Record<string, string>;
}

function toggled(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/**
 * The sidebar filter: a trigger that says what is filtered, and a dropdown with a search field
 * over the status options, the folders, the projects and the worktrees (multi-select, a listbox; DECISIONS
 * "Sidebar filter dropdown"). Picked folders, projects and worktrees are one union; status narrows it.
 * Keyboard: `/` opens it, arrows move, Enter toggles, Escape clears the search, then closes.
 */
export function SidebarFilter() {
  const store = useUiStore();
  const open = useUi((s) => s.filterOpen);
  const folders = useUi((s) => s.filterFolders);
  const projects = useUi((s) => s.filterProjects);
  const worktrees = useUi((s) => s.filterWorktrees);
  const onlyDirty = useUi((s) => s.onlyDirty);
  const onlyUnreviewed = useUi((s) => s.onlyUnreviewed);
  const { sidebar } = useAppModel();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const rows = useMemo(() => [...sidebar.byId.values()], [sidebar.byId]);
  const projectRows = useMemo(() => {
    const out = new Map<string, { name: string; rows: WorktreeRow[] }>();
    for (const row of rows) {
      const entry = out.get(row.project.id) ?? { name: row.project.name, rows: [] };
      entry.rows.push(row);
      out.set(row.project.id, entry);
    }
    return out;
  }, [rows]);

  const all: FilterOption[] = [
    {
      id: 'status-dirty',
      group: 'Status',
      label: 'Only dirty',
      text: 'only dirty changes',
      selected: onlyDirty,
      toggle: () => store.setState({ onlyDirty: !onlyDirty }),
      testId: TEST_IDS.onlyDirtyToggle,
    },
    {
      id: 'status-unreviewed',
      group: 'Status',
      label: 'Only unreviewed',
      text: 'only unreviewed review',
      selected: onlyUnreviewed,
      toggle: () => store.setState({ onlyUnreviewed: !onlyUnreviewed }),
      testId: TEST_IDS.onlyUnreviewedToggle,
    },
    ...sidebar.folderOptions.map<FilterOption>((f) => ({
      id: `folder-${f.id}`,
      group: 'Folders',
      label: f.label,
      hint: String(f.worktrees),
      text: f.label,
      selected: folders.includes(f.id),
      toggle: () => store.setState((s) => ({ filterFolders: toggled(s.filterFolders, f.id) })),
      testId: TEST_IDS.sidebarFilterOption,
      data: { 'data-kind': 'folder', 'data-folder-id': f.id },
    })),
    ...[...projectRows].map<FilterOption>(([id, p]) => ({
      id: `project-${id}`,
      group: 'Projects',
      label: p.name,
      hint: String(p.rows.length),
      text: p.name,
      selected: projects.includes(id),
      toggle: () => store.setState((s) => ({ filterProjects: toggled(s.filterProjects, id) })),
      testId: TEST_IDS.sidebarFilterOption,
      data: { 'data-kind': 'project', 'data-project-id': id },
    })),
    // Across projects, most recent activity first (like the rows inside each sidebar project).
    ...[...rows].sort(compareByActivity).map<FilterOption>((row) => {
      const id = row.worktree.id;
      const label = worktreeLabel(row.worktree);
      return {
        id: `worktree-${id}`,
        group: 'Worktrees',
        label,
        hint: row.project.name,
        text: `${label} ${row.project.name}`,
        selected: worktrees.includes(id),
        toggle: () => store.setState((s) => ({ filterWorktrees: toggled(s.filterWorktrees, id) })),
        testId: TEST_IDS.sidebarFilterOption,
        data: { 'data-kind': 'worktree', 'data-worktree-id': id },
      };
    }),
  ];

  const q = query.trim();
  // Groups keep their order; inside a group the best matches come first while searching.
  const options = q
    ? (['Status', 'Folders', 'Projects', 'Worktrees'] as const).flatMap((group) =>
        all
          .filter((o) => o.group === group)
          .map((o) => ({ o, m: fuzzyMatch(q, o.text) }))
          .filter((x) => x.m !== null)
          .sort((a, b) => (b.m?.score ?? 0) - (a.m?.score ?? 0))
          .map((x) => x.o),
      )
    : all;
  const current = Math.min(active, Math.max(0, options.length - 1));

  // Known names only: an id whose project or worktree is gone does not filter anything visible.
  const parts = [
    ...folders.flatMap((id) => sidebar.folderOptions.find((f) => f.id === id)?.label ?? []),
    ...projects.flatMap((id) => projectRows.get(id)?.name ?? []),
    ...worktrees.flatMap((id) => {
      const row = sidebar.byId.get(id);
      return row ? worktreeLabel(row.worktree) : [];
    }),
    ...(onlyDirty ? ['dirty'] : []),
    ...(onlyUnreviewed ? ['unreviewed'] : []),
  ];
  const filtering =
    folders.length + projects.length + worktrees.length > 0 || onlyDirty || onlyUnreviewed;
  const summary =
    parts.length === 0
      ? filtering
        ? 'Filtered'
        : 'All worktrees'
      : parts.length <= 2
        ? parts.join(', ')
        : `${parts.slice(0, 2).join(', ')} +${parts.length - 2}`;

  const close = (refocus: boolean) => {
    store.setState({ filterOpen: false });
    setQuery('');
    setActive(0);
    if (refocus) triggerRef.current?.focus();
  };
  const clear = () =>
    store.setState({
      filterFolders: [],
      filterProjects: [],
      filterWorktrees: [],
      onlyDirty: false,
      onlyUnreviewed: false,
    });

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) store.setState({ filterOpen: false });
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, store]);

  // Reset the search whenever the dropdown closes (outside click, Tab away, `/` toggling).
  useEffect(() => {
    if (!open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  // Keep the active option in view while moving with the arrows.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${current}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, current, listId]);

  let lastGroup: string | null = null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: focus leaving the filter closes its dropdown
    <div
      ref={rootRef}
      className="relative"
      onBlur={(e) => {
        if (open && !rootRef.current?.contains(e.relatedTarget as Node | null)) {
          store.setState({ filterOpen: false });
        }
      }}
    >
      <div className="flex items-center gap-1">
        <button
          ref={triggerRef}
          type="button"
          data-testid={TEST_IDS.sidebarFilter}
          data-filtering={String(filtering)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-keyshortcuts="/"
          aria-label={`Filter worktrees: ${summary}`}
          title="Filter by status, folder, project or worktree (/)"
          onClick={() => (open ? close(false) : store.setState({ filterOpen: true }))}
          className="od-input flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <FunnelIcon active={filtering} />
          <span className={`min-w-0 flex-1 truncate ${filtering ? 'text-fg' : 'text-faint'}`}>
            {summary}
          </span>
          {!filtering && <kbd className="shrink-0 text-faint">/</kbd>}
          <ChevronDown />
        </button>
        {filtering && (
          <button
            type="button"
            data-testid={TEST_IDS.sidebarFilterClear}
            onClick={clear}
            title="Clear filters"
            aria-label="Clear filters"
            className="od-btn od-btn-ghost"
          >
            <ClearIcon />
          </button>
        )}
      </div>

      {open && (
        <div className="od-overlay od-fade-in absolute top-full right-0 left-0 z-40 mt-1 flex flex-col rounded-md p-1 text-xs">
          <input
            ref={searchRef}
            data-testid={TEST_IDS.sidebarFilterSearch}
            data-filter-input=""
            type="search"
            name="filter"
            autoComplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={options.length > 0 ? `${listId}-${current}` : undefined}
            aria-label="Search folders, projects and worktrees"
            placeholder="Search by name"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (options.length === 0) return;
                const delta = e.key === 'ArrowDown' ? 1 : -1;
                setActive((current + delta + options.length) % options.length);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                options[current]?.toggle();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                if (query) {
                  setQuery('');
                  setActive(0);
                } else close(true);
              }
            }}
            className="od-input mb-1 w-full"
          />
          <div
            id={listId}
            role="listbox"
            aria-multiselectable="true"
            aria-label="Filter options"
            className="od-scroll max-h-[min(60vh,420px)] overflow-y-auto"
          >
            {options.map((o, i) => {
              const heading = o.group !== lastGroup;
              lastGroup = o.group;
              return [
                heading && (
                  <div
                    key={`h-${o.group}`}
                    role="presentation"
                    className="od-label px-2 pt-2 pb-1 first:pt-1"
                  >
                    {o.group}
                  </div>
                ),
                // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by the combobox
                <div
                  key={o.id}
                  id={`${listId}-${i}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={o.selected}
                  data-testid={o.testId}
                  {...o.data}
                  // Keep the focus in the search field so typing and arrows keep working.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => i !== current && setActive(i)}
                  onClick={() => {
                    setActive(i);
                    o.toggle();
                  }}
                  className={`flex cursor-default items-center gap-2 rounded-sm px-2 py-1 ${
                    i === current ? 'bg-hover' : ''
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border ${
                      o.selected ? 'border-fg bg-fg text-surface' : 'border-line'
                    }`}
                  >
                    {o.selected && <CheckIcon className="size-2.5" />}
                  </span>
                  <span
                    className={`min-w-0 truncate ${o.group === 'Worktrees' ? 'font-mono' : ''}`}
                  >
                    {o.label}
                  </span>
                  {o.hint && (
                    <span className="ml-auto shrink-0 truncate pl-2 text-[11px] text-faint">
                      {o.hint}
                    </span>
                  )}
                </div>,
              ];
            })}
            {options.length === 0 && (
              <p className="px-2 py-2 text-faint">No folder, project or worktree matches “{q}”.</p>
            )}
          </div>
          {filtering && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={clear}
              className="mt-1 rounded-sm border-t border-line px-2 pt-1.5 pb-1 text-left text-muted hover:bg-hover hover:text-fg"
            >
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FunnelIcon({ active }: { active: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      className={`shrink-0 ${active ? 'text-fg' : 'text-muted'}`}
    >
      <path
        d="M2 3h12l-4.5 5.5V13l-3-1.5v-3z"
        fill={active ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="10"
      height="10"
      aria-hidden="true"
      className="shrink-0 text-faint"
    >
      <path
        d="M4 6l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M4 4l8 8M12 4l-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
