import { type FileDiff, scopeKey, TEST_IDS } from '@octopus-diff/contracts';
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { describeError, useDiffQuery } from '../../api/queries.ts';
import {
  classifyDiff,
  type DiffDisplay,
  formatBytes,
  repairTruncatedPatch,
} from '../../lib/diffKind.ts';
import { fileRefKey } from '../../lib/fileRef.ts';
import {
  describeSuspicious,
  escapeSuspicious,
  findSuspicious,
  hasSuspicious,
} from '../../lib/unicode.ts';
import { useCommandsContext } from '../../state/commandsContext.tsx';
import { CONTEXT_STEP, DEFAULT_CONTEXT } from '../../state/diffContext.ts';
import { useAppModel } from '../../state/model.tsx';
import { actions, useUi, useUiStore } from '../../state/ui.tsx';
import { useTheme } from '../../theme/useTheme.ts';
import {
  CheckIcon,
  LineCounts,
  StatusIcon,
  statusLabel,
  WarningIcon,
  WorktreeName,
} from '../bits.tsx';

const DiffRenderer = lazy(() =>
  import('./DiffRenderer.tsx').then((m) => ({ default: m.DiffRenderer })),
);

export const FULL_CONTEXT = 1_000_000;

function Placeholder({
  kind,
  title,
  children,
}: {
  kind: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-testid={TEST_IDS.diffPlaceholder}
      data-kind={kind}
      className={`px-5 py-4 text-sm ${kind === 'truncated' ? 'border-b border-line bg-surface' : ''}`}
      role="note"
    >
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-1 max-w-xl text-xs text-muted">{children}</div>}
    </div>
  );
}

function RawPatch({ patch }: { patch: string }) {
  if (!patch) return null;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-muted">Raw patch</summary>
      <pre className="od-scroll mt-2 max-h-80 overflow-auto rounded-md bg-raised p-2 font-mono text-[11px] whitespace-pre text-fg">
        {patch}
      </pre>
    </details>
  );
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 12) : '(none)';
}

