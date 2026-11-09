# forge-details report

Implementation session, 2026-11-09, branch `feat/forge-details` (prepared worktree
`~/.t3/worktrees/octopus-diff/t3-cb92472d`, based on `main` at `6c53f1a`). Brief:
`/home/santosa/.claude/plans/you-are-planning-the-cosmic-abelson.md`. Design: `docs/FORGES.md`. Decisions #71–#80.

## Shipped

- **Phase A (existing data):** the batch query gained scalars only (`createdAt additions deletions changedFiles
  mergeStateStatus`; GitLab `createdAt`, `diffStatsSummary`), still 1 point (measured live). A request block in the
  sidebar hover card (`ChangeRequestHoverBlock`, `apps/web/src/components/ChangeRequest.tsx`) and a **Pull request**
  column on the project Overview. A GitHub `basic` batch variant for old GitHub Enterprise.
- **Phase B (repository information):** `GitCore.readRepositoryInfo` (`packages/git-core/src/repository.ts`, no
  allowlist change, credentials stripped from remote URLs), `GET /api/repositories` (`apps/daemon/src/repositories.ts`,
  30 s cache, dropped on project events), the forge repository query and `GET|POST /api/forges/projects/:id/repository`
  (10 min cache, open requests joined to worktrees), the allowlist **query registry** (`packages/forge/src/cli.ts`
  `QUERY_REGISTRY`), the project Overview's Local / Forge blocks and Open pull requests
  (`apps/web/src/components/RepositoryInfo.tsx`), and the folder Overview's columns and roll-ups (no forge query).
- **Phase C (Request tab, Summary):** detail query and route (60 s / 10 min caches, in-flight dedupe, 15 s forced
  refresh spacing, stale-while-error), `react-markdown` + `remark-gfm` with no raw HTML
  (`apps/web/src/components/request/Markdown.tsx`, `lib/markdown.ts`), `uiCsp(imageHosts)` and `forgeImageHosts`
  (`apps/daemon/src/security.ts`, `forges.ts`), the `forges.images` switch in Settings → Forges, the `request` view in
  `views/registry.ts` with `View.tab`, the Toolbar's `Changes | PR #n` control, and the Request tab header and Summary
  (`apps/web/src/components/request/`): reviewers with `stale`, labels, assignees, merge state, Description,
  Checks grouped with live refresh (45 s, only while running, visible, foreground, and with input in the last 20 min).
- **Phase D (conversation, Timeline, Files):** the conversation query and route; the Conversation section (comment,
  review and thread cards, resolved/dismissed collapsed, bot and resolved filters, newest/oldest, 10 per page,
  truncation banner); the Timeline; the Files tab with `changed here` markers that open the Changes tab on the file.
- Mock data for every look (`apps/web/mock/forge-details.ts`), a fixture recorder (`packages/forge/scripts/
  record-fixtures.ts`), screenshot states in `apps/web/scripts/shots.ts`, and screenshots in `docs/screenshots/`.

## Verification

All on 2026-11-09 in this worktree:

- `pnpm check` (lint + credits check + typecheck + build + unit tests): exit 0, about 35 s. contracts 81, forge 94
  (+4 live tests skipped by default), git-core 144, daemon 173, web 167, fixtures 48, cli 139, e2e-unit 5. Run again after the docs and
  credits changes: same counts, exit 0.
- `pnpm test:e2e`: **70 passed** (2.3 min), including the two new tests in `14-ui-forge-details.spec.ts`. The known
  `03-scopes` flake (DECISIONS #70) did not show this time.
- `OCTOPUS_FORGE_LIVE=1 pnpm --filter @octopus-diff/forge test`: 96 passed, 2 skipped (the glab ones). Live GitHub
  checks against public repositories through the real `gh` 2.46: the batch query on `cli/cli` and the repository,
  detail and conversation queries on `pingdotgg/t3code` each reported `rateLimit.cost` = 1 (asserted `<= 1`), and the
  normalisers accepted the live payloads (schema-parsed).
- `OCTOPUS_FORGE_LIVE=1 OCTOPUS_FORGE_GLAB=~/.cache/octopus-diff-dev/glab/x/bin/glab pnpm --filter @octopus-diff/forge
  test`: 98 passed. GitLab ran through the real `glab` 1.128 **signed out**, against gitlab.com's public GraphQL
  (`gitlab-org/cli`); every new GitLab query (full and basic variants) was also checked with `curl` against the public
  endpoint while designing them.
- Fixtures were recorded through the allowlisted runner (`packages/forge/scripts/record-fixtures.ts`): GitHub PR
  #32830 and repository of `pingdotgg/t3code` (each query cost 1), GitLab MR !4230 and project `gitlab-org/cli`.
- Screenshots from the mock dataset (Octopus Dark and Light, 1440×900) with `apps/web/scripts/shots.ts`.

## Decisions

#71–#80 in `docs/DECISIONS.md`:

- #71 contracts (and the one deviation: the per-check list is `checkList`, because `ChangeRequest.checks` already
  exists as the CI summary).
