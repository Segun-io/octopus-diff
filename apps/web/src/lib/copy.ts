/**
 * Clipboard writes. The async Clipboard API exists only in secure contexts, and octopus-diff is
 * also opened over the LAN on plain `http://<lan-ip>`, where `navigator.clipboard` is undefined;
 * there a hidden `<textarea>` + `document.execCommand('copy')` still works inside a user gesture.
 *
 * The fallback is adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.),
 * apps/web/src/hooks/useCopyToClipboard.ts `writeTextWithExecCommand` / `writeTextToClipboard`.
 */

/** Copies with a hidden textarea and `execCommand('copy')`; restores focus afterwards. */
export function copyWithExecCommand(text: string, doc: Document = document): boolean {
  if (typeof doc.execCommand !== 'function' || !doc.body) return false;
  const textarea = doc.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  // 16px stops iOS from zooming into the focused field.
  textarea.style.fontSize = '16px';
  const previous = doc.activeElement as HTMLElement | null;
  doc.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (previous && typeof previous.focus === 'function') previous.focus({ preventScroll: true });
  }
}

/**
 * Writes `text` to the clipboard: the async API first, then the textarea fallback. Resolves to
 * whether the text was copied; never throws.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or the document lost focus: try the legacy path.
    }
  }
  return copyWithExecCommand(text);
}
