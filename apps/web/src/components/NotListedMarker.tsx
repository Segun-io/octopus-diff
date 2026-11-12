import type { UntrackedOmission } from '@octopus-diff/contracts';

export const NOT_LISTED_TEST_ID = 'not-listed-marker';

function compact(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}k`;
}

/**
 * `+N not listed` on a worktree's row and context bar while untracked files above the daemon's cap
 * are left out of its lists (#43, `WorktreeSummary.untrackedOmitted`): a reviewed worktree may still
 * hold files nobody saw. The title explains; the row's screen-reader sentence says it too.
 */
export function NotListedMarker({ omission }: { omission: UntrackedOmission | undefined }) {
  if (!omission || omission.count === 0) return null;
  const n = omission.count;
  return (
    <span
      data-testid={NOT_LISTED_TEST_ID}
      className="text-warn"
      title={`${n} untracked ${n === 1 ? 'file is' : 'files are'} not listed (more than ${omission.limit}): counted, but not opened or reviewable here. Open the worktree for the .gitignore suggestion.`}
    >
      +{compact(n)} not listed
    </span>
  );
}
