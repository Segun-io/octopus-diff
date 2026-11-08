# WS5 — CLI, packaging, docs, CI report

Branch `ws/cli`, based on `db5274c`. Date: 2026-11-08.

## Shipped

**`octopus-diff` CLI** (`apps/cli`, bin `apps/cli/dist/index.js`, still `private: true`):

| Command | What it does | Entry point |
|---|---|---|
| `serve [path…]` (default command) | Loads `config.json`, merges flags (`--port --host --open/--no-open --scan… --depth --allow-non-loopback --allowed-host… --watch/--no-watch --poll --web-root`) into `StartDaemonOptions`, finds the web build, calls `startDaemon`, writes `<stateDir>/daemon.json`, prints a banner with the tokenized `authUrl`, optionally opens the browser, and shuts down on SIGINT/SIGTERM/SIGHUP via `handle.close()` (10 s timeout). Clear messages for EADDRINUSE (also says if the port belongs to another octopus-diff), EACCES, non-loopback without the flag, and "already running for this state dir" (prints that daemon's URL instead). | `src/commands/serve.ts` |
| `add <path…> [--scan <dir>…] [--depth n]` | Finds the daemon (`--url` > `daemon.json` > host/port), reads `<stateDir>/token`, calls `addProject` / `addScanRoot` with absolute paths. No daemon → "no octopus-diff daemon is running at …; start one with `octopus-diff serve`", exit 1. | `src/commands/add.ts`, `src/commands/daemon-client.ts` |
| `status [--open] [--json]` | Health, project/worktree counts, re-prints the tokenized URL. | `src/commands/status.ts` |
| `doctor [--json]` | Node ≥ 24, git found + ≥ `MIN_GIT_VERSION` (2.25.0, provisional), platform/WSL + `/mnt/*` caveat, inotify `max_user_watches`/`max_user_instances` with the sysctl fix, config file validity, state dir / token file permissions (0600), port availability (or "already running"), web assets. Exit 1 on any failure. | `src/commands/doctor.ts` |
| `config [--path] [--schema]` | Shows the effective config / prints its JSON Schema. | `src/commands/config.ts` |
| `help [command]`, `--version` | | `src/cli.ts` |

Supporting modules: `args.ts` (parseArgs), `config.ts` (zod schema `ConfigSchema`, `loadConfig`),
`settings.ts` (path resolution, flag/config merge → `StartDaemonOptions`, loopback checks),
`paths.ts` (XDG), `runtime.ts` (`daemon.json`, token), `web-assets.ts`, `open-browser.ts`,
`platform.ts` (WSL detection), `logger.ts`, `deps.ts` (`CliDeps`: every side effect is injectable —
`loadStartDaemon`, `createApiClient`, `openUrl`, `waitForShutdown`, `runProgram`, `readText`,
`probePort`, `isProcessAlive`, `now`), `cli.ts` (`run(argv, deps)` → exit code; never calls
`process.exit`), `index.ts` (bin; symlink-safe main-module check).

**Config file** `~/.config/octopus-diff/config.json` (honors `XDG_CONFIG_HOME`, or `--config`),
documented in README with an example that a test validates against the schema.

**Web assets:** `pnpm build` copies `apps/web/dist` → `apps/cli/dist/web` (`scripts/copy-web-assets.mjs`);
`@octopus-diff/web` is a devDependency so the topological build runs web first (verified from a clean
`dist`).

**Self-contained tarball (stretch):** `pnpm --filter octopus-diff run pack:tarball` →
`apps/cli/.pack/octopus-diff-0.0.0.tgz` (esbuild bundle of CLI + contracts + git-core + daemon + zod/hono,
`@parcel/watcher` as the only dependency, web UI in `dist/web`). Installed and run from an empty temp
dir. Never published.

**Docs and CI:** `README.md` (what/why, read-only guarantee, requirements incl. git ≥ 2.25, install,
usage, config, files, security model: loopback/token/cookie/`?token=` redirect/Host/Origin, inotify and
WSL notes, limitations), `CONTRIBUTING.md` (setup, scripts, layout, conventions, read-only rules,
fixture/git-config isolation, e2e, CI), `.github/workflows/ci.yml` (committed, never pushed).

## Verification

All commands run at the repo root on this machine (Node 26.13.0, pnpm 12.16.1, git 2.53.0, WSL2):

| Command | Result |
|---|---|
| `pnpm lint` | exit 0 — "Checked 89 files … No fixes applied." |
| `pnpm typecheck` | exit 0 (7 packages) |
| `pnpm test` | exit 0 — cli: **10 files, 106 passed, 2 skipped** (108); contracts 57 passed; fixtures, git-core, web, daemon 1 each (placeholders) |
| `pnpm build` | exit 0; after `rm -rf apps/web/dist apps/cli/dist`, web builds before cli and `copy-web-assets: copied ../web/dist -> dist/web` |
| `node apps/cli/dist/index.js serve --port 0 --state-dir <tmp> --config-dir <tmp>` | exit 1 — `octopus-diff: failed to start the daemon: daemon is a placeholder until WS2 lands` (expected on this branch: everything up to `startDaemon` runs) |
| `node apps/cli/dist/index.js doctor --state-dir <tmp> --config-dir <tmp>` | exit 0 — "0 problems, 1 warning" (`max_user_instances = 128` on this machine) |
| `pnpm --filter octopus-diff run pack:tarball`, then `npm install ./octopus-diff-0.0.0.tgz` in an empty temp dir | tarball 839 874 bytes, 9 files; installed `octopus-diff --version` → `0.0.0`; `doctor` finds the bundled web UI; `serve` reaches the placeholder daemon |
| `npx @action-validator/cli .github/workflows/ci.yml` | exit 0 (and exit 1 with errors on a deliberately broken file) |
| actionlint 2.0.6 (wasm, from npm) on `ci.yml` | 0 issues (and it reports a planted error) |
| `pnpm install` | **exit 1** — "Ignored build scripts: esbuild@0.28.2" (same on the base commit; see Known gaps) |

What the CLI tests cover: argument parsing (every flag, errors), config loading/validation/path
resolution/merging, XDG paths, loopback checks, `serve` against a fake `startDaemon` (options passed,
banner, runtime file 0600 written and removed, `--open`, open failure, EADDRINUSE incl. another
octopus-diff, other start errors, API-only fallback, explicit web root, non-loopback refusal, invalid
config, close timeout, close error, already-running and stale runtime file, WSL `/mnt` warning, signals
registered before start), `add`/`status` against a fake fetch (bearer token, runtime-file discovery,
`--url`/`--port`, no daemon, non-octopus server, missing dir, not a repo, duplicate, token mismatch,
missing token, `--json`), doctor (each check, statuses, exit codes, JSON), browser-open command
selection and fallback (no shell), logger, web-asset resolution, README accuracy, and one live test:
`serve` + `add` + `status` over real HTTP on an ephemeral loopback port with a `node:http` stub daemon.

The 2 skipped tests (`test/integration.test.ts`) need the real daemon; see Notes for integration.

## Decisions

Logged as WS5 #1–#18 in `docs/DECISIONS.md`. The main ones: bare `octopus-diff` = `serve`; exit codes
0/1/2; strict config schema, scalar flags win and list flags add; the CLI always passes explicit
`stateDir`/`configDir`; `<stateDir>/daemon.json` runtime file for discovery; one daemon per state dir;
`add` fails without a daemon (no offline fallback); CLI-side non-loopback refusal; web-asset lookup
order; WSL opener chain `wslview` → PowerShell `-EncodedCommand` → `xdg-open`; provisional
`MIN_GIT_VERSION = 2.25.0`; doctor runs only `git --version` from the temp dir; extra `status` and
`config` commands; esbuild-bundled tarball; CI action versions and install flags.

## Contract changes

None. The CLI uses `StartDaemonOptions` / `DaemonHandle`, `createApiClient`, `ApiClientError`,
`HealthResponse`, `DEFAULT_HOST`/`DEFAULT_PORT`, `AUTH_QUERY_PARAM`, `SCAN_DEPTH_*`,
`InputPathSchema`, `ScanDepthSchema` as they are.

## Known gaps

- **Real `serve` not verified end to end**: the daemon is a placeholder on this branch, so
  `startDaemon` throws. Everything before and after it is tested with fakes and a stub HTTP daemon.
- **`pnpm install` exits 1** because esbuild's build script is neither allowed nor denied in
  `pnpm-workspace.yaml` (pre-existing; BLOCKERS WS5 #1). CI works around it with
  `--config.strict-dep-builds=false`.
- `MIN_GIT_VERSION` (2.25.0) is provisional until WS1 settles the minimum; README says "git ≥ 2.25".
- `--open` was not exercised against a real browser (tests must not open one); the command chains
  are unit-tested. The PowerShell fallback on WSL and `rundll32` on native Windows are untested on
  real systems. Native Windows in general is untested.
- The tarball bundles the daemon from sources. If WS2's daemon loads files relative to its own module
  (`import.meta.url`, e.g. SQL migrations) those would need copying in `scripts/pack.mjs`; today the
  daemon has none. If WS2 adds more native dependencies, add them to `EXTERNAL_PACKAGES` there.
- The CI workflow has never run on GitHub (no remote, by design); it is validated only statically.
- No token rotation command (documented manual procedure: stop, delete the token file, start).

## Notes for integration

1. **Un-skip:** nothing to do by hand. `test/integration.test.ts` probes `startDaemon` and calls
   `ctx.skip()` only while it throws an error matching `/placeholder/`. Once WS2 is merged, both tests
   run: (a) in-process `serve --port 0 --no-watch` with the real daemon, checks `/api/health` = 200,
   the `Open:` line, token file mode 0600, clean exit on a signal; (b) the **built** binary:
   `node apps/cli/dist/index.js serve --port 0 --no-watch --state-dir <tmp> --config-dir <tmp>`,
   waits for the `Open:` line, fetches `/api/health` (200) and `/` (200/302/401 accepted), sends
   SIGINT, expects exit 0. (b) needs `pnpm build` first; it is skipped if `apps/cli/dist/index.js`
   does not exist. If WS2's real error doesn't say "placeholder" the probe rethrows, so a broken
   daemon fails loudly rather than skipping.
2. **What the CLI expects from WS2's daemon** (all per the contracts / DECISIONS #16):
   the token in `<stateDir>/token` (the CLI reads it for `add`/`status` and doctor checks its mode);
   `handle.url` / `handle.authUrl` (`<url>/?token=<token>`), `host`, `port` (the real one when
   `port: 0`); a listen failure that carries `code: 'EADDRINUSE'` somewhere in the error or its
   `cause` chain (or the string `EADDRINUSE` in the message); `webRoot: null` meaning API only;
   `close()` that releases everything (the bin has a 2 s fallback exit, but a hang there is a bug).
3. **Web assets:** in the workspace, `serve` serves `apps/web/dist` directly (detected via
   `apps/web/package.json` name), else `apps/cli/dist/web` (copied by the CLI build), else
   `--web-root`/config `webRoot`. The daemon only receives the resolved `webRoot` path.
4. **Root-file changes recommended (not made, lead-owned):**
   - `pnpm-workspace.yaml`: add `esbuild: false` under `allowBuilds` so `pnpm install` exits 0; then
     drop `--config.strict-dep-builds=false` from `PNPM_INSTALL_FLAGS` in `ci.yml` and the note in
     CONTRIBUTING.
   - Optionally add `.pack/` to the root `.gitignore` (today `apps/cli/.gitignore` covers it).
5. **Lockfile:** `apps/cli` gained `zod` (dependency), `@octopus-diff/web` and `esbuild`
   (devDependencies); `pnpm-lock.yaml` changed accordingly. Re-run `pnpm install` after merging.
6. **README** describes the finished MVP behavior (UI features, security model, read-only rules) with
   a status banner saying `serve` stops at the placeholder; remove the banner once the acceptance list
   passes. A unit test fails if the README's config example stops matching the schema or a `serve`
   option is undocumented.
7. **Merge order:** the CLI depends only on the contracts and the daemon's `startDaemon` export, so it
   can merge last as planned (PLAN §6 Phase 2).
