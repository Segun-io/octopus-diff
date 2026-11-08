import { useEffect } from 'react';

/** Mark geometry shared with `components/Mark.tsx` and `public/favicon.svg`. */
export const MARK_BODY =
  'M16 3 C22 3 26 7.5 26 13.5 C26 16.5 24.5 18.5 22.5 19.5 L9.5 19.5 C7.5 18.5 6 16.5 6 13.5 C6 7.5 10 3 16 3 Z';
export const MARK_ARMS = [
  'M9.5 19.5 C9.5 23 6 24 3 24.5',
  'M13 19.5 C13 24 10 27 8 29',
  'M16 19.5 L16 29',
  'M19 19.5 C19 24 22 27 24 29',
  'M22.5 19.5 C22.5 23 26 24 29 24.5',
];

/**
 * The favicon with an amber dot (unreviewed changes exist), as a `data:` SVG so the CSP
 * (`img-src 'self' data:`) allows it. Colour follows the OS scheme like `favicon.svg`.
 */
export function faviconWithDot(): string {
  const arms = MARK_ARMS.map((d) => `<path d="${d}" fill="none"/>`).join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<style>.m{fill:#1a1d26;stroke:#1a1d26}@media(prefers-color-scheme:dark){.m{fill:#e4e7ee;stroke:#e4e7ee}}</style>` +
    `<mask id="e"><rect width="32" height="32" fill="#fff"/>` +
    `<rect x="10.3" y="12" width="4.4" height="1.8" rx=".9"/><rect x="17.3" y="12" width="4.4" height="1.8" rx=".9"/>` +
    `<circle cx="26" cy="6" r="7" fill="#000"/></mask>` +
    `<g class="m" stroke-width="2.6" stroke-linecap="round" mask="url(#e)"><path d="${MARK_BODY}" stroke="none"/>${arms}</g>` +
    `<circle cx="26" cy="6" r="5" fill="#e0ae52"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const FAVICON_HREF = '/favicon.svg';

export function applyFaviconDot(active: boolean, doc: Document = document): void {
  const link = doc.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
  if (!link) return;
  const next = active ? faviconWithDot() : FAVICON_HREF;
  if (link.getAttribute('href') !== next) link.setAttribute('href', next);
}

/** Shows a dot on the favicon while unreviewed changes exist (follows the title-count pref). */
export function useFaviconDot(active: boolean): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    applyFaviconDot(active);
  }, [active]);
}
