import type { ThemeDefinition } from '../tokens.ts';

/** The brand light theme: paper white, the same violet brand hue, darker for contrast. */
export const octopusLight: ThemeDefinition = {
  id: 'octopus-light',
  label: 'Octopus Light',
  kind: 'light',
  description: 'Paper white, violet accent. The default by day.',
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
    accent: '#5b47d6',
    accentFg: '#ffffff',
    accentSoft: '#e9e5fb',
    selected: '#e7e3fa',
    hover: '#eceef4',
    focus: '#5b47d6',
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
