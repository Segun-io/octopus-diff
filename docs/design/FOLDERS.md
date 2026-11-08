# Folders: read-only capabilities for a whole folder (design)

> UX round 1, stream ux-web, 2026-11-08. Design only. No daemon endpoint exists for anything in §3;
> §1 and §2 describe what the shell already does to make that work later without shell changes.

## 1. Vision

Today the unit of attention is a **diff**. The next unit is a **folder you watch**: `~/code`,
`~/.t3/worktrees`, a client's monorepo checkout. A folder holds repositories and worktrees, but also
things that are not diffs: files you want to read at HEAD or in the working copy, a search across
everything an agent touched, the history of one file, and plain directories that are not repositories
at all (build output, notes, a vendored tree) where "what changed since I looked" is still a fair
question. All of it stays read-only: octopus-diff shows, it never writes.

The product stays diff-first. The Inbox is still the home screen and `Changes` is still the view you
land in. Folder capabilities are what you reach for when the diff is not enough context: "show me the
whole file", "where else is this symbol", "when did this line arrive", "what is in this folder anyway".

## 2. What the shell already provides (shipped in this round)

- **Folder is a first-class node.** The sidebar is `Inbox → Folders (scan roots) → Projects →
  Worktrees`, with an "Added directly" pseudo-folder for projects registered without a scan root. A
  folder row aggregates repositories, dirty worktrees and unreviewed files, has the same context menu as
  a project (mark all verified / unreviewed, review on / off / inherit, rescan, remove) and its own
  Overview.
- **Selection is a path, not a mode.** `View` is `{ kind: 'inbox' } | { kind: 'folder', scanRootId } |
  { kind: 'project', projectId } | { kind: 'worktree', worktreeId }`; `views/registry.ts` turns it into a
  `Selection { folder?, project?, worktree?, inbox }` and asks each registered `ViewDefinition.appliesTo`
  whether it fits. `Changes` applies to the Inbox and worktrees, `Overview` to folders and projects.
- **The main pane is a registry.** Adding a view is a `ViewDefinition { id, label, icon, appliesTo }`
  plus a lazy component; the shell renders whichever applies first. No tab strip is shown today because
  exactly one view applies to every selection; once two apply (a worktree with `Changes` and `Files`),
  the shell gets a small tab strip fed by `viewsFor(selection)`. Non-functional tabs are never shown.
- **Navigation is name-addressable.** The command palette already lists folders, projects and worktrees;
  future views add "Files in …", "Search …" entries without touching the sidebar.
- **Policy and bulk actions are node-scoped.** Review policy and "mark all" already take a folder /
  project / worktree target, so a future view inside a folder inherits them.

## 3. Views that would come (and how they look in this shell)

| View | Applies to | What it shows | Shell impact |
|---|---|---|---|
| **Files** | worktree, project (main worktree), non-repo folder | A read-only tree of the working copy (or of `HEAD` for a bare project), with the changed files decorated exactly like today's tree view; selecting a file opens a read-only viewer (same renderer as the diff, single column, same syntax highlighting, same Trojan Source warnings). A "Diff" button on a changed file jumps to `Changes` for it. | A second applicable view for worktrees → the tab strip appears. Reuses `FileTreeView` and the diff renderer in "file" mode. |
| **File history** | a file inside a worktree | `git log --follow` for the path, one row per commit (sha, subject, author, date), the diff of the selected commit for that file only (today's `commit` scope, pinned to one path). | A view that applies when the selection carries a `path`; `Selection` grows an optional `path`. |
| **Search** | folder, project, worktree | A query box; results grouped folder → project → worktree → file, each hit a line with context; opening a hit opens the file viewer at that line, or `Changes` if the file is dirty. | Applies to every node; Search is also a palette command. Results reuse the file-list row component. |
| **Snapshot diff** (repo-less folders) | a watched folder that is not a repository | The daemon keeps a content snapshot the first time it sees the folder; the view is a `Changes` list between the snapshot and now (added / modified / deleted), with "take a new snapshot" as the only action. Review marks apply as usual (patch-hash keyed). | `Changes` applies to a folder node too once the daemon can report its files; nothing new in the shell. |
| **Overview** (shipped) | folder, project | Stats, members, bulk actions, policy. | – |

Common visual rules: every view has the same header (node name, path with middle ellipsis, stats),
the same keyboard model (`j`/`k` rows, `Enter` opens, `Esc` back), and no write affordances at all.
Views never show a spinner where a list used to be; they show the previous content dimmed until the new
one arrives, like the file list does today.

## 4. Daemon prerequisites and security model (for the next round)

Everything below is additive to the API and sits behind the same auth and `Host`/`Origin` checks as
every route today. None of it exists yet.

- **Only registered roots are readable.** A path is served only if its realpath is inside the realpath of
  a registered scan root or project worktree (`readable roots`). Symlinks are resolved first and the
  result must still be inside a readable root; a symlink that escapes is reported as a symlink (target
  shown as text), never followed. This is the containment rule `apps/daemon/src/static.ts` already applies
  to the UI assets, applied to user data.
- **Read-only by construction.** New routes are `GET` only: `GET /api/worktrees/:id/tree?path=`,
  `GET /api/worktrees/:id/file?path=&ref=`, `GET /api/worktrees/:id/history?path=`,
  `GET /api/search?q=&scope=`. Files at a ref come from `git show <ref>:<path>` through git-core's
  runner (allowlist, `--no-optional-locks`, `--end-of-options`, literal pathspecs); working-copy files are
  read with `fs` under the containment rule. No endpoint writes, and there is no "open in editor" that
  spawns anything (see SEC-03).
- **Size caps and types.** File reads stop at the existing soft/hard caps and report `tooLarge` /
  `truncated` like diffs; binary detection reuses git's attributes and the NUL heuristic; search results are
  capped per worktree and globally, and search runs with a time budget per request.
- **Hostile repository config is still untrusted.** `core.worktree`, `.gitattributes` filters and
  `textconv` are never honoured for reads (`--no-textconv`, `--no-ext-diff`, `-c core.worktree=` guard,
  see SEC-06).
- **Trojan Source applies to file contents as well.** The file viewer reuses the SEC-05 detection and the
  banner.
- **Snapshots for repo-less folders** live in the daemon's own state dir (SQLite, content hashes +
  optional stored text under a size cap), never inside the folder.
- **Policy.** Review policy already resolves per folder; file-level views inherit the worktree's policy
  (a review-off worktree shows no marks).

## 5. Out of scope, deliberately

Editing, staging, opening terminals, agent integration, remote folders. The value of a read-only tool is
that nothing in it can be the thing that broke a repository.
