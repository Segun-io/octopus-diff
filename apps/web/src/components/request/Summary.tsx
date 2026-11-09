import {
  type ChangeRequest,
  type ChangeRequestCheck,
  type ChangeRequestDetail,
  TEST_IDS,
} from '@octopus-diff/contracts';
import { MERGE_WORD } from '../../lib/forge.ts';
import { CHECK_WORD, groupChecks, REVIEWER_WORD } from '../../lib/request.ts';
import { Conversation } from './Conversation.tsx';
import {
  ActorName,
  Avatar,
  Banner,
  ExternalLink,
  MarkdownBlock,
  MetaRow,
  Section,
  StatusDot,
} from './parts.tsx';

/**
 * The Summary tab (T3 Code's `PullRequestSummaryTab`, read-only): reviewers, labels and
 * mergeability as meta rows, then Description, Checks and Conversation as collapsible sections.
 */
export function Summary({
  worktreeId,
  batch,
  detail,
  webUrl,
  imageHosts,
}: {
  worktreeId: string;
  batch: ChangeRequest;
  detail: ChangeRequestDetail;
  webUrl: string | null;
  imageHosts: readonly string[];
}) {
  const groups = groupChecks(detail.checkList);
  const needsAttention = groups.attention.length > 0;
  const mergeState = detail.state === 'open' ? (detail.mergeState ?? null) : null;
  return (
    <div>
      <div className="px-4 pb-3">
        <MetaRow label="Reviewers">
          {detail.reviewers.length === 0 ? (
            <span className="text-muted">No reviewers</span>
          ) : (
            <ul className="flex flex-wrap gap-x-3 gap-y-1">
              {detail.reviewers.map((r) => (
                <li
                  key={r.actor.login}
                  className="inline-flex items-center gap-1.5"
                  data-state={r.state}
                >
                  <Avatar actor={r.actor} imageHosts={imageHosts} />
                  <ActorName actor={r.actor} />
                  <span className="text-muted">
                    {r.state === 'approved' ? '✓ ' : r.state === 'changes_requested' ? '✗ ' : ''}
                    {REVIEWER_WORD[r.state]}
                  </span>
                  {r.stale && (
                    <span
                      className="text-faint"
                      title="Given on an older commit than the request's head"
                    >
                      stale
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </MetaRow>
        {detail.labels.length > 0 && (
          <MetaRow label="Labels">
            <ul className="flex flex-wrap gap-1">
              {detail.labels.map((label) => (
                <li
                  key={label.name}
                  className="od-chip text-fg"
                  // The label colour is a thin left swatch only; the text stays ink.
                  style={label.color ? { boxShadow: `inset 3px 0 0 #${label.color}` } : undefined}
                >
                  {label.name}
                </li>
              ))}
            </ul>
          </MetaRow>
        )}
        {detail.assignees.length > 0 && (
          <MetaRow label="Assignees">
            <span className="flex flex-wrap gap-x-3">
              {detail.assignees.map((a) => (
                <span key={a.login} className="inline-flex items-center gap-1.5">
                  <Avatar actor={a} imageHosts={imageHosts} />
                  <ActorName actor={a} />
                </span>
              ))}
            </span>
          </MetaRow>
        )}
        <MetaRow label="Merge">
          {detail.state === 'merged' ? (
            <span>Merged{detail.mergedBy ? ` by ${detail.mergedBy.login}` : ''}</span>
          ) : detail.state === 'closed' ? (
            <span>Closed without merging</span>
          ) : mergeState ? (
            <span className={mergeState === 'conflicts' ? 'text-danger' : ''}>
              {MERGE_WORD[mergeState]}
            </span>
          ) : detail.conflicts ? (
            <span className="text-danger">Conflicts with base</span>
          ) : (
            <span className="text-muted">Not reported</span>
          )}
        </MetaRow>
      </div>

      <Section title="Description">
        {detail.bodyTruncated && (
          <Banner>
            The description is long and was cut.{' '}
            <ExternalLink href={detail.url}>Read all of it on the forge ↗</ExternalLink>
          </Banner>
        )}
        {detail.body.trim() === '' ? (
          <p className="text-xs text-muted">No description provided.</p>
        ) : (
          <MarkdownBlock
            text={detail.body}
            base={webUrl}
            kind={detail.kind}
            imageHosts={imageHosts}
          />
        )}
      </Section>

      {detail.checkList.length > 0 && (
        <Section title="Checks" count={detail.checkList.length} defaultOpen={needsAttention}>
          {detail.checksTruncated && (
            <Banner>
              Only the first {detail.checkList.length} checks are listed.{' '}
              <ExternalLink href={detail.url}>See all on the forge ↗</ExternalLink>
            </Banner>
          )}
          <CheckGroup title="Needs attention" checks={groups.attention} />
          <CheckGroup title="Running" checks={groups.running} />
          <CheckGroup title="Passed" checks={groups.completed} />
        </Section>
      )}

      <Section title="Conversation" count={batch.comments ?? undefined}>
        <Conversation
          worktreeId={worktreeId}
          changeRequest={batch}
          kind={detail.kind}
          webUrl={webUrl}
          requestUrl={detail.url}
        />
      </Section>
    </div>
  );
}

function CheckGroup({ title, checks }: { title: string; checks: ChangeRequestCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <div className="mb-2">
      <h3 className="mb-1 text-[11px] text-faint">
        {title} <span className="tabular-nums">{checks.length}</span>
      </h3>
      <ul className="flex flex-col">
        {checks.map((check) => (
          <li
            key={`${check.group ?? ''}/${check.name}`}
            data-testid={TEST_IDS.requestCheck}
            data-status={check.status}
            className="flex min-h-6 items-center gap-2 text-xs"
            title={check.description ?? undefined}
          >
            <StatusDot status={check.status} />
            <span className="min-w-0 truncate">{check.name}</span>
            {check.group && <span className="min-w-0 truncate text-faint">{check.group}</span>}
            <span className="ml-auto shrink-0 text-muted">{CHECK_WORD[check.status]}</span>
            <span className="w-16 shrink-0 text-right">
              {check.url && <ExternalLink href={check.url}>Details ↗</ExternalLink>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
