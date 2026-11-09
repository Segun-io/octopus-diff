# Chrome hierarchy: the context bar and the pane headers (design)

> Lead, 2026-11-09, branch `ux/toolbar-hierarchy`, on `main` at `90c7cff`. Brief from the user: the controls
> above the file list and the diff are "too dense, there is little context and hierarchy into which belongs to
> which"; rearrange them, taking the Request (PR) tab into account. Decisions #116–#122 in `docs/DECISIONS.md`.

## 1. What was there

One 36 px toolbar spanned the file list and the diff pane and mixed four levels of concern in identical 24 px
bordered buttons, in this order:

```
[Changes | PR #100] | Show [To review (0) ▾] | Split  Hide whitespace  Show reviewed  Review on  PR #100 · open ↗  Tree view        Live ☾ ?
 worktree view        list filter               diff   diff             list           worktree   worktree           list             app
```

Below it, two more header rows: `1 file  0 unreviewed … ✓ Review 0` over the list, and
`U docs/DESKTOP.md ⧉ Untracked +255 octopus-diff main … ⋯ More context Expand all ✓ Reviewed` over the diff.

The problems, named:

- **No spatial mapping.** Controls that change the *list* (scope, show reviewed, tree view) and controls that
  change the *diff* (split, whitespace) sat in one row that belonged to neither pane.
- **Nothing said where you are.** The worktree (project, branch) appeared only as 11 px muted text in the diff
  header, repeated per file; the Inbox said nothing at all.
- **Equal weight everywhere.** A policy menu used twice a month (`Review on`), a rendering toggle used every
  minute (`Split`) and the primary verb (`Reviewed`) all wore the same bordered button.
- **Navigation looked like a setting.** The `Changes | PR #100` view switch had the same look and row as the
  option toggles beside it.
- **Redundancy.** `0 unreviewed` next to `To review (0)`; `PR #100` in the tab and again in the link beside it;
  the worktree named in the diff header while the sidebar row is selected.

## 2. Principles (from `docs/design/IDENTITY.md`, applied to chrome)

1. **A control sits over what it changes.** List controls over the list, diff controls over the diff; what is
   about the worktree sits above both.
2. **Three tiers, one row each.** Where you are (the context bar), what each pane shows (the pane headers), the
   content. Nothing else between the sidebar and the diff.
3. **Weight says what matters.** The primary verb is the one bordered, filled control in its row; toggles are
   ghost icons with a soft fill when pressed; facts are 11 px muted text set apart by space.
4. **State is a word.** `Review on`, `Live`, `open` stay words; a dot is never the only signal.
5. **T3 Code is the interaction reference** (`~/contrib/t3code`, `DiffPanel.tsx` header row): a scope control at
   the left of the diff header, icon toggles with tooltips at the right, a segmented pair for the layout.

## 3. The three tiers

```
┌ sidebar ┬─ context bar (spans both panes) ───────────────────────────────────────────────────────────┐
│         │ octopus-api  feat/auth  t3  ↑4 ↓0   [Changes | ⎇ PR #100]   ⎇ open ↗   Review on        Live ☾ ? │
│         ├─ file pane header ───────────────────┬─ diff header ───────────────────────────────────────────┤
│         │ [To review (17) ▾]      👁 ⊞  ✓ Review 17 │ M src/both.ts ⧉ Modified +2 −2     [≡|⫴] ¶ │ More context Expand all ⋯ │ ✓ Reviewed │
│         ├──────────────────────────────────────┼─────────────────────────────────────────────────────────┤
│         │ file rows                            │ the diff                                                 │
```

### 3.1 Context bar (`components/ContextBar.tsx`, `data-testid="context-bar"`)

Says where you are and which view of it is open. Identical on the Changes and Request tabs: the tabs switch
what is *below* it.

| Slot | Inbox | Worktree |
|---|---|---|
| Identity (13 px, project 500, branch mono muted; tooltip: path) | `Inbox` | `octopus-api` `feat/auth` |
| Facts (11 px muted, spaced) | `5 worktrees` `17 files` (what the list holds in the current scope) | chips `main` / source / in-progress, `↑4 ↓0` |
| View switch (`od-seg`, only with a matched request) | – | `[Changes \| ⎇ PR #100]` |
| Forge link (ghost, only on the Changes tab; the Request header carries it) | – | `⎇ open  changes requested ↗` (state words, no number: the tab has it) |
| Review policy (ghost when on, raised when off) | – | `Review on` |
| App chrome (right, ghost) | `Live` `☾` `?` | the same |

### 3.2 File pane header (`components/FilePaneHeader.tsx`)

One 36 px row over the list. Left: the scope `<select>` (`To review (17)`, counts per scope; the commit list and
its copy button follow when the commit scope is chosen and wrap under it). Right: `Show reviewed` (eye, pressed =
reviewed files are listed), `Tree view` (worktree view only), then `✓ Review 17`, the one bordered control.

The `17 files  17 unreviewed` line is gone: the select carries the total, the button carries the unreviewed count.

### 3.3 Diff header (`components/diff/DiffPane.tsx`)

Always rendered in the Changes view, so the rendering options have a fixed home. Left: status letter, path, copy
button, status word, `+a −d`; the worktree name only in the Inbox, where the file's worktree is not the selected
one. Right, in three groups separated by hairlines: rendering (`[unified | split]` segmented icons, whitespace
pilcrow), this file (`More context`, `Expand all` as ghost text, `⋯` copy menu), then `✓ Reviewed`.

## 4. What the tests pin, kept as is

`scopeSelect` (native select, `data-scope`), `diffModeToggle` (`data-mode`; now the segmented group, its buttons
carry `data-mode-option`), `whitespaceToggle` / `showReviewedToggle` (`aria-pressed`), `worktreeTabs` /
`worktreeTab` (`data-tab`), `changeRequestBadge` (href, target, rel, `data-number`; on the Changes tab),
`reviewPolicyChip` (`data-enabled`, `data-source`), `markAllButton`, `reviewToggle`, `refreshIndicator`,
`themeToggle`, the `Tree view` accessible name. e2e: `AppPage.setDiffMode` learns the segmented control.

## 5. Out of scope, deliberately

The Overview (folder, project) keeps its own heading and no bar, as before. The Request view's inner
`Summary | Timeline | Files` control and its header are untouched. No new preference, route or contract.
