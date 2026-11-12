/**
 * The Activity strip under the diff (roadmap #39, DECISIONS #229): what an agent (or anything
 * else) changed in the open worktree since octopus-diff started watching it, newest first. The
 * daemon folds bursts (`bulk`) and coalesces repeats; a deletion is red, with the line count and
 * "View content" (the file's last staged or committed content, from the blob route); a click on a
 * row selects the file when it is still in the list. Collapsed by default so the diff keeps the
 * room; it fetches only for the open worktree and never touches the diff's own queries, so the
 * selection and the reading position survive its refreshes (PLAN §4.2).
 */
import { type ActivityEntry, ApiClientError } from '@octopus-diff/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useActivityQuery, useBlobQuery } from '../../api/activity.ts';
import { describeError } from '../../api/queries.ts';
import {
  ago,
  bulkKinds,
  headLabel,
  isFileEntry,
  newestFirst,
  watchNote,
} from '../../lib/activity.ts';
import { formatBytes } from '../../lib/diffKind.ts';
import { fileRefKey, toFileRef } from '../../lib/fileRef.ts';
import { escapeSuspicious } from '../../lib/unicode.ts';
import { useAppModel } from '../../state/model.tsx';
import { actions, useUi, useUiStore } from '../../state/ui.tsx';
import { LineCounts } from '../bits.tsx';

/** Web-only test ids of the strip. */
export const ACTIVITY_TEST_IDS = {
  strip: 'activity-strip',
  toggle: 'activity-toggle',
  count: 'activity-count',
  watch: 'activity-watch',
  follow: 'activity-follow',
  list: 'activity-list',
  row: 'activity-row',
  select: 'activity-row-select',
  viewContent: 'activity-view-content',
  content: 'activity-content',
  paths: 'activity-paths',
  state: 'activity-state',
} as const;

const KIND_GLYPH: Record<ActivityEntry['kind'], { glyph: string; tone: string; label: string }> = {
  added: { glyph: '+', tone: 'text-add', label: 'Added' },
  modified: { glyph: '~', tone: 'text-mod', label: 'Edited' },
  deleted: { glyph: '−', tone: 'text-del', label: 'Deleted' },
  restored: { glyph: '↺', tone: 'text-muted', label: 'Reverted' },
  commit: { glyph: '●', tone: 'text-accent', label: 'Commit' },
  head: { glyph: '⎇', tone: 'text-warn', label: 'HEAD' },
  bulk: { glyph: '≡', tone: 'text-muted', label: 'Many files' },
};

