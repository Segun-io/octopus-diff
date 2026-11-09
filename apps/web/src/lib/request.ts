import type {
  ChangeRequestCheck,
  ChangeRequestComment,
  ChangeRequestConversation,
  ChangeRequestDetail,
  ChangeRequestReviewEntry,
  ChangeRequestThread,
  CheckStatus,
  ForgeActor,
  ReviewerState,
} from '@octopus-diff/contracts';
import { visibleBody } from './markdown.ts';

/**
 * Presentation logic of the Request tab, after T3 Code's `pullRequestDetail.logic.ts` (MIT;
 * wording and grouping adapted): checks grouping and the status line, review words, the
 * conversation list (filters, ordering, paging) and the timeline.
 */

export const CHECK_WORD: Record<CheckStatus, string> = {
  success: 'passed',
  failure: 'failed',
  pending: 'running',
  cancelled: 'cancelled',
  skipped: 'skipped',
  neutral: 'neutral',
  action_required: 'action required',
};

/** Hue of a check's dot: add / danger / warn only; others stay ink (IDENTITY §4). */
export const CHECK_TONE: Record<CheckStatus, string> = {
  success: 'bg-add',
  failure: 'bg-danger',
  cancelled: 'bg-danger',
  pending: 'bg-warn',
  action_required: 'bg-warn',
  skipped: 'bg-faint',
  neutral: 'bg-faint',
};

export function groupChecks(checks: readonly ChangeRequestCheck[]) {
  return {
    attention: checks.filter((c) => ['failure', 'cancelled', 'action_required'].includes(c.status)),
    running: checks.filter((c) => c.status === 'pending'),
    completed: checks.filter((c) => ['success', 'skipped', 'neutral'].includes(c.status)),
  };
}

/** "All checks passed", "2 of 12 failing", "3 of 12 running · 1 failed" (T3's wording). */
export function describeChecks(checks: readonly ChangeRequestCheck[]): string {
  if (checks.length === 0) return 'No checks reported';
  const n = checks.length;
  const failed = checks.filter((c) => c.status === 'failure' || c.status === 'cancelled').length;
  const pending = checks.filter((c) => c.status === 'pending').length;
  const action = checks.filter((c) => c.status === 'action_required').length;
  const passed = checks.filter((c) => c.status === 'success').length;
  const parts: string[] = [];
  if (pending > 0) parts.push(`${pending} of ${n} running`);
  if (action > 0) parts.push(`${action} of ${n} awaiting action`);
  if (failed > 0) parts.push(parts.length > 0 ? `${failed} failed` : `${failed} of ${n} failing`);
  if (parts.length === 0) return passed === n ? 'All checks passed' : `${passed} of ${n} passing`;
  return parts.join(' · ');
}

/** The tone of the checks status line: the worst state among the checks. */
export function checksTone(checks: readonly ChangeRequestCheck[]): CheckStatus | null {
  if (checks.length === 0) return null;
  const g = groupChecks(checks);
  if (g.attention.some((c) => c.status !== 'action_required')) return 'failure';
  if (g.running.length > 0 || g.attention.length > 0) return 'pending';
  return 'success';
}

/** Checks are still moving: the tab polls only while this is true (and the tab is visible). */
export function checksRunning(detail: Pick<ChangeRequestDetail, 'checkList' | 'state'>): boolean {
  return (
    detail.state === 'open' &&
    detail.checkList.some((c) => c.status === 'pending' || c.status === 'action_required')
  );
}

export const REVIEWER_WORD: Record<ReviewerState, string> = {
  approved: 'approved',
  changes_requested: 'changes requested',
  commented: 'commented',
  dismissed: 'dismissed',
  pending: 'review requested',
};

/** Initials for an avatar placeholder (`Ada Lovelace` -> `AL`, `octo-cat` -> `OC`). */
export function initials(actor: Pick<ForgeActor, 'login' | 'name'> | null): string {
  const source = actor?.name?.trim() || actor?.login.replace(/\[bot\]$/, '') || '?';
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const letters =
    words.length >= 2 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : source.slice(0, 2);
  return letters.toUpperCase();
}

export function isBot(actor: ForgeActor | null): boolean {
  return actor?.bot === true || (actor?.login.endsWith('[bot]') ?? false);
}

// --- conversation ---------------------------------------------------------------------------

export type ConversationItem =
  | { kind: 'comment'; id: string; at: string; comment: ChangeRequestComment }
  | { kind: 'review'; id: string; at: string; review: ChangeRequestReviewEntry }
  | { kind: 'thread'; id: string; at: string; thread: ChangeRequestThread };

