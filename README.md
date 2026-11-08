# octopus-diff

A **diff-first, read-only git UI that shows many projects and worktrees in one view**, built for the
era of coding agents that edit many repositories at once.

Coding agents (Claude Code, Codex, Cursor, T3 Code, Conductor, …) edit code in many repos and many git
worktrees at the same time. You no longer live in an editor, but you still need to answer three
questions. octopus-diff answers them in one browser window:

1. **What changed, across everything I have, since I last looked?** A cross-project *Inbox* of every
   dirty worktree.
2. **What exactly is the diff?** The diff is the main screen: split or unified, five scopes
   (working tree, staged, unstaged, branch vs. its base, single commit).
3. **Where am I?** Repository, worktree, branch, ahead/behind, and dirty counts for each worktree.

It is **agent-agnostic**: it only speaks git, so it works with any tool that edits files or creates
worktrees. Worktrees are discovered automatically, and edits show up live without a reload. Files you
mark as reviewed stay reviewed until their patch changes, then come back as unreviewed.

> **Status: MVP under construction.** The CLI described below is implemented. The daemon, git layer
> and web UI are being built in parallel and are merged as they land; until then `octopus-diff serve`
> stops with "daemon is a placeholder". The design and the acceptance list are in
> [`docs/PLAN.md`](docs/PLAN.md).

## Why it is safe to point at your repositories

octopus-diff **never writes to a repository**: no stage, commit, checkout, fetch, or even an index
refresh. This is enforced in code and tested, not just promised:

- All git access goes through one runner that only allows read-only subcommands (`status`, `diff`,
  `diff-index`, `diff-tree`, `rev-parse`, `rev-list`, `merge-base`, `worktree list`, `for-each-ref`,
  `symbolic-ref`, `show`, `cat-file`, `ls-files`, `log`, `config --get`). Anything else is rejected.
- Every call runs with `--no-optional-locks` and `GIT_OPTIONAL_LOCKS=0`, so a read never takes
  `index.lock` and never collides with an agent running git at the same moment. Also
  `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `LC_ALL=C`, and `--no-ext-diff --no-textconv` on diffs.
- git is spawned with an argument array, never through a shell. Refs and paths from requests are
  validated, and `--end-of-options` / `--` separators keep user input from being read as options.
  Repository config is treated as untrusted.
- Proof tests run the whole app against fixture repositories and assert that no `index.lock` was
  created and that `.git/index`, refs and `git status` are unchanged.

octopus-diff's own state (the access token, the project list, review marks) lives outside your
repositories, in `~/.local/state/octopus-diff/`.

## Requirements

- **Node.js ≥ 24**
- **git ≥ 2.25** (newer versions are used when available, e.g. `worktree list -z` from 2.36)
- Linux, macOS, or Windows via WSL2. Native Windows is untested.
- For development: **pnpm 12**

## Install

octopus-diff is not published to npm yet. Run it from a checkout:

```sh
git clone <this repository> octopus-diff
cd octopus-diff
pnpm install
pnpm build
node apps/cli/dist/index.js serve
```

To get an `octopus-diff` command on your `PATH`, link the CLI package: `cd apps/cli && pnpm link
--global`. A self-contained tarball (one bundled file plus the web UI) can be built with
`pnpm --filter octopus-diff run pack:tarball` and installed with `npm install -g
apps/cli/.pack/octopus-diff-<version>.tgz`. Once the package is published, `npx octopus-diff` will be
enough.

## Usage

```sh
octopus-diff serve                  # start on http://127.0.0.1:7428 and print the URL to open
octopus-diff serve --open           # … and open it in your browser
octopus-diff serve ~/code/app ~/code/lib --scan ~/work --depth 2
octopus-diff add ~/code/other       # register a repository with the running daemon
octopus-diff add --scan ~/agents    # add a scan root (discovers repositories below it)
octopus-diff status                 # is it running? prints the URL again
octopus-diff doctor                 # check git, Node, inotify limits, WSL, paths, port, web assets
```

`serve` is also the default command, so plain `octopus-diff` starts the daemon.

`serve` prints a line like this:

```
  Open:   http://127.0.0.1:7428/?token=3f9c…
