import { TEST_IDS } from '@octopus-diff/contracts';
import { useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from './bits.tsx';

/** Rows per page in the Overview lists. */
export const PAGE_SIZE = 15;

export interface PageSlice<T> {
  /** The rows of the current page. */
  rows: T[];
  /** Zero-based page, clamped to the last page when the list shrinks. */
  page: number;
  pages: number;
  /** Zero-based index of the first row shown, and one past the last. */
  start: number;
  end: number;
  total: number;
  setPage: (page: number) => void;
}

/**
 * Client-side pagination of an already-loaded list. The page clamps instead of resetting when
 * rows come and go (a live list must not jump back to page 1 on every poll); key the caller by
 * its subject (the project) to start over at page 1.
 */
export function usePage<T>(items: readonly T[], size = PAGE_SIZE): PageSlice<T> {
  const [wanted, setPage] = useState(0);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(0, wanted), pages - 1);
  const start = page * size;
  const end = Math.min(total, start + size);
  return { rows: items.slice(start, end), page, pages, start, end, total, setPage };
}

/**
 * `16–30 of 42` and previous / next. Renders nothing for a single page. `what` names the rows
 * for the buttons' labels ("worktrees").
 */
export function Pager({ slice, what }: { slice: PageSlice<unknown>; what: string }) {
  if (slice.pages <= 1) return null;
  const { page, pages, start, end, total, setPage } = slice;
  return (
    <nav
      aria-label={`${what} pages`}
      data-testid={TEST_IDS.pager}
      data-page={String(page + 1)}
      data-pages={String(pages)}
      className="mt-2 flex items-center justify-end gap-1 text-[11px] text-muted"
    >
      <span className="mr-1 tabular-nums" aria-live="polite">
        {start + 1}–{end} of {total}
      </span>
      <button
        type="button"
        className="od-btn od-btn-ghost od-btn-icon"
        aria-label={`Previous ${what}`}
        title={`Previous ${what}`}
        disabled={page === 0}
        onClick={() => setPage(page - 1)}
      >
        <ChevronLeftIcon />
      </button>
      <button
        type="button"
        className="od-btn od-btn-ghost od-btn-icon"
        aria-label={`Next ${what}`}
        title={`Next ${what}`}
        disabled={page >= pages - 1}
        onClick={() => setPage(page + 1)}
      >
        <ChevronRightIcon />
      </button>
    </nav>
  );
}
