# Contributing to octopus-diff

Thanks for helping. octopus-diff is a read-only, diff-first, multi-project git UI: a Node daemon that
shells out to the `git` CLI, plus a browser UI. Before changing anything, read
[`docs/PLAN.md`](docs/PLAN.md) (vision, locked decisions, architecture, contracts, acceptance list) and
[`AGENTS.md`](AGENTS.md) (conventions; coding agents follow it too). Decisions that deviate from the
plan are logged in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Setup

Requirements: **Node.js ≥ 24** (development happens on Node 26), **pnpm 12** (pinned through
`packageManager`; `corepack enable` or `npm i -g pnpm@12` gets it), **git ≥ 2.31**.

```sh
pnpm install
pnpm check            # lint + typecheck + unit tests + build: run this before every commit
```

pnpm 12 blocks dependency build scripts. The ones this repo pulls in (`esbuild`, `@parcel/watcher`)
are denied in `allowBuilds` in `pnpm-workspace.yaml`: both ship prebuilt platform binaries as
optional dependencies, so nothing needs to run at install time. If you add a dependency whose script
is truly required, approve it there and say why in `docs/DECISIONS.md`.

## Scripts (from the repository root)

| Command | What it does |
|---|---|
| `pnpm lint` | Biome lint + format check (`pnpm lint:fix` applies fixes) |
| `pnpm typecheck` | `tsc` in every package, against workspace **sources** (no build needed) |
| `pnpm test` | vitest unit tests in every package (no build needed) |
| `pnpm build` | topological build: contracts → git-core → daemon → web → cli |
| `pnpm test:e2e` | Playwright end-to-end tests (`e2e/`; needs `pnpm build` first) |
| `pnpm check` | lint + typecheck + test + build |
| `pnpm --filter octopus-diff run pack:tarball` | self-contained CLI tarball in `apps/cli/.pack/` (never published) |

Per package: `pnpm --filter <name> <script>`, with names `@octopus-diff/contracts`,
`@octopus-diff/git-core`, `@octopus-diff/daemon`, `@octopus-diff/web`, `octopus-diff` (the CLI),
`@octopus-diff/fixtures`, `@octopus-diff/e2e`. Every package has `build`, `typecheck`, `test`, `lint`.

Run TypeScript sources directly while developing:

```sh
pnpm exec tsx --conditions=@octopus-diff/source apps/cli/src/index.ts serve --port 0
pnpm --filter @octopus-diff/web dev     # Vite dev server; proxies /api to OCTOPUS_DIFF_API (default :7428)
```

## Layout

```
packages/contracts/   zod schemas, types, routes, SSE events, API client, GitCore + daemon interfaces
packages/git-core/    the read-only git runner, parsers, discovery, diff retrieval
apps/daemon/          HTTP + SSE server (Hono), registry, watcher, review store (node:sqlite)
apps/web/             React UI (Vite, TanStack Query, Tailwind, @pierre/diffs, @pierre/trees)
apps/cli/             the `octopus-diff` command: serve / add / status / doctor / config, packaging
tools/fixtures/       scratch-repo generator, agent simulator, perf bench, read-only proof harness
e2e/                  Playwright tests
docs/                 PLAN, DECISIONS, BLOCKERS, stream reports
```

Workspace packages resolve each other through a custom export condition, `@octopus-diff/source`,
which points at `src/index.ts`. typecheck, vitest and Vite use it, so nothing needs to be built first.
`tsconfig.build.json` clears it, so `tsc` builds against the dependencies' `dist/`, and plain Node runs
the built CLI from `dist/`. New packages must follow the same pattern (see an existing `package.json`).

The CLI build copies `apps/web/dist` into `apps/cli/dist/web`, so a packed CLI carries its UI. In a
checkout, `octopus-diff serve` prefers `apps/web/dist` (so rebuilding only the web app is enough), then
`apps/cli/dist/web`; `--web-root <dir>` overrides both.

## Conventions

- TypeScript strict, ESM only, `module: nodenext`: relative imports end in `.js` (the web app uses
  bundler resolution and may import `.tsx`). Named exports; default exports only where a tool needs
  them (Vite/Vitest/Playwright configs).
- Node built-ins use the `node:` prefix. `packages/contracts/src` and `apps/web/src` must not import
  Node built-ins (Biome enforces it): the contracts are shared with the browser.
- Biome formats and lints: 2-space indent, single quotes, semicolons, line width 100. Run
  `pnpm lint:fix` before committing. Markdown is not auto-formatted.
