/**
 * Copy feedback, modelled on T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.):
 * `useCopyToClipboard` (a "copied" state that resets after a moment), `DiffFilePathCopyButton`
 * (a ghost icon button whose icon turns into a check) and `anchoredCopyToast` (a small
 * tooltip-style "Copied!" above the button, or "Failed to copy").
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { copyText } from '../lib/copy.ts';
import { actions, useUi, useUiStore } from '../state/ui.tsx';
import { CheckIcon, CopyIcon } from './bits.tsx';

/** How long the check icon and the anchored "Copied!" stay (T3: 1000 ms). */
export const COPIED_TIMEOUT_MS = 1000;
const ERROR_TIMEOUT_MS = 3500;

export interface CopyOptions {
  /** What was copied, for the toast: `Copied file path`. Without it: `Copied!`. */
  what?: string;
  /** Anchor the toast above this element (a button); otherwise it shows bottom-centre. */
  anchor?: Element | null;
  /** The text had invisible / bidirectional characters and was copied escaped. */
  escaped?: boolean;
}

function anchorPoint(anchor: Element | null | undefined): { x: number; y: number } | undefined {
  if (!anchor?.isConnected) return undefined;
  const rect = anchor.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top };
}

/** Copies and reports the result in the copy toast; `copied` is true for a moment after. */
export function useCopyFeedback() {
  const store = useUiStore();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback(
    async (text: string, options: CopyOptions = {}): Promise<boolean> => {
      // Measure before the await: a menu that closes takes its anchor with it.
      const at = anchorPoint(options.anchor);
      const ok = await copyText(text);
      const note = options.escaped ? ' (invisible characters escaped)' : '';
      actions.copyToast(store, {
        ok,
        text: ok
          ? `${options.what ? `Copied ${options.what}` : 'Copied!'}${note}`
          : 'Failed to copy: the clipboard is not available here',
        ...(at ? { at } : {}),
      });
      if (ok) {
        if (timer.current) clearTimeout(timer.current);
        setCopied(true);
        timer.current = setTimeout(() => {
          timer.current = null;
          setCopied(false);
        }, COPIED_TIMEOUT_MS);
      }
      return ok;
    },
    [store],
  );
  return { copy, copied };
}

/** A ghost icon button that copies `text` (T3 `DiffFilePathCopyButton`). */
export function CopyButton({
  text,
  label,
  what,
  escaped,
  testId,
  className = '',
}: {
  text: string;
  /** Tooltip and accessible name, e.g. `Copy path`. */
  label: string;
  what?: string;
  escaped?: boolean;
  testId?: string;
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copy, copied } = useCopyFeedback();
  return (
    <button
      ref={ref}
      type="button"
      data-testid={testId}
      data-copied={copied ? 'true' : undefined}
      aria-label={label}
      title={copied ? 'Copied' : label}
      onClick={() => void copy(text, { what, escaped, anchor: ref.current })}
      className={`od-btn od-btn-ghost h-5 px-1 ${copied ? 'text-add' : 'text-muted'} ${className}`}
    >
      {copied ? <CheckIcon /> : <CopyIcon size={12} />}
    </button>
  );
}

/** The copy toast host (mounted once in `App`). */
export function CopyToastHost() {
  const toast = useUi((s) => s.copyToast);
  const store = useUiStore();
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(
      () => {
        if (store.getState().copyToast?.id === toast.id) store.setState({ copyToast: null });
      },
      toast.ok ? COPIED_TIMEOUT_MS + 200 : ERROR_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [toast, store]);
  if (!toast) return null;
  const anchored = toast.at !== undefined;
  return (
    <div
      key={toast.id}
      role="status"
      aria-live="polite"
      data-testid="copy-toast"
      data-state={toast.ok ? 'copied' : 'failed'}
      style={
        toast.at
          ? {
              position: 'fixed',
              left: Math.max(8, Math.min(toast.at.x, window.innerWidth - 8)),
              top: Math.max(8, toast.at.y - 6),
              transform: 'translate(-50%, -100%)',
            }
          : undefined
      }
      className={`od-overlay od-fade-in pointer-events-none z-[60] rounded-md px-2 py-1 text-xs whitespace-nowrap ${
        anchored ? '' : 'fixed bottom-16 left-1/2 -translate-x-1/2'
      } ${toast.ok ? 'text-fg' : 'text-danger'}`}
    >
      {toast.text}
    </div>
  );
}
