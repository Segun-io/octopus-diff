import {
  type ChangeRequest,
  type ChangeRequestComment,
  type ChangeRequestReviewEntry,
  type ChangeRequestThread,
  TEST_IDS,
} from '@octopus-diff/contracts';
import { useState } from 'react';
import { describeError } from '../../api/queries.ts';
import { useChangeRequestConversation } from '../../api/request.ts';
import { useWorktreeForgeWait } from '../../api/wait.ts';
import {
  CONVERSATION_PAGE,
  type ConversationFilter,
  type ConversationItem,
  conversationItems,
  DEFAULT_CONVERSATION_FILTER,
  filterItems,
  isFinished,
  pageItems,
  REVIEWER_WORD,
} from '../../lib/request.ts';
import { absoluteTime, relativeTime } from '../../lib/time.ts';
import { SkeletonLines, WaitNote } from '../WaitNote.tsx';
import { ActorName, Avatar, Banner, ExternalLink, MarkdownBlock } from './parts.tsx';

/**
 * The conversation (T3 Code's comment cards, read-only): top-level comments, reviews with a
 * verdict or text, and review threads with indented replies. Resolved threads and dismissed
 * reviews collapse to one line. Filters for bots and finished items, newest/oldest, 10 per page.
 * Fetched when first shown (one query, cached by the daemon).
 */
export function Conversation({
  worktreeId,
  changeRequest,
  kind,
  webUrl,
  requestUrl,
}: {
  worktreeId: string;
  changeRequest: ChangeRequest;
  kind: 'github' | 'gitlab';
  webUrl: string | null;
  requestUrl: string;
}) {
  const query = useChangeRequestConversation(worktreeId, changeRequest, true);
  const waitSource = useWorktreeForgeWait(worktreeId, kind);
  const [filter, setFilter] = useState<ConversationFilter>(DEFAULT_CONVERSATION_FILTER);
  const [newest, setNewest] = useState(false);
  const [shown, setShown] = useState(CONVERSATION_PAGE);
  const data = query.data;
  if (!data) {
    if (query.isError) {
      return (
        <p role="alert" className="text-xs text-danger">
          {describeError(query.error).detail}{' '}
          <button type="button" className="od-btn ml-2" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      );
    }
    return (
      <div aria-busy="true">
        <SkeletonLines widths={[60, 80, 45]} />
        <WaitNote active source={waitSource} />
      </div>
    );
  }
  if (!data.conversation) {
    return (
      <p className="text-xs text-muted">
        {data.message ?? 'The conversation is not available.'}{' '}
        <ExternalLink href={requestUrl}>Open it on the forge ↗</ExternalLink>
      </p>
    );
  }
  const conversation = data.conversation;
  const all = conversationItems(conversation);
  const items = filterItems(all, filter);
  const page = pageItems(items, shown, newest);
  const ctx = { kind, webUrl, imageHosts: data.imageHosts };
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <label className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            checked={filter.bots}
            onChange={(e) => setFilter({ ...filter, bots: e.target.checked })}
          />
          Bots
        </label>
        <label className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            checked={filter.resolved}
            onChange={(e) => setFilter({ ...filter, resolved: e.target.checked })}
          />
          Resolved and dismissed
        </label>
        <button
          type="button"
          className="od-btn ml-auto"
          aria-pressed={newest}
          onClick={() => setNewest(!newest)}
          title="Order of the conversation"
        >
          {newest ? 'Newest first' : 'Oldest first'}
        </button>
      </div>
      {conversation.truncated && (
        <Banner>
          This conversation is only partially loaded (the first page of each list).{' '}
          <ExternalLink href={requestUrl}>Open it on the forge ↗</ExternalLink>
        </Banner>
      )}
      {items.length === 0 ? (
        <p className="text-xs text-muted">
          {all.length === 0 ? 'No comments yet.' : 'Nothing matches the filters.'}
        </p>
      ) : (
        <>
          {page.hidden > 0 && !newest && (
            <OlderButton hidden={page.hidden} onClick={() => setShown(shown + CONVERSATION_PAGE)} />
          )}
          <ol className="flex flex-col gap-2">
            {page.visible.map((item) => (
              <li key={`${item.kind}:${item.id}`}>
                <ConversationCard item={item} {...ctx} />
              </li>
            ))}
          </ol>
          {page.hidden > 0 && newest && (
            <OlderButton hidden={page.hidden} onClick={() => setShown(shown + CONVERSATION_PAGE)} />
          )}
        </>
      )}
    </div>
  );
}