- #72 batch scalars only, GitHub `basic` batch variant, `rateLimit` on every GitHub query, the Overview column.
- #73 the allowlist query registry and inlined GitHub PR numbers.
- #74 CSP relaxed to signed-in forge hosts, `forges.images`, the `<img>` rules.
- #75 repository information: two routes, two sources, credential stripping.
- #76 the folder Overview runs no forge query.
- #77 markdown dependency and safety rules.
- #78 the Request tab as a registry view; bounded live refresh; daemon caches; routes keyed by id.
- #79 GitLab limits (GraphQL only, sections hide, unverified with a signed-in glab).
- #80 implementation notes (Files tab, conversation paging and filters, how the phases were committed).

## Contract changes

All additive, in `contracts:` commits:

- `90c7bde`: `ChangeRequest` optional `createdAt`, `additions`, `deletions`, `changedFiles`, `mergeState`;
  `ForgeActor`, `ChangeRequestLabel`, `ChangeRequestReviewer`, `ChangeRequestCheck`, `ChangeRequestCommit`,
  `ChangeRequestFile`, `ChangeRequestDetail`, `ChangeRequestComment`, `ChangeRequestReviewEntry`,
  `ChangeRequestThread`, `ChangeRequestConversation`, the two `*Response`s, `ForgeRepositoryInfo`,
  `ForgeRepositoryRequest`, `RepositoryForgeResponse`, `CHANGE_REQUEST_LIMITS`, TTL constants;
  `ForgeSettings.images?`; `GitRepositoryInfo` (domain.ts) and optional `GitCore.readRepositoryInfo`; routes
  `getChangeRequest`, `getChangeRequestConversation`, `refreshChangeRequest`, `getRepositoryForge`,
  `refreshRepositoryForge`, `listRepositories` with `RepositoriesQuerySchema` / `RepositoriesResponseSchema` and
  client methods; test ids.
- `2c12b0c`: test id `settingsForgesImages`.

## Dependencies

- Added to `apps/web`: `react-markdown` ^10.1.0 and `remark-gfm` ^4.0.1 (MIT). They bring the unified / micromark /
  mdast family: shipped packages 71 → 142, all within `allowedRuntimeLicenses` (the gate passed). `pnpm credits` was
  run and `CREDITS.md` + `apps/web/src/generated/credits.json` were committed with the dependency (`fb0ab25`).
- Ideas and wording adapted from T3 Code (MIT, `~/contrib/t3code`): `toCheckStatus`, check dedupe, `visibleBody`,
  `groupPullRequestChecks`, `describePullRequestChecks`, the summary/timeline layout. These small rules are attributed in
  comments and the three files were added to T3 Code's `adapted` entry in `scripts/credits/acknowledgements.json`
  (`pnpm credits` re-run).

## Known gaps

- **GitLab with a signed-in `glab` is unverified** (no GitLab login on this machine). Field names come from
  gitlab.com's public GraphQL and recorded responses; private-project behaviour, internal notes and the `basic`
  variants on old self-managed GitLab are untested live. Sections hide when data is missing.
- **Old GitHub Enterprise** `basic` variants (no `mergeStateStatus` / `latestOpinionatedReviews`) are tested with a
  fake CLI only.
- First page only: 50 comments/reviews/threads (10 replies each), 100 files, newest 100 commits, 100 checks; banners
  link to the forge. No pagination cursors (non-goal).
- Private-repository images (attachments needing cookies) do not load; they fall back to a link, as designed.
- The batch `ChangeRequest` (hover card) and the detail can briefly disagree on sizes until the next batch refresh.
- No palette command or shortcut for the Request tab (optional in the brief; not done).
- Phases C and D share one web commit (`427a91f`) because the Summary embeds the Conversation; the daemon routes for
  C and D are in the daemon commit `aa011d1`.
- In dev mode (`pnpm --filter @octopus-diff/web dev:mock`, the Vite dev server) the page fails with "Cannot access
  'CONTEXT_STEP' before initialization" (a `commands.ts` ↔ `commandRegistry.ts` import cycle). I did not touch those
  files; production builds (and `preview:mock`, used for the screenshots) are unaffected. Not investigated further.
- While stopping my own `dev:mock` process I ran `pkill -f mock/dev.ts` once; it can only have matched processes
  whose command line contained `mock/dev.ts` (mine, and the shell running pkill). I cannot rule out that another
  session's `dev:mock` was running at that moment; none was visible afterwards.

## Notes for integration

- `main` did not move during this session (`git log --oneline 6c53f1a..main` is empty at the time of writing).
- Run `pnpm install` after merging (two new web dependencies).
- `apps/web/scripts/shots.ts` gained the states `request`, `request-conversation`, `request-timeline`,
  `request-files` and `hover-card`.
- `e2e/tests/14-ui-forge-details.spec.ts` puts a fake `gh` first on `PATH` inside its worker process (the daemon runs
  in-process) and restores it after; the fake answers from `packages/forge/test/fixtures/`.
- Re-record the forge fixtures with `pnpm exec tsx --conditions=@octopus-diff/source
  packages/forge/scripts/record-fixtures.ts --glab ~/.cache/octopus-diff-dev/glab/x/bin/glab` (public repositories,
  through the allowlisted runner).
