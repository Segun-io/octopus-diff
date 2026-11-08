/**
 * The single source of theme token names (docs/design/THEMING.md). Every theme must define every
 * colour token; `styles.css` maps each one to a CSS custom property `--od-<name>` and a Tailwind
 * colour utility (`bg-canvas`, `text-muted`, ...). Non-colour tokens (spacing, radius, motion,
 * density) are shared by all themes and live in `styles.css`.
 */
export const COLOR_TOKENS = [
  // surfaces, from the back to the front
  'canvas',
  'surface',
  'raised',
  'overlay',
  // lines
  'line',
  'lineStrong',
  // text
  'fg',
  'muted',
  'faint',
  // brand
  'accent',
  'accentFg',
  'accentSoft',
  // interaction
  'selected',
  'hover',
  'focus',
  // semantic (never the brand hue; keep the +/- glyphs, colour is an aid)
  'add',
  'addSoft',
  'del',
  'delSoft',
  'mod',
  'warn',
  'danger',
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];
export type ColorTokens = Readonly<Record<ColorToken, string>>;

export type ThemeKind = 'light' | 'dark';

export interface ThemeDefinition {
  /** Stable id, kebab-case, saved in preferences. Never reuse an id for a different look. */
  id: string;
  /** Shown in the theme picker. */
  label: string;
  kind: ThemeKind;
  /** One line shown under the label in the picker. */
  description: string;
  colors: ColorTokens;
  /** Diff viewer (shiki) theme names for @pierre/diffs. Any bundled shiki theme works. */
  diff: { theme: string };
}

/** `--od-<kebab>` custom property name for a token. */
export function cssVar(token: ColorToken): string {
  return `--od-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}
