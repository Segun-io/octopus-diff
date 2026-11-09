import { type ChangeRequest, TEST_IDS, type WorktreeForge } from '@octopus-diff/contracts';
import type { ReactNode } from 'react';
import { useForgeIndex } from '../api/forges.ts';
import {
  type ChangeRequestLook,
  changeRequestTitle,
  checksSummary,
  LOOK_TONE,
  LOOK_WORD,
  lookOf,
  MERGE_WORD,
  REVIEW_WORD,
  shortRef,
  sizeSummary,
} from '../lib/forge.ts';
import { absoluteTime, relativeTime } from '../lib/time.ts';

/**
 * Pull/merge request glyphs, chip (sidebar rows) and badge (toolbar link). Shapes after T3 Code's
 * PR icons (open / draft / merged / closed); drawn here as inline SVG like the other icons.
 */
function GlyphSvg({ children }: { children: ReactNode }) {
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
      className="shrink-0 self-center"
    >
      {children}
    </svg>
  );
}

export function ChangeRequestGlyph({ look }: { look: ChangeRequestLook }) {
  if (look === 'merged') {
    return (
      <GlyphSvg>
        <circle cx="4" cy="3.5" r="1.75" />
        <circle cx="4" cy="12.5" r="1.75" />
        <circle cx="12" cy="8.5" r="1.75" />
        <path d="M4 5.25v5.5M4 5.25c0 3.25 2.5 3.25 6.25 3.25" />
      </GlyphSvg>
    );
  }
  return (
    <GlyphSvg>
      <circle cx="4" cy="3.5" r="1.75" />
      <circle cx="4" cy="12.5" r="1.75" />
      <path d="M4 5.25v5.5" />
      <circle cx="12" cy="12.5" r="1.75" />
      {look === 'open' && <path d="M12 10.75V6.5a2 2 0 0 0-2-2H7.5M9 3 7.5 4.5 9 6" />}
      {look === 'draft' && <path d="M12 9v.01M12 6.5v.01M12 4v.01" />}
      {look === 'closed' && <path d="M12 10.75V8M10.5 3l3 3M13.5 3l-3 3" />}
    </GlyphSvg>
  );
}

const CHECK_DOT: Record<string, string> = {
  success: 'bg-add',
  failure: 'bg-danger',
  pending: 'bg-warn',
};

export function ChecksDot({ cr }: { cr: Pick<ChangeRequest, 'checks'> }) {
  const state = cr.checks?.state;
  const tone = state ? CHECK_DOT[state] : undefined;
  if (!tone) return null;
  return (
    <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 self-center rounded-full ${tone}`} />
  );
}

function dataAttrs(cr: ChangeRequest) {
  return {
    'data-kind': cr.kind,
    'data-number': String(cr.number),
    'data-state': lookOf(cr),
    'data-checks': cr.checks?.state ?? 'none',
  };
}

/** Compact chip after a sidebar row's branch: glyph, number, a CI dot when CI is not neutral. */
export function ChangeRequestChip({ worktreeId }: { worktreeId: string }) {
  const entry = useForgeIndex().get(worktreeId);
  const cr = entry?.worktree.changeRequest;
  if (!entry || !cr) return null;
  const look = lookOf(cr);
  return (
    <span
      data-testid={TEST_IDS.changeRequestChip}
      {...dataAttrs(cr)}
      className={`od-chip inline-flex items-center gap-1 tabular-nums ${LOOK_TONE[look]}`}
      title={changeRequestTitle(entry.worktree, cr)}
    >
      <ChangeRequestGlyph look={look} />
      <span>
        {cr.kind === 'github' ? '#' : '!'}
        {cr.number}
      </span>
      <ChecksDot cr={cr} />
    </span>
  );
}

function badgeText(wf: WorktreeForge, cr: ChangeRequest): string {
  const parts = [shortRef(cr), LOOK_WORD[lookOf(cr)]];
  if (cr.conflicts) parts.push('conflicts');
  else if (cr.review === 'changes_requested') parts.push('changes requested');
  else if (cr.review === 'approved') parts.push('approved');
  if (wf.sync === 'differs' && cr.state === 'open') parts.push('out of sync');
  return parts.join(' · ');
}

/** Toolbar link to the selected worktree's request on its forge. */
export function ChangeRequestBadge({ worktreeId }: { worktreeId: string }) {
  const entry = useForgeIndex().get(worktreeId);
  const cr = entry?.worktree.changeRequest;
  if (!entry || !cr?.url.startsWith('https://')) return null;
  const look = lookOf(cr);
  return (
    <a
      data-testid={TEST_IDS.changeRequestBadge}
      {...dataAttrs(cr)}
      href={cr.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${changeRequestTitle(entry.worktree, cr)}\n\nOpen on ${cr.kind === 'github' ? 'GitHub' : 'GitLab'}`}
      className="od-btn inline-flex max-w-80 items-center gap-1.5"
    >
      <span className={`inline-flex ${LOOK_TONE[look]}`}>
        <ChangeRequestGlyph look={look} />
      </span>
      <span className="truncate tabular-nums">{badgeText(entry.worktree, cr)}</span>
      <ChecksDot cr={cr} />
      <span aria-hidden="true" className="text-faint">
        ↗
      </span>
    </a>
  );
}

