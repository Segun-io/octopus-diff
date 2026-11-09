# Copy tools: branch, path, file and code selection

> Status: plan, 2026-11-09, agreed with the user ("Lets plan where to add copy tools"). Web-only feature
> (WS3 paths + `docs/` + credits files). No daemon, git-core or contract change, so the read-only guarantee
> (PLAN §5.5) is untouched. Start only after the status-flow rework (`docs/STATUS-FLOW.md`) is merged to
> `main`: it rewrites the sidebar rows, the toolbar scope and the file-list model that this plan hooks into.
> The implementing session logs each step in `docs/DECISIONS.md` (next free numbers) and adds the feature to
> PLAN §4.2.

## 1. Goal

Anything the reviewer reads can be copied in one gesture, in a form that pastes well into a terminal, an
issue, or an agent prompt:

1. **Names and paths:** branch name, worktree path, file path / name / absolute path, commit sha.
2. **Code:** select lines in the diff, copy them as plain text or as Markdown with where they live
   (file, line range, branch, worktree, project, scope, head sha).

## 2. State today (verified on `main` at `6c53f1a`)

- Nothing writes to the clipboard. `lib/folderPath.ts` only parses pasted paths.
- `components/ContextMenu.tsx` (`ContextMenu`, `useContextMenu`, `MenuItem`) exists; only `Sidebar.tsx` uses it
  (folder, project and worktree rows). `FileList` rows, `FileTreeView` rows and the diff header have no menu.
- Data is already in the client: `Worktree.branch` (null when detached), `Worktree.path`, `headSha`,
  `ChangedFile.path` / `oldPath` / `rawPath`, project name, `scope`.
- `DiffRenderer.tsx` renders `@pierre/diffs` 1.6.4 (`FileDiff` in a `Virtualizer`, shadow DOM). The library has
  `enableLineSelection`, `enableGutterUtility`, `renderGutterUtility`, `selectedLines`, `onLineSelectionEnd`
  and a `SelectedLineRange` (`start`, `end`, `side`, `endSide`). The patch fed to it has been through
  `escapeSuspicious` (SEC-05).
- Reference implementation: T3 Code (`~/contrib/t3code`, MIT): `apps/web/src/reviewCommentContext.ts`
  (range → lines → fenced block), `lib/selectionActions.ts` (floating action near the selection),
  `components/DiffFilePathCopyButton.tsx` and `hooks/useCopyToClipboard` (+ `anchoredCopyToast`).
  Follow it closely for look and behaviour (user preference: mimic T3 Code).

## 3. Decisions (defaults; the implementer may change one and logs why)

1. **Clipboard with fallback.** The app is also opened over the LAN (plain `http://<lan-ip>`), which is not a
   secure context: `navigator.clipboard` is undefined there. `copyText` tries the async API and falls back to
   a hidden `<textarea>` + `document.execCommand('copy')`. It returns a result; failures show an error toast.
2. **Copy what is visible, never hidden characters.** The diff is shown after `escapeSuspicious`, so a copy
   contains the visible `⟨U+…⟩` escapes, not invisible or bidirectional characters. Pasting those into an agent
   prompt is the attack SEC-05 guards against. Paths are escaped the same way when they contain such
   characters; the copy toast says "contains invisible characters, copied escaped".
3. **Plain copy** = the new-side text of the selected lines, without `+`/`-` markers. A selection of only
   deleted lines copies the old-side text.
4. **Markdown copy** = header line(s) + one fenced block (§5). A selection that includes deleted lines uses a
   `diff` fence with `+`/`-`/space markers and a hunk header; otherwise a fence in the file's language.
5. **Paths:** the header shows the repo-relative file path and the worktree's absolute path. "Copy path"
   defaults to repo-relative. For a rename, the new path is the default and the menu also offers the old one.
6. **Detached HEAD:** "Copy branch name" is disabled (tooltip "Detached HEAD"); the menu offers the short sha.
7. **No new shortcut keys in the first pass.** Everything is in menus, buttons, the floating action bar and
   the command palette. Exception: Cmd/Ctrl+C with a diff line selection active copies the plain text.

## 4. Build order (each step: own commits, green `pnpm check`, e2e for touched flows)