/** Re-renders every `ms` so "12s" keeps counting without any request. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width="10"
      height="10"
      aria-hidden="true"
      className={`shrink-0 text-faint transition-transform ${open ? 'rotate-90' : ''}`}
    >
      <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function ActivityStrip({ worktreeId }: { worktreeId: string }) {
  const store = useUiStore();
  const model = useAppModel();
  const open = useUi((s) => s.activityOpen);
  const follow = useUi((s) => s.followLatest);
  const query = useActivityQuery(worktreeId);
  const feed = query.data && query.data.worktreeId === worktreeId ? query.data : undefined;
  const now = useNow(10_000);

  const rows = useMemo(() => (feed ? newestFirst(feed.entries) : []), [feed]);
  // Which files a click can still select: the ones the file list shows right now.
  const listed = useMemo(() => new Set(model.entries.map((e) => e.key)), [model.entries]);
  const exists = (path: string, rawPath?: string) =>
    listed.has(fileRefKey({ worktreeId, path, rawPath }));
  const select = (path: string, rawPath?: string) =>
    actions.select(store, toFileRef(worktreeId, rawPath ? { path, rawPath } : { path }));

  // Follow latest change: the newest entry that names a file selects it, once per update (a
  // coalesced entry has a new `seq`). Turning it off forgets, so turning it on selects again.
  const newestFile = rows.find(isFileEntry);
  const followed = useRef<number | null>(null);
  const newestPath = newestFile?.path;
  const newestRaw = newestFile?.rawPath;
  const newestSeq = newestFile?.seq;
  const newestListed = newestPath !== undefined && exists(newestPath, newestRaw);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `exists` and `select` only read what the listed deps already carry
  useEffect(() => {
    if (!follow) {
      followed.current = null;
      return;
    }
    if (newestSeq === undefined || newestPath === undefined || followed.current === newestSeq) {
      return;
    }
    if (!newestListed) return; // not in the list (yet): try again when the list catches up
    followed.current = newestSeq;
    select(newestPath, newestRaw);
  }, [follow, newestSeq, newestPath, newestRaw, newestListed]);

  const note = feed ? watchNote(feed.watch) : null;
  const latest = rows[0];
  let state: 'loading' | 'error' | 'waiting' | 'empty' | 'ready' = 'ready';
  if (!feed) state = query.isError ? 'error' : 'loading';
  else if (!feed.live) state = 'waiting';
  else if (rows.length === 0) state = 'empty';

  return (
    <div
      data-testid={ACTIVITY_TEST_IDS.strip}
      data-open={open ? 'true' : 'false'}
      data-state={state}
      data-worktree-id={worktreeId}
      className="flex shrink-0 flex-col border-t border-line bg-surface"
    >
      <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1 text-xs">
        <button
          type="button"
          data-testid={ACTIVITY_TEST_IDS.toggle}
          aria-expanded={open}
          title={open ? 'Hide activity' : 'Show what changed while you watched'}
          onClick={() => store.setState({ activityOpen: !open })}
          className="flex shrink-0 items-center gap-1.5 font-medium text-fg"
        >
          <Chevron open={open} />
          Activity
          {rows.length > 0 && (
            <span data-testid={ACTIVITY_TEST_IDS.count} className="od-chip tabular-nums">
              {rows.length}
            </span>
          )}
        </button>
        {!open && latest && (
          <span className="min-w-0 flex-1 truncate text-muted" aria-live="off">
            {summaryOf(latest)} · {ago(latest.updatedAt, now)}
          </span>
        )}
        {note && (
          <span
            data-testid={ACTIVITY_TEST_IDS.watch}
            className="od-chip text-warn"
            title="This worktree is not watched with file events, so changes show up on the next poll"
          >
            {note}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            data-testid={ACTIVITY_TEST_IDS.follow}
            aria-pressed={follow}
            title="Select the newest changed file as changes arrive"
            onClick={() => store.setState({ followLatest: !follow })}
            className="od-chip"
          >
            Follow latest change
          </button>
        </span>
      </div>
      {open && (
        <div className="od-scroll h-48 overflow-auto border-t border-line bg-canvas">
          {state === 'loading' && <Note>Loading activity…</Note>}
          {state === 'error' && (
            <Note tone="error">
              Activity is not available: {describeError(query.error).detail} (An older daemon does
              not record it.)
            </Note>
          )}
          {state === 'waiting' && <Note>Waiting for the first snapshot of this worktree…</Note>}
          {state === 'empty' && (
            <Note>Nothing has changed since octopus-diff started watching this worktree.</Note>
          )}
          {state === 'ready' && (
            <ul data-testid={ACTIVITY_TEST_IDS.list} className="divide-y divide-line">
              {rows.map((entry) => (
                <ActivityRow
                  key={entry.id}
                  entry={entry}
                  worktreeId={worktreeId}
                  now={now}
                  exists={exists}
                  select={select}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Note({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <p
      data-testid={ACTIVITY_TEST_IDS.state}
      role={tone === 'error' ? 'alert' : 'status'}
      className={`px-3 py-2 text-xs ${tone === 'error' ? 'text-danger' : 'text-muted'}`}
    >
      {children}
    </p>
  );
}

/** One short phrase for a row, also the collapsed strip's latest line. */
function summaryOf(entry: ActivityEntry): string {
  switch (entry.kind) {
    case 'added':
    case 'modified':
    case 'deleted':
    case 'restored':
      return `${KIND_GLYPH[entry.kind].label} ${entry.path ?? ''}`;
    case 'commit':
      return `Commit ${entry.sha?.slice(0, 7) ?? ''} ${entry.subject ?? ''}`.trim();
    case 'head':
      return headLabel(entry);
    case 'bulk':
      return `${entry.pathCount ?? 0} files changed`;
  }
}

