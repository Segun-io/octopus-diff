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

1. **2026-11-09 · lead · The e2e suite can hang forever at a daemon shutdown (`@parcel/watcher` 2.6.0 deadlock).**
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
   path) and the thread ends without notifying. `~InotifyBackend()` does `mEndedSignal.wait()`, which then never returns,
   and it runs on whichever thread drops the last reference to the backend. Usually that is the dying watcher thread
   itself, which blocks forever. But a subscribe or unsubscribe in flight holds a reference in its N-API runner, and
   the runner is destroyed on the JavaScript thread; if that runner releases the last reference (an unsubscribe of
   the last watcher, at `close()` for instance), the process's main thread is the one blocked, as observed. Reproduced
   with `tgkill` (an `EINTR` while a subscribe is crawling): main thread in `futex_do_wait`. 2.6.0 is the newest release
   (`pnpm view @parcel/watcher version`). *Impact:* a full e2e run is a coin flip on this machine; any daemon, the LAN
   one included, can deadlock after one `EINTR` in a watcher thread, and until then every subscription is dead (live
   updates fall back to polling). The web UI is not involved: one hang followed an API-only test, and the page is
   closed before the daemon fixture closes. *Workaround:* rerun, or run spec files alone
   (`pnpm --filter @octopus-diff/e2e exec playwright test tests/<spec>`). *What a fix must do:* not awaiting
   `unsubscribe()` is **not** a fix: the call itself can release the last reference, and its native completion can
   still block the JavaScript thread in the destructor, awaited or not. A failed subscription must never be
   unsubscribed (drop the reference), and since runners in flight can still end up running the destructor, the
   native code must not run on the daemon's thread at all. A native patch (retry `EINTR` in `InotifyBackend::start()`)
   is not enough on its own either: the install script builds only with `npm_config_build_from_source=true` (plus
   `allowBuilds` and a C++ toolchain), `index.js` loads the prebuilt `@parcel/watcher-<platform>` package before
   `build/Release/watcher.node`, so the runtime must also be made to load the local build, and users installing the
   published package would still get the unpatched prebuild. *Fix in progress:*
   https://github.com/Segun-io/octopus-diff/pull/3 runs `@parcel/watcher` in a child process (no `SIGCHLD` reaches
   it; a stuck one is killed, never waited for), never unsubscribes a failed subscription, and re-subscribes with a
   backoff (its DECISIONS #130–#132).
   *Resolved 2026-11-09:* PR #3 merged into `main` (`a546364`); `ux/toolbar-hierarchy` merged `main` the same day.