export function DiffPane() {
  const store = useUiStore();
  const model = useAppModel();
  const commands = useCommandsContext();
  const selected = useUi((s) => s.selected);
  const diffMode = useUi((s) => s.diffMode);
  const ignoreWhitespace = useUi((s) => s.ignoreWhitespace);
  const fileOptions = useUi((s) => s.fileOptions);
  const appTheme = useTheme();
  const theme = appTheme.kind;
  const key = selected ? fileRefKey(selected) : null;
  const opts = (key && fileOptions[key]) || {};
  const query = useDiffQuery(selected, model.scope, {
    ignoreWhitespace,
    context: opts.context,
    full: opts.full,
  });
  const data =
    query.data && key && query.data.worktreeId === selected?.worktreeId ? query.data : undefined;
  const diff = data?.diff;
  const entry = model.selectedEntry;
  const reviewed = diff?.reviewed ?? entry?.file.reviewed ?? false;
  const row = selected ? model.sidebar.byId.get(selected.worktreeId) : undefined;

  // "Updated" banner: the open file's patchHash changed underneath the reader. Keyed by file
  // AND scope (F9): the same file has a different hash per scope, which is not a change.
  const seenKey = key === null ? null : `${key}|${scopeKey(model.scope)}`;
  const seen = useRef<{ key: string; hash: string } | null>(null);
  const [updatedKey, setUpdatedKey] = useState<string | null>(null);
  const placeholder = query.isPlaceholderData;
  useEffect(() => {
    // Placeholder data is the previous scope's diff for the same file: not a change on disk.
    if (!diff || !seenKey || placeholder) return;
    const prev = seen.current;
    if (prev && prev.key === seenKey && prev.hash !== diff.patchHash) setUpdatedKey(seenKey);
    if (prev?.key !== seenKey) setUpdatedKey(null);
    seen.current = { key: seenKey, hash: diff.patchHash };
  }, [diff, seenKey, placeholder]);

  // SEC-05: invisible / bidirectional characters in the path or the patch are made visible.
  const suspicious = useMemo(() => {
    const text = `${selected?.path ?? ''}\n${diff?.patch ?? ''}`;
    return hasSuspicious(text) ? findSuspicious(text) : [];
  }, [selected?.path, diff?.patch]);

  const display = useMemo<DiffDisplay | null>(
    () => (diff ? classifyDiff(diff, ignoreWhitespace) : null),
    [diff, ignoreWhitespace],
  );

  let state: 'empty' | 'loading' | 'ready' | 'error' = 'empty';
  if (selected) state = query.isError && !data ? 'error' : data ? 'ready' : 'loading';

  const file = diff ?? entry?.file;
  const status = file?.status;
  const contextLines = opts.context ?? DEFAULT_CONTEXT;

  return (
    <section
      data-testid={TEST_IDS.diffViewer}
      data-worktree-id={selected?.worktreeId ?? ''}
      data-path={selected?.path ?? ''}
      data-patch-hash={diff?.patchHash ?? ''}
      data-mode={diffMode}
      data-state={state}
      aria-label={selected ? `Diff of ${selected.path}` : 'Diff viewer'}
      aria-busy={state === 'loading'}
      className="flex h-full min-h-0 min-w-0 flex-col bg-canvas"
    >
      {selected && (
        <header className="flex min-h-10 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
          {status && <StatusIcon status={status} />}
          <h2 className="min-w-0 truncate font-mono text-xs" title={selected.path}>
            {file?.oldPath && file.oldPath !== selected.path ? (
              <>
                <span className="text-muted">{escapeSuspicious(file.oldPath)}</span>
                <span className="text-faint"> → </span>
                <span>{escapeSuspicious(selected.path)}</span>
              </>
            ) : (
              escapeSuspicious(selected.path)
            )}
          </h2>
          {status && <span className="text-[11px] text-muted">{statusLabel(status)}</span>}
          {file && <LineCounts additions={file.additions} deletions={file.deletions} />}
          {row && (
            <WorktreeName
              project={row.project.name}
              branch={row.worktree.branch ?? 'detached'}
              className="text-[11px] text-muted"
              branchClassName="text-faint"
            />
          )}
          <span className="ml-auto flex items-center gap-1.5">
            {display?.kind === 'patch' && (
              <>
                <button
                  type="button"
                  onClick={commands.expandContext}
                  className="od-btn"
                  title={`Show ${CONTEXT_STEP} more context lines around each change (e)`}
                >
                  More context
                </button>
                <button
                  type="button"
                  onClick={() =>
                    key &&
                    actions.setFileOptions(store, key, {
                      ...opts,
                      context: contextLines >= FULL_CONTEXT ? DEFAULT_CONTEXT : FULL_CONTEXT,
                    })
                  }
                  aria-pressed={contextLines >= FULL_CONTEXT}
                  className="od-btn"
                  title="Expand every collapsed unchanged region"
                >
                  {contextLines >= FULL_CONTEXT ? 'Collapse' : 'Expand all'}
                </button>
              </>
            )}
            {selected && model.disabledWorktrees.has(selected.worktreeId) ? (
              <span className="text-[11px] text-faint" title="Review is off for this worktree">
                review off
              </span>
            ) : (
              <button
                type="button"
                data-testid={TEST_IDS.reviewToggle}
                aria-pressed={reviewed}
                onClick={commands.toggleReviewed}
                disabled={!entry && !diff}
                title="Mark reviewed (r)"
                className={`od-btn font-medium ${reviewed ? 'border-add bg-add text-canvas' : 'text-fg'}`}
              >
                <CheckIcon />
                {reviewed ? 'Reviewed' : 'Mark reviewed'}
              </button>
            )}
          </span>
        </header>
      )}

      {suspicious.length > 0 && (
        <div
          data-testid="diff-unicode-warning"
          role="alert"
          className="flex items-center gap-2 border-b border-warn/40 bg-raised px-3 py-1 text-xs"
        >
          <span className="flex items-center text-warn" aria-hidden="true">
            <WarningIcon />
          </span>
          <span>
            This file contains {describeSuspicious(suspicious)}. They are shown as ⟨U+…⟩ below; the
            code may not read the way it runs.
          </span>
        </div>
      )}
      {updatedKey !== null && updatedKey === seenKey && (
        <div
          data-testid={TEST_IDS.diffUpdatedBanner}
          role="status"
          className="od-fade-in flex items-center gap-2 border-b border-line bg-selected px-3 py-1 text-xs"
        >
          <span>This file changed on disk; the diff below is up to date.</span>
          <button
            type="button"
            className="ml-auto text-muted underline hover:text-fg"
            onClick={() => setUpdatedKey(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {state === 'empty' && (
          <Placeholder
            kind="empty"
            title={model.entries.length === 0 ? 'Nothing to review' : 'No file selected'}
          >
            {model.entries.length === 0
              ? 'No changed files here in this scope.'
              : 'Pick a file on the left, or press j / n.'}
          </Placeholder>
        )}
        {state === 'loading' && (
          <p className="p-4 text-xs text-muted" role="status">
            Loading diff…
          </p>
        )}
        {state === 'error' && (
          <Placeholder kind="error" title="Could not load this diff">
            {describeError(query.error).detail}
          </Placeholder>
        )}
        {state === 'ready' && diff && display && (
          <DiffBody
            key={key}
            diff={diff}
            display={display}
            mode={diffMode}
            theme={theme}
            diffTheme={appTheme.diff.theme}
            ignoreWhitespace={ignoreWhitespace}
            context={opts.context}
            onLoadAnyway={() => key && actions.setFileOptions(store, key, { ...opts, full: true })}
          />
        )}
      </div>
    </section>
  );
}

function DiffBody({
  diff,
  display,
  mode,
  theme,
  diffTheme,
  ignoreWhitespace,
  context,
  onLoadAnyway,
}: {
  diff: FileDiff;
  display: DiffDisplay;
  mode: 'split' | 'unified';
  theme: 'light' | 'dark';
  diffTheme: string;
  ignoreWhitespace: boolean;
  context: number | undefined;
  onLoadAnyway: () => void;
}) {
  switch (display.kind) {
    case 'binary':
      return (
        <Placeholder kind="binary" title="Binary file">
          Binary files are not shown.{' '}
          {diff.oldMode && diff.newMode && diff.oldMode !== diff.newMode
            ? `Mode ${diff.oldMode} → ${diff.newMode}.`
            : ''}
        </Placeholder>
      );
    case 'too-large':
      return (
        <Placeholder
          kind="too-large"
          title={`Large diff (${formatBytes(display.byteLength)}) not loaded`}
        >
          <p>Big diffs are skipped by default to keep things fast.</p>
          <button
            type="button"
            data-testid={TEST_IDS.diffLoadAnyway}
            onClick={onLoadAnyway}
            className="od-btn mt-2 text-fg"
          >
            Load anyway
          </button>
        </Placeholder>
      );
    case 'submodule':
      return (
        <Placeholder kind="submodule" title="Submodule">
          <p className="font-mono">
            {short(display.oldCommit)} → {short(display.newCommit)}
          </p>
          <RawPatch patch={diff.patch} />
        </Placeholder>
      );
    case 'symlink':
      return (
        <Placeholder
          kind="symlink"
          title={display.typechange ? 'Type changed (symlink)' : 'Symbolic link'}
        >
          <p className="font-mono">
            {display.oldTarget === null
              ? diff.oldMode
                ? `(regular file, mode ${diff.oldMode})`
                : '(none)'
              : `→ ${display.oldTarget}`}
            {'  ⇒  '}
            {display.newTarget === null
              ? diff.newMode
                ? `(regular file, mode ${diff.newMode})`
                : '(deleted)'
              : `→ ${display.newTarget}`}
          </p>
          <RawPatch patch={diff.patch} />
        </Placeholder>
      );
    case 'empty':
      return <Placeholder kind="empty" title={display.reason} />;
    case 'patch':
      return (
        <div className="flex h-full min-h-0 flex-col">
          {display.truncated && (
            <Placeholder kind="truncated" title="Diff truncated">
              The patch
              {diff.byteLength !== null ? ` (${formatBytes(diff.byteLength)})` : ''} exceeds the
              daemon’s hard size cap; only its first{' '}
              {diff.patch.split('\n').length.toLocaleString('en-US')} lines are shown.
            </Placeholder>
          )}
          <div className="min-h-0 flex-1">
            <Suspense fallback={<p className="p-4 text-xs text-muted">Loading diff renderer…</p>}>
              <DiffRenderer
                patch={escapeSuspicious(
                  display.truncated ? repairTruncatedPatch(diff.patch) : diff.patch,
                )}
                cacheKey={`${diff.patchHash}:${ignoreWhitespace ? 'w' : ''}:${context ?? ''}`}
                mode={mode}
                theme={theme}
                diffTheme={diffTheme}
              />
            </Suspense>
          </div>
        </div>
      );
  }
}
