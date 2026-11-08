/**
 * Stable `data-testid` values shared by the web UI (WS3) and the Playwright suite (WS4), so both
 * can be built in parallel. The data attributes listed for each id are part of this contract.
 * Booleans are rendered as the strings "true" / "false"; numbers as decimal strings.
 * Add ids freely (additive); never rename or remove one without a DECISIONS.md entry.
 */
export const TEST_IDS = {
  /** App root. `data-ready="true"` once the first projects + inbox response has rendered. */
  app: 'app',
  /** Shown when no projects are registered; contains the add-project form. */
  emptyState: 'empty-state',
  /** Global error banner (e.g. daemon unreachable, unauthorized). */
  errorBanner: 'error-banner',

  // --- sidebar ---------------------------------------------------------------------------
  sidebar: 'sidebar',
  /** Text filter input (focused by `/`). */
  sidebarFilter: 'sidebar-filter',
  /** `aria-pressed`. */
  onlyDirtyToggle: 'only-dirty-toggle',
  /** `aria-pressed`. */
  onlyUnreviewedToggle: 'only-unreviewed-toggle',
  /** The Inbox entry. `data-count` = number of dirty worktrees; `aria-current="true"` if selected. */
  inboxItem: 'inbox-item',
  /** `data-project-id`, `data-project-name`. */
  projectItem: 'project-item',
  /**
   * `data-worktree-id`, `data-project-id`, `data-branch` (empty if detached), `data-dirty`,
   * `data-ahead`, `data-behind` (empty if null), `data-staged`, `data-unstaged`,
   * `data-untracked`, `data-conflicted`, `data-additions`, `data-deletions`;
   * `aria-current="true"` when selected.
   */
  worktreeItem: 'worktree-item',
  /** Opens the add-project / add-scan-root form. */
  addProjectButton: 'add-project-button',
  addProjectPathInput: 'add-project-path-input',
  addProjectSubmit: 'add-project-submit',
  addScanRootPathInput: 'add-scan-root-path-input',
  addScanRootSubmit: 'add-scan-root-submit',
  /**
   * Folder picker (in the add dialog, empty state and Settings → Folders). The location input
   * takes a typed path and filters the listing; `data-path` on the picker is the listed folder.
   * `addProjectSubmit` / `addScanRootSubmit` act on the location input's path.
   */
  folderPicker: 'folder-picker',
  folderPickerInput: 'folder-picker-input',
  /** One subdirectory row: `data-path`, `data-kind` (DirKind), `data-registered`. */
  folderPickerEntry: 'folder-picker-entry',
  /** Adds the repository of one row directly. */
  folderPickerEntryAdd: 'folder-picker-entry-add',
  folderPickerUp: 'folder-picker-up',

  // --- file list -------------------------------------------------------------------------
  fileList: 'file-list',
  /** Inbox mode: one group per worktree. `data-worktree-id`, `data-project-id`. */
  fileGroup: 'file-group',
  /**
   * `data-path`, `data-old-path` (renames/copies), `data-status` (FileStatus), `data-reviewed`,
   * `data-worktree-id`, `data-additions`, `data-deletions`; `aria-selected="true"` when open.
   */
  fileItem: 'file-item',

  // --- diff ------------------------------------------------------------------------------
  /**
   * `data-worktree-id`, `data-path`, `data-patch-hash`, `data-mode` (`split` | `unified`),
   * `data-state` (`empty` | `loading` | `ready` | `error`).
   */
  diffViewer: 'diff-viewer',
  /** `data-kind`: `binary` | `too-large` | `truncated` | `submodule` | `symlink` | `empty` | `error`. */
  diffPlaceholder: 'diff-placeholder',
  /** Requests the full patch for a too-large file. */
  diffLoadAnyway: 'diff-load-anyway',
  /** "Updated" banner shown when the open file's patch changed underneath the reader. */
  diffUpdatedBanner: 'diff-updated-banner',
  /** Marks the open file reviewed / unreviewed. `aria-pressed`. */
  reviewToggle: 'review-toggle',
  /** Banner above a diff whose text contains bidi/invisible control characters (SEC-05). */
  diffUnicodeWarning: 'diff-unicode-warning',

  // --- toolbar ---------------------------------------------------------------------------
  /** `data-scope` = `scopeKey(scope)`. */
  scopeSelect: 'scope-select',
  /** `data-mode` (`split` | `unified`). */
  diffModeToggle: 'diff-mode-toggle',
  /** `aria-pressed`. */
  whitespaceToggle: 'whitespace-toggle',
  /** `aria-pressed`. */
  showReviewedToggle: 'show-reviewed-toggle',
  /** `data-state`: `idle` | `refreshing` | `offline`. */
  refreshIndicator: 'refresh-indicator',
  themeToggle: 'theme-toggle',
  /** Keyboard help (`?`). */
  helpDialog: 'help-dialog',

  // --- UX round 1 (additive) ---------------------------------------------------------------
  /**
   * "Mark all as verified" for what the user is looking at (the open worktree, or the whole
   * Inbox). `data-target` = `all` | `folder` | `project` | `worktree`, `data-count` = number of
   * files it would mark. Disabled (`aria-disabled`) when there is nothing to mark.
   */
  markAllButton: 'mark-all-button',
  /** Transient notice after a bulk change; `data-changed`, `data-reviewed`. Contains the undo button. */
  bulkReviewToast: 'bulk-review-toast',
  bulkReviewUndo: 'bulk-review-undo',
  /**
   * Review on/off control of the selected worktree (toolbar chip that opens `reviewPolicyMenu`).
   * `data-enabled` ("true"/"false"), `data-source` (`worktree` | `branch` | `project` | `folder`
   * | `default`).
   */
  reviewPolicyChip: 'review-policy-chip',
  /** Menu with one item per target level and an "inherit" choice. */
  reviewPolicyMenu: 'review-policy-menu',
  /** Menu items; `data-target` (`worktree` | `branch` | `project` | `folder`), `data-state` (`on` | `off` | `inherit`). */
  reviewPolicyItem: 'review-policy-item',
  /** Sidebar badge on a worktree/project whose review is disabled. */
  reviewOffBadge: 'review-off-badge',
  /** Settings screen (opened with `,`, the sidebar gear or the command palette). */
  settingsDialog: 'settings-dialog',
  settingsOpenButton: 'settings-open-button',
  /** One per settings section nav entry; `data-section` (`general` | `review` | `appearance` | `folders` | `keyboard` | `about`). */
  settingsSection: 'settings-section',
  /** The global "review enabled by default" switch. `aria-checked`. */
  settingsReviewDefault: 'settings-review-default',
  /** Appearance: the theme picker. `data-theme-id` on each `themeOption`. */
  themePicker: 'theme-picker',
  themeOption: 'theme-option',
  /** Command palette (Ctrl/Cmd+K). */
  commandPalette: 'command-palette',
  commandPaletteInput: 'command-palette-input',
  commandPaletteItem: 'command-palette-item',
} as const;

export type TestId = (typeof TEST_IDS)[keyof typeof TEST_IDS];
