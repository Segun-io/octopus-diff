import {
  type AddProjectResponse,
  type AddScanRootResponse,
  type ApiClient,
  type DirEntry,
  type DirsResponse,
  SCAN_DEPTH_DEFAULT,
  TEST_IDS,
} from '@octopus-diff/contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeError, queryKeys, useApi, useProjectsQuery } from '../api/queries.ts';
import { useScanRootsQuery } from '../api/settings.ts';
import {
  appendSegment,
  countRepos,
  displayPath,
  filterEntries,
  folderText,
  isForeignWindowsPath,
  nextFolderText,
  resolveRelative,
  resolveTarget,
  splitLocation,
  startText,
  type Target,
  tabCompletion,
} from '../lib/folderPath.ts';
import type { AddJob } from '../state/addJob.ts';
import { type UiState, type UiStore, useUi, useUiStore } from '../state/ui.tsx';
import { CornerLeftUpIcon, FolderIcon, RepoIcon } from './bits.tsx';

/*
 * The folder browser shared by the add dialog, Settings → Folders and the command palette's
 * browse mode (DECISIONS: folder picker). Modelled on T3 Code's command-palette browse mode
 * (github.com/pingdotgg/t3code, MIT): the text is the browser, the next listing loads before the
 * view switches, listings live 5 s, and focus never leaves the text box.
 */

/** Listings go stale fast (agents create worktrees); keep one only long enough to navigate. */
const DIRS_GC_MS = 5_000;

export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl';

export function dirsQueryOptions(api: ApiClient, path: string) {
  return {
    queryKey: queryKeys.dirs(path),
    queryFn: () => api.listDirs(path ? { path } : {}),
    staleTime: 0,
    gcTime: DIRS_GC_MS,
    retry: false,
  };
}

/**
 * The absolute path relative text (`./`, `../`) is resolved against: the worktree in view, as T3
 * Code resolves it against the active project. Null: the daemon resolves it against its folder.
 */
function useRelativeBase(): string | null {
  const view = useUi((s) => s.view);
  const projects = useProjectsQuery();
  return useMemo(() => {
    for (const { project, worktrees } of projects.data?.projects ?? []) {
      if (view.kind === 'project' && project.id === view.projectId) {
        return project.mainWorktreePath ?? worktrees[0]?.worktree.path ?? null;
      }
      if (view.kind === 'worktree') {
        const hit = worktrees.find((w) => w.worktree.id === view.worktreeId);
        if (hit) return hit.worktree.path;
      }
    }
    return null;
  }, [view, projects.data]);
}

/** The listing key for a location text (what is sent to the daemon). */
function listedDir(text: string, base: string | null, sep: string): string {
  return resolveRelative(splitLocation(text).dir, base, sep);
}

/** The start folder's location text, and a way to load its listing before showing the picker. */
export function useFolderStart(): { text: string; prefetch: () => Promise<string> } {
  const api = useApi();
  const queryClient = useQueryClient();
  const base = useRelativeBase();
  const text = startText(useUi((s) => s.folderStart));
  const prefetch = useCallback(async () => {
    await queryClient.prefetchQuery(dirsQueryOptions(api, listedDir(text, base, '/')));
    return text;
  }, [api, queryClient, base, text]);
  return { text, prefetch };
}

export type Row = { type: 'up'; path: string } | { type: 'entry'; entry: DirEntry };

/** Where an already added repository lives in the UI. */
export type OpenTarget = Extract<UiState['view'], { kind: 'project' | 'worktree' }>;

export interface FolderBrowserOptions {
  text: string;
  setText: (text: string) => void;
  /** False: no listing is loaded (the palette, while the text is a search). */
  enabled?: boolean;
  depth?: number;
  /** Given: an already added repository opens instead, and adding one opens it. */
  onOpen?: (target: OpenTarget) => void;
  onWatched?: (res: AddScanRootResponse, shown: string) => void;
}

let jobCounter = 0;

/** Starts a new add job (replacing any previous one). */
type NewJob =
  | Omit<Extract<AddJob, { kind: 'repo' }>, 'id' | 'state'>
  | Omit<Extract<AddJob, { kind: 'folder' }>, 'id' | 'state'>;

function startJob(store: UiStore, job: NewJob) {
  jobCounter += 1;
  const id = jobCounter;
  store.setState({ addJob: { ...job, id, state: 'working' } as AddJob });
  return id;
}

