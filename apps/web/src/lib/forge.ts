import {
  type ChangeRequest,
  type ChecksState,
  changeRequestNoun,
  type ForgeBudgetState,
  type ForgesResponse,
  type MergeState,
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

export const REVIEW_WORD = {
  approved: 'approved',
  changes_requested: 'changes requested',
  review_required: 'review required',
} as const;

/** Mergeability words (T3 Code's wording, adapted; no em dashes). */
export const MERGE_WORD: Record<MergeState, string> = {
  clean: 'Ready to merge',
  blocked: 'Blocked: reviews or checks required',
  behind: 'Behind base',
  conflicts: 'Conflicts with base',
  unstable: 'Mergeable, checks not passing',
  draft: 'Draft',
  unknown: 'Mergeability not known yet',
};

export const CHECKS_STATE_WORD: Record<ChecksState, string> = {
  success: 'passed',
  failure: 'failing',
  pending: 'running',
  neutral: 'neutral',
};

/** `3/12 checks · 2 failing` (counts when the forge reports them, else the pipeline word). */
export function checksSummary(cr: Pick<ChangeRequest, 'checks'>): string | null {
  const c = cr.checks;
  if (!c) return null;
  if (c.total !== null && c.passed !== null && c.failed !== null && c.pending !== null) {
    const parts = [`${c.passed}/${c.total} checks passed`];
    if (c.failed > 0) parts.push(`${c.failed} failing`);
    if (c.pending > 0) parts.push(`${c.pending} running`);
    return parts.join(' · ');
  }
  return `pipeline ${CHECKS_STATE_WORD[c.state]}`;
}

/** `N files +a −d`, when the forge reported the size. */
export function sizeSummary(
  cr: Pick<ChangeRequest, 'changedFiles' | 'additions' | 'deletions'>,
): { files: string | null; additions: number; deletions: number } | null {
  if (cr.additions == null || cr.deletions == null) return null;
  const files =
    cr.changedFiles == null
      ? null
      : `${cr.changedFiles} ${cr.changedFiles === 1 ? 'file' : 'files'}`;
  return { files, additions: cr.additions, deletions: cr.deletions };
}

/** Does this request need the user's attention (failing CI, changes requested, conflicts)? */
export function needsAttention(cr: ChangeRequest): boolean {
  if (cr.state !== 'open') return false;
  return (
    cr.checks?.state === 'failure' ||
    cr.review === 'changes_requested' ||
    cr.conflicts === true ||
    cr.mergeState === 'conflicts'
  );
}

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

/**
 * The rate-limit line of one host (Settings → Forges, DECISIONS #197): what the daemon used in the
 * last hour and, when it holds lookups back, why and until when. `warn` is true when automatic
 * lookups are not running normally.
 */
export function budgetLine(
  budget: ForgeBudgetState,
  clock: (iso: string) => string = (iso) =>
    new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
): { text: string; warn: boolean } {
  const unit = budget.kind === 'github' ? 'points' : 'requests';
  const used = `${budget.spentLastHour.toLocaleString('en-US')} ${unit} used in the last hour`;
  if (budget.state === 'ok') {
    const left =
      budget.remaining !== null
        ? `, ${budget.remaining.toLocaleString('en-US')} left in ${budget.host}'s window`
        : '';
    return { text: `${used}${left}`, warn: false };
  }
  const until = budget.resumeAt ? ` Resumes about ${clock(budget.resumeAt)}.` : '';
  return { text: `${used}. ${budget.message ?? ''}${until}`.replace(/\s+/g, ' '), warn: true };
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

/**
 * `host/path` of a remote URL for display (`https://github.com/o/r.git`, `git@github.com:o/r`,
 * `ssh://git@host:22/g/p.git` -> `github.com/o/r`, `host/g/p`); null for local paths.
 */
export function remoteLabel(url: string): string | null {
  const scp = /^[^/@:\s]+@([^/:\s]+):(.+)$/.exec(url);
  let host: string;
  let path: string;
  if (scp) {
    host = scp[1] ?? '';
    path = scp[2] ?? '';
  } else {
    const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url);
    if (!match || /^file:/i.test(url)) return null;
    host = match[1] ?? '';
    path = match[2] ?? '';
  }
  path = path.replace(/\.git\/?$/, '').replace(/\/+$/, '');
  return host && path ? `${host.toLowerCase()}/${path}` : null;
}
