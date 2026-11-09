# forges report

Lead session, 2026-11-09, branch `feat/forges` (worktree `~/.t3/worktrees/octopus-diff/forges`). Design and safety
rules: `docs/FORGES.md`. Decisions #61–#70.

## Shipped

- **Discovery** from git config alone (`git-core` `readRemoteConfig`: remotes, `insteadOf`, branch tracking,
  `gh-resolved`), ssh aliases from `~/.ssh/config`, forge recognition by setting → hostname → CLI login, base
  repository in `gh`'s order (forks look up the upstream).
- **`packages/forge`** (new): `ForgeCli` (allowlisted, argv-only, neutral cwd, host-scoped env tokens), `ForgeClient`
  (`probe`, `fetchChangeRequests`: one aliased GraphQL query per repository through `gh api graphql` /
  `glab api graphql`, GitLab basic-field fallback, glab < 1.79 `--all` retry), parsers and matching.
- **Daemon** `ForgeService` (`apps/daemon/src/forges.ts`): `GET /api/forges`, `POST /api/forges/refresh`, SSE
  `forge.updated`, `AppSettings.forges { enabled, hosts }`. Starts no CLI until a project has a remote on a host;
  refreshes on registry/branch events (debounced), every 2 min, at most every 15 s per project unless forced.
- **Web**: PR/MR chip on sidebar and Overview rows (glyph, number, CI dot, full tooltip), toolbar link
  (`PR #123 · open · … ↗`), Settings → Forges (switch, CLI status, per-repository status, host overrides,
  "Check again"); mock backend serves demo forge data.

Screenshots (real daemon, real `gh`, throwaway repos with `cli/cli` as origin): `docs/screenshots/forges-dark.png`,
`forges-light.png`, `forges-settings-dark.png`.

## Verification

- `pnpm check` (lint + typecheck + build + all unit tests): exit 0 in 32 s. contracts 75, forge 63 (+2 live tests
  skipped by default), git-core 130, daemon 161, web 146 (147 after the last web change, see below), fixtures 48,
  cli 139, e2e-unit 5.
- `pnpm test:e2e`: 68 passed (2.2 min). Earlier runs: `03-scopes` "the scope selector switches the file list" failed
  1 in 3 runs on this branch and 1 in 4 runs on an untouched `main` build, so it was already flaky.
- Live, opt-in: `OCTOPUS_FORGE_LIVE=1 OCTOPUS_FORGE_GLAB=<glab 1.128> pnpm --filter @octopus-diff/forge exec vitest run
  test/live.test.ts`: 2 passed (`cli/cli` through gh 2.46, `gitlab-org/cli` through glab 1.128 unauthenticated against
  public GraphQL).
- Live, the whole daemon (source, real `gh` 2.46 signed in, throwaway repos): settled in 2.1 s.
  - `cli/cli` found via `origin` (hostname).
  - `dependabot/github_actions/codeql-actions-…` → PR #14964: open, checks 28/28 passed, review required, no
    conflicts.
  - `bagtoad/triage-ghmock-skill` → PR #14976: merged, approved, checks 11/11.
  - `octopus/no-pr-here` → no request.
  - GitLab project → `unauthenticated` with the `glab auth login --hostname gitlab.com` hint.
- Query costs measured: GitHub batched query `cost: 1`. GitLab query shape checked on gitlab.com's public GraphQL
  (`iid` is a string there; handled).

## Decisions

#61–#70 in `docs/DECISIONS.md`:

- PLAN now allows read-only forge status.
- On by default, with a switch and per-host overrides.
- The CLIs do the auth; octopus-diff never holds a token. Queries are batched GraphQL.
- A second read-only runner, with host-scoped tokens.
- Discovery order.
- Matching ignores branches in strangers' forks.
- `GitCore.readRemoteConfig`.
- Auth status is parsed from text output.
- Colours stay within the identity.
- A preflight fix and a known flake.

## Contract changes

All additive:

- `contracts: forge integration …`: `forge.ts`, `ROUTES.getForges` / `refreshForges`, `ForgeUpdatedEvent`,
  `AppSettings.forges?`, `AppSettingsPatch.forges?`, `ApiClient.getForges` / `refreshForges`, and optional
  `GitCore.readRemoteConfig` with `GitRemote` / `GitBranchConfig` / `GitRemoteConfig`.
- `contracts: test ids …`: `changeRequestChip`, `changeRequestBadge`, `settingsForgesEnabled`, `forgeCliStatus`.

## Known gaps

- GitLab has not been run against a signed-in `glab` (there is no GitLab login on this machine). The parsers use
  real gitlab.com responses, and the client was tested with a fake `glab` and the real 1.128 binary.
- No writes, no other forges, no "compare against the PR base" scope (that needs fetching), and sync is only
  `same`/`differs`. All listed in `docs/FORGES.md` "Not done".
- The `glab` binary used for checks lives in `~/.cache/octopus-diff-dev/glab/` (release v1.128.0, SHA-256 checked).
  It is not on PATH.

## Notes for integration

- New workspace package `@octopus-diff/forge`; the daemon depends on it. The CLI gets it through the daemon, so its
  packaging needs no change. Run `pnpm install` after merging.
- `internal.forges` in daemon options injects a fake client, or `false` disables the service, for tests.
- `e2e/support/env.ts` was changed (DECISIONS #70).
- `apps/web/test/ux.test.tsx` and e2e specs 09 and 13 were updated for the seventh settings section and the
  `forges` settings default.
