/**
 * Per-device preferences in `localStorage['octopus-diff:prefs']` (COORDINATION §2.3: browser
 * prefs, not daemon settings). Versioned; `loadPrefs` migrates older shapes and never throws.
 *
 * v1 (WS3): `{ diffMode, ignoreWhitespace, showReviewed, theme: 'system'|'light'|'dark',
 *             fileListLayout }`
 * v2 (UX round 1): adds `version: 2`, `theme` becomes `{ mode, light, dark }`, plus density,
 *             defaultScope, autoAdvance, reviewOffDisplay, titleCount, confirmBulk, sidebar
 *             collapse state. Later additive fields (`pinned`, `folderStart`, `settle`,
 *             `settledOpen`, `fromMainOnly`, `activityOpen`, `lastWorktree`) need no version bump: `normalizePrefs` fills their defaults.
 */
import {
  DESKTOP_EDITORS,
  type DesktopEditor,
  type DiffScope,
  type ScopeKind,
  scopeFromQueryFields,
} from '@octopus-diff/contracts';
import type { SettleOverride } from '../lib/model.ts';
import { normalizeThemePrefs, type ThemePrefs } from '../theme/registry.ts';

export const PREFS_STORAGE_KEY = 'octopus-diff:prefs';
export const PREFS_VERSION = 2;

export type DiffMode = 'split' | 'unified';
export type FileListLayout = 'list' | 'tree';
export type Density = 'compact' | 'comfortable';

export interface Prefs {
  diffMode: DiffMode;
  ignoreWhitespace: boolean;
  showReviewed: boolean;
  /**
   * The "From main" chip: list only the files that came from a merge, rebase or update of the
   * default branch. Off by default (those files are wrapped in a collapsed group, DECISIONS #205).
   */
  fromMainOnly: boolean;
  theme: ThemePrefs;
  fileListLayout: FileListLayout;
  density: Density;
  /** Scope selected when the app opens (`commit` is never a default). */
  defaultScope: Exclude<ScopeKind, 'commit'>;
  /** After marking a file reviewed, move to the next unreviewed file. */
  autoAdvance: boolean;
  titleCount: boolean;
  /** Ask before a bulk "mark all" that touches more than one worktree. */
  confirmBulk: boolean;
  /** Collapsed sidebar nodes (folder and project ids). */
  collapsed: string[];
  /** Worktrees pinned to the top of the sidebar (worktree ids). */
  pinned: string[];
  /** Where the folder picker opens (location text); empty means home (`~/`). */
  folderStart: string;
  /** Manual settle / un-settle overrides; each holds while the worktree's `stateHash` matches. */
  settle: SettleOverride[];
  /** The Hidden shelf (`settled` rows) is open (closed by default: density is earned by hiding). */
  settledOpen: boolean;
  /** The Activity strip under the diff is open (collapsed by default: the diff comes first). */
  activityOpen: boolean;
  /** The worktree that was open last: where the app lands on the next load (`''`: none yet). */
  lastWorktree: string;
  /** Desktop app only: the editor "Open in editor" uses (its URL scheme, DESKTOP §3.4). */
  editor: DesktopEditor;
}

export const DEFAULT_PREFS: Prefs = {
  diffMode: 'split',
  ignoreWhitespace: false,
  showReviewed: true,
  fromMainOnly: false,
  theme: normalizeThemePrefs(undefined),
  fileListLayout: 'list',
  density: 'compact',
  defaultScope: 'branch',
  autoAdvance: false,
  titleCount: true,
  confirmBulk: true,
  collapsed: [],
  pinned: [],
  folderStart: '',
  settle: [],
  settledOpen: false,
  activityOpen: false,
  lastWorktree: '',
  editor: 'vscode',
};

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === 'string').slice(0, 1000)
    : [];
}

