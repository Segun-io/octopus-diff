import {
  changeRequestNoun,
  type DiffScope,
  type ScopeKind,
  scopeKey,
  TEST_IDS,
} from '@octopus-diff/contracts';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useForgeIndex } from '../api/forges.ts';
import { useResolvedTheme } from '../api/hooks.ts';
import { queryKeys, useApi, useCommitsQuery } from '../api/queries.ts';
import { useScanRootsQuery, useSettingsSupport } from '../api/settings.ts';
import { LOOK_TONE, lookOf } from '../lib/forge.ts';
import { useCommandsContext } from '../state/commandsContext.tsx';
import { useAppModel } from '../state/model.tsx';
import { actions, useUi, useUiStore } from '../state/ui.tsx';
import { activeView } from '../views/registry.ts';
import { MoonIcon, SunIcon, ToggleButton } from './bits.tsx';
import { ChangeRequestBadge, ChangeRequestGlyph } from './ChangeRequest.tsx';
import { ReviewPolicyChip } from './ReviewPolicyChip.tsx';

const SCOPE_LABELS: Record<ScopeKind, string> = {
  working: 'Working tree',
  staged: 'Staged',
  unstaged: 'Unstaged',
  branch: 'Branch (vs default)',
  commit: 'Commit…',
};

export function Toolbar() {
  const store = useUiStore();
  const model = useAppModel();
  const commands = useCommandsContext();
  const api = useApi();
  const queryClient = useQueryClient();
  const scope = useUi((s) => s.scope);
  const diffMode = useUi((s) => s.diffMode);
  const ignoreWhitespace = useUi((s) => s.ignoreWhitespace);
  const showReviewed = useUi((s) => s.showReviewed);
  const layout = useUi((s) => s.fileListLayout);
  const connection = useUi((s) => s.connection);
  const theme = useResolvedTheme();
  const worktreeId = model.view.kind === 'worktree' ? model.view.worktreeId : null;
  const commits = useCommitsQuery(worktreeId, worktreeId !== null);
  const fetching = useIsFetching();
  const support = useSettingsSupport();
  const scanRoots = useScanRootsQuery(support === 'ready');
  const row = worktreeId ? model.sidebar.byId.get(worktreeId) : undefined;
  const folderPath = row?.project.scanRootId
    ? scanRoots.data?.scanRoots.find((r) => r.id === row.project.scanRootId)?.path
    : undefined;

  const forgeEntry = useForgeIndex().get(worktreeId ?? '');
  const request = forgeEntry?.worktree.changeRequest ?? null;
  const tab = activeView(model.view, { hasRequest: request !== null }).id;
  const onRequest = tab === 'request';
  const setTab = (next: 'changes' | 'request') => {
    if (worktreeId) actions.setView(store, { kind: 'worktree', worktreeId, tab: next });
  };

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
    } else {
      next = { kind };
    }
    store.setState({ scope: next });
  };

  const indicatorState =
    connection === 'offline' || model.projects.isError
      ? 'offline'
      : fetching > 0
        ? 'refreshing'
        : 'idle';
  const indicatorLabel = {
    offline: 'Offline: live updates paused',
    refreshing: 'Refreshing…',
    idle: connection === 'open' ? 'Live' : 'Connecting…',
  }[indicatorState];

  const refreshNow = () => {
    if (worktreeId) void api.refreshWorktree(worktreeId).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll() });
    void queryClient.invalidateQueries({ queryKey: ['files'] });
    void queryClient.invalidateQueries({ queryKey: ['diff'] });
  };

  return (
    <div
      role="toolbar"
      aria-label={onRequest ? 'Request options' : 'Diff options'}
      className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-2 py-1.5"
    >
      {worktreeId && request && (
        <>
          <fieldset
            data-testid={TEST_IDS.worktreeTabs}
            className="od-seg m-0 p-0"
            aria-label="Worktree view"
          >
            <button
              type="button"
              data-testid={TEST_IDS.worktreeTab}
              data-tab="changes"
              aria-pressed={!onRequest}
              onClick={() => setTab('changes')}
              title="The worktree's changes"
            >
              Changes
            </button>
            <button
              type="button"
              data-testid={TEST_IDS.worktreeTab}
              data-tab="request"
              aria-pressed={onRequest}
              onClick={() => setTab('request')}
              title={`The ${changeRequestNoun(request.kind).long} of this branch`}
            >
              <span className={`inline-flex ${LOOK_TONE[lookOf(request)]}`}>
                <ChangeRequestGlyph look={lookOf(request)} />
              </span>
              <span className="tabular-nums">
                {request.kind === 'github' ? 'PR #' : 'MR !'}
                {request.number}
              </span>
            </button>
          </fieldset>
          <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
        </>
      )}
      {!onRequest && (
        <>
          <label className="flex items-center gap-1 text-xs text-muted">
            <span>Scope</span>
            <select
              data-testid={TEST_IDS.scopeSelect}
              data-scope={scopeKey(scope)}
              value={scope.kind}
              onChange={(e) => setScopeKind(e.target.value as ScopeKind)}
              className="od-input"
            >
              {(Object.keys(SCOPE_LABELS) as ScopeKind[]).map((kind) => (
                <option
                  key={kind}
                  value={kind}
                  disabled={kind === 'commit' && (worktreeId === null || !commitList?.length)}
                >
                  {SCOPE_LABELS[kind]}
                  {kind === 'commit' && worktreeId === null ? ' (select a worktree)' : ''}
                </option>
              ))}
            </select>
          </label>
          {scope.kind === 'commit' && commitList && (
            <select
              aria-label="Commit"
              value={
                commitList.find((c) => c.sha.toLowerCase().startsWith(scope.sha.toLowerCase()))
                  ?.sha ?? ''
              }
              onChange={(e) => store.setState({ scope: { kind: 'commit', sha: e.target.value } })}
              className="od-input max-w-72 font-mono"
            >
              {commitList.map((c) => (
                <option key={c.sha} value={c.sha}>
                  {c.shortSha} {c.subject.slice(0, 60)}
                </option>
              ))}
            </select>
          )}

          <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />

          <button
            type="button"
            data-testid={TEST_IDS.diffModeToggle}
            data-mode={diffMode}
            onClick={commands.toggleDiffMode}
            title="Split / unified (s)"
            className="od-btn text-fg"
          >
            {diffMode === 'split' ? 'Split' : 'Unified'}
          </button>
          <ToggleButton
            pressed={ignoreWhitespace}
            onClick={commands.toggleWhitespace}
            title="Hide whitespace changes (w)"
            testId={TEST_IDS.whitespaceToggle}
          >
            Hide whitespace
          </ToggleButton>
          <ToggleButton
            pressed={showReviewed}
            onClick={commands.toggleShowReviewed}
            title="Show reviewed files (h)"
            testId={TEST_IDS.showReviewedToggle}
          >
            Show reviewed
          </ToggleButton>
          {row && model.viewPolicy && (
            <ReviewPolicyChip row={row} policy={model.viewPolicy} folderPath={folderPath} />
          )}
        </>
      )}
      {worktreeId && <ChangeRequestBadge worktreeId={worktreeId} />}
      {model.view.kind === 'worktree' && !onRequest && (
        <button
          type="button"
          onClick={() => store.setState({ fileListLayout: layout === 'list' ? 'tree' : 'list' })}
          title="Show the files as a directory tree"
          aria-pressed={layout === 'tree'}
          className="od-btn"
        >
          Tree view
        </button>
      )}

      <span className="ml-auto flex items-center gap-2">
        <button
          type="button"
          data-testid={TEST_IDS.refreshIndicator}
          data-state={indicatorState}
          onClick={refreshNow}
          title={`${indicatorLabel}. Click to refresh now.`}
          aria-label={`${indicatorLabel}. Refresh now`}
          className={`od-btn od-btn-ghost ${indicatorState === 'offline' ? 'text-danger' : ''}`}
        >
          {indicatorLabel}
        </button>
        <button
          type="button"
          data-testid={TEST_IDS.themeToggle}
          onClick={commands.toggleTheme}
          title="Toggle light / dark (t)"
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          className="od-btn od-btn-ghost"
        >
          {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
        </button>
        <button
          type="button"
          onClick={commands.toggleHelp}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          className="od-btn od-btn-ghost"
        >
          ?
        </button>
      </span>
    </div>
  );
}
