# fix-git-core report

Branch `fix/git-core`, based on `6f44f53` (`main`). Scope: `packages/git-core/**` only. Fixes
review-code F3, F4, F7, F8 and review-security SEC-06, SEC-07, SEC-08. Date: 2026-11-08.
Machine: WSL2, git 2.53.0, Node 26.13.0, pnpm 12.16.1.

Commits (oldest first):

| sha | what |
|---|---|
| `287f43f` | runner location pins + stdin + `check-attr`; SEC-06, SEC-07, SEC-08 |
| `8425047` | F3, F4, F7, F8 |
| `39fca4d` | skip/cache `check-attr` (perf); read-only and hostile-config proofs extended |
| `ade994d` | attribute cache stable across `getFileDiff`; no blocking on FIFOs; `O_NOFOLLOW` |
| `f921679` | streamed untracked display; `check-attr` failure degrades; relative-path worktrees |

Every finding was first reproduced with plain git and real temp repos (isolated config) before
I changed code. Each regression test starts with a plain-git control where that is meaningful.
Against `main`'s `src/`, 21 of the 26 new tests in `boundaries.test.ts` / `review-fixes.test.ts`
fail. The 5 that pass are expected: two plain-git controls, a symlink that stays inside the scan
root, linked worktrees with relative paths, and "no `check-attr` without attribute sources".

## Per finding

### SEC-06: `core.worktree` returned content outside the repository

**What changed.**
- `GitRunOptions.location` adds `--git-dir=<gitDir>` and `--work-tree=<root>` as global options
  (`runner.ts`, `buildGitArgv`). `GitContext.git()` and the per-operation config read pass them
  on **every** call. The only unpinned call is discovery itself (`resolveRepo`'s `rev-parse`).
- The work tree is no longer git's (`--is-inside-work-tree` / `--show-prefix` honor
  `core.worktree`). `findWorktreeRoot` finds it instead: the nearest directory at or above the
  path whose `.git` entry (a directory, a symlink, or a gitfile parsed like git's `read_gitfile`)
  resolves to the git dir git found. An explicit `--work-tree` wins over `core.worktree`
  (setup.c checks `GIT_WORK_TREE` first). Paths inside a git dir, and bare repos, get no work tree
  (`RepoInfo.bare` = bare or no work tree).
- `worktree list` reports the common dir itself as the main worktree when the work tree comes
  only from `core.worktree`. Then `linkedMainWorkTree` asks git for that work tree
  (`rev-parse --show-toplevel` with only `--git-dir` pinned) and accepts it **only if its `.git`
  links back to this git dir**. That keeps absorbed submodules working (their
  `.git/modules/<n>/config` sets `core.worktree`, and `sub/.git` points back). Anything else
  (`/home/user`, `../..`) is ignored, and the entry is reported `bare: true`.
- Project-level calls (`worktree list`, refs) pin `--git-dir=<commonDir>` with no work tree.

**Tests** (`test/boundaries.test.ts`, "SEC-06"): an absolute and a relative (`../../home`)
`core.worktree`, and a linked worktree's `config.worktree` `core.worktree`. In each, the plain-git
control lists and diffs the outside files. With git-core the list and summary are clean, outside
paths are `not_found`, a modified in-repo placeholder diffs its own content (never
`REAL-SECRET`), and every status scope is checked. Also: a bare-looking git dir with
`core.bare=false` + `core.worktree` comes back bare with no files. An absorbed submodule
resolves to its real work tree. `runner.test.ts` pins the argv order and rejects relative
locations.

**Residual risk.**
- Repos without a work tree (bare) still let git apply `core.worktree` internally for
  tree-to-tree diffs (branch/commit scope). That only affects which `.gitattributes` git reads
  (binary/funcname verdicts), never returned content.
- "Bare repo + `core.worktree=$HOME`" dotfiles setups lose their working scope (reported as bare).
  That's deliberate.
- An explicit `--git-dir` skips git's `safe.directory` check. Discovery still runs it, and it is
  re-run when the 5-minute repo cache expires or a call fails with `not_a_repository`.
- Separate-git-dir repos (`git init --separate-git-dir`, no `core.worktree`) are reported bare.
  git itself lists the git dir as their main worktree. Before this change their summary failed
  with `git_failed`; now they show as a bare entry. This gap predates the change.

### SEC-07: forged `.git/worktrees/*/gitdir` records

**What changed** (`discovery.ts`). A linked record counts as a worktree only if the link goes
both ways: `<path>/.git` refers to an admin dir directly under `<commonDir>/worktrees`, and that
admin dir's `gitdir` file refers back to `<path>/.git` (relative paths resolved as git does).
Otherwise the record is `prunable: true, missing: true`. The daemon neither watches nor
summarizes missing worktrees (`core.ts` `#syncWatcher` / `#computeSummary`). Duplicate records
for the same directory (a copied admin dir) are dropped, so ids stay unique.

**Tests** ("SEC-07"): forged records pointing at a 20-subdirectory non-repo, at a `$HOME`
stand-in, at another of the user's repos, at `/.git` (git then lists the admin dir itself), and
at another repository's real linked worktree. All come back missing + prunable. The real linked
worktree stays valid and appears once despite a copied admin dir. Worktrees created with
`worktree.useRelativePaths=true` stay valid. The control shows git itself lists the forged ones.

**Residual risk.** Forged records still appear in `listWorktrees` (as missing). There is no cap
on records per project (see "Notes for the daemon").

### SEC-08: scan followed symlinks out of the scan root

**What changed** (`discovery.ts` `scan`). A symlinked directory is followed only if its realpath
is the scan root's realpath or inside it. Loop and duplicate protection (visited realpaths) is
unchanged.

**Tests** ("SEC-08"): links `../../elsewhere`, an absolute path to elsewhere, and `/` are not
followed (`private-repo` is not found, and fewer than 20 dirs are scanned). A link that stays
inside the root is still followed, including one that is the only way to reach a repo within the
depth limit. The existing loop and duplicate tests still pass.

**Residual risk.** A `.git` symlink or gitfile *inside* the root that points outside it still
registers the directory. That is git's own discovery mechanism, and linked worktrees under a scan
root legitimately point to a main repo elsewhere.

### F3: submodule pointer changes did not change `stateHash`

**Verified first.** The review's suggested fix does not work on git 2.53. `diff --raw HEAD`
prints a null worktree oid for a modified gitlink (`:160000 160000 1a02a6f 0000000 M sub`), so
the raw line doesn't change when the submodule commits. Only the patch (`index a..b 160000`,
`Subproject commit b`) carries the checked-out commit.

