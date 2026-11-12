import { TEST_IDS } from '@octopus-diff/contracts';
import { memo, type ReactNode, useEffect, useRef, useState } from 'react';
import {
  countLabel,
  hideToggle,
  isDirtySummary,
  type RowIndicator,
  type RowIndicatorKind,
  rowIndicator,
  type WorktreeRow,
  worktreeLabel,
} from '../lib/model.ts';
import { worktreeSource } from '../lib/source.ts';
import { useNow } from '../lib/ticker.ts';
import { RECENT_MS, relativeTime, shortAge } from '../lib/time.ts';
import { ChangeRequestGlyph, ChangeRequestHoverBlock } from './ChangeRequest.tsx';
import { NotListedMarker } from './NotListedMarker.tsx';
import { DefaultBranchChip, RowChips } from './WorktreeChips.tsx';

/**
 * A worktree row of the sidebar's flat list (#13, redesigned in #14) and what belongs to it: the
 * state indicator, the two lines, the hover card and the hide / show action. Moved out of `Sidebar.tsx` with the virtual list.
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
 * The state indicator before the branch name (#14): one small shape per `RowIndicatorKind`, so a
 * row says what it is before a word is read, and colour is never the only difference (a filled dot,
 * a ring, a triangle, a tick, a dashed ring, the request glyphs, a cross). Decorative: the row's
 * status sentence is read out instead (`aria-hidden` here).
 */
function Glyph({ className, children }: { className: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
    >
      {children}
    </svg>
  );
}

function StateGlyph({ kind }: { kind: RowIndicatorKind }) {
  switch (kind) {
    case 'review':
      return (
        <Glyph className="text-accent">
          <circle cx="8" cy="8" r="4" fill="currentColor" stroke="none" />
        </Glyph>
      );
    case 'changed':
      return (
        <Glyph className="text-accent">
          <circle cx="8" cy="8" r="3.6" />
        </Glyph>
      );
    case 'conflicts':
    case 'operation':
      return (
        <Glyph className={kind === 'conflicts' ? 'text-danger' : 'text-warn'}>
          <path d="M8 2.5 14 13H2z" />
          <path d="M8 6.5v3M8 11.4v.1" />
        </Glyph>
      );
    case 'missing':
    case 'error':
      return (
        <Glyph className="text-danger">
          <circle cx="8" cy="8" r="5.5" />
          <path d="m5.8 5.8 4.4 4.4M10.2 5.8 5.8 10.2" />
        </Glyph>
      );
    case 'request':
      return <ChangeRequestGlyph look="open" />;
    case 'merged':
      return <ChangeRequestGlyph look="merged" />;
    case 'closed':
      return <ChangeRequestGlyph look="closed" />;
    case 'reviewOff':
      return (
        <Glyph className="text-faint">
          <circle cx="8" cy="8" r="4.5" strokeDasharray="2 2.2" />
        </Glyph>
      );
    case 'reviewed':
      return (
        <Glyph className="text-faint">
          <path d="m3.8 8.4 2.8 2.8 5.6-6.2" />
        </Glyph>
      );
    case 'notListed':
      // The reviewed tick with a dot: reviewed as far as the list goes, files not listed (#43).
      return (
        <Glyph className="text-warn">
          <path d="m2.8 8.4 2.8 2.8 4.6-5.2" />
          <circle cx="13" cy="4" r="1.6" fill="currentColor" stroke="none" />
        </Glyph>
      );
    case 'loading':
      return (
        <Glyph className="text-faint">
          <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2" />
        </Glyph>
      );
    default:
      // clean: the faintest mark, there to hold the column, not to say anything.
      return (
        <Glyph className="text-line-strong">
          <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
        </Glyph>
      );
  }
}

/** The text a status says on the right of the branch line (`merged`, `3 conflicts`, ...), or null. */
function statusWord(
  row: WorktreeRow,
  indicator: RowIndicator,
): { text: string; danger: boolean } | null {
  switch (indicator.kind) {
    case 'missing':
    case 'error':
      return { text: indicator.kind, danger: true };
    case 'loading':
      return { text: '…', danger: false };
    case 'conflicts':
      return { text: indicator.label, danger: true };
    case 'operation':
      return { text: row.summary?.inProgress ?? 'operation', danger: false };
    case 'merged':
    case 'closed':
      return { text: indicator.kind, danger: false };
    default:
      return null;
  }
}

