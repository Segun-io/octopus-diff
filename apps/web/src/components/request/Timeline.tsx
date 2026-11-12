import { type ChangeRequest, type ChangeRequestDetail, TEST_IDS } from '@octopus-diff/contracts';
import { type ReactNode, useState } from 'react';
import { useChangeRequestConversation } from '../../api/request.ts';
import { useWorktreeForgeWait } from '../../api/wait.ts';
import { buildTimeline, REVIEWER_WORD, type TimelineEvent } from '../../lib/request.ts';
import { absoluteTime, relativeTime } from '../../lib/time.ts';
import { ChangeRequestGlyph } from '../ChangeRequest.tsx';
import { WaitNote } from '../WaitNote.tsx';
import { ActorName, Banner, ExternalLink, MarkdownBlock } from './parts.tsx';

/**
 * The Timeline tab (T3 Code's `buildPullRequestTimeline` + timeline layout, read-only): opened,
 * commits, comments, reviews, threads, merged or closed, with a vertical connector. Markers are
 * glyphs, not avatars (identity: no portraits in the frame).
 */

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function Marker({ event }: { event: TimelineEvent }) {
  let glyph: ReactNode;
  switch (event.kind) {
    case 'opened':
      glyph = <ChangeRequestGlyph look="open" />;
      break;
    case 'merged':
      glyph = <ChangeRequestGlyph look="merged" />;
      break;
    case 'closed':
      glyph = <ChangeRequestGlyph look="closed" />;
      break;
    case 'commit':
      glyph = (
        <Svg>
          <circle cx="8" cy="8" r="2.5" />
          <path d="M1.5 8h4M10.5 8h4" />
        </Svg>
      );
      break;
    case 'review':
      glyph = (
        <Svg>
          <path d="M2 8.5l3.5 3.5L14 3.5" />
        </Svg>
      );
      break;
    default:
      glyph = (
        <Svg>
          <path d="M2.5 3h11v7.5H7L4 13v-2.5H2.5z" />
        </Svg>
      );
  }
  return (
    <span className="absolute top-0.5 -left-[9px] flex h-[18px] w-[18px] items-center justify-center rounded-full border border-line bg-canvas text-muted">
      {glyph}
    </span>
  );
}

function When({ at }: { at: string }) {
  return (
    <span className="ml-auto shrink-0 text-faint" title={absoluteTime(at)}>
      {relativeTime(at)}
    </span>
  );
}

export function Timeline({
  worktreeId,
  batch,
  detail,
  webUrl,
}: {
  worktreeId: string;
  batch: ChangeRequest;
  detail: ChangeRequestDetail;
  webUrl: string | null;
}) {
  const [newest, setNewest] = useState(true);
  const conversation = useChangeRequestConversation(worktreeId, batch, true);
  const waitSource = useWorktreeForgeWait(worktreeId, batch.kind);
  const data = conversation.data;
  const events = buildTimeline(detail, data?.conversation ?? null, newest);
  const imageHosts = data?.imageHosts ?? [];
  const md = (text: string) => (
    <div className="mt-1">
      <MarkdownBlock text={text} base={webUrl} kind={detail.kind} imageHosts={imageHosts} />
    </div>
  );
  const sigil = detail.kind === 'github' ? '#' : '!';
  return (
    <div className="px-4 py-3">
      <div className="mb-3 flex items-center gap-2 text-[11px] text-muted">
        <WaitNote
          variant="inline"
          active={!data && !conversation.isError}
          source={waitSource}
        />
        {data?.conversation?.truncated && (
          <span>
            Only partially loaded.{' '}
            <ExternalLink href={detail.url}>Open on the forge ↗</ExternalLink>
          </span>
        )}
        <button
          type="button"
          className="od-btn ml-auto"
          aria-pressed={newest}
          onClick={() => setNewest(!newest)}
        >
          {newest ? 'Newest first' : 'Oldest first'}
        </button>
      </div>
      {detail.commitsTotal > detail.commits.length && (
        <Banner>
          Showing the newest {detail.commits.length} of {detail.commitsTotal} commits.
        </Banner>
      )}
      <ol className="ml-[9px] border-l border-line">
        {events.map((event) => (
          <li
            key={event.id}
            data-testid={TEST_IDS.requestTimelineItem}
            data-kind={event.kind}
            className="relative pb-4 pl-5 text-xs"
          >
            <Marker event={event} />
            {event.kind === 'opened' && (
              <div className="flex gap-1.5">
                <span className="font-medium">{event.actor ?? 'someone'}</span>
                <span className="text-muted">
                  opened {sigil}
                  {detail.number}
                </span>
                <When at={event.at} />
              </div>
            )}
            {event.kind === 'commit' && (
              <div className="flex min-w-0 gap-1.5">
                <span className="min-w-0 truncate">{event.headline}</span>
                <span className="shrink-0 font-mono text-muted">{event.sha.slice(0, 7)}</span>
                <When at={event.at} />
              </div>
            )}
            {event.kind === 'comment' && (
              <>
                <div className="flex gap-1.5">
                  <ActorName actor={event.comment.author} />
                  <span className="text-muted">commented</span>
                  <When at={event.at} />
                </div>
                {md(event.comment.body)}
              </>
            )}
            {event.kind === 'review' && (
              <>
                <div className="flex gap-1.5">
                  <ActorName actor={event.review.author} />
                  <span className="text-muted">
                    {event.review.state === 'approved'
                      ? '✓ '
                      : event.review.state === 'changes_requested'
                        ? '✗ '
                        : ''}
                    {REVIEWER_WORD[event.review.state]}
                  </span>
                  <When at={event.at} />
                </div>
                {event.review.body.trim() !== '' && md(event.review.body)}
              </>
            )}
            {event.kind === 'thread' && (
              <>
                <div className="flex min-w-0 gap-1.5">
                  <ActorName actor={event.thread.comments[0]?.author ?? null} />
                  <span className="shrink-0 text-muted">commented on</span>
                  <span className="min-w-0 truncate font-mono text-muted">
                    {event.thread.path}
                    {event.thread.line !== null && `:${event.thread.line}`}
                  </span>
                  {event.thread.resolved && <span className="text-faint">resolved</span>}
                  <When at={event.at} />
                </div>
                {event.thread.comments[0] && md(event.thread.comments[0].body)}
                {event.thread.commentsTotal > 1 && (
                  <p className="mt-1 text-[11px] text-faint">
                    {event.thread.commentsTotal - 1} more in the thread
                  </p>
                )}
              </>
            )}
            {(event.kind === 'merged' || event.kind === 'closed') && (
              <div className="flex gap-1.5">
                <span className="font-medium">{event.actor ?? 'someone'}</span>
                <span className="text-muted">{event.kind}</span>
                <When at={event.at} />
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
