# copy-tools report

Branch `feat/copy-tools`, from `main` at `1561c3c` (status flow v2 merged). Plan: `docs/COPY-TOOLS.md`.
Decisions: `docs/DECISIONS.md` #101–#111 ("Copy tools" section). Web only. No daemon request, git call or
contract change was added.

## Shipped

- **Foundation** (`apps/web/src/lib`):
  - `copy.ts` `copyText`: the async Clipboard API, then a hidden `<textarea>` + `execCommand('copy')` where
    `navigator.clipboard` is missing (plain-http LAN). It never throws.
  - `copyFormat.ts` (pure): file / branch / sha texts, `fenceFor`, `inlineCode`, `languageForPath`, `diffLines` /
    `selectedDiffLines`, `scopeCopyLabel` and `buildSelectionCopy` (the §5 Markdown).
  - `scopeLabels.ts`: the toolbar's scope names, shared with the copy headers.
  - `selectionPosition.ts`: where the Copy bar goes.
  - Every copied text goes through `escapeSuspicious`.
- **Feedback** (`components/CopyButton.tsx`): `useCopyFeedback` and `CopyButton` (ghost icon that turns into a
  check), plus `CopyToastHost`. The toast is "Copied …" above the button or menu that copied, or "Failed to copy:
  the clipboard is not available here". `state/copy.ts` `copyAndReport` is the non-hook version used by menus,
  the palette and commands.
- **Names and paths** (shared item builders in `components/copyMenu.ts`, test ids in `COPY_TEST_IDS`):
  - Sidebar worktree menu: a "Copy" group (branch name, disabled with "Detached HEAD"; worktree path; commit id).
  - Overview worktree rows and Inbox group headers: the same group, on right-click.
  - File rows in the list and the tree (`@pierre/trees` `renderContextMenu`): path / old path / file name /
    absolute path.
  - Diff header: a copy-path button and a `⋯` menu (also on right-click) with the file items, "Copy file diff
    (patch)" and the worktree group.
  - Toolbar: a copy button for the selected commit (commit scope).
  - Palette: Copy branch name / worktree path / file path / file name / absolute file path, listed only with an
    open worktree or a selected file.
- **Code selection** (`components/diff/DiffRenderer.tsx`, `CopySelectionBar.tsx`): press on a line number (or
  the gutter "+") and drag. A bar appears where the pointer was released, with `N lines`, **Copy**, **Copy as
  Markdown** and a close button.
  - The bar never takes focus. Esc clears; on scroll the bar docks in the corner.
  - Ctrl/⌘ C with a line selection and no text selection copies the plain code.
  - A new patch (`cacheKey`) or another file drops the selection; a refresh with the same hash keeps it.
  - Placeholders and the raw `<pre>` fallback have no line selection.
- **Docs**:
  - PLAN §4.2 "Copy" paragraph, §8 items 19–23.
  - README feature line, with `docs/screenshots/copy-selection-{light,dark}.png` written by a new
    `e2e/support/copy-screenshots.ts`.
  - A help dialog / Settings → Keyboard row for `Ctrl/⌘ C`.

## Verification

All on this machine, 2026-11-09, at `e32e600`, except where noted.

