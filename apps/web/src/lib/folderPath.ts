import type { DirEntry, DirKind, DirsResponse } from '@octopus-diff/contracts';

/*
 * Folder picker path logic. The interaction model (the location text is the browser: the folder
 * part is listed, the last segment filters by prefix, `.` reveals hidden folders, shell-style Tab,
 * paths pasted from a file manager) follows T3 Code's command-palette browse mode
 * (github.com/pingdotgg/t3code, MIT). Adapted from it: the separator rules and
 * `appendSegment` / `isBrowseQuery` (packages/client-runtime/src/state/projects.ts),
 * `tabCompletion` (`getFilesystemBrowseTabCompletion`, packages/client-runtime/src/state/
 * filesystem.ts), `resolvePastedPath` (packages/shared/src/path.ts) and `wslUncToLinux`
 * (apps/desktop/src/wsl/wslPathParsing.ts).
 */

export function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:([/\\]|$)/.test(value);
}

export function isWindowsAbsolutePath(value: string): boolean {
  return value.startsWith('\\\\') || isWindowsDrivePath(value);
}

/** `./x`, `../x` (and the Windows forms): relative to the project in view. */
export function isExplicitRelative(value: string): boolean {
  return (
    value === '.' ||
    value === '..' ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('.\\') ||
    value.startsWith('..\\')
  );
}

/** Text that names a folder rather than a search: the command palette browses for these. */
export function isBrowseQuery(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('~/') ||
    (isExplicitRelative(value) && value !== '.' && value !== '..') ||
    isWindowsAbsolutePath(value)
  );
}

/** `\` is a legal character in a Unix file name, so only `/` separates in a `/…` path. */
function lastSeparatorIndex(text: string): number {
  if (text.startsWith('/')) return text.lastIndexOf('/');
  return Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
}

export function hasTrailingSeparator(text: string): boolean {
  return (text.startsWith('/') ? /\/$/ : /[/\\]$/).test(text);
}

function preferredSeparator(text: string): '/' | '\\' {
  if (isWindowsAbsolutePath(text)) return '\\';
  if (text.startsWith('/')) return '/';
  return text.includes('\\') ? '\\' : '/';
}

/**
 * The location text split shell-style: `dir` is everything up to the last separator (the folder
 * to list; `''` lists the start folder) and `partial` is the name being typed in it.
 */
export interface Location {
  dir: string;
  partial: string;
}

export function splitLocation(text: string): Location {
  const t = text.trimStart();
  if (t === '~') return { dir: '~/', partial: '' };
  const i = lastSeparatorIndex(t);
  if (i === -1) return { dir: '', partial: t };
  return { dir: t.slice(0, i + 1), partial: t.slice(i + 1) };
}

/** Enter a folder by name: keeps what was typed before it (`~/co` + `code` → `~/code/`). */
export function appendSegment(text: string, name: string): string {
  return `${splitLocation(text).dir}${name}${preferredSeparator(text)}`;
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

/** The start folder setting as location text (empty means home). */
export function startText(setting: string): string {
  const t = setting.trim();
  if (!t) return '~/';
  return hasTrailingSeparator(t) ? t : `${t}${preferredSeparator(t)}`;
}

/**
 * Resolves an explicit relative path (`./x`, `../x`) against `base`, an absolute daemon path.
 * Other text is returned unchanged; the daemon resolves `~` itself.
 */
export function resolveRelative(text: string, base: string | null, sep: string): string {
  if (!base || !isExplicitRelative(text)) return text;
  const isWin = sep === '\\';
  const root = isWin ? (/^[a-zA-Z]:\\/.exec(base)?.[0] ?? '\\') : '/';
  const segments = base
    .slice(root.length)
    .split(isWin ? /[\\/]+/ : /\/+/)
    .filter(Boolean);
  for (const seg of text.split(/[\\/]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') segments.pop();
    else segments.push(seg);
  }
  const joined = root + segments.join(sep);
  // Keep a trailing separator: it means "list this folder", not "filter by its name".
  return hasTrailingSeparator(text) && !hasTrailingSeparator(joined) ? joined + sep : joined;
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
  const lower = name.toLowerCase();
  return lower.length > partial.length &&
    visible.every((e) => e.name.toLowerCase().startsWith(lower))
    ? { name, complete: false }
    : null;
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

// --- Pasting -------------------------------------------------------------------------------

/** One character typed, or text deleted: not a paste. */
function isTyping(previous: string, next: string): boolean {
  return next.startsWith(previous)
    ? next.length === previous.length + 1
    : previous.startsWith(next);
}

function isHostPath(value: string): boolean {
  return value.startsWith('/') || isWindowsAbsolutePath(value) || value.startsWith('~/');
}

// Finder and Explorer copy a path ready for a shell: `'/a b'`, `/a\'s\ b`, or `"C:\a b"`.
const QUOTED_PATH_AT_END = /(?:'((?:[^']|'\\'')+)'|"([^"]+)")\s*$/;
const SHELL_ESCAPE = /\\([\s'"\\()[\]{}<>|&;$`!*?#~^=])/g;

/**
 * What a folder box holds after a change. A full path pasted into it replaces the box, even after
 * the text already there (`~/` + `/a/b` is `/a/b`), and a path copied for a shell is unquoted.
 */
export function resolvePastedPath(previous: string, next: string): string {
  if (isTyping(previous, next)) return next;

  const match = QUOTED_PATH_AT_END.exec(next);
  // Text before the quote that wasn't in the box is a search, not a folder to paste after.
  if (match && previous.startsWith(next.slice(0, match.index).trimEnd())) {
    const quoted = match[1]?.replaceAll("'\\''", "'") ?? match[2] ?? '';
    if (isHostPath(quoted)) return quoted;
  }

  // Without a trailing separator, `/a` then `/a/b` is a longer path, not one pasted after a folder.
  const afterFolder = /[/\\]$/.test(previous) && next.startsWith(previous);
  const path = afterFolder ? next.slice(previous.length) : next;
  if (!isHostPath(path)) return next;
  // `\` separates folders in Windows paths, so it only escapes in `/` and `~/` paths.
  return isWindowsAbsolutePath(path) ? path : path.replace(SHELL_ESCAPE, '$1');
}

// Literal spaces only; \s would accept control characters in the distro name.
const DISTRO_NAME = /^\w(?:[\w \-.]*\w)?$/;

/** `\\wsl.localhost\Ubuntu\home\me` (copied from Explorer) → `/home/me`; null for anything else. */
export function wslUncToLinux(windowsPath: string): string | null {
  const match = /^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i.exec(windowsPath.trim());
  if (!match?.[1] || !DISTRO_NAME.test(match[1])) return null;
  const rest = match[2] ?? '';
  return `/${rest.split('\\').filter(Boolean).join('/')}`;
}

/**
 * The folder box after a change: pasted paths are cleaned up, and on a Unix daemon a WSL path
 * copied from Windows Explorer becomes the Linux path it names.
 */
export function nextFolderText(previous: string, next: string, sep: string): string {
  const resolved = resolvePastedPath(previous, next);
  if (sep !== '/' || isTyping(previous, next)) return resolved;
  return wslUncToLinux(resolved) ?? resolved;
}

/** A Windows path typed for a daemon that runs on Unix (WSL included): it cannot be listed. */
export function isForeignWindowsPath(text: string, sep: string): boolean {
  return sep === '/' && isWindowsAbsolutePath(text.trim());
}