/**
 * The pull/merge request part of a sidebar row's hover card (T3 Code's `ThreadDetailsPrRow`
 * hover: number and state, title, branches, checks, conflicts, size). Data from the batch query
 * only: no request is made for it.
 */
export function ChangeRequestHoverBlock({ worktreeId }: { worktreeId: string }) {
  const entry = useForgeIndex().get(worktreeId);
  const cr = entry?.worktree.changeRequest;
  if (!entry || !cr) return null;
  const look = lookOf(cr);
  const size = sizeSummary(cr);
  const checks = checksSummary(cr);
  const status: string[] = [];
  if (cr.review) status.push(REVIEW_WORD[cr.review]);
  if (cr.state === 'open' && cr.mergeState && cr.mergeState !== 'unknown') {
    status.push(MERGE_WORD[cr.mergeState]);
  } else if (cr.conflicts) status.push('Conflicts with base');
  if (cr.comments) status.push(`${cr.comments} ${cr.comments === 1 ? 'comment' : 'comments'}`);
  const noun = cr.kind === 'github' ? 'pull request' : 'merge request';
  return (
    <div
      data-testid={TEST_IDS.changeRequestHoverBlock}
      data-number={String(cr.number)}
      data-state={look}
      className="mt-2 flex flex-col gap-0.5 border-t border-line pt-2"
    >
      <div className="flex items-center gap-1.5">
        <span className={`inline-flex ${LOOK_TONE[look]}`}>
          <ChangeRequestGlyph look={look} />
        </span>
        <span className="font-mono tabular-nums">
          {cr.kind === 'github' ? '#' : '!'}
          {cr.number}
        </span>
        <span className={LOOK_TONE[look]}>{LOOK_WORD[look]}</span>
        {cr.updatedAt && (
          <span className="ml-auto text-[11px] text-faint" title={absoluteTime(cr.updatedAt)}>
            updated {relativeTime(cr.updatedAt)}
          </span>
        )}
      </div>
      <p className="line-clamp-2 font-medium">{cr.title}</p>
      <p className="truncate font-mono text-[11px] text-muted">
        {cr.headBranch} → {cr.baseBranch}
      </p>
      <p className="text-[11px] text-muted">
        {cr.author && <span>by {cr.author}</span>}
        {size && (
          <span className="font-mono">
            {cr.author ? ' · ' : ''}
            {size.files ? `${size.files} ` : ''}
            <span className="text-add">+{size.additions}</span>{' '}
            <span className="text-del">−{size.deletions}</span>
          </span>
        )}
      </p>
      {checks && (
        <p className="flex items-center gap-1.5 text-[11px] text-muted">
          <ChecksDot cr={cr} />
          <span>{checks}</span>
        </p>
      )}
      {status.length > 0 && <p className="text-[11px] text-muted">{status.join(' · ')}</p>}
      {entry.worktree.sync === 'differs' && cr.state === 'open' && (
        <p className="text-[11px] text-muted">
          Out of sync: the {noun}’s head is not this worktree’s HEAD (unpushed or unpulled commits).
        </p>
      )}
    </div>
  );
}
