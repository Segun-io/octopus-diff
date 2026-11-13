/**
 * Event-loop cost of starting git (roadmap #45): runs `git status` through the runner while the
 * main process retains a large V8 heap, with the spawn helper on and off, and reports the wall
 * time, the main thread's event-loop utilization and the event-loop delay. Not part of
 * `pnpm test`. Run from the repo root:
 *
 *   pnpm exec tsx --conditions=@octopus-diff/source packages/git-core/test/bench/spawn-helper.bench.ts [runs] [heapMiB,...]
 *
 * Defaults: 640 runs at concurrency 4, retained heap 0,100,1000 MiB. Each configuration runs in
 * a fresh child process (`--child`), so one heap does not distort the next.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eventLoopUtilization, monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { GitRunner } from '../../src/index.js';

const self = fileURLToPath(import.meta.url);

interface Sample {
  /** 0: direct spawn; n: n helper processes. */
  helper: number;
  heapMiB: number;
  runs: number;
  rssMiB: number;
  wallMs: number;
  /** Main-thread busy time during the runs (eventLoopUtilization().active). */
  busyMs: number;
  /** Busy time per git process. */
  busyPerSpawnMs: number;
  delayP50Ms: number;
  delayP99Ms: number;
  delayMaxMs: number;
}

/** Retains `mib` MiB of V8 heap (double arrays, touched so they are resident). */
function retainHeap(mib: number): unknown[] {
  const keep: unknown[] = [];
  const perArray = 8 * 1024 * 1024; // 64 MiB of doubles
  let left = Math.floor((mib * 1024 * 1024) / 8);
  while (left > 0) {
    const n = Math.min(perArray, left);
    const array = new Array<number>(n);
    for (let i = 0; i < n; i++) array[i] = i + 0.5;
    keep.push(array);
    left -= n;
  }
  return keep;
}

async function child(
  helper: number,
  heapMiB: number,
  runs: number,
  repo: string,
  env: Record<string, string>,
) {
  const keep = retainHeap(heapMiB);
  const runner = new GitRunner({
    concurrency: 4,
    env,
    helper: helper > 0 ? { processes: helper } : false,
  });
  // Warm up: the helper starts lazily, and the first spawns page in git itself.
  await Promise.all(
    Array.from({ length: 8 }, () => runner.run(['status', '--porcelain=v2', '-z'], { cwd: repo })),
  );
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const elu0 = eventLoopUtilization();
  const started = performance.now();
  await Promise.all(
    Array.from({ length: runs }, () =>
      runner.run(['status', '--porcelain=v2', '-z'], { cwd: repo }),
    ),
  );
  const wallMs = performance.now() - started;
  const elu = eventLoopUtilization(elu0);
  histogram.disable();
  const sample: Sample = {
    helper,
    heapMiB,
    runs,
    rssMiB: Math.round(process.memoryUsage().rss / 1048576),
    wallMs: Math.round(wallMs),
    busyMs: Math.round(elu.active),
    busyPerSpawnMs: Number((elu.active / runs).toFixed(3)),
    delayP50Ms: Number((histogram.percentile(50) / 1e6).toFixed(2)),
    delayP99Ms: Number((histogram.percentile(99) / 1e6).toFixed(2)),
    delayMaxMs: Number((histogram.max / 1e6).toFixed(2)),
  };
  await runner.dispose();
  process.stdout.write(`${JSON.stringify(sample)}\n`);
  keep.length = 0;
}

async function main(): Promise<void> {
  if (process.argv[2] === '--child') {
    const [, , , helper, heap, runs, repo, env] = process.argv;
    await child(
      Number(helper),
      Number(heap),
      Number(runs),
      repo as string,
      JSON.parse(env as string),
    );
    return;
  }
  const runs = Number(process.argv[2] ?? 640);
  const heaps = (process.argv[3] ?? '0,100,1000').split(',').map(Number);
  const root = mkdtempSync(path.join(os.tmpdir(), 'octopus-diff-bench-'));
  try {
    const configFile = path.join(root, '.gitconfig');
    writeFileSync(
      configFile,
      // AGENTS.md: the fixture's git config is isolated and explicit.
      [
        '[user]',
        '\tname = Bench',
        '\temail = bench@example.com',
        '[init]',
        '\tdefaultBranch = main',
        '[commit]',
        '\tgpgsign = false',
        '[core]',
        '\tautocrlf = false',
        '',
      ].join('\n'),
    );
    const env = { GIT_CONFIG_GLOBAL: configFile, GIT_CONFIG_NOSYSTEM: '1' };
    const repo = path.join(root, 'repo');
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: root, env: { ...process.env, ...env } });
    git(['init', '-q', '-b', 'main', repo]);
    for (let i = 0; i < 200; i++) writeFileSync(path.join(repo, `f${i}.txt`), `line ${i}\n`);
    git(['-C', repo, 'add', '.']);
    git(['-C', repo, 'commit', '-q', '-m', 'init']);
    writeFileSync(path.join(repo, 'f1.txt'), 'changed\n');
    const results: Sample[] = [];
    for (const heapMiB of heaps) {
      for (const helper of [0, 1, 2]) {
        const out = spawnSync(
          process.execPath,
          [
            ...process.execArgv,
            '--max-old-space-size=4096',
            self,
            '--child',
            String(helper),
            String(heapMiB),
            String(runs),
            repo,
            JSON.stringify(env),
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
        );
        const line = out.stdout.trim().split('\n').pop() ?? '';
        const sample = JSON.parse(line) as Sample;
        results.push(sample);
        console.error(JSON.stringify(sample));
      }
    }
    console.log(`\n${runs} x git status at concurrency 4, Node ${process.version}\n`);
    console.log(
      '| Retained heap | RSS | Path | Wall | Main-thread busy | Busy per spawn | Loop delay p50 / p99 / max |',
    );
    console.log('|---|---|---|---|---|---|---|');
    for (const s of results) {
      console.log(
        `| ${s.heapMiB} MiB | ${s.rssMiB} MiB | ${s.helper > 0 ? `${s.helper} helper${s.helper > 1 ? 's' : ''}` : 'direct'} | ${s.wallMs} ms | ${s.busyMs} ms | ${s.busyPerSpawnMs} ms | ${s.delayP50Ms} / ${s.delayP99Ms} / ${s.delayMaxMs} ms |`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