function OlderButton({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  return (
    <button type="button" className="od-btn my-2" onClick={onClick}>
      Show {Math.min(hidden, CONVERSATION_PAGE)} older ({hidden} hidden)
    </button>
  );
}

interface Ctx {
  kind: 'github' | 'gitlab';
  webUrl: string | null;
  imageHosts: readonly string[];
}

function Time({ at }: { at: string | null }) {
  if (!at) return null;
  return (
    <span className="text-faint" title={absoluteTime(at)}>
      {relativeTime(at)}
    </span>
  );
}

function CommentHeader({
  comment,
  outcome,
  imageHosts,
}: {
  comment: ChangeRequestComment;
  outcome?: string;
  imageHosts: readonly string[];
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs">
      <Avatar actor={comment.author} imageHosts={imageHosts} />
      <ActorName actor={comment.author} />
      {outcome && <span className="text-muted">{outcome}</span>}
      <Time at={comment.createdAt} />
      {comment.editedAt && <span className="text-faint">edited</span>}
      {comment.url && (
        <ExternalLink href={comment.url} className="ml-auto text-faint">
          ↗
        </ExternalLink>
      )}
    </div>
  );
}

function CommentBody({ comment, ctx }: { comment: ChangeRequestComment; ctx: Ctx }) {
  return (
    <div className="mt-1.5">
      <MarkdownBlock
        text={comment.body}
        base={ctx.webUrl}
        kind={ctx.kind}
        imageHosts={ctx.imageHosts}
      />
      {comment.bodyTruncated && (
        <p className="mt-1 text-[11px] text-muted">
          Cut here. <ExternalLink href={comment.url}>Read the rest on the forge ↗</ExternalLink>
        </p>
      )}
    </div>
  );
}

function reviewOutcome(review: ChangeRequestReviewEntry): string {
  const glyph =
    review.state === 'approved' ? '✓ ' : review.state === 'changes_requested' ? '✗ ' : '';
  return `${glyph}${REVIEWER_WORD[review.state]}`;
}

function collapsedLine(item: ConversationItem): string {
  if (item.kind === 'thread') {
    const first = item.thread.comments[0];
    return `Resolved: ${item.thread.path}${item.thread.line !== null ? `:${item.thread.line}` : ''}${first?.author ? ` · ${first.author.login}` : ''}`;
  }
  if (item.kind === 'review')
    return `Dismissed review by ${item.review.author?.login ?? 'unknown'}`;
  return '';
}

function ConversationCard({ item, ...ctx }: { item: ConversationItem } & Ctx) {
  const finished = isFinished(item);
  const [expanded, setExpanded] = useState(!finished);
  const frame = 'rounded-md border border-line bg-surface p-2.5';
  if (!expanded) {
    return (
      <button
        type="button"
        data-testid={TEST_IDS.requestConversationItem}
        data-kind={item.kind}
        data-collapsed="true"
        onClick={() => setExpanded(true)}
        className="flex w-full items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-left text-xs text-muted hover:bg-hover"
      >
        <span aria-hidden="true">▸</span>
        <span className="min-w-0 truncate">{collapsedLine(item)}</span>
        <Time at={item.at || null} />
      </button>
    );
  }
  if (item.kind === 'comment') {
    return (
      <article data-testid={TEST_IDS.requestConversationItem} data-kind="comment" className={frame}>
        <CommentHeader comment={item.comment} imageHosts={ctx.imageHosts} />
        <CommentBody comment={item.comment} ctx={ctx} />
      </article>
    );
  }
  if (item.kind === 'review') {
    return (
      <article data-testid={TEST_IDS.requestConversationItem} data-kind="review" className={frame}>
        <CommentHeader
          comment={item.review}
          outcome={reviewOutcome(item.review)}
          imageHosts={ctx.imageHosts}
        />
        {item.review.body.trim() !== '' && <CommentBody comment={item.review} ctx={ctx} />}
      </article>
    );
  }
  return (
    <ThreadCard
      thread={item.thread}
      ctx={ctx}
      onCollapse={finished ? () => setExpanded(false) : null}
    />
  );
}

function ThreadCard({
  thread,
  ctx,
  onCollapse,
}: {
  thread: ChangeRequestThread;
  ctx: Ctx;
  onCollapse: (() => void) | null;
}) {
  const [root, ...replies] = thread.comments;
  const more = thread.commentsTotal - thread.comments.length;
  return (
    <article
      data-testid={TEST_IDS.requestConversationItem}
      data-kind="thread"
      data-resolved={String(thread.resolved)}
      className="rounded-md border border-line bg-surface p-2.5"
    >
      <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px] text-muted">
        <span className="min-w-0 truncate">
          {thread.path}
          {thread.line !== null && `:${thread.line}`}
        </span>
        {thread.outdated && <span className="font-sans text-faint">Outdated</span>}
        {thread.resolved && <span className="font-sans text-faint">Resolved</span>}
        {onCollapse && (
          <button type="button" className="ml-auto font-sans hover:text-fg" onClick={onCollapse}>
            Collapse
          </button>
        )}
      </div>
      {root && (
        <>
          <CommentHeader comment={root} imageHosts={ctx.imageHosts} />
          <CommentBody comment={root} ctx={ctx} />
        </>
      )}
      {replies.length > 0 && (
        <ol className="mt-2 ml-2 flex flex-col gap-2 border-l border-line pl-3">
          {replies.map((reply) => (
            <li key={reply.id}>
              <CommentHeader comment={reply} imageHosts={ctx.imageHosts} />
              <CommentBody comment={reply} ctx={ctx} />
            </li>
          ))}
        </ol>
      )}
      {more > 0 && (
        <p className="mt-2 ml-5 text-[11px] text-muted">
          {more} more {more === 1 ? 'reply' : 'replies'}.{' '}
          <ExternalLink href={root?.url}>Read on the forge ↗</ExternalLink>
        </p>
      )}
    </article>
  );
}
