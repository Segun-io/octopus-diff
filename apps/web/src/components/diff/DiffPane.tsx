import { type FileDiff, scopeKey, TEST_IDS } from '@octopus-diff/contracts';
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { describeError, useDiffQuery } from '../../api/queries.ts';
import { fileCopyTexts, type SelectionCopyMeta } from '../../lib/copyFormat.ts';
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
import { type CopyFn, copyAndReport } from '../../state/copy.ts';
import {
  CONTEXT_STEP,
  DEFAULT_CONTEXT,
  FULL_CONTEXT,
  isFullContext,
  patchShowsWholeFile,
} from '../../state/diffContext.ts';
import { useAppModel } from '../../state/model.tsx';
import { actions, useUi, useUiStore } from '../../state/ui.tsx';
import { useTheme } from '../../theme/useTheme.ts';
import {
  CheckIcon,
  ColumnsIcon,
  LineCounts,
  MoreIcon,
  PilcrowIcon,
  RowsIcon,
  StatusIcon,
  statusLabel,
  WarningIcon,
  WorktreeName,
} from '../bits.tsx';
import { ContextMenu, useContextMenu } from '../ContextMenu.tsx';
import { CopyButton } from '../CopyButton.tsx';
import { COPY_TEST_IDS, fileCopyItems, separated, worktreeCopyItems } from '../copyMenu.ts';
import { ImageDiff } from './ImageDiff.tsx';

const DiffRenderer = lazy(() =>
  import('./DiffRenderer.tsx').then((m) => ({ default: m.DiffRenderer })),
);

/** Web-only test ids of the diff header's context controls. */
export const DIFF_CONTEXT_TEST_IDS = {
  more: 'diff-more-context',
  expandAll: 'diff-expand-all',
} as const;

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

/**
 * The diff's rendering options (docs/TOOLBAR.md §3.3): unified or split as a segmented pair, and
 * whitespace. They are persisted preferences, so they sit in the header whether or not a file is
 * open. The group carries the mode for the tests; its buttons carry `data-mode-option`.
 */
