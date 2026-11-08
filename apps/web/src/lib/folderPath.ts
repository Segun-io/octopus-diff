import type { DirEntry, DirKind, DirsResponse } from '@octopus-diff/contracts';

/*
 * Folder picker path logic. The interaction model (the location text is the browser: the folder
 * part is listed, the last segment filters by prefix, `.` reveals hidden folders, shell-style Tab)
 * follows T3 Code's command-palette browse mode (github.com/pingdotgg/t3code, MIT,
 * packages/client-runtime/src/state/filesystem.ts); `tabCompletion` is adapted from its
 * `getFilesystemBrowseTabCompletion`.
 */

/**
 * The location text split shell-style: `dir` is everything up to the last separator (the folder
 * to list; `''` lists the daemon's default, home) and `partial` is the name being typed in it.
 */
export interface Location {
  dir: string;
  partial: string;
}

export function hasTrailingSeparator(text: string): boolean {
  return /[/\\]$/.test(text);
}

export function splitLocation(text: string): Location {
  const t = text.trimStart();
  if (t === '~') return { dir: '~/', partial: '' };
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  if (i === -1) return { dir: '', partial: t };
  return { dir: t.slice(0, i + 1), partial: t.slice(i + 1) };
}

/** An absolute daemon path as the user reads and types it: home becomes `~`. */
export function displayPath(abs: string, home: string, sep: string): string {
  if (home && abs === home) return '~';
  const homePrefix = home.endsWith(sep) ? home : home + sep;
  if (home && abs.startsWith(homePrefix)) return `~${sep}${abs.slice(homePrefix.length)}`;
  return abs;
}

/** Location text that lists `abs` (always ends with a separator). */
export function folderText(abs: string, home: string, sep: string): string {
  const shown = displayPath(abs, home, sep);
  return hasTrailingSeparator(shown) ? shown : shown + sep;
}

/**
 * Entries whose name starts with `partial` (case-insensitive). Hidden folders show only once the
 * partial starts with `.`, as in a shell.
 */
export function filterEntries(entries: readonly DirEntry[], partial: string): DirEntry[] {
  const q = partial.toLowerCase();
  const showHidden = q.startsWith('.');
  return entries.filter((e) => (showHidden || !e.hidden) && e.name.toLowerCase().startsWith(q));
}

/** Shell-style Tab: one match enters that folder, several extend the text to their common prefix. */
export function tabCompletion(
  visible: readonly DirEntry[],
  partial: string,
): { name: string; complete: boolean } | null {
  const [first, ...rest] = visible;
  if (!first) return null;
  if (rest.length === 0) return { name: first.name, complete: true };
  let prefix = Array.from(first.name);
  for (const entry of rest) {
    const chars = Array.from(entry.name);
    let n = 0;
    while (n < prefix.length && prefix[n]?.toLowerCase() === chars[n]?.toLowerCase()) n++;
    prefix = prefix.slice(0, n);
  }
  const name = prefix.join('');
  return name.length > partial.length ? { name, complete: false } : null;
}

/**
 * What the add / watch buttons act on. With a trailing separator: the listed folder. Otherwise
 * the entry named exactly like the partial, or (no listing yet, or no such entry) the raw text,
 * which the daemon resolves and validates itself.
 */
export interface Target {
  /** Sent to the daemon. */
  path: string;
  /** Null while unknown (listing not loaded, or the name is not in the listing). */
  kind: DirKind | null;
  /** False once the listing shows there is no such folder. */
  exists: boolean | null;
}

export function resolveTarget(text: string, listing: DirsResponse | undefined): Target | null {
  const raw = text.trim();
  if (!raw) return null;
  const { partial } = splitLocation(text);
  if (partial === '') {
    return listing ? { path: listing.path, kind: listing.kind, exists: true } : unknown(raw);
  }
  if (!listing) return unknown(raw);
  const exact = listing.entries.find((e) => e.name === partial);
  return exact
    ? { path: exact.path, kind: exact.kind, exists: true }
    : { ...unknown(raw), exists: false };
}

function unknown(path: string): Target {
  return { path, kind: null, exists: null };
}

/** Repositories directly inside a listing (what "Watch" would find at depth 1, roughly). */
export function countRepos(entries: readonly DirEntry[]): number {
  return entries.filter((e) => e.kind !== 'dir').length;
}
