/**
 * Menu actions that drive the web UI. Phase A has no bridge and changes nothing in `apps/web`, so
 * the menu uses what the web UI already has (constant scripts, run with
 * `webContents.executeJavaScript` only on the daemon's page):
 *
 * - Settings: the web's own `,` shortcut (a `keydown` on `window`, as `useKeyboardShortcuts`
 *   listens). It is ignored while a dialog is open or a text field has focus, like the key itself.
 * - Refresh: a click on the context bar's refresh button (`data-testid="refresh-indicator"`, the
 *   web's `commands.refreshNow`: refresh the open worktree, refetch lists). When no worktree is
 *   open there is no button and nothing happens: the lists are live anyway.
 * - Undo: text undo in a focused field; otherwise the web's Ctrl/Cmd+Z (undo the last bulk mark).
 *
 * Each script is a no-op when its target is missing, so a page that is not the web UI (a newer or
 * older web build) cannot break. Phase C (#20) can replace them with explicit web hooks.
 */
import { TEST_IDS } from '@octopus-diff/contracts';

function keydown(key: string, modifier: 'none' | 'mod', platform: NodeJS.Platform): string {
  const mod =
    modifier === 'none' ? '' : platform === 'darwin' ? ', metaKey: true' : ', ctrlKey: true';
  return `new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true${mod} })`;
}

/** Opens the web UI's Settings dialog (its `,` shortcut). */
export function settingsScript(platform: NodeJS.Platform): string {
  return `(() => { window.dispatchEvent(${keydown(',', 'none', platform)}); return true; })()`;
}

/** Clicks the web UI's "refresh now" button, if there is one; returns whether it was found. */
export function refreshScript(): string {
  const selector = `[data-testid=${JSON.stringify(TEST_IDS.refreshIndicator)}]`;
  return `(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (b instanceof HTMLElement) { b.click(); return true; } return false; })()`;
}

/**
 * Undo: in an editable element the browser's own undo (`execCommand`, still the only API for the
 * editing undo stack); otherwise the web UI's Cmd/Ctrl+Z, dispatched on the focused element so its
 * "not while typing" check sees the real target.
 */
export function undoScript(platform: NodeJS.Platform): string {
  return (
    '(() => { const t = document.activeElement; ' +
    "const editable = t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !['checkbox','radio','button','submit','reset'].includes(t.type))); " +
    "if (editable) { document.execCommand('undo'); return 'text'; } " +
    `(t instanceof HTMLElement ? t : window).dispatchEvent(${keydown('z', 'mod', platform)}); return 'app'; })()`
  );
}
