/**
 * Turns the theme registry into CSS (used by the Vite plugin at build time and by the tests).
 * The brand themes double as the `:root` / `:root.dark` defaults, so an unknown `data-theme`
 * still paints correctly before React corrects the attribute.
 */
import { DEFAULT_THEME_IDS, THEMES } from './registry.ts';
import { COLOR_TOKENS, cssVar, type ThemeDefinition } from './tokens.ts';

function declarations(theme: ThemeDefinition): string {
  const lines = COLOR_TOKENS.map((t) => `  ${cssVar(t)}: ${theme.colors[t]};`);
  lines.push(`  color-scheme: ${theme.kind};`);
  return lines.join('\n');
}

export function themesToCss(themes: readonly ThemeDefinition[] = THEMES): string {
  const light = themes.find((t) => t.id === DEFAULT_THEME_IDS.light);
  const dark = themes.find((t) => t.id === DEFAULT_THEME_IDS.dark);
  const parts: string[] = ['/* generated from src/theme/themes/*.ts: do not edit */'];
  if (light) parts.push(`:root {\n${declarations(light)}\n}`);
  if (dark) parts.push(`:root.dark {\n${declarations(dark)}\n}`);
  for (const theme of themes) {
    parts.push(`:root[data-theme="${theme.id}"] {\n${declarations(theme)}\n}`);
  }
  return `${parts.join('\n\n')}\n`;
}
