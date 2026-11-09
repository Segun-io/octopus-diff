import type { DiffScope, ScopeKind } from '@octopus-diff/contracts';

/**
 * The scope names the file pane header's scope select uses (docs/STATUS-FLOW.md §2.3), shared with
 * the copy headers (`scopeCopyLabel` in `copyFormat.ts`) so both say the same thing. Key order is
 * the select's order: All on branch (the default scope) first.
 */
export const SCOPE_LABELS: Record<ScopeKind, string> = {
  branch: 'All on branch',
  review: 'To review',
  working: 'Uncommitted',
  staged: 'Staged',
  unstaged: 'Unstaged',
  commit: 'Commit…',
};

/** "All on branch": the working tree against the merge-base (committed + uncommitted). */
export const ALL_ON_BRANCH: DiffScope = { kind: 'branch', includeWorking: true };
