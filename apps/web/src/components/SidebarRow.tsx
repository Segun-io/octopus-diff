import { TEST_IDS } from '@octopus-diff/contracts';
import { memo, type ReactNode, useEffect, useRef, useState } from 'react';
import {
  hideToggle,
  isDirtySummary,
  type SettledWord,
  settledWord,
  type WorktreeRow,
  worktreeLabel,
} from '../lib/model.ts';
import { worktreeSource } from '../lib/source.ts';
import { ChangeRequestHoverBlock } from './ChangeRequest.tsx';
import { DefaultBranchChip, RowChips } from './WorktreeChips.tsx';

/**
 * A worktree row of the sidebar's flat list (#13) and what belongs to it: the status slot, meta
 * line, hover card and the hide / show action. Moved out of `Sidebar.tsx` with the virtual list.
 */

function attr(value: number | null | undefined): string {
  return value === null || value === undefined ? '' : String(value);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export type RowEvent = React.MouseEvent | React.KeyboardEvent;

/** Where a worktree row is listed: the flat list, or the closed "Hidden" section at the end. */
export type RowSection = 'flat' | 'hidden';

export interface RowProps {
  row: WorktreeRow;
  selected: boolean;
  onSelect: (id: string) => void;
  onMenu: (event: RowEvent, row: WorktreeRow) => void;
  onHide: (row: WorktreeRow) => void;
}

/** The data attributes the e2e suite reads (TEST_IDS.worktreeItem); the same in every variant. */
function rowAttributes(row: WorktreeRow, selected: boolean) {
  const { worktree, summary } = row;
  const counts = summary?.counts;
  const source = worktree.isMain ? null : worktreeSource(worktree.path);
  return {
    'data-testid': TEST_IDS.worktreeItem,
    'data-worktree-id': worktree.id,
    'data-project-id': worktree.projectId,
    'data-project-name': row.project.name,
    'data-branch': worktree.branch ?? '',
    'data-dirty': String(isDirtySummary(summary)),
    'data-ahead': attr(summary?.ahead),
    'data-behind': attr(summary?.behind),
    'data-staged': attr(counts?.staged ?? 0),
    'data-unstaged': attr(counts?.unstaged ?? 0),
    'data-untracked': attr(counts?.untracked ?? 0),
    'data-conflicted': attr(counts?.conflicted ?? 0),
    'data-additions': attr(summary?.additions ?? 0),
    'data-deletions': attr(summary?.deletions ?? 0),
    'data-main': String(worktree.isMain),
    'data-source': source?.id ?? '',
    'data-state': row.state,
    'data-stage': row.stage,
    'data-unreviewed': String(row.unreviewed),
    'data-commits': String(row.newCommits),
    'data-pinned': String(row.pinned),
    'data-hidden': String(row.hidden),
    'aria-current': selected ? ('true' as const) : undefined,
  };
}

function ReviewOffBadge({ row }: { row: WorktreeRow }) {
  return (
    <span
      data-testid={TEST_IDS.reviewOffBadge}
      data-source={row.review.source}
      className="od-chip shrink-0"
      title={`Review off (from ${row.review.source})`}
    >
      review off
    </span>
  );
}

/**
 * The words a quiet row says: only what is informative. A row that needs no review (reviewed,
 * clean) gets no special state (#13); merged, closed, review off, missing, failed and still
 * loading do say so.
 */
function quietWord(row: WorktreeRow): SettledWord | null {
  const word = settledWord(row);
  return word === 'reviewed' || word === 'clean' || word === 'review off' ? null : word;
}

/**
 * The status slot at the top right of a card: `N commits ·` and the unreviewed-files pill (the one
 * filled shape, always the **own** count: files that came from a merge are wrapped, not counted,
 * DECISIONS #205) for To review, `N conflicts` for blocked work, an open request, or one word when
 * there is something to say. Hover slides it left to make room for the action.
 */
function RowStatus({ row, makeRoom }: { row: WorktreeRow; makeRoom: boolean }) {
  const counts = row.summary?.counts;
  const word = quietWord(row);
  return (
    <span
      className={`ml-auto flex shrink-0 items-center gap-1.5 text-[11px] ${
        makeRoom ? 'group-focus-within/wt:mr-14 group-hover/wt:mr-14' : ''
      }`}
    >
      {!row.review.enabled && <ReviewOffBadge row={row} />}
      {counts && counts.conflicted > 0 && (
        <span className="text-danger">{plural(counts.conflicted, 'conflict')}</span>
      )}
      {row.stage === 'review' && row.newCommits > 0 && (
        <span className="text-muted" title="Commits after the review bookmark">
          {plural(row.newCommits, 'commit')}
          {row.unreviewed > 0 ? ' ·' : ''}
        </span>
      )}
      {row.unreviewed > 0 && (
        <span className="od-pill" title={`${row.unreviewed} unreviewed`}>
          {row.unreviewed}
        </span>
      )}
      {row.stage === 'inPR' && row.request ? (
        <span
          className={row.request.review === 'changes_requested' ? 'text-warn' : 'text-faint'}
          title="Open request, nothing new to review"
        >
          {inPrText(row.request)}
        </span>
      ) : (
        word && (
          <span className={word === 'missing' || word === 'error' ? 'text-danger' : 'text-faint'}>
            {word === 'loading' ? '…' : word}
            {(word === 'merged' || word === 'closed') && (row.summary?.changedFiles ?? 0) > 0
              ? ` · ${plural(row.summary?.changedFiles ?? 0, 'file')}`
              : ''}
          </span>
        )
      )}
    </span>
  );
}

/** `#42 · checks ✓` / `changes requested` (one chip's worth of words for an In PR row). */
function inPrText(cr: NonNullable<WorktreeRow['request']>): string {
  const ref = `${cr.kind === 'github' ? '#' : '!'}${cr.number}`;
  if (cr.review === 'changes_requested') return `${ref} · changes requested`;
  const checks = cr.checks?.state;
  if (checks === 'success') return `${ref} · checks ✓`;
  if (checks === 'failure') return `${ref} · checks ✗`;
  if (checks === 'pending') return `${ref} · checks …`;
  return ref;
}

/** The facts of the meta line (and the hover card): files, lines, ahead/behind. */
function rowFacts(row: WorktreeRow): { files?: string; lines?: [number, number]; sync?: string } {
  const s = row.summary;
  if (!s) return {};
  return {
    ...(isDirtySummary(s) ? { files: plural(s.changedFiles, 'file') } : {}),
    ...(s.additions > 0 || s.deletions > 0
      ? { lines: [s.additions, s.deletions] as [number, number] }
      : {}),
    ...(s.ahead !== null && s.behind !== null && s.ahead + s.behind > 0
      ? { sync: `↑${s.ahead} ↓${s.behind}` }
      : {}),
  };
}

/** The meta line under the branch: chips, then the facts in mono. Omitted when it would be empty. */
function RowMeta({ row }: { row: WorktreeRow }) {
  const { worktree, summary, project } = row;
  const facts = rowFacts(row);
  const hasChip =
    (worktree.isMain && worktree.branch !== project.defaultBranch) ||
    (!worktree.isMain && worktreeSource(worktree.path) !== null) ||
    summary?.inProgress;
  if (!hasChip && !facts.files && !facts.lines && !facts.sync) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden font-mono text-[11px] whitespace-nowrap text-muted">
      <RowChips row={row} />
      {facts.files && <span>{facts.files}</span>}
      {facts.lines && (
        <span>
          <span className="text-add">+{facts.lines[0]}</span>{' '}
          <span className="text-del">−{facts.lines[1]}</span>
        </span>
      )}
      {facts.sync && (
        <span title={summary?.aheadBehindRef ? `vs ${summary.aheadBehindRef}` : undefined}>
          {facts.sync}
        </span>
      )}
    </span>
  );
}

