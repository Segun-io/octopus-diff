import type { Plugin } from 'vite';
import { themesToCss } from './css.ts';

export const THEME_CSS_ID = 'virtual:octopus-themes.css';
const RESOLVED = `\0${THEME_CSS_ID}`;

/** Serves `virtual:octopus-themes.css`, the token declarations of every registered theme. */
export function octopusThemesPlugin(): Plugin {
  return {
    name: 'octopus-diff:themes',
    resolveId(id) {
      return id === THEME_CSS_ID ? RESOLVED : undefined;
    },
    load(id) {
      return id === RESOLVED ? themesToCss() : undefined;
    },
  };
}
