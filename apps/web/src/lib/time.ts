/**
 * Short relative times for the forge surfaces ("3 min ago", "yesterday", "12 Oct"). Plain
 * arithmetic, no Intl.RelativeTimeFormat, so tests are deterministic across locales.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'unknown';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 'unknown';
  const diff = now - at;
  if (diff < 0) return 'just now';
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 2 * DAY) return 'yesterday';
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} days ago`;
  const date = new Date(at);
  const sameYear = new Date(now).getUTCFullYear() === date.getUTCFullYear();
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}${sameYear ? '' : ` ${date.getUTCFullYear()}`}`;
}

/** Absolute time for a `title` attribute. */
export function absoluteTime(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? undefined : new Date(at).toLocaleString();
}

/** A change this recent is "live": the row marks it (an agent is probably at work). */
export const RECENT_MS = 2 * MINUTE;

/**
 * The age in two characters or so for a dense row (`now`, `7m`, `3h`, `2d`, `5w`, `8mo`, `2y`).
 * `null` when the time is unknown. Plain arithmetic like `relativeTime`.
 */
export function shortAge(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  const diff = Math.max(0, now - at);
  // The same cutoff as the row's recent dot: the text and the dot agree.
  if (diff < RECENT_MS) return 'now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`;
  if (diff < 14 * DAY) return `${Math.floor(diff / DAY)}d`;
  if (diff < 60 * DAY) return `${Math.floor(diff / (7 * DAY))}w`;
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))}mo`;
  return `${Math.floor(diff / (365 * DAY))}y`;
}
