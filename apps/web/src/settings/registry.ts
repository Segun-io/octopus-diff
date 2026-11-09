/**
 * Typed, registry-driven Settings (COORDINATION §3.1.4). Each per-device preference is declared
 * once here with its control; the dialog renders sections from this list. Daemon-side settings
 * (review default, overrides) and the Folders/Keyboard/About sections have bespoke panels.
 */
import type { Prefs } from '../state/prefs.ts';

export type SettingsSectionId =
  | 'general'
  | 'review'
  | 'appearance'
  | 'folders'
  | 'forges'
  | 'keyboard'
  | 'about';

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  description: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'general', label: 'General', description: 'How the Inbox and the review flow behave.' },
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
      { value: 'working', label: 'Uncommitted' },
      { value: 'branch', label: 'All on branch' },
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
    kind: 'select',
    key: 'reviewOffDisplay',
    label: 'Worktrees with review off',
    description: 'How the Inbox shows worktrees that are out of the review loop.',
    options: [
      { value: 'dim', label: 'Dimmed' },
      { value: 'hide', label: 'Hidden' },
      { value: 'show', label: 'Like the others' },
    ],
  },
  {
    kind: 'toggle',
    key: 'titleCount',
    label: 'Unreviewed count in the tab title',
    description: 'Shows "(12) octopus-diff" while unreviewed files exist.',
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
];

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
