import { type ChangedFile, TEST_IDS } from '@octopus-diff/contracts';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fileRefKey, toFileRef } from '../lib/fileRef.ts';
import {
  type FileGroup,
  type NavEntry,
  splitPath,
  type VisiblePredicate,
  worktreeLabel,
} from '../lib/model.ts';
import { CheckIcon, LineCounts, StatusIcon, statusLabel } from './bits.tsx';

export const ROW_HEIGHT = 26;
export const HEADER_HEIGHT = 30;
const OVERSCAN_PX = 400;

interface LayoutGroup {
  group: FileGroup;
  top: number;
  height: number;
  headerHeight: number;
  rows: NavEntry[];
}

export interface FileListProps {
  groups: readonly FileGroup[];
  /** Worktrees out of the review loop (no unreviewed counts; dimmed when `dimDisabled`). */
  disabled?: ReadonlySet<string>;
  dimDisabled?: boolean;
  entries: readonly NavEntry[];
  visible: VisiblePredicate;
  selectedKey: string | null;
  grouped: boolean;
  onSelect: (entry: NavEntry) => void;
  emptyMessage: string;
}

function rowId(key: string): string {
  // Option ids for aria-activedescendant; keys contain NUL and slashes.
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  return `file-opt-${(h >>> 0).toString(36)}`;
}

/**
 * Virtualized file list. Every group container is rendered (cheap, keeps `file-group` counts
 * exact); only rows near the viewport are mounted.
 */
