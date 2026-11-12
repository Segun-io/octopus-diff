import type { ReactNode } from 'react';
import { useDelayedFlag, useNow } from '../lib/useWait.ts';
import { staleText, WAIT_NOTE_DELAY_MS, type WaitSource, waitText } from '../lib/wait.ts';

export const WAIT_NOTE_TEST_ID = 'wait-note';
export const STALE_NOTE_TEST_ID = 'stale-note';

function isWarn(source: WaitSource): boolean {
  return (
    source.kind === 'forge' &&
    (source.budget?.state === 'backoff' || source.budget?.state === 'low')
  );
}

/**
 * Says what a slow load is waiting on: "Waiting for GitHub…" for a forge request, "Loading from
 * your computer…" for local work, or why a host is held back (its budget). Silent until `active`
 * has lasted `delayMs` (`WAIT_NOTE_DELAY_MS`): below it the skeleton alone is shown, so a fast load
 * flashes nothing.
 *
 * The live region is always mounted and only its text comes and goes, so a screen reader hears
 * each change once and nothing when the wait is short.
 *
 * - `block`: a line whose height is reserved (under a skeleton), so the text never moves content.
 * - `inline`: a span with no width until it has text (beside a button).
 * - `float`: a pill over the corner of the nearest positioned ancestor; takes no space.
 */
export function WaitNote({
  active,
  source,
  variant = 'block',
  delayMs = WAIT_NOTE_DELAY_MS,
  className = '',
}: {
  active: boolean;
  source: WaitSource;
  variant?: 'block' | 'inline' | 'float';
  delayMs?: number;
  className?: string;
}) {
  const shown = useDelayedFlag(active, delayMs);
  const text = shown ? waitText(source) : '';
  const tone = isWarn(source) ? 'text-warn' : 'text-muted';
  const attrs = {
    role: 'status',
    'aria-live': 'polite' as const,
    'data-testid': WAIT_NOTE_TEST_ID,
    'data-source': source.kind === 'local' ? 'local' : source.forge.join('+') || 'forge',
    'data-shown': String(shown),
  };
  if (variant === 'float') {
    return (
      <div
        {...attrs}
        className={`pointer-events-none absolute inset-x-2 bottom-2 z-10 flex ${className}`}
      >
        {shown && (
          <span className="od-overlay od-fade-in max-w-full truncate rounded-md px-2 py-1 text-[11px] text-muted">
            <span className={tone}>{text}</span>
          </span>
        )}
      </div>
    );
  }
  if (variant === 'inline') {
    return (
      <span {...attrs} className={`text-[11px] ${tone} ${className}`}>
        {text}
      </span>
    );
  }
  return (
    <p {...attrs} className={`mt-1 min-h-4 text-[11px] ${tone} ${className}`}>
      {text}
    </p>
  );
}

/**
 * "Last updated 3 min ago · Refresh": the content on screen is the last good data, a refresh
 * failed or the daemon holds lookups back. `updatedAt` is the real time of that data (the forge
 * fetch, or the query's `dataUpdatedAt`); `reason` says why when it is known. A button, so it
 * is reached with Tab like every other control.
 */
export function StaleNote({
  updatedAt,
  reason,
  onRefresh,
  refreshing = false,
  title,
  className = '',
  children,
}: {
  updatedAt: number | string | null;
  reason?: string | null;
  onRefresh: () => void;
  refreshing?: boolean;
  title?: string | undefined;
  className?: string;
  children?: ReactNode;
}) {
  const now = useNow(true);
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid={STALE_NOTE_TEST_ID}
      title={title}
      className={`inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted ${className}`}
    >
      <span className="min-w-0 truncate">
        {reason ? `${reason}. ` : ''}
        {staleText(updatedAt, now)}
        {children}
      </span>
      <button
        type="button"
        className="od-btn od-btn-ghost shrink-0"
        disabled={refreshing}
        onClick={onRefresh}
      >
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </span>
  );
}