/** Updates the add job `id`, if it is still the current one. */
function updateJob(store: UiStore, id: number, patch: Partial<AddJob>) {
  store.setState((s) =>
    s.addJob && s.addJob.id === id ? { addJob: { ...s.addJob, ...patch } as AddJob } : {},
  );
}

export function useFolderBrowser({
  text,
  setText,
  enabled = true,
  depth = SCAN_DEPTH_DEFAULT,
  onOpen,
  onWatched,
}: FolderBrowserOptions) {
  const api = useApi();
  const store = useUiStore();
  const queryClient = useQueryClient();
  const projects = useProjectsQuery();
  const scanRoots = useScanRootsQuery();
  const base = useRelativeBase();
  const [active, setActive] = useState(-1);
  const navGeneration = useRef(0);
  const sepRef = useRef('/');

  const { dir, partial } = splitLocation(text);
  const queryDir = listedDir(text, base, sepRef.current);
  const listing = useQuery({
    ...dirsQueryOptions(api, queryDir),
    enabled,
    placeholderData: keepPreviousData,
  });
  /** The listing of the folder in the text (not the previous one kept while loading). */
  const current: DirsResponse | undefined =
    enabled && !listing.isPlaceholderData ? listing.data : undefined;
  const shown = enabled ? listing.data : undefined;
  if (shown) sepRef.current = shown.sep;
  const sep = sepRef.current;
  const missing = enabled && !listing.isPlaceholderData && listing.isError;
  const foreign = isForeignWindowsPath(text, sep);

  /** Added worktree paths → where to open them. */
  const registered = useMemo(() => {
    const map = new Map<string, OpenTarget>();
    for (const { project, worktrees } of projects.data?.projects ?? []) {
      for (const { worktree } of worktrees) {
        map.set(worktree.path, { kind: 'worktree', worktreeId: worktree.id });
      }
      if (project.mainWorktreePath && !map.has(project.mainWorktreePath)) {
        map.set(project.mainWorktreePath, { kind: 'project', projectId: project.id });
      }
    }
    return map;
  }, [projects.data]);
  const watched = useMemo(
    () => new Set((scanRoots.data?.scanRoots ?? []).map((r) => r.path)),
    [scanRoots.data],
  );

  const entries = shown ? filterEntries(shown.entries, partial) : [];
  const hiddenCount =
    shown && !partial.startsWith('.') ? shown.entries.filter((e) => e.hidden).length : 0;
  const rows: Row[] = [
    ...(shown?.parent ? [{ type: 'up' as const, path: shown.parent }] : []),
    ...entries.map((entry) => ({ type: 'entry' as const, entry })),
  ];
  const activeRow = active >= 0 ? rows[active] : undefined;
  const rawTarget = resolveTarget(text, current);
  const target: Target | null =
    rawTarget && rawTarget.kind === null
      ? { ...rawTarget, path: resolveRelative(rawTarget.path, base, sep) }
      : rawTarget;
  const show = (abs: string) => (shown ? displayPath(abs, shown.home, shown.sep) : abs);
  const openTarget = target ? registered.get(target.path) : undefined;

  // Keep the highlight valid as rows change.
  useEffect(() => {
    if (active >= rows.length) setActive(rows.length - 1);
  }, [active, rows.length]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.scanRoots() }),
    ]);

  const addProject = useMutation({
    mutationFn: ({ path }: { path: string; job: number }) => api.addProject({ path }),
    onError: (error, { job }) => {
      updateJob(store, job, { state: 'error', error: describeError(error).detail });
    },
    onSuccess: async (res: AddProjectResponse, { job }) => {
      await refresh();
      updateJob(store, job, {
        state: 'done',
        projectId: res.project.project.id,
        name: res.project.project.name,
        created: res.created,
        worktrees: res.project.worktrees.length,
      });
      if (onOpen) onOpen({ kind: 'project', projectId: res.project.project.id });
    },
  });
  const addScanRoot = useMutation({
    mutationFn: ({ path }: { path: string; job: number }) => api.addScanRoot({ path, depth }),
    onError: (error, { job }) => {
      updateJob(store, job, { state: 'error', error: describeError(error).detail });
    },
    onSuccess: async (res: AddScanRootResponse, { job }) => {
      const where = show(res.scanRoot.path);
      // The job's scan is done once lastScannedAt moves (components/AddJobStatus.tsx).
      updateJob(store, job, {
        path: where,
        scanRootId: res.scanRoot.id,
        created: res.created,
        scannedBefore: res.scanRoot.lastScannedAt,
      });
      store.setState((s) => ({
        scanFollows: [
          ...s.scanFollows.filter((f) => f.scanRootId !== res.scanRoot.id),
          {
            scanRootId: res.scanRoot.id,
            scannedBefore: res.scanRoot.lastScannedAt,
            since: Date.now(),
          },
        ],
      }));
      await refresh();
      onWatched?.(res, where);
    },
  });
  const runAddProject = (path: string) => {
    const job = startJob(store, { kind: 'repo', path: show(path) });
    addProject.mutate({ path, job });
  };
  const runAddScanRoot = (path: string) => {
    // Progress events from now on belong to this scan (or to another folder's, by id).
    store.setState({ scan: null });
    const job = startJob(store, { kind: 'folder', path: show(path), depth });
    addScanRoot.mutate({ path, job });
  };
  const pending = addProject.isPending || addScanRoot.isPending;
  const error = addProject.error ?? addScanRoot.error;
  // A folder that cannot be listed (missing, unreadable) cannot be added or watched either.
  const canSubmit = target !== null && target.exists !== false && !missing && !foreign && !pending;
  const primary: 'add' | 'watch' | 'open' =
    openTarget && onOpen ? 'open' : target?.kind === 'dir' ? 'watch' : 'add';

  const resetFeedback = () => {
    addProject.reset();
    addScanRoot.reset();
    // A finished job's message goes away once the user moves on; a running one stays.
    store.setState((s) => (s.addJob && s.addJob.state !== 'working' ? { addJob: null } : {}));
  };

  /** Loads the next listing first, then switches (no empty flash); a newer action wins. */
  const navigate = async (nextText: string) => {
    resetFeedback();
    const generation = ++navGeneration.current;
    await queryClient.prefetchQuery(dirsQueryOptions(api, listedDir(nextText, base, sep)));
    if (generation !== navGeneration.current) return;
    setText(nextText);
    setActive(-1);
  };
  const goTo = (abs: string) => {
    if (shown) void navigate(folderText(abs, shown.home, shown.sep));
  };
  const activate = (row: Row) => {
    if (row.type === 'up') goTo(row.path);
    else void navigate(appendSegment(text, row.entry.name));
  };
  const submit = (kind: 'add' | 'watch' | 'open') => {
    if (!target || !canSubmit) return;
    resetFeedback();
    if (kind === 'open' && openTarget && onOpen) onOpen(openTarget);
    else if (kind === 'watch') runAddScanRoot(target.path);
    else runAddProject(target.path);
  };
  const addEntry = (entry: DirEntry) => {
    resetFeedback();
    const open = registered.get(entry.path);
    if (open && onOpen) onOpen(open);
    else runAddProject(entry.path);
  };
  const change = (next: string) => {
    navGeneration.current++; // typing beats an in-flight navigation
    setText(nextFolderText(text, next, sep));
    setActive(-1);
    resetFeedback();
  };

  /** Keyboard handling for the text box; true when the key was used. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): boolean => {
    // Enter / Tab that confirm an IME composition belong to typing.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return e.key === 'Enter';
    const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(-1, i - 1));
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (activeRow && !mod) activate(activeRow);
      else submit(primary);
      return true;
    }
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (activeRow) {
        e.preventDefault();
        activate(activeRow);
        return true;
      }
      const completion = current ? tabCompletion(entries, partial) : null;
      if (!completion) return false; // let Tab move focus
      e.preventDefault();
      if (completion.complete) void navigate(appendSegment(text, completion.name));
      else {
        setText(dir + completion.name);
        setActive(-1);
      }
      return true;
    }
    return false;
  };

  const status = (() => {
    if (foreign) {
      return 'Windows paths work only when the daemon runs on Windows. Under WSL, drives are at /mnt/c/….';
    }
    if (missing) return describeError(listing.error).detail;
    if (!target) return 'Type a path or pick a folder below.';
    if (target.exists === false) {
      return `No folder named “${partial}” in ${current ? show(current.path) : dir}.`;
    }
    if (target.kind === null) return '';
    const where = show(target.path);
    if (target.kind === 'repo') {
      return registered.has(target.path)
        ? `${where} is a git repository, already added.`
        : `${where} is a git repository.`;
    }
    if (target.kind === 'gitfile') {
      return registered.has(target.path)
        ? `${where} is a linked worktree, already added.`
        : `${where} has a .git file: a linked worktree or a submodule.`;
    }
    if (watched.has(target.path)) return `${where} is already watched.`;
    const repos = target.path === current?.path ? countRepos(current.entries) : null;
    if (repos === null) return `${where} is a folder.`;
    return repos === 0
      ? `${where} has no repositories directly inside; watching also looks ${depth} levels deep.`
      : `${where} has ${repos} ${repos === 1 ? 'repository' : 'repositories'} directly inside.`;
  })();

  return {
    text,
    partial,
    listing,
    shown,
    current,
    missing,
    rows,
    entries,
    hiddenCount,
    active,
    setActive,
    activeRow,
    target,
    primary,
    canSubmit,
    pending,
    error,
    status,
    registered,
    watched,
    addProject,
    addScanRoot,
    shortcut: activeRow ? `${MOD_LABEL} Enter` : 'Enter',
    show,
    goTo,
    activate,
    submit,
    addEntry,
    change,
    onKeyDown,
  };
}

export type FolderBrowser = ReturnType<typeof useFolderBrowser>;

/** Keeps focus in the text box when a row or button is clicked (as T3 Code's palette does). */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

