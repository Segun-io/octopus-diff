/**
 * Theme registry and preference model (docs/design/THEMING.md).
 *
 * Preference: `{ mode: 'system' | 'light' | 'dark', light: ThemeId, dark: ThemeId }`. `mode`
 * decides which slot is active; each slot names a theme of that kind. Unknown or removed ids fall
 * back to the brand theme of the slot's kind, so a stale preference can never break the UI.
 */
import { THEMES } from './themes/index.ts';
import type { ThemeDefinition, ThemeKind } from './tokens.ts';

export { THEMES };

export type ThemeMode = 'system' | 'light' | 'dark';

export interface ThemePrefs {
  mode: ThemeMode;
  light: string;
  dark: string;
}

export const DEFAULT_THEME_IDS: Readonly<Record<ThemeKind, string>> = {
  light: 'octopus-light',
  dark: 'octopus-dark',
};

export const DEFAULT_THEME_PREFS: ThemePrefs = {
  mode: 'system',
  light: DEFAULT_THEME_IDS.light,
  dark: DEFAULT_THEME_IDS.dark,
};

const byId = new Map(THEMES.map((t) => [t.id, t]));

export function getTheme(id: string): ThemeDefinition | undefined {
  return byId.get(id);
}

export function themesOfKind(kind: ThemeKind): ThemeDefinition[] {
  return THEMES.filter((t) => t.kind === kind);
}

/** The theme for a slot, falling back to the brand theme of that kind. */
export function resolveSlot(id: string | undefined, kind: ThemeKind): ThemeDefinition {
  const theme = id === undefined ? undefined : byId.get(id);
  if (theme && theme.kind === kind) return theme;
  const fallback = byId.get(DEFAULT_THEME_IDS[kind]);
  if (!fallback) throw new Error(`default ${kind} theme is not registered`);
  return fallback;
}

export function resolveKind(prefs: ThemePrefs, systemDark: boolean): ThemeKind {
  if (prefs.mode === 'system') return systemDark ? 'dark' : 'light';
  return prefs.mode;
}

/** The active theme for the preference and the OS colour scheme. */
export function resolveTheme(prefs: ThemePrefs, systemDark: boolean): ThemeDefinition {
  const kind = resolveKind(prefs, systemDark);
  return resolveSlot(prefs[kind], kind);
}

function isMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * Accepts anything found in storage: the v1 string (`'system' | 'light' | 'dark'`), a v2 object
 * (possibly with unknown ids), or garbage. Always returns a complete, valid preference.
 */
export function normalizeThemePrefs(value: unknown): ThemePrefs {
  if (isMode(value)) return { ...DEFAULT_THEME_PREFS, mode: value };
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_THEME_PREFS };
  const v = value as Record<string, unknown>;
  return {
    mode: isMode(v.mode) ? v.mode : 'system',
    light: resolveSlot(typeof v.light === 'string' ? v.light : undefined, 'light').id,
    dark: resolveSlot(typeof v.dark === 'string' ? v.dark : undefined, 'dark').id,
  };
}

/** Selecting a theme in the picker: sets its slot and switches the mode to show it. */
export function selectTheme(prefs: ThemePrefs, id: string): ThemePrefs {
  const theme = byId.get(id);
  if (!theme) return prefs;
  return { ...prefs, [theme.kind]: theme.id, mode: theme.kind };
}
