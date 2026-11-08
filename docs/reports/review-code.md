# review-code report (adversarial code review of the MVP at `f777775`)

## Summary

Scope: the whole MVP. The work went deepest on the review-mark loop (`patchHash` keying and
invalidation across git-core, daemon caches and the web UI), the watcher, refresh and cache path,
and git-core edge cases. Every finding below was **confirmed by experiment** (throwaway vitest
probes against real temp repos, the real daemon over HTTP and SSE, or the web app under jsdom),
except F10, which was confirmed by reading code in this repo and in `@pierre/trees`. No product
code was changed. The probes were deleted after use; a minimal repro is inlined for each finding.

Baseline at `f777775`:

| Check | Result |
|---|---|
| `pnpm install && pnpm check` | **FAILS** at `pnpm lint`: Biome rejects the formatting of `docs/bench/results.json` (F11) |
| `pnpm typecheck && pnpm build && pnpm test` | pass: contracts 57, git-core 98, web 37, daemon 84, cli 108, fixtures 48, e2e-unit 5 |
| `pnpm test:e2e` | pass: 36/36 in 1.2 min; read-only proof: 12 control repos, 1681 lock polls, 0 violations |

The worst problems are not in git plumbing, which held up well under a broad consistency sweep.
They sit where live state meets cached state:

- **F1:** a worktree recycled at the same path silently loses native watching. Health still
  reports `native`.
- **F2:** the review toggle marks the file list's `patchHash`, not the diff on screen.
- **F3, F4:** submodule commits and `git add` break the review-mark invariant in opposite
  directions.

| id | severity | status | summary |
|---|---|---|---|
| F1 | high | confirmed | Worktree removed and re-added at the same path keeps a dead watcher subscription and stale watch targets; no live updates (5 min poll), health still says `native` |
| F2 | high | confirmed | `r` / "Mark reviewed" sends the file list's `patchHash`, not the `patchHash` of the diff on screen: it can mark unseen content reviewed, or silently do nothing / un-mark |
| F3 | medium | confirmed | A commit inside a submodule changes the superproject's patch for the submodule but not `stateHash`: no event, files cache serves the old `patchHash`, the stale review mark stays "reviewed" |
| F4 | medium | confirmed | Untracked files use a different `patchHash` scheme than tracked ones: `git add` / `git add -N` of a reviewed file drops its mark although the patch text is byte-identical |
| F5 | medium | confirmed | Default watcher ignores (`dist`, `build`, `out`, `target`, …, at any depth) also hide **tracked** files: edits there are not live (5 min poll) |
| F6 | low | confirmed | `.git/info/exclude` is a git-core watch target, but the daemon's git-dir subscription ignores `info/`: exclude changes are not live |
| F7 | low | confirmed | One unreadable tracked file (`git diff` exit 128) fails the summary **and** file list of the whole worktree |
| F8 | low | confirmed | Untracked file covered by a `binary` / `-diff` attribute is listed as text with line counts, but its diff is an empty patch; after `git add` it flips to binary |
| F9 | low | confirmed | Switching scope with the same file open shows a false "This file changed on disk" banner |
| F10 | low | confirmed (code) | In the tree layout, `j`/`k`/`n` follow flat byte order, not the tree's folders-first, case-insensitive display order |
| F11 | low | confirmed | `pnpm check` / `pnpm lint` is red on `main` (`docs/bench/results.json` formatting), so acceptance item §8.11 is not met |

---

## Findings

### F1 — Recycled worktree path: dead native watch, stale targets, misreported health (high, confirmed)

