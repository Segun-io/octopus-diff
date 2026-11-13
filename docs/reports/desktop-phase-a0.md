# desktop-phase-a0 report

Issue #17 (part of #15): the CLI hooks the desktop shell needs. Branch `t3/a0012dc0`, DECISIONS #476-#482.

## Shipped
- `octopus-diff serve --ready-fd <n>` (`apps/cli/src/commands/serve.ts`, `args.ts`, `deps.ts`): one JSON line
  `{ mode: 'started' | 'attached', url, authUrl, pid, version }` on fd `n` (integer >= 3), then the fd is closed.
  `started` after the daemon listens and `daemon.json` is written; `attached` right away when a verified daemon
  already runs for the state dir (pid/version are the running daemon's), then exit 0. The token is only in `authUrl`
  on that fd: with the flag the stdout banner has no token URL; argv, stdout and stderr are checked in tests.
- `serve --exit-with-stdin`: EOF/close/error on stdin runs the same graceful shutdown as SIGINT/SIGTERM (raced with the
  signal promise; listening starts before the daemon does; stdin is unref'd and paused afterwards; not read without the
  flag; not watched when attaching).
- `ServeReadySchema` + `ServeReady` in `packages/contracts/src/daemon.ts` (exported via the package index).
- `apps/cli/scripts/bundle.mjs`: reusable bundle step (`bundleCli({ outDir })`, `node bundle.mjs --out <dir>`,
  `externalDependencies()`) producing `index.js`, `git-helper.js`, `web/`, `@parcel/watcher` external; `pack.mjs` uses it.
  Documented in CONTRIBUTING.md; `--ready-fd` / `--exit-with-stdin` in `help serve` and the README options table.

## Verification
Run in this worktree (Linux/WSL2, Node 26), after `pnpm install` + `pnpm build`:
- `pnpm lint`: pass (4 warnings and 1 info, all pre-existing in `apps/web`; `credits:check` up to date).
- `pnpm typecheck`: pass, every package.
- `pnpm build`: pass.
- `pnpm test`: pass. contracts 138, forge 101 (+5 skipped), fixtures 58, web 512, git-core 556 (+1 skipped),
  daemon 610 (+4 skipped), e2e package 8, **cli 172** (12 of them the new process tests), scripts 34.
  The CLI suite was run four times in a row after the last test fix: green each time.
- `pnpm test:e2e --workers=1`: 110 passed (3.1 min), read-only proof 0 violations.
- Tarball: built with the old `pack.mjs` (from `HEAD` before the split) and the new one; same 1070-file listing and
  `diff -r` of the extracted trees is empty (byte-identical). The CI `package` job's steps pass on it: `npm install` of
  the tarball, `--version`, `doctor --json` git-helper check `ok`, `smoke-tarball.mjs` (diff through the helper, no
  orphans after SIGKILL). Also ran the installed tarball's `serve --ready-fd 3 --exit-with-stdin` by hand: started line
  with the right pid, `daemon.json` gone and exit 0 after `stdin.end()`.

## Decisions
#476 `ServeReadySchema`; #477 validation and the "not open" error; #478 line contents, timing, attached semantics,
write failure; #479 token only on the fd; #480 `--exit-with-stdin`; #481 `bundle.mjs`; #482 tests and platforms.

## Contract changes
`ServeReadySchema` and `ServeReady` added to `packages/contracts/src/daemon.ts` (additive, commit `contracts: ServeReadySchema`,
tests in `packages/contracts/test/serve-ready.test.ts`). `daemon.ts` now imports zod.

## Dependencies
None added or removed; `pnpm credits:check` is up to date (no `pnpm credits` run needed).

## Known gaps
- **Windows and macOS were not run** (no such machine here). The process tests avoid signals and POSIX-only calls
  (the one SIGINT use is guarded by `process.platform !== 'win32'`); the code relies on `fs.writeSync` on an inherited
  fd >= 3 and stdin events. First CI run on those OSes is the real check (issue "Done when").
- `--ready-fd` cannot tell a pipe from the parent from some other open descriptor: low numbers are Node's internal
  fds (fd 9 is open in a bare `node`), so a wrong number can pass the open check. The parent is expected to pass
  the pipe at the index it names (#477).
- Process tests skip when `apps/cli/dist/index.js` is not built (like the existing binary test); CI builds first.
- `--exit-with-stdin` with a child stdin of `ignore` (reads `/dev/null`) shuts down immediately by design (#480).
- A fresh worktree needs a root `pnpm install` before `pnpm build` (the first `pnpm --filter` install left
  `tools/fixtures` unlinked); not specific to this change.

## Notes for integration
- Desktop phase A: spawn `process.execPath <bundle>/index.js serve --ready-fd 3 --exit-with-stdin` with
  `stdio: ['pipe','pipe','pipe','pipe']`, read fd 3 to EOF, validate with `ServeReadySchema`, never log `authUrl`.
  Quit = `child.stdin.end()`, then kill after a grace period. `attached` means do not own the daemon.
- Reuse the bundle with `node apps/cli/scripts/bundle.mjs --out <dir>`; ship `@parcel/watcher` beside it
  (`externalDependencies()` has the range).
- DECISIONS numbers #483-#485 of the allotted block are unused.
