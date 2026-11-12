import type { UntrackedOmission } from '@octopus-diff/contracts';
import { CopyButton } from './CopyButton.tsx';

export const UNTRACKED_OMITTED_TEST_ID = 'untracked-omitted';

const count = (n: number): string => n.toLocaleString('en-US');

/**
 * Over the file list when the worktree has more untracked files than the daemon lists (#43,
 * `FilesResponse.untrackedOmitted`): how many are left out and where, and the `.gitignore` lines
 * that would drop them (we never write to a repository: the user copies the line). The omitted
 * files are counted in the worktree's totals but have no row, so they cannot be opened or marked
 * reviewed here.
 */
export function UntrackedOmittedNotice({ omission }: { omission: UntrackedOmission | undefined }) {
  if (!omission || omission.count === 0) return null;
  const lines = [
    ...new Set(omission.directories.flatMap((d) => (d.ignoreLine ? [d.ignoreLine] : []))),
  ];
  const where = omission.directories
    .slice(0, 3)
    .map((d) => `${d.path}/ (${count(d.count)})`)
    .join(', ');
  return (
    <div
      role="note"
      data-testid={UNTRACKED_OMITTED_TEST_ID}
      data-count={omission.count}
      className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-raised px-2 py-1 text-xs text-muted"
    >
      <span>
        {count(omission.count)} untracked {omission.count === 1 ? 'file' : 'files'} not listed (more
        than {count(omission.limit)}){where ? ` in ${where}` : ''}. Probably build output or
        dependencies: add {lines.length === 1 ? 'this line' : 'a line'} to .gitignore.
      </span>
      {lines.slice(0, 3).map((line) => (
        <span key={line} className="flex items-center gap-0.5">
          <code className="rounded bg-surface px-1 font-mono text-fg">{line}</code>
          <CopyButton text={line} label={`Copy ${line}`} what="ignore line" />
        </span>
      ))}
    </div>
  );
}
