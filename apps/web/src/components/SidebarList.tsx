import { defaultRangeExtractor, type Range, useVirtualizer } from '@tanstack/react-virtual';
import { type RefObject, useCallback, useEffect, useRef } from 'react';
import type { WorktreeRow } from '../lib/model.ts';
import { type RowProps, type RowSection, WorktreeItem } from './SidebarRow.tsx';

/**
 * What the sidebar's flat list is made of (#13): worktree rows, and the header of the closed
 * "Hidden" section at the end. A header is just another virtual row, so the list stays one flat
 * array.
 */
export type SidebarItem =
  | { kind: 'row'; section: RowSection; row: WorktreeRow }
  | { kind: 'hiddenHeader'; count: number; open: boolean };

export function itemKey(item: SidebarItem | undefined, index: number): string {
  if (!item) return `i${index}`;
  return item.kind === 'row' ? item.row.worktree.id : 'hidden-header';
}

/** Estimated heights (px) before a row is measured: a three-line card, the section header. */
export const ROW_ESTIMATE = 58;
export const HEADER_ESTIMATE = 30;
/** Rows kept mounted beyond the viewport on each side. */
export const OVERSCAN = 6;

/**
 * The window of the list: only the rows in (or near) the scroll viewport are mounted, positioned
 * absolutely inside a spacer as tall as the whole list (`@tanstack/react-virtual`). Heights are
 * measured, not fixed, so a row may grow (a second meta line, the "N deleted" chip, a redesign).
 * The selected row is always mounted so keyboard focus and `J`/`K` never lose it, and selecting a
 * worktree (J/K, the palette, a click elsewhere) scrolls it into view.
 */
export function SidebarList({
  items,
  scrollRef,
  selectedId,
  menuId = null,
  renderHeader,
  ...rowProps
}: {
  items: readonly SidebarItem[];
  /** The scrolling element the list lives in. */
  scrollRef: RefObject<HTMLElement | null>;
  selectedId: string | null;
  /** The worktree whose actions menu is open: kept mounted, so closing the menu can focus it. */
  menuId?: string | null;
  renderHeader: (item: Extract<SidebarItem, { kind: 'hiddenHeader' }>) => React.ReactNode;
} & Omit<RowProps, 'row' | 'selected'>) {
  const selectedIndex =
    selectedId === null
      ? -1
      : items.findIndex((i) => i.kind === 'row' && i.row.worktree.id === selectedId);

  const menuIndex =
    menuId === null ? -1 : items.findIndex((i) => i.kind === 'row' && i.row.worktree.id === menuId);

  // The selected row and the one whose menu is open stay mounted whatever the scroll position:
  // focus, `aria-current` and J/K keep the first, and the menu returns focus to its opener (the
  // second) when it closes, which a scrolled-away row could not receive.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      // A Set: the menu may be open on the selected row, which must be mounted once.
      const extra = [...new Set([selectedIndex, menuIndex])].filter(
        (i) => i >= 0 && !indexes.includes(i),
      );
      if (extra.length === 0) return indexes;
      return [...indexes, ...extra].sort((a, b) => a - b);
    },
    [selectedIndex, menuIndex],
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (items[i]?.kind === 'row' ? ROW_ESTIMATE : HEADER_ESTIMATE),
    getItemKey: (i) => itemKey(items[i], i),
    overscan: OVERSCAN,
    rangeExtractor,
  });

  // Bring a newly selected worktree into view; a reorder under a fixed selection must not scroll.
  const latestIndex = useRef(selectedIndex);
  latestIndex.current = selectedIndex;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the selection changes only
  useEffect(() => {
    if (latestIndex.current >= 0) virtualizer.scrollToIndex(latestIndex.current, { align: 'auto' });
  }, [selectedId]);

  return (
    <ul
      aria-label="Worktrees"
      data-testid="sidebar-list"
      data-mounted={virtualizer.getVirtualItems().length}
      data-total={items.length}
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((v) => {
        const item = items[v.index];
        if (!item) return null;
        return (
          <li
            key={v.key}
            data-index={v.index}
            data-section={item.kind === 'row' ? item.section : 'hidden-header'}
            ref={virtualizer.measureElement}
            // `top`, not a transform: a transformed ancestor would trap the hover card's `fixed`.
            style={{ position: 'absolute', top: v.start, left: 0, width: '100%' }}
          >
            {item.kind === 'row' ? (
              <WorktreeItem
                {...rowProps}
                row={item.row}
                selected={item.row.worktree.id === selectedId}
              />
            ) : (
              renderHeader(item)
            )}
          </li>
        );
      })}
    </ul>
  );
}
