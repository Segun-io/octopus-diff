# Forges: pull and merge requests (GitHub via `gh`, GitLab via `glab`)

> Added 2026-11-09 (branch `feat/forges`). Decisions #61–#70 in `docs/DECISIONS.md`. Report:
> `docs/reports/forges.md`. The Request tab and repository information came the same day (branch
> `feat/forge-details`): decisions #71–#80, report `docs/reports/forge-details.md`.

octopus-diff shows, for every worktree on a feature branch, the pull request (GitHub) or merge request
(GitLab) that branch belongs to: its number, state (open, draft, merged, closed), CI, review decision,
conflicts and whether its head matches the worktree's HEAD. It uses the `gh` and `glab` CLIs the user is
already signed in to. It is **read-only**: octopus-diff never creates, edits, merges or comments, and never
reads, stores or forwards a token.

![PR chips in the sidebar and the PR link in the context bar](screenshots/forges-dark.png)

The design follows T3 Code's source-control layer (`~/contrib/t3code/packages/source-control-*`, MIT;
ideas and two small adapted parsers, attributed in comments), scaled down to what a read-only,
many-worktree tool needs.

## What is shown

| Where | What |
|---|---|
| Sidebar row, Overview row | Chip after the branch: PR/MR glyph (open, draft, merged, closed), `#123` / `!123`, a CI dot (green passed, red failed, amber running). Tooltip: title, `head → base`, author, CI counts, review, conflicts, comments, "head differs from HEAD". |
| Context bar (selected worktree) | The `Changes \| PR #123` switch opens the Request tab; beside it, on the Changes tab, a link to the request on its forge with its state words (`open  changes requested  out of sync ↗`). |
| Sidebar hover card | A request block from the batch data (no extra query): glyph, number, state, title, `head → base`, author, `N files +a −d`, `21/22 checks passed · 1 failing`, review, merge state, comments, updated, and the out-of-sync explanation. |
| Project Overview | A **Pull request** column (chip, title, review word). **Repository information**: local facts (remotes with credentials removed, default branch with `↑a ↓b` against its upstream as of the last fetch, last commit, branch/tag/worktree counts, last activity) and forge facts (`host/owner/name ↗`, description, visibility, archived, fork of, license, language, topics, open request and issue counts linking to the forge, default-branch CI, pushed). **Open pull requests** below the worktree table (newest 20): rows checked out locally open that worktree's Request tab, the others open the forge. |
| Folder Overview | Columns `Default branch` (with ahead/behind), `Last commit`, `Forge` and `PRs`, and roll-ups `open pull requests` and `need attention` (failing CI, changes requested or conflicts). No forge query: local facts plus the batch data. |
| Request tab | Header (repository ▸ `#123 ↗`, title, author · opened · updated, `base ← head` with copy, `N files +a −d`, out of sync). `Summary` (reviewers with `stale`, labels as ink chips with a colour swatch, assignees, merge state; Description in markdown; Checks grouped *Needs attention / Running / Passed*, open only when something needs attention; Conversation), `Timeline` (opened, commits, comments, reviews, threads, merged/closed; newest-first toggle) and `Files` (path, status letter, `+a −d`, `changed here` when the worktree also changes it: click to see the local diff). |
| Settings → Forges | On/off switch, "Load images from the forges", `gh`/`glab` status (version, signed-in hosts, install/login hint), each repository's forge and status, host overrides, "Check again". |

Colour follows the identity rule (hues belong to the diff): only "open" (`add`) and the CI dot are
coloured; draft, merged and closed stay in the ink scale. T3 Code colours merged violet and closed red;
we deliberately do not.

## Pipeline

