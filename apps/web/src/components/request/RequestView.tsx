import { changeRequestNoun, TEST_IDS } from '@octopus-diff/contracts';
import { useState } from 'react';
import { useForgeIndex } from '../../api/forges.ts';
import { describeError } from '../../api/queries.ts';
import { useChangeRequestDetail, useRefreshChangeRequest } from '../../api/request.ts';
import { LOOK_TONE, LOOK_WORD, lookOf } from '../../lib/forge.ts';
import { checksTone, describeChecks } from '../../lib/request.ts';
import { absoluteTime, relativeTime } from '../../lib/time.ts';
import { ChangeRequestGlyph } from '../ChangeRequest.tsx';
import { SegmentedTabs, tabPanelProps } from '../Tabs.tsx';
import { Files } from './Files.tsx';
import { Banner, ExternalLink, FileDiffGlyph, StatusDot } from './parts.tsx';
import { Summary } from './Summary.tsx';
import { Timeline } from './Timeline.tsx';

type RequestTab = 'summary' | 'timeline' | 'files';
const TABS: Array<{ id: RequestTab; label: string }> = [
  { id: 'summary', label: 'Summary' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'files', label: 'Files' },
];

/**
 * The Request tab of a worktree (docs/FORGES.md "Request tab"), after T3 Code's pull request panel
 * (`PullRequestDetailPanel` / `PullRequestDetailLayout`, MIT): header, `Summary | Timeline | Files`,
 * read-only. Shows the batch data at once (number, title, state) and fills in when the detail
 * arrives; checks refresh every 45 s only while some are running and this tab is visible.
 */