```

Open that URL. The token logs the browser in (it becomes an HttpOnly cookie and is removed from the
address bar). **Treat the URL like a password**: anyone with it can read the diffs of every registered
repository. Stop the daemon with Ctrl+C.

A *project* is a git repository. You can add any directory inside it, including a linked worktree;
all of the repository's worktrees are discovered automatically (T3 Code's `~/.t3/worktrees`, Claude
Code's `.claude/worktrees`, Conductor, Codex and hand-made worktrees alike). A *scan root* is a
directory that is searched for repositories down to a depth (default 3, max 8), skipping
`node_modules` and similar.

### Commands and options

| Command | Options |
|---|---|
| `serve [path…]` | `-p, --port <n>` (default 7428, `0` = any free port) · `--host <addr>` (default `127.0.0.1`) · `--allow-non-loopback` · `--allowed-host <name>`… · `-o, --open` / `--no-open` · `-s, --scan <dir>`… · `-d, --depth <n>` · `--watch` / `--no-watch` · `--poll` · `--web-root <dir>` |
| `add <path…>` | `-s, --scan <dir>`… · `-d, --depth <n>` · `--url <url>` · `-p, --port <n>` · `--host <addr>` |
| `status` | `-o, --open` · `--json` · `--url <url>` · `-p, --port <n>` · `--host <addr>` |
| `doctor` | `--json` · `-p, --port <n>` · `--host <addr>` · `--web-root <dir>` |
| `config` | `--path` (print the config file path) · `--schema` (print its JSON Schema) |
| every command | `-c, --config <file>` · `--config-dir <dir>` · `--state-dir <dir>` · `--log-level debug\|info\|warn\|error\|silent` · `-h, --help` |

`octopus-diff help <command>` prints the details. Exit codes: `0` success, `1` failure (daemon not
running, port in use, a `doctor` check failed, …), `2` bad command line or invalid config file.

`add` and `status` talk to the daemon that `serve` started: `serve` records its address in
`<state dir>/daemon.json`, and the token is read from `<state dir>/token`. If no daemon is running,
`add` says so and exits 1; start one with `octopus-diff serve` (paths given to `serve` or listed in the
config file are registered at startup).

### Configuration file

Optional: `~/.config/octopus-diff/config.json` (or `$XDG_CONFIG_HOME/octopus-diff/config.json`, or
`--config <file>`). Command-line flags win over the file; list flags (`--scan`, project paths,
`--allowed-host`) are added to the lists from the file. Relative paths in the file are relative to the
file; `~` is expanded. Unknown keys are an error, so typos don't silently do nothing.
`octopus-diff config --schema` prints the JSON Schema, and `octopus-diff config` shows the file that
was read and the effective values.

```jsonc
{
  "port": 7428,                    // 0 = any free port
  "host": "127.0.0.1",
  "open": true,                    // open the browser on `serve`
  "projects": ["~/code/app", "~/code/lib"],
  "scanRoots": ["~/.t3/worktrees", { "path": "~/work", "depth": 2 }],
  "scanDepth": 3,                  // depth for scan roots without one (0–8)
  "watch": {
    "enabled": true,               // false = poll + manual refresh only
    "forcePolling": false,         // true = never use native watchers (WSL /mnt/*, NFS)
    "ignore": ["vendor", ".venv"], // added to the built-in ignores (.git, node_modules, build dirs)
    "debounceMs": 200,             // 150–300
    "pollFocusedMs": 30000,
    "pollIdleMs": 300000
  },
  "git": { "gitBinary": "git", "concurrency": 4, "timeoutMs": 15000 },
  "logLevel": "info",
  "allowNonLoopback": false,
  "allowedHosts": [],
  "stateDir": "~/.local/state/octopus-diff"
}
```

The real file is plain JSON (no comments). `webRoot` (a directory with a built web UI) overrides the
bundled UI; omit it normally.

### Files

| Path | What |
|---|---|
| `~/.config/octopus-diff/config.json` | optional config file (`$XDG_CONFIG_HOME`) |
| `~/.local/state/octopus-diff/token` | access token, mode 0600 (`$XDG_STATE_HOME`) |
| `~/.local/state/octopus-diff/daemon.json` | address and pid of the running daemon (removed on exit) |
| `~/.local/state/octopus-diff/` | project registry and review marks (SQLite) |

## Security model

The daemon serves the contents of your repositories over HTTP, so it is locked down by default:

- **Loopback only.** It binds `127.0.0.1` by default. Binding anything else requires
  `--allow-non-loopback` (or `"allowNonLoopback": true`); `serve` refuses otherwise. Do this only on a
  network you trust.
- **Per-install token.** A random token is created in `<state dir>/token` (mode 0600). Every API
  request needs it, as `Authorization: Bearer <token>` or as the `octopus_diff_token` cookie
  (HttpOnly, SameSite=Strict). The printed URL carries it once as `?token=`; the daemon then sets the
  cookie and redirects to a URL without it. Only `/api/health` is unauthenticated. To rotate the token,
  stop the daemon, delete the token file and start it again.
- **Host and Origin checks.** The `Host` header must be a loopback name or address (or one listed in
  `--allowed-host`), which defeats DNS-rebinding attacks. A request with an `Origin` header must come
  from the daemon's own origin, so other websites open in your browser cannot read your diffs.
- **No write endpoints toward repositories.** The only writes are octopus-diff's own state (project
  list, review marks, focus) in the state directory.

`octopus-diff doctor` checks that the token file is not readable by other users.

## Platform notes

### Linux: inotify limits

Live updates use native file watchers. With many worktrees, Linux's inotify limits can run out; the
daemon then logs a warning and falls back to polling. `octopus-diff doctor` shows the current limits
and the fix:

```sh
printf 'fs.inotify.max_user_watches=524288\nfs.inotify.max_user_instances=512\n' \
  | sudo tee /etc/sysctl.d/60-octopus-diff.conf && sudo sysctl --system
