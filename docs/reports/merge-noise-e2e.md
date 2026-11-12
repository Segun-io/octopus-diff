# merge-noise-e2e report

Roadmap #35 "e2e: merge-noise spec and bench" (step 14 of #24, the last step of milestone M2). Branch
`test/merge-noise-e2e`, from `main` at `62e98ae` (PRs #66 and #67 merged). No DECISIONS entry: no new budget, no
contract change, nothing outside `e2e/`, `tools/fixtures/` and `docs/`.

## Shipped

- **Fixtures** (`tools/fixtures/src/merge-noise.ts`, exported from the package; opt-in, `generateFixtures()` and its
  manifests are untouched, so no other spec or bench changed a count).
  - `generateMergeNoise()`: two projects under a fresh temp root with the isolated git config, built in two stages
    because the daemon starts a worktree's review bookmark where the branch is *at first sight* (a feature that already
    merged `main` would start with nothing to wrap): stage 1 creates repos and feature worktrees at the base commit
    (register and let the daemon see them), then `commitOwnWork()` and `integrate()` (main moves, features take it),
    `fetchMovesOrigin()` later.
    - `noise-local` (no remote, default branch = local `main`): `merge` (clean merge, 2 own files, 5 base), `conflict`
      (conflict in `src/conflict.txt`, resolved by hand: 1 own, 1 mixed, 4 base), `mixed` (git auto-merges a file both
      sides changed: 1 own, 1 mixed, 4 base), `pick` (`git cherry-pick` of main's hotfix commit: 1 own, 1 base
      `same-as-base`), and the `main` checkout (3 commits, 5 own files since first sight).
    - `noise-remote`: `origin` is a bare repository filled by clone / push / fetch (no network), the local `main` stays
      at the base commit: `rebase` (own commit rebased onto `origin/main`: 2 base via `rebase`, `origin/main`),
      `fix` (own `src/fix.txt`; `fetchMovesOrigin()` lands the same content on `origin/main` and fetches: the file turns
      from own to base `same-as-base`).
    - `MERGE_NOISE_EXPECTED`, `MERGE_NOISE_AFTER_FETCH`, `MERGE_NOISE_OWN_COUNTS`: the expected labels and counts
      (checked against the real daemon before the spec was written; fixed dates, same shas every run).
  - `addBenchOrigins()` (bench): a bare `origin` per bench repo, one own commit per linked worktree, `origin/main`
    merged into the linked worktrees (stale local `main`), `fetchMovesOrigin(round)` moves `origin/main` in every
    repository (round 2 also lands each worktree's own file upstream so every worktree has one real relabel).
  - `tools/fixtures/test/merge-noise.test.ts` (+2 tests): scenario shapes (merge commits, linear cherry-pick, stale
    main, no markers) and the bench origins (the plain bench layout still has no remote).
- **Spec** `e2e/tests/19-merge-noise.spec.ts` (8 tests, ~1.5 s each; own daemon per test with only the two noise
  projects, so the tab title count is exactly theirs; real daemon, web and git; no sleeps, only `expect.poll` /
  auto-retrying assertions):
  1. merge of main: own files first, then the collapsed group `From main - merge (5 files)` (`aria-expanded=false`,
     `data-count=5`), expanding: dimmed (`opacity-60`) rows with `data-origin=base`, `data-origin-via=merge` and an
     `origin-tag` `merge`; collapse again.
  2. `j`/`k` stop at the last own row; `n` (global across worktrees) walks the whole ring (19 presses) and never
     selects a `data-origin=base` row; expanded, `j` enters the group.
  3. chip `From main (5)`: on lists only the 5 base files (no group row, 5 tags), `m` toggles both ways.
  4. counts: before the merge the rows are 2/2/2/1 and the title `(10)`; after main moves and the merges / cherry-pick /
     rebase the feature rows are unchanged, the title is `(15)` (not the 15 + 16 merge-brought files), the pill, the
     `To review (2)` scope option, the group count, the favicon dot, and the Inbox "Review all" count (15).
  5. resolved conflict and mixed file: `+main` tag, own row (no dimming), group `From main - merge (4 files)`; the
     "Only this branch's changes" toggle switches to All on branch where the file is plain own, no group, no tag; the
     second click returns to To review.
  6. cherry-pick `From main - same as main (1 file)` and tag `same as main`; rebase `From origin/main - rebase (2
     files)` with chip `From main (2)`; the stale local `main` worktree has nothing to review.
  7. Review all: the button says 2 collapsed or expanded; after it: row reviewed, group gone, list empty, summary
     `newCommits 0 / unreviewedFiles 0 / baseFiles 0`, own files marked (All on branch), and the `main` worktree is
     untouched: 5 files unreviewed (marks are per project and patch, so a marked base file would show reviewed), 3
     new commits, stage `review`.
  8. `git fetch` moves `origin/main`: the open worktree's list relabels **live** (no reload): `fix.txt` goes from own
     to the group `From origin/main - same as main (1 file)`, the row pill 2 → 1, scope `To review (1)`; the rebase
     worktree keeps its labels.
- **Bench** (`e2e/bench/bench.ts`): `--after-fetch` (small layout) and a control `--to-review`. See Verification and
  `docs/bench/results-after-fetch.{json,md}`; `docs/bench/README.md` documents both.

## Verification

Machine: 12-core WSL2 (Ryzen 7 7800X3D), Node 26.13, git 2.53.0.

- `pnpm check`: **exit 0**. contracts 93, forge 101 (+5 skipped), git-core 254, **fixtures 57** (was 55; +2), web 284,
  daemon 284 (+1 skipped), e2e unit 5, cli 139, scripts 34. lint (incl. `credits:check`), typecheck and build green.
- `pnpm --filter @octopus-diff/e2e exec playwright test tests/19-merge-noise.spec.ts`, 10 times in a loop: see the
  "Final runs" section at the end of this file.
- **Mutation checks** (each reverted, web / daemon dist rebuilt afterwards): `n` ignoring the group's visibility fails
  the keyboard test; the sidebar counting `unreviewedFiles` instead of `unreviewedOwnFiles` fails the counts test and
  the live-fetch test; the daemon's bulk review marking base files fails the Review all test (`data-unreviewed` 7
  instead of 2).