**What changed** (`summary.ts`). For every changed gitlink (`modeWorktree` 160000 with worktree
changes), the dirty-file signature that goes into `stateHash` now includes the submodule's HEAD.
`nestedRepoHead` (`untracked.ts`) reads it from the filesystem only (no git process):
- it follows the gitfile, `commondir`, `HEAD`, symref chains (up to 5), loose refs, then
  `packed-refs`;
- it returns the exact sha when it can, otherwise a fingerprint of the ref storage (packed-refs
  stat, `reftable/tables.list`) that still changes on every ref update;
- it refuses ref names with `..` or odd bytes.

The summary costs **no extra git call**. `listChangedFiles`'s patchHash already changed (it
comes from the patch).

`getWatchTargets().gitPaths` adds `<gitDir>/modules`, `<commonDir>/modules` (submodule git dirs)
and `<commonDir>/info/attributes`. These are additive entries in an existing array, so no
contract change.

**Test** ("F3"): a superproject with `sub` moved c1 → c2. An in-place commit inside the
submodule (directory entries unchanged) changes both `stateHash` and the gitlink's patchHash.
`reset --soft HEAD~1` restores the earlier hash exactly, a detached checkout changes it, and two
calls without changes give equal hashes. `gitPaths` contains `.git/modules`.

**Residual risk.**
- Non-absorbed submodules (a `.git` directory inside `sub/`) are hashed correctly, but their git
  dir sits inside the worktree, where the daemon's watcher ignores `.git`. Only the fallback poll
  catches those.
- A reftable submodule changes on any ref update, not just HEAD. That's a harmless false positive.

### F4: untracked → `git add` dropped review marks

**What changed** (`untracked.ts`, `diff.ts`).
- An untracked file's `patchHash` is now the `PatchHasher('patch')` digest of its **canonical
  new-file patch**, the same function `listChangedFiles` applies to the chunk git prints after
  `git add -N` / `git add`.
- The patch is synthesized and streamed: header with blob id (SHA-1 or SHA-256), `---`/`+++`
  with git's quoting and TAB rule, hunk header, `+` lines, "No newline". Files up to 1 MiB are
  read once; larger ones twice, rejected if they change between passes. Memory stays at about
  1 MiB.
