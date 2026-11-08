/**
 * Per-device preferences in `localStorage['octopus-diff:prefs']` (COORDINATION §2.3: browser
 * prefs, not daemon settings). Versioned; `loadPrefs` migrates older shapes and never throws.
 *
 * v1 (WS3): `{ diffMode, ignoreWhitespace, showReviewed, theme: 'system'|'light'|'dark',
 *             fileListLayout }`
 * v2 (UX round 1): adds `version: 2`, `theme` becomes `{ mode, light, dark }`, plus density,
 *             defaultScope, autoAdvance, reviewOffDisplay, titleCount, confirmBulk, sidebar
 *             collapse state.
 */
import { type DiffScope, type ScopeKind, scopeFromQueryFields } from '@octopus-diff/contracts';
import { normalizeThemePrefs, type ThemePrefs } from '../theme/registry.ts';

export const PREFS_STORAGE_KEY = 'octopus-diff:prefs';
export const PREFS_VERSION = 2;

export type DiffMode = 'split' | 'unified';
export type FileListLayout = 'list' | 'tree';
export type Density = 'compact' | 'comfortable';
/** How worktrees with review disabled appear in the Inbox. */
export type ReviewOffDisplay = 'dim' | 'hide' | 'show';

export interface Prefs {
  diffMode: DiffMode;
  ignoreWhitespace: boolean;
  showReviewed: boolean;
  theme: ThemePrefs;
  fileListLayout: FileListLayout;
  density: Density;
  /** Scope selected when the app opens (`commit` is never a default). */
  defaultScope: Exclude<ScopeKind, 'commit'>;
  /** After marking a file reviewed, move to the next unreviewed file. */
  autoAdvance: boolean;
  reviewOffDisplay: ReviewOffDisplay;
  titleCount: boolean;
  /** Ask before a bulk "mark all" that touches more than one worktree. */
  confirmBulk: boolean;
  /** Collapsed sidebar nodes (folder / project ids). */
  collapsed: string[];
}

export const DEFAULT_PREFS: Prefs = {
  diffMode: 'split',
  ignoreWhitespace: false,
  showReviewed: true,
  theme: normalizeThemePrefs(undefined),
  fileListLayout: 'list',
  density: 'compact',
  defaultScope: 'working',
  autoAdvance: false,
  reviewOffDisplay: 'dim',
  titleCount: true,
  confirmBulk: true,
  collapsed: [],
};

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
    theme: normalizeThemePrefs(v.theme),
    fileListLayout: oneOf(v.fileListLayout, ['list', 'tree']) ?? DEFAULT_PREFS.fileListLayout,
    density: oneOf(v.density, ['compact', 'comfortable']) ?? DEFAULT_PREFS.density,
    defaultScope:
      oneOf(v.defaultScope, ['working', 'staged', 'unstaged', 'branch']) ??
      DEFAULT_PREFS.defaultScope,
    autoAdvance: bool(v.autoAdvance) ?? DEFAULT_PREFS.autoAdvance,
    reviewOffDisplay:
      oneOf(v.reviewOffDisplay, ['dim', 'hide', 'show']) ?? DEFAULT_PREFS.reviewOffDisplay,
    titleCount: bool(v.titleCount) ?? DEFAULT_PREFS.titleCount,
    confirmBulk: bool(v.confirmBulk) ?? DEFAULT_PREFS.confirmBulk,
    collapsed: Array.isArray(v.collapsed)
      ? v.collapsed.filter((x): x is string => typeof x === 'string').slice(0, 1000)
      : [],
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
  return scopeFromQueryFields({ scope: kind });
}