/**
 * The status slot at the right of the branch line: `N conflicts` / the operation in progress for
 * blocked work, `N commits ·` and the unreviewed-files pill (the one filled shape, always the
 * **own** count, never merge noise, DECISIONS #205; clamped to `99+`, exact in the tooltip), one
 * word for finished or unreadable work, `changes requested` for an open request that waits on
 * its author, and the `review off` badge. Reviewed and clean rows say nothing here: their
 * indicator is enough. Visual only: the row's `sr-only` sentence carries it for screen readers.
 */
function RowStatus({ row, indicator }: { row: WorktreeRow; indicator: RowIndicator }) {
  const word = statusWord(row, indicator);
  const merged = indicator.kind === 'merged' || indicator.kind === 'closed';
  const files = row.summary?.changedFiles ?? 0;
  return (
    <span aria-hidden="true" className="ml-auto flex shrink-0 items-center gap-1.5 text-[11px]">
      {!row.review.enabled && <ReviewOffBadge row={row} />}
      {indicator.kind === 'review' && row.stage === 'review' && row.newCommits > 0 && (
        <span className="text-muted" title="Commits after the review bookmark">
          {plural(row.newCommits, 'commit')} ·
        </span>
      )}
      {row.unreviewed > 0 && (
        <span className="od-pill" title={`${row.unreviewed} unreviewed`}>
          {countLabel(row.unreviewed)}
        </span>
      )}
      <NotListedMarker omission={row.summary?.untrackedOmitted} />
      {word && (
        <span className={word.danger ? 'text-danger' : merged ? 'text-faint' : 'text-warn'}>
          {word.text}
          {merged && files > 0 ? ` · ${plural(files, 'file')}` : ''}
        </span>
      )}
      {indicator.kind === 'request' && row.request?.review === 'changes_requested' && (
        // Short in a narrow sidebar (container query), so it cannot squeeze the branch away.
        <span className="text-warn" title="A reviewer asked for changes">
          <span className="@max-[15rem]/row:hidden">changes requested</span>
          <span className="hidden @max-[15rem]/row:inline">changes</span>
        </span>
      )}
    </span>
  );
}

/** The facts of the second line (and the hover card): files, lines, ahead/behind. */
function rowFacts(row: WorktreeRow): { files?: string; lines?: [number, number]; sync?: string } {
  const s = row.summary;
  if (!s) return {};
  return {
    ...(isDirtySummary(s) ? { files: plural(s.changedFiles, 'file') } : {}),
    ...(s.additions > 0 || s.deletions > 0
      ? { lines: [s.additions, s.deletions] as [number, number] }
      : {}),
    ...(s.ahead !== null && s.behind !== null && s.ahead + s.behind > 0
      ? {
          sync: [s.ahead > 0 ? `↑${s.ahead}` : '', s.behind > 0 ? `↓${s.behind}` : '']
            .filter(Boolean)
            .join(' '),
        }
      : {}),
  };
}

/** The age of the last change: `now` (accent, with a live dot) for a change a moment ago, else `7m`, `3h`, `2d`. */
function RowAge({ at }: { at: string | null | undefined }) {
  const now = useNow();
  const age = shortAge(at, now);
  if (age === null) return null;
  const recent = at !== null && at !== undefined && now - Date.parse(at) < RECENT_MS;
  return (
    <span
      aria-hidden="true"
      data-testid="row-age"
      data-recent={String(recent)}
      title={`Last change ${relativeTime(at, now)}`}
      className={`flex shrink-0 items-center gap-1 tabular-nums ${recent ? 'text-accent' : 'text-faint'}`}
    >
      {recent && <span className="size-1.5 rounded-full bg-accent" />}
      {age}
    </span>
  );
}

/**
 * The second line: the repository (glyph under the state indicator, name truncating at a bounded
 * share of the line), then what matters about the work: ahead / behind, files when no pill counts
 * them, the "N deleted" chip and the request chip, and the age at the far end. It wraps instead
 * of clipping, so a crowded row grows (rows are measured) rather than losing a fact.
 */
