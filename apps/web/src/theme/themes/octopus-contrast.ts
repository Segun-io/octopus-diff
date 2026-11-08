import type { ThemeDefinition } from '../tokens.ts';

/** High-contrast dark theme (proves the registry; ≥ 7:1 for body text). */
export const octopusContrast: ThemeDefinition = {
  id: 'octopus-contrast',
  label: 'Octopus Contrast',
  kind: 'dark',
  description: 'Black, white text, stronger lines. For low light and low vision.',
  colors: {
    canvas: '#000000',
    surface: '#07080b',
    raised: '#141720',
    overlay: '#141720',
    line: '#4a5061',
    lineStrong: '#7a8195',
    fg: '#ffffff',
    muted: '#d5d9e2',
    faint: '#b4bac7',
    accent: '#bdb3ff',
    accentFg: '#000000',
    accentSoft: '#2e2a62',
    selected: '#2b2d5c',
    hover: '#15182a',
    focus: '#ffd166',
    add: '#7fe39b',
    addSoft: '#0f3a1e',
    del: '#ffa39c',
    delSoft: '#4a1c1c',
    mod: '#ffcc66',
    warn: '#ffcc66',
    danger: '#ffa39c',
  },
  diff: { theme: 'github-dark-high-contrast' },
};
