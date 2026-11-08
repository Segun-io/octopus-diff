import { type DiffScope, type ScopeKind, scopeKey, TEST_IDS } from '@octopus-diff/contracts';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useResolvedTheme } from '../api/hooks.ts';
import { queryKeys, useApi, useCommitsQuery } from '../api/queries.ts';
import { useScanRootsQuery, useSettingsSupport } from '../api/settings.ts';
import { useCommandsContext } from '../state/commandsContext.tsx';
import { useAppModel } from '../state/model.tsx';
import { useUi, useUiStore } from '../state/ui.tsx';
import { MoonIcon, SunIcon, ToggleButton } from './bits.tsx';
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
      aria-label="Diff options"
      className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-2 py-1.5"
    >
      <label className="flex items-center gap-1 text-xs text-muted">
        <span>Scope</span>
        <select
          data-testid={TEST_IDS.scopeSelect}
          data-scope={scopeKey(scope)}
          value={scope.kind}
          onChange={(e) => setScopeKind(e.target.value as ScopeKind)}
          className="rounded border border-line bg-canvas px-1 py-0.5 text-xs text-fg"
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
            commitList.find((c) => c.sha.toLowerCase().startsWith(scope.sha.toLowerCase()))?.sha ??
            ''
          }
          onChange={(e) => store.setState({ scope: { kind: 'commit', sha: e.target.value } })}
          className="max-w-72 rounded border border-line bg-canvas px-1 py-0.5 font-mono text-xs text-fg"
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
        className="rounded border border-line bg-surface px-2 py-0.5 text-xs text-fg hover:bg-hover"
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
      {model.view.kind === 'worktree' && (
        <button
          type="button"
          onClick={() => store.setState({ fileListLayout: layout === 'list' ? 'tree' : 'list' })}
          title="Show the files as a directory tree"
          aria-pressed={layout === 'tree'}
          className="rounded border border-line bg-surface px-2 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg aria-pressed:bg-selected aria-pressed:text-fg"
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
          title={`${indicatorLabel} — click to refresh now`}
          aria-label={`${indicatorLabel}. Refresh now`}
          className="flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-muted hover:bg-hover"
        >
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full ${
              indicatorState === 'offline'
                ? 'bg-danger'
                : indicatorState === 'refreshing'
                  ? 'animate-pulse bg-accent'
                  : connection === 'open'
                    ? 'bg-add'
                    : 'bg-faint'
            }`}
          />
          <span>{indicatorLabel}</span>
        </button>
        <button
          type="button"
          data-testid={TEST_IDS.themeToggle}
          onClick={commands.toggleTheme}
          title="Toggle light / dark (t)"
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          className="flex items-center rounded px-1.5 py-1 text-muted hover:bg-hover hover:text-fg"
        >
          {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
        </button>
        <button
          type="button"
          onClick={commands.toggleHelp}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          className="rounded px-1.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg"
        >
          ?
        </button>
      </span>
    </div>
  );
}