```

### WSL

- Keep repositories in the Linux filesystem (e.g. `~/code`). On `/mnt/c/…` (Windows drives) git is
  much slower, and file watching does not see edits made by Windows programs. If you must use
  `/mnt/*`, run `serve --poll` (or set `"watch": { "forcePolling": true }`).
- `--open` opens your Windows browser through `wslview` (from `wslu`) or PowerShell, falling back to
  `xdg-open`. The URL works from Windows because WSL2 forwards `localhost`.
- Without systemd, `/etc/sysctl.d` is not applied at WSL start; run `sudo sysctl --system` after each
  start or add it to the `[boot]` command in `/etc/wsl.conf`.

## Limitations

- **Read-only by design**: no staging, committing, discarding, pushing or conflict resolution. Use
  your agent, editor, lazygit or the git CLI for that.
- No history graph, no forge/PR features, no fetching: ahead/behind counts use local refs only.
- Very large diffs are capped and shown as "too large" placeholders (you can load them on demand);
  binary files are shown as binary.
- One machine: the browser and the repositories must be on the machine running the daemon (or reach
  it over a trusted network with `--allow-non-loopback`).
- Not published to npm yet; no desktop app yet.

## Development

```sh
pnpm install
pnpm check      # lint + typecheck + unit tests + build
pnpm test:e2e   # Playwright end-to-end tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout, conventions and the read-only rules, and
[AGENTS.md](AGENTS.md) for the rules that coding agents working on this repository follow.

## License

MIT