**Location:** `apps/daemon/src/watcher.ts:262` (`setProject`: `existing.info = info; continue;`),
`apps/daemon/src/core.ts:643-645` (`e.targets` cached for the entry's lifetime),
`apps/daemon/src/watcher.ts:375` (`#isNative`), `apps/daemon/src/watcher.ts:616`
(`pollIntervalFor`).

**What is wrong:** worktree ids are hashes of the path, so a worktree removed and re-added at the
same path keeps its id. If the relist never sees it in the `missing` state, it stays in the set.
That happens whenever the remove and the re-add both land inside the 150 ms list debounce or
between parcel batches. `WatcherService.setProject` then keeps the old `WorktreeState`, so the
inotify subscription stays bound to the deleted directory inode and is never recreated. No
watcher error is raised:
- `st.native` stays `true`, so the worktree is polled at the **idle** interval (5 min; 30 s only
  while focused).
- `/api/health` keeps reporting `mode: "native"` with no warnings.

`DaemonCore` also keeps the worktree's cached `WatchTargets`. If git chose a different admin dir
(`worktrees/<name>1`), index and HEAD events of the new worktree no longer match it.

A main repository deleted and quickly re-cloned at the same path follows the same code path
(plausible, not separately tested).

**Failure scenario:** an agent tool, script or user runs
`git worktree remove --force wt && git worktree add -b b2 wt`, then the agent edits files in
`wt`. Results:
- No `worktree.changed` event.
- The summary stays "clean", so the worktree is missing from the Inbox and the sidebar.
- Nothing tells the user that watching is broken.

**Repro** (daemon vitest, real git-core; output was `0` events within 3 s, health
`{"mode":"native","warnings":[]}`):

```ts
fx.git(repo, 'worktree', 'add', '-q', '-b', 'b1', wt);
const daemon = await startDaemon({ host: '127.0.0.1', port: 0, token: TEST_TOKEN, stateDir,
  logLevel: 'silent', git: { env: fx.env }, watch: { debounceMs: 150 } });
const api = client(daemon); await api.addProject({ path: repo });
const events = recordEvents(daemon); await events.opened;
execFileSync('sh', ['-c', `git worktree remove --force "${wt}" && git worktree add -q -b b2 "${wt}"`], { cwd: repo, env });
await sleep(1500);                    // events: project.updated, worktree.changed (relist saw b1 -> b2)
const n = events.events.length;
await writeFile(path.join(wt, 'a.txt'), 'edited by agent\n');
await sleep(3000);
events.events.slice(n).filter((e) => e.type === 'worktree.changed' && e.worktreeId === hashId(wt)).length; // 0
(await api.health()).watcher;         // { mode: 'native', warnings: [] }
```

**Suggested fix:**
- On a root `delete` event for a worktree subscription, tear the subscription down and mark the
  state non-native, so the next `setProject` re-subscribes and polling uses the degraded
  interval meanwhile.
- In `setProject`, re-subscribe when the root's inode (`stat(root).ino`) or `targets.gitDir`
  differs from the subscribed one.
- In `DaemonCore`, drop `e.targets` when the relist reports a changed worktree (or re-fetch
  targets on every `#syncWatcher`).

### F2 — The review toggle uses the list's `patchHash`, not the displayed diff's (high, confirmed)

**Location:** `apps/web/src/state/commands.ts:110` (`patchHash: entry.file.patchHash`,
`reviewed: !entry.file.reviewed`), `apps/web/src/components/diff/DiffPane.tsx:82` (the button
shows `diff?.reviewed`).

**What is wrong:** the button state comes from the diff response, but the mutation is keyed by
the file-list (or inbox) entry. The two are separate queries, refetched independently after a
`worktree.changed`, so they can disagree:
- **List newer than diff.** During the refetch window after an agent edit, the list already has
  the new hash H2 while the diff pane still shows the old patch P1. Pressing `r` records H2 as
  reviewed, a patch the user has not seen; this defeats PLAN §4.3.2. The new diff then arrives
  pre-marked "Reviewed".
- **Diff newer than list.** This happens transiently, and permanently under F3. `r` marks the
  stale hash. The optimistic update does not touch the diff (its hash differs), so the button
  does not flip. A second `r` sends `reviewed: false` for the list hash. The patch on screen can
  never be marked from the UI.

**Repro** (web vitest under jsdom, demo mock backend; the fetch wrapper rewrites the `/diff`
response's `patchHash` to simulate a list/diff disagreement). Observed: PUT #1
`{"patchHash":"eb94f6…","reviewed":true}`, then PUT #2 `{"patchHash":"eb94f6…","reviewed":false}`.
`aria-pressed` stayed `false` throughout.

```tsx
const api = createApiClient({ baseUrl: 'http://mock.local', fetch: async (input, init) => {
  if ((init?.method ?? 'GET') === 'PUT') puts.push(JSON.parse(String(init?.body)));
  const res = await mockFetch(input, init);
  if (String(input).includes('/diff')) {
    const body = await res.json(); body.diff.patchHash = 'f'.repeat(40); body.diff.reviewed = false;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return res;
} });
render(<App api={api} queryClient={createQueryClient()} uiStore={createUiStore({}, false)} eventSourceFactory={() => new FakeEventSource()} />);
// wait for diff-viewer data-state=ready, then press `r` twice
expect(puts.map((p) => p.patchHash)).not.toContain('f'.repeat(40)); // passes: the shown patch is never marked
```

**Suggested fix:** when the diff query holds non-placeholder data for the selected file and the
current scope, key the mutation on `diff.patchHash` and `!diff.reviewed`: review exactly what
is displayed. Fall back to the list entry only while the diff is loading. Optionally refuse the
toggle and show a "changed, reload" hint when the list and diff hashes differ.

### F3 — Submodule pointer changes do not change `stateHash` (medium, confirmed)

**Location:** `packages/git-core/src/summary.ts:223-236` (stateHash inputs),
`packages/git-core/src/summary.ts:147` (numstat only),
`apps/daemon/src/watcher.ts:50` (`'modules'` ignored in the git-dir subscription),
`apps/daemon/src/core.ts` `#gitFiles` (files cached by `(worktree, scope, stateHash)`).

**What is wrong:** for a gitlink, `git status --porcelain=v2` reports only the HEAD and index
commit ids, not the submodule's checked-out commit, and numstat is always `1 1`. The only other
input is the `lstat` signature of the submodule directory, which does not change when the
submodule's HEAD moves without adding or removing directory entries: a commit inside the
submodule, `reset --soft`, or an in-place edit plus commit. The watcher ignores
`<common>/modules`, and when the submodule is also registered as a project (likely with a scan
root), `#ownerOf` routes its file events to the submodule, not the superproject.

This violates the contract's promise that `stateHash` "changes whenever … any file's patch
changes" (`packages/contracts/src/domain.ts`).

**Failure scenario:** the user reviews `sub` (pointer `c1 → c2`), then an agent commits inside
the submodule:
- No `worktree.changed` event.
- `GET /files` keeps returning the old `patchHash` with `reviewed: true`.
- `GET /diff` returns the new patch with `reviewed: false`. Combined with F2, the user cannot
  mark it from the UI.

This persists until something else changes the worktree; a manual refresh fixes it.

**Repro.** git-core probe (P2b): `stateHash` equal before and after, `patchHash` of `sub`
different. Daemon probe (D1), observed:

```
D1 events after submodule commit: 0
D1 list after:  reviewed=true  hash=bc24c2… (same as before: true)
D1 diff after:  reviewed=false hash=a675fc…
D1 list after manual refresh: reviewed=false hash=a675fc…
```

```ts
fx.git(repo, 'submodule', 'add', '-q', lib, 'sub');          // protocol.file.allow=always in the temp config
fx.git(sub, 'checkout', '-q', c1); fx.git(repo, 'add', '-A'); fx.git(repo, 'commit', '-qm', 'sub at c1');
fx.git(sub, 'checkout', '-q', c2);                          // superproject: M sub
const s1 = await core.getSummary(wt);
writeFileSync(path.join(sub, 'a.txt'), 'v3\n');             // in place: sub/ entries unchanged
fx.git(sub, 'commit', '-qam', 'v3');
const s2 = await core.getSummary(wt);
s1.stateHash === s2.stateHash;                               // true  (bug)
// listChangedFiles(...)[0].patchHash differs before/after   // true
```

**Suggested fix:** hash `--raw` output too. Running the summary's numstat as
`--raw --numstat -z` makes the raw line for a gitlink carry the submodule's current commit
(`:160000 160000 <old> <new> M sub`), which covers this case cheaply. Also watch
`<common>/modules/*/HEAD` and refs (or add the submodule git dirs to `WatchTargets`). Don't let
a nested registered project steal events from its superproject when the path is a gitlink of
the superproject.

### F4 — Untracked → `git add` drops review marks although the patch is identical (medium, confirmed)

**Location:** `packages/git-core/src/untracked.ts:240`: an untracked file's `patchHash` is
`hashParts(['untracked', mode, key, sha256(content)])`. After `git add` (or `git add -N`) the
same file's hash is the `PatchHasher('patch')` digest of the canonical patch text.

**What is wrong:** the two hash schemes never agree, even though `git diff --no-index /dev/null f`
and `git diff HEAD -- f` after `git add` produce byte-identical patches. That was verified:
`patch text identical=true`. Agents often stage everything (`git add -A`) before asking for
review or committing, so every file reviewed while untracked comes back unreviewed. Related
weaker instances of the same issue:
- `untracked.ts:173`: an untracked nested repository's hash is constant, so a reviewed nested
  repo never invalidates.
- `untracked.ts:204`: beyond `maxUntrackedFiles` (2000) the hash is stat-based and depends on
  the file's position in the sorted list. A new file that sorts earlier pushes others across the
  boundary and changes their hashes.

**Repro** (daemon probe D3, observed `before add: status=untracked reviewed=true` →
`after add: status=added reviewed=false; patch text identical=true`):

```ts
await writeFile(path.join(repo, 'new.ts'), 'export const x = 1;\n');
// wait for worktree.changed; f = (await api.listFiles(wtId)).files[0]
await api.setReview({ projectId, scopeKind: 'working', path: 'new.ts', patchHash: f.patchHash, reviewed: true });
fx.git(repo, 'add', 'new.ts');                 // or: git add -N new.ts (same result)
// wait for worktree.changed
(await api.listFiles(wtId)).files[0].reviewed; // false
```

**Suggested fix:** compute the untracked `patchHash` with the same `PatchHasher('patch')` over
the canonical new-file patch. `synthesizeNewFilePatch` already produces git's exact text for
UTF-8 files; for files under attributes, hash the `--no-index` output. Add a test asserting
`hash(untracked) == hash(after git add -N) == hash(after git add)` in the working scope.

### F5 — Default ignores hide tracked files (medium, confirmed)

**Location:** `apps/daemon/src/watcher.ts:17-42` (`DEFAULT_WORKTREE_IGNORES`) and
`buildWorktreeIgnores`, which adds `**/<name>`.

**What is wrong:** `dist`, `build`, `out`, `target`, `coverage`, `.cache` and the other default
names are ignored at **any depth**, whether or not git ignores them. Tracked content in such
directories is common:
- JS GitHub Actions and libraries commit `dist/`.
- Kubernetes and many Go repos have a tracked top-level `build/`.
- Directories such as `tools/build/` hold scripts.

Edits there never produce file events. Only the 5-minute idle poll picks them up, which breaks
the ~1.5 s live-update promise (§8.5) for those files. The worktree also stays out of the Inbox
in the meantime, because the summary reports it clean.

**Repro** (daemon probe D8). Observed: `0` events for edits to tracked `dist/index.js` and
`tools/build/run.sh`, `summary.changedFiles = 0`, versus 1 event for a control edit under `src/`.

```ts
// repo committed with src/a.ts, dist/index.js, tools/build/run.sh
await writeFile(path.join(repo, 'dist', 'index.js'), 'rebuilt by agent\n');
await writeFile(path.join(repo, 'tools', 'build', 'run.sh'), 'echo changed\n');
await sleep(3000); // no worktree.changed; listProjects() summary.changedFiles === 0
```

**Suggested fix:** apply the build-dir defaults only to paths git ignores. For example, compute
the ignored top-level directories once with an allowlisted read
(`ls-files --others --ignored --exclude-standard --directory`), or skip a default name when
`ls-files -- <dir>` reports tracked files. Alternatively, keep watching those directories and
drop events for ignored paths.

### F6 — `.git/info/exclude` is not watched (low, confirmed)

**Location:** `apps/daemon/src/watcher.ts:52` (`'info'` in `GIT_DIR_IGNORES`) versus
`packages/git-core/src/core.ts:92` (`info/exclude` in `WatchTargets.gitPaths`).

**What is wrong:** git-core asks the daemon to watch `info/exclude`, but the parcel subscription
on the common dir ignores `info/`, so the event never reaches `#gitEventMatches`.

**Repro** (daemon probe D2): untracked `junk.log`, then
`writeFile('.git/info/exclude', 'junk.log\n')`. Observed `0` events within 3 s, and `/files`
still lists `junk.log` while `git status` is clean.

**Suggested fix:** don't ignore `info` wholesale. Ignore `info/*` except `exclude`, or subscribe
to that file through the targets.

### F7 — One unreadable tracked file fails the whole worktree (low, confirmed)

**Location:** `packages/git-core/src/summary.ts:147` (numstat `git diff` must succeed),
`packages/git-core/src/diff.ts:488` (whole-scope `git diff`).

**What is wrong:** `git status` tolerates an unreadable modified file, but `git diff HEAD` exits
128 (`error: open("secret.txt"): Permission denied` / `fatal: cannot hash`). The summary and the
file list both fail, so the worktree shows an error and none of its other changed files can be
reviewed. This is a partial failure turned into a total one.

**Repro.** Plain git: `chmod 000 b.txt` on a modified tracked file. `git status --porcelain=v2`
exits 0, `git diff --raw --numstat -p HEAD` exits 128. Daemon probe D9 observed
`refreshWorktree` and `listFiles` both failing with
`git diff failed (exit 128): error: open("secret.txt"): Permission denied`, and the worktree item
carrying the `git_error` code.

**Suggested fix:**
- The summary can fall back to status-only counts (additions and deletions unknown) instead of
  failing.
- The file list can retry with the unreadable path excluded (`:(exclude)` is unavailable with
  literal pathspecs; instead diff the other status paths explicitly) and list that path with a
  per-file error or placeholder.

### F8 — Untracked files under `binary` / `-diff` attributes are misreported (low, confirmed)

**Location:** `packages/git-core/src/untracked.ts:90-98` (binary = NUL sniff or size only),
`packages/git-core/src/diff.ts` `untrackedPatch` (`/^Binary files /` → empty patch).

**What is wrong:** `inspectUntracked` ignores `.gitattributes`. A text file matching `*.dat binary`
is listed with `binary: false, additions: 2`. Its diff has `patch: ''` (git's `--no-index` honors
the attribute), still with `binary: false`, so the UI shows an empty diff, not the binary
placeholder. After `git add`, the same file reports `binary: true, additions: null`. The summary
also adds its lines to `additions`.

**Repro** (git-core probe). Observed list `{"binary":false,"additions":2}`, diff
`{"binary":false,"additions":2,"patch":"","tooLarge":false}`, after `git add`
`{"status":"added","binary":true,"additions":null}`:

```ts
const r = fx.repo('a', { files: { '.gitattributes': '*.dat binary\n' } });
writeFileSync(path.join(r, 'x.dat'), 'plain text\nline2\n');
// listFiles(working) / fileDiff(working, x.dat), then git add x.dat and list again
```

**Suggested fix:** resolve attributes for untracked paths in one batch with
`git check-attr -z --stdin binary diff`, adding `check-attr` (read-only) to the allowlist. Treat
`binary` / `-diff` as binary in both listing and diff.

### F9 — False "changed on disk" banner when switching scope (low, confirmed)

**Location:** `apps/web/src/components/diff/DiffPane.tsx:91-93`: the `seen` ref is keyed by the
file only (`fileRefKey`), not by scope or view options.

**What is wrong:** the same file has a different canonical patch, and so a different `patchHash`,
in each scope. Switching scope with the file still selected therefore triggers the "updated"
banner: "This file changed on disk; the diff below is up to date." Nothing changed.

**Repro** (web vitest under jsdom; the fetch wrapper gives each scope's diff a different
`patchHash`, as real git-core does). Observed on switching staged → unstaged with
`src/server/router.ts` still selected:
`banner="This file changed on disk; the diff below is up to date.Dismiss"`.

**Suggested fix:** key `seen` by `${fileRefKey}|${scopeKey(scope)}`.

### F10 — Tree layout navigation order differs from the displayed order (low, confirmed by code)

**Location:** `apps/web/src/lib/model.ts:31` (`compareFiles`: code-unit order, case-sensitive)
versus `@pierre/trees` `defaultChildrenComparator` (folders first, dot-items first,
case-insensitive), used by `apps/web/src/components/FileTreeView.tsx:38`.

**Failure scenario:** with files `.github/x.yml`, `README.md`, `b.txt` and `src/a.ts`:
- The tree shows `.github/x.yml`, `src/a.ts`, `b.txt`, `README.md`.
- `j` visits `.github/x.yml` → `README.md` → `b.txt` → `src/a.ts`, jumping around the visible
  tree.

**Suggested fix:** when `fileListLayout === 'tree'`, order `entries` with the tree's comparator,
or pass a `compareFiles`-compatible comparator to `useFileTree`.

### F11 — `pnpm check` is red on `main` (low, confirmed)

**Location:** `docs/bench/results.json` (committed in `f777775`).

**What is wrong:** `pnpm lint` (Biome) fails: "Formatter would have printed the following
content" (the arrays should be packed). `pnpm check` stops at lint, CI would fail, and §8.11
("lint … green") is not met.

**Repro:** `pnpm install && pnpm check` → `Found 1 error. … docs/bench/results.json format`.

**Suggested fix:** run `pnpm lint:fix`. Better, have the bench write Biome-formatted JSON, or
add `docs/bench/*.json` to the Biome ignore list.

---

## Areas reviewed and found sound

- **Read-only runner** (`packages/git-core/src/runner/*`): argv-only spawn, absolute-binary
  resolution, subcommand and option allowlist, `--no-optional-locks` plus `GIT_OPTIONAL_LOCKS=0`,
  config pins (`diff.autoRefreshIndex=false`, `core.fsmonitor=false`, …), repo-local filter
  neutralization, process-group kill on timeout, stderr cap. The e2e read-only proof and the
  hostile-config tests pass. The security reviewer covers the deeper attack surface.
- **list ↔ diff consistency**, swept in all status scopes plus staged/commit copies. Identity
  fields and `patchHash` matched, including with `-w`, for:
  - attribute-binary and `-diff` tracked files;
  - a staged rename plus a worktree edit;
  - a staged delete with the same path untracked;
  - intent-to-add plus an edit;
  - typechanges (file → symlink, file → directory);
  - paths with spaces, quotes and non-ASCII characters;
  - CRLF with `text=auto`, mode-only changes and empty files;
  - copies with pathspec narrowing.

  The existing suites already cover conflicts, unborn and detached HEAD, non-UTF-8 paths, root
  commits and large files.
- **Status porcelain v2 parser**, unborn and detached handling, the unborn-HEAD empty-tree
  retry, and `rev-list --parents` for root and merge commits in the commit scope.
- **Daemon single-flight and coalescing**: `Coalescer` queued re-runs, the files cache keyed by
  `stateHash` with an in-flight map, and the bounded LRU. Apart from F3 no stale-hash path was
  found: stat signatures cover rewrites of already-dirty and untracked files.
- **Registry lifecycle**: missing-project detection and recovery (watcher removed, then
  re-registered and re-subscribed), scan exclusions, scan-root removal, startup
  reconciliation, and a bare repository with linked worktrees (D6: inbox and branch scope
  correct).
- **Resources**: timers are `unref`ed and cleared on close; watcher subscriptions are released
  on project removal; EventHub heartbeat stops with no clients; replay buffer and slow-consumer
  disconnect are bounded; the SQLite store is closed; git children are killed on timeout or
  dispose. No leak found.
- **SSE**: `bootId.seq` ids, `Last-Event-ID` replay, and full invalidation in the web on
  reconnect `hello`. One gap looked plausible but was **not** confirmed and is not reported as a
  defect: dropping `worktree.changed` when the cached projects list already carries the new
  `stateHash` could skip a files and diff refetch if a projects refetch outruns the SSE frame.
- **Web UI**:
  - `n` ordering across projects matches the sidebar order (project name, then main-first
    worktrees, then path).
  - Selection repair keeps or hands over the selection correctly.
  - Commit scope is reset when entering the Inbox.
  - Optimistic review updates roll back on error.
  - The worker pool is shared, with an idle TTL.
- **CLI**: `add` and `status` talk to the running daemon over the API (no direct store writes),
  and `serve` detects a daemon already running for the same state dir.

## Notes

- No product code was changed. The throwaway probes lived in `packages/git-core/test/zz-*`,
  `apps/daemon/test/zz-*` and `apps/web/test/zz-*` and were deleted before this commit. Copies
  are in `/tmp/review-code-probes/` on the review machine.
- All fixture repositories were created under `os.tmpdir()` with an isolated git config
  (`GIT_CONFIG_GLOBAL` in the temp dir, `GIT_CONFIG_NOSYSTEM=1`, explicit user,
  `init.defaultBranch=main`, `commit.gpgsign=false`, `core.autocrlf=false`), and were removed
  afterwards.
- The perf bench was not run (the performance reviewer owns it).
