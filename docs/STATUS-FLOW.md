# Status flow v2: review stages and "reviewed up to" bookmarks

> Status: plan, 2026-11-09, agreed with the user in the "Lets analyze status for the flow" thread
> (flow B with flow A's vocabulary, plus per-branch review bookmarks). It changes PLAN §4.1 (sidebar),
> §4.3 (review state) and §5.7. The implementing session logs each step in `docs/DECISIONS.md` and
> updates `docs/PLAN.md` to match.
>
> **Placement superseded (DECISIONS #241-#244, 2026-11-12):** the stages below still define each row's `stage` and
> `state`, but the sidebar no longer places rows "under their project" or in a "shelf": it is one flat list by last
> activity, and only a row hidden by hand sits in the closed Hidden section. Reviewed, merged/closed and review-off
> rows stay in the list; a row that needs no review gets no special state.

## 1. Problems this fixes

1. **Status depends on the toolbar scope.** The sidebar counts come from `/api/inbox?scope=<global scope>`
   (`apps/web/src/lib/model.ts` `buildSidebar`, `autoRowState`). Switching Working tree → Branch moves
   rows between their project and the Settled shelf.
2. **Committing settles a worktree unseen.** In the Working tree scope, an agent that commits leaves 0 changed
   files, so the row auto-settles as `clean` with unreviewed commits on it. An agent that merges its worktree
   into `main` makes the Branch scope empty too (merge-base = HEAD), and `main` is "clean" as well: both rows
   settle and the work is visible only through Commit…, one commit at a time.
3. **Review marks are keyed by scope kind** (`reviewed(project_id, scope_kind, path, patch_hash)`), so a
   file reviewed under Working tree is unreviewed again under Branch.
4. **Three words for one act**: "Mark reviewed" (diff pane), "Verify N" / "Mark N visible as verified"
   (`MarkAllButton.tsx`), and `verified` on settled rows (`settledWord`).
5. **Settle is a fake "done"**: a per-device hide held by `stateHash`. It writes no review marks, so when
   the row comes back everything is unreviewed again.
6. **The activity pulse** (`.od-pulse`, `isRecentlyActive`, `useClock` in `Sidebar.tsx`) is time-based
   (~10 s): it says something changed, not what changed or what to do.
7. **Forge data is display-only.** A merged or closed PR does not affect where a row sits.
8. **"Scope: Working tree" tells you little**: no base, no counts.

## 2. The model

### 2.1 What a worktree has to review (fixed; the toolbar never changes it)

```
to review = commits after the branch's bookmark   (committed work)
          + unreviewed uncommitted files           (working tree + index vs HEAD)
```

A **bookmark** ("reviewed up to") is the last commit on a branch that the user has reviewed through. One
per `(project, branch)`, stored in the daemon's SQLite (app state; the repos stay read-only).

- First sight of a branch: the default branch's bookmark starts at its current HEAD; any other branch's
  starts at its merge-base with the default branch. Adding a project never floods the user with history.
- Detached HEAD: keyed by worktree id instead of branch, initialised to HEAD.
- `cursor..HEAD` = new commits. If the bookmark is not an ancestor of HEAD (rebase, reset, force), the
  state is `historyRewritten` and the range falls back to merge-base(default branch)..HEAD, with
  already-reviewed content skipped (§2.4).

### 2.2 Stages (replace `RowState` / `settledWord`)

| Stage | Rule | Row says | Sits |
|---|---|---|---|
| **Blocked** | conflict or an operation in progress | `1 conflict` / `rebasing` | under its project |
| **To review** | new commits after the bookmark **or** unreviewed files | `2 commits · 3 files` | under its project, pill |
| **Reviewed** | nothing new; no PR, or a draft PR | `reviewed` | under its project, quiet |
| **In PR** | nothing new; open PR | `#42 · checks ✓` / `changes requested` | under its project |
| **Merged / closed** | forge says merged/closed, `headSha` matches, nothing uncommitted | `merged` / `closed` | shelf, automatic |
| **Hidden** | "Hide until it changes" (today's settle, renamed) | its last word | shelf |
| (unchanged) | review off / missing / error | as today | shelf |

The key rule: **a row reaches the shelf only once its review is empty** (or it is hidden, review off,
missing, failed, or merged/closed with nothing left). A commit or a merge moves work into a bookmark range;
it never settles it. "Reviewed" rows stay under their project (quiet), unlike today's `verified`, which went
to the shelf. (Open question for the implementer, pick the simplest and log it: whether Reviewed with no
PR sits in the shelf after the session or stays; default **shelf**, so density is still earned.)

Merged but with uncommitted work left: stays out, says `merged · 2 files`.

### 2.3 The diff pane and toolbar

The scope select becomes a filter with live counts and never moves rows:

```
[ To review (5) ] [ All on branch (12) ] [ Uncommitted (3) ] [ Commit… ]
```

- **To review** (new default; replaces pref `defaultScope: 'working'`): the commits after the bookmark as
  one range diff, then the unreviewed uncommitted files, with small section headers.
- **All on branch**: working tree vs the integration base of the default branch (committed + uncommitted):
  the newest default-branch commit HEAD has absorbed, from local `main` or `origin/main` (DECISIONS #196), so
  a `fetch` + `merge origin/main` does not turn other people's files into the branch's own change.
- **Uncommitted**: today's Working tree. Staged / Unstaged move into a secondary menu or stay as options.
- **Commit…**: as today.
- One verb: **Reviewed**. `r` toggles a file; **Review all (`⇧R`)** marks everything shown reviewed and,
  in To review, moves the bookmark to HEAD. The undo toast stays (undo restores the bookmark too).

### 2.4 Not reviewing the same work twice

- Review marks stop depending on the scope kind: a mark is keyed by `(project, path, patchHash)` for the
  uncommitted part, and reviewed commits are recorded by sha **and** `git patch-id --stable`.
- When the agent commits files the user already reviewed uncommitted, the matching per-file patches in the
  new range show as reviewed (same patch hash). Only the rest needs review.
- When work arrives on `main` by fast-forward or merge, commits already reviewed (same sha) are skipped; with
  squash or rebase merges, commits whose patch-id was reviewed are skipped. What remains: merge-commit
  resolutions and commits never seen.

### 2.4a Merge noise: own, mixed, base (#31-#34)

Files of the To review list that came from the default branch are tagged, not hidden. git-core's
`readFileOrigins` (#32, DECISIONS #198-#200) classifies each listed file: **base** (the default branch's change:
merged, rebased, fast-forwarded, or the branch's version equals the newest default-branch version: cherry-picks,
squash-landed work), **mixed** (own changes and the default branch changed it too: shown with the combined patch,
"only this branch's changes" is the file against `N`) or **own** (everything else, and every uncommitted change
except what a merge or cherry-pick of a default-branch commit staged). The default branch's own worktree and a
detached HEAD are all own (pulled work cannot be told from own work); merges of other branches are own. The
daemon attaches it (#33, DECISIONS #201-#204: `ChangedFile.origin` in To review, All on branch and Uncommitted;
`WorktreeReview.baseFiles` / `unreviewedOwnFiles` / `integrationRef`) and the web collapses base files into a "From
origin/main" group (#34). All on branch is measured from `N`, so there a file both sides changed shows only this
branch's patch and is own; only "same as main" and in-progress files are base. The default branch's commits that a
merge or rebase brought into the range are not counted in `newCommits` and are not recorded as reviewed when the
bookmark moves (so `main` does not inherit them); their files stay unreviewed but are not counted as own work.
"Review all" never marks base files and still moves the bookmark past them.

**In the web (#34, DECISIONS #205-#207).** The group is the last row of each worktree's list, collapsed, labelled
`From origin/main - merge (N files)` (the via follows `originVia`; mixed vias drop it and each row says its own);
expanded rows are dimmed and tagged. Collapsed, it is skipped by `j`/`k`/`n`. The chip `From main (N)` (`m`) lists
only those files. Counts (row counts, scope counts, "Review N shown", title) are own + mixed; the sidebar prefers
`unreviewedOwnFiles`. A mixed row has a `+main` tag and the header's "Only this branch's changes" switches to All on
branch.

### 2.5 Forge

Uses existing `WorktreeForge` data (`changeRequest.state`, `headSha`, `sync`, `review`, `checks`):
- open PR → **In PR** with one chip (checks state or `changes requested`); never overrides To review.
- merged/closed and `headSha` is HEAD (or `sync: same`) and nothing uncommitted → **Merged/closed**, shelf.
  Unreviewed commits it carried are still counted on the target branch's bookmark (they show on `main`).
- forges off / no data → those two stages simply never apply.

### 2.6 Removed

The pulse (`.od-pulse`, `@keyframes od-pulse`, `isRecentlyActive`, `useClock` and the row indent kept for
it), "verify/verified" wording, the global scope driving the sidebar, settle as "done".

## 3. Contracts (additive only; one `contracts:` commit per step)

- `DiffScope` kind `range` `{ from: sha, to: sha }` and kind `review` (bookmark..HEAD + uncommitted) or
  a `branch` option `includeWorking` — the implementer picks one and logs it. Old kinds keep their meaning.
- `WorktreeSummary` (optional): `review: { bookmark: sha | null, newCommits: number, unreviewedFiles:
  number, historyRewritten: boolean }`.
- Route `PUT /api/review/bookmark { worktreeId, to: sha }` (+ undo through the existing bulk-undo path if
  it fits), event `review.bookmark`.
- No field renamed or removed; the web keeps working against older daemons (absent = today's behaviour).

## 4. Build order (each step: own commits, green `pnpm check`, e2e for touched flows)

1. **Web only: stages, vocabulary, pulse.** Sidebar status no longer reads the toolbar scope: compute it
   from a fixed scope (`branch` + working until step 2 lands; the inbox query for the sidebar is separate
   from the diff pane's). One word "Reviewed"; "Settle" → "Hide until it changes"; remove the pulse.
   Toolbar scope as a filter with counts.
2. **Bookmarks.** Daemon table + store, git-core range scope and `rev-list --count` for new commits,
   summary field, route, event; web To review view and Review all moving the bookmark. Watcher already sees
   HEAD moves via `stateHash`.
3. **No double review.** Scope-independent marks (migration from `scope_kind` keys, keep old rows readable),
   reviewed-commit set with sha + patch-id (git-core: `patch-id` through the runner; it reads a patch on
   stdin, so the runner needs a read-only stdin pipe — allowlist it explicitly), skip on merges/squashes.
4. **Forge stages.** In PR and Merged/closed from existing forge data.

## 5. Acceptance (add to PLAN §8)

1. Switching the toolbar scope never moves a sidebar row.
2. An agent commits in a worktree: the row shows `N commits` and stays out of the shelf until reviewed.
3. An agent merges a reviewed branch into `main` (ff, merge commit, squash): `main` shows only content not yet
   reviewed; the branch row moves to the shelf as `merged` when the forge says so.
4. Reset/rebase: `history rewritten`, nothing previously reviewed is shown as unreviewed.
5. "Hide until it changes" returns the row on the next commit or edit.
6. No pulse; no "verify"/"verified" strings in the UI.
7. Restart the daemon: bookmarks and marks survive. Read-only proof tests still pass.
