/**
 * API micro-bench for the UX round 1 daemon changes: `GET /api/projects`, `GET /api/inbox` and
 * `POST /api/review/bulk { all }` on the bench layout (default 30 repos × 3 worktrees). Runs the
 * daemon in-process from the package the current resolution picks (sources with
 * `--conditions=@octopus-diff/source`, else `dist`), so the same script can be run on an older
 * checkout for a before/after comparison; the bulk steps are skipped when the daemon has no
 * `/api/settings` (404).
 *
 * Usage: pnpm exec tsx --conditions=@octopus-diff/source e2e/support/api-bench.ts
 *          [--repos 30 --worktrees 3 --files 40 --dirty 3 --iterations 10 --json <file>]
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createApiClient } from '@octopus-diff/contracts';
import { startDaemon } from '@octopus-diff/daemon';
import { generateFixtures, registeredProjects, summarize } from '@octopus-diff/fixtures';

const { values: args } = parseArgs({
  options: {
    repos: { type: 'string', default: '30' },
    worktrees: { type: 'string', default: '3' },
    files: { type: 'string', default: '40' },
    dirty: { type: 'string', default: '3' },
    iterations: { type: 'string', default: '10' },
    json: { type: 'string' },
  },
});

function log(message: string) {
  process.stderr.write(`[api-bench] ${message}\n`);
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = performance.now();
  const value = await fn();
  return { ms: performance.now() - started, value };
}

async function repeat(n: number, fn: () => Promise<unknown>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await timed(fn)).ms);
  return out;
}

const fmt = (s: { p50: number; max: number }) =>
  `p50 ${s.p50.toFixed(1)} ms, max ${s.max.toFixed(1)} ms`;

async function main() {
  const repos = Number(args.repos);
  const worktreesPerRepo = Number(args.worktrees);
  const iterations = Number(args.iterations);
  log(
    `generating ${repos} × ${worktreesPerRepo} (${args.files} files/repo, ${args.dirty} dirty/worktree)…`,
  );
  const fixtures = await generateFixtures({
    seed: 7,
    acceptance: false,
    bench: {
      repos,
      worktreesPerRepo,
      filesPerRepo: Number(args.files),
      dirtyFilesPerWorktree: Number(args.dirty),
    },
    prefix: 'octopus-diff-apibench-',
  });
  const stateDir = join(tmpdir(), `octopus-diff-apibench-state-${randomBytes(4).toString('hex')}`);
  const daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: randomBytes(24).toString('hex'),
    stateDir,
    projects: registeredProjects(fixtures.manifest).flatMap((p) =>
      p.registration?.kind === 'path' ? [p.registration.path] : [],
    ),
    git: { env: { ...fixtures.manifest.git.vars } },
    logLevel: 'warn',
    version: 'api-bench',
  });
  try {
    const client = createApiClient({ baseUrl: daemon.url, token: daemon.token });
    const deadline = Date.now() + 120_000;
    let worktrees = 0;
    for (;;) {
      const { projects } = await client.listProjects();
      const all = projects.flatMap((p) => p.worktrees);
      if (projects.length >= repos && all.every((w) => w.summary !== null || w.error !== null)) {
        worktrees = all.length;
        break;
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for summaries');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const hasSettings = await client.getSettings().then(
      () => true,
      () => false,
    );
    log(
      `${worktrees} worktrees ready; settings routes: ${hasSettings ? 'yes' : 'no (older daemon)'}`,
    );

    const projectsMs = summarize(await repeat(iterations, () => client.listProjects()));
    let bulkCold: number | null = null;
    let undoMs: number | null = null;
    let changed: number | null = null;
    if (hasSettings) {
      const cold = await timed(() => client.bulkReview({ target: { kind: 'all' } }));
      bulkCold = cold.ms;
      changed = cold.value.changed;
      if (cold.value.undoToken) {
        undoMs = (await timed(() => client.undoReview({ undoToken: cold.value.undoToken ?? '' })))
          .ms;
      }
    }
    const inboxCold = (await timed(() => client.inbox())).ms;
    const inboxWarm = summarize(await repeat(iterations, () => client.inbox()));
    const inboxUnreviewed = summarize(
      await repeat(iterations, () => client.inbox({ onlyUnreviewed: true })),
    );
    let bulkWarm: number | null = null;
    let bulkClear: number | null = null;
    if (hasSettings) {
      bulkWarm = (await timed(() => client.bulkReview({ target: { kind: 'all' } }))).ms;
      bulkClear = (
        await timed(() => client.bulkReview({ target: { kind: 'all' }, reviewed: false }))
      ).ms;
    }
    const result = {
      generatedAt: new Date().toISOString(),
      node: process.version,
      layout: {
        repos,
        worktreesPerRepo,
        worktrees,
        filesPerRepo: Number(args.files),
        dirtyFilesPerWorktree: Number(args.dirty),
        changedFiles: changed,
      },
      iterations,
      listProjects: projectsMs,
      inboxColdMs: inboxCold,
      inboxWarm,
      inboxOnlyUnreviewed: inboxUnreviewed,
      bulkAllColdMs: bulkCold,
      undoMs,
      bulkAllWarmMs: bulkWarm,
      bulkAllClearWarmMs: bulkClear,
    };
    const lines = [
      `layout: ${repos} × ${worktreesPerRepo} = ${worktrees} worktrees, ${changed ?? '?'} changed files`,
      `GET /api/projects ×${iterations}: ${fmt(projectsMs)}`,
      `GET /api/inbox cold: ${inboxCold.toFixed(1)} ms; warm ×${iterations}: ${fmt(inboxWarm)}; onlyUnreviewed ×${iterations}: ${fmt(inboxUnreviewed)}`,
      hasSettings
        ? `POST /api/review/bulk all: cold ${bulkCold?.toFixed(1)} ms, warm ${bulkWarm?.toFixed(1)} ms, clear ${bulkClear?.toFixed(1)} ms; undo ${undoMs?.toFixed(1)} ms`
        : 'POST /api/review/bulk: not available on this daemon',
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    if (args.json) {
      await mkdir(dirname(args.json), { recursive: true });
      await writeFile(args.json, `${JSON.stringify(result, null, 2)}\n`);
      log(`wrote ${args.json}`);
    }
  } finally {
    await daemon.close();
    await fixtures.cleanup();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[api-bench] FAILED: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
