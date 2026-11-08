import type { ThemeDefinition } from './tokens.ts';

/**
 * Applies a theme to the document: `data-theme` selects the generated CSS block, `.dark` keeps
 * Tailwind's `dark:` variant working, `color-scheme` fixes form controls and scrollbars, and the
 * `theme-color` metas follow the canvas colour (browser chrome, PWA title bar).
 */
export function applyTheme(theme: ThemeDefinition, doc: Document = document): void {
  const root = doc.documentElement;
  if (root.dataset.theme !== theme.id) root.dataset.theme = theme.id;
  root.classList.toggle('dark', theme.kind === 'dark');
  root.style.colorScheme = theme.kind;
  for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    if (meta.content !== theme.colors.canvas) meta.content = theme.colors.canvas;
  }
}