- The displayed untracked patch is streamed through the same writer, so the display is the
  hashed text. That replaces the `git diff --no-index` spawn.
- **Nested repositories:** their HEAD (above) goes into their hash and signature. When the sha
  resolves, the patchHash is that of the gitlink patch `git add <dir>` produces, so it survives
  adding. An unborn nested repo is hashed by its ref fingerprint.
- **Cap:** `maxUntrackedFiles` now applies **to all untracked files or to none**, counted on git
  status' list. It used to apply to the first N by path, so a new file that sorted earlier pushed
  another across the cap and changed its hash. Over the cap, every file is fingerprinted by stat
  and gets no line counts.

**Tests** ("F4", sha1 and sha256 repos):
- 16 kinds of file: empty, no trailing newline, blank lines, CRLF, space / quote / backslash /
  tab / non-ASCII / non-UTF-8 names, NUL binary, executable, symlink, nested dirs, a `binary`
  attribute file, and a ~3 MiB file. For each, `hash(untracked) == hash(after add -N) ==
  hash(after add)`, with the same `binary` and `additions`.
- The ~3 MiB file's `full` display is byte-equal to `git diff --no-index`.
- A nested repo's hash changes on an in-place commit, survives `pack-refs`, returns to the
  original on checkout, and equals the gitlink hash after `git add`. An unborn nested repo
  changes on its first commit.
- `diff-working.test.ts`: the cap test now checks all-or-nothing, and that a new file sorting
  first changes no other hash.

**Residual risk.**
- Equality after `git add` does not hold when adding *converts* content: `eol`/`text=auto` on
  CRLF content, `ident`, `working-tree-encoding`, global filters such as git-lfs (the index gets
  the pointer). LF-only text is unaffected by eol rules.
- Files above `core.bigFileThreshold` or over the cap keep stat-based hashes.
- Crossing the cap flips every untracked hash at once. That's deterministic and rare.
- Changing the scheme invalidates, **once**, review marks that were set on untracked files before
  the upgrade.

### F7: one unreadable tracked file failed the whole worktree

**What changed.**
- When the worktree-reading `git diff` fails with `git_failed`, `findUnreadable` checks
  `access(R_OK)` on changed regular files (EACCES/EPERM). If any are unreadable, the diff is
  re-run with literal pathspecs for every other status path, and the excluded files' rename
  sources are excluded too.
- **Summary:** the unreadable files count as changed without line counts, and the stateHash marks
  the degraded state. If the paths can't be passed (non-UTF-8, or over a 512 KB / 24 KB-on-Windows
  argv budget) or the retry fails, it falls back to status-only counts.
- **List** (`working`/`unstaged`): the unreadable files are listed from their status entry
  (status, modes, `additions/deletions: null`), with patchHash = hash(scope, status line, lstat
  signature), so it changes whenever the file does.
- `getFileDiff` for the unreadable file rejects with `git_failed` ("…open("secret.txt"):
  Permission denied"). Every other file works. `staged` and tree scopes are unaffected.

**Tests** ("F7", skipped as root): the control shows `git diff HEAD` fails. Then: summary
`changedFiles` 3 with additions from the readable files only, equal to the list length. The list
has `a.txt` (+1), `secret.txt` (`null`), `u.txt` (+2), and readable files hash consistently.
The unreadable file's diff rejects. `unstaged` works and `staged` is empty. Both hashes change
when the unreadable file changes.

**Residual risk.**
- If the pathspecs cannot be passed, the list still fails as before; the summary degrades to
  status-only.
- Windows ACL semantics are untested.

### F8: untracked files under `binary` / `-diff` attributes were misreported

**What changed.**
- `git check-attr -z --stdin diff` (read-only, newly allowlisted; stdin support added to the
  runner) gives the `diff` attribute of untracked paths in one call: `unset` (the `binary` macro,
  `-diff`) → binary, `set` → text even with NULs (as git does), anything else → git's NUL sniff.
- The same verdict drives the list, the summary's additions, the diff (`binary: true`,
  `patch: ''`) and the hash, so it matches `git add`.
