# web-merge-noise report

Roadmap #34 "web: collapsed 'from merge' group, filter chip and mixed-file toggle" (step 13 of #24, milestone M2 "Merge
noise out of the box"). Branch `feat/web-merge-noise`, from `main` at `cf85c2b`. DECISIONS **#205-#208** (the daemon
branch `feat/daemon-file-origins`, PR #66, uses #201-#204). Built against the contracts on `main` and the mock backend;
the daemon branch is not merged here, its semantics were read from its report (labels only on base and mixed files; in
All on branch a file both sides changed is own; `unreviewedFiles` keeps its meaning, `unreviewedOwnFiles` is preferred).

## Shipped

- **Collapsed group** (`components/FileList.tsx`, `components/OriginGroupHeader.tsx`). Own and mixed files first
  (`ownFirst`, a stable partition); at the end of each worktree group a disclosure button `From <integrationRef> - <via>
  (N files)` (via = merge / rebase / update / same as main / in progress; mixed vias: `From origin/main (5 files)` and
  a tag per row). Expanded rows are dimmed and tagged with their via. `aria-expanded`, tab-reachable, `Enter`/`Space`.
  Still virtualised: the group row is one more slot in the group's slot range (`noiseAt`), so mounted rows stay ~46.
- **Keyboard.** One predicate: `visible = reviewed-eye AND originVisibleIf(view)`. `j`/`k`/ArrowUp/Down, `n` (the
  `eligible` argument of `nextUnreviewed`), the bulk plan and selection repair all use it, so a collapsed group is
  skipped everywhere; expanding makes the rows reachable; a selection inside a group that gets collapsed stays selected
  and `k` steps to the last own file. Selection, scroll and the expanded state survive a live refresh (tested).
- **Chip** `From main (N)` in the file pane header before the eye (`ToggleButton` chip variant, `aria-pressed`): off by
  default, a per-device pref (`fromMainOnly`, additive, no prefs version bump), on = only base files (plain, tagged, no
  group row). Key `m`, palette "Show only files from the default branch"; palette-only "Expand / collapse the files
  from the default branch" (open worktree, or every Inbox group).
