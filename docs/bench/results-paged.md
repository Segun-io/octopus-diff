# Paged file lists bench (#42)

2026-11-13T01:21:45.354Z, linux 6.18.58.1-microsoft-standard-WSL2, 12 cores, Node 26.13.0. Layout `large-paged`: 40000 tracked files, 36000 of them rewritten in the `many-changed` worktree (generated in 5280 ms); daemon ready (every summary) in 5047 ms. Page size 500.

## `GET /files` of the many-changed worktree

| Scope | Files | Unpaged (old client): rows, raw / gzip | cold (CPU) / warm | Paged: pages, first page time and size | largest page | all pages | complete |
|---|---|---|---|---|---|---|---|
| working | 36150 | 2000 (truncated), 549.3 KiB / 57.8 KiB | 2049 ms (2960 ms) / 10 ms (10 ms) | 73, 8 ms, 137.5 KiB (14.8 KiB gzip) | 137.6 KiB | 270 ms | true (36150 rows, 0 duplicates) |
| All on branch | 36150 | 2000 (truncated), 549.4 KiB / 57.8 KiB | 2083 ms (2870 ms) / 10 ms (10 ms) | 73, 4 ms, 137.6 KiB (14.8 KiB gzip) | 137.6 KiB | 297 ms | true (36150 rows, 0 duplicates) |

## `GET /api/inbox`

| Scope | Rows sent / files | Raw / gzip | First / warm |
|---|---|---|---|
| working | 800 / 37901 | 215.4 KiB / 27.6 KiB | 81 ms / 6 ms |
| All on branch | 800 / 37901 | 215.4 KiB / 27.6 KiB | 81 ms / 8 ms |

## Web

- App opened on the worktree (navigation → first file row), a fresh browser profile with the daemon's list of the worktree already computed (the `/files` phase above did it; a first open on a fresh daemon also waits for the cold list, 2049 ms): 180 ms; reload 118 ms.
- Opened from another worktree (click on its row → first file row): 119 ms; 49 rows mounted.
- One edit in the open worktree: `worktree.changed` after 4124 ms, then 23.2 KiB of `/api/*` traffic on the wire (3 requests: /api/worktrees/d7ffe5b84def9b92/activity 734, /api/inbox?worktreeIds 7343, /api/worktrees/d7ffe5b84def9b92/files?limit=500 15671).

Re-run: `pnpm --filter @octopus-diff/e2e bench:paged`.