function settleList(value: unknown): SettleOverride[] {
  if (!Array.isArray(value)) return [];
  const out: SettleOverride[] = [];
  for (const item of value.slice(0, 1000)) {
    const o = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    if (
      typeof o.worktreeId === 'string' &&
      typeof o.stateHash === 'string' &&
      (o.state === 'settled' || o.state === 'active')
    ) {
      out.push({ worktreeId: o.worktreeId, state: o.state, stateHash: o.stateHash });
    }
  }
  return out;
}

export const PREF_KEYS = Object.keys(DEFAULT_PREFS) as (keyof Prefs)[];

function oneOf<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return typeof value === 'string' && (options as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Validates a raw object (any version) into complete prefs; unknown fields are dropped. */
export function normalizePrefs(raw: unknown): Prefs {
  const v = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    diffMode: oneOf(v.diffMode, ['split', 'unified']) ?? DEFAULT_PREFS.diffMode,
    ignoreWhitespace: bool(v.ignoreWhitespace) ?? DEFAULT_PREFS.ignoreWhitespace,
    showReviewed: bool(v.showReviewed) ?? DEFAULT_PREFS.showReviewed,
    fromMainOnly: bool(v.fromMainOnly) ?? DEFAULT_PREFS.fromMainOnly,
    theme: normalizeThemePrefs(v.theme),
    fileListLayout: oneOf(v.fileListLayout, ['list', 'tree']) ?? DEFAULT_PREFS.fileListLayout,
    density: oneOf(v.density, ['compact', 'comfortable']) ?? DEFAULT_PREFS.density,
    defaultScope:
      oneOf(v.defaultScope, ['review', 'working', 'staged', 'unstaged', 'branch']) ??
      DEFAULT_PREFS.defaultScope,
    autoAdvance: bool(v.autoAdvance) ?? DEFAULT_PREFS.autoAdvance,
    titleCount: bool(v.titleCount) ?? DEFAULT_PREFS.titleCount,
    confirmBulk: bool(v.confirmBulk) ?? DEFAULT_PREFS.confirmBulk,
    collapsed: stringList(v.collapsed),
    pinned: stringList(v.pinned),
    folderStart:
      typeof v.folderStart === 'string' && v.folderStart.length <= 4096
        ? v.folderStart
        : DEFAULT_PREFS.folderStart,
    settle: settleList(v.settle),
    settledOpen: bool(v.settledOpen) ?? DEFAULT_PREFS.settledOpen,
    activityOpen: bool(v.activityOpen) ?? DEFAULT_PREFS.activityOpen,
    lastWorktree:
      typeof v.lastWorktree === 'string' && v.lastWorktree.length <= 256
        ? v.lastWorktree
        : DEFAULT_PREFS.lastWorktree,
    editor: oneOf(v.editor, DESKTOP_EDITORS) ?? DEFAULT_PREFS.editor,
  };
}

export function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Reads and migrates stored prefs. Malformed JSON yields the defaults. */
export function loadPrefs(storage: Storage | null = safeStorage()): Prefs {
  const raw = storage?.getItem(PREFS_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    return normalizePrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** True when the stored document is already in the current shape (`version` matches). */
export function storedPrefsAreCurrent(storage: Storage | null = safeStorage()): boolean {
  const raw = storage?.getItem(PREFS_STORAGE_KEY);
  if (!raw) return true;
  try {
    const parsed: unknown = JSON.parse(raw);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { version?: unknown }).version === PREFS_VERSION
    );
  } catch {
    return false;
  }
}

export function serializePrefs(prefs: Prefs): string {
  return JSON.stringify({ version: PREFS_VERSION, ...prefs });
}

export function savePrefs(prefs: Prefs, storage: Storage | null = safeStorage()): void {
  try {
    storage?.setItem(PREFS_STORAGE_KEY, serializePrefs(prefs));
  } catch {
    // Quota or private mode: preferences simply do not persist.
  }
}

export function scopeForPref(kind: Prefs['defaultScope']): DiffScope {
  // "All on branch" includes the working tree (docs/STATUS-FLOW.md §2.3).
  return scopeFromQueryFields(kind === 'branch' ? { scope: kind, working: '1' } : { scope: kind });
}
