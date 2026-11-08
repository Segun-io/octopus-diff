import type { ThemeDefinition } from '../tokens.ts';

/** The brand light theme: paper white, black ink as the accent (docs/design/IDENTITY.md §4). */
export const octopusLight: ThemeDefinition = {
  id: 'octopus-light',
  label: 'Octopus Light',
  kind: 'light',
  description: 'Black ink on paper. The default by day.',
  colors: {
    canvas: '#f4f5f9',
    surface: '#ffffff',
    raised: '#eceef4',
    overlay: '#ffffff',
    line: '#d8dbe4',
    lineStrong: '#b9bec9',
    fg: '#1a1d26',
    muted: '#555c6c',
    faint: '#5d6576',
    accent: '#1a1d26',
    accentFg: '#ffffff',
    accentSoft: '#dfe2ea',
    selected: '#e3e6ed',
    hover: '#eceef4',
    focus: '#1a1d26',
    add: '#136b2f',
    addSoft: '#e3f5e8',
    del: '#b91f25',
    delSoft: '#fbe5e5',
    mod: '#7d5200',
    warn: '#7d5200',
    danger: '#b91f25',
  },
  diff: { theme: 'pierre-light' },
};
