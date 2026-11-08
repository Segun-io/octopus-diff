# Theming

> UX round 1, stream ux-web, 2026-11-08. Code: `apps/web/src/theme/`, `apps/web/public/theme-init.js`,
> tests in `apps/web/test/theme.test.ts` and `apps/web/test/prefs.test.ts`.

The goal is "add a theme" as a one-file change, like VS Code or t3.chat, without building a theme zoo
now. Three themes ship: **Octopus Dark**, **Octopus Light** (the brand pair, see IDENTITY.md) and
**Octopus Contrast** (a high-contrast dark theme that proves the registry handles more than two).

## Architecture

```
src/theme/tokens.ts          COLOR_TOKENS: the one list of token names; ThemeDefinition type
src/theme/themes/<id>.ts     one file per theme: a complete token map + kind + diff theme
src/theme/themes/index.ts    THEMES: the registry list (append a line)
src/theme/registry.ts        lookup, ThemePrefs model, resolution, fallbacks, migration helpers
src/theme/css.ts             themesToCss(): token maps → CSS custom properties per theme
src/theme/vite-plugin.ts     serves `virtual:octopus-themes.css` (generated at build time)
src/theme/apply.ts           applyTheme(): data-theme, .dark, color-scheme, <meta theme-color>
src/theme/useTheme.ts        React hook: active ThemeDefinition from prefs + OS scheme
src/theme/contrast.ts        WCAG contrast maths, used by the test
src/styles.css               maps --od-* to Tailwind utilities; non-colour tokens; density
public/theme-init.js         pre-paint: sets data-theme / .dark from localStorage before CSS applies
```

**Themes are data.** A `ThemeDefinition` is `{ id, label, kind: 'light'|'dark', description, colors,
diff: { theme } }` where `colors` is a `Record<ColorToken, '#rrggbb'>`. TypeScript rejects a theme that
misses a token; the unit test rejects one that fails AA.

**Tokens become CSS once.** The Vite plugin turns the registry into a stylesheet:

```css
:root { --od-canvas: #f4f5f9; … color-scheme: light; }          /* = octopus-light */
:root.dark { … }                                                  /* = octopus-dark  */
:root[data-theme="octopus-light"] { … }
:root[data-theme="octopus-dark"] { … }
:root[data-theme="octopus-contrast"] { … }
```

`main.tsx` imports `virtual:octopus-themes.css`, so in production the declarations are part of the main
CSS file loaded from `<head>` and present before the first paint. The `:root` / `:root.dark` blocks are
the brand themes again: an unknown or removed `data-theme` id still paints correctly.

**Apply.** `applyTheme(theme)` sets `data-theme=<id>` (selects the block), toggles `.dark` (keeps
Tailwind's `dark:` variant and `@pierre/trees`' colour scheme working), sets `color-scheme` (native form
controls, scrollbars) and rewrites every `<meta name="theme-color">` to the theme's `canvas`. Density
(`data-density`) is applied next to it; it is not a theme.

**Diff viewer.** Each theme names the shiki theme for `@pierre/diffs` (`diff.theme`, e.g. `pierre-dark`,
`github-dark-high-contrast`). `DiffPane` reads it from `useTheme()` and passes it down, so the diff
surface follows the app theme without any CSS override.

## Preference model

```ts
interface ThemePrefs { mode: 'system' | 'light' | 'dark'; light: ThemeId; dark: ThemeId }
```

`mode` chooses the active slot (`system` follows `prefers-color-scheme`); each slot names a theme of that
kind. Picking a theme in Settings → Appearance fills its slot and switches `mode` to that kind, so the
pick is visible immediately (`selectTheme`). `t` and the toolbar toggle flip `mode` only; the slots keep
the user's choices. Resolution (`resolveTheme`): unknown id → the brand theme of the slot's kind; a dark
theme stored in the light slot → the brand light theme. Nothing can throw.

Stored in `localStorage['octopus-diff:prefs']` with `version: 2`. The v1 string `theme: 'dark'` migrates
to `{ mode: 'dark', light: 'octopus-light', dark: 'octopus-dark' }` on first load (`normalizePrefs`),
and every other v1 key is kept. Malformed JSON yields the defaults.

## No flash on load

`index.html` cannot carry an inline script (CSP `script-src 'self'`), so `<script src="/theme-init.js">`
runs synchronously in `<head>` before the stylesheet applies. It reads the same storage key, understands
both the v1 string and the v2 object, resolves `system` with `matchMedia`, and sets `data-theme`, `.dark`
and `color-scheme`. It knows nothing about token values and does not need to: the generated CSS already
contains every theme. If the stored id no longer exists, the `:root`/`:root.dark` defaults paint and React
corrects the attribute to the fallback id on mount (same kind, so no light/dark flip). In the Vite dev
server CSS arrives through JS modules, so a brief unstyled frame is possible there; production is
flash-free.

## Adding a theme (one file)

1. Create `src/theme/themes/<id>.ts` exporting a `ThemeDefinition` with every token (copy a brand theme).
2. Append it to `THEMES` in `src/theme/themes/index.ts`.
3. Run `pnpm --filter @octopus-diff/web test`: the test checks that every token is present, ids are unique,
   and every text/background pair meets AA (4.5:1 text, 3:1 focus/accent) in your theme. Fix colours until
   it passes.

The picker, the CSS, `theme-init.js`, the preference model and the diff viewer need no change. Removing
a theme is also safe: stored preferences fall back to the brand theme of the same kind.

## Tests

`test/theme.test.ts`: registry ids unique and include both defaults; every theme defines exactly
`COLOR_TOKENS`; AA contrast for every text token on `canvas`, `surface`, `raised`, `overlay`, `selected`,
`hover`, plus `accentSoft`, `addSoft`, `delSoft` and `accentFg` on `accent`; focus and accent ≥ 3:1 on
every surface; brand hue distinct from the semantic hues; resolution, fallback and v1 migration; the
generated CSS declares every token for every theme and the root defaults. `test/prefs.test.ts`: v1 → v2
migration keeps every old value, malformed storage yields defaults, v2 round-trips.
