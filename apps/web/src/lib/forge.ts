import {
  type ChangeRequest,
  changeRequestNoun,
  type ForgesResponse,
  type ProjectForgeState,
  type WorktreeForge,
} from '@octopus-diff/contracts';

/**
 * Presentation of pull/merge requests (docs/FORGES.md). Glyph shapes follow T3 Code's PR icons
 * (open, draft, merged, closed). Colour is limited to what the identity allows
 * (docs/design/IDENTITY.md §4: hues belong to the diff): open uses `add`, CI uses add / danger /
 * warn, everything else stays in the ink scale.
 */

export type ChangeRequestLook = 'open' | 'draft' | 'merged' | 'closed';

export function lookOf(cr: Pick<ChangeRequest, 'state' | 'draft'>): ChangeRequestLook {
  if (cr.state === 'open') return cr.draft ? 'draft' : 'open';
  return cr.state;
}

export const LOOK_WORD: Record<ChangeRequestLook, string> = {
  open: 'open',
  draft: 'draft',
  merged: 'merged',
  closed: 'closed',
};

export const LOOK_TONE: Record<ChangeRequestLook, string> = {
  open: 'text-add',
  draft: 'text-faint',
  merged: 'text-muted',
  closed: 'text-faint',
};

/** `PR #12` / `MR !12` (GitLab writes merge requests with `!`). */
export function shortRef(cr: Pick<ChangeRequest, 'kind' | 'number'>): string {
  return cr.kind === 'github' ? `PR #${cr.number}` : `MR !${cr.number}`;
}

export function checksWord(cr: ChangeRequest): string | null {
  const c = cr.checks;
  if (!c) return null;
  if (c.total !== null && c.passed !== null && c.failed !== null && c.pending !== null) {
    const parts: string[] = [];
    if (c.failed > 0) parts.push(`${c.failed} failing`);
    if (c.pending > 0) parts.push(`${c.pending} pending`);
    if (c.passed > 0) parts.push(`${c.passed} passed`);
    return `checks: ${parts.join(', ') || `${c.total} total`}`;
  }
  return `pipeline: ${
    { success: 'passed', failure: 'failed', pending: 'running', neutral: 'skipped or canceled' }[
      c.state
    ]
  }`;
}

const REVIEW_WORD = {
  approved: 'approved',
  changes_requested: 'changes requested',
  review_required: 'review required',
} as const;

/** Multi-line tooltip: title, state, base, CI, review, conflicts, sync. */
export function changeRequestTitle(wf: WorktreeForge, cr: ChangeRequest): string {
  const noun = changeRequestNoun(cr.kind).long;
  const lines = [`${shortRef(cr)}: ${cr.title}`];
  const facts = [`${LOOK_WORD[lookOf(cr)]} ${noun}`, `${cr.headBranch} → ${cr.baseBranch}`];
  if (cr.author) facts.push(`by ${cr.author}`);
  lines.push(facts.join(' · '));
  const status: string[] = [];
  const checks = checksWord(cr);
  if (checks) status.push(checks);
  if (cr.review) status.push(REVIEW_WORD[cr.review]);
  if (cr.conflicts) status.push('has conflicts');
  if (cr.comments) status.push(`${cr.comments} ${cr.comments === 1 ? 'comment' : 'comments'}`);
  if (status.length > 0) lines.push(status.join(' · '));
  if (wf.sync === 'differs' && cr.state === 'open') {
    lines.push(
      `The ${noun}'s head differs from this worktree's HEAD (unpushed or unpulled commits)`,
    );
  }
  if (cr.crossRepository && cr.headRepository) lines.push(`From ${cr.headRepository}`);
  return lines.join('\n');
}

/** Index of the forge response by worktree id. */
export interface ForgeIndexEntry {
  project: ProjectForgeState;
  worktree: WorktreeForge;
}

export function indexForges(
  response: ForgesResponse | null | undefined,
): Map<string, ForgeIndexEntry> {
  const map = new Map<string, ForgeIndexEntry>();
  if (!response?.enabled) return map;
  for (const project of response.projects) {
    for (const worktree of project.worktrees) map.set(worktree.worktreeId, { project, worktree });
  }
  return map;
}

/** One line for a project's forge status in Settings and tooltips. */
export function projectStatusLine(state: ProjectForgeState): string {
  switch (state.status) {
    case 'ok':
      return 'Up to date';
    case 'pending':
      return 'Checking…';
    case 'idle':
      return 'Only the default branch is checked out';
    case 'disabled':
      return 'Off';
    default:
      return state.message ?? state.status;
  }
}
