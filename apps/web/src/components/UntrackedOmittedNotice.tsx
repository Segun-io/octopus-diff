import type { UntrackedOmission, UntrackedOmittedDirectory } from '@octopus-diff/contracts';
import { escapeSuspicious, hasSuspicious } from '../lib/unicode.ts';
import { CopyButton } from './CopyButton.tsx';

export const UNTRACKED_OMITTED_TEST_ID = 'untracked-omitted';

const count = (n: number): string => n.toLocaleString('en-US');

/** Directories named with a line each; the rest are summed up. */
const SHOWN = 3;

/**
 * Over the file list when the worktree has more untracked files than the daemon lists (#43,
 * `FilesResponse.untrackedOmitted`): how many are left out and where, each directory with the
 * `.gitignore` line that would drop it (we never write to a repository: the user copies the line).
 * The omitted files are counted in the worktree's totals but have no row, so they cannot be opened
 * or marked reviewed here. Only directories with a dependency or build-output name are called that
 * (PR #91 P2-2); every path and line is shown with invisible and bidi characters escaped, and a
 * line holding any is not offered for copying (SEC-05, PR #91 P2-4).
 */
export function UntrackedOmittedNotice({ omission }: { omission: UntrackedOmission | undefined }) {
  if (!omission || omission.count === 0) return null;
  const shown = omission.directories.slice(0, SHOWN);
  const inShown = shown.reduce((n, d) => n + d.count, 0);
  const rest = omission.count - inShown;
  const files = omission.count === 1 ? 'file' : 'files';
  return (
    <div
      role="note"
      data-testid={UNTRACKED_OMITTED_TEST_ID}
      data-count={omission.count}
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-raised px-2 py-1 text-xs text-muted"
    >
      <span>
        {count(omission.count)} untracked {files} not listed (more than {count(omission.limit)})
        {shown.length === 0
          ? ': the last ones in path order. They are counted but cannot be opened or reviewed here.'
          : '. They are counted but cannot be opened or reviewed here.'}
      </span>
      {shown.map((dir) => (
        <OmittedDirectory key={dir.rawPath ?? dir.path} dir={dir} />
      ))}
      {shown.length > 0 && rest > 0 && <span>and {count(rest)} more</span>}
    </div>
  );
}

function OmittedDirectory({ dir }: { dir: UntrackedOmittedDirectory }) {
  const line = dir.ignoreLine;
  const copyable = line !== null && !hasSuspicious(line);
  return (
    <span data-omitted-dir={dir.path} className="flex items-center gap-1">
      <span>
        {count(dir.count)} in <span className="font-mono">{escapeSuspicious(dir.path)}/</span>
        {dir.generated === true ? ' (dependencies or build output)' : ''}
        {line !== null ? ':' : ''}
      </span>
      {line !== null && (
        <code className="rounded bg-surface px-1 font-mono text-fg" title="A .gitignore line">
          {escapeSuspicious(line)}
        </code>
      )}
      {copyable && <CopyButton text={line} label={`Copy ${line}`} what="ignore line" />}
    </span>
  );
}
