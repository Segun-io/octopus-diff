import { DEFAULT_SCOPE, type DiffScope } from '@octopus-diff/contracts';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { type FileRef, fileRefKey } from '../lib/fileRef.ts';
import type { SettingsSectionId } from '../settings/registry.ts';
import type { ThemePrefs } from '../theme/registry.ts';
import type { AddJob, ScanFollow } from './addJob.ts';
import {
  DEFAULT_PREFS,
  type Density,
  type DiffMode,
  type FileListLayout,
  loadPrefs,
  PREF_KEYS,
  type Prefs,
  type ReviewOffDisplay,
  savePrefs,
  scopeForPref,
  storedPrefsAreCurrent,
} from './prefs.ts';
import { createStore, type Store, useStoreSelector } from './store.ts';

export { PREFS_STORAGE_KEY } from './prefs.ts';
export type { Density, DiffMode, FileListLayout, ReviewOffDisplay, ThemePrefs };

/**
 * What the main pane shows. Shaped as a path through Inbox → folder → project → worktree so new
 * views need no shell changes (views/registry.ts).
 */
export type View =
  | { kind: 'inbox' }
  | { kind: 'folder'; scanRootId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'worktree'; worktreeId: string; tab?: WorktreeTab };
/** Main-pane tab of a worktree (views/registry.ts): its changes, or its pull/merge request. */
export type WorktreeTab = 'changes' | 'request';
export type ConnectionState = 'connecting' | 'open' | 'offline';

/** Per-file view options that change the diff request (reset when the file changes). */
export interface FileViewOptions {
  context?: number;
  full?: boolean;
}

export interface BulkToast {
  id: number;
  text: string;
  undoToken: string | null;
  reviewed: boolean;
  changed: number;
  /** Set while an undo is in flight or after it completed. */
  state: 'done' | 'undoing' | 'undone' | 'failed';
}

export interface ScanStatus {
  scanRootId: string;
  state: 'scanning' | 'done' | 'error';
  scannedDirs: number;
  foundRepos: number;
  message: string | null;
}

/** Transient state plus every persisted preference (see `Prefs`). */
export interface UiState extends Prefs {
  view: View;
  selected: FileRef | null;
  scope: DiffScope;
  /** Sidebar filter dropdown: picked project and worktree ids (a union; empty = all). */
  filterProjects: string[];
  filterWorktrees: string[];
  /** The filter dropdown is open (`/` opens it). */
  filterOpen: boolean;
  onlyDirty: boolean;
  onlyUnreviewed: boolean;
  /**
   * Activity strip, "follow latest change": select the newest changed file as the feed moves. Off
   * by default and not remembered (a reload starts without it).
   */
  followLatest: boolean;
  /**
   * Worktrees whose "from main" group (the files a merge, rebase or update of the default branch
   * brought) is expanded. Transient: every list opens with the group collapsed.
   */
  originOpen: string[];
  /**
   * The scope to go back to when the "only this branch's changes" toggle is on (it switched the
   * list to All on branch); null while the toggle is off or the scope was changed another way.
   */
  branchToggleFrom: DiffScope | null;
  helpOpen: boolean;
  addProjectOpen: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSectionId;
  paletteOpen: boolean;
  /** Result of the last bulk mark, shown as a toast with undo until dismissed or expired. */
  bulkToast: BulkToast | null;
  /** Pending bulk mark awaiting confirmation (pref `confirmBulk`, more than one worktree). */
  bulkConfirm: { reviewed: boolean; count: number; worktrees: number } | null;
  fileOptions: Record<string, FileViewOptions>;
  connection: ConnectionState;
  scan: ScanStatus | null;
  /** The last "add a repository" / "watch a folder" request and its outcome (state/addJob.ts). */
  addJob: AddJob | null;
  /** Folder scans followed to their end, whether or not their job is still shown. */
  scanFollows: ScanFollow[];
  /** How many add forms are on screen; the add-job toast shows only while none is. */
  addFormsOpen: number;
  /** Transient one-line message (e.g. "No unreviewed files left"). */
  notice: { id: number; text: string } | null;
  /** Result of the last copy (docs/COPY-TOOLS.md): anchored near `at`, else bottom-centre. */
  copyToast: CopyToast | null;
}

export interface CopyToast {
  id: number;
  ok: boolean;
  text: string;
  /** Viewport point to anchor the toast above (a copy button's centre-top). */
  at?: { x: number; y: number };
}

export const DEFAULT_UI_STATE: UiState = {
  ...DEFAULT_PREFS,
  view: { kind: 'inbox' },
  selected: null,
  scope: DEFAULT_SCOPE,
  filterProjects: [],
  filterWorktrees: [],
  filterOpen: false,
  onlyDirty: false,
  onlyUnreviewed: false,
  followLatest: false,
  originOpen: [],
  branchToggleFrom: null,
  helpOpen: false,
  addProjectOpen: false,
  settingsOpen: false,
  settingsSection: 'general',
  paletteOpen: false,
  bulkToast: null,
  bulkConfirm: null,
  fileOptions: {},
  connection: 'connecting',
  scan: null,
  addJob: null,
  scanFollows: [],
  addFormsOpen: 0,
  notice: null,
  copyToast: null,
};

export type UiStore = Store<UiState>;

