# File explorer bench (2026-11-13T12:22:21.660Z)

Layout `large`: 100000 tracked files. Times in ms (HTTP round trip on loopback, identity encoding).

| worktree | dir | entries | bytes | first request of the worktree | first listing of the dir (root: a repeat) | warm p50 | warm p95 | warm CPU/req | tree view warm p95 |
|---|---|---|---|---|---|---|---|---|---|
| main | root `/` | 4 | 821 | 1215 | 5.13 | 1.52 | 4.4 | 1 | 5.78 |
| main | middle `apps/app3/packages` | 10 | 1836 |  | 15.91 | 1.36 | 2.92 | 0.67 | 4.05 |
| main | leaf `apps/app5/packages/pkg7/src/mod2/sub4` | 25 | 4745 |  | 22.92 | 1.37 | 3.94 | 0.67 | 8.35 |
| stale-index | root `/` | 4 | 809 | 387 | 7.26 | 1.31 | 3.06 | 0.67 | 2.78 |
| stale-index | middle `apps/app3/packages` | 10 | 1836 |  | 4.1 | 1.11 | 3.85 | 0.33 | 2.66 |
| stale-index | leaf `apps/app5/packages/pkg7/src/mod2/sub4` | 25 | 4745 |  | 1.27 | 1.21 | 2.93 | 0.67 | 3.84 |
| untracked-heavy | root `/` | 4 | 836 | 406 | 4.47 | 1.09 | 2.83 | 0.67 | 2.72 |
| untracked-heavy | middle `apps/app3/packages` | 10 | 1836 |  | 4.11 | 1.07 | 1.88 | 0.67 | 2.38 |
| untracked-heavy | leaf `apps/app5/packages/pkg7/src/mod2/sub4` | 25 | 4745 |  | 2.3 | 1.1 | 2.37 | 1 | 1.99 |

git-core in process: ls-tree of the root (cold, with commit → root tree) p50 9.56 ms; ls-tree -r of the root p50 67.57 ms (100002 files). A full path list as JSON: 5312001 bytes.

Every directory (tree view, one request each): 4980 requests, 104981 entries, 19735042 bytes, 21325 ms, daemon CPU 6880 ms.
