import { type ReactNode, useEffect, useRef } from 'react';
import { useEscapeToClose } from '../lib/useEscape.ts';
import { CloseIcon } from './bits.tsx';

/** Accessible modal: focuses itself on open, traps Tab, closes on Escape, restores focus. */
export function Dialog({
  title,
  onClose,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Escape must work even when the focused control was disabled or removed (see useEscape.ts).
  useEscapeToClose(true, onClose);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, button, select, [tabindex]');
    (first ?? ref.current)?.focus();
    return () => previous?.focus?.();
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !ref.current) return;
    const focusable = [
      ...ref.current.querySelectorAll<HTMLElement>(
        'input, button, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => !el.hasAttribute('disabled'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes the dialog
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the dialog itself
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="od-overlay od-fade-in max-h-[76vh] w-[min(560px,92vw)] overflow-auto rounded-lg p-4"
      >
        <div className="mb-3 flex items-center">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="od-btn od-btn-ghost ml-auto"
          >
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