export function prefsOf(state: UiState): Prefs {
  const out = {} as Record<keyof Prefs, unknown>;
  for (const key of PREF_KEYS) out[key] = state[key];
  return out as unknown as Prefs;
}

export function createUiStore(initial: Partial<UiState> = {}, persist = true): UiStore {
  const prefs = persist ? loadPrefs() : DEFAULT_PREFS;
  const store = createStore<UiState>({
    ...DEFAULT_UI_STATE,
    ...prefs,
    scope: scopeForPref(prefs.defaultScope),
    ...initial,
  });
  if (persist) {
    // Write migrated (or malformed) prefs back right away, so storage holds one shape only.
    if (!storedPrefsAreCurrent()) savePrefs(prefs);
    let last = JSON.stringify(prefsOf(store.getState()));
    store.subscribe(() => {
      const next = prefsOf(store.getState());
      const json = JSON.stringify(next);
      if (json === last) return;
      last = json;
      savePrefs(next);
    });
  }
  return store;
}

const UiStoreContext = createContext<UiStore | null>(null);

export function UiStoreProvider({ store, children }: { store?: UiStore; children: ReactNode }) {
  const [value] = useState(() => store ?? createUiStore());
  return <UiStoreContext value={value}>{children}</UiStoreContext>;
}

export function useUiStore(): UiStore {
  const store = useContext(UiStoreContext);
  if (!store) throw new Error('UiStoreProvider missing');
  return store;
}

export function useUi<T>(selector: (state: UiState) => T): T {
  return useStoreSelector(useUiStore(), selector);
}

// --- actions --------------------------------------------------------------------------------

let noticeId = 0;

export const actions = {
  notice(store: UiStore, text: string) {
    store.setState({ notice: { id: ++noticeId, text } });
  },
  copyToast(store: UiStore, toast: Omit<CopyToast, 'id'>) {
    store.setState({ copyToast: { ...toast, id: ++noticeId } });
  },
  select(store: UiStore, ref: FileRef | null) {
    const current = store.getState().selected;
    if (current && ref && fileRefKey(current) === fileRefKey(ref)) return;
    store.setState({ selected: ref });
  },
  setView(store: UiStore, view: View) {
    const state = store.getState();
    const scope =
      view.kind !== 'worktree' && state.scope.kind === 'commit' ? DEFAULT_SCOPE : state.scope;
    // Moving to another worktree keeps the chosen tab (the registry falls back to Changes when
    // the new worktree has no request).
    const current = state.view;
    const next =
      view.kind === 'worktree' &&
      view.tab === undefined &&
      current.kind === 'worktree' &&
      current.tab
        ? { ...view, tab: current.tab }
        : view;
    store.setState({ view: next, scope });
  },
  setFileOptions(store: UiStore, key: string, options: FileViewOptions) {
    store.setState((s) => ({ fileOptions: { ...s.fileOptions, [key]: options } }));
  },
  openSettings(store: UiStore, section?: SettingsSectionId) {
    store.setState((s) => ({
      settingsOpen: true,
      settingsSection: section ?? s.settingsSection,
      paletteOpen: false,
      helpOpen: false,
    }));
  },
  closeOverlays(store: UiStore) {
    store.setState({
      settingsOpen: false,
      paletteOpen: false,
      helpOpen: false,
      addProjectOpen: false,
    });
  },
  toggleCollapsed(store: UiStore, id: string) {
    store.setState((s) => ({
      collapsed: s.collapsed.includes(id)
        ? s.collapsed.filter((x) => x !== id)
        : [...s.collapsed, id],
    }));
  },
  togglePinned(store: UiStore, worktreeId: string) {
    store.setState((s) => ({
      pinned: s.pinned.includes(worktreeId)
        ? s.pinned.filter((x) => x !== worktreeId)
        : [...s.pinned, worktreeId],
    }));
  },
  /** Expands or collapses the "from main" group of a worktree (`open` forces a state). */
  toggleOriginGroup(store: UiStore, worktreeId: string, open?: boolean) {
    store.setState((s) => {
      const isOpen = s.originOpen.includes(worktreeId);
      if ((open ?? !isOpen) === isOpen) return s;
      return {
        originOpen: isOpen
          ? s.originOpen.filter((x) => x !== worktreeId)
          : [...s.originOpen, worktreeId],
      };
    });
  },
  toggleSettledOpen(store: UiStore) {
    store.setState((s) => ({ settledOpen: !s.settledOpen }));
  },
  /**
   * Settles or un-settles a worktree by hand, pinned to its current `stateHash`; `null` removes
   * the override (and `stateHash` may then be anything).
   */
  setSettle(
    store: UiStore,
    worktreeId: string,
    state: 'settled' | 'active' | null,
    stateHash: string,
  ) {
    store.setState((s) => {
      const rest = s.settle.filter((o) => o.worktreeId !== worktreeId);
      return { settle: state === null ? rest : [...rest, { worktreeId, state, stateHash }] };
    });
  },
  /** Drops overrides whose worktree moved on (hash changed) or is gone; a no-op when none did. */
  pruneSettle(store: UiStore, holds: (o: { worktreeId: string; stateHash: string }) => boolean) {
    const current = store.getState().settle;
    const kept = current.filter(holds);
    if (kept.length !== current.length) store.setState({ settle: kept });
  },
};
