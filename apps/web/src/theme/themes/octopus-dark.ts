import type { ThemeDefinition } from '../tokens.ts';

/**
 * The brand dark theme: ink black with a blue cast. The accent is ink itself (the `fg` colour), so
 * every hue on screen belongs to the diff (docs/design/IDENTITY.md §4).
 */
export const octopusDark: ThemeDefinition = {
  id: 'octopus-dark',
  label: 'Octopus Dark',
  kind: 'dark',
  description: 'White ink on black. The default at night.',
  colors: {
    canvas: '#0b0d14',
    surface: '#10131b',
    raised: '#171b25',
    overlay: '#1d222e',
    line: '#262b38',
    lineStrong: '#363c4c',
    fg: '#e4e7ee',
    muted: '#a4abba',
    faint: '#8e96a6',
    accent: '#e4e7ee',
    accentFg: '#0b0d14',
    accentSoft: '#282d39',
    selected: '#242936',
    hover: '#181c27',
    focus: '#f0f2f7',
    add: '#5ccb7f',
    addSoft: '#12301d',
    del: '#ff8a80',
    delSoft: '#3a1b1b',
    mod: '#e0ae52',
    warn: '#e0ae52',
    danger: '#ff8a80',
  },
  diff: { theme: 'pierre-dark' },
};
