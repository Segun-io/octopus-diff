/**
 * The command registry: one list that feeds the keyboard handler's documentation (`?`),
 * Settings → Keyboard and the command palette. Keys are display strings; the actual key
 * matching lives in `useKeyboardShortcuts` (chords and modifier handling need code).
 */
import type { Commands } from './commands.ts';
import { CONTEXT_STEP } from './diffContext.ts';

export type CommandGroup = 'navigate' | 'review' | 'view' | 'diff' | 'copy' | 'app';

export interface CommandDef {
  id: string;
  label: string;
  group: CommandGroup;
  /** Display keys, e.g. `['j']`, `['g', 'i']` (chord), `['⇧ R']`, `['Ctrl/⌘ K']`. */
  keys: string[];
  /** Chord: keys are pressed in sequence. */
  chord?: boolean;
  run: (commands: Commands) => void;
  /** Palette-only commands are not shortcuts; they still show in the palette. */
  paletteOnly?: boolean;
  /** Hidden from the palette (navigation primitives nobody searches for). */
  hideInPalette?: boolean;
  /** Listed in the palette only with an open worktree / a selected file. */
  needs?: 'worktree' | 'file';
}

export const COMMANDS: readonly CommandDef[] = [
  // navigate
  {
    id: 'nextFile',
    label: 'Next file',
    group: 'navigate',
    keys: ['j'],
    run: (c) => c.nextFile(),
    hideInPalette: true,
  },
  {
    id: 'prevFile',
    label: 'Previous file',
    group: 'navigate',
    keys: ['k'],
    run: (c) => c.prevFile(),
    hideInPalette: true,
  },
  {
    id: 'nextWorktree',
    label: 'Next worktree',
    group: 'navigate',
    keys: ['J'],
    run: (c) => c.nextWorktree(),
    hideInPalette: true,
  },
  {
    id: 'prevWorktree',
    label: 'Previous worktree',
    group: 'navigate',
    keys: ['K'],
    run: (c) => c.prevWorktree(),
    hideInPalette: true,
  },
  {
    id: 'nextUnreviewed',
    label: 'Next unreviewed file anywhere',
    group: 'navigate',
    keys: ['n'],
    run: (c) => c.nextUnreviewed(),
  },
  {
    id: 'goInbox',
    label: 'Go to the Inbox',
    group: 'navigate',
    keys: ['g', 'i'],
    chord: true,
    run: (c) => c.goInbox(),
  },
  {
    id: 'focusFilter',
    label: 'Filter worktrees',
    group: 'navigate',
    keys: ['/'],
    run: (c) => c.focusFilter(),
  },
  {
    id: 'palette',
    label: 'Command palette',
    group: 'app',
    keys: ['Ctrl/⌘ K'],
    run: (c) => c.togglePalette(),
    hideInPalette: true,
  },
  // review
  {
    id: 'toggleReviewed',
    label: 'Toggle reviewed for the open file',
    group: 'review',
    keys: ['r'],
    run: (c) => c.toggleReviewed(),
  },
  {
    id: 'markAllVerified',
    label: 'Review all (mark everything shown reviewed)',
    group: 'review',
    keys: ['⇧ R'],
    run: (c) => c.markAll(true),
  },
  {
    id: 'markAllUnreviewed',
    label: 'Mark all unreviewed',
    group: 'review',
    keys: [],
    run: (c) => c.markAll(false),
    paletteOnly: true,
  },
  {
    id: 'undoBulk',
    label: 'Undo the last bulk mark',
    group: 'review',
    keys: ['Ctrl/⌘ Z'],
    run: (c) => c.undoBulk(),
    hideInPalette: true,
  },
  {
    id: 'toggleShowReviewed',
    label: 'Show / hide reviewed files',
    group: 'review',
    keys: ['h'],
    run: (c) => c.toggleShowReviewed(),
  },
  // diff
  {
    id: 'toggleDiffMode',
    label: 'Split / unified diff',
    group: 'diff',
    keys: ['s'],
    run: (c) => c.toggleDiffMode(),
  },
  {
    id: 'toggleWhitespace',
    label: 'Hide / show whitespace changes',
    group: 'diff',
    keys: ['w'],
    run: (c) => c.toggleWhitespace(),
  },
  {
    id: 'expandContext',
    label: `Expand context (+${CONTEXT_STEP} lines)`,
    group: 'diff',
    keys: ['e'],
    run: (c) => c.expandContext(),
  },
  {
    id: 'scrollPage',
    label: 'Scroll the diff down / up a page',
    group: 'diff',
    keys: ['Space', '⇧ Space'],
    run: (c) => c.scrollDiff(0.85),
    hideInPalette: true,
  },
  {
    id: 'scrollHalf',
    label: 'Scroll the diff down / up half a page',
    group: 'diff',
    keys: ['d', 'u'],
    run: (c) => c.scrollDiff(0.5),
    hideInPalette: true,
  },
  // view
  {
    id: 'toggleTree',
    label: 'Tree / list file layout',
    group: 'view',
    keys: [],
    run: (c) => c.toggleTreeLayout(),
    paletteOnly: true,
  },
  {
    id: 'toggleTheme',
    label: 'Toggle light / dark theme',
    group: 'view',
    keys: ['t'],
    run: (c) => c.toggleTheme(),
  },
  {
    id: 'refresh',
    label: 'Refresh now',
    group: 'view',
    keys: [],
    run: (c) => c.refreshNow(),
    paletteOnly: true,
  },
  // copy (palette only; menus and buttons have the same actions)
  {
    id: 'copyBranch',
    label: 'Copy branch name',
    group: 'copy',
    keys: [],
    run: (c) => c.copy('branch'),
    paletteOnly: true,
    needs: 'worktree',
  },
  {
    id: 'copyWorktreePath',
    label: 'Copy worktree path',
    group: 'copy',
    keys: [],
    run: (c) => c.copy('worktreePath'),
    paletteOnly: true,
    needs: 'worktree',
  },
  {
    id: 'copyFilePath',
    label: 'Copy file path',
    group: 'copy',
    keys: [],
    run: (c) => c.copy('filePath'),
    paletteOnly: true,
    needs: 'file',
  },
  {
    id: 'copyFileName',
    label: 'Copy file name',
    group: 'copy',
    keys: [],
    run: (c) => c.copy('fileName'),
    paletteOnly: true,
    needs: 'file',
  },
  {
    id: 'copyAbsolutePath',
    label: 'Copy absolute file path',
    group: 'copy',
    keys: [],
    run: (c) => c.copy('absolutePath'),
    paletteOnly: true,
    needs: 'file',
  },
  // app
  {
    id: 'settings',
    label: 'Open Settings',
    group: 'app',
    keys: [','],
    run: (c) => c.openSettings(),
  },
  {
    id: 'help',
    label: 'Keyboard shortcuts',
    group: 'app',
    keys: ['?'],
    run: (c) => c.toggleHelp(),
  },
  {
    id: 'escape',
    label: 'Close dialogs, leave the filter',
    group: 'app',
    keys: ['Esc'],
    run: () => {},
    hideInPalette: true,
  },
];

export const GROUP_LABELS: Record<CommandGroup, string> = {
  navigate: 'Navigate',
  review: 'Review',
  view: 'View',
  diff: 'Diff',
  copy: 'Copy',
  app: 'App',
};

/** Shortcut rows for the help dialog and Settings → Keyboard (commands with keys only). */
export const SHORTCUTS: { id: string; keys: string[]; chord: boolean; description: string }[] =
  COMMANDS.filter((c) => c.keys.length > 0).map((c) => ({
    id: c.id,
    keys: c.keys,
    chord: c.chord === true,
    description: c.label,
  }));
