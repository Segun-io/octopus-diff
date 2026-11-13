# File explorer bench (2026-11-13T13:55:30.843Z)

Layout `large`: 100000 tracked files. Times in ms (HTTP round trip on loopback, identity encoding).

| worktree | dir | entries | bytes | first request of the worktree | first listing of the dir (root: a repeat) | warm p50 | warm p95 | warm CPU/req | tree view warm p95 |
|---|---|---|---|---|---|---|---|---|---|
| main | root `/` | 4 | 821 | 526 | 1.65 | 0.86 | 1.25 | 1 | 1.46 |
| main | middle `apps/app3/packages` | 10 | 1836 |  | 8.39 | 0.81 | 0.94 | 0.67 | 1.43 |
| main | leaf `apps/app5/packages/pkg7/src/mod2/sub4` | 25 | 4745 |  | 14.79 | 0.81 | 1.02 | 1 | 1.35 |
| stale-index | root `/` | 4 | 809 | 207 | 1.12 | 0.75 | 1.02 | 0.33 | 1.4 |
| stale-index | middle `apps/app3/packages` | 10 | 1836 |  | 1.8 | 0.77 | 0.97 | 0.67 | 1.29 |
| stale-index | leaf `apps/app5/packages/pkg7/src/mod2/sub4` | 25 | 4745 |  | 1.64 | 0.76 | 0.88 | 0.67 | 1.55 |
| untracked-heavy | root `/` | 4 | 836 | 206 | 0.95 | 0.72 | 0.84 | 0.33 | 1.2 |
| untracked-heavy | middle `apps/app3/packages` | 10 | 1836 |  | 1.34 | 0.75 | 0.9 | 0.33 | 1.3 |
| untracked-heavy | leaf `apps/app5/packages/pkg7/src/mod2/sub4` | 25 | 4745 |  | 1.41 | 0.76 | 0.94 | 0.33 | 1.24 |

git-core in process: ls-tree of the root (cold, with commit → root tree) p50 6.27 ms; ls-tree -r of the root p50 38.76 ms (100002 files). A full path list as JSON: 5312001 bytes.

Every directory (tree view, one request each): 4980 requests, 104981 entries, 19735042 bytes, 16062 ms, daemon CPU 5390 ms.
