import {
  type ChangeRequestDetail,
  type ChangeRequestFileChange,
  type FileStatus,
  TEST_IDS,
} from '@octopus-diff/contracts';
import { useFilesQuery } from '../../api/queries.ts';
import { toFileRef } from '../../lib/fileRef.ts';
import { actions, useUi, useUiStore } from '../../state/ui.tsx';
import { LineCounts, StatusIcon } from '../bits.tsx';
import { Banner, ExternalLink } from './parts.tsx';

/**
 * The Files tab: the request's changed files with `+a −d` and the status letters used elsewhere,
 * marked `changed here` when this worktree also changes the path (in the current scope). Such a
 * row opens the Changes tab on that file. No patch is shown here: diffs stay local and read-only.
 */

const STATUS: Record<ChangeRequestFileChange, FileStatus | null> = {
  added: 'added',
  modified: 'modified',
  removed: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  changed: null,
};

export function Files({ worktreeId, detail }: { worktreeId: string; detail: ChangeRequestDetail }) {
  const store = useUiStore();
  const scope = useUi((s) => s.scope);
  const local = useFilesQuery(worktreeId, scope);
  const byPath = new Map((local.data?.files ?? []).map((f) => [f.path, f]));
  const filesUrl = detail.kind === 'github' ? `${detail.url}/files` : `${detail.url}/diffs`;
  return (
    <div className="px-4 py-3">
      {detail.filesTotal > detail.files.length && (
        <Banner>
          Showing {detail.files.length} of {detail.filesTotal} files.{' '}
          <ExternalLink href={filesUrl}>See all on the forge ↗</ExternalLink>
        </Banner>
      )}
      {detail.files.length === 0 ? (
        <p className="text-xs text-muted">No files reported.</p>
      ) : (
        <ul className="flex flex-col">
          {detail.files.map((file) => {
            const here = byPath.get(file.path);
            const status = STATUS[file.change];
            const open = () => {
              if (!here) return;
              actions.setView(store, { kind: 'worktree', worktreeId, tab: 'changes' });
              actions.select(store, toFileRef(worktreeId, here));
            };
            const content = (
              <>
                {status ? (
                  <StatusIcon status={status} />
                ) : (
                  <span className="inline-flex w-4 shrink-0 justify-center font-mono text-[11px] text-faint">
                    ·
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={file.path}>
                  {file.path}
                </span>
                {here && <span className="shrink-0 text-[11px] text-muted">changed here</span>}
                <LineCounts additions={file.additions} deletions={file.deletions} />
              </>
            );
            return (
              <li
                key={file.path}
                data-testid={TEST_IDS.requestFile}
                data-path={file.path}
                data-changed-here={String(!!here)}
              >
                {here ? (
                  <button
                    type="button"
                    onClick={open}
                    title="Open this file in the Changes tab"
                    className="flex min-h-7 w-full items-center gap-2 rounded-sm px-1 text-left hover:bg-hover"
                  >
                    {content}
                  </button>
                ) : (
                  <div className="flex min-h-7 items-center gap-2 px-1">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