- **Bench** (30 repos × 3 worktrees = 90, `docs/bench/`; all budgets PASS in all three, exit 0). Same machine,
  back to back. before = `pnpm … bench` (plain layout, fresh profile opens on All on branch); control = `--to-review`
  (plain layout, UI opens on To review); after = `--after-fetch` (UI on To review, `origin/main` moved by a fetch in
  every repo before the daemon started, 60 linked worktrees with merge noise):

  | Metric | before | control | after fetch |
  |---|---|---|---|
  | Startup git spawns (per worktree; budget ≤ 8) | 414 (4.6) | 415 (4.6) | 472 (5.2) |
  | of which `config` | 53 | 54 | 111 (a remote makes the per-project config read twice as common) |
  | Daemon listening / all summaries | 731 / 900 ms | 771 / 951 ms | 739 / 970 ms |
  | First paint cold (budget 3000) / warm median (budget 300) | 145 / 73 ms | 149 / 88 ms | 145 / 106 ms |
  | UI spawns cold paint / warm reloads | 30 / 12, 21, 0 | 21 / 27, 24, 2 | 31 / 69, 68, 71 |
  | Time until every worktree's labels are known (from cold paint start) | n/a | n/a | **1889 ms** (90 worktrees; 60 with base files) |
  | Idle CPU average | 0.35 % | 0.25 % | 0.38 % |
  | Edit → SSE p95 / → UI p95 | 21 / 45 ms | 29 / 63 ms | 33 / 93 ms |
  | Daemon RSS end / peak | 130 / 130 MiB | 127 / 143 MiB | 162 / 162 MiB |

  Live fetch (second fetch while the daemon and the UI run: every worktree's labels invalid at once): the To review
  inbox shows the new labels in **60/60** worktrees after **1067 ms**; 647 git spawns (7.2 per worktree): `diff` 183,
  `status` 182, `merge-base` 140, `config` 61, `diff-tree` 60, `worktree` 21. The label work itself is `merge-base` +
  `diff-tree` = 200 spawns = 3.3 per linked worktree (matching the daemon report's "about 3"); `status` and `diff`
  are the summary refreshes the moved ref triggers in every worktree (pre-existing behaviour, not labelling). RSS
  went 133 → 162 MiB.

  Reading it: startup stays within budget (5.2 spawns per worktree), the cold paint does not wait for the labels (145
  ms) and every worktree's labels are known 1.9 s after the paint starts; a relabel of all 90 worktrees after a fetch
  takes about 1 s here. Two numbers I did not explain: `config` startup spawns doubled (53 → 111) and the warm
  reloads of the after-fetch run spawn 68-71 git processes each against 0-27 in the other runs (wall time still
  106 ms, within budget). Both come with a remote being present; I did not trace them (daemon territory, report
  only).

## Decisions

None needed (no new budget; the fetch figures are report-only). The `--to-review` flag and `--after-fetch` flag are
bench-only.

## Contract changes

None.

## Dependencies

None added or removed.

## Known gaps

- Two bench observations with a remote present are reported, not judged or explained: startup `config` spawns 53 →
  111 and 68-71 spawns per warm reload (plain: 0-27). Wall times are within budget. Worth a look by whoever owns the
  daemon's per-project git metadata (#29).
- `n` is global by design (wraps through every worktree), so the keyboard test proves "never lands in a group" by
  walking the whole ring and checking `data-origin`, not by staying in one worktree.
- The bench measures labels by polling `/api/projects` (`review.baseFiles` present on every worktree) and the To
  review inbox; it does not measure what the user *sees* late (see above).
- The test fixture daemons use `register: 'none'` and add the two projects, so the spec does not depend on the shared
  fixture projects' counts.

## Notes for integration

- Test ids used by the spec are literal strings in the spec (`ORIGIN` constant) because `ORIGIN_TEST_IDS` lives in
  `apps/web`; moving them into `TEST_IDS` (contracts) would be an additive `contracts:` commit.
- Dist rebuilt: `pnpm build` is needed before `pnpm test:e2e` and the bench (as before); `tools/fixtures` changed.
- README screenshots were not regenerated; a screenshot of the group could now be added to
  `e2e/scripts/screenshots.ts` using `generateMergeNoise()` (not done).

## Final runs

- New spec, 10 consecutive runs (`playwright test tests/19-merge-noise.spec.ts`): **10/10 passed, 8 tests each (80/80)**,
  15-18 s per run, exit 0.
- Full `pnpm test:e2e`: **98 passed, 1 failed** (3.2 min), exit 1. The failure is the known flaky
  `16-copy.spec.ts:226` (documented in the task); `16-copy.spec.ts` run alone right after: 9/9 passed. Read-only proof:
  **12 control repos, 4779 lock polls, 0 violations** (it covers the new spec's reads only for the shared fixtures; the
  noise projects are their own temp repos). No shutdown hang (BLOCKERS Open 2 did not trigger). The log shows the usual
  `git-core has been disposed` request errors between specs.
- `pnpm check`: exit 0 (numbers above).
- Not done: Windows/macOS runs; CI (no push); README screenshots (see Notes).
