/**
 * Typed, registry-driven Settings (COORDINATION §3.1.4). Each per-device preference is declared
 * once here with its control; the dialog renders sections from this list. Daemon-side settings
 * (review default, overrides) and the Folders/Keyboard/About sections have bespoke panels.
 */
import { DESKTOP_EDITOR_LABELS, DESKTOP_EDITORS } from '@octopus-diff/contracts';
import type { Prefs } from '../state/prefs.ts';

export type SettingsSectionId =
  | 'general'
  | 'review'
  | 'appearance'
  | 'folders'
  | 'forges'
  | 'keyboard'
  | 'about'
  /** Only inside the desktop app (`visibleSections`): the command installer, the WSL backend. */
  | 'desktop';

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  description: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'general', label: 'General', description: 'How the review flow behaves.' },
  {
    id: 'review',
    label: 'Review',
    description: 'Where the review loop is on, and where it is off.',
  },
  { id: 'appearance', label: 'Appearance', description: 'Theme, density and diff defaults.' },
  { id: 'folders', label: 'Folders', description: 'Watched folders and repositories.' },
  {
    id: 'forges',
    label: 'Forges',
    description: 'Pull and merge requests from GitHub (gh) and GitLab (glab).',
  },
  { id: 'keyboard', label: 'Keyboard', description: 'Every shortcut, from the command registry.' },
  { id: 'about', label: 'About', description: 'Versions, the daemon and open-source credits.' },
];

/**
 * The desktop app's section (#21's follow-up, #22). Not in `SETTINGS_SECTIONS`, so the browser's
 * list, the command palette and the e2e section order stay as they were.
 */
export const DESKTOP_SETTINGS_SECTION: SettingsSection = {
  id: 'desktop',
  label: 'Desktop app',
  description: 'The octopus-diff command, and where the app runs its backend.',
};

/** The sections to list: the desktop app adds its own before About. */
export function visibleSections(desktop: boolean): readonly SettingsSection[] {
  if (!desktop) return SETTINGS_SECTIONS;
  const about = SETTINGS_SECTIONS.findIndex((s) => s.id === 'about');
  return [
    ...SETTINGS_SECTIONS.slice(0, about),
    DESKTOP_SETTINGS_SECTION,
    ...SETTINGS_SECTIONS.slice(about),
  ];
}

export type BooleanPrefKey = {
  [K in keyof Prefs]: Prefs[K] extends boolean ? K : never;
}[keyof Prefs];
export type StringPrefKey = {
  [K in keyof Prefs]: Prefs[K] extends string ? K : never;
}[keyof Prefs];

export interface PrefToggle {
  kind: 'toggle';
  key: BooleanPrefKey;
  label: string;
  description: string;
}

export interface PrefSelect {
  kind: 'select';
  key: StringPrefKey;
  label: string;
  description: string;
  options: readonly { value: string; label: string }[];
  /** Shown only inside the desktop app (`window.octopusDesktop`). */
  desktopOnly?: boolean;
}

export type PrefItem = PrefToggle | PrefSelect;

/** General: saved on this device. */
export const GENERAL_ITEMS: readonly PrefItem[] = [
  {
    kind: 'select',
    key: 'defaultScope',
    label: 'Default scope',
    description: 'The diff scope selected when octopus-diff opens.',
    options: [
      { value: 'branch', label: 'All on branch' },
      { value: 'review', label: 'To review' },
      { value: 'working', label: 'Uncommitted' },
      { value: 'staged', label: 'Staged' },
      { value: 'unstaged', label: 'Unstaged' },
    ],
  },
  {
    kind: 'toggle',
    key: 'autoAdvance',
    label: 'Auto-advance after marking',
    description: 'After r marks a file reviewed, jump to the next unreviewed file.',
  },
  {
    kind: 'toggle',
    key: 'titleCount',
    label: 'Unreviewed count in the tab title',
    description:
      'Shows "(12) octopus-diff" while unreviewed files exist (in the desktop app, also the badge).',
  },
  {
    kind: 'toggle',
    key: 'confirmBulk',
    label: 'Confirm before marking many worktrees',
    description: 'Ask before "Mark all" touches more than one worktree. Undo is always available.',
  },
  {
    kind: 'select',
    key: 'fileListLayout',
    label: 'File list',
    description: 'Flat list, or a directory tree for a single worktree.',
    options: [
      { value: 'list', label: 'List' },
      { value: 'tree', label: 'Tree' },
    ],
  },
  {
    kind: 'select',
    key: 'editor',
    label: 'Editor',
    description: 'What "Open in editor" opens files with (desktop app).',
    options: DESKTOP_EDITORS.map((value) => ({ value, label: DESKTOP_EDITOR_LABELS[value] })),
    desktopOnly: true,
  },
];

/** The items to show: desktop-only ones only inside the desktop app. */
export function visiblePrefItems(items: readonly PrefItem[], desktop: boolean): PrefItem[] {
  return items.filter((item) => desktop || !(item.kind === 'select' && item.desktopOnly));
}

/** Appearance items that are plain prefs (theme is a bespoke picker). */
export const APPEARANCE_ITEMS: readonly PrefItem[] = [
  {
    kind: 'select',
    key: 'density',
    label: 'Density',
    description: 'Row height and padding.',
    options: [
      { value: 'compact', label: 'Compact' },
      { value: 'comfortable', label: 'Comfortable' },
    ],
  },
  {
    kind: 'select',
    key: 'diffMode',
    label: 'Diff layout',
    description: 'Also toggled with s.',
    options: [
      { value: 'split', label: 'Split' },
      { value: 'unified', label: 'Unified' },
    ],
  },
  {
    kind: 'toggle',
    key: 'ignoreWhitespace',
    label: 'Hide whitespace changes',
    description: 'Also toggled with w. Does not change what counts as reviewed.',
  },
  {
    kind: 'toggle',
    key: 'showReviewed',
    label: 'Show reviewed files',
    description: 'Also toggled with h.',
  },
];