function RowSecondLine({ row }: { row: WorktreeRow }) {
  const facts = rowFacts(row);
  const { summary } = row;
  // The pill already counts the files to review; otherwise say how many files changed.
  const files = row.unreviewed > 0 ? undefined : facts.files;
  return (
    <span className="flex w-full items-start gap-1.5 text-[11px] text-muted">
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className="flex max-w-[72%] min-w-0 items-center gap-1.5">
          <RepoIcon />
          <span data-testid="row-repo" title={row.project.name} className="min-w-0 truncate">
            {row.project.name}
          </span>
        </span>
        {facts.sync && (
          <span
            className="shrink-0 font-mono"
            title={
              summary?.aheadBehindRef ? `${facts.sync} vs ${summary.aheadBehindRef}` : facts.sync
            }
          >
            <span aria-hidden="true">{facts.sync}</span>
            <span className="sr-only">
              {[
                summary?.ahead ? `${summary.ahead} ahead` : '',
                summary?.behind ? `${summary.behind} behind` : '',
              ]
                .filter(Boolean)
                .join(', ')}
            </span>
          </span>
        )}
        {files && <span className="shrink-0">{files}</span>}
        <RowChips row={row} compact />
      </span>
      <RowAge at={summary?.activityAt} />
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
  const indicator = rowIndicator(row);
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
              : indicator.label}
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
 * One worktree as a two-line card (#14, after T3 Code's thread row: indicator, title, hover
 * action). Line 1: the state indicator, the branch and the status slot (conflicts, the unreviewed
 * pill, merged, ...). Line 2: the repository, then ahead / behind, files, "N deleted", the request
 * chip and the age. The accessible name is the button's own content: branch, a `sr-only` sentence
 * with the status, then the repository and facts; the visual status and facts are `aria-hidden`.
 *
 * Actions by state: idle shows nothing extra; hover or keyboard focus (on the row or its action)
 * lays the hide / show button over the end of line 2 (the age and chips under it stay readable
 * through its fade, and nothing shifts); selected is a filled row; right-click or the menu key
 * opens the full menu. Rendered inside the virtual list's row, so it never positions itself.
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
  const indicator = rowIndicator(row);
  const label = worktreeLabel(worktree);
  const fade = selected ? 'var(--od-selected)' : 'var(--od-hover)';
  return (
    <div
      className="group/wt @container/row relative"
      onPointerEnter={hover.onPointerEnter}
      onPointerLeave={hover.onPointerLeave}
      onPointerDown={hover.onPointerDown}
    >
      <button
        type="button"
        {...rowAttributes(row, selected)}
        data-indicator={indicator.kind}
        onClick={() => onSelect(worktree.id)}
        onContextMenu={(e) => onMenu(e, row)}
        className={`flex w-full flex-col gap-0.5 rounded-md py-1.5 pr-2 pl-2 text-left ${
          selected ? 'bg-selected text-fg' : 'hover:bg-hover'
        } ${row.hidden && !selected ? 'text-muted hover:text-fg' : ''}`}
      >
        <span className="flex w-full items-center gap-1.5">
          <span title={indicator.label} className="flex">
            <StateGlyph kind={indicator.kind} />
          </span>
          <span
            data-testid="row-branch"
            title={label}
            className={`min-w-0 truncate ${worktree.branch ? '' : 'italic'}`}
          >
            {label}
          </span>
          <DefaultBranchChip row={row} />
          <RowStatus row={row} indicator={indicator} />
        </span>
        <RowSecondLine row={row} />
        <span className="sr-only" data-testid="row-status-text">
          {indicator.label}
          {!row.review.enabled && indicator.kind !== 'reviewOff' ? ', review off' : ''}
          {indicator.kind !== 'notListed' && row.summary?.untrackedOmitted
            ? `, ${row.summary.untrackedOmitted.count} untracked files not listed`
            : ''}
          {row.hidden ? ', hidden' : ''}
        </span>
      </button>
      {canHide && (
        <span
          className="absolute right-1.5 bottom-1 flex h-5 items-center rounded-sm pl-5 opacity-0 group-focus-within/wt:opacity-100 group-hover/wt:opacity-100"
          style={{ background: `linear-gradient(to left, ${fade} 72%, transparent)` }}
        >
          <button
            type="button"
            aria-label={hideLabel(row)}
            title={hideLabel(row)}
            onClick={() => onHide(row)}
            className="flex h-5 items-center gap-1 rounded-sm px-1 text-[11px] text-muted hover:bg-raised hover:text-fg"
          >
            {row.hidden ? <UndoIcon /> : <HideIcon />}
            {row.hidden ? 'Show' : 'Hide'}
          </button>
        </span>
      )}
      {hover.at && <RowHoverCard row={row} at={hover.at} />}
    </div>
  );
});

/** A repository: the branch glyph, one weight, `currentColor`. */
export function RepoIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
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
