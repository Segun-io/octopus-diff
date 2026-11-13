# File explorer bench (2026-11-13T13:13:03.306Z)

Layout `large`: 100000 tracked files. Times in ms (HTTP round trip on loopback, identity encoding).

| worktree | dir | entries | bytes | first request of the worktree | first listing of the dir (root: a repeat) | warm p50 | warm p95 | warm CPU/req | tree view warm p95 |
|---|---|---|---|---|---|---|---|---|---|
| main | root `/` | 4 | 821 | 527 | 1.6 | 0.89 | 1.19 | 0.67 | 1.42 |
| main | middle `apps/app3/packages` | 10 | 1836 |  | 8.58 | 0.81 | 1.1 | 0.67 | 1.34 |
| main | leaf `apps/app5/packages/pkg7/src/mod2/sub4` | 25 | 4745 |  | 14.42 | 0.85 | 1.05 | 0.67 | 1.44 |
| stale-index | root `/` | 4 | 809 | 206 | 1.12 | 0.78 | 1.01 | 0.33 | 1.43 |
| stale-index | middle `apps/app3/packages` | 10 | 1836 |  | 1.53 | 0.79 | 1.06 | 0.67 | 1.46 |
| stale-index | leaf `apps/app5/packages/pkg7/src/mod2/sub4` | 25 | 4745 |  | 1.4 | 0.79 | 0.89 | 0.67 | 1.58 |
| untracked-heavy | root `/` | 4 | 836 | 206 | 1.01 | 0.73 | 0.82 | 0.67 | 1.32 |
| untracked-heavy | middle `apps/app3/packages` | 10 | 1836 |  | 1.36 | 0.74 | 0.82 | 0.33 | 1.41 |
| untracked-heavy | leaf `apps/app5/packages/pkg7/src/mod2/sub4` | 25 | 4745 |  | 1.36 | 0.82 | 0.98 | 0.67 | 1.16 |

git-core in process: ls-tree of the root (cold, with commit → root tree) p50 6.18 ms; ls-tree -r of the root p50 39.91 ms (100002 files). A full path list as JSON: 5312001 bytes.

Every directory (tree view, one request each): 4980 requests, 104981 entries, 19735042 bytes, 16403 ms, daemon CPU 5630 ms.
