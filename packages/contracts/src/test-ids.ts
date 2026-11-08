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
} as const;

export type TestId = (typeof TEST_IDS)[keyof typeof TEST_IDS];
