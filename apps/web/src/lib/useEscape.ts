import { useEffect } from 'react';

/**
 * Closes an overlay on Escape no matter where focus is. Dialogs and menus handle Escape on their
 * own element, but focus leaves them when the clicked control is removed (an override row after
 * "Inherit") or disabled during a mutation (the default switch, the On/Off/Inherit buttons);
 * the global shortcut handler defers to open dialogs, so Escape was dead in those states.
 * Listens in the capture phase so it runs before the element handlers and marks the event
 * handled for them (`defaultPrevented`).
 */
export function useEscapeToClose(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);
}
