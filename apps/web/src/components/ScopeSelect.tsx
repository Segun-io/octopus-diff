import {
  type DiffScope,
  type ScopeKind,
  scopeKey,
  TEST_IDS,
  type WorktreeSummary,
} from '@octopus-diff/contracts';
import { useEffect } from 'react';
import { useCommitsQuery, useFilesQuery } from '../api/queries.ts';
import { ALL_ON_BRANCH, SCOPE_LABELS } from '../lib/scopeLabels.ts';
import { useAppModel } from '../state/model.tsx';
import { useUi, useUiStore } from '../state/ui.tsx';
import { CopyButton } from './CopyButton.tsx';
import { COPY_TEST_IDS } from './copyMenu.ts';

/** Files per scope for the open worktree: from its summary, else from a loaded file list. */
function scopeCounts(
  summary: WorktreeSummary | null | undefined,
  branchFiles: number | undefined,
): Partial<Record<ScopeKind, number>> {
  if (!summary) return {};
  const c = summary.counts;
  return {
    ...(summary.review ? { review: summary.review.unreviewedFiles } : {}),
    working: summary.changedFiles,
    staged: c.staged + c.conflicted,
    unstaged: c.unstaged + c.untracked + c.conflicted,
    ...(branchFiles !== undefined ? { branch: branchFiles } : {}),
  };
}

/**
 * What the file list shows (docs/TOOLBAR.md §3.2): the scope with a count per scope and, for the
 * commit scope, the commit list with a copy button for its id. It sits in the file pane header,
 * over the list it filters.
 */
export function ScopeSelect() {
  const store = useUiStore();
  const model = useAppModel();
  const scope = useUi((s) => s.scope);
  const worktreeId = model.view.kind === 'worktree' ? model.view.worktreeId : null;
  const commits = useCommitsQuery(worktreeId, worktreeId !== null);
  const row = worktreeId ? model.sidebar.byId.get(worktreeId) : undefined;

  // "All on branch" has no count in the summary: list it for the open worktree only.
  const branchFiles = useFilesQuery(worktreeId, ALL_ON_BRANCH);
  const counts = scopeCounts(row?.summary, branchFiles.data?.files.length);
  // To review needs a status-flow daemon (summaries carry `review`); older ones fall back.
  const projectItems = model.projects.data?.projects;
  const reviewSupported =
    projectItems === undefined ||
    projectItems.some((p) => p.worktrees.some((w) => w.summary?.review !== undefined));
  useEffect(() => {
    if (scope.kind === 'review' && !reviewSupported) store.setState({ scope: { kind: 'working' } });
  }, [scope.kind, reviewSupported, store]);

  const commitList = commits.data?.commits;
  // A commit scope always needs a sha: when entering commit scope, default to HEAD.
  useEffect(() => {
    if (scope.kind !== 'commit' || !commitList) return;
    if (!commitList.some((c) => c.sha.toLowerCase().startsWith(scope.sha.toLowerCase()))) {
      const head = commitList[0];
      if (head) store.setState({ scope: { kind: 'commit', sha: head.sha } });
    }
  }, [scope, commitList, store]);

  const setScopeKind = (kind: ScopeKind) => {
    let next: DiffScope;
    if (kind === 'commit') {
      const head = commitList?.[0];
      if (!head) return;
      next = { kind: 'commit', sha: head.sha };
    } else if (kind === 'branch') {
      next = ALL_ON_BRANCH;
    } else {
      next = { kind };
    }
    store.setState({ scope: next });
  };

  const commitSha = scope.kind === 'commit' ? scope.sha : null;
  const selectedCommit =
    commitSha === null
      ? undefined
      : commitList?.find((c) => c.sha.toLowerCase().startsWith(commitSha.toLowerCase()));

  return (
    <>
      <select
        data-testid={TEST_IDS.scopeSelect}
        data-scope={scopeKey(scope)}
        aria-label="What the list shows"
        title="What the list shows"
        value={scope.kind}
        onChange={(e) => setScopeKind(e.target.value as ScopeKind)}
        className="od-input max-w-full"
      >
        {(Object.keys(SCOPE_LABELS) as ScopeKind[]).map((kind) => (
          <option
            key={kind}
            value={kind}
            disabled={
              (kind === 'commit' && (worktreeId === null || !commitList?.length)) ||
              (kind === 'review' && !reviewSupported)
            }
          >
            {SCOPE_LABELS[kind]}
            {worktreeId !== null && counts[kind] !== undefined ? ` (${counts[kind]})` : ''}
            {kind === 'commit' && worktreeId === null ? ' (select a worktree)' : ''}
          </option>
        ))}
      </select>
      {commitSha !== null && commitList && (
        // The commit picker takes its own row under the other controls (flex order, not DOM order).
        <span className="order-1 flex min-w-0 basis-full items-center gap-1.5">
          <select
            aria-label="Commit"
            value={selectedCommit?.sha ?? ''}
            onChange={(e) => store.setState({ scope: { kind: 'commit', sha: e.target.value } })}
            className="od-input min-w-0 flex-1 font-mono"
          >
            {commitList.map((c) => (
              <option key={c.sha} value={c.sha}>
                {c.shortSha} {c.subject.slice(0, 60)}
              </option>
            ))}
          </select>
          <CopyButton
            text={selectedCommit?.sha ?? commitSha}
            label="Copy commit id"
            what="commit id"
            testId={COPY_TEST_IDS.commitButton}
          />
        </span>
      )}
    </>
  );
}
