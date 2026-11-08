import { DEFAULT_SCOPE, type DiffScope } from '@octopus-diff/contracts';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { type FileRef, fileRefKey } from '../lib/fileRef.ts';
import { createStore, type Store, useStoreSelector } from './store.ts';

export type View = { kind: 'inbox' } | { kind: 'worktree'; worktreeId: string };
export type DiffMode = 'split' | 'unified';
export type ThemePreference = 'system' | 'light' | 'dark';
export type FileListLayout = 'list' | 'tree';
export type ConnectionState = 'connecting' | 'open' | 'offline';

/** Per-file view options that change the diff request (reset when the file changes). */
export interface FileViewOptions {
  context?: number;
  full?: boolean;
}

export interface ScanStatus {
  scanRootId: string;
  state: 'scanning' | 'done' | 'error';
  scannedDirs: number;
  foundRepos: number;
  message: string | null;
}

export interface UiState {
  view: View;
  selected: FileRef | null;
  scope: DiffScope;
  diffMode: DiffMode;
  ignoreWhitespace: boolean;
  showReviewed: boolean;
  filterText: string;
  onlyDirty: boolean;
  onlyUnreviewed: boolean;
  theme: ThemePreference;
  fileListLayout: FileListLayout;
  /** Show the unreviewed count in the document title: `(12) octopus-diff`. */
  titleCount: boolean;
  helpOpen: boolean;
  addProjectOpen: boolean;
  fileOptions: Record<string, FileViewOptions>;
  connection: ConnectionState;
  scan: ScanStatus | null;
  /** Transient one-line message (e.g. "No unreviewed files left"). */
  notice: { id: number; text: string } | null;
}

/** Preferences persisted to localStorage. */
const PERSISTED_KEYS = [
  'diffMode',
  'ignoreWhitespace',
  'showReviewed',
  'theme',
  'fileListLayout',
  'titleCount',
] as const satisfies readonly (keyof UiState)[];
type Persisted = Pick<UiState, (typeof PERSISTED_KEYS)[number]>;

export const PREFS_STORAGE_KEY = 'octopus-diff:prefs';

export const DEFAULT_UI_STATE: UiState = {
  view: { kind: 'inbox' },
  selected: null,
  scope: DEFAULT_SCOPE,
  diffMode: 'split',
  ignoreWhitespace: false,
  showReviewed: true,
  filterText: '',
  onlyDirty: false,
  onlyUnreviewed: false,
  theme: 'system',
  fileListLayout: 'list',
  titleCount: true,
  helpOpen: false,
  addProjectOpen: false,
  fileOptions: {},
  connection: 'connecting',
  scan: null,
  notice: null,
};

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadPrefs(): Partial<Persisted> {
  const raw = safeStorage()?.getItem(PREFS_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Persisted> = {};
    if (parsed.diffMode === 'split' || parsed.diffMode === 'unified')
      out.diffMode = parsed.diffMode;
    if (typeof parsed.ignoreWhitespace === 'boolean')
      out.ignoreWhitespace = parsed.ignoreWhitespace;
    if (typeof parsed.showReviewed === 'boolean') out.showReviewed = parsed.showReviewed;
    if (parsed.theme === 'system' || parsed.theme === 'light' || parsed.theme === 'dark') {
      out.theme = parsed.theme;
    }
    if (parsed.fileListLayout === 'list' || parsed.fileListLayout === 'tree') {
      out.fileListLayout = parsed.fileListLayout;
    }
    if (typeof parsed.titleCount === 'boolean') out.titleCount = parsed.titleCount;
    return out;
  } catch {
    return {};
  }
}

export type UiStore = Store<UiState>;

export function createUiStore(initial: Partial<UiState> = {}, persist = true): UiStore {
  const store = createStore<UiState>({
    ...DEFAULT_UI_STATE,
    ...(persist ? loadPrefs() : {}),
    ...initial,
  });
  if (persist) {
    let last = '';
    store.subscribe(() => {
      const state = store.getState();
      const prefs: Record<string, unknown> = {};
      for (const key of PERSISTED_KEYS) prefs[key] = state[key];
      const json = JSON.stringify(prefs);
      if (json === last) return;
      last = json;
      safeStorage()?.setItem(PREFS_STORAGE_KEY, json);
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
};
