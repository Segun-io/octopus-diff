# @octopus-diff/web

The octopus-diff browser UI: Vite + React 19 + TanStack Query + Tailwind v4, `@pierre/diffs` for
diffs (highlighting in a worker pool) and `@pierre/trees` for the optional tree view. The daemon
serves `dist/` at `/` with the API on the same origin; the UI only talks to it through the contract
client (`createApiClient` from `@octopus-diff/contracts`).

## Run against the mock API (no daemon needed)

```sh
pnpm --filter @octopus-diff/web dev:mock          # demo dataset, Vite on http://127.0.0.1:5173
MOCK_DATASET=large pnpm --filter @octopus-diff/web dev:mock   # 30 worktrees × 200 files
pnpm --filter @octopus-diff/web build && pnpm --filter @octopus-diff/web preview:mock   # production build on :4173
```

Env vars: `MOCK_DATASET` (`demo` | `large` | `empty`), `MOCK_INTERVAL_MS` (simulated agent edits,
default 5000, `0` = off), `MOCK_TOKEN` (require auth, to see the 401 screen), `MOCK_LATENCY_MS`,
`MOCK_PORT`, `WEB_PORT`. Trigger an edit by hand:
`curl -XPOST 'http://127.0.0.1:5173/api/__mock/mutate?action=edit'` (optional `worktreeId`, `path`).

The demo dataset covers every file status and the special cases: renames (pure and with edits),
copies, deletions, binary, submodule, symlink, typechange, mode-only, whitespace-only, CRLF, a
non-UTF-8 path, a conflict, a 4000-line file and a too-large/truncated one; plus a detached HEAD, an
in-progress rebase, a worktree whose summary failed and a missing worktree.

## Run against a real daemon with hot reload

From the repository root, `pnpm dev` starts Vite (HMR, port 5173) and a daemon from sources under
`tsx watch` (port 7429, restarts on daemon/package edits), and prints the URLs with the token for the
Vite port: `http://localhost:5173/#token=…` and, on the LAN, `http://odino:5173/#token=…`.
`--loopback` keeps both on 127.0.0.1; `pnpm dev --help` lists the options. Details, the firewall
note for LAN devices and a systemd recipe: CONTRIBUTING.md, "Develop with hot reload". The
production server on :7428 serves the built UI and still needs `pnpm build` and a restart.

`vite.config.ts` reads `OCTOPUS_DIFF_API` (proxy target, default `http://127.0.0.1:7428`),
`OCTOPUS_DIFF_WEB_HOST`, `OCTOPUS_DIFF_WEB_PORT` (strict when set) and `OCTOPUS_DIFF_ALLOWED_HOSTS`
(comma-separated). Pointing plain `pnpm --filter @octopus-diff/web dev` at another daemon only works
if that daemon allows the browser's Host on any port (`--allowed-host localhost`).

## Layout

```
src/api/         contract client context, query keys/hooks, SSE + review + focus hooks, cache patching
src/state/       UI store (useSyncExternalStore), derived app model, commands + keyboard shortcuts
src/lib/         pure logic: sidebar/inbox model, navigation (j/k/J/K/n), diff classification
src/components/  Sidebar, FileList (virtualized), FileTreeView (@pierre/trees), Toolbar, diff/*
mock/            mock daemon: data generator, router, Node server with SSE, dev/preview launchers
scripts/         headless-Chromium checks: browser-check.ts, perf.ts, csp-check.ts
test/            vitest (node + jsdom) tests
```

## Scripts

`pnpm test` (vitest), `pnpm typecheck`, `pnpm build`, `pnpm check:browser` (needs a running `dev:mock` /
`preview:mock`; set `BASE_URL`), `pnpm perf` / `pnpm perf:smoke` (render benchmark: build first; it starts its own mock
with the large dataset, see `docs/bench/README.md`).