### Step 1: foundation (`apps/web/src/lib`, tests in `apps/web/test`)
- `lib/copy.ts`: `copyText(text): Promise<boolean>` (async API, then the textarea fallback).
- `lib/copyFormat.ts` (pure, no DOM, unit-tested):
  - `fileCopyTexts(file, worktree)` → `{ relative, name, absolute, oldRelative? }`
  - `branchCopyText(worktree)`, `shaCopyText(sha, short?)`
  - `fenceFor(contents)` (fence longer than the longest backtick run, minimum 3)
  - `languageForPath(path)` (extension → fence language; adapt T3 `inferReviewCommentFenceLanguage`)
  - `buildSelectionCopy({ fileDiff, range, meta, format })` → `{ text }` where `meta` is
    `{ project, branch|null, worktreePath, headSha, scope, filePath, oldPath? }`
  - `selectedDiffLines(fileDiff, range)` (adapt T3 `buildDiffReviewLines` / `getDiffRange`)
- Feedback: a `useCopyFeedback` hook and a small "Copied" toast / check icon, modelled on T3's
  `useCopyToClipboard` + anchored toast. Reuse the existing toast host if `BulkReviewToast.tsx`'s one can be
  generalised without changing its behaviour; otherwise add a tiny sibling.
- Attribution: every function adapted from T3 Code carries an attribution comment and an entry in
  `scripts/credits/acknowledgements.json` → `adapted` (T3 Code, MIT, `Copyright (c) 2026 T3 Tools Inc.`,
  files + what). Run `pnpm credits`; commit both outputs in the same commit.

### Step 2: names and paths in the existing surfaces
| Copy | Where |
|---|---|
| Branch name | Worktree row menu (`Sidebar.tsx` `menuItems` case `worktree`), the branch label in the diff header (`WorktreeName` in `bits.tsx`), Overview worktree rows |
| Worktree path | Same places + the `Path` line in the sidebar hover card (`Sidebar.tsx` ~l.290) |
| Commit sha | Worktree row menu and the commit scope in the toolbar |
| File path, file name, absolute path (+ old path on rename) | New context menu on `FileList.tsx` rows (use `useContextMenu`), on tree rows (`@pierre/trees` `renderContextMenu` in `FileTreeView.tsx`), and a copy button next to the path in the `DiffPane.tsx` header (like T3 `DiffFilePathCopyButton`) |

Also add palette-only commands (`state/commandRegistry.ts`, `Commands` in `state/commands.ts`): Copy branch
name, Copy worktree path, Copy file path, Copy file name, Copy absolute file path. They act on the selected
worktree / file and are disabled with no selection. Keep menu `MenuItem.testId`s stable (§7).

Note: STATUS-FLOW rewrites the sidebar row model and menu. Read the merged `Sidebar.tsx` before adding the
items; add them as a "Copy" group with a separator, below the review actions.

### Step 3: code selection in the diff (`components/diff/DiffRenderer.tsx`, new `CopySelectionBar.tsx`)
1. Turn on `enableLineSelection` and `enableGutterUtility`; hold `selectedLines` in `DiffRenderer` state;
   clear it when `cacheKey` (patch hash) changes or Esc is pressed.
2. First spike (limit 1 hour, log in DECISIONS): confirm in the browser that (a) line selection gives correct
   `side`/`endSide`/numbers for split and unified modes, (b) plain mouse text selection + Ctrl+C inside the
   shadow DOM does not copy gutter numbers or markers. If (b) copies junk, intercept `copy` on the scroller
   when a line selection is active and write the plain text instead.
3. On selection end (`onLineSelectionEnd`), show a floating bar near the range (position logic adapted from T3
   `resolveSelectionActionPosition`) with **Copy** (plain) and **Copy as Markdown**, a "Copied" state, and Esc
   to dismiss. It must not steal focus from the `j`/`k` file navigation: no focus move, `onMouseDown`
   `preventDefault` on the bar.
4. `meta` comes from `useAppModel()` (selected worktree row, project name) and `useUi` (scope). Scope label
   text: `working tree`, `staged`, `branch vs <base>`, `commit <short sha>` (use the label function the toolbar
   already has; do not duplicate it).
5. Keep the selection when the diff refreshes with the same `patchHash`; drop it when the hash changes (the
   line numbers may no longer match what the user saw).
6. Large and special diffs: nothing shows for binary / too-large / submodule / symlink placeholders (no
   selection there). The raw `<pre>` fallback (parse failure) keeps native selection and `copy`.

### Step 4: polish (only if time is left; each its own commit)
- Settings → copy: "Markdown header" toggle for the worktree path and an "absolute vs relative file path in
  Markdown" choice, via `settings/registry.ts` (client prefs in `state/prefs.ts`, no daemon setting).
