import {
  type DirEntry,
  type DirsResponse,
  SCAN_DEPTH_DEFAULT,
  SCAN_DEPTH_MAX,
  TEST_IDS,
} from '@octopus-diff/contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { describeError, queryKeys, useApi, useProjectsQuery } from '../api/queries.ts';
import { useScanRootsQuery } from '../api/settings.ts';
import {
  countRepos,
  displayPath,
  filterEntries,
  folderText,
  hasTrailingSeparator,
  resolveTarget,
  splitLocation,
  tabCompletion,
} from '../lib/folderPath.ts';
import { useUi } from '../state/ui.tsx';
import { ArrowUpIcon, ChevronRightIcon, FolderIcon, RepoIcon } from './bits.tsx';

/** Listings go stale fast (agents create worktrees); keep one only long enough to navigate. */
const DIRS_GC_MS = 5_000;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD_LABEL = isMac ? '⌘' : 'Ctrl';

type Row = { type: 'up'; path: string } | { type: 'entry'; entry: DirEntry };

/**
 * Add a repository or watch a folder by browsing the daemon's filesystem (DECISIONS: folder
 * picker). The location text is the browser: the folder part is listed, the last segment filters.
 */
export function AddProjectForm({
  onDone,
  autoFocus = false,
}: {
  onDone?: () => void;
  autoFocus?: boolean;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const scan = useUi((s) => s.scan);
  const projects = useProjectsQuery();
  const scanRoots = useScanRootsQuery();
  const [text, setText] = useState('~/');
  const [active, setActive] = useState(-1);
  const [depth, setDepth] = useState(SCAN_DEPTH_DEFAULT);
  const [message, setMessage] = useState<string | null>(null);
  const navGeneration = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const { dir, partial } = splitLocation(text);
  const dirsOptions = (path: string) => ({
    queryKey: queryKeys.dirs(path),
    queryFn: () => api.listDirs(path ? { path } : {}),
    staleTime: 0,
    gcTime: DIRS_GC_MS,
    retry: false,
  });
  const listing = useQuery({ ...dirsOptions(dir), placeholderData: keepPreviousData });
  /** The listing of the folder in the text (not the previous one kept while loading). */
  const current: DirsResponse | undefined = listing.isPlaceholderData ? undefined : listing.data;
  const shown = listing.data;
  const missing = !listing.isPlaceholderData && listing.isError;

  const registered = useMemo(() => {
    const set = new Set<string>();
    for (const { project, worktrees } of projects.data?.projects ?? []) {
      if (project.mainWorktreePath) set.add(project.mainWorktreePath);
      for (const { worktree } of worktrees) set.add(worktree.path);
    }
    return set;
  }, [projects.data]);
  const watched = useMemo(
    () => new Set((scanRoots.data?.scanRoots ?? []).map((r) => r.path)),
    [scanRoots.data],
  );

  const entries = shown ? filterEntries(shown.entries, partial) : [];
  const hiddenCount =
    shown && !partial.startsWith('.') ? shown.entries.filter((e) => e.hidden).length : 0;
  const rows: Row[] = [
    ...(shown?.parent && partial === '' && hasTrailingSeparator(text)
      ? [{ type: 'up' as const, path: shown.parent }]
      : []),
    ...entries.map((entry) => ({ type: 'entry' as const, entry })),
  ];
  const activeRow = active >= 0 ? rows[active] : undefined;
  const target = resolveTarget(text, current);
  const show = (abs: string) => (shown ? displayPath(abs, shown.home, shown.sep) : abs);

  // Keep the highlight valid and visible as rows change.
  useEffect(() => {
    if (active >= rows.length) setActive(rows.length - 1);
  }, [active, rows.length]);
  useEffect(() => {
    if (active < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${active}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.scanRoots() }),
    ]);

  const addProject = useMutation({
    mutationFn: (path: string) => api.addProject({ path }),
    onSuccess: async (res) => {
      setMessage(
        res.created
          ? `Added ${res.project.project.name}.`
          : `${res.project.project.name} was already added.`,
      );
      await refresh();
      onDone?.();
    },
  });
  const addScanRoot = useMutation({
    mutationFn: (path: string) => api.addScanRoot({ path, depth }),
    onSuccess: async (res) => {
      setMessage(
        res.created
          ? `Watching ${show(res.scanRoot.path)}. Scanning for repositories…`
          : `${show(res.scanRoot.path)} is already watched.`,
      );
      await refresh();
    },
  });
  const pending = addProject.isPending || addScanRoot.isPending;
  const error = addProject.error ?? addScanRoot.error;
  const canSubmit = target !== null && target.exists !== false && !pending;
  const primary: 'add' | 'watch' = target?.kind === 'dir' ? 'watch' : 'add';

  const resetFeedback = () => {
    setMessage(null);
    addProject.reset();
    addScanRoot.reset();
  };

  /** Loads the next listing first, then switches (no empty flash); a newer action wins. */
  const navigate = async (nextText: string) => {
    const generation = ++navGeneration.current;
    await queryClient.prefetchQuery(dirsOptions(splitLocation(nextText).dir));
    if (generation !== navGeneration.current) return;
    setText(nextText);
    setActive(-1);
  };
  const open = (abs: string) => {
    if (shown) void navigate(folderText(abs, shown.home, shown.sep));
  };
  const activate = (row: Row) => {
    resetFeedback();
    open(row.type === 'up' ? row.path : row.entry.path);
  };
  const submit = (kind: 'add' | 'watch') => {
    if (!target || !canSubmit) return;
    resetFeedback();
    if (kind === 'add') addProject.mutate(target.path);
    else addScanRoot.mutate(target.path);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter / Tab that confirm an IME composition belong to typing.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(-1, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeRow && !mod) activate(activeRow);
      else submit(primary);
    } else if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (activeRow) {
        e.preventDefault();
        activate(activeRow);
        return;
      }
      const completion = current ? tabCompletion(entries, partial) : null;
      if (!completion) return; // let Tab move focus
      e.preventDefault();
      const match = entries.find((x) => x.name === completion.name);
      if (completion.complete && match) open(match.path);
      else setText(dir + completion.name);
    }
  };

  const status = (() => {
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

  const shortcut = activeRow ? `${MOD_LABEL} Enter` : 'Enter';

  return (
    <div
      data-testid={TEST_IDS.folderPicker}
      data-path={current?.path ?? ''}
      className="flex flex-col gap-2 text-xs"
    >
      <p className="text-muted">
        Watch a folder to add every repository and worktree inside it and keep them in sync, or add
        one repository. Nothing is ever written to a repository.
      </p>

      <div className="flex items-center gap-1">
        <label htmlFor={`${listId}-input`} className="font-semibold">
          Folder
        </label>
        <span className="ml-auto flex gap-1">
          {shown?.places.map((place) => (
            <button
              key={place.path}
              type="button"
              className="od-btn od-btn-ghost text-muted"
              title={place.path}
              onClick={() => {
                resetFeedback();
                open(place.path);
              }}
            >
              {place.label}
            </button>
          ))}
        </span>
      </div>

      <input
        id={`${listId}-input`}
        name="folderPath"
        data-testid={TEST_IDS.folderPickerInput}
        data-autofocus={autoFocus ? 'true' : undefined}
        role="combobox"
        aria-expanded="true"
        aria-controls={`${listId}-list`}
        aria-activedescendant={activeRow ? `${listId}-row-${active}` : undefined}
        aria-autocomplete="list"
        value={text}
        onChange={(e) => {
          navGeneration.current++; // typing beats an in-flight navigation
          setText(e.target.value);
          setActive(-1);
          resetFeedback();
        }}
        onKeyDown={onKeyDown}
        placeholder="~/code"
        autoComplete="off"
        spellCheck={false}
        className="od-input w-full font-mono"
      />

      <div
        ref={listRef}
        id={`${listId}-list`}
        role="listbox"
        aria-label="Folders"
        aria-busy={listing.isFetching}
        className={`od-scroll h-56 overflow-y-auto rounded-md border border-line p-1 ${
          listing.isPlaceholderData ? 'opacity-60' : ''
        }`}
      >
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
                title={`Up to ${show(row.path)}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => activate(row)}
                className={rowClass}
              >
                <ArrowUpIcon size={13} className="shrink-0 text-muted" />
                <span className="font-mono">..</span>
              </div>
            );
          }
          const { entry } = row;
          const isRepo = entry.kind !== 'dir';
          const isAdded = registered.has(entry.path);
          const isWatched = watched.has(entry.path);
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
              onMouseEnter={() => setActive(i)}
              onClick={() => activate(row)}
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
                  disabled={pending}
                  onClick={(e) => {
                    e.stopPropagation();
                    resetFeedback();
                    addProject.mutate(entry.path);
                  }}
                  className="od-btn h-5 px-1.5 text-[11px]"
                >
                  Add
                </button>
              )}
              <ChevronRightIcon size={12} className="shrink-0 text-faint" />
            </div>
          );
        })}
        {shown && !missing && entries.length === 0 && (
          <div className="px-2 py-3 text-center text-faint">
            {partial ? `No folder starts with “${partial}”.` : 'No folders here.'}
          </div>
        )}
        {missing && <div className="px-2 py-3 text-center text-faint">Nothing to list.</div>}
        {!shown && !missing && <div className="px-2 py-3 text-center text-faint">Loading…</div>}
        {hiddenCount > 0 && (
          <div className="px-2 pt-1 text-[11px] text-faint">
            {hiddenCount} hidden {hiddenCount === 1 ? 'folder' : 'folders'}: type <kbd>.</kbd> to
            show {hiddenCount === 1 ? 'it' : 'them'}.
          </div>
        )}
        {shown?.truncated && (
          <div className="px-2 pt-1 text-[11px] text-faint">
            Showing the first {shown.entries.length} folders. Type to narrow down.
          </div>
        )}
      </div>

      <p className="min-h-4 text-muted" aria-live="polite">
        {status}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid={TEST_IDS.addProjectSubmit}
          disabled={!canSubmit}
          onClick={() => submit('add')}
          className={`od-btn px-3 ${primary === 'add' ? 'od-btn-primary' : ''}`}
        >
          {addProject.isPending ? 'Adding…' : 'Add repository'}
          {primary === 'add' && <kbd className="ml-1 opacity-80">{shortcut}</kbd>}
        </button>
        <span className="ml-auto flex items-center gap-1 text-muted">
          <label htmlFor={`${listId}-depth`}>depth</label>
          <input
            id={`${listId}-depth`}
            type="number"
            name="depth"
            inputMode="numeric"
            min={0}
            max={SCAN_DEPTH_MAX}
            value={depth}
            title="How many folder levels below the watched folder to look for repositories"
            onChange={(e) =>
              setDepth(Math.max(0, Math.min(SCAN_DEPTH_MAX, Number(e.target.value) || 0)))
            }
            className="od-input w-14 px-1.5"
          />
        </span>
        <button
          type="button"
          data-testid={TEST_IDS.addScanRootSubmit}
          disabled={!canSubmit}
          onClick={() => submit('watch')}
          className={`od-btn px-3 ${primary === 'watch' ? 'od-btn-primary' : ''}`}
        >
          {addScanRoot.isPending ? 'Watching…' : 'Watch folder'}
          {primary === 'watch' && <kbd className="ml-1 opacity-80">{shortcut}</kbd>}
        </button>
      </div>

      <div className="flex flex-wrap gap-3 text-[11px] text-faint">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>↵</kbd> open folder
        </span>
        <span>
          <kbd>Tab</kbd> complete
        </span>
        <span>
          <kbd>{MOD_LABEL}</kbd> <kbd>↵</kbd> add or watch
        </span>
      </div>

      <div aria-live="polite" className="min-h-4">
        {error && <p className="text-danger">{describeError(error).detail}</p>}
        {!error && message && <p className="text-muted">{message}</p>}
        {scan && (
          <p className="text-muted">
            Scan {scan.state}: {scan.scannedDirs} folders, {scan.foundRepos} repositories
            {scan.message ? `. ${scan.message}` : ''}
          </p>
        )}
      </div>
    </div>
  );
}