export function FileList({
  groups,
  disabled,
  dimDisabled = true,
  entries,
  visible,
  selectedKey,
  grouped,
  onSelect,
  emptyMessage,
}: FileListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });

  const layout = useMemo(() => {
    const byWorktree = new Map<string, NavEntry[]>();
    for (const e of entries) {
      if (!visible(e)) continue;
      const list = byWorktree.get(e.worktreeId);
      if (list) list.push(e);
      else byWorktree.set(e.worktreeId, [e]);
    }
    const out: LayoutGroup[] = [];
    let top = 0;
    for (const group of groups) {
      const rows = byWorktree.get(group.worktree.id) ?? [];
      const headerHeight = grouped ? HEADER_HEIGHT : 0;
      const height = headerHeight + rows.length * ROW_HEIGHT;
      out.push({ group, top, height, headerHeight, rows });
      top += height;
    }
    return { groups: out, total: top };
  }, [groups, entries, visible, grouped]);

  // Track viewport (scroll + size), throttled to animation frames.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setViewport((v) =>
        v.top === el.scrollTop && v.height === el.clientHeight
          ? v
          : { top: el.scrollTop, height: el.clientHeight },
      );
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onScroll);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // Scroll the selection into view when the selection changes (not on data refreshes).
  const lastScrolledKey = useRef<string | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || selectedKey === null || lastScrolledKey.current === selectedKey) return;
    for (const g of layout.groups) {
      const index = g.rows.findIndex((r) => r.key === selectedKey);
      if (index === -1) continue;
      lastScrolledKey.current = selectedKey;
      const rowTop = g.top + g.headerHeight + index * ROW_HEIGHT;
      const headerTop = g.top;
      if (rowTop < el.scrollTop) {
        el.scrollTop = index === 0 ? headerTop : rowTop - ROW_HEIGHT;
      } else if (rowTop + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
        el.scrollTop = rowTop + ROW_HEIGHT * 2 - el.clientHeight;
      }
      return;
    }
  }, [selectedKey, layout]);

  const windowTop = viewport.top - OVERSCAN_PX;
  const windowBottom = viewport.top + viewport.height + OVERSCAN_PX;
  const selectedVisible =
    selectedKey !== null && layout.groups.some((g) => g.rows.some((r) => r.key === selectedKey));

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const flat = layout.groups.flatMap((g) => g.rows);
      const index = flat.findIndex((r) => r.key === selectedKey);
      const next = flat[event.key === 'ArrowDown' ? index + 1 : Math.max(0, index - 1)];
      if (next) onSelect(next);
    },
    [layout, selectedKey, onSelect],
  );

  return (
    <div
      ref={scrollRef}
      data-testid={TEST_IDS.fileList}
      role="listbox"
      aria-label="Changed files"
      tabIndex={0}
      aria-activedescendant={selectedVisible && selectedKey ? rowId(selectedKey) : undefined}
      onKeyDown={onKeyDown}
      className="od-scroll relative h-full min-h-0 overflow-y-auto outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
    >
      {layout.total === 0 && (
        <p className="p-4 text-center text-xs text-muted" role="presentation">
          {emptyMessage}
        </p>
      )}
      <div style={{ height: layout.total, position: 'relative' }} role="presentation">
        {layout.groups.map((g) => {
          const inView = g.top + g.height >= windowTop && g.top <= windowBottom;
          let first = 0;
          let last = -1;
          if (inView) {
            const rowsTop = g.top + g.headerHeight;
            first = Math.max(0, Math.floor((windowTop - rowsTop) / ROW_HEIGHT));
            last = Math.min(g.rows.length - 1, Math.ceil((windowBottom - rowsTop) / ROW_HEIGHT));
          }
          const rendered = last >= first ? g.rows.slice(first, last + 1) : [];
          return (
            // biome-ignore lint/a11y/useSemanticElements: absolutely positioned virtualized group, not a form fieldset
            <div
              key={g.group.worktree.id}
              role="group"
              aria-label={`${g.group.project.name} · ${worktreeLabel(g.group.worktree)}`}
              {...(grouped
                ? {
                    'data-testid': TEST_IDS.fileGroup,
                    'data-worktree-id': g.group.worktree.id,
                    'data-project-id': g.group.project.id,
                  }
                : {})}
              style={{ position: 'absolute', top: g.top, left: 0, right: 0, height: g.height }}
              className={disabled?.has(g.group.worktree.id) && dimDisabled ? 'opacity-60' : ''}
            >
              {grouped && (
                <GroupHeader
                  group={g.group}
                  shown={g.rows.length}
                  reviewOff={disabled?.has(g.group.worktree.id) ?? false}
                />
              )}
              {rendered.map((entry, i) => (
                <FileRow
                  key={entry.key}
                  entry={entry}
                  top={g.headerHeight + (first + i) * ROW_HEIGHT}
                  selected={entry.key === selectedKey}
                  onSelect={onSelect}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const GroupHeader = memo(function GroupHeader({
  group,
  shown,
  reviewOff,
}: {
  group: FileGroup;
  shown: number;
  reviewOff: boolean;
}) {
  const total = group.files.length;
  const unreviewed = reviewOff ? 0 : group.files.reduce((n, f) => n + (f.reviewed ? 0 : 1), 0);
  return (
    <div
      className="flex items-center gap-2 border-b border-line bg-raised px-2 text-xs"
      style={{ height: HEADER_HEIGHT }}
      title={group.worktree.path}
    >
      <span className="truncate font-semibold">{group.project.name}</span>
      <span className="truncate text-muted">{worktreeLabel(group.worktree)}</span>
      <span className="ml-auto shrink-0 text-[11px] text-muted">
        {reviewOff ? 'review off · ' : unreviewed > 0 ? `${unreviewed} unreviewed · ` : ''}
        {shown < total ? `${shown}/${total}` : total} files
      </span>
    </div>
  );
});

function renameLabel(file: ChangedFile): string | null {
  if (!file.oldPath || file.oldPath === file.path) return null;
  return `${file.oldPath} → ${file.path}`;
}

const FileRow = memo(function FileRow({
  entry,
  top,
  selected,
  onSelect,
}: {
  entry: NavEntry;
  top: number;
  selected: boolean;
  onSelect: (entry: NavEntry) => void;
}) {
  const { file } = entry;
  const { dir, base } = splitPath(file.path);
  const rename = renameLabel(file);
  const key = fileRefKey(toFileRef(entry.worktreeId, file));
  return (
    // Keyboard selection is handled by the listbox (j/k, arrows) via aria-activedescendant.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by the parent listbox
    <div
      id={rowId(key)}
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      data-testid={TEST_IDS.fileItem}
      data-path={file.path}
      {...(file.oldPath ? { 'data-old-path': file.oldPath } : {})}
      data-status={file.status}
      data-reviewed={String(file.reviewed)}
      data-worktree-id={entry.worktreeId}
      data-additions={file.additions === null ? '' : String(file.additions)}
      data-deletions={file.deletions === null ? '' : String(file.deletions)}
      title={`${statusLabel(file.status)}: ${rename ?? file.path}${file.reviewed ? ' (reviewed)' : ''}`}
      onClick={() => onSelect(entry)}
      className={`absolute right-0 left-0 flex cursor-pointer items-center gap-1.5 px-2 text-xs ${
        selected ? 'bg-selected' : 'hover:bg-hover'
      } ${file.reviewed ? 'opacity-60' : ''}`}
      style={{ top, height: ROW_HEIGHT }}
    >
      <StatusIcon status={file.status} />
      <span className="flex min-w-0 flex-1 items-baseline gap-1 overflow-hidden whitespace-nowrap">
        {rename ? (
          <span className="truncate" dir="auto">
            <span className="text-muted">{file.oldPath}</span>
            <span className="text-faint"> → </span>
            <span className="font-medium">{file.path}</span>
          </span>
        ) : (
          <>
            <span className="shrink-0 font-medium">{base}</span>
            {dir && <span className="truncate text-[11px] text-faint">{dir.slice(0, -1)}</span>}
          </>
        )}
      </span>
      {file.binary && <span className="text-[10px] text-faint">bin</span>}
      <LineCounts additions={file.additions} deletions={file.deletions} />
      <span className="w-3 shrink-0 text-add">
        {file.reviewed && (
          <>
            <CheckIcon />
            <span className="sr-only">reviewed</span>
          </>
        )}
      </span>
    </div>
  );
});