function ActivityRow({
  entry,
  worktreeId,
  now,
  exists,
  select,
}: {
  entry: ActivityEntry;
  worktreeId: string;
  now: number;
  exists: (path: string, rawPath?: string) => boolean;
  select: (path: string, rawPath?: string) => void;
}) {
  const [contentOpen, setContentOpen] = useState(false);
  const [pathsOpen, setPathsOpen] = useState(false);
  const meta = KIND_GLYPH[entry.kind];
  const deleted = entry.kind === 'deleted';
  const fileEntry = isFileEntry(entry);
  const present = fileEntry && entry.path !== undefined && exists(entry.path, entry.rawPath);
  const paths = entry.paths ?? [];
  const label = fileEntry ? (entry.path ?? '') : summaryOf(entry);
  const body = (
    <>
      <span aria-hidden="true" className={`w-3 shrink-0 text-center font-mono ${meta.tone}`}>
        {meta.glyph}
      </span>
      {fileEntry ? (
        <>
          <span className={`shrink-0 ${deleted ? 'font-medium text-del' : 'text-muted'}`}>
            {meta.label}
          </span>
          <span
            className={`min-w-0 truncate font-mono ${deleted ? 'text-del' : ''} ${present ? '' : 'line-through decoration-faint'}`}
            title={present ? entry.path : `${entry.path} (no longer in the list)`}
          >
            {escapeSuspicious(label)}
          </span>
          {deleted ? (
            entry.deleted != null && (
              <span className="shrink-0 font-mono text-[11px] text-del tabular-nums">
                −{entry.deleted} {entry.deleted === 1 ? 'line' : 'lines'}
              </span>
            )
          ) : (
            <LineCounts additions={entry.added ?? null} deletions={entry.deleted ?? null} />
          )}
          {entry.oldPath && (
            <span className="min-w-0 truncate text-faint">
              from {escapeSuspicious(entry.oldPath)}
            </span>
          )}
        </>
      ) : (
        <span className="min-w-0 truncate">{escapeSuspicious(label)}</span>
      )}
      {entry.count > 1 && (
        <span className="shrink-0 text-faint tabular-nums" title={`${entry.count} refreshes`}>
          ×{entry.count}
        </span>
      )}
      {entry.origin === 'base' && (
        <span className="od-chip shrink-0" title="Came from the default branch (a merge or update)">
          from main
        </span>
      )}
      {entry.kind === 'bulk' && bulkKinds(entry) && (
        <span className="shrink-0 text-faint">{bulkKinds(entry)}</span>
      )}
    </>
  );
  return (
    <li
      data-testid={ACTIVITY_TEST_IDS.row}
      data-kind={entry.kind}
      data-id={entry.id}
      data-seq={entry.seq}
      data-path={entry.path ?? ''}
      data-present={fileEntry ? String(present) : ''}
      className={deleted ? 'bg-del-soft' : ''}
    >
      <div className="flex items-center gap-2 px-3 py-1 text-xs">
        {fileEntry && present && entry.path !== undefined ? (
          <button
            type="button"
            data-testid={ACTIVITY_TEST_IDS.select}
            onClick={() => select(entry.path ?? '', entry.rawPath)}
            title="Show this file's diff"
            className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-fg"
          >
            {body}
          </button>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-2">{body}</span>
        )}
        {entry.kind === 'bulk' && paths.length > 0 && (
          <PathsToggle open={pathsOpen} onToggle={() => setPathsOpen(!pathsOpen)} entry={entry} />
        )}
        {entry.kind === 'commit' && paths.length > 0 && (
          <PathsToggle open={pathsOpen} onToggle={() => setPathsOpen(!pathsOpen)} entry={entry} />
        )}
        {deleted &&
          (entry.oid ? (
            <button
              type="button"
              data-testid={ACTIVITY_TEST_IDS.viewContent}
              aria-expanded={contentOpen}
              onClick={() => setContentOpen(!contentOpen)}
              className="od-btn shrink-0"
              title="The file's last staged or committed content"
            >
              {contentOpen ? 'Hide content' : 'View content'}
            </button>
          ) : (
            <span
              className="shrink-0 text-faint"
              title={
                entry.untracked
                  ? 'The file was never tracked, so git has no copy of it'
                  : 'git has no copy of this file'
              }
            >
              content unavailable
            </span>
          ))}
        <time
          dateTime={entry.updatedAt}
          title={new Date(entry.updatedAt).toLocaleString()}
          className="w-8 shrink-0 text-right text-faint tabular-nums"
        >
          {ago(entry.updatedAt, now)}
        </time>
      </div>
      {pathsOpen && paths.length > 0 && (
        <ul
          data-testid={ACTIVITY_TEST_IDS.paths}
          className="pr-3 pb-1.5 pl-8 font-mono text-[11px]"
        >
          {paths.map((path) => (
            <li key={path} className="truncate">
              {exists(path) ? (
                <button type="button" onClick={() => select(path)} className="hover:text-fg">
                  {escapeSuspicious(path)}
                </button>
              ) : (
                <span className="text-faint">{escapeSuspicious(path)}</span>
              )}
            </li>
          ))}
          {(entry.pathCount ?? paths.length) > paths.length && (
            <li className="text-faint">… and {(entry.pathCount ?? 0) - paths.length} more</li>
          )}
        </ul>
      )}
      {deleted && contentOpen && entry.oid && (
        <DeletedContent worktreeId={worktreeId} oid={entry.oid} path={entry.path ?? ''} />
      )}
    </li>
  );
}