/** Shows a card after a short hover, anchored to the right of the row (T3 Code's row tooltip). */
function useHoverCard(delayMs = 450) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const hide = () => {
    clear();
    setAt(null);
  };
  // Unmount while a timer is pending (a row that settles mid-hover): drop it.
  useEffect(() => {
    const pending = timer;
    return () => {
      if (pending.current) clearTimeout(pending.current);
    };
  }, []);
  const onPointerEnter = (e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType !== 'mouse') return;
    const rect = e.currentTarget.getBoundingClientRect();
    clear();
    timer.current = setTimeout(() => {
      setAt({ x: rect.right + 8, y: Math.max(8, Math.min(rect.top, window.innerHeight - 380)) });
    }, delayMs);
  };
  return { at, onPointerEnter, onPointerLeave: hide, onPointerDown: hide };
}

/**
 * The details a row does not show: branch, project, path, source, facts, review policy and the
 * manual settle. Fixed-positioned so the sidebar's scroll clip cannot cut it off.
 */
function RowHoverCard({ row, at }: { row: WorktreeRow; at: { x: number; y: number } }) {
  const { worktree, summary, error, project, review } = row;
  const source = worktree.isMain ? null : worktreeSource(worktree.path);
  const facts = rowFacts(row);
  const word = settledWord(row);
  const line = (label: string, value: ReactNode) => (
    <div className="flex gap-2">
      <dt className="w-14 shrink-0 text-faint">{label}</dt>
      <dd className="min-w-0 flex-1 break-all">{value}</dd>
    </div>
  );
  return (
    <div
      role="tooltip"
      className="od-overlay od-fade-in pointer-events-none fixed z-50 w-[320px] rounded-md p-2.5 text-xs text-fg"
      style={{ left: at.x, top: at.y }}
    >
      <div className="mb-1.5 flex items-baseline gap-1.5">
        <span className="min-w-0 truncate font-medium">{worktreeLabel(worktree)}</span>
        <span className="ml-auto shrink-0 text-[11px] text-muted">
          {row.state === 'blocked'
            ? 'blocked'
            : row.state === 'attention'
              ? toReviewText(row)
              : word}
        </span>
      </div>
      <dl className="flex flex-col gap-0.5">
        {line('Project', project.name)}
        {line('Path', <span className="font-mono text-[11px]">{worktree.path}</span>)}
        {source && line('Source', source.title)}
        {worktree.isMain && line('Checkout', 'main checkout')}
        {summary?.inProgress && line('Operation', `${summary.inProgress} in progress`)}
        {summary &&
          (facts.files || facts.lines) &&
          line(
            'Changes',
            <span className="font-mono text-[11px]">
              {facts.files ?? 'no files'}
              {facts.lines && (
                <>
                  {' '}
                  <span className="text-add">+{facts.lines[0]}</span>{' '}
                  <span className="text-del">−{facts.lines[1]}</span>
                </>
              )}
            </span>,
          )}
        {summary &&
          summary.ahead !== null &&
          summary.behind !== null &&
          line(
            'Sync',
            <span className="font-mono text-[11px]">
              ↑{summary.ahead} ↓{summary.behind}
              {summary.aheadBehindRef ? ` vs ${summary.aheadBehindRef}` : ''}
            </span>,
          )}
        {line('Review', review.enabled ? 'on' : `off (from ${review.source})`)}
        {summary?.review &&
          line(
            'Reviewed',
            <span className="font-mono text-[11px]">
              {summary.review.bookmark
                ? `up to ${summary.review.bookmark.slice(0, 7)}`
                : 'no commits yet'}
              {summary.review.historyRewritten ? ' · history rewritten' : ''}
            </span>,
          )}
        {row.hidden && line('Hidden', 'until it changes')}
        {error && line('Error', <span className="text-danger">{error.message}</span>)}
      </dl>
      <ChangeRequestHoverBlock worktreeId={worktree.id} />
    </div>
  );
}