export function RequestView({ worktreeId }: { worktreeId: string }) {
  const entry = useForgeIndex().get(worktreeId);
  const batch = entry?.worktree.changeRequest ?? null;
  const [tab, setTab] = useState<RequestTab>('summary');
  const query = useChangeRequestDetail(worktreeId, batch, { live: true });
  const refresh = useRefreshChangeRequest(worktreeId);
  if (!entry || !batch) {
    return (
      <div
        data-testid={TEST_IDS.requestView}
        data-status="no-request"
        className="p-5 text-sm text-muted"
      >
        This worktree’s branch has no pull or merge request.
      </div>
    );
  }
  const response = query.data;
  const detail = response?.request ?? null;
  const status = detail ? 'ok' : query.isError ? 'error' : (response?.status ?? 'loading');
  const noun = changeRequestNoun(batch.kind);
  const look = lookOf(batch);
  const sigil = batch.kind === 'github' ? '#' : '!';
  const webUrl = entry.project.forge?.webUrl ?? null;
  const shown = detail ?? batch;
  const files = detail?.changedFiles ?? batch.changedFiles ?? null;
  const additions = detail?.additions ?? batch.additions ?? null;
  const deletions = detail?.deletions ?? batch.deletions ?? null;
  const createdAt = detail?.createdAt ?? batch.createdAt ?? null;
  return (
    <div
      data-testid={TEST_IDS.requestView}
      data-status={status}
      className="od-scroll h-full overflow-y-auto"
    >
      <header className="px-4 pt-3 pb-3">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <span className="min-w-0 truncate font-mono">
            {entry.project.forge?.repository ?? entry.project.projectId}
          </span>
          <span aria-hidden="true" className="text-faint">
            ▸
          </span>
          <ExternalLink href={batch.url} className="inline-flex items-center gap-1 tabular-nums">
            <span className={`inline-flex ${LOOK_TONE[look]}`}>
              <ChangeRequestGlyph look={look} />
            </span>
            {sigil}
            {batch.number} <span className="text-faint">↗</span>
          </ExternalLink>
          <span className={LOOK_TONE[look]}>{LOOK_WORD[look]}</span>
          <button
            type="button"
            className="od-btn ml-auto"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
            title={`Ask the forge again${response?.fetchedAt ? `. Loaded ${relativeTime(response.fetchedAt)}` : ''}`}
          >
            Refresh
          </button>
        </div>
        <h1 className="mt-1.5 truncate text-base font-semibold" title={shown.title}>
          {shown.title}
        </h1>
        <p className="mt-1 text-xs text-muted">
          {shown.author ?? 'unknown'}
          {createdAt && (
            <>
              {' · '}
              <span title={absoluteTime(createdAt)}>opened {relativeTime(createdAt)}</span>
            </>
          )}
          {shown.updatedAt && (
            <>
              {' · '}
              <span title={absoluteTime(shown.updatedAt)}>
                updated {relativeTime(shown.updatedAt)}
              </span>
            </>
          )}
        </p>
        <div className="mt-3 flex min-w-0 items-center gap-2 text-xs text-muted">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono">
            <span className="truncate">{shown.baseBranch}</span>
            <span className="text-faint" title="receives changes from">
              ←
            </span>
            <span className="truncate">{shown.headBranch}</span>
            <button
              type="button"
              className="font-sans text-faint hover:text-fg"
              title="Copy the head branch name"
              onClick={() => void navigator.clipboard?.writeText(shown.headBranch).catch(() => {})}
            >
              copy
            </button>
          </span>
          {additions !== null && deletions !== null && (
            <span className="ml-auto inline-flex shrink-0 items-center gap-2 font-mono tabular-nums">
              <span className="inline-flex items-center gap-1">
                <FileDiffGlyph />
                {files ?? '?'} {files === 1 ? 'file' : 'files'}
              </span>
              <span className="text-add">+{additions}</span>
              <span className="text-del">−{deletions}</span>
            </span>
          )}
        </div>
        {entry.worktree.sync === 'differs' && batch.state === 'open' && (
          <p className="mt-2 text-[11px] text-muted">
            Out of sync: the {noun.long}’s head is not this worktree’s HEAD (local commits not
            pushed, or pushed commits not pulled; nothing is fetched).
          </p>
        )}
      </header>

      <nav
        aria-label={`${noun.long} tabs`}
        className="flex min-w-0 flex-wrap items-center gap-2 border-t border-line px-4 py-2"
      >
        <SegmentedTabs
          tabs={TABS.map((t) => ({
            ...t,
            ...(t.id === 'files' && files !== null ? { count: files } : {}),
          }))}
          value={tab}
          onChange={setTab}
          label={`${noun.long} sections`}
          idPrefix={`request-${worktreeId}`}
          testId={TEST_IDS.requestTab}
        />
        {tab === 'summary' && detail && (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted">
            <StatusDot status={checksTone(detail.checkList)} />
            {describeChecks(detail.checkList)}
          </span>
        )}
      </nav>

      {detail && response?.message && (
        <div className="px-4">
          <Banner>Showing the last loaded data: {response.message}</Banner>
        </div>
      )}

      {detail ? (
        <div {...tabPanelProps(`request-${worktreeId}`, tab)} className="contents">
          {tab === 'summary' ? (
            <Summary
              worktreeId={worktreeId}
              batch={batch}
              detail={detail}
              webUrl={webUrl}
              imageHosts={response?.imageHosts ?? []}
            />
          ) : tab === 'timeline' ? (
            <Timeline worktreeId={worktreeId} batch={batch} detail={detail} webUrl={webUrl} />
          ) : (
            <Files worktreeId={worktreeId} detail={detail} />
          )}
        </div>
      ) : status === 'loading' ? (
        <div role="status" aria-label={`Loading the ${noun.long}`} className="px-4 py-3">
          {[70, 45, 60].map((w) => (
            <div key={w} className="mb-2 h-3 rounded-sm bg-raised" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : (
        <div role="alert" className="px-4 py-3 text-xs">
          <p className="text-muted">
            {query.isError
              ? describeError(query.error).detail
              : (response?.message ?? `The ${noun.long} could not be loaded.`)}
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className="od-btn" onClick={() => void query.refetch()}>
              Retry
            </button>
            <ExternalLink href={batch.url} className="od-btn">
              Open on the forge ↗
            </ExternalLink>
          </div>
        </div>
      )}
    </div>
  );
}
