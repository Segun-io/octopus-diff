/**
 * Cost of opening one file's diff (roadmap #41): wall time and git spawns of `getFileDiff` in the
 * large layouts (tools/fixtures `generateLargeFixtures`), per worktree role and file kind, with the
 * summary state held (the daemon's situation: a summary and a list came first) and without it.
 * Not part of `pnpm test`. Run from the repo root (after `pnpm install`):
 *
 *   pnpm exec tsx --conditions=@octopus-diff/source packages/git-core/test/bench/diff-open.bench.ts [large|large-ci] [rounds]
 *
 * `OCTOPUS_DIFF_BENCH_OLD=1` reads the diffs with a core that has no summary route (`incremental: false`): the "before" column. Spawns are counted from the runner's debug log (every git process).
 */
import type { GitChangedFile, GitCore, WorktreeLocator } from '@octopus-diff/contracts';
import {
  generateLargeFixtures,
  type LargeLayoutName,
} from '../../../../tools/fixtures/src/large.js';
import { fileDiffRoutes } from '../../src/diff.js';
import { createGitCore, hashId } from '../../src/index.js';

const LAYOUT = (process.argv[2] ?? 'large') as LargeLayoutName;
const ROUNDS = Number(process.argv[3] ?? 15);
/** The whole-scope route only (`incremental: false`): the "before" numbers of #41. */
const OLD = process.env.OCTOPUS_DIFF_BENCH_OLD === '1';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

async function main(): Promise<void> {
  const started = performance.now();
  const set = await generateLargeFixtures({ layout: LAYOUT, prefix: 'octopus-diff-bench-' });
  console.log(
    `layout ${LAYOUT}: ${set.options.files} files in ${((performance.now() - started) / 1000).toFixed(1)} s`,
  );
  const spawns: string[][] = [];
  const logger = {
    debug(message: string, fields?: Record<string, unknown>) {
      const args = fields?.args;
      if (message === 'git' && Array.isArray(args) && args[0] !== 'config') {
        spawns.push(args.map(String));
      }
    },
    info() {},
    warn() {},
    error() {},
  };
  const core: GitCore = createGitCore({ env: { ...set.env.vars }, logger });
  // The whole-scope route: a core with no summary route reads the diffs (the summaries and lists
  // still come from `core`, since a full list of the stale-index worktree takes minutes).
  const reader: GitCore = OLD
    ? createGitCore({ env: { ...set.env.vars }, logger, incremental: false })
    : core;
  try {
    for (const worktree of set.worktrees) {
      const locator: WorktreeLocator = {
        projectId: hashId(`${set.projectPath}/.git`),
        worktreeId: hashId(worktree.path),
        path: worktree.path,
      };
      const t0 = performance.now();
      const summary = await core.getSummary(locator);
      const summaryMs = performance.now() - t0;
      const t1 = performance.now();
      const files = await core.listChangedFiles(
        locator,
        { kind: 'working' },
        { summaryState: summary.stateHash },
      );
      const listMs = performance.now() - t1;
      console.log(
        `\n== ${worktree.role}: summary ${summaryMs.toFixed(0)} ms, list ${listMs.toFixed(0)} ms (${files.length} files)`,
      );
      const pick = (predicate: (f: GitChangedFile) => boolean): GitChangedFile | undefined =>
        files.find(predicate);
      const targets: Array<[string, GitChangedFile | undefined]> = [
        ['modified', pick((f) => f.status === 'modified' && f.path.startsWith('apps/'))],
        ['untracked', pick((f) => f.status === 'untracked')],
        ['huge (rewrite)', pick((f) => f.path === 'docs/generated/huge.txt')],
        // Above the cap (#43) an untracked file is not listed: the whole route reads it.
        ...(worktree.role === 'untracked-heavy'
          ? ([
              [
                'omitted by the cap',
                { path: 'scratch/many/pkg0/d0/f0.txt', patchHash: '' } as GitChangedFile,
              ],
            ] as Array<[string, GitChangedFile]>)
          : []),
      ];
      for (const [label, file] of targets) {
        if (!file) continue;
        fileDiffRoutes.reasons.clear();
        const times: number[] = [];
        let spawned = 0;
        for (let round = 0; round < ROUNDS; round++) {
          spawns.length = 0;
          const t = performance.now();
          const diff = await reader.getFileDiff(locator, { kind: 'working' }, { path: file.path });
          times.push(performance.now() - t);
          if (file.patchHash !== '' && diff.patchHash !== file.patchHash)
            throw new Error(`patchHash differs for ${file.path}`);
          spawned = spawns.length;
        }
        const first = times[0] as number;
        console.log(
          `${label.padEnd(16)} ${file.path.slice(-34).padStart(34)}  first ${first.toFixed(0).padStart(5)} ms  median ${median(times).toFixed(0).padStart(5)} ms  min ${Math.min(
            ...times,
          )
            .toFixed(0)
            .padStart(
              5,
            )} ms  spawns ${spawned} (${spawns.map((a) => a[0]).join(',')})${fileDiffRoutes.reasons.size > 0 ? `  fallback: ${[...fileDiffRoutes.reasons.keys()].join(',')}` : ''}`,
        );
      }
    }
  } finally {
    await core.dispose();
    if (reader !== core) await reader.dispose();
    await set.cleanup();
  }
}

await main();