function PathsToggle({
  open,
  onToggle,
  entry,
}: {
  open: boolean;
  onToggle: () => void;
  entry: ActivityEntry;
}) {
  const n = entry.pathCount ?? entry.paths?.length ?? 0;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="od-btn shrink-0"
      title="The paths of this entry"
    >
      {open ? 'Hide files' : `${n} ${n === 1 ? 'file' : 'files'}`}
    </button>
  );
}

/** The removed file's content, read through the blob route when "View content" opens. */
function DeletedContent({
  worktreeId,
  oid,
  path,
}: {
  worktreeId: string;
  oid: string;
  path: string;
}) {
  const query = useBlobQuery(worktreeId, oid);
  const blob = query.data;
  let body: React.ReactNode;
  if (blob) {
    if (blob.kind === 'text' && blob.content !== null) {
      body = (
        <pre
          data-testid={ACTIVITY_TEST_IDS.content}
          data-path={path}
          className="od-scroll max-h-56 overflow-auto rounded-md bg-raised p-2 font-mono text-[11px] whitespace-pre text-fg"
        >
          {escapeSuspicious(blob.content)}
        </pre>
      );
    } else if (blob.kind === 'binary') {
      body = <p className="text-muted">Binary file ({formatBytes(blob.size)}): not shown.</p>;
    } else {
      body = (
        <p className="text-muted">
          Too large to show ({formatBytes(blob.size)}; the limit is {formatBytes(blob.maxBytes)}).
        </p>
      );
    }
  } else if (query.isError) {
    const gone = query.error instanceof ApiClientError && query.error.status === 404;
    body = (
      <p role="alert" className="text-danger">
        {gone
          ? 'The content is no longer available: the entry aged out of the feed, or git pruned it.'
          : describeError(query.error).detail}
      </p>
    );
  } else {
    body = <p className="text-muted">Loading…</p>;
  }
  return (
    <div className="px-3 pb-2 pl-8 text-xs">
      <p className="mb-1 text-faint">Last staged or committed content (not unsaved edits):</p>
      {body}
    </div>
  );
}
