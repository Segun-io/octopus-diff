import type { DiffScope, ScopeKind } from '@octopus-diff/contracts';

/**
 * The scope names the file pane header's scope select uses (docs/STATUS-FLOW.md §2.3), shared with
 * the copy headers (`scopeCopyLabel` in `copyFormat.ts`) so both say the same thing.
 */
export const SCOPE_LABELS: Record<ScopeKind, string> = {
  review: 'To review',
  branch: 'All on branch',
  working: 'Uncommitted',
  staged: 'Staged',
  unstaged: 'Unstaged',
  commit: 'Commit…',
};

/** "All on branch": the working tree against the merge-base (committed + uncommitted). */
export const ALL_ON_BRANCH: DiffScope = { kind: 'branch', includeWorking: true };
