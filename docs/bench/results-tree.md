# File explorer bench (2026-11-13T11:20:31.228Z)

Layout `large`: 100000 tracked files. Times in ms (HTTP round trip on loopback, identity encoding).

| worktree | dir | entries | bytes | first request of the worktree | first listing of the dir (root: a repeat) | warm p50 | warm p95 | warm CPU/req | tree view warm p95 |
|---|---|---|---|---|---|---|---|---|---|
| main | root `/` | 4 | 821 | 579 | 1.59 | 0.91 | 1.32 | 0.67 | 1.36 |
| main | middle `apps/app3/packages` | 10 | 1836 |  | 8.03 | 0.89 | 1.14 | 0.67 | 1.45 |
| main | leaf `apps/app5/packages/pkg7/src/mod2/sub4` | 25 | 4745 |  | 14.41 | 0.93 | 1.16 | 0.67 | 1.58 |
| stale-index | root `/` | 4 | 809 | 200 | 1.52 | 0.82 | 1.06 | 0.67 | 1.37 |
| stale-index | middle `apps/app3/packages` | 10 | 1836 |  | 0.93 | 0.8 | 0.99 | 0.67 | 1.25 |
| stale-index | leaf `apps/app5/packages/pkg7/src/mod2/sub4` | 25 | 4745 |  | 0.86 | 0.8 | 0.92 | 0.33 | 1.42 |
| untracked-heavy | root `/` | 4 | 836 | 234 | 1.01 | 0.8 | 0.97 | 0.67 | 2.62 |
| untracked-heavy | middle `apps/app3/packages` | 10 | 1836 |  | 0.75 | 0.78 | 0.9 | 0.67 | 1.22 |
| untracked-heavy | leaf `apps/app5/packages/pkg7/src/mod2/sub4` | 25 | 4745 |  | 0.89 | 0.8 | 0.88 | 0.33 | 1.35 |

git-core in process: ls-tree of the root (cold, with commit → root tree) p50 7.06 ms; ls-tree -r of the root p50 45.73 ms (100002 files). A full path list as JSON: 5312001 bytes.

Every directory (tree view, one request each): 4980 requests, 104981 entries, 19735042 bytes, 16967 ms, daemon CPU 5560 ms.
