/**
 * "Open in editor" through the editor's URL scheme (docs/DESKTOP.md §3.4): `vscode://file/…`,
 * `cursor://file/…`, `zed://file/…`, with an optional `:line`. The main process builds the URL
 * from a checked absolute path; the renderer never passes a URL. `isAllowedEditorUrl` is the gate
 * in front of `shell.openExternal`: those three schemes, the `file` host, an absolute path, nothing
 * else (no query, fragment, credentials or port, which other editor URL handlers act on).
 */
import { DESKTOP_EDITORS, type DesktopEditor } from '@octopus-diff/contracts';

/** `/a/b c` → `/a/b%20c`; Windows `C:\a\b` → `/C:/a/b`. Null for a path that is not absolute. */
function urlPath(absPath: string, platform: NodeJS.Platform): string | null {
  if (platform === 'win32') {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(absPath);
    if (!m) return null;
    const rest = (m[2] ?? '').split(/[\\/]/).filter((s) => s !== '');
    return `/${m[1]}:/${rest.map(encodeURIComponent).join('/')}`;
  }
  if (!absPath.startsWith('/')) return null;
  const rest = absPath.split('/').filter((s) => s !== '');
  return `/${rest.map(encodeURIComponent).join('/')}`;
}

export function editorUrl(
  editor: DesktopEditor,
  absPath: string,
  line: number | undefined,
  platform: NodeJS.Platform,
): string | null {
  const p = urlPath(absPath, platform);
  if (p === null) return null;
  const suffix = line !== undefined && Number.isInteger(line) && line > 0 ? `:${line}` : '';
  return `${editor}://file${p}${suffix}`;
}

export function isAllowedEditorUrl(url: string): boolean {
  const editor = DESKTOP_EDITORS.find((e) => url.startsWith(`${e}://file/`));
  if (!editor) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === `${editor}:` &&
    parsed.host === 'file' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.port === '' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    !url.includes('?') &&
    !url.includes('#') &&
    parsed.pathname.length > 1
  );
}