```
project (git-core readRemoteConfig: one `git config --get-regexp`)
  └─ remotes (insteadOf applied) ──▶ parse URL ──▶ host + path   (ssh aliases from ~/.ssh/config)
        └─ classify host: setting override ▶ hostname rule ▶ CLI login       (packages/forge/src/host.ts)
              └─ base repository: gh-resolved mark ▶ upstream ▶ github/gitlab ▶ origin ▶ others
worktrees on non-default branches
  └─ head branch (branch.<b>.merge when pushing to the tracked remote) + push repository
        └─ one GraphQL query per repository (all branches as aliases)       (gh/glab api graphql)
              └─ match: same head branch AND (push repository, or same-repo when unknown)
                    └─ open first, else the newest merged/closed
```

### 1. Discovery

- **Remotes** come from git-core's new `readRemoteConfig` (the existing allowlisted
  `git config --null --get-regexp`): `remote.*.url|pushurl|gh-resolved`, `remote.pushDefault`,
  `branch.*.remote|merge|pushRemote`, `url.*.insteadOf|pushInsteadOf`. Rewrites are applied the way
  `git remote get-url` would. No new git subcommand, nothing fetched.
- **URLs**: `https://`, `ssh://`, `git://`, scp-like `git@host:path`. Local paths, `file://`, `ext::` and
  anything whose host is not a bare hostname or whose path is not `seg/seg[/…]` are ignored. An ssh host
  alias (`git@github-work:me/app`) is mapped through literal `Host`/`HostName` pairs in `~/.ssh/config`.
- **Which forge** (first match wins):
  1. `AppSettings.forges.hosts[host]`: `github`, `gitlab` or `none` (never query);
  2. the hostname: `github.com`, `*.ghe.com`, any `github` label → GitHub; `gitlab.com`, any `gitlab`
     label → GitLab (T3 Code's rules);
  3. the CLIs' logins: a host `gh auth status` / `glab auth status` reports as signed in. This is how a
     self-managed GitLab or GitHub Enterprise on a neutral hostname is found without configuration.
- **Which repository** requests live in: `gh`'s own order. A single `remote.<r>.gh-resolved` mark
  (`gh repo set-default`) wins, else the recognised remotes ranked `upstream` > `github`/`gitlab` >
  `origin` > others. So a fork's PRs are looked up in the upstream.

### 2. CLI status

`gh --version` + `gh auth status`, `glab --version` + `glab auth status --all` (retried without
`--all` for glab < 1.79). Text output is parsed (`gh auth status --json` needs gh ≥ 2.81; Ubuntu ships
2.46). Probes are cached 10 minutes (30 s on "Check again"). **The CLIs are started only once some
project has a remote on a host**, so offline setups and the test fixtures never run them.

### 3. Fetching

One GraphQL query per repository and refresh, with each branch as an aliased connection
(`b0: pullRequests(headRefName: $b0, first: 5, orderBy: UPDATED_AT DESC)`; GitLab:
`mergeRequests(sourceBranches: [$b0], first: 5, sort: UPDATED_DESC)`), batches of 20 branches.
Measured: 1 GitHub rate-limit point per repository per refresh.

- GitHub fields: number, title, url, state, isDraft, base/head ref, head oid, isCrossRepository,
  headRepository, author, reviewDecision, mergeable, totalCommentsCount, and the head commit's
  `statusCheckRollup` state with `checkRunCountsByState` / `statusContextCountsByState` (counts without
  listing every check).
- GitLab fields: iid, title, webUrl, state, draft, target/source branch, diffHeadSha, author, source and
  target project, userNotesCount, headPipeline.status, conflicts, approved + approvedBy, detailedMergeStatus.
  If a self-managed GitLab rejects unknown fields, the query is retried with a basic field set.
- Only branches checked out in worktrees are asked about, never the default branch (forks reuse `main`).
- When: on daemon start; 1.5 s after a worktree/project is added, removed or updated or a branch
  changes; every 2 minutes; on "Check again" (`POST /api/forges/refresh`). At most once per 15 s per
  project unless forced. A failed fetch keeps the last good data and reports `error`.

### 3b. Detail, conversation and repository queries

Each is one GraphQL query through the same runner and allowlist, fetched only when needed:

| Data | Query | When fetched | Cache (daemon) | Cost |
|---|---|---|---|---|
| Chips, hover card, Overview rows | the batch above (now also `createdAt additions deletions changedFiles mergeStateStatus`; GitLab `createdAt`, `diffStatsSummary`) | daemon start, worktree events, every 2 min | as above | 1 pt per repository and refresh (measured, unchanged) |
| Request detail: summary, reviewers, labels, 100 checks, newest 100 commits, first 100 files | `OctopusDiffPullRequestDetail` / `OctopusDiffMergeRequestDetail` | when the Request tab opens | 60 s while open, 10 min when merged/closed; in-flight dedupe; key includes the batch's `updatedAt`, head and CI state | 1 pt |
| Checks live refresh | the same detail query | every 45 s, only while a check runs, the tab is shown, the browser tab is visible and the user gave input in the last 20 min | same | 1 pt per 45 s per open tab |
| Conversation: 50 comments, 50 reviews, 50 threads × 10 comments (GitLab: 50 discussions × 10 notes) | `OctopusDiffPullRequestConversation` / `OctopusDiffMergeRequestConversation` | when the Summary's Conversation or the Timeline is shown | 60 s / 10 min | 1 pt |
| Repository facts + 20 newest open requests | `OctopusDiffRepository` / `OctopusDiffProject` | when the project Overview opens; "Refresh" (15 s spacing) | 10 min | 1 pt |
| Local repository facts | git only (`for-each-ref`, `log -1`, `rev-list --left-right --count`, the remote config read) | Overview mount (project and folder) | 30 s, dropped on any event naming the project | 0 |

Every GitHub query asks for `rateLimit { cost remaining }`; the opt-in live test asserts `cost <= 1`. GitHub PR
numbers are inlined in the query text (`pullRequest(number: 42)`): `gh api graphql --raw-field` cannot pass an
`Int!` and `-F` stays banned. GitLab's `iid` is a `String!` variable. Errors keep the last good data (shown with a
"Showing the last loaded data" note); a request that no longer exists answers `no-request`. A `basic` variant of
each GitHub query without `mergeStateStatus` / `latestOpinionatedReviews` covers old GitHub Enterprise, and GitLab's
`basic` variants drop newer fields (`mergeRequestInteraction`, `diffStatsSummary`, `languages`, ...); both are tried
after an "unknown field" error.

