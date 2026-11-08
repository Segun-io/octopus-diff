import { type FileDiff, TEST_IDS } from '@octopus-diff/contracts';
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { describeError, useDiffQuery } from '../../api/queries.ts';
import {
  classifyDiff,
  type DiffDisplay,
  formatBytes,
  repairTruncatedPatch,
} from '../../lib/diffKind.ts';
import { fileRefKey } from '../../lib/fileRef.ts';
import { CONTEXT_STEP, DEFAULT_CONTEXT } from '../../state/commands.ts';
import { useCommandsContext } from '../../state/commandsContext.tsx';
import { useAppModel } from '../../state/model.tsx';
import { actions, useUi, useUiStore } from '../../state/ui.tsx';
import { useTheme } from '../../theme/useTheme.ts';
import { CheckIcon, LineCounts, StatusIcon, statusLabel } from '../bits.tsx';

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
      className="m-4 rounded-md border border-dashed border-line bg-surface p-4 text-sm"
      role="note"
    >
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-2 text-xs text-muted">{children}</div>}
    </div>
  );
}

function RawPatch({ patch }: { patch: string }) {
  if (!patch) return null;
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-muted">Raw patch</summary>
      <pre className="od-scroll mt-2 max-h-80 overflow-auto rounded bg-canvas p-2 font-mono text-[11px] whitespace-pre text-fg">
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

  // "Updated" banner: the open file's patchHash changed underneath the reader.
  const seen = useRef<{ key: string; hash: string } | null>(null);
  const [updatedKey, setUpdatedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!diff || !key) return;
    const prev = seen.current;
    if (prev && prev.key === key && prev.hash !== diff.patchHash) setUpdatedKey(key);
    if (prev?.key !== key) setUpdatedKey(null);
    seen.current = { key, hash: diff.patchHash };
  }, [diff, key]);

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
                <span className="text-muted">{file.oldPath}</span>
                <span className="text-faint"> → </span>
                <span>{selected.path}</span>
              </>
            ) : (
              selected.path
            )}
          </h2>
          {status && <span className="text-[11px] text-muted">{statusLabel(status)}</span>}
          {file && <LineCounts additions={file.additions} deletions={file.deletions} />}
          {row && (
            <span className="truncate text-[11px] text-faint" title={row.worktree.path}>
              {row.project.name} · {row.worktree.branch ?? 'detached'}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1.5">
            {display?.kind === 'patch' && (
              <>
                <button
                  type="button"
                  onClick={commands.expandContext}
                  className="rounded border border-line px-2 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg"
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
                  className="rounded border border-line px-2 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg aria-pressed:bg-selected aria-pressed:text-fg"
                  title="Expand every collapsed unchanged region"
                >
                  {contextLines >= FULL_CONTEXT ? 'Collapse' : 'Expand all'}
                </button>
              </>
            )}
            <button
              type="button"
              data-testid={TEST_IDS.reviewToggle}
              aria-pressed={reviewed}
              onClick={commands.toggleReviewed}
              disabled={!entry && !diff}
              title="Mark reviewed (r)"
              className={`flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium ${
                reviewed ? 'border-add bg-add text-canvas' : 'border-line text-fg hover:bg-hover'
              }`}
            >
              <CheckIcon />
              {reviewed ? 'Reviewed' : 'Mark reviewed'}
            </button>
          </span>
        </header>
      )}

      {updatedKey !== null && updatedKey === key && (
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
            className="mt-2 rounded border border-accent px-2 py-1 text-xs text-fg hover:bg-selected"
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
              daemon's hard size cap; only its first{' '}
              {diff.patch.split('\n').length.toLocaleString('en-US')} lines are shown.
            </Placeholder>
          )}
          <div className="min-h-0 flex-1">
            <Suspense fallback={<p className="p-4 text-xs text-muted">Loading diff renderer…</p>}>
              <DiffRenderer
                patch={display.truncated ? repairTruncatedPatch(diff.patch) : diff.patch}
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
