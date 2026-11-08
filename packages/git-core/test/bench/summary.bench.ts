/**
 * Rough timing for the PLAN §8 perf target (30 repos x 3 worktrees, initial paint < 3 s).
 * Not part of `pnpm test`. Run from the repo root:
 *
 *   pnpm exec tsx --conditions=@octopus-diff/source packages/git-core/test/bench/summary.bench.ts [repos]
 */
import path from 'node:path';
import type { WorktreeLocator } from '@octopus-diff/contracts';
import { createGitCore, hashId } from '../../src/index.js';
import { createFixture, lines } from '../helpers/fixture.js';

const REPOS = Number(process.argv[2] ?? 30);
const FILES_PER_REPO = 200;

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  console.log(`${label.padEnd(48)} ${(performance.now() - start).toFixed(0).padStart(6)} ms`);
  return result;
}

async function main(): Promise<void> {
  const fx = createFixture('octopus-diff-bench-');
  try {
    const locators: WorktreeLocator[] = [];
    const setupStart = performance.now();
    for (let r = 0; r < REPOS; r += 1) {
      const files: Record<string, string> = {};
      for (let f = 0; f < FILES_PER_REPO; f += 1)
        files[`src/dir${f % 10}/file${f}.ts`] = lines(40, `r${r}f${f}`);
      const repo = fx.repo(`repo-${r}`, { files });
      const commonDir = path.join(repo, '.git');
      const worktrees = [repo];
      for (let w = 1; w <= 2; w += 1) {
        const wt = path.join(fx.root, 'worktrees', `repo-${r}-wt${w}`);
        fx.git(repo, ['worktree', 'add', '-q', '-b', `agent/${w}`, wt]);
        worktrees.push(wt);
      }
      worktrees.forEach((wt, i) => {
        // Two thirds of the worktrees are dirty: a few edits and an untracked file.
        if ((r + i) % 3 !== 0) {
          for (let f = 0; f < 5; f += 1) {
            fx.write(path.join(wt, `src/dir${f}/file${f}.ts`), lines(42, `edited${i}`));
          }
          fx.write(path.join(wt, `notes-${i}.md`), lines(10, 'note'));
        }
        locators.push({ projectId: hashId(commonDir), worktreeId: hashId(wt), path: wt });
      });
    }
    console.log(
      `setup: ${REPOS} repos, ${locators.length} worktrees in ${((performance.now() - setupStart) / 1000).toFixed(1)} s`,
    );

    const core = createGitCore(fx.coreOptions());
    await core.version();
    const summaries = await time(`getSummary x${locators.length} (cold, concurrency 4)`, () =>
      Promise.all(locators.map((wt) => core.getSummary(wt))),
    );
    await time(`getSummary x${locators.length} (warm)`, () =>
      Promise.all(locators.map((wt) => core.getSummary(wt))),
    );
    const dirty = locators.filter((_, i) => (summaries[i]?.changedFiles ?? 0) > 0);
    const lists = await time(`listChangedFiles(working) x${dirty.length} dirty`, () =>
      Promise.all(dirty.map((wt) => core.listChangedFiles(wt, { kind: 'working' }))),
    );
    const first = dirty[0];
    const file = lists[0]?.[0];
    if (first && file) {
      await time('getFileDiff (one file)', () =>
        core.getFileDiff(first, { kind: 'working' }, file),
      );
    }
    const wide = createGitCore(fx.coreOptions({ concurrency: 8 }));
    await wide.version();
    await time(`getSummary x${locators.length} (cold, concurrency 8)`, () =>
      Promise.all(locators.map((wt) => wide.getSummary(wt))),
    );
    await Promise.all([core.dispose(), wide.dispose()]);
  } finally {
    fx.dispose();
  }
}

await main();