GitLab maps onto the same UI from GraphQL only: pipeline jobs grouped by stage are the checks (`MANUAL` is
neutral), `diffStats` gives files without a change kind, reviewers come from `mergeRequestInteraction` plus
approvers, and discussions become the conversation (diff notes are threads, other notes are comments, system
notes are dropped; there are no review objects). Missing data hides its section.

### 4. Matching

For a worktree on local branch `b`: the head branch is `branch.b.merge` when the branch pushes to the
remote it tracks, else `b`; the push repository is the URL of `branch.b.pushRemote` > `remote.pushDefault`
> `branch.b.remote` > `origin`, if it is on the forge's host. A request matches when its head branch
is that name and it comes from the push repository (or, with no known push repository, from the base
repository itself). Same-named branches in strangers' forks never match. Then: an open request (newest
first), else the most recently updated merged or closed one. `sync` compares the request's head commit
with the worktree's HEAD (`same` / `differs`; local refs only).

## Safety

The read-only guarantee (PLAN §5.5) is extended to the forge CLIs, in `packages/forge/src/cli.ts`:

- **One runner, argument allowlist.** Allowed: `--version`; `auth status [--hostname <h>]` (glab also
  `--all`); `api graphql --hostname <h> --raw-field query=<Q> --raw-field <var>=<value>…` where `Q` must
  equal, byte for byte, one of the queries built by `buildGithubQuery(n)` / `buildGitlabQuery(n, …)` for
  the number of branch variables given, and the variables are exactly `owner`/`name` (GitHub) or
  `fullPath` (GitLab) plus `b0…bN-1`. Rejected: any other subcommand, `--method`, `-F`/`--field` (which
  can read files), `--input`, `auth token`, `--show-token`, mutations, values with newlines or NUL.
