# Credits

octopus-diff is built on open-source software. This file credits every third-party package the
repository depends on, the code we adapted from other projects, and the projects whose ideas shaped it.
octopus-diff itself is MIT licensed (see [LICENSE](LICENSE)).

**Keep this file current.** Adding, removing or replacing a dependency, or a license change after a
version bump, updates this file in the same commit. So does copying or adapting code from another
project. `pnpm lint` runs `scripts/check-credits.mjs`, which fails when a direct dependency in any
`package.json` is missing from the tables below, when a table row names a package that is no longer a
dependency, or when a row's license differs from the installed package's `license` field. See
[AGENTS.md § Dependencies](AGENTS.md#dependencies).

## Shipped with octopus-diff

Runtime dependencies: they run in the daemon or CLI, or are bundled into the web UI.

| Package | Used by | License | Project |
|---|---|---|---|
| `zod` | contracts, cli, web | MIT | https://github.com/colinhacks/zod |
| `hono` | daemon | MIT | https://github.com/honojs/hono |
| `@hono/node-server` | daemon | MIT | https://github.com/honojs/node-server |
| `@parcel/watcher` | daemon | MIT | https://github.com/parcel-bundler/watcher |
| `@pierre/diffs` | web | Apache-2.0 | https://www.npmjs.com/package/@pierre/diffs |
| `@pierre/trees` | web | Apache-2.0 | https://www.npmjs.com/package/@pierre/trees |
| `@tanstack/react-query` | web | MIT | https://github.com/TanStack/query |
| `react` | web | MIT | https://github.com/facebook/react |
| `react-dom` | web | MIT | https://github.com/facebook/react |
| `tailwindcss` | web (build; its generated CSS ships) | MIT | https://github.com/tailwindlabs/tailwindcss |

Pulled in by those packages (not listed in our `package.json` files, so the check does not track them;
review this list when a direct dependency above changes):

- Syntax highlighting, via `@pierre/diffs`: `shiki` and `@shikijs/*` (MIT), `oniguruma-to-es`,
  `oniguruma-parser`, `regex`, `regex-recursion`, `regex-utilities` (MIT); Pierre's `@pierre/highlights`,
  `@pierre/theme`, `@pierre/theming` (Apache-2.0); `diff` (BSD-3-Clause); `lru_map` (MIT).
- HTML/syntax-tree utilities from the unified collective, via `shiki`: `hast-util-to-html`,
  `hast-util-whitespace`, `mdast-util-to-hast`, `micromark-util-*`, `unist-util-*`, `vfile`,
  `vfile-message`, `property-information`, `stringify-entities`, `character-entities-html4`,
  `character-entities-legacy`, `ccount`, `comma-separated-tokens`, `space-separated-tokens`,
  `html-void-elements`, `trim-lines`, `zwitch`, `devlop` (all MIT); `@ungap/structured-clone` (ISC);
  `dequal` (MIT).
- File tree rendering, via `@pierre/trees`: `preact`, `preact-render-to-string` (MIT).
- React and TanStack internals: `scheduler`, `@tanstack/query-core` (MIT).
- File watching, via `@parcel/watcher`: its prebuilt `@parcel/watcher-<platform>` binaries,
  `node-addon-api`, `picomatch`, `is-glob`, `is-extglob` (MIT); `detect-libc` (Apache-2.0).

## Development tools

Used to build, lint and test octopus-diff; not shipped.

| Package | Used by | License | Project |
|---|---|---|---|
| `@biomejs/biome` | root | MIT OR Apache-2.0 | https://github.com/biomejs/biome |
| `typescript` | root | Apache-2.0 | https://github.com/microsoft/TypeScript |
| `tsx` | root | MIT | https://github.com/privatenumber/tsx |
| `vitest` | root | MIT | https://github.com/vitest-dev/vitest |
| `@types/node` | root | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `esbuild` | cli | MIT | https://github.com/evanw/esbuild |
| `vite` | web | MIT | https://github.com/vitejs/vite |
| `@vitejs/plugin-react` | web | MIT | https://github.com/vitejs/vite-plugin-react |
| `@tailwindcss/vite` | web | MIT | https://github.com/tailwindlabs/tailwindcss |
| `@types/react` | web | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `@types/react-dom` | web | MIT | https://github.com/DefinitelyTyped/DefinitelyTyped |
| `diff` | web (mock backend) | BSD-3-Clause | https://github.com/kpdecker/jsdiff |
| `jsdom` | web | MIT | https://github.com/jsdom/jsdom |
| `@testing-library/dom` | web | MIT | https://github.com/testing-library/dom-testing-library |
| `@testing-library/react` | web | MIT | https://github.com/testing-library/react-testing-library |
| `@testing-library/user-event` | web | MIT | https://github.com/testing-library/user-event |
| `@playwright/test` | web, e2e | Apache-2.0 | https://github.com/microsoft/playwright |

## Programs octopus-diff runs

- **[Git](https://git-scm.com/)** (GPL-2.0). The daemon runs the user's installed `git` as a separate
  program; octopus-diff does not bundle or link it.

## Code adapted from other projects

Each adapted file also carries an attribution comment.

- **[T3 Code](https://github.com/pingdotgg/t3code)**, MIT License, Copyright (c) 2026 T3 Tools Inc.
  - `apps/web/src/components/diff/DiffWorkerPool.tsx`: adapted from
    `apps/web/src/components/DiffWorkerPoolProvider.tsx`.
  - `apps/web/src/lib/folderPath.ts`: path rules of the command-palette browse mode.
  - `apps/web/test/folderPath.test.ts`: test cases ported from `packages/shared/src/path.test.ts`.
  - The sidebar (folders, settled shelf, settling by hand) and the folder picker / command-palette
    browse mode are modelled on T3 Code's UI.

## Inspiration (ideas only, no code)

gitpane, difit, SproutGit, overgit, Archipel, DiffDino, Emdash, Paradev and Vibe Kanban, which explored
multi-repository, worktree and agent-review views before us (see `docs/PLAN.md` §3).