- Tests live in `<package>/test/**/*.test.ts` (the web app may also colocate `src/**/*.test.tsx`).
- Validate every input at the boundary with the zod schemas from `@octopus-diff/contracts`.
- Errors from git-core are `GitCoreError` with a `code`; the daemon maps them to `ApiErrorBody`.
- Contracts evolve **additively** (new optional fields, schemas, routes, events). Renames, removals or
  meaning changes need a decision in `docs/DECISIONS.md` first.
- Dependencies: prefer small, well-maintained MIT / Apache-2.0 / BSD / ISC packages, added to the
  package that uses them. Ideas may come from anywhere, but copy code only from MIT / Apache-2.0
  sources, with attribution. Never copy from GitButler (FSL), Zed or Detached (GPL-3).
- Credits: the app lists every open-source package it uses, with its license, in Settings → About,
  and [CREDITS.md](CREDITS.md) lists the same. Both are generated: after any dependency change run
  `pnpm credits` and commit the result (`pnpm lint` fails until you do). Code adapted from another
  project goes into `scripts/credits/acknowledgements.json`.
- Commit messages: `<area>: <what>`, e.g. `git-core: parse status porcelain v2`.

## The read-only guarantee (non-negotiable)

octopus-diff must never modify a user's repository. Reviews reject anything that weakens this:

- All git access goes through the single runner in `packages/git-core`. No other package spawns `git`
  against user repositories (test fixture setup is the only exception). The CLI's `doctor` runs only
  `git --version`, from the temp directory.
- A hard subcommand allowlist; `--no-optional-locks` plus `GIT_OPTIONAL_LOCKS=0`;
  `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `LC_ALL=C`; `--no-ext-diff --no-textconv` on diffs;
  `-z` output formats; argv arrays only.
- **Never use `shell: true`** or build command strings. Never pass user input where git could read it
  as an option: validate refs and paths with the contract schemas, and use `--end-of-options` / `--`
  separators and literal pathspecs.
- Treat repository config as untrusted (for example `core.fsmonitor` can run programs).
- The proof tests in `tools/fixtures` / `e2e` assert that a full run creates no `index.lock` and
  leaves `.git/index`, refs and `git status` unchanged. Keep them green.

## Tests that create git repositories

- Create fixtures under the OS temp dir with `fs.mkdtemp(path.join(os.tmpdir(), 'octopus-diff-'))`
  and delete them afterwards. Never touch real repositories.
- **Isolate git config**: a developer's global config (`core.autocrlf`, `core.pager=delta`, …) changes
  git's output. For every git process that creates or inspects fixtures set
  `GIT_CONFIG_GLOBAL=<a file in the temp dir>`, `GIT_CONFIG_NOSYSTEM=1`, and explicitly `user.name`,
  `user.email`, `init.defaultBranch=main`, `commit.gpgsign=false`, `core.autocrlf=false`. Use fixed
  `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` where determinism matters. git-core's
  `GitCoreOptions.env` passes the same variables to the runner.
- Tests that start servers bind `127.0.0.1` on port `0`, keep config and state in temp dirs (pass
  `--config-dir` / `--state-dir` or an injected env; never the real `~/.config` or `~/.local/state`),
  and never open a browser.

## End-to-end tests

```sh
pnpm build
pnpm --filter @octopus-diff/e2e exec playwright install --with-deps chromium   # once
pnpm test:e2e
```

`playwright install --with-deps` needs root for the system libraries. Without root, extract
`libnss3`, `libnspr4` and `libasound2` locally (for example with `apt-get download` + `dpkg -x`) into
`~/.cache/octopus-diff-dev/chromium-libs/` (the libraries end up in `usr/lib/x86_64-linux-gnu/` below
it), or point `OCTOPUS_DIFF_CHROMIUM_LIBS` at the directory holding the `.so` files; `e2e/playwright.config.ts` adds it to `LD_LIBRARY_PATH`.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs lint, typecheck, unit tests, build and a
CLI smoke test on Node 24 and 26; Playwright e2e on Node 26 (with `playwright install --with-deps
chromium`); and builds the CLI tarball and runs it from a clean directory. Validate workflow changes
locally, for example with `npx @action-validator/cli .github/workflows/ci.yml`.

## Reporting security issues

The daemon serves repository contents over HTTP. If you find a way around the token, the Host/Origin
checks or the read-only guarantee, please report it privately to the maintainers instead of opening a
public issue.