- **Argv arrays, never a shell.** Branch names are GraphQL variables, never spliced into query text.
- **Neutral working directory** (the daemon's state dir): the CLIs never run inside a user repository,
  so they cannot read its (untrusted) config or run git there. Repositories are named explicitly.
- **Hardened environment**: `GH_PROMPT_DISABLED`, `GLAB_NO_PROMPT`, update notifiers off, pagers `cat`,
  `NO_COLOR`, `GIT_TERMINAL_PROMPT=0`; `GH_REPO`, `GITLAB_REPO`, `GH_DEBUG`, `GLAB_DEBUG_HTTP`, editors and
  browsers removed.
- **Tokens never travel to the wrong host.** `gh` sends `GH_ENTERPRISE_TOKEN` to any non-github.com host
  and `glab` sends `GITLAB_TOKEN` to whatever host it is asked about, so a crafted remote URL
  (`https://github.attacker.example/x/y`) could otherwise collect them. The runner keeps `GH_TOKEN` only
  for github.com / `*.ghe.com`, `GH_ENTERPRISE_TOKEN` only for the user's own `GH_HOST`, and `GITLAB_TOKEN`
  only for the user's `GITLAB_HOST` (gitlab.com when unset). And **a host is only ever queried when the
  CLI itself reports being signed in to it.**
- Hosts are validated as bare lower-case hostnames (`ForgeHostSchema`), timeouts 20 s, stdout cap 8 MiB,
  two processes per CLI. Auth output is never logged; error details skip token lines.
- The web UI opens request URLs only when they are `https://` (`target=_blank rel=noopener noreferrer`).
- **Query registry.** The allowlist is a registry of query kinds (`batch`, `repository`, `detail`,
  `conversation`, `QUERY_REGISTRY` in `cli.ts`): each knows its fixed variable names (`owner`/`name`,
  `fullPath`, `fullPath`/`iid`, `b0…bN-1`), reads its parameters (branch count, the inlined PR number, which
  must be a safe integer) and rebuilds the exact strings it allows. A tampered number, an extra variable or a
  modified field is denied (tested).
- **Routes keyed by id.** Detail, conversation and repository routes take a worktree or project id; the
  daemon resolves repository and number from the request it already matched, so a page cannot make it
  query an arbitrary request. Unknown ids are 404.
- **Images and CSP.** The UI's `img-src` adds `https://` sources for the hosts a CLI is signed in to
  (GitHub.com: `github.com`, `*.githubusercontent.com`; GitHub Enterprise `H`: `H`, `*.H`; GitLab `H`: `H`,
  `secure.gravatar.com`), validated by `ForgeHostSchema`, so no directive can be injected. `forges.images:
  false` (Settings) or forges off restores the strict policy; API responses keep `default-src 'none'`. The
  UI renders `<img>` only for https URLs on those hosts (`no-referrer`, lazy, fixed max size), else a plain
  `image: <alt> ↗` link; a failed load falls back to the link. Comment authors can thereby make the browser
  contact a forge host the user already uses (IP and timing exposure), nothing else.
- **Markdown.** `react-markdown` + `remark-gfm` with `skipHtml` (no raw HTML, no `rehype-raw`, no
  `dangerouslySetInnerHTML`), HTML comments stripped, links `https:`/`mailto:`/`#` only (relative ones resolved
  against the repository), task-list boxes disabled, `#123`/`!123` autolinked.
- **Remote URLs** in repository information lose their userinfo (http/https/git) or password (ssh) before
  they leave git-core.

## API (additive; `packages/contracts/src/forge.ts`)

- `GET /api/forges` → `ForgesResponse { enabled, clis[], projects[{ projectId, forge, status, message,
  worktrees[{ worktreeId, branch, changeRequest, sync }], fetchedAt }], generatedAt }`. Served from the
  cache joined with the live worktree list; never waits on the network.
- `POST /api/forges/refresh { projectIds? }` → the same, after re-probing stale CLIs and refetching.
- SSE `forge.updated { projectIds }` (empty list = only the CLI status changed).
- `AppSettings.forges { enabled (default true), hosts: { [host]: 'github' | 'gitlab' | 'none' } }`,
  patched through `PATCH /api/settings`.
- `GitCore.readRemoteConfig?(project)` (optional on the interface, implemented by git-core).
- `GET /api/forges/worktrees/:worktreeId/request` → `ChangeRequestDetailResponse { worktreeId, status: ok |
  no-request | unavailable, message, request: ChangeRequestDetail | null, fetchedAt, imageHosts }`.
  `ChangeRequestDetail` = `ChangeRequest` + `body`, `bodyTruncated` (64 KiB), `mergedAt`, `closedAt`, `mergedBy`,
  `authorActor`, `labels`, `assignees`, `reviewers` (`approved | changes_requested | commented | dismissed |
  pending`, `stale`), `checkList` (+ `checksTruncated`), `commits` (+ `commitsTotal`), `files` (+ `filesTotal`).
- `GET /api/forges/worktrees/:worktreeId/request/conversation` → `ChangeRequestConversationResponse` (comments,
  reviews, threads, totals, `truncated`; comment bodies capped at 20 KiB, minimised comments dropped).
- `POST /api/forges/worktrees/:worktreeId/request/refresh` → refetches detail and conversation (15 s spacing).
- `GET /api/forges/projects/:projectId/repository` and `POST …/repository/refresh` → `RepositoryForgeResponse {
  projectId, status (ProjectForgeStatus), message, forge, repository: ForgeRepositoryInfo | null, fetchedAt }`.
- `GET /api/repositories?projectIds=a,b,c` (max 200) → `{ repositories: [{ projectId, info: GitRepositoryInfo |
  null, error }], generatedAt }` (git only, no forge).
- `ChangeRequest` gained optional `createdAt`, `additions`, `deletions`, `changedFiles`, `mergeState` (`clean |
  blocked | behind | conflicts | unstable | draft | unknown`); `AppSettings.forges.images?` (default on);
  `GitCore.readRepositoryInfo?(project, { defaultBranch })`.
- Project statuses: `ok`, `pending`, `disabled`, `no-forge`, `ignored`, `idle` (only the default
  branch checked out), `cli-missing`, `unauthenticated`, `error`.

## Packages

| Path | What |
|---|---|
| `packages/forge` (new) | `ForgeCli` (runner + allowlist + env), `ForgeClient` (probe, batched fetch, GitLab fallback), remote parsing and classification, ssh aliases, auth-status parser, GraphQL builders and normalisers, base-repository and branch resolution, matching. No daemon state. |
| `packages/git-core/src/remotes.ts` | `readRemoteConfig` + `parseRemoteConfig` / `rewriteUrl`. |
| `apps/daemon/src/forges.ts` | `ForgeService`: caches, scheduling, events, `GET`/`POST` handlers. `internal.forges` injects a fake client in tests (or `false` to not start it). |
| `apps/web/src/{api/forges.ts,lib/forge.ts,components/ChangeRequest.tsx,components/settings/ForgesSection.tsx}` | Query + SSE refetch, presentation, chip/badge/hover block, Settings panel. `mock/forges.ts` serves demo data. |
| `packages/forge/src/{details,github-details,gitlab-details}.ts` | Detail, conversation and repository builders and normalisers; `cli.ts` `QUERY_REGISTRY`; `scripts/record-fixtures.ts` re-records the fixtures through the runner. |
| `packages/git-core/src/repository.ts` | `readRepositoryInfo`, `stripUrlCredentials`. |
| `apps/daemon/src/{forges.ts,repositories.ts,security.ts}` | Detail/conversation/repository caches and routes, the repository-info service, `uiCsp(imageHosts)` and `forgeImageHosts`. |
| `apps/web/src/{api/request.ts,lib/request.ts,lib/markdown.ts,components/request/*,components/RepositoryInfo.tsx}` | Request tab (hooks with the live-refresh rule, presentation logic, safe markdown, views) and the Overview blocks. `mock/forge-details.ts` serves demo detail, conversation and repository data. |

## Testing

- `packages/forge`: parsers against **real recorded responses** (`test/fixtures/github-batch.json` from
  `pingdotgg/t3code`, `gitlab-batch.json` from `gitlab-org/cli`, gh 2.46 /
  older gh / glab auth output); allowlist and env rules; the full client against fake `gh`/`glab`
  executables (argv, cwd and env recorded; old-glab `--all` retry; GitLab basic-query fallback; errors and
  timeouts). Opt-in live test: `OCTOPUS_FORGE_LIVE=1 [OCTOPUS_FORGE_GLAB=/path/to/glab] pnpm --filter
  @octopus-diff/forge test` (public repositories only).
- `apps/daemon/test/forges.test.ts`: fork matching, upstream selection, GitLab via CLI login,
  rate limiting and forced refresh, errors keep data, disabled, host overrides, and "no remote → no CLI
  ever started".
- `apps/web/test/forges.test.tsx`: chips for every look, toolbar link attributes, Settings toggling off
  removes every chip through `forge.updated`; the hover block and the Overview column.
- Request tab and repository information: `packages/forge/test/details.test.ts` (recorded
  `github-{repository,detail,conversation}.json` from `pingdotgg/t3code` and `gitlab-*` from `gitlab-org/cli`,
  edge cases, the registry, a fake CLI serving the fixtures incl. the `basic` retries);
  `packages/git-core/test/repository.test.ts` (counts, ahead/behind with a local bare remote, credential
  stripping, unborn and bare repositories); `apps/daemon/test/forge-details.test.ts` (TTLs, dedupe, forced
  refresh spacing, stale-on-error, statuses, 404s, the CSP builder and setting, the repositories route with a
  real repository); `apps/web/test/request.test.tsx` (markdown safety, checks/conversation/timeline logic, the
  live-refresh rule, registry and toolbar tab, Summary/Timeline/Files); `apps/web/test/repository-info.test.tsx`
  (both Overviews; the folder Overview makes no forge request); `e2e/tests/14-ui-forge-details.spec.ts` (local
  facts with no forge; a fake `gh` on PATH serving the recorded fixtures for the chip, the Request tab, the
  forge block and the CSP).
- Live: the opt-in test now also runs the repository, detail and conversation queries on `pingdotgg/t3code`
  (each `cost <= 1`) and on `gitlab-org/cli` through an unauthenticated `glab`.

## Not done (on purpose or for later)

- No writes of any kind (merge, approve, comment, checkout): out of scope by PLAN §1.
- No other forges (Bitbucket, Azure DevOps, Forgejo/Gitea): T3 Code has them; the classification and
  runner are shaped so one more `kind` is a contained change.
- No "compare against the PR's base" scope yet: `ChangeRequest.baseBranch` is there for it, but the base
  usually needs a fetch to be current, and fetching is not read-only.
- No notifications, no pagination beyond the first page of each list (a banner links to the forge), no
  reactions, no "Guide" or agent hand-off, no syntax highlighting inside markdown, no raw HTML (`<details>`
  renders flattened), no forge-served patch (the Files tab marks local changes instead).
- `sync` is `same`/`differs` only: telling "ahead" from "behind" needs the request's head object
  locally, which needs a fetch.
- GitLab is verified against gitlab.com's public GraphQL and the `glab` 1.128 binary, but not against a
  signed-in `glab` (none on the dev machine).