function DiffViewOptions() {
  const store = useUiStore();
  const commands = useCommandsContext();
  const diffMode = useUi((s) => s.diffMode);
  const ignoreWhitespace = useUi((s) => s.ignoreWhitespace);
  const setMode = (mode: typeof diffMode) => {
    if (mode !== diffMode) store.setState({ diffMode: mode });
  };
  return (
    <>
      <fieldset
        data-testid={TEST_IDS.diffModeToggle}
        data-mode={diffMode}
        aria-label="Diff layout"
        className="od-seg m-0 p-0"
      >
        <button
          type="button"
          data-mode-option="unified"
          aria-pressed={diffMode === 'unified'}
          aria-label="Unified"
          title="Unified (s)"
          onClick={() => setMode('unified')}
          className="px-1.5"
        >
          <RowsIcon />
        </button>
        <button
          type="button"
          data-mode-option="split"
          aria-pressed={diffMode === 'split'}
          aria-label="Split"
          title="Split (s)"
          onClick={() => setMode('split')}
          className="px-1.5"
        >
          <ColumnsIcon />
        </button>
      </fieldset>
      <button
        type="button"
        data-testid={TEST_IDS.whitespaceToggle}
        aria-pressed={ignoreWhitespace}
        onClick={commands.toggleWhitespace}
        title="Hide whitespace changes (w)"
        aria-label="Hide whitespace changes"
        className="od-btn od-btn-ghost od-btn-icon"
      >
        <PilcrowIcon />
      </button>
    </>
  );
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
  const shownIgnoreWhitespace = data?.params.ignoreWhitespace ?? ignoreWhitespace;
  const entry = model.selectedEntry;
  const reviewed = diff?.reviewed ?? entry?.file.reviewed ?? false;
  const row = selected ? model.sidebar.byId.get(selected.worktreeId) : undefined;
  // In the Inbox the list mixes worktrees, so the header names the file's; elsewhere the context
  // bar already does.
  const inbox = model.view.kind === 'inbox';
  const menu = useContextMenu<null>();

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
    // The shown patch's own whitespace option (placeholder data may predate the toggle).
    () => (diff ? classifyDiff(diff, shownIgnoreWhitespace) : null),
    [diff, shownIgnoreWhitespace],
  );

  let state: 'empty' | 'loading' | 'ready' | 'error' = 'empty';
  if (selected) state = query.isError && !data ? 'error' : data ? 'ready' : 'loading';

  const file = diff ?? entry?.file;
  const status = file?.status;
  // Context controls. The patch on screen may be the previous view's (placeholder data while
  // a new context loads), so "is the whole file shown" is judged on the patch's own context and
  // only once the requested view has arrived.
  const wholeFile = useMemo(
    () =>
      !!diff &&
      display?.kind === 'patch' &&
      !display.truncated &&
      patchShowsWholeFile(diff.patch, data?.params.context ?? DEFAULT_CONTEXT),
    [diff, display, data?.params.context],
  );
  const settledWhole = wholeFile && !placeholder;
  const fullContext = isFullContext(opts.context);
  const expanded =
    fullContext || (settledWhole && (opts.context ?? DEFAULT_CONTEXT) > DEFAULT_CONTEXT);
  const canMore = !placeholder && !settledWhole && !fullContext;
  const moreTitle = placeholder
    ? 'Loading more context…'
    : settledWhole || fullContext
      ? 'The whole file is already shown'
      : `Show ${CONTEXT_STEP} more context lines around each change (e)`;
  const oldPath = file?.oldPath && file.oldPath !== selected?.path ? file.oldPath : null;
  const pathTexts = selected ? fileCopyTexts({ path: selected.path }, '') : null;
  const copy: CopyFn = (text, options) => void copyAndReport(store, text, options);
  const worktree = row?.worktree;
  const projectName = row?.project.name;
  const defaultBranch = row?.project.defaultBranch;
  const scope = model.scope;
  const selectedPath = selected?.path;
  const copyMeta = useMemo<SelectionCopyMeta | undefined>(
    () =>
      worktree && projectName !== undefined && selectedPath !== undefined
        ? {
            project: projectName,
            branch: worktree.branch,
            worktreePath: worktree.path,
            headSha: worktree.headSha,
            scope,
            defaultBranch: defaultBranch ?? null,
            filePath: selectedPath,
            oldPath,
          }
        : undefined,
    [worktree, projectName, defaultBranch, scope, selectedPath, oldPath],
  );

  return (
    <section
      data-testid={TEST_IDS.diffViewer}
      data-worktree-id={selected?.worktreeId ?? ''}
      data-path={selected?.path ?? ''}
      data-patch-hash={diff?.patchHash ?? ''}
      data-mode={diffMode}
      data-state={state}
      // True while the patch shown is the previous scope's (placeholder data): `ready`, but not yet this view's.
      data-placeholder={placeholder ? 'true' : 'false'}
      aria-label={selected ? `Diff of ${selected.path}` : 'Diff viewer'}
      aria-busy={state === 'loading'}
      className="flex h-full min-h-0 min-w-0 flex-col bg-canvas"
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: right-click shortcut for the ⋯ menu button */}
      <header
        className="flex min-h-9 flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-1.5"
        onContextMenu={selected ? (e) => menu.open(e, null) : undefined}
      >
        {selected && (
          <>
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
            {pathTexts && (
              <CopyButton
                text={pathTexts.relative}
                label="Copy path"
                what="path"
                escaped={pathTexts.escaped}
                testId={COPY_TEST_IDS.pathButton}
                className="-ml-1"
              />
            )}
            {status && <span className="text-[11px] text-muted">{statusLabel(status)}</span>}
            {file && <LineCounts additions={file.additions} deletions={file.deletions} />}
            {inbox && row && (
              <span data-testid="diff-header-worktree" className="inline-flex min-w-0">
                <WorktreeName
                  project={row.project.name}
                  branch={row.worktree.branch ?? 'detached'}
                  className="text-[11px] text-muted"
                  branchClassName="text-faint"
                />
              </span>
            )}
          </>
        )}
        <span className="ml-auto flex items-center gap-1">
          <DiffViewOptions />
          {selected && (
            <>
              <span className="od-sep" aria-hidden="true" />
              {display?.kind === 'patch' && (
                <>
                  <button
                    type="button"
                    data-testid={DIFF_CONTEXT_TEST_IDS.more}
                    onClick={commands.expandContext}
                    disabled={!canMore}
                    aria-busy={placeholder}
                    className="od-btn od-btn-ghost disabled:cursor-default disabled:opacity-50"
                    title={moreTitle}
                  >
                    More context
                  </button>
                  <button
                    type="button"
                    data-testid={DIFF_CONTEXT_TEST_IDS.expandAll}
                    onClick={() =>
                      key &&
                      actions.setFileOptions(store, key, {
                        ...opts,
                        context: expanded ? DEFAULT_CONTEXT : FULL_CONTEXT,
                      })
                    }
                    disabled={!expanded && settledWhole}
                    aria-pressed={expanded}
                    className="od-btn od-btn-ghost disabled:cursor-default disabled:opacity-50"
                    title={
                      expanded
                        ? `Back to ${DEFAULT_CONTEXT} context lines around each change`
                        : settledWhole
                          ? 'The whole file is already shown'
                          : 'Expand every collapsed unchanged region'
                    }
                  >
                    {expanded ? 'Collapse' : 'Expand all'}
                  </button>
                </>
              )}
              <button
                type="button"
                data-testid={COPY_TEST_IDS.diffMenuButton}
                aria-label="More actions"
                aria-haspopup="menu"
                title="Copy path, name, branch…"
                onClick={(e) => menu.open(e, null)}
                className="od-btn od-btn-ghost od-btn-icon"
              >
                <MoreIcon />
              </button>
              <span className="od-sep" aria-hidden="true" />
              {model.disabledWorktrees.has(selected.worktreeId) ? (
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
            </>
          )}
        </span>
      </header>
      {selected && menu.state && (
        <ContextMenu
          items={[
            ...fileCopyItems(
              { path: selected.path, oldPath },
              row?.worktree.path,
              copy,
              menu.state.position,
            ),
            ...(diff?.patch && display?.kind !== 'too-large'
              ? [
                  {
                    id: 'copy-file-diff',
                    label: 'Copy file diff (patch)',
                    testId: COPY_TEST_IDS.fileDiff,
                    onSelect: () =>
                      copy(escapeSuspicious(diff.patch), {
                        what: 'file diff',
                        escaped: suspicious.length > 0,
                        at: menu.state?.position,
                      }),
                  },
                ]
              : []),
            ...(row ? separated(worktreeCopyItems(row.worktree, copy, menu.state.position)) : []),
          ]}
          position={menu.state.position}
          onClose={menu.close}
          label="Copy"
          testId="diff-header-menu-list"
        />
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
            view={data?.view ?? ''}
            copyMeta={copyMeta}
            suspicious={suspicious.length > 0}
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
  view,
  copyMeta,
  suspicious,
  onLoadAnyway,
}: {
  diff: FileDiff;
  display: DiffDisplay;
  mode: 'split' | 'unified';
  theme: 'light' | 'dark';
  diffTheme: string;
  /** The view options the patch was fetched with (`DiffQueryData.view`). */
  view: string;
  copyMeta: SelectionCopyMeta | undefined;
  suspicious: boolean;
  onLoadAnyway: () => void;
}) {
  if (diff.images) return <ImageDiff images={diff.images} />;
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
                // Keyed by the view the patch was fetched with, not the one asked for: while a
                // new view loads, the previous patch is still shown, and caching its highlight
                // under the new key made the new patch render the old lines ("deletionLine and
                // additionLine are null"). The length guards any other mismatch.
                cacheKey={`${diff.patchHash}:${view}:${diff.patch.length}`}
                mode={mode}
                theme={theme}
                diffTheme={diffTheme}
                copyMeta={copyMeta}
                suspicious={suspicious}
              />
            </Suspense>
          </div>
        </div>
      );
  }
}
