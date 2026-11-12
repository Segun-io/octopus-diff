import { type ChangedFile, TEST_IDS } from '@octopus-diff/contracts';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fileRefKey, toFileRef } from '../lib/fileRef.ts';
import {
  type FileGroup,
  isBaseFile,
  type NavEntry,
  type OriginStats,
  type OriginView,
  originTag,
  splitPath,
  type VisiblePredicate,
  worktreeLabel,
} from '../lib/model.ts';
import { escapeSuspicious, hasSuspicious } from '../lib/unicode.ts';
import { type CopyFn, copyAndReport } from '../state/copy.ts';
import { useUi, useUiStore } from '../state/ui.tsx';
import { CheckIcon, LineCounts, StatusIcon, statusLabel, WarningIcon } from './bits.tsx';
import { ContextMenu, type MenuItem, useContextMenu } from './ContextMenu.tsx';
import { fileCopyItems, worktreeCopyItems } from './copyMenu.ts';
import { ORIGIN_TEST_IDS, OriginGroupHeader } from './OriginGroupHeader.tsx';

type ListMenuTarget = { kind: 'file'; entry: NavEntry } | { kind: 'group'; group: FileGroup };

/** Row heights per density (mirrors `--od-row` / `--od-row-header` in styles.css). */
export const ROW_HEIGHTS = {
  compact: { row: 26, header: 30 },
  comfortable: { row: 30, header: 32 },
} as const;
export const ROW_HEIGHT = ROW_HEIGHTS.compact.row;
export const HEADER_HEIGHT = ROW_HEIGHTS.compact.header;
const OVERSCAN_PX = 400;

interface LayoutGroup {
  group: FileGroup;
  top: number;
  height: number;
  headerHeight: number;
  /** Listed files in order: own and mixed ones, then the "from main" ones while that group is open. */
  rows: NavEntry[];
  /** Slot of the collapsible "from main" row (it follows the own rows), or -1 without one. */
  noiseAt: number;
  noise: OriginStats | null;
  /** Slots of the group: its rows plus the "from main" row. */
  slots: number;
}

