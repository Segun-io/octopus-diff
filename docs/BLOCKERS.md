# Blockers

Things that are truly blocked or need the user. Format: date · who · blocker · impact · workaround.
Resolved items move to the bottom with the resolution.

## Open

1. **2026-11-08 · lead · Chromium system libraries need root to install.**
   Playwright's Chromium needs `libnss3`, `libnspr4` and `libasound2t64`; there is no passwordless sudo.
   *Impact:* none right now. *Workaround in place:* the libraries were extracted user-locally to
   `~/.cache/octopus-diff-dev/chromium-libs/` and `e2e/playwright.config.ts` adds them to
   `LD_LIBRARY_PATH` (see DECISIONS #19). *Proper fix (user):*
   `sudo apt install libnss3 libnspr4 libasound2t64` (or `sudo pnpm --filter @octopus-diff/e2e exec
   playwright install-deps chromium`), then delete `~/.cache/octopus-diff-dev/`.

2. **2026-11-09 · lead · The e2e suite can hang forever at a daemon shutdown (`@parcel/watcher` 2.6.0 deadlock).**
   Seen in 3 of 4 full `pnpm test:e2e` runs on `ux/toolbar-hierarchy` (after tests 82, 64 and 50, zero failures each
   time) and in neither of 2 control runs on an untouched `main` checkout the same hour (each of those had one unrelated
   timing failure instead: `11-ui-bulk-review` "stale … skipped", then `16-copy` "select two lines"). The asymmetry
   (1 of 4 branch runs complete, 2 of 2 on `main`) may be chance or the timing of git spawns around shutdown; the
   branch does not touch the daemon or its dependencies. Signature: the log ends with the daemon's
   `watcher error; polling continues … Unable to poll: Interrupted system call` warnings, then nothing; the Playwright
   worker's main thread sits in a futex wait (`/proc/<pid>/task/<pid>/wchan` = `futex_do_wait`; a healthy worker
   reads its pipe), the browser is idle, the runner spins at ~65 % CPU in the read-only proof poller
   (it walks every control repository's whole git dir every 20 ms), and the per-test timeout never fires because it
   lives in the blocked worker. Cause, from the native source in
   `node_modules/.pnpm/@parcel+watcher@2.6.0/node_modules/@parcel/watcher/src`: `InotifyBackend::start()` calls
   `poll()` and throws `"Unable to poll: " + strerror(errno)` on any negative result, `EINTR` included (a signal
   delivered to the watcher thread, e.g. `SIGCHLD` from the many short git processes); the throw skips
   `mEndedSignal.notify()` after the loop; `Backend::run()` catches it, reports it (the daemon's "polling continues"
   path) and the thread ends. When the daemon's `close()` later unsubscribes the last watcher of that backend,
   `~InotifyBackend()` does `mEndedSignal.wait()`, which never returns, and the process's main thread is the one
   observed blocked. 2.6.0 is the newest release (`pnpm view @parcel/watcher version`). *Impact:* a full e2e run is a
   coin flip on this machine; any daemon, the LAN one included, can deadlock on shutdown after one `EINTR` in a
   watcher thread. The web UI is not involved: one hang followed an API-only test, and the page is closed before the
   daemon fixture closes. *Workaround:* rerun, or run spec files alone
   (`pnpm --filter @octopus-diff/e2e exec playwright test tests/<spec>`). *Proper fix (WS2 / lead):* retry `EINTR`
   in `InotifyBackend::start()` (`if (result < 0) { if (errno == EINTR) continue; throw … }`) as a pnpm patch
   (`pnpm patch @parcel/watcher`, which also needs `allowBuilds` for the rebuild) or upstream; or make
   `apps/daemon/src/watcher.ts` skip awaiting `unsubscribe()` for a subscription whose backend already reported an
   error (its thread is gone; there is nothing to wait for). Not changed in this round: the daemon and its
   dependencies are outside its scope.

### WS1 — git-core

1. **2026-11-08 · WS1 · `pnpm install` exits non-zero on a fresh worktree** with
   `ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: esbuild@0.28.2` (pnpm 12 denies dependency
   build scripts by default; only `@parcel/watcher` is listed in `allowBuilds`). *Impact:* none
   for WS1 (all packages install; esbuild works through its prebuilt `@esbuild/linux-x64`
   binary), but CI's `pnpm install` step would fail. *Fix (lead/WS5, root config):* add
   `esbuild: false` (or `true`) under `allowBuilds` in `pnpm-workspace.yaml`. Not changed by WS1
   (root config is out of scope).

### WS2 — daemon

(none)

### WS3 — web

(none)

### WS4 — fixtures, e2e, perf

1. **2026-11-08 · WS4 · e2e, bench and screenshots can't run end to end on the WS4 branch.**
   `@octopus-diff/daemon`, `@octopus-diff/git-core` and the web UI are Phase 0 placeholders here.
   *Impact:* `pnpm test:e2e` fails fast in global setup with one message naming the placeholder daemon
   and UI (by design); the bench and screenshot scripts fail the same way. *Workaround:* none needed;
   they are written against the contracts and run once the lead merges WS1–WS3 and runs `pnpm build`.
2. **2026-11-08 · WS4 · `pnpm install` exits 1 on this checkout** with `ERR_PNPM_IGNORED_BUILDS`
   (`esbuild@0.28.2`, pulled in by tsx/vite). Everything still installs and links, and `pnpm run`
   continues after a warning, but CI and scripts that check the exit code will fail. *Needs the lead*
   (root config is not WS4's): add `esbuild: false` to `allowBuilds` in `pnpm-workspace.yaml` (its
   postinstall only verifies the platform binary that the optional dependency already provides).

### WS5 — CLI, packaging, docs, CI

1. **2026-11-08 · WS5 · `pnpm install` exits 1: "Ignored build scripts: esbuild@0.28.2".**
   pnpm 12 fails the install when a dependency's build script is neither allowed nor denied.
   esbuild (via tsx / vite) is not listed in `allowBuilds`. Already the case on the base commit
   `db5274c`. *Impact:* the install itself completes and everything works, but the exit code breaks
   scripted installs and CI. *Workaround in place:* CI runs
   `pnpm install --frozen-lockfile --config.strict-dep-builds=false`; CONTRIBUTING documents it.
   *Proper fix (lead, root file):* add `esbuild: false` under `allowBuilds` in `pnpm-workspace.yaml`
   (its platform binary comes from `@esbuild/<platform>` optional dependencies; the postinstall only
   validates it). Then the CI flag can be dropped.

### Phase 2 — integration (lead)

(none)

## Resolved

(none yet)
