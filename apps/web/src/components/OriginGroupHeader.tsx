import type { CSSProperties } from 'react';
import { noiseGroupLabel, type OriginStats } from '../lib/model.ts';
import { ChevronRightIcon } from './bits.tsx';

/** Test ids of the merge-noise controls (docs/reports/web-merge-noise.md). */
export const ORIGIN_TEST_IDS = {
  /** The collapsed "From origin/main - merge (N files)" row (`aria-expanded`). */
  group: 'from-main-group',
  /** The "From main (N)" filter chip in the file pane header (`aria-pressed`). */
  chip: 'from-main-chip',
  /** The "Only this branch's changes" toggle (`aria-pressed`). */
  branchToggle: 'branch-only-toggle',
  /** The `+main` / `merge` tag on a row. */
  tag: 'origin-tag',
} as const;

/** The label of a worktree's "from main" group, from its stats and the ref its files came from. */
export function originGroupLabel(stats: OriginStats, ref: string): string {
  return noiseGroupLabel(ref, stats.vias, stats.base);
}

/**
 * The row that wraps the files a merge, rebase or update of the default branch brought: a
 * disclosure button at the end of a worktree's list, collapsed by default (never hidden: it is
 * always there, with its count, and one click or `Enter` opens it).
 */
export function OriginGroupHeader({
  worktreeId,
  stats,
  integrationRef,
  open,
  onToggle,
  className = '',
  style,
}: {
  worktreeId: string;
  stats: OriginStats;
  integrationRef: string;
  open: boolean;
  onToggle: (worktreeId: string) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const label = originGroupLabel(stats, integrationRef);
  return (
    <button
      type="button"
      data-testid={ORIGIN_TEST_IDS.group}
      data-worktree-id={worktreeId}
      data-open={String(open)}
      data-count={String(stats.base)}
      aria-expanded={open}
      title={`Files whose change came from ${integrationRef} (a merge, rebase or update), not from this branch. ${
        open ? 'Collapse' : 'Expand'
      } the group.`}
      onClick={() => onToggle(worktreeId)}
      className={`flex w-full cursor-pointer items-center gap-1.5 border-0 border-t border-line bg-transparent px-2 text-left text-xs text-muted hover:bg-hover hover:text-fg ${className}`}
      style={style}
    >
      <span
        aria-hidden="true"
        className={`flex shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
      >
        <ChevronRightIcon size={12} />
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}
