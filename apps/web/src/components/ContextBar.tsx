import { changeRequestNoun, TEST_IDS } from '@octopus-diff/contracts';
import { useIsFetching } from '@tanstack/react-query';
import { useForgeIndex } from '../api/forges.ts';
import { useResolvedTheme } from '../api/hooks.ts';
import { useScanRootsQuery, useSettingsSupport } from '../api/settings.ts';
import { LOOK_TONE, lookOf } from '../lib/forge.ts';
import { worktreeLabel } from '../lib/model.ts';
import { useCommandsContext } from '../state/commandsContext.tsx';
import { useAppModel } from '../state/model.tsx';
import { actions, useUi, useUiStore } from '../state/ui.tsx';
import { activeView } from '../views/registry.ts';
import { MoonIcon, SunIcon } from './bits.tsx';
import { ChangeRequestBadge, ChangeRequestGlyph } from './ChangeRequest.tsx';
import { ReviewPolicyChip } from './ReviewPolicyChip.tsx';
import { DefaultBranchChip, RowChips } from './WorktreeChips.tsx';

export const CONTEXT_BAR_TEST_ID = 'context-bar';

function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

/**
 * The row above the panes (docs/TOOLBAR.md §3.1): where you are (the Inbox, or the worktree's
 * project and branch with its facts), the view switch when the branch has a pull/merge request,
 * the review policy, and the app chrome at the right. It is the same on the Changes and Request
 * tabs: the tabs change what sits below it.
 */
export function ContextBar() {
  const store = useUiStore();
  const model = useAppModel();
  const commands = useCommandsContext();
  const connection = useUi((s) => s.connection);
  const theme = useResolvedTheme();
  const fetching = useIsFetching();
  const support = useSettingsSupport();
  const scanRoots = useScanRootsQuery(support === 'ready');
  const worktreeId = model.view.kind === 'worktree' ? model.view.worktreeId : null;
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

  const inbox = model.view.kind === 'inbox';
  const summary = row?.summary;
  const aheadBehind =
    summary && summary.ahead !== null && summary.behind !== null
      ? { ahead: summary.ahead, behind: summary.behind }
      : null;
  const label = inbox ? 'Inbox' : row ? `${row.project.name} ${worktreeLabel(row.worktree)}` : '';

  return (
    <div
      role="toolbar"
      data-testid={CONTEXT_BAR_TEST_ID}
      aria-label={label}
      className="flex min-h-9 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-1.5"
    >
      {inbox && (
        <>
          <span className="font-medium">Inbox</span>
          <span className="flex gap-3 text-[11px] text-muted tabular-nums">
            <span>{plural(model.groups.length, 'worktree')}</span>
            <span>{plural(model.entries.length, 'file')}</span>
          </span>
        </>
      )}
      {row && (
        <>
          <span
            className="inline-flex min-w-0 items-baseline gap-1.5"
            title={row.worktree.path}
            data-testid="context-bar-worktree"
          >
            <span className="truncate font-medium">{row.project.name}</span>
            <span
              className={`truncate font-mono text-xs text-muted ${row.worktree.branch ? '' : 'italic'}`}
            >
              {worktreeLabel(row.worktree)}
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <DefaultBranchChip row={row} />
            <RowChips row={row} request={false} />
            {aheadBehind && (aheadBehind.ahead > 0 || aheadBehind.behind > 0) && (
              <span
                className="font-mono tabular-nums"
                title="Ahead and behind the upstream, as of the last fetch; octopus-diff never fetches"
              >
                ↑{aheadBehind.ahead} ↓{aheadBehind.behind}
              </span>
            )}
          </span>
        </>
      )}
      {worktreeId && request && (
        <>
          <fieldset
            data-testid={TEST_IDS.worktreeTabs}
            className="od-seg m-0 ml-1 p-0"
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
          {!onRequest && <ChangeRequestBadge worktreeId={worktreeId} />}
        </>
      )}
      {row && model.viewPolicy && (
        <ReviewPolicyChip row={row} policy={model.viewPolicy} folderPath={folderPath} />
      )}

      <span className="ml-auto flex items-center gap-1">
        <button
          type="button"
          data-testid={TEST_IDS.refreshIndicator}
          data-state={indicatorState}
          onClick={commands.refreshNow}
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
          className="od-btn od-btn-ghost od-btn-icon"
        >
          {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
        </button>
        <button
          type="button"
          onClick={commands.toggleHelp}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          className="od-btn od-btn-ghost od-btn-icon"
        >
          ?
        </button>
      </span>
    </div>
  );
}
