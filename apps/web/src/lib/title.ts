import { useEffect } from 'react';

export const APP_TITLE = 'octopus-diff';

/** `(12) octopus-diff` while unreviewed files exist (user setting; default on). */
export function formatTitle(unreviewed: number, showCount: boolean): string {
  return showCount && unreviewed > 0 ? `(${unreviewed}) ${APP_TITLE}` : APP_TITLE;
}

export function useDocumentTitle(unreviewed: number, showCount: boolean): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const next = formatTitle(unreviewed, showCount);
    if (document.title !== next) document.title = next;
  }, [unreviewed, showCount]);
}