const PRIMARY_LABEL = { add: 'Add', watch: 'Watch', open: 'Open' } as const;
const BUSY_LABEL = { add: 'Adding…', watch: 'Watching…', open: 'Opening…' } as const;
const PRIMARY_TITLE = {
  add: 'Add this repository',
  watch: 'Watch this folder for repositories',
  open: 'Open this repository',
} as const;

/**
 * The text box's trailing button: the action Enter runs, with its shortcut. It carries the
 * test id of the action it runs, so the other action's button (below the list) keeps its own.
 */
export function FolderSubmitButton({ browser }: { browser: FolderBrowser }) {
  const { primary } = browser;
  const busy = primary === 'watch' ? browser.addScanRoot.isPending : browser.addProject.isPending;
  return (
    <button
      type="button"
      tabIndex={-1}
      data-testid={
        primary === 'watch'
          ? TEST_IDS.addScanRootSubmit
          : primary === 'add'
            ? TEST_IDS.addProjectSubmit
            : undefined
      }
      data-action={primary}
      title={`${PRIMARY_TITLE[primary]} (${browser.shortcut})`}
      aria-label={`${PRIMARY_LABEL[primary]} (${browser.shortcut})`}
      disabled={!browser.canSubmit}
      onMouseDown={keepFocus}
      onClick={() => browser.submit(primary)}
      className="od-btn absolute top-1/2 right-1.5 h-6 -translate-y-1/2 gap-1 px-2 text-[11px]"
    >
      <span>{busy ? BUSY_LABEL[primary] : PRIMARY_LABEL[primary]}</span>
      <kbd className="pointer-events-none opacity-80">{browser.shortcut}</kbd>
    </button>
  );
}