- "Copy whole file diff" (patch text) in the diff header menu.
- Docs: README feature line + one screenshot (`pnpm` screenshot flow used by earlier rounds), HelpDialog row
  for Cmd/Ctrl+C.

## 5. Markdown format (the contract for `buildSelectionCopy`)

New-side or context-only selection:

````md
`src/foo.ts` L12–18 · `feature/x` · octopus-diff
worktree `/home/santosa/.t3/worktrees/octopus-diff/forges` · working tree · head `a1b2c3d`

```ts
const x = 1;
```
````

Selection with deleted lines (old and new numbers given per side, `diff` fence):

````md
`src/foo.ts` old L10–12 → new L10–14 · `feature/x` · octopus-diff
worktree `/…/forges` · branch vs `main` · head `a1b2c3d`

```diff
@@ -10,3 +10,5 @@
 context
-removed
+added
```
````

Rules: omit `· branch` when detached (write `detached at a1b2c3d`); a single line is `L12`; a fence longer
than any backtick run in the content; no trailing blank lines; path and branch are wrapped in backticks and
backticks inside them are escaped by lengthening the inline code delimiter. The line numbers are for the
shown side only; for a commit scope the header says `commit <sha>` so the numbers are not mistaken for the
working copy.

## 6. Files

New: `apps/web/src/lib/copy.ts`, `lib/copyFormat.ts`, `components/diff/CopySelectionBar.tsx`,
`components/CopyButton.tsx` (+ feedback hook), tests under `apps/web/test/`.
Edited: `components/diff/DiffRenderer.tsx`, `components/diff/DiffPane.tsx`, `components/FileList.tsx`,
`components/FileTreeView.tsx`, `components/Sidebar.tsx`, `components/Overview.tsx`, `components/bits.tsx`,
`state/commands.ts`, `state/commandRegistry.ts`, `components/HelpDialog.tsx`.
Contracts: only if new `TEST_IDS` are needed; additive, in a separate `contracts:` commit with a DECISIONS entry.

## 7. Tests

- **Unit (vitest, `apps/web/test`):** `copyFormat` (backtick fences, language by extension, renames, detached,
  deleted-only / added-only / mixed ranges, single line, reversed range, `⟨U+…⟩` kept escaped, commit scope
  header); `copy.ts` fallback path with a stubbed `document`.
- **e2e (Playwright, `e2e/tests/14-copy.spec.ts`):** grant `clipboard-read`/`clipboard-write` in the test
  context and read back with `navigator.clipboard.readText()`.
  1. Worktree row menu → Copy branch name / Copy worktree path.
  2. File row menu and diff header button → path, name, absolute path.
  3. Select two lines in the gutter → bar appears → Copy as Markdown → clipboard matches §5.
  4. A second test with `navigator.clipboard` removed (`addInitScript`) proves the textarea fallback.
  5. Selection clears when the file changes; Esc dismisses the bar.
- Use test ids from `TEST_IDS` or `data-testid` on new elements; do not rely on text.
- `pnpm check` and `pnpm test:e2e` green at the end; report real counts (AGENTS rule 5).

## 8. Acceptance (add to PLAN §8)

1. Branch name, worktree path, file path, file name and absolute path can each be copied from a menu or button
   on the worktree row, the file row and the diff header, and from the palette.
2. Selecting diff lines shows a Copy bar; plain copy yields only the selected code; Markdown copy yields §5.
3. Copying works on `http://localhost` and on a plain-http LAN address (fallback).
4. Invisible / bidirectional characters are never copied raw.
5. No daemon request, git call or contract change was added; the read-only proof harness still passes.

## 9. Constraints for the implementing session

- Work in your own worktree from the then-current `main` (`workspaceStrategy: worktree`), never in the shared
  root checkout; commit often (`web: …`, `docs: …`); do not push.
- Edit only `apps/web`, `e2e/tests` + `e2e/support` (new files only), `docs/`, and the credits files.
- Before the final fast-forward: `git log --oneline <base>..main`, rebase, keep both `docs/DECISIONS.md`
  sections, regenerate credits if the lockfile or acknowledgements moved. Advance `main` only with
  `git fetch . <branch>:main` (ff-only).
- Do not kill processes you did not start. Write `docs/reports/copy-tools.md` in the AGENTS stream-report format.
