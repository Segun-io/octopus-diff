import { DEFAULT_SCOPE, type DiffScope } from '@octopus-diff/contracts';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { type FileRef, fileRefKey } from '../lib/fileRef.ts';
import type { SettingsSectionId } from '../settings/registry.ts';
import type { ThemePrefs } from '../theme/registry.ts';
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
} from './prefs.ts';
import { createStore, type Store, useStoreSelector } from './store.ts';

export { PREFS_STORAGE_KEY } from './prefs.ts';
export type { Density, DiffMode, FileListLayout, ReviewOffDisplay, ThemePrefs };

export type View = { kind: 'inbox' } | { kind: 'worktree'; worktreeId: string };
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
  filterText: string;
  onlyDirty: boolean;
  onlyUnreviewed: boolean;
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
  /** Transient one-line message (e.g. "No unreviewed files left"). */
  notice: { id: number; text: string } | null;
}

export const DEFAULT_UI_STATE: UiState = {
  ...DEFAULT_PREFS,
  view: { kind: 'inbox' },
  selected: null,
  scope: DEFAULT_SCOPE,
  filterText: '',
  onlyDirty: false,
  onlyUnreviewed: false,
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
  notice: null,
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
  select(store: UiStore, ref: FileRef | null) {
    const current = store.getState().selected;
    if (current && ref && fileRefKey(current) === fileRefKey(ref)) return;
    store.setState({ selected: ref });
  },
  setView(store: UiStore, view: View) {
    const state = store.getState();
    const scope =
      view.kind === 'inbox' && state.scope.kind === 'commit' ? DEFAULT_SCOPE : state.scope;
    store.setState({ view, scope });
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
};
