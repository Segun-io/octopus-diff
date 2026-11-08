// Pre-paint theme selection (docs/design/THEMING.md). Runs before the stylesheet applies so the
// first frame already has the right colours. External file: the CSP forbids inline scripts.
// Must stay dependency-free and in sync with src/state/prefs.ts (storage key, shape).
(() => {
  try {
    const raw = localStorage.getItem('octopus-diff:prefs');
    const prefs = raw ? JSON.parse(raw) : null;
    const theme = prefs?.theme;
    const ids = { light: 'octopus-light', dark: 'octopus-dark' };
    let mode = 'system';
    if (typeof theme === 'string') mode = theme;
    else if (theme && typeof theme === 'object') {
      if (typeof theme.mode === 'string') mode = theme.mode;
      if (typeof theme.light === 'string') ids.light = theme.light;
      if (typeof theme.dark === 'string') ids.dark = theme.dark;
    }
    const dark =
      mode === 'dark' ||
      (mode !== 'light' &&
        typeof matchMedia === 'function' &&
        matchMedia('(prefers-color-scheme: dark)').matches);
    const root = document.documentElement;
    root.setAttribute('data-theme', dark ? ids.dark : ids.light);
    if (dark) root.classList.add('dark');
    root.style.colorScheme = dark ? 'dark' : 'light';
  } catch {
    // No storage or malformed prefs: the stylesheet defaults (system scheme) apply.
  }
})();