- **Counts.** Group header, scope select (`To review (N)`, `All on branch (N)`, the current scope's `N of M`), "Review N
  shown", Inbox "Review all N": own + mixed. Sidebar row / chip / title / favicon: `unreviewedOwnFiles ??
  unreviewedFiles`. The bulk plan never includes base files (expanded or not), so the button count equals what the
  click changes; the daemon skips them as well (#204).
- **Mixed files.** `+main` tag; header chip "Only this branch's changes" (shown where the list has mixed files, or
  while it is the reason for the scope) switches to the existing All on branch scope (`ALL_ON_BRANCH`, same query path)
  and, pressed, returns to the scope it came from (`branchToggleFrom`, cleared by any other scope change).
- **Older daemons.** `origin` absent = own: no group, no chip, no toggle, no tag; tested against a mock without noise.
- **Tree layout.** `@pierre/trees` cannot host a sub-group: own + mixed files in the tree and the same disclosure bar
  under it; expanded, the base files join the tree in tree order with the via as a row decoration (known gap below).
- **Mock** (`mock/backend.ts`, `content.ts`, `server.ts`): `mergeNoise` option (off by default so counting tests keep
  their numbers; the standalone `dev:mock` / `preview:mock` turn it on, `MOCK_MERGE_NOISE=0` off). `feat/auth`: 4
  merge + 1 same-as-main base files and a mixed file; `fix/cache`: 3 rebased base files; the large dataset: 12 base +
  3 mixed files per non-default worktree, no PRNG draws (the rest of the dataset is unchanged). To review labels them,
  the summary carries `baseFiles` / `unreviewedOwnFiles` / `integrationRef`, All on branch lists mixed files as own and
  no base file, bulk review skips base files and moves the bookmark.
- **Scripts.** `scripts/perf.ts` takes `SCOPE` (default `working`) and waits for that scope's own list (see
  Verification); `scripts/shots.ts` has `merge-noise`, `merge-noise-open`, `merge-noise-chip`.
- Docs: DECISIONS #205-#208, `docs/STATUS-FLOW.md` §2.4a, `docs/TOOLBAR.md` §3.2, `docs/PLAN.md` §4.2 (and the
  keyboard line: `m`).

## Verification

Machine: 12-core WSL2, Node 26.13. All commands from the repo root unless noted.

- `pnpm check`: **exit 0**, 41.6 s wall (lint incl. `credits:check`, typecheck, build, tests): contracts 93, forge 101
  (+5 skipped), git-core 253, fixtures 53, **web 281** (was 254: +27 in `test/merge-noise.test.tsx`), daemon 264 (+1
  skipped), e2e unit 5, cli 139, scripts 34. (`pnpm install --frozen-lockfile --offline` first: the worktree lacked
  some root dependencies; the lockfile is unchanged.)
- **New tests** (`apps/web/test/merge-noise.test.tsx`, 27): model (`ownFirst`, `countOwn`, `originVisibleIf`, `j`/`k`
  skipping and reaching, `n` skipping, group labels for same / different / absent vias, tags, per-worktree stats,
  bulk plan count and paths, sidebar `unreviewedOwnFiles` with the older-daemon fallback); app against the mock
  (collapsed group at the end and its label, mixed `+main` tag, own rows untagged, same-via label, expand: dimmed + via
  tags + order, collapse, `j`/`k` through the group, `n` never landing in a collapsed group, selection and expansion
  across a live refresh, group row on `Enter` / `Space`, chip on/off / `m` / `Enter` / pref / absent without noise,
  scope counts + sidebar + Inbox header + title, "Review N shown" and Review all leaving base files alone, mixed
  toggle there and back, the way back forgotten on another scope change, older daemon, tree layout bar).
- **Mutation checks** (each reverted): `n` ignoring `originVisible` fails 1 (a first draft of that test passed
  vacuously, it read the selected row from the DOM and a collapsed row does not exist; it now reads the store);
  bulk plan not skipping base files fails 3; the scope count not preferring `unreviewedOwnFiles` is covered by the
  counts test (fails with the mutation).
- **e2e (real daemon from `main`, no origins, so this proves nothing regressed)**: `cd e2e && pnpm exec playwright
  test tests/03-scopes tests/05-review tests/06-keyboard tests/11-ui-bulk-review tests/15-ui-status-flow
  tests/04-live-updates tests/16-copy`: **38 passed** (1.1 min), exit 0, 0 read-only violations in 1580 lock polls; no
  shutdown hang (BLOCKERS Open 2 did not trigger); `16-copy.spec.ts:226` passed. The full suite was not run.
- **Perf**, `pnpm --filter @octopus-diff/web perf` against `preview:mock` on the production build (large dataset: 30
  worktrees x 200 files, 6000 files in the Inbox, `MOCK_INTERVAL_MS=0`, fresh mock per run). before = `main` at
  `cf85c2b` (a detached worktree, with the fixed script); after = this branch.

  | Metric | before (main) | after, working | after, `MOCK_MERGE_NOISE=0` | after, `SCOPE=review` (noise) |
  |---|---|---|---|---|
  | FCP / ready (ms) | 68 / 934 | 76 / 1044 | 72 / 925 | 80 / 977 |
  | `j` per press p50 / p95 / max (ms) | 33.3 / 34.1 / 123 | 33.3 / 34.0 / 37 | 33.3 / 34.1 / 118 | 33.2 / 35.5 / 38 |
  | scroll: list height, frames > 50 ms, max frame (ms) | 156900 px, 0, 19.9 | 156900 px, 0, 20.1 | 156900 px, 0, 19.9 | 158980 px, 0, 20.3 |
  | rows mounted after scrolling 6000 files | 46 | 46 | 46 | 45 |
  | `J` worktree switch p50 / p95 (ms) | 33 / 36 | 34 / 36 | 34 / 36 | 34 / 37 |
  | live refresh mutate→idle p50 / p95 (ms) | 85.7 / 191.8 | 186.8 / 192.4 | 88.2 / 191.7 | 188.5 / 195.3 |
  | page errors | 0 | 0 | 0 | 0 |

  The list stays virtualised (≈46 mounted rows of 6000, no frame over 50 ms). The one difference is the live-refresh
  p50 (86 vs 187 ms) in the runs where the mock serves merge noise; it is **not** a UI cost: the same build gives 88
  ms with `MOCK_MERGE_NOISE=0`, a network trace of three edits shows the identical request sequence and timings in both
  (`/api/projects`, then `files?scope=working`, ~75 ms apart), and in-process the mock's `listProjects` costs 57 vs 64
  ms. The script reads the first idle state of the refresh indicator, which falls into the gap between those two
  requests or not; I did not pin down why the noise data moves it. Treat that row as a script artifact, not a
  regression. **Script fix**: with the large dataset's mixed files in All on branch (the app's default scope) the old
  wait returned on the first scope's `ready` viewer and measured an empty list; it now waits for the chosen scope's
  list (this is why the "before" column was re-measured with the fixed script; the first, unfixed baseline was 971 ms
  ready and 87.3 / 189.1 ms refresh, the same picture).
- **Screenshots / visual check.** `preview:mock` + `pnpm --filter @octopus-diff/web shots` with `STATES=merge-noise,
  merge-noise-open,merge-noise-chip` (themes octopus-dark and octopus-light, 1440x900 and 960x700; written to
  `/tmp/wmn-shots`, not committed) and looked at: collapsed group, expanded dimmed rows with via tags, `+main` tag, both
  chips, the chip-on list. The repository's README screenshots (`docs/screenshots/*`) come from
  `pnpm --filter @octopus-diff/e2e screenshots` against fixture repositories that have no merge noise, and none of what
  they show changed (no chip, no group row without origins), so by the convention of `docs/reports/ux-*.md` /
  `copy-tools.md` they were **not regenerated**. Once #35 adds a merge-noise e2e fixture, a screenshot of the group
  belongs in that script.

## Decisions

#205 (wrapped not hidden, one predicate, transient per-worktree expansion, tree layout), #206 (chip, `m`, counts), #207
(the mixed toggle is the scope switch with a way back), #208 (mock, perf, shots). #201-#204 are the daemon branch's.

## Contract changes

None (reads the optional fields #198 added). No `TEST_IDS` added: the new test ids (`from-main-group`,
`from-main-chip`, `branch-only-toggle`, `origin-tag`) are exported from `components/OriginGroupHeader.tsx`
(`ORIGIN_TEST_IDS`) for #35's e2e; moving them into the contracts would be an additive `contracts:` commit if wanted.

## Dependencies

None added or removed (`pnpm credits:check` passes inside `pnpm lint`).

## Known gaps

- **Tree layout**: the base files are not at the end of the tree and cannot be dimmed (`@pierre/trees`); they join the
  tree in tree order, tagged, when the bar is expanded. j/k stay consistent with what the tree shows.
- **Not run against the real daemon.** The daemon branch (PR #66) is unmerged; everything here is verified against the
  mock, which follows its semantics, and the old-daemon path against `main`'s daemon in e2e. #35 owns the e2e with real
  merge noise.
- An Inbox entry whose only unreviewed files are base (kept by #204) shows `0 files` in its header and the collapsed
  group under it.
- With the chip on, an own file that was selected stays selected (and open in the diff) although it is no longer
  listed; `j`/`k` step from its position.
- The chip's `N` is the base files of the groups on screen (after the Inbox sidebar filters and the eye), and its label
  says `main` when the groups name different refs.
- The group's expansion is not remembered across reloads (by design, DECISIONS #205).
- The live-refresh reading in the perf script is noisy (see above).

## Notes for integration

- Merging with the daemon branch: no code overlap (web only). The web needs nothing new from the daemon: `origin` /
  `originVia` on files, `baseFiles` / `unreviewedOwnFiles` / `integrationRef` on `summary.review`. `integrationRef` is
  used verbatim in the group label (`origin/main`) and without the `origin/` prefix in the chip.
- DECISIONS numbers: this branch uses #205-#208 after the daemon branch's #201-#204; renumber if either lands in a
  different order.
- #35 (e2e/bench): selectors are `[data-testid="from-main-group"]` (`aria-expanded`, `data-count`, `data-worktree-id`),
  `from-main-chip` (`aria-pressed`, `data-count`), `branch-only-toggle`, `origin-tag`, and `file-item[data-origin]` /
  `[data-origin-via]` on rows (absent for own files).