- The verdict is part of the content cache key and of `stateHash`.
- **Cost control:** `check-attr` is skipped when no attributes source can apply. Sources checked:
  a `.gitattributes` on the directory chain of any untracked path or in status, `info/attributes`,
  `core.attributesFile` (read in the existing per-operation `git config --get-regexp`, whose
  pattern now also matches that key), `$XDG_CONFIG_HOME/git/attributes`, `/etc/gitattributes`,
  `<git prefix>/etc/gitattributes`. On Windows it always runs.
- **Cache:** verdicts are cached per worktree, keyed by the stat data of all those sources. Only
  new paths are asked about. `getFileDiff` shares the list's cache key.
- If `check-attr` fails, git-core falls back to the sniff with a warning.

**Tests** ("F8"):
- `*.dat binary`, `*.nd -diff`, `*.forced diff` (NUL content) and a plain file, in list, diff,
  summary and after `git add`. An `info/attributes` change alone changes the summary.
- Each source is honored: `info/attributes`, a nested `.gitattributes`, `core.attributesFile`,
  XDG.
- No `check-attr` spawn at all without sources (checked via the runner's debug log). The cache
  makes no new spawn on repeat calls or after a single diff, one spawn for a new path, and
  invalidates when `.gitattributes` changes.

**Residual risk.**
- A `diff=<driver>` whose config has `diff.<driver>.binary=true` is still decided by sniff for
  untracked files.
- Two sources are missed by the skip check and the cache key: a sparse-checkout `.gitattributes`
  that exists only in the index (the index stat is deliberately not in the key, to keep the hit
  rate), and system attributes at a non-standard prefix.

## Decisions (please log in DECISIONS.md)

1. **Pin `--git-dir` and `--work-tree` on every git call after discovery.** The work tree is the
   directory whose `.git` links to the git dir (git-core finds it, not git). `core.worktree` is
   honored only if its target's `.git` links back (absorbed submodules). Otherwise the main entry
   is reported bare.
2. **Linked worktree records must link both ways**, or they are `prunable` + `missing`; duplicate
   records are dropped. `missing` now also means "no valid worktree at that path".
3. **Scan symlinks are followed only within the scan root's realpath.**
4. **The F3 submodule HEAD is read from the filesystem** (no spawn). It goes into the dirty-file
   signature, and its git dirs are added to `gitPaths`.
5. **Untracked `patchHash` = hash of the canonical new-file patch.** It is synthesized and
   streamed, and the display uses the same text. `git diff --no-index` is no longer spawned
   (the runner still supports it).
6. **`maxUntrackedFiles` is all-or-nothing** per status snapshot.
7. **`check-attr` is allowlisted** (`-z`, `--stdin`, `-a/--all`, `--cached` only), run once per
   operation when attributes can apply, and cached per worktree by source stat data.
8. **F7 degrades per file:** explicit pathspecs exclude unreadable files, which are listed from
   status, and their own diff fails.
9. **`stateHash` version bumped** (`summary-v2`): every stateHash changes once after upgrade.
10. **FIFO safety:** all new metadata reads open with `O_NONBLOCK` and require a regular file.
    Untracked contents also use `O_NOFOLLOW`.

## Requested PLAN / doc changes (lead)

- **PLAN §5.5 allowlist:** add `check-attr` (read forms `-z`, `--stdin`, `-a`/`--all`,
  `--cached`; `--source` rejected). Add a rule: "After discovery, every invocation pins
  `--git-dir` and (with a work tree) `--work-tree`; repository `core.worktree` never selects
  files."
- **`packages/contracts` docs (no code change):** `Worktree.missing`: "The worktree path no
  longer exists on disk, **or is not a valid worktree of this project** (its `.git` does not link
  back)." `WatchTargets.gitPaths` may include `modules` directories (submodule git dirs).
- **DECISIONS.md:** entries for the decisions above. Also mark SEC-06/07/08 and F3/F4/F7/F8 as
  fixed on the git-core side.

## Contract changes

None. `packages/contracts` is untouched. `gitPaths` only gets more entries of the existing kind.

## Verification

All from the repo root at `f921679`.

- `pnpm check`: Biome checked 220 files, no errors. `typecheck` clean in every package.
  `build` OK. Tests:
  - contracts 58
  - **git-core 126 (12 files)**; base was 98 in 10 files
  - web 38
  - daemon 86
  - cli 108
  - fixtures 48
  - e2e unit 5
  - Wall time 14.6 s.
- `pnpm test:e2e`: **36 passed** (1.2 min). Read-only proof: 12 control repos, 1548 lock polls,
  **0 violations**.
- git-core read-only proof (`readonly.test.ts`) passes with new fixtures: a superproject with a
  moved submodule pointer, a `binary`-attribute untracked file (exercises `check-attr`), an
  untracked nested repo (HEAD reader), and an unreadable modified tracked file (degraded path).
  It checks: no inotify event in any git dir (including `.git/modules/sub` and the nested
  repo's), every git-dir file unchanged, status unchanged.
- Hostile config (`hostile-config.test.ts`) passes with an untracked nested repo carrying its own
  fsmonitor/filter config and a file under the evil diff driver. 0 markers.

**Performance**:
- Command: `pnpm exec tsx --conditions=@octopus-diff/source
  packages/git-core/test/bench/summary.bench.ts 30` (30 repos × 3 worktrees, 200 files each, 60
  dirty worktrees with an untracked file).
- `BENCH_ATTRIBUTES=1` (new) commits a root `.gitattributes` in every repo.
- Before = `6f44f53`'s `src/`, after = `f921679`. 3 interleaved runs each; medians in ms. The
  machine was shared with other sessions, so individual runs vary by ±10%.

| | cold c=4 | warm | cold c=8 | list ×60 | one diff |
|---|---|---|---|---|---|
| before, no attributes | 589 | 440 | 572 | 203 | 9 |
| after, no attributes | 601 | 460 | 590 | 218 | 9 |
| before, root `.gitattributes` | 597 | 476 | 600 | 262 | 11 |
| after, root `.gitattributes` | 703 | 484 | 655 | 269 | 11 |

The only real cost is **cold** `getSummary` in repos that have attributes: +~105 ms over 90
worktrees. That's one `check-attr` per worktree with untracked files, which F8 correctness
needs. Warm summaries (the daemon's steady state) and lists are back to baseline thanks to the
skip and the cache. Without attributes, nothing changes. Still far below the 3 s target.

## Notes for the daemon (integration)

- **Watching submodules (F3):** `gitPaths` now includes `<gitDir>/modules` and
  `<commonDir>/modules`, but the daemon's `GIT_DIR_IGNORES` ignores `modules` entirely. To get
  immediate updates, watch `modules/**/HEAD`, `modules/**/refs/**`, `modules/**/packed-refs` and
  `modules/**/reftable/**` (not `objects`, `logs`, `index`). Map them to the superproject's
  worktree, not to a registered submodule project (review F3's "nested project steals events").
  Until then the fallback poll catches these changes, because `stateHash` now changes.
- **Forged worktrees (SEC-07):** they arrive as `missing: true, prunable: true`, which the daemon
  already skips for watching and summaries. Consider hiding `prunable && missing && !locked`
  records in the UI, or labeling them as invalid, and capping records per project (the review's
  third suggestion; not done in git-core).
- **Submodule projects:** their main worktree path is now the submodule work tree (`…/sub`), not
  `…/.git/modules/sub`. The id changes once (removed + added on the first relist after upgrade),
  and `matchedWorktreeId` now matches.
- **After upgrade:** every `stateHash` changes once (`summary-v2`), and review marks on
  *untracked* files from before the upgrade show as unreviewed once (new hash scheme). Marks on
  tracked files are unaffected.
- **F7:** `getFileDiff` for an unreadable file rejects with `git_failed`. Show it as a per-file
  error; the rest of the worktree is fine.
- **F8:** for untracked files under `binary`/`-diff`, list and diff now agree (`binary: true`,
  `patch: ''`). An untracked nested repository's diff now shows `+Subproject commit <sha>`
  instead of an empty patch.
- `getFileDiff` for untracked files no longer spawns `git diff --no-index`. It may spawn one
  `check-attr` (cached).

## Known gaps

All listed under "Residual risk" above. Briefly:
- **F4:** content conversion on add breaks hash equality; big and over-cap files stay
  stat-hashed.
- **F8:** driver-level `binary=true`; sparse index-only attributes.
- **SEC-06:** dotfiles and separate-git-dir repos are reported bare.
- **SEC-07:** forged records still listed (as missing); no per-project cap.
- **SEC-08:** `.git` gitfiles/symlinks inside the root may point outside.
- **F3:** non-absorbed submodules are not watched.
- Tested only on Linux (WSL2) with git 2.53.0.