/** The merge-noise wrapping of the list (absent: an older daemon, or a caller with no origins). */
export interface FileListOrigin {
  view: OriginView;
  /** Own, mixed and base files per worktree, after the eye. */
  stats: ReadonlyMap<string, OriginStats>;
  /** The default-branch ref a worktree's base files came from. */
  refs: ReadonlyMap<string, string>;
  onToggle: (worktreeId: string) => void;
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
  origin?: FileListOrigin;
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
  origin,
}: FileListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });
  const store = useUiStore();
  const menu = useContextMenu<ListMenuTarget>();
  const openMenu = menu.open;
  const onFileMenu = useCallback(
    (event: React.MouseEvent, entry: NavEntry) => openMenu(event, { kind: 'file', entry }),
    [openMenu],
  );
  const onGroupMenu = useCallback(
    (event: React.MouseEvent, group: FileGroup) => openMenu(event, { kind: 'group', group }),
    [openMenu],
  );
  const worktreePath = (id: string) => groups.find((g) => g.worktree.id === id)?.worktree.path;
  const copy: CopyFn = (text, options) => void copyAndReport(store, text, options);
  const menuItems = (target: ListMenuTarget): MenuItem[] => {
    const at = menu.state?.position;
    if (target.kind === 'group') return worktreeCopyItems(target.group.worktree, copy, at);
    return fileCopyItems(target.entry.file, worktreePath(target.entry.worktreeId), copy, at);
  };
  const density = useUi((s) => s.density);
  const ROW_HEIGHT = ROW_HEIGHTS[density].row;
  const HEADER_HEIGHT = ROW_HEIGHTS[density].header;

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
      // The wrapped group follows the own and mixed files (they come first in `rows`). It is there
      // whenever the worktree has base files, open or not; the chip lists them without a header.
      const stats = origin?.stats.get(group.worktree.id) ?? null;
      const noise = origin && !origin.view.fromMainOnly && stats && stats.base > 0 ? stats : null;
      let noiseAt = -1;
      if (noise) {
        noiseAt = 0;
        while (noiseAt < rows.length && !isBaseFile(rows[noiseAt]?.file ?? {})) noiseAt++;
      }
      const slots = rows.length + (noise ? 1 : 0);
      const headerHeight = grouped ? HEADER_HEIGHT : 0;
      const height = headerHeight + slots * ROW_HEIGHT;
      out.push({ group, top, height, headerHeight, rows, noiseAt, noise, slots });
      top += height;
    }
    return { groups: out, total: top };
  }, [groups, entries, visible, grouped, ROW_HEIGHT, HEADER_HEIGHT, origin]);

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
      const slot = index + (g.noiseAt >= 0 && index >= g.noiseAt ? 1 : 0);
      const rowTop = g.top + g.headerHeight + slot * ROW_HEIGHT;
      const headerTop = g.top;
      if (rowTop < el.scrollTop) {
        el.scrollTop = index === 0 ? headerTop : rowTop - ROW_HEIGHT;
      } else if (rowTop + ROW_HEIGHT > el.scrollTop + el.clientHeight) {
        el.scrollTop = rowTop + ROW_HEIGHT * 2 - el.clientHeight;
      }
      return;
    }
  }, [selectedKey, layout, ROW_HEIGHT]);

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

  const list = (
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
            last = Math.min(g.slots - 1, Math.ceil((windowBottom - rowsTop) / ROW_HEIGHT));
          }
          // Slots are rows, with the collapsible "from main" row (`noiseAt`) after the own ones.
          const slotIndexes: number[] = [];
          for (let slot = first; slot <= last; slot++) slotIndexes.push(slot);
          const fromMainOnly = origin?.view.fromMainOnly ?? false;
          return (
            // biome-ignore lint/a11y/useSemanticElements: absolutely positioned virtualized group, not a form fieldset
            <div
              key={g.group.worktree.id}
              role="group"
              aria-label={`${g.group.project.name}, ${worktreeLabel(g.group.worktree)}`}
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
                  onMenu={onGroupMenu}
                  group={g.group}
                  // Expanded base files are rows too, but not part of the own-only count they are compared with.
                  shown={
                    fromMainOnly
                      ? g.rows.length
                      : g.rows.reduce((n, r) => (isBaseFile(r.file) ? n : n + 1), 0)
                  }
                  fromMainOnly={fromMainOnly}
                  height={HEADER_HEIGHT}
                  reviewOff={disabled?.has(g.group.worktree.id) ?? false}
                />
              )}
              {slotIndexes.map((slot) => {
                const top = g.headerHeight + slot * ROW_HEIGHT;
                if (slot === g.noiseAt && g.noise && origin) {
                  return (
                    <OriginGroupHeader
                      key="from-main"
                      worktreeId={g.group.worktree.id}
                      stats={g.noise}
                      integrationRef={origin.refs.get(g.group.worktree.id) ?? 'main'}
                      open={origin.view.expanded.has(g.group.worktree.id)}
                      onToggle={origin.onToggle}
                      className="absolute right-0 left-0"
                      style={{ top, height: ROW_HEIGHT }}
                    />
                  );
                }
                const entry = g.rows[g.noiseAt >= 0 && slot > g.noiseAt ? slot - 1 : slot];
                if (!entry) return null;
                return (
                  <FileRow
                    key={entry.key}
                    entry={entry}
                    top={top}
                    height={ROW_HEIGHT}
                    selected={entry.key === selectedKey}
                    // Wrapped files are dimmed once expanded; under the chip they are the list.
                    dim={!fromMainOnly && isBaseFile(entry.file)}
                    onSelect={onSelect}
                    onMenu={onFileMenu}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
  // The menu sits outside the listbox: its arrow keys must not move the file selection.
  return (
    <>
      {list}
      {menu.state && (
        <ContextMenu
          items={menuItems(menu.state.target)}
          position={menu.state.position}
          onClose={menu.close}
          label="Copy"
          testId="file-list-menu"
        />
      )}
    </>
  );
}

const GroupHeader = memo(function GroupHeader({
  group,
  shown,
  fromMainOnly,
  height,
  reviewOff,
  onMenu,
}: {
  group: FileGroup;
  shown: number;
  /** The chip is on: `shown` counts base files, and they are the count. */
  fromMainOnly: boolean;
  height: number;
  reviewOff: boolean;
  onMenu: (event: React.MouseEvent, group: FileGroup) => void;
}) {
  // Counts are own + mixed files: what came from the default branch is wrapped, not counted.
  let total = 0;
  let unreviewed = 0;
  for (const f of group.files) {
    if (isBaseFile(f)) continue;
    total++;
    if (!f.reviewed && !reviewOff) unreviewed++;
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right-click shortcut; the palette has the same copy commands
    <div
      className="flex items-center gap-2 border-b border-line bg-raised px-2 text-xs"
      style={{ height }}
      title={group.worktree.path}
      onContextMenu={(e) => onMenu(e, group)}
    >
      <span className="truncate font-semibold">{group.project.name}</span>
      <span className="truncate text-muted">{worktreeLabel(group.worktree)}</span>
      <span className="ml-auto flex shrink-0 gap-3 text-[11px] text-muted tabular-nums">
        {reviewOff ? (
          <span>review off</span>
        ) : unreviewed > 0 ? (
          <span>{unreviewed} unreviewed</span>
        ) : null}
        {fromMainOnly ? (
          <span>{shown} from main</span>
        ) : (
          <span>
            {shown < total ? `${shown}/${total}` : total} {total === 1 ? 'file' : 'files'}
          </span>
        )}
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
  height,
  selected,
  dim,
  onSelect,
  onMenu,
}: {
  entry: NavEntry;
  top: number;
  height: number;
  selected: boolean;
  /** A file from the default branch in an expanded group. */
  dim: boolean;
  onSelect: (entry: NavEntry) => void;
  onMenu: (event: React.MouseEvent, entry: NavEntry) => void;
}) {
  const { file } = entry;
  const suspicious =
    hasSuspicious(file.path) || (file.oldPath ? hasSuspicious(file.oldPath) : false);
  const { dir, base } = splitPath(suspicious ? escapeSuspicious(file.path) : file.path);
  const rename = renameLabel(file);
  const key = fileRefKey(toFileRef(entry.worktreeId, file));
  const tag = originTag(file);
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
      {...(file.origin && file.origin !== 'own' ? { 'data-origin': file.origin } : {})}
      {...(file.originVia ? { 'data-origin-via': file.originVia } : {})}
      data-suspicious={suspicious ? 'true' : undefined}
      data-worktree-id={entry.worktreeId}
      data-additions={file.additions === null ? '' : String(file.additions)}
      data-deletions={file.deletions === null ? '' : String(file.deletions)}
      title={`${statusLabel(file.status)}: ${rename ?? file.path}${file.reviewed ? ' (reviewed)' : ''}${
        file.origin === 'mixed'
          ? ' (the default branch changed this file too; see "Only this branch\'s changes")'
          : file.origin === 'base'
            ? ' (came from the default branch)'
            : ''
      }`}
      onClick={() => onSelect(entry)}
      onContextMenu={(e) => onMenu(e, entry)}
      className={`absolute right-0 left-0 flex cursor-pointer items-center gap-1.5 px-2 text-xs ${
        selected ? 'bg-selected' : 'hover:bg-hover'
      } ${file.reviewed || dim ? 'opacity-60' : ''}`}
      style={{ top, height }}
    >
      <StatusIcon status={file.status} />
      {suspicious && (
        <span
          className="flex shrink-0 items-center text-warn"
          role="img"
          aria-label="File name contains invisible or bidirectional characters"
          title="File name contains invisible or bidirectional characters (shown as ⟨U+…⟩)"
        >
          <WarningIcon size={12} />
        </span>
      )}
      <span className="flex min-w-0 flex-1 items-baseline gap-1 overflow-hidden whitespace-nowrap">
        {rename ? (
          <span className="truncate" dir="auto">
            <span className="text-muted">{escapeSuspicious(file.oldPath ?? '')}</span>
            <span className="text-faint"> → </span>
            <span className="font-medium">{escapeSuspicious(file.path)}</span>
          </span>
        ) : (
          <>
            <span className="shrink-0 font-medium">{base}</span>
            {dir && <span className="truncate text-[11px] text-faint">{dir.slice(0, -1)}</span>}
          </>
        )}
      </span>
      {tag && (
        <span
          data-testid={ORIGIN_TEST_IDS.tag}
          className="od-chip shrink-0"
          title={
            file.origin === 'mixed'
              ? 'The default branch changed this file too'
              : 'Came from the default branch'
          }
        >
          {tag}
        </span>
      )}
      {file.binary && <span className="text-[11px] text-faint">bin</span>}
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
