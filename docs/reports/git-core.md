# WS1 git-core report

Branch `ws/git-core`, based on `db5274c`. Package: `packages/git-core`. Date: 2026-11-08.

## Shipped

The real implementation of the `GitCore` contract (`packages/contracts/src/git-core.ts`); the
placeholder is gone and `GIT_CORE_IMPLEMENTED` is `true`.

**Public exports** (`@octopus-diff/git-core`):

- `createGitCore(options?: GitCoreOptions): GitCore`: everything the daemon needs.
- `hashId(value)`: id helper (first 16 hex of SHA-256, DECISIONS #8) for scan-root ids.
- `GIT_CORE_IMPLEMENTED`, `MIN_GIT_VERSION` (`2.31.0`), `parseGitVersion`.
- For tests and tools (WS4's proof harness can reuse them): `GitRunner`, `assertAllowedGitArgs`,
  `ALLOWED_SUBCOMMANDS`, `buildGitArgv`, `buildGitEnv`, `resolveExecutable`, `SAFETY_ENV`,
  `CONFIG_PINS`, `DIFF_PINS`, `CANONICAL_CONTEXT`, `STATUS_ARGS`, and the pure parsers `parseStatusV2`, `parseRawNumstat`,
  `DiffOutputParser`, `PatchSplitter`, `splitPatch`, `parseChunkHeader`, `parseWorktreeList`,
  `parseForEachRef`, `parseLog`, plus `PatchCollector`, `computeFilterOverrides`,
  `synthesizeNewFilePatch`, `quotePathName`, `unquoteMaybe`, `decodeRepoPath`, `selectorToBstr`.

**Layout** (`packages/git-core/src`):

| File | What it does |
|---|---|
| `runner/runner.ts` | The single git runner: `spawn` of an absolute git path (resolved from absolute PATH entries only) with an argv array (never a shell), global options `--no-pager --no-optional-locks` + pinned `-c` config (incl. `core.bigFileThreshold`), safety flags per subcommand (`--no-ext-diff --no-textconv --no-color`, `--no-show-signature`), timeout, stdout cap (buffered) or streaming, stderr cap, error classification, process-group kill, fair scheduler (global limit, per-repo FIFO queues served round-robin), `dispose`. |
| `runner/allowlist.ts` | Subcommand allowlist and argument checks (`worktree list` only, read-only `config --get*`, read-only `symbolic-ref`, rejected writing/executing options). |
| `runner/config-pins.ts` | Config pinned on every call (fsmonitor off, autoRefreshIndex off, prefixes, quoting, colors, renames, algorithm, hunk merging, submodule format, status options, gpg, gc, protocols). |
| `runner/env.ts` | Environment: safety variables win; redirecting/executing variables removed; `GIT_CONFIG_COUNT` helper. |
| `context.ts` | Version gate, repo resolution (git dir, common dir, toplevel, object format; cached 30 s), repo-local filter-driver neutralization (read once per operation). |
| `parse/*.ts` | Pure parsers on raw bytes ("bstr" = latin1 strings, so non-UTF-8 paths survive). |
| `discovery.ts` | `resolveProject`, `listWorktrees`, default-branch detection, ref resolution, `scan`. |
| `scope.ts` | Turns a `DiffScope` into revision args (unborn HEAD → empty tree, merge base for branch scope, first parent / empty tree for commits). |
| `diff.ts` | `listChangedFiles`, `getFileDiff`: streaming raw+numstat+patch parsing, per-file chunk hashing, stat-only filtering, untracked files. |
| `untracked.ts` | Untracked inspection (mode, binary sniff, line count, content hash; cached by stat signature), synthesized new-file patches. |
| `summary.ts` | `getSummary` and `stateHash`, in-progress detection. |
| `core.ts` | `createGitCore`, `listCommits`, `getWatchTargets`, option validation, dispose guard. |

**Behaviour highlights:**

- Every scope: `working` (index + worktree vs HEAD, untracked files as additions), `staged`,
  `unstaged`, `branch` (merge-base..HEAD, committed only), `commit` (first parent / empty tree
  for roots). Covered: renames, copies (staged/branch/commit), deletes, binary, very large files
  (`tooLarge` above `maxPatchBytes`, `truncated` at `maxOutputBytes` with `full`), submodules
  (gitlink commit changes), symlinks, typechanges (both chunks), CRLF, conflicts (all three
  status scopes), unborn HEAD, bare repos, non-UTF-8 paths (`rawPath`; fetched by scope and
  split, since Node cannot pass non-UTF-8 argv), nested untracked repositories.
- `patchHash` is identical between `listChangedFiles` and `getFileDiff` for the same state, and
  independent of `ignoreWhitespace` / `contextLines` / `full` (tested for every file of every
  scope). `getFileDiff` uses a cheap whole-scope `--raw` call to identify the file, then
  narrows the patch to its pathspec(s) (old+new for renames). Copies and non-UTF-8 paths use the
  whole scope so the patch is byte-identical.
- `getSummary` = one `git config --get-regexp` (filter drivers) and one `git status`; plus
  `git diff --numstat` only when tracked files changed;
  plus `for-each-ref` + `rev-list --count` only without a usable upstream. Untracked line counts
  are cached by stat signature. No patch text is generated for summaries.
- `stateHash` changes when an already-modified or untracked file is modified again (lstat
  signature of dirty files), and does not change when a clean file is merely touched.

## Verification

All commands from the repo root on the dev machine (WSL2, Node 26.13.0, pnpm 12.16.1,
git 2.53.0), at the final commit:

- `pnpm lint`: Biome checked 92 files, no errors.
- `pnpm typecheck`: all 7 packages done, no errors.
- `pnpm test`: all packages pass; **git-core 10 files, 98 tests, ~1.9 s** (contracts 57, the
  other packages' placeholders 1 each).
- `pnpm build`: all packages build (`packages/git-core/dist` imports and runs on plain Node:
  smoke-tested `createGitCore().resolveProject/getSummary` against a scratch repo).

git-core test files (real git, fixtures under `os.tmpdir()` with isolated config:
`GIT_CONFIG_GLOBAL=<temp file>`, `GIT_CONFIG_NOSYSTEM=1`, fixed identity/dates,
`init.defaultBranch=main`, `commit.gpgsign=false`, `core.autocrlf=false`, passed to git-core
via `GitCoreOptions.env`):

| File | Covers |
|---|---|
| `diff-working.test.ts` | working/staged/unstaged lists, flags, statuses, patches, untracked files vs `git diff --no-index`, non-UTF-8 paths, invalid input, stat-only changes (and index untouched), subdirectory locators, `maxUntrackedFiles`, `tooLarge`/`full`/`truncated`. |
| `diff-special.test.ts` | conflicts (all status scopes + summary), submodules (incl. dirty submodules ignored), symlinks/typechange, unborn HEAD, branch scope (default/explicit/option bases, errors), commit scope (root, short sha, merge, missing), immutable cache isolation, `listCommits`, bare repos. |
| `discovery.test.ts` | `hashId`, `resolveProject` from main/subdir/file/linked/git dir/bare/bare worktree, worktree flags (locked, detached, prunable, missing, unborn), default-branch detection order, `scan` (depth, ignore, node_modules, nested, linked, bare, symlink loop and duplicate, abort, progress, validation), `getWatchTargets`. |
| `summary.test.ts` | clean/dirty summaries, counts vs working scope, stateHash sensitivity, ahead/behind (upstream, default branch, explicit/missing default, detached), in-progress (cherry-pick, rebase, am). |
| `runner.test.ts` | allowlist (43 writing subcommands rejected, incl. add/commit/checkout/reset/apply/fetch/gc; writing forms of allowed ones), rejection before spawn, argv/env construction, timeout, output cap, error classification, safety env reaching git, concurrency limit + fairness, dispose, version gate. |
| `parsers.test.ts` | status v2, raw/numstat (combined entries, positional paths), patch splitting (quoting, renames with spaces, typechange, cc, unmerged, binary; identical results for any stream chunking; very long lines), worktree list (-z and LF), for-each-ref, log, versions, filter overrides, synthesized patches byte-equal to git's. |
| `readonly.test.ts` | **Read-only proof**: every GitCore method on stat-dirty repos (main + linked worktree, conflict, unborn, bare), then: no inotify event at all in any git dir (so no `index.lock`), every file under every git dir unchanged (content, size, mtime, inode: `index`, `HEAD`, refs, `packed-refs`, worktree admin dirs), `git status` porcelain unchanged. Plus the split-index boundary (below). |
| `hostile-config.test.ts` | Local config with `core.fsmonitor`, filter clean/smudge, `diff.external`, diff driver command, textconv, pagers, `log.showSignature` + `gpg.program` (with a signed commit), hooksPath, and `GIT_EXTERNAL_DIFF` in options: control run proves plain git executes them; no GitCore method does. A trusted global filter still runs; a local override of it does not. |
| `no-shell.test.ts` | No `shell:` option, no `exec`/`execFile`/`spawnSync` in `src/`; only `runner/runner.ts` imports `node:child_process`, and only `spawn`. |
| `exports.test.ts` | Public exports and option validation. |

**Independent review.** After the suite was green, a fresh agent reviewed `src/` with only the
code and contract (no conclusions from me) and ran its own experiments: 11 findings, 10
confirmed. All are fixed, each with a regression test (DECISIONS WS1 #22). The two serious ones:
a 60 s cache of the filter neutralization could miss a driver added through an included config
file (now read per operation), and spawning a bare `git` could execute a planted `./git` via a
relative `PATH` entry (now resolved to an absolute path). Also: per-worktree `.gitattributes`
made the branch/commit result cache wrong (removed), and a narrowed pathspec could change
rename pairing (verified, falls back to the whole scope).

**Performance** (manual, `pnpm exec tsx --conditions=@octopus-diff/source
packages/git-core/test/bench/summary.bench.ts 30`; 30 repos × 3 worktrees, 200 files each,
two thirds dirty; 12-core WSL2):

| Operation | Time |
|---|---|
| `getSummary` × 90, cold, concurrency 4 | 585 ms |
| `getSummary` × 90, warm | 452 ms |
| `getSummary` × 90, cold, concurrency 8 | 591 ms |
| `listChangedFiles(working)` × 60 dirty worktrees | 212 ms |
| `getFileDiff`, one file | 9 ms |

The < 3 s initial-paint target has plenty of headroom on the git side.

## Decisions

Logged as DECISIONS.md "WS1 — git-core" #1–#22. The ones that matter most:

- **Minimum git 2.31.0** (`git_unsupported` below; `worktree list -z` feature-detected at 2.36).
- **`diff.autoRefreshIndex=false`**: porcelain `git diff` otherwise rewrites the index
  (takes `index.lock`) when files are stat-dirty, even with `--no-optional-locks`. The
  read-only proof test caught this. Stat-only raw entries are filtered.
- **Repo-local filter drivers are neutralized** (reset to the global value or disabled) via
  `GIT_CONFIG_COUNT`; `config --get-regexp` was added to the allowlist's read forms to find them.
- **Copies only where the worktree isn't read** (staged/branch/commit) to keep results
  independent of stat state.
- **`--ignore-submodules=dirty`**: only submodule commit changes are reported.
- **`core.bigFileThreshold` pinned** to `max(maxOutputBytes, 1 MiB)`: larger files diff as
  binary, bounding each streamed patch; total streamed output is bounded by the timeout.
- **git is spawned by absolute path** (absolute PATH entries only).
- `patchHash` / `stateHash` definitions (DECISIONS WS1 #7, #8).

What git-core defends against (repository config is untrusted): fsmonitor hooks, external diff
(config, attributes, env), textconv, repo-local clean/smudge/process filters, gpg via
`log.showSignature`, pagers, auto-gc/maintenance, any network transport (`protocol.allow=never`,
`GIT_ALLOW_PROTOCOL=none`, `GIT_NO_LAZY_FETCH=1`), output files (`--output`), environment
redirection (`GIT_DIR`, `GIT_INDEX_FILE`, ...), option injection (argv only, validated refs,
`--` separators, `GIT_LITERAL_PATHSPECS=1`). Not defended: see Known gaps.

## Contract changes

None. `packages/contracts` is untouched.

## Known gaps

- **Tested only with git 2.53.0 on Linux (WSL2).** Versions 2.31–2.52 and Windows/macOS are
  untested; older gits may phrase stderr differently (error classification is best-effort).
- **Split-index repositories** (`core.splitIndex=true`): git bumps the mtime (only) of
  `.git/sharedindex.<sha>` on every index read (`freshen_shared_index`, so it isn't expired).
  Unavoidable from outside git; content, `index`, refs and locks are untouched. Pinned by a
  test.
- Filter neutralization has a small TOCTOU window: config is read once per operation, so a
  driver added to the repo config between that read and the `status`/`diff` call (same
  operation, milliseconds) would run. Trusted global drivers do run: git-lfs may write into
  `.git/lfs/objects` exactly as plain `git status` does (DECISIONS WS1 #3).
- Streaming patch runs don't cap total output at `maxOutputBytes` (per file it is bounded via
  `core.bigFileThreshold`; overall by `timeoutMs`), see DECISIONS WS1 #19.
- Untracked files: binary detection for listing is a NUL sniff of the first 8000 bytes or size
  above `core.bigFileThreshold` (ignores `.gitattributes`); the displayed patch comes from git
  and honors attributes. Untracked patches for symlinks and non-UTF-8 paths are synthesized
  (no attributes, no CRLF conversion).
- Uncommitted changes inside submodules are not reported (decision 6).
- In the working scope, copies are reported as `added` (decision 5).
- A path removed from the index but still on disk (`git rm --cached`) is reported once, as
  `deleted`; its untracked twin is dropped.
- File contents that are not UTF-8 are decoded lossily in `patch` (hashes use the raw bytes).
  Worktree *directories* whose path is not valid UTF-8 are not supported.
- A conflicted path containing a newline followed by text that looks like a patch header
  (`@@`, `Binary files `) would still be misparsed in the staged scope (git does not quote
  `* Unmerged path` names); plain newlines are handled.
- Rename detection is limited to 1000 candidates (`diff.renameLimit`/`status.renameLimit`
  pinned); above that renames show as delete + add.

## Notes for integration

- `createGitCore(options)` is ready to replace the daemon's stub. `options.env` is for tests
  (isolation); in production leave it unset. Defaults: concurrency 4, timeout 15 s, stdout cap
  64 MiB, soft patch limit 1 MiB, 2000 untracked files. git is looked up once in the absolute
  `PATH` entries (or pass an absolute/relative `gitBinary`); not found → `git_not_found`.
- Cost per call (spawns): `getSummary` 2–5 (config read for filters, status, numstat if tracked
  changes, for-each-ref + rev-list without upstream); `listChangedFiles` 3 for status scopes
  (config, combined diff, status; +1 for unstaged conflicts), 3–5 for branch/commit;
  `getFileDiff` 3–6 (identify, status, canonical patch, optional view, rare whole-scope retry).
- Pass the project's effective default branch to `getSummary`/`listChangedFiles` via
  `{ defaultBranch }`; otherwise git-core detects it each call (one extra `for-each-ref`).
- `summary.changedFiles === listChangedFiles(wt, { kind: 'working' }).length` for the same
  state, and `additions`/`deletions` match the sum over that list.
- `stateHash` is safe to compare for "refetch or not". Touching files without changing content
  (builds, editors) does not change it unless the file is already dirty.
- `getWatchTargets().gitPaths` may include paths that don't exist yet (`MERGE_HEAD`,
  `rebase-merge`, `reftable`, ...): watch their parent directories (`gitDir`, `commonDir`).
- Errors: a deleted worktree directory → `not_found`; not a repo / dubious ownership →
  `not_a_repository`; old git → `git_unsupported`; missing binary → `git_not_found`.
  `command_not_allowed` should never reach the daemon (it would mean a git-core bug).
- `patchHash` depends on the scope (an untracked file gets a different hash once staged, and the
  same file in `working` vs `unstaged` hashes differently): review keys already include
  `scopeKind`, so this is consistent with PLAN §5.7.
- **BLOCKERS.md WS1 #1:** `pnpm install` exits non-zero (`ERR_PNPM_IGNORED_BUILDS` for esbuild)
  in a fresh worktree; needs `esbuild` in `allowBuilds` (root config, lead/WS5).
- PLAN §5.5 was updated (allowlist `config` read forms; autoRefreshIndex note). README (WS5)
  should state "git >= 2.31".
