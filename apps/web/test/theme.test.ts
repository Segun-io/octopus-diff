import { describe, expect, it } from 'vitest';
import { AA_TEXT, AA_UI, contrast } from '../src/theme/contrast.ts';
import { themesToCss } from '../src/theme/css.ts';
import {
  DEFAULT_THEME_IDS,
  DEFAULT_THEME_PREFS,
  normalizeThemePrefs,
  resolveTheme,
  selectTheme,
  THEMES,
} from '../src/theme/registry.ts';
import { COLOR_TOKENS, cssVar } from '../src/theme/tokens.ts';

/** Text tokens and the surfaces each may be drawn on (docs/design/IDENTITY.md §4). */
const SURFACES = ['canvas', 'surface', 'raised', 'overlay', 'selected', 'hover'] as const;
const TEXT = ['fg', 'muted', 'faint', 'accent', 'add', 'del', 'mod', 'warn', 'danger'] as const;

describe('theme registry', () => {
  it('registers unique ids and both brand defaults', () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_THEME_IDS.light);
    expect(ids).toContain(DEFAULT_THEME_IDS.dark);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('every theme defines every token and nothing else', () => {
    for (const theme of THEMES) {
      expect(Object.keys(theme.colors).sort()).toEqual([...COLOR_TOKENS].sort());
      for (const token of COLOR_TOKENS) {
        expect(theme.colors[token], `${theme.id}.${token}`).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(theme.diff.theme.length).toBeGreaterThan(0);
      expect(theme.label.length).toBeGreaterThan(0);
    }
  });

  it('meets WCAG AA for every text/background pair in every theme', () => {
    for (const theme of THEMES) {
      const c = theme.colors;
      for (const surface of SURFACES) {
        for (const text of TEXT) {
          expect(
            contrast(c[text], c[surface]),
            `${theme.id}: ${text} on ${surface}`,
          ).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }
      // tinted backgrounds carry text too
      for (const text of ['fg', 'muted', 'faint', 'accent'] as const) {
        expect(
          contrast(c[text], c.accentSoft),
          `${theme.id}: ${text} on accentSoft`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
      expect(contrast(c.add, c.addSoft), `${theme.id}: add on addSoft`).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
      expect(contrast(c.del, c.delSoft), `${theme.id}: del on delSoft`).toBeGreaterThanOrEqual(
        AA_TEXT,
      );
      expect(contrast(c.fg, c.addSoft)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(c.fg, c.delSoft)).toBeGreaterThanOrEqual(AA_TEXT);
      // primary button / unreviewed badge
      expect(
        contrast(c.accentFg, c.accent),
        `${theme.id}: accentFg on accent`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
      // UI components: focus ring and accent against every surface
      for (const surface of SURFACES) {
        expect(
          contrast(c.focus, c[surface]),
          `${theme.id}: focus on ${surface}`,
        ).toBeGreaterThanOrEqual(AA_UI);
        expect(
          contrast(c.accent, c[surface]),
          `${theme.id}: accent on ${surface}`,
        ).toBeGreaterThanOrEqual(AA_UI);
      }
    }
  });

  it('keeps the brand hue distinct from the semantic hues', () => {
    for (const theme of THEMES) {
      const c = theme.colors;
      for (const semantic of ['add', 'del', 'mod', 'danger'] as const) {
        expect(c.accent).not.toBe(c[semantic]);
      }
    }
  });
});

describe('theme preferences', () => {
  it('resolves mode and slots', () => {
    expect(resolveTheme(DEFAULT_THEME_PREFS, true).id).toBe('octopus-dark');
    expect(resolveTheme(DEFAULT_THEME_PREFS, false).id).toBe('octopus-light');
    expect(resolveTheme({ ...DEFAULT_THEME_PREFS, mode: 'dark' }, false).id).toBe('octopus-dark');
    expect(resolveTheme({ ...DEFAULT_THEME_PREFS, mode: 'light' }, true).id).toBe('octopus-light');
    expect(
      resolveTheme({ mode: 'dark', light: 'octopus-light', dark: 'octopus-contrast' }, false).id,
    ).toBe('octopus-contrast');
  });

  it('falls back safely for unknown or mismatched ids', () => {
    expect(
      resolveTheme({ mode: 'dark', light: 'octopus-light', dark: 'removed-theme' }, true).id,
    ).toBe('octopus-dark');
    // a dark theme in the light slot is not honoured
    expect(
      resolveTheme({ mode: 'light', light: 'octopus-dark', dark: 'octopus-dark' }, false).id,
    ).toBe('octopus-light');
    expect(normalizeThemePrefs({ mode: 'weird', light: 42, dark: 'nope' })).toEqual(
      DEFAULT_THEME_PREFS,
    );
  });

  it('migrates the v1 string preference', () => {
    expect(normalizeThemePrefs('dark')).toEqual({ ...DEFAULT_THEME_PREFS, mode: 'dark' });
    expect(normalizeThemePrefs('light')).toEqual({ ...DEFAULT_THEME_PREFS, mode: 'light' });
    expect(normalizeThemePrefs('system')).toEqual(DEFAULT_THEME_PREFS);
    expect(normalizeThemePrefs(undefined)).toEqual(DEFAULT_THEME_PREFS);
    expect(normalizeThemePrefs(null)).toEqual(DEFAULT_THEME_PREFS);
  });

  it('selecting a theme fills its slot and switches the mode', () => {
    const next = selectTheme(DEFAULT_THEME_PREFS, 'octopus-contrast');
    expect(next).toEqual({ mode: 'dark', light: 'octopus-light', dark: 'octopus-contrast' });
    expect(selectTheme(next, 'octopus-light').mode).toBe('light');
    expect(selectTheme(next, 'unknown')).toBe(next);
  });
});

describe('generated theme css', () => {
  it('declares every token for every theme and the root defaults', () => {
    const css = themesToCss();
    for (const theme of THEMES) {
      const block = css.slice(css.indexOf(`:root[data-theme="${theme.id}"]`));
      const body = block.slice(0, block.indexOf('}'));
      for (const token of COLOR_TOKENS) {
        expect(body).toContain(`${cssVar(token)}: ${theme.colors[token]};`);
      }
      expect(body).toContain(`color-scheme: ${theme.kind};`);
    }
    expect(css).toMatch(/^:root \{/m);
    expect(css).toMatch(/^:root\.dark \{/m);
    expect(cssVar('lineStrong')).toBe('--od-line-strong');
  });
});