/** The folder list: `..`, then the matching folders; repositories can be added in place. */
export function FolderRows({
  browser,
  listId,
  className = '',
  footer,
}: {
  browser: FolderBrowser;
  listId: string;
  className?: string;
  footer?: ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const { rows, active, setActive, shown, missing, entries, partial } = browser;

  useEffect(() => {
    if (active < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  return (
    <div
      ref={listRef}
      id={listId}
      role="listbox"
      aria-label="Folders"
      aria-busy={browser.listing.isFetching}
      className={`od-scroll overflow-y-auto p-1 ${
        browser.listing.isPlaceholderData ? 'opacity-60' : ''
      } ${className}`}
    >
      <div className="px-2 pt-0.5 pb-1 text-[11px] font-medium text-faint">Folders</div>
      {rows.map((row, i) => {
        const isActive = i === active;
        const rowClass = `flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 ${
          isActive ? 'bg-selected' : 'hover:bg-hover'
        }`;
        if (row.type === 'up') {
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by the combobox
            <div
              key=".."
              id={`${listId}-row-${i}`}
              data-row={i}
              data-testid={TEST_IDS.folderPickerUp}
              role="option"
              tabIndex={-1}
              aria-selected={isActive}
              title={`Up to ${browser.show(row.path)}`}
              onMouseDown={keepFocus}
              onMouseEnter={() => setActive(i)}
              onClick={() => browser.activate(row)}
              className={rowClass}
            >
              <CornerLeftUpIcon size={13} className="shrink-0 text-muted" />
              <span className="font-mono">..</span>
            </div>
          );
        }
        const { entry } = row;
        const isRepo = entry.kind !== 'dir';
        const isAdded = browser.registered.has(entry.path);
        const isWatched = browser.watched.has(entry.path);
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by the combobox
          <div
            key={entry.path}
            id={`${listId}-row-${i}`}
            data-row={i}
            data-testid={TEST_IDS.folderPickerEntry}
            data-path={entry.path}
            data-kind={entry.kind}
            data-registered={String(isAdded || isWatched)}
            role="option"
            tabIndex={-1}
            aria-selected={isActive}
            title={entry.symlink ? `${entry.name} is a symbolic link` : undefined}
            onMouseDown={keepFocus}
            onMouseEnter={() => setActive(i)}
            onClick={() => browser.activate(row)}
            className={`group ${rowClass}`}
          >
            {isRepo ? (
              <RepoIcon size={13} className="shrink-0 text-accent" />
            ) : (
              <FolderIcon size={13} className="shrink-0 text-muted" />
            )}
            <span className={`min-w-0 flex-1 truncate ${isRepo ? 'font-medium' : ''}`}>
              {entry.name}
              {entry.symlink && <span className="ml-1.5 text-faint">link</span>}
            </span>
            {isRepo && (
              <span className="shrink-0 text-[11px] text-faint">
                {entry.kind === 'repo' ? 'repository' : 'worktree'}
              </span>
            )}
            {isAdded && <span className="shrink-0 text-[11px] text-muted">added</span>}
            {isWatched && <span className="shrink-0 text-[11px] text-muted">watched</span>}
            {isRepo && !isAdded && (
              <button
                type="button"
                tabIndex={-1}
                data-testid={TEST_IDS.folderPickerEntryAdd}
                aria-label={`Add ${entry.name}`}
                disabled={browser.pending}
                onMouseDown={keepFocus}
                onClick={(e) => {
                  e.stopPropagation();
                  browser.addEntry(entry);
                }}
                className="od-btn h-5 px-1.5 text-[11px]"
              >
                Add
              </button>
            )}
          </div>
        );
      })}
      {shown && !missing && entries.length === 0 && (
        <div className="px-2 py-3 text-center text-faint">
          {partial ? `No folder starts with “${partial}”.` : 'No folders here.'}
        </div>
      )}
      {missing && <div className="px-2 py-3 text-center text-faint">Nothing to list.</div>}
      {!shown && !missing && (
        <div role="status" className="px-2 py-3 text-center text-faint">
          Loading folders…
        </div>
      )}
      {browser.hiddenCount > 0 && (
        <div className="px-2 pt-1 text-[11px] text-faint">
          {browser.hiddenCount} hidden {browser.hiddenCount === 1 ? 'folder' : 'folders'}: type{' '}
          <kbd>.</kbd> to show {browser.hiddenCount === 1 ? 'it' : 'them'}.
        </div>
      )}
      {shown?.truncated && (
        <div className="px-2 pt-1 text-[11px] text-faint">
          Showing the first {shown.entries.length} folders. Type to narrow down.
        </div>
      )}
      {footer}
    </div>
  );
}

/** Footer key hints, worded like T3 Code's palette footer. */
export function FolderKeyHints({ browser, close }: { browser: FolderBrowser; close?: boolean }) {
  return (
    <div className="flex flex-wrap gap-3 text-[11px] text-faint">
      <span>
        <kbd>↑</kbd> <kbd>↓</kbd> Navigate
      </span>
      {browser.activeRow && (
        <span>
          <kbd>Enter</kbd> Select
        </span>
      )}
      <span>
        <kbd>Tab</kbd> Complete
      </span>
      {browser.activeRow && (
        <span>
          <kbd>{MOD_LABEL}</kbd> <kbd>Enter</kbd> {PRIMARY_LABEL[browser.primary]}
        </span>
      )}
      {close && (
        <span>
          <kbd>Esc</kbd> Close
        </span>
      )}
    </div>
  );
}