/** `2 commits · 3 files` (the To review text of the hover card). */
function toReviewText(row: WorktreeRow): string {
  // Review state not computed yet (#10): opening the worktree or its project computes it.
  if (row.stage === 'changed') return 'changes (open to review)';
  const parts: string[] = [];
  if (row.newCommits > 0) parts.push(plural(row.newCommits, 'commit'));
  if (row.unreviewed > 0) parts.push(plural(row.unreviewed, 'file'));
  return parts.length > 0 ? `to review: ${parts.join(' · ')}` : 'to review';
}

/** The label of the hover action and of its menu item. */
export function hideLabel(row: Pick<WorktreeRow, 'hidden'>): string {
  return row.hidden ? 'Show again' : 'Hide until it changes';
}

/**
 * One worktree as a card (T3 Code's row anatomy), the same everywhere in the flat list: the
 * repository (glyph and name) with the status slot, then the branch, then the meta line. Hover or
 * focus shows the hide / show action beside the status slot and, after a moment, the hover card.
 * Right-click (or the keyboard's menu key) opens the actions; there is no `⋯`. Rendered inside
 * the virtual list's row, so it never positions itself.
 */
export const WorktreeItem = memo(function WorktreeItem({
  row,
  selected,
  onSelect,
  onMenu,
  onHide,
}: RowProps) {
  const { worktree } = row;
  const canHide = hideToggle(row) !== undefined;
  const hover = useHoverCard();
  return (
    <div
      className="group/wt relative"
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
      onPointerDown={hover.onPointerDown}
    >
      <button
        type="button"
        {...rowAttributes(row, selected)}
        onClick={() => onSelect(worktree.id)}
        onContextMenu={(e) => onMenu(e, row)}
        className={`flex w-full flex-col gap-0.5 rounded-md py-1.5 pr-2 pl-2 text-left ${
          selected ? 'bg-selected text-fg' : 'hover:bg-hover'
        } ${row.hidden && !selected ? 'text-muted hover:text-fg' : ''}`}
      >
        <span className="flex w-full items-center gap-1.5 text-[11px] text-muted">
          <RepoIcon />
          <span data-testid="row-repo" className="min-w-0 truncate">
            {row.project.name}
          </span>
          <RowStatus row={row} makeRoom={canHide} />
        </span>
        <span className="relative flex w-full items-center gap-1.5">
          <span className={`min-w-0 truncate ${worktree.branch ? '' : 'italic'}`}>
            {worktreeLabel(worktree)}
          </span>
          <DefaultBranchChip row={row} />
        </span>
        <RowMeta row={row} />
      </button>
      <span className="absolute top-1.5 right-1.5 flex h-4 items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/wt:opacity-100">
        {canHide && (
          <button
            type="button"
            aria-label={hideLabel(row)}
            onClick={() => onHide(row)}
            className="flex h-5 items-center gap-1 rounded-sm px-1 text-[11px] text-muted hover:bg-raised hover:text-fg"
          >
            {row.hidden ? <UndoIcon /> : <HideIcon />}
            {row.hidden ? 'Show' : 'Hide'}
          </button>
        )}
      </span>
      {hover.at && <RowHoverCard row={row} at={hover.at} />}
    </div>
  );
});

/** A repository: the branch glyph, one weight, `currentColor`. */
export function RepoIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      aria-hidden="true"
      className="shrink-0 text-muted"
    >
      <circle cx="4.5" cy="3.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4.5" cy="12.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="11.5" cy="5.5" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M4.5 5.1v5.8M11.5 7.1c0 2.2-2.5 2.6-4.5 2.9-1 .2-2 .5-2.5 1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** An eye with a stroke: hide until it changes. */
function HideIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8zM2.5 13.5l11-11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M5.5 3.5 2.5 6.5l3 3M2.5 6.5H10a3.5 3.5 0 0 1 0 7H7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
