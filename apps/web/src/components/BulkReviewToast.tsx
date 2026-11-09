import { TEST_IDS } from '@octopus-diff/contracts';
import { useCallback, useEffect, useRef } from 'react';
import { useEscapeToClose } from '../lib/useEscape.ts';
import { useCommandsContext } from '../state/commandsContext.tsx';
import { useUi, useUiStore } from '../state/ui.tsx';
import { CheckIcon, CloseIcon } from './bits.tsx';

/** Toast after a bulk mark (undo inside) and the confirm dialog before a multi-worktree one. */
export function BulkReviewToast() {
  const toast = useUi((s) => s.bulkToast);
  const confirm = useUi((s) => s.bulkConfirm);
  const commands = useCommandsContext();
  const store = useUiStore();
  return (
    <>
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-2"
      >
        {toast && (
          <div
            data-testid={TEST_IDS.bulkReviewToast}
            data-changed={String(toast.changed)}
            data-reviewed={String(toast.reviewed)}
            data-state={toast.state}
            role="status"
            className="od-overlay od-slide-up pointer-events-auto flex items-center gap-3 rounded-md px-3 py-2 text-xs"
          >
            <span className={toast.state === 'failed' ? 'text-danger' : 'text-add'}>
              <CheckIcon />
            </span>
            <span>{toast.text}</span>
            {toast.state === 'done' && toast.undoToken && (
              <button
                type="button"
                data-testid={TEST_IDS.bulkReviewUndo}
                onClick={() => commands.undoBulk()}
                className="od-btn border-line-strong font-medium text-fg"
                title="Undo (Ctrl/⌘ Z)"
              >
                Undo
              </button>
            )}
            {toast.state === 'undoing' && <span className="text-muted">Undoing…</span>}
            <button
              type="button"
              onClick={() => store.setState({ bulkToast: null })}
              aria-label="Dismiss"
              className="od-btn od-btn-ghost"
            >
              <CloseIcon />
            </button>
          </div>
        )}
      </div>
      {confirm && <ConfirmBulk {...confirm} />}
    </>
  );
}

function ConfirmBulk({
  reviewed,
  count,
  worktrees,
}: {
  reviewed: boolean;
  count: number;
  worktrees: number;
}) {
  const commands = useCommandsContext();
  const ref = useRef<HTMLButtonElement>(null);
  const cancel = useCallback(() => commands.cancelBulk(), [commands]);
  useEscapeToClose(true, cancel);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus?.();
  }, []);
  const what = count >= 0 ? `${count} ${count === 1 ? 'file' : 'files'}` : 'every changed file';
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click cancels
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape handled on the dialog
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[20vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) commands.cancelBulk();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={`Mark ${what} ${reviewed ? 'reviewed' : 'unreviewed'}?`}
        className="od-overlay od-fade-in w-[min(420px,92vw)] rounded-lg p-4 text-xs"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            commands.cancelBulk();
          }
        }}
      >
        <p className="text-sm font-semibold">
          Mark {what} {reviewed ? 'reviewed' : 'unreviewed'}?
        </p>
        <p className="mt-1 text-muted">
          Across {worktrees} worktrees. You can undo this afterwards (Ctrl/⌘ Z while the notice is
          shown). Turn this confirmation off in Settings → General.
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={() => commands.cancelBulk()} className="od-btn px-3">
            Cancel
          </button>
          <button
            ref={ref}
            type="button"
            onClick={() => commands.confirmBulk()}
            className="od-btn od-btn-primary px-3"
          >
            Mark {reviewed ? 'reviewed' : 'unreviewed'}
          </button>
        </div>
      </div>
    </div>
  );
}