- `pnpm lint`: clean (Biome, 396 files; credits up to date).
- `pnpm typecheck`: clean.
- `pnpm check`: green on the final tree. Counts: contracts 83, forge 94 (+4 skipped), git-core 170,
  fixtures 48, web **209** (was 175: +34 in `test/copy.test.ts`), daemon 187, e2e-unit 5, cli 139.
  - Across this round it also failed 5 of 9 runs, always on one git-core test: `test/readonly.test.ts` "never
    writes to any repository" times out at 5 s under parallel load.
  - The same failure shows on `main` (`1561c3c`): 1 of 3 `pnpm test` runs.
  - The test takes ~2.4 s alone, and the same ~2.5 s with or without this branch's web suite running next to it
    (DECISIONS #111).
- `pnpm test:e2e`: **83 passed** (3.3 min), read-only proof 0 violations (12 control repos).
  - 74 existing tests plus 9 in `e2e/tests/16-copy.spec.ts` (15 was the last used number; 14 is the forge spec).
  - Re-run after the last web change; see "Final run" below.
- `e2e/tests/16-copy.spec.ts` covers:
  - The worktree menu: branch, path, commit id. Detached HEAD has "Copy branch name" disabled.
  - The file row menu, the header button and the `⋯` menu, including the file diff.
  - The palette commands.
  - The textarea fallback with `navigator.clipboard` removed (read back from a second page).
  - Selecting two lines, then Copy as Markdown (exact §5 text against the file on disk), Copy, Ctrl+C. Focus
    stays out of the bar, and Esc clears.
  - A split-mode old-side range, which gives a `diff` fence.
  - The selection clearing on a file change.
  - A text drag after a line selection, which copies only the code text.
- Checked by hand in screenshots (light and dark): the bar, the header menu and the tree menu (it copies and
  shows the toast).

### Final run

At `e32e600` plus this report (no code change after):

- `pnpm check`: exit 0. Counts: contracts 83, forge 94 (+4 skipped), git-core 170, fixtures 48, web 209,
  daemon 187, e2e-unit 5, cli 139.
- `pnpm test:e2e`: exit 0, **83 passed** in 3.3 min (199 s wall), read-only proof 0 violations (12 control repos,
  4909 lock polls).

## Decisions

- **#101:** the foundation. A new copy toast, not the bulk toast.
- **#102:** differences from the plan:
  - The scope words are the toolbar's (`to review`, `uncommitted`, `all on branch vs \`main\``…).
  - A rename names its old path in the header.
  - A deleted-only range is labelled `old L…`.
  - In split mode a range in one column keeps that column's lines.
  - No contracts change.
- **#103 / #104:** where each copy item lives in the merged UI.
  - The hover card has no copy button: it is `pointer-events: none`.
  - "Copy commit id" copies the full id.
  - Palette copy commands are hidden without a selection.
- **#105:** the ContextMenu now takes `title`, and an inline `onClose` is safe. The file list's menu sits outside
  the listbox.
- **#106:** the spike.
  - `side` / `endSide` are correct in split and unified.
  - A native text copy has no gutter numbers or markers.
  - A shadow-root text selection shows as `isCollapsed: true` with a non-empty `toString()`.
  - The last gesture wins.
- **#107:** the selection state and the bar.
- **#108:** the gutter button stays the library's "+". A custom copy glyph did not render within the time box.
- **#109:** polish done and not done.
- **#110:** the PLAN change.
- **#111:** the git-core flake.

## Contract changes

None. New elements use plain `data-testid`s (`copy-*`, `diff-header-menu`, `file-list-menu`, `file-tree-menu`,
`overview-worktree-row`).

## Dependencies

None added or removed. `scripts/credits/acknowledgements.json` gained the T3 Code `adapted` files: `lib/copy.ts`,
`lib/copyFormat.ts`, `components/CopyButton.tsx` and `lib/selectionPosition.ts`. `pnpm credits` was run, and
`CREDITS.md` + `apps/web/src/generated/credits.json` are committed with them.

## Known gaps

- **No Settings → copy toggles** (Markdown header without the worktree path; absolute vs relative path in
  Markdown). The §5 format is fixed (#109).
- **The gutter button is a "+"** (T3's comment glyph), not a copy glyph (#108).
- **Other README screenshots are older.** They were not regenerated: the shared `e2e/scripts/screenshots.ts` is
  WS4's. The diff header in them lacks the new copy-path and `⋯` buttons.
- **The Copy bar can cover the lines below the selection.** It sits where the pointer was released, like T3. It
  docks to the corner on scroll.
- **The sidebar hover card has no copy button** (#104).
- **No e2e for the tree view's menu.** It renders in the trees shadow DOM. It was checked by hand with
  `copy-screenshots.ts --extra`.
- **The git-core read-only test flake** (#111) is pre-existing and needs WS1.

## Notes for integration

- Fast-forward `feat/copy-tools` onto `main`; `main` had not moved from `1561c3c` when this report was written.
- `DECISIONS.md`: this round appends #101–#111 in its own section after "Status flow v2". On a conflict, keep both
  sections and renumber this one.
- `CREDITS.md` / `credits.json`: regenerate with `pnpm credits` if the lockfile or acknowledgements moved
  meanwhile.
- `pnpm check` may fail on the git-core read-only test under load (#111). Re-run it, or apply the proposed timeout
  in git-core.
- The new e2e spec relies on the `live` and `beta-detached` fixtures and on Playwright clipboard permissions
  (`test.use({ permissions })`).
- `useContextMenu` / `ContextMenu` behaviour changed slightly (#105). Its other users (sidebar) were re-run in
  e2e.
