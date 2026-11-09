# dev-hot-reload report

## Shipped

`pnpm dev`: one command for hot-reload development, reachable from the LAN as `odino`.

- `scripts/dev.mjs`: supervisor (plain Node ESM, no dependencies). It spawns, from argv arrays with no
  shell and each child in its own process group:
  - `[daemon]` `tsx watch --clear-screen=false --conditions=@octopus-diff/source apps/cli/src/index.ts serve
    --host :: --allow-non-loopback --port 7429 --allowed-host localhost|127.0.0.1|odino|odino.local|<LAN IPv4s>
    --state-dir ~/.local/state/octopus-diff-dev --no-open -- <repos>`. It restarts on edits to any file the
    daemon imports (apps/cli, apps/daemon, packages/* sources).
  - `[web]` Vite from `apps/web` with `OCTOPUS_DIFF_API=http://127.0.0.1:7429`, `OCTOPUS_DIFF_WEB_HOST=::`,
    `OCTOPUS_DIFF_WEB_PORT=5173`, `OCTOPUS_DIFF_ALLOWED_HOSTS=odino,odino.local,<LAN IPv4s>`.
  - It prints a `[dev]` banner with the token URLs on the Vite port (Local, `odino`, `odino.local`, LAN IPs)
    and a one-line notice on each daemon restart. It checks both ports before spawning, rejects 7428, forwards
    SIGINT/SIGTERM/SIGHUP (one SIGTERM per child, SIGKILL to the groups after 8 s), and stops the sibling and
    exits 1 when a child dies. A second `pnpm dev` on the same state dir exits 1.
  - Options: `--daemon-port`, `--web-port`, `--allowed-host` (repeatable), `--loopback`, `--state-dir`, repo
    paths, `-- <serve flags>`, `--help`; env equivalents `OCTOPUS_DIFF_DEV_*`.
- `scripts/lib/dev-options.mjs`: the pure parts (option parsing, serve argv, Vite env, LAN addresses,
  banner token extraction, daemon output filter). Tested by `scripts/test/dev-options.test.mjs` (26 tests)
  via `scripts/vitest.config.mjs`; root `pnpm test` runs it after the packages (`pnpm test:scripts`).
- `apps/web/vite.config.ts`: `server.host`, `server.port` (strict when set) and `server.allowedHosts` come
  from `OCTOPUS_DIFF_WEB_HOST` / `OCTOPUS_DIFF_WEB_PORT` / `OCTOPUS_DIFF_ALLOWED_HOSTS`. Unset, nothing changes.
- Docs: CONTRIBUTING "Develop with hot reload" (with the firewall note and a `systemd-run` recipe),
  `apps/web/README.md`, the AGENTS.md command table, DECISIONS #135–#142.

## Verification

All of it ran in this worktree. The fixture repo lived in a `mktemp -d` dir with `GIT_CONFIG_GLOBAL` /
`GIT_CONFIG_NOSYSTEM=1`, and the state dir was temporary too. Ports were 7439/5183, so the default ports
stayed free, and 7428 was never bound or signalled.

- `tsx watch` follow-through probe: appending a comment to `packages/git-core/src/index.ts`,
  `apps/daemon/src/security.ts` and `packages/contracts/src/index.ts` (each reverted) restarted the daemon,
  2 restarts per file (edit + revert).
- `pnpm dev --daemon-port 7439 --web-port 5183 --state-dir <tmp> <tmp repo>`: banner printed, `ss` showed `*:5183`
  and `*:7439`.
  - Through the Vite proxy with `Host`/`Origin` set: `/api/health` returned 200 for `odino:5183`, `odino.local:5183`,
    `localhost:5183`, `127.0.0.1:5183` and `10.20.31.2:5183` (a LAN IP). `/api/events` returned the `hello` event
    for the first four. `evil.example` got 403 from Vite, a foreign Origin 403 from the daemon, and no token 401.
    Requests over `[::1]` and to the LAN IP itself both worked.
  - HMR: a raw WebSocket upgrade as `Host: odino:5183` (`vite-hmr` protocol) got `connected`, then
    `js-update /src/styles.css` on a CSS edit and again on its revert.
  - Daemon restart (edit + revert `apps/daemon/src/security.ts`): the old daemon logged `daemon stopped` (clean),
    the proxy answered 502 for about 0.4 s, then 200. An open SSE stream through the proxy ended cleanly.
  - Headless Chromium (Playwright, `--host-resolver-rules=MAP odino 127.0.0.1`, page `http://odino:5183/#token=…`):
    the context bar showed `Live`. A CSS edit hot-applied (`outline` none → dashed) and reverted without a reload.
    Across two daemon restarts the status stayed `Live` in 48 samples at 250 ms, and after each restart the page
    reopened `/api/events` and refetched projects, scan roots, inbox, forges, settings and the diff.
- Teardown, checked each time with `ps` and `ss` (no tsx/vite/serve process left, 7439/5183 free, `*:7428` still
  owned by the unit's PID 3951185):
  - SIGINT to the whole process group (Ctrl+C): the daemon shut down cleanly. A first version signalled the
    groups, the daemon got SIGTERM twice and skipped its clean shutdown; fixed by signalling only the children.
  - SIGTERM to `node scripts/dev.mjs` only: exit 0, clean daemon shutdown.
  - SIGKILL to Vite: `web exited (SIGKILL); stopping the rest`, the daemon stopped cleanly, exit 1.
- Error paths: `--daemon-port 7428`, `--web-port 7428 --loopback` and `OCTOPUS_DIFF_DEV_WEB_PORT=7428` were each
  rejected with the message and exit 1. With 5183 already held: `web port 5183 is already in use …`, exit 1.
  A second instance on the same state dir: `another daemon already uses the state dir …`, exit 1, while the
  first stayed up (later stopped with exit 0).
- `--loopback`: both children on `127.0.0.1` only. `localhost`/`127.0.0.1` returned 200, `odino` 403.
- `pnpm lint`: pass (404 files, credits up to date, 0.4 s). `pnpm typecheck`: pass (1.4 s). `pnpm build`: pass
  (1.8 s).
- `pnpm test`: pass (32 s). contracts 83, forge 94 + 4 skipped, git-core 170, fixtures 48, web 210, daemon 187,
  e2e unit 5, cli 139, scripts 26.
- `pnpm test:e2e`: not run. e2e serves the built UI, not the Vite dev server, so the config change doesn't
  reach it, and the build passed. BLOCKERS #2 (the `@parcel/watcher` shutdown hang) makes a full run unreliable.

## Decisions

DECISIONS #135–#142:

- tsx watch with no `--include` globs, since it follows workspace sources.
- One SIGTERM per child, with process groups only for SIGKILL.
- Ports 7429/5173; 7428 rejected; the web port is strict.
- LAN by default, with Vite on `::` instead of `0.0.0.0`.
- The LAN IPv4 addresses are added as allowed hosts.
- A separate `--state-dir ~/.local/state/octopus-diff-dev`, because `serve` allows one daemon per state dir.
- The token URL is rewritten to the Vite port, and the daemon's repeating banner is hidden.
- Vite config read from env.
- Root `test:scripts`.
- No web change was needed for reconnects.

## Contract changes

None.

## Dependencies

None added or removed. `pnpm credits:check` is up to date.

## Known gaps

- LAN devices need the firewall to admit 5173, as the production server needs 7428. Under WSL with mirrored
  networking and the Hyper-V firewall, the rule for 7428 has to cover 5173 as well. That is the user's step, and
  it was not tested from another device here.
- The dev daemon has its own token and review store, so review marks made in dev don't show up on :7428 and vice
  versa.
- While the daemon restarts (about 0.4 s), Vite logs one `http proxy error … ECONNREFUSED` block per request that
  was in flight.
- A daemon that crashes on startup (a syntax error, say) stays down until the next edit. `pnpm dev` keeps
  running, and the UI shows `Offline` while the client backs off up to 10 s.
- The LAN IPv4 list is read once at startup. If the IP changes, restart `pnpm dev`.
- The LAN unit's PID changed between my first check (3747474) and the start of my runs (3951185, active since
  05:47:08 CST). Something outside this session restarted it, before any `pnpm dev` run here. This session never
  touched it.

## Notes for integration

- Run it with `pnpm dev`, then open the `[dev]` banner's `http://odino:5173/#token=…` URL.
- For a background run, use the `systemd-run --user --unit=octopus-diff-dev …` recipe in CONTRIBUTING.
- Root `package.json` gained `dev` and `test:scripts`, and `test` now chains `test:scripts`.
- The production server (`node apps/cli/dist/index.js serve … --port 7428`) is unchanged. It still needs
  `pnpm build` and a restart to pick up changes.
