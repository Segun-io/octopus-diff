/**
 * Perf bench (PLAN §6 WS4, §8 item 10): N repos × M worktrees (default 30 × 3).
 *
 * Measures, against the built daemon running as a child process:
 * - daemon startup (spawn → listening → every summary computed),
 * - time to first paint (navigation → `[data-testid=app][data-ready=true]`), cold and warm,
 * - idle CPU of the daemon process incl. its git children (`/proc/<pid>/stat`), with the UI open,
 * - single-file refresh latency: file write → SSE `worktree.changed`, and → sidebar update in the UI.
 *
 * Usage: pnpm --filter @octopus-diff/fixtures bench [-- --idle-seconds 60 --iterations 15 ...]
 * Writes docs/bench/results.json and docs/bench/results.md (override with --out <dir>).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createApiClient, type ServerEvent, TEST_IDS } from '@octopus-diff/contracts';
import {
  type FixtureSet,
  generateFixtures,
  registeredProjects,
  runGit,
  sampleProcessCpu,
  summarize,
} from '@octopus-diff/fixtures';
import { type Browser, chromium, type Page } from '@playwright/test';
import {
  applyChromiumLibraryPath,
  assertBuilt,
  E2E_DIR,
  REPO_ROOT,
  WEB_DIST,
  webUiProblem,
} from '../support/env.js';

const { values: args } = parseArgs({
  options: {
    repos: { type: 'string', default: '30' },
    worktrees: { type: 'string', default: '3' },
    'idle-seconds': { type: 'string', default: '60' },
    iterations: { type: 'string', default: '15' },
    out: { type: 'string', default: join(REPO_ROOT, 'docs', 'bench') },
    'no-ui': { type: 'boolean', default: false },
    seed: { type: 'string', default: '1' },
  },
});

const TARGETS = { firstPaintMs: 3000, idleCpuPercent: 10, refreshMs: 1000 };

function log(message: string) {
  process.stderr.write(`[bench] ${message}\n`);
}

interface ChildDaemon {
  child: ChildProcess;
  url: string;
  authUrl: string;
  token: string;
}

async function spawnDaemon(fixtures: FixtureSet, stateBase: string): Promise<ChildDaemon> {
  const token = randomBytes(24).toString('hex');
  const options = {
    host: '127.0.0.1',
    port: 0,
    token,
    stateDir: join(stateBase, 'state'),
    configDir: join(stateBase, 'config'),
    webRoot: WEB_DIST,
    projects: registeredProjects(fixtures.manifest).flatMap((p) =>
      p.registration?.kind === 'path' ? [p.registration.path] : [],
    ),
    git: { env: { ...fixtures.manifest.git.vars } },
    logLevel: 'warn',
    version: 'bench',
  };
  const child = spawn(process.execPath, [join(E2E_DIR, 'bench', 'daemon-child.mjs')], {
    cwd: E2E_DIR,
    env: { ...process.env, OCTOPUS_BENCH_DAEMON_OPTIONS: JSON.stringify(options) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
  const first = await new Promise<string>((resolve, reject) => {
    lines.once('line', resolve);
    child.once('exit', (code) => reject(new Error(`daemon child exited early (code ${code})`)));
  });
  const message = JSON.parse(first) as {
    ready: boolean;
    url?: string;
    authUrl?: string;
    error?: string;
  };
  if (!message.ready || !message.url || !message.authUrl) {
    throw new Error(
      `daemon failed to start: ${message.error}${/placeholder/i.test(message.error ?? '') ? ' (merge WS2 and run `pnpm build`)' : ''}`,
    );
  }
  return { child, url: message.url, authUrl: message.authUrl, token };
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await exited;
  clearTimeout(timer);
}

async function waitForSummaries(
  client: ReturnType<typeof createApiClient>,
  expected: number,
  timeoutMs = 120_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { projects } = await client.listProjects();
    const worktrees = projects.flatMap((p) => p.worktrees);
    if (
      projects.length >= expected &&
      worktrees.every((w) => w.summary !== null || w.error !== null)
    ) {
      return worktrees.length;
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for summaries');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function firstPaint(page: Page, url: string): Promise<{ ms: number; fcp: number | null }> {
  const started = performance.now();
  await page.goto(url);
  await page
    .locator(`[data-testid="${TEST_IDS.app}"][data-ready="true"]`)
    .waitFor({ timeout: 60_000 });
  const ms = performance.now() - started;
  const fcp = await page.evaluate(
    () => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
  );
  return { ms, fcp };
}

async function main() {
  assertBuilt();
  const repos = Number(args.repos);
  const worktreesPerRepo = Number(args.worktrees);
  const idleMs = Number(args['idle-seconds']) * 1000;
  const iterations = Number(args.iterations);
  const uiProblem = args['no-ui'] ? 'disabled with --no-ui' : webUiProblem();
  if (uiProblem) log(`UI metrics skipped: ${uiProblem.split('\n')[0]}`);

  log(`generating ${repos} repos × ${worktreesPerRepo} worktrees…`);
  const genStarted = performance.now();
  const fixtures = await generateFixtures({
    seed: Number(args.seed),
    acceptance: false,
    bench: { repos, worktreesPerRepo },
    prefix: 'octopus-diff-bench-',
  });
  const generationMs = performance.now() - genStarted;
  let daemon: ChildDaemon | null = null;
  let browser: Browser | null = null;
  try {
    const stateBase = join(fixtures.root, 'daemon');
    const spawnStarted = performance.now();
    daemon = await spawnDaemon(fixtures, stateBase);
    const listeningMs = performance.now() - spawnStarted;
    const client = createApiClient({ baseUrl: daemon.url, token: daemon.token });
    const worktreeCount = await waitForSummaries(client, repos);
    const summariesMs = performance.now() - spawnStarted;
    log(
      `daemon pid ${daemon.child.pid}: listening ${listeningMs.toFixed(0)} ms, ${worktreeCount} summaries ${summariesMs.toFixed(0)} ms`,
    );

    const events: Array<{ at: number; event: ServerEvent }> = [];
    const sub = client.subscribe({ onEvent: (event) => events.push({ at: Date.now(), event }) });

    let page: Page | null = null;
    let paint: { cold: number; warm: number; fcp: number | null } | null = null;
    if (!uiProblem) {
      applyChromiumLibraryPath();
      browser = await chromium.launch();
      page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
      const cold = await firstPaint(page, daemon.authUrl);
      const warm = await firstPaint(page, daemon.url);
      paint = { cold: cold.ms, warm: warm.ms, fcp: cold.fcp };
      await page.locator(`[data-testid="${TEST_IDS.inboxItem}"]`).click();
      log(`first paint: cold ${cold.ms.toFixed(0)} ms, warm ${warm.ms.toFixed(0)} ms`);
    }

    log(`idle CPU: settling 5 s, then sampling ${idleMs / 1000} s…`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const idle = await sampleProcessCpu(daemon.child.pid as number, idleMs, 1000);
    log(
      `idle CPU: avg ${idle.averagePercent.toFixed(2)} %, max interval ${idle.maxIntervalPercent.toFixed(2)} %`,
    );

    // Refresh latency: append a line to a clean tracked file in a different worktree each time.
    const { projects } = await client.listProjects();
    const targets = projects
      .flatMap((p) => p.worktrees.map((w) => w.worktree))
      .filter((w) => !w.bare);
    const sse: number[] = [];
    const ui: number[] = [];
    const samples: Array<{ worktree: string; sseMs: number | null; uiMs: number | null }> = [];
    for (let i = 0; i < iterations; i++) {
      const target = targets[i % targets.length];
      if (!target) break;
      const selector = `[data-testid="${TEST_IDS.worktreeItem}"][data-worktree-id="${target.id}"]`;
      const before = page ? await page.locator(selector).getAttribute('data-additions') : null;
      const uiWait = page
        ? page
            .waitForFunction(
              ({ sel, prev }) => {
                const el = document.querySelector(sel);
                return el && el.getAttribute('data-additions') !== prev ? Date.now() : false;
              },
              { sel: selector, prev: before },
              { polling: 'raf', timeout: 10_000 },
            )
            .then((handle) => handle.jsonValue() as Promise<number>)
            .catch(() => null)
        : Promise.resolve(null);
      const mark = events.length;
      const started = Date.now();
      await appendFile(join(target.path, 'README.md'), `bench edit ${i}\n`);
      const sseAt = await new Promise<number | null>((resolve) => {
        const deadline = Date.now() + 10_000;
        const check = () => {
          const hit = events
            .slice(mark)
            .find((e) => e.event.type === 'worktree.changed' && e.event.worktreeId === target.id);
          if (hit) resolve(hit.at);
          else if (Date.now() > deadline) resolve(null);
          else setTimeout(check, 5);
        };
        check();
      });
      const uiAt = await uiWait;
      const sample = {
        worktree: target.path,
        sseMs: sseAt === null ? null : sseAt - started,
        uiMs: uiAt === null ? null : uiAt - started,
      };
      samples.push(sample);
      if (sample.sseMs !== null) sse.push(sample.sseMs);
      if (sample.uiMs !== null) ui.push(sample.uiMs);
      log(
        `refresh ${i + 1}/${iterations}: SSE ${sample.sseMs ?? 'timeout'} ms, UI ${sample.uiMs ?? (page ? 'timeout' : 'n/a')} ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    sub.close();

    const gitVersion = (
      await runGit(['--version'], { cwd: fixtures.root, env: fixtures.env })
    ).stdout
      .toString()
      .trim();
    const sseStats = summarize(sse);
    const uiStats = summarize(ui);
    const result = {
      generatedAt: new Date().toISOString(),
      environment: {
        platform: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model ?? 'unknown',
        cores: cpus().length,
        node: process.version,
        git: gitVersion,
      },
      layout: {
        repos,
        worktreesPerRepo,
        worktrees: worktreeCount,
        generationMs: Math.round(generationMs),
      },
      startup: { listeningMs: Math.round(listeningMs), allSummariesMs: Math.round(summariesMs) },
      firstPaint: paint
        ? {
            coldMs: Math.round(paint.cold),
            warmMs: Math.round(paint.warm),
            firstContentfulPaintMs: paint.fcp,
          }
        : { skipped: uiProblem },
      idleCpu: idle,
      refresh: { iterations, sse: sseStats, ui: page ? uiStats : { skipped: uiProblem }, samples },
      targets: TARGETS,
      pass: {
        firstPaint: paint ? paint.cold < TARGETS.firstPaintMs : null,
        idleCpu: idle.supported ? idle.averagePercent < TARGETS.idleCpuPercent : null,
        refreshSse: sse.length === iterations ? sseStats.p95 < TARGETS.refreshMs : false,
        refreshUi: page ? ui.length === iterations && uiStats.p95 < TARGETS.refreshMs : null,
      },
    };
    await mkdir(args.out, { recursive: true });
    await writeFile(join(args.out, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(join(args.out, 'results.md'), markdown(result));
    process.stdout.write(markdown(result));
    log(`wrote ${join(args.out, 'results.json')} and results.md`);
  } finally {
    await browser?.close().catch(() => {});
    if (daemon) await stopChild(daemon.child);
    await fixtures.cleanup();
  }
}

function fmt(value: number | null | undefined, unit = ' ms'): string {
  return value === null || value === undefined || Number.isNaN(value)
    ? 'n/a'
    : `${Math.round(value)}${unit}`;
}

function verdict(pass: boolean | null): string {
  return pass === null ? 'skipped' : pass ? 'PASS' : 'FAIL';
}

// biome-ignore lint/suspicious/noExplicitAny: report object assembled above.
function markdown(r: any): string {
  const fp = r.firstPaint.skipped ? null : r.firstPaint;
  const ui = r.refresh.ui.skipped ? null : r.refresh.ui;
  return `# octopus-diff perf bench

Generated ${r.generatedAt} · ${r.environment.platform} · ${r.environment.cpu} (${r.environment.cores} cores) · Node ${r.environment.node} · ${r.environment.git}

Layout: ${r.layout.repos} repos × ${r.layout.worktreesPerRepo} worktrees = ${r.layout.worktrees} worktrees (all dirty), generated in ${fmt(r.layout.generationMs)}.

| Metric | Result | Target (PLAN §8.10) | Verdict |
|---|---|---|---|
| Time to first paint (cold, \`data-ready\`) | ${fp ? fmt(fp.coldMs) : 'skipped'} | < ${r.targets.firstPaintMs} ms | ${verdict(r.pass.firstPaint)} |
| Time to first paint (warm reload) | ${fp ? fmt(fp.warmMs) : 'skipped'} | — | — |
| Idle CPU, daemon + git children (avg over ${Math.round(r.idleCpu.durationMs / 1000)} s) | ${r.idleCpu.supported ? `${r.idleCpu.averagePercent.toFixed(2)} %` : 'n/a'} | single-digit % | ${verdict(r.pass.idleCpu)} |
| Idle CPU, worst 1 s interval | ${r.idleCpu.supported ? `${r.idleCpu.maxIntervalPercent.toFixed(2)} %` : 'n/a'} | — | — |
| Refresh: write → SSE \`worktree.changed\` (p50 / p95 / max) | ${fmt(r.refresh.sse.p50)} / ${fmt(r.refresh.sse.p95)} / ${fmt(r.refresh.sse.max)} (${r.refresh.sse.count}/${r.refresh.iterations}) | < ${r.targets.refreshMs} ms | ${verdict(r.pass.refreshSse)} |
| Refresh: write → UI sidebar update (p50 / p95 / max) | ${ui ? `${fmt(ui.p50)} / ${fmt(ui.p95)} / ${fmt(ui.max)} (${ui.count}/${r.refresh.iterations})` : 'skipped'} | < ${r.targets.refreshMs} ms | ${verdict(r.pass.refreshUi)} |
| Daemon startup: listening / all summaries | ${fmt(r.startup.listeningMs)} / ${fmt(r.startup.allSummariesMs)} | — | — |
| Daemon RSS at end of idle | ${r.idleCpu.rssBytes ? `${Math.round(r.idleCpu.rssBytes / 1024 / 1024)} MiB` : 'n/a'} | — | — |

Raw numbers: \`results.json\` next to this file. Re-run: \`pnpm --filter @octopus-diff/fixtures bench\`.
`;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[bench] FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