/** Comments, reviews with a verdict or text, and threads, as one list. */
export function conversationItems(conversation: ChangeRequestConversation): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const comment of conversation.comments) {
    if (visibleBody(comment.body) === null) continue;
    items.push({ kind: 'comment', id: comment.id, at: comment.createdAt ?? '', comment });
  }
  for (const review of conversation.reviews) {
    items.push({ kind: 'review', id: review.id, at: review.createdAt ?? '', review });
  }
  for (const thread of conversation.threads) {
    const first = thread.comments[0];
    items.push({ kind: 'thread', id: thread.id, at: first?.createdAt ?? '', thread });
  }
  return items;
}

export function itemAuthor(item: ConversationItem): ForgeActor | null {
  switch (item.kind) {
    case 'comment':
      return item.comment.author;
    case 'review':
      return item.review.author;
    case 'thread':
      return item.thread.comments[0]?.author ?? null;
  }
}

/** Finished conversations collapse to one line: resolved threads and dismissed reviews. */
export function isFinished(item: ConversationItem): boolean {
  return (
    (item.kind === 'thread' && item.thread.resolved) ||
    (item.kind === 'review' && item.review.state === 'dismissed')
  );
}

export interface ConversationFilter {
  bots: boolean;
  resolved: boolean;
}

export const DEFAULT_CONVERSATION_FILTER: ConversationFilter = { bots: true, resolved: true };

export function filterItems(
  items: readonly ConversationItem[],
  filter: ConversationFilter,
): ConversationItem[] {
  return items.filter(
    (item) => (filter.bots || !isBot(itemAuthor(item))) && (filter.resolved || !isFinished(item)),
  );
}

export function orderItems<T extends { at: string }>(items: readonly T[], newest: boolean): T[] {
  const sorted = [...items].sort((a, b) => a.at.localeCompare(b.at));
  return newest ? sorted.reverse() : sorted;
}

export const CONVERSATION_PAGE = 10;

/**
 * The `shown` most recent items, in the chosen order, and how many older ones are hidden ("Show N
 * older"). Older items are hidden first whatever the order.
 */
export function pageItems<T extends { at: string }>(
  items: readonly T[],
  shown: number,
  newest: boolean,
): { visible: T[]; hidden: number } {
  const oldestFirst = orderItems(items, false);
  const hidden = Math.max(0, oldestFirst.length - shown);
  const kept = oldestFirst.slice(hidden);
  return { visible: newest ? kept.reverse() : kept, hidden };
}

// --- timeline -------------------------------------------------------------------------------

export type TimelineEvent =
  | { kind: 'opened'; id: string; at: string; actor: string | null }
  | { kind: 'commit'; id: string; at: string; sha: string; headline: string; actor: string | null }
  | { kind: 'comment'; id: string; at: string; comment: ChangeRequestComment }
  | { kind: 'review'; id: string; at: string; review: ChangeRequestReviewEntry }
  | { kind: 'thread'; id: string; at: string; thread: ChangeRequestThread }
  | { kind: 'merged' | 'closed'; id: string; at: string; actor: string | null };

/** T3's `buildPullRequestTimeline`, read-only: lifecycle, commits and the conversation. */
export function buildTimeline(
  detail: ChangeRequestDetail,
  conversation: ChangeRequestConversation | null,
  newest: boolean,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  if (detail.createdAt) {
    events.push({ kind: 'opened', id: 'opened', at: detail.createdAt, actor: detail.author });
  }
  for (const commit of detail.commits) {
    if (!commit.committedAt) continue;
    events.push({
      kind: 'commit',
      id: `commit:${commit.sha}`,
      at: commit.committedAt,
      sha: commit.sha,
      headline: commit.headline,
      actor: commit.authorLogin ?? commit.authorName,
    });
  }
  if (conversation) {
    for (const item of conversationItems(conversation)) {
      if (!item.at) continue;
      if (item.kind === 'comment') events.push({ ...item, kind: 'comment' });
      else if (item.kind === 'review') events.push({ ...item, kind: 'review' });
      else events.push({ ...item, kind: 'thread' });
    }
  }
  if (detail.state === 'merged' && (detail.mergedAt ?? detail.closedAt)) {
    events.push({
      kind: 'merged',
      id: 'merged',
      at: (detail.mergedAt ?? detail.closedAt) as string,
      actor: detail.mergedBy?.login ?? null,
    });
  } else if (detail.state === 'closed' && detail.closedAt) {
    events.push({ kind: 'closed', id: 'closed', at: detail.closedAt, actor: null });
  }
  return orderItems(events, newest);
}
