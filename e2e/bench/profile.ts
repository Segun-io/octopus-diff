/**
 * Perf profiler (review/perf): goes beyond bench.ts by attributing time and CPU.
 *
 * Runs the built daemon as a child process with `spawn-trace.mjs` preloaded (every git process
 * is logged with subcommand, cwd and duration) and debug logs, then measures:
 * - startup: listening / all summaries, git spawns per phase, inotify instances and watches;
 * - idle: CPU per 1 s interval, correlated with the git spawns that ran in each interval;
 * - refresh: write → debounce fired → git work → SSE → UI, plus what the UI refetched (bytes,
 *   ms, browser main-thread time from CDP `Performance.getMetrics`);
 * - client cost of `/api/projects` and `/api/inbox` fetched directly;
 * - optional agent-simulator burst across many worktrees.
 *
 * Usage (from e2e/): pnpm exec tsx bench/profile.ts --out /tmp/x [--repos 30 --worktrees 3
 *   --files 40 --dirty 3 --idle-seconds 70 --iterations 8 --no-ui --cpu-prof --big-files 0
 *   --node-modules-files 0 --burst-seconds 0 --burst-worktrees 30 --log-level debug]
 * Writes <out>/profile.json, <out>/spawns.jsonl, <out>/daemon.log (and *.cpuprofile).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createApiClient, type ServerEvent, TEST_IDS } from '@octopus-diff/contracts';
import {
  type FixtureSet,
  generateFixtures,
  readProcCpu,
  registeredProjects,
  runGit,
  type SimulatorHandle,
  startAgentSimulator,
  summarize,
} from '@octopus-diff/fixtures';
import { type Browser, type CDPSession, chromium, type Page } from '@playwright/test';
import { applyChromiumLibraryPath, assertBuilt, E2E_DIR, WEB_DIST } from '../support/env.js';

const { values: args } = parseArgs({
  options: {
    repos: { type: 'string', default: '30' },
    worktrees: { type: 'string', default: '3' },
    files: { type: 'string', default: '40' },
    dirty: { type: 'string', default: '3' },
    'idle-seconds': { type: 'string', default: '70' },
    iterations: { type: 'string', default: '8' },
    out: { type: 'string' },
    'no-ui': { type: 'boolean', default: false },
    'cpu-prof': { type: 'boolean', default: false },
    'big-files': { type: 'string', default: '0' },
    'node-modules-files': { type: 'string', default: '0' },
    'burst-seconds': { type: 'string', default: '0' },
    'burst-worktrees': { type: 'string', default: '30' },
    'burst-min-ms': { type: 'string', default: '150' },
    'burst-max-ms': { type: 'string', default: '1200' },
    'log-level': { type: 'string', default: 'debug' },
    'select-worktree': { type: 'boolean', default: false },
    'git-concurrency': { type: 'string' },
    'refresh-target': { type: 'string' },
    'relist-ms': { type: 'string' },
    'large-diff-lines': { type: 'string', default: '0' },
    seed: { type: 'string', default: '1' },
  },
});

if (!args.out) throw new Error('--out <dir> is required');
const OUT = args.out;

function log(message: string) {
  process.stderr.write(`[profile] ${message}\n`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Spawn {
  t0: number;
  t1: number;
  ms: number;
  sub: string;
  args: string[];
  cwd: string | null;
  code: number | null;
}

async function readSpawns(file: string): Promise<Spawn[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Spawn);
}

function spawnStats(spawns: Spawn[]) {
  const bySub: Record<string, { count: number; totalMs: number; p50: number; p95: number }> = {};
  const groups = new Map<string, number[]>();
  for (const s of spawns) {
    const key = s.sub === 'diff' && s.args.includes('--numstat') ? 'diff --numstat' : s.sub;
    const key2 = s.sub === 'diff' && s.args.includes('--raw') ? 'diff --raw' : key;
    const list = groups.get(key2) ?? [];
    list.push(s.ms);
    groups.set(key2, list);
  }
  for (const [key, list] of groups) {
    const st = summarize(list);
    bySub[key] = {
      count: list.length,
      totalMs: Math.round(list.reduce((a, b) => a + b, 0)),
      p50: Math.round(st.p50 * 10) / 10,
      p95: Math.round(st.p95 * 10) / 10,
    };
  }
  return { total: spawns.length, bySub };
}

async function inotifyStats(pid: number) {
  let instances = 0;
  let watches = 0;
  const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
  for (const fd of fds) {
    const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
    if (link !== 'anon_inode:inotify') continue;
    instances++;
    const info = await readFile(`/proc/${pid}/fdinfo/${fd}`, 'utf8').catch(() => '');
    watches += info.split('\n').filter((l) => l.startsWith('inotify wd:')).length;
  }
  return { instances, watches, fds: fds.length };
}

async function memStats(pid: number) {
  const text = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
  const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0);
  return {
    rssMiB: Math.round(kb('VmRSS') / 1024),
    hwmMiB: Math.round(kb('VmHWM') / 1024),
    threads: kb('Threads'),
  };
}

interface CpuInterval {
  start: number;
  end: number;
  selfPct: number;
  childPct: number;
}

/** Samples CPU of `pid` (self + reaped children) per interval, with epoch timestamps. */
async function sampleCpu(pid: number, durationMs: number, intervalMs = 1000) {
  const hz = 100;
  let prev = await readProcCpu(pid);
  let prevAt = Date.now();
  const startedAt = prevAt;
  const intervals: CpuInterval[] = [];
  while (Date.now() - startedAt < durationMs) {
    await sleep(intervalMs);
    const cur = await readProcCpu(pid);
    const now = Date.now();
    const elapsed = now - prevAt;
    intervals.push({
      start: prevAt,
      end: now,
      selfPct: (((cur.selfTicks - prev.selfTicks) / hz) * 1000 * 100) / elapsed,
      childPct: (((cur.childTicks - prev.childTicks) / hz) * 1000 * 100) / elapsed,
    });
    prev = cur;
    prevAt = now;
  }
  const total = intervals.reduce((a, b) => a + (b.selfPct + b.childPct) * (b.end - b.start), 0);
  const self = intervals.reduce((a, b) => a + b.selfPct * (b.end - b.start), 0);
  const span = intervals.reduce((a, b) => a + (b.end - b.start), 0);
  return {
    intervals,
    averagePct: total / span,
    averageSelfPct: self / span,
    maxPct: Math.max(0, ...intervals.map((i) => i.selfPct + i.childPct)),
  };
}

interface DaemonChild {
  child: ChildProcess;
  url: string;
  authUrl: string;
  token: string;
  spawnFile: string;
  logLines: string[];
}

async function spawnDaemon(fixtures: FixtureSet, projects: string[]): Promise<DaemonChild> {
  const token = randomBytes(24).toString('hex');
  const spawnFile = join(OUT, 'spawns.jsonl');
  await writeFile(spawnFile, '');
  const options = {
    host: '127.0.0.1',
    port: 0,
    token,
    stateDir: join(fixtures.root, 'daemon', 'state'),
    configDir: join(fixtures.root, 'daemon', 'config'),
    webRoot: WEB_DIST,
    projects,
    git: {
      env: { ...fixtures.manifest.git.vars },
      ...(args['git-concurrency'] ? { concurrency: Number(args['git-concurrency']) } : {}),
    },
    logLevel: args['log-level'],
    version: 'profile',
    ...(args['relist-ms'] ? { internal: { relistMs: Number(args['relist-ms']) } } : {}),
  };
  const execArgv = ['--import', join(E2E_DIR, 'bench', 'spawn-trace.mjs')];
  if (args['cpu-prof']) execArgv.push('--cpu-prof', `--cpu-prof-dir=${OUT}`);
  const child = spawn(process.execPath, [...execArgv, join(E2E_DIR, 'bench', 'daemon-child.mjs')], {
    cwd: E2E_DIR,
    env: {
      ...process.env,
      OCTOPUS_BENCH_DAEMON_OPTIONS: JSON.stringify(options),
      OCTOPUS_SPAWN_TRACE: spawnFile,
      OCTOPUS_MEM_TRACE: join(OUT, 'mem.jsonl'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logLines: string[] = [];
  const logFile = createWriteStream(join(OUT, 'daemon.log'));
  createInterface({ input: child.stderr as NodeJS.ReadableStream }).on('line', (line) => {
    logLines.push(line);
    logFile.write(`${line}\n`);
  });
  const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
  const first = await new Promise<string>((resolve, reject) => {
    lines.once('line', resolve);
    child.once('exit', (code) => reject(new Error(`daemon child exited early (code ${code})`)));
  });
  const message = JSON.parse(first) as { ready: boolean; url?: string; authUrl?: string };
  if (!message.ready || !message.url || !message.authUrl) throw new Error(first);
  return { child, url: message.url, authUrl: message.authUrl, token, spawnFile, logLines };
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  await exited;
  clearTimeout(timer);
}

/** A repository with many tracked files (and optionally a big ignored node_modules). */
async function buildBigRepo(fixtures: FixtureSet, files: number, nodeModulesFiles: number) {
  const dir = join(fixtures.root, 'big', 'big-repo');
  await mkdir(dir, { recursive: true });
  const git = (a: string[]) => runGit(a, { cwd: dir, env: fixtures.env });
  await git(['init', '-q', '--initial-branch=main', '.']);
  const perDir = 100;
  for (let d = 0; d * perDir < files; d++) {
    const sub = join(dir, 'src', `pkg-${String(Math.floor(d / 20)).padStart(3, '0')}`, `d${d}`);
    await mkdir(sub, { recursive: true });
    const writes: Promise<void>[] = [];
    for (let f = 0; f < perDir && d * perDir + f < files; f++) {
      writes.push(writeFile(join(sub, `f${f}.ts`), `export const v${f} = ${d * perDir + f};\n`));
    }
    await Promise.all(writes);
  }
  await writeFile(join(dir, '.gitignore'), 'node_modules/\n');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'big: initial']);
  if (nodeModulesFiles > 0) {
    for (let d = 0; d * perDir < nodeModulesFiles; d++) {
      const sub = join(dir, 'node_modules', `dep-${Math.floor(d / 10)}`, `lib${d}`);
      await mkdir(sub, { recursive: true });
      const writes: Promise<void>[] = [];
      for (let f = 0; f < perDir && d * perDir + f < nodeModulesFiles; f++) {
        writes.push(writeFile(join(sub, `m${f}.js`), `module.exports = ${f};\n`));
      }
      await Promise.all(writes);
    }
  }
  // A few dirty files so it shows in the inbox.
  for (let i = 0; i < 5; i++) {
    await appendFile(join(dir, 'src', 'pkg-000', 'd0', `f${i}.ts`), '// edit\n');
  }
  return dir;
}

interface PageCost {
  scriptMs: number;
  taskMs: number;
  layoutMs: number;
  styleMs: number;
  heapMiB: number;
}

async function pageMetrics(cdp: CDPSession): Promise<PageCost> {
  const { metrics } = (await cdp.send('Performance.getMetrics')) as {
    metrics: Array<{ name: string; value: number }>;
  };
  const m = (name: string) => metrics.find((x) => x.name === name)?.value ?? 0;
  return {
    scriptMs: m('ScriptDuration') * 1000,
    taskMs: m('TaskDuration') * 1000,
    layoutMs: m('LayoutDuration') * 1000,
    styleMs: m('RecalcStyleDuration') * 1000,
    heapMiB: m('JSHeapUsedSize') / 1024 / 1024,
  };
}

function diffCost(a: PageCost, b: PageCost): PageCost {
  return {
    scriptMs: b.scriptMs - a.scriptMs,
    taskMs: b.taskMs - a.taskMs,
    layoutMs: b.layoutMs - a.layoutMs,
    styleMs: b.styleMs - a.styleMs,
    heapMiB: b.heapMiB,
  };
}

interface ResourceEntry {
  name: string;
  start: number;
  end: number;
  ttfb: number;
  bytes: number;
}

async function apiResources(page: Page, sinceEpoch: number): Promise<ResourceEntry[]> {
  return page.evaluate((since) => {
    const origin = performance.timeOrigin;
    return (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .filter((e) => e.name.includes('/api/') && origin + e.startTime >= since)
      .map((e) => ({
        name: new URL(e.name).pathname,
        start: origin + e.startTime,
        end: origin + e.responseEnd,
        ttfb: e.responseStart - e.requestStart,
        bytes: e.encodedBodySize,
      }));
  }, sinceEpoch);
}

function round(value: number, digits = 1) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

async function main() {
  assertBuilt();
  await mkdir(OUT, { recursive: true });
  const repos = Number(args.repos);
  const worktreesPerRepo = Number(args.worktrees);
  const idleMs = Number(args['idle-seconds']) * 1000;
  const iterations = Number(args.iterations);
  const bigFiles = Number(args['big-files']);
  const nodeModulesFiles = Number(args['node-modules-files']);
  const burstMs = Number(args['burst-seconds']) * 1000;
  const useUi = !args['no-ui'];

  log(`generating ${repos}×${worktreesPerRepo} (files ${args.files}, dirty ${args.dirty})…`);
  const genStarted = performance.now();
  const fixtures = await generateFixtures({
    seed: Number(args.seed),
    acceptance: false,
    bench: {
      repos,
      worktreesPerRepo,
      filesPerRepo: Number(args.files),
      dirtyFilesPerWorktree: Number(args.dirty),
    },
    prefix: 'octopus-diff-profile-',
  });
  const projects = registeredProjects(fixtures.manifest).flatMap((p) =>
    p.registration?.kind === 'path' ? [p.registration.path] : [],
  );
  let bigRepo: string | null = null;
  if (bigFiles > 0 || nodeModulesFiles > 0) {
    log(`building big repo: ${bigFiles} files, node_modules ${nodeModulesFiles} files…`);
    bigRepo = await buildBigRepo(fixtures, Math.max(1, bigFiles), nodeModulesFiles);
    projects.push(bigRepo);
  }
  const largeDiffLines = Number(args['large-diff-lines']);
  let largeDiff: { root: string; rel: string } | null = null;
  if (largeDiffLines > 0) {
    const root = projects[0] as string;
    // The last module sorts last in the file list, so it is not the auto-selected first file.
    const rel = `src/module-${String(Number(args.files) - 1).padStart(3, '0')}.ts`;
    const lines = Array.from(
      { length: largeDiffLines },
      (_, i) => `export const generated${i} = { id: ${i}, name: 'item-${i}', tags: ['a', 'b'] };`,
    );
    await writeFile(join(root, rel), `${lines.join('\n')}\n`);
    largeDiff = { root, rel };
  }
  const generationMs = performance.now() - genStarted;
  log(`generated in ${Math.round(generationMs)} ms at ${fixtures.root}`);

  let daemon: DaemonChild | null = null;
  let browser: Browser | null = null;
  let closeSub: (() => void) | null = null;
  const result: Record<string, unknown> = {
    args,
    layout: { repos, worktreesPerRepo, bigFiles, nodeModulesFiles, generationMs },
  };
  const phases: Record<string, [number, number]> = {};
  try {
    const t0 = Date.now();
    daemon = await spawnDaemon(fixtures, projects);
    const pid = daemon.child.pid as number;
    const tListening = Date.now();
    const client = createApiClient({ baseUrl: daemon.url, token: daemon.token });
    const events: Array<{ at: number; event: ServerEvent }> = [];
    const sub = client.subscribe({ onEvent: (event) => events.push({ at: Date.now(), event }) });
    closeSub = () => sub.close();
    let worktreeCount = 0;
    for (;;) {
      const { projects: list } = await client.listProjects();
      const wts = list.flatMap((p) => p.worktrees);
      worktreeCount = wts.length;
      if (
        list.length >= projects.length &&
        wts.every((w) => w.summary !== null || w.error !== null)
      )
        break;
      if (Date.now() - t0 > 300_000) throw new Error('timed out waiting for summaries');
      await sleep(50);
    }
    const tSummaries = Date.now();
    phases.startup = [t0, tSummaries];
    // Wait until the inotify watch count is stable for 4 s (subscriptions crawl in the background).
    let inotify = await inotifyStats(pid);
    let stableSince = Date.now();
    while (Date.now() - stableSince < 4000 && Date.now() - tSummaries < 60_000) {
      await sleep(50);
      const next = await inotifyStats(pid);
      if (next.watches !== inotify.watches) stableSince = Date.now();
      inotify = next;
    }
    const watchersSettledMs = stableSince - t0;
    const memStartup = await memStats(pid);
    const startupSpawns = (await readSpawns(daemon.spawnFile)).filter((s) => s.t0 <= tSummaries);
    result.startup = {
      listeningMs: tListening - t0,
      allSummariesMs: tSummaries - t0,
      worktrees: worktreeCount,
      spawns: spawnStats(startupSpawns),
      spawnsBeforeListening: startupSpawns.filter((s) => s.t0 <= tListening).length,
      inotify,
      watchersSettledMs,
      mem: memStartup,
    };
    log(
      `startup: listening ${tListening - t0} ms, summaries ${tSummaries - t0} ms, ${startupSpawns.length} git spawns, inotify ${inotify.instances} instances / ${inotify.watches} watches (settled at ${watchersSettledMs} ms), RSS ${memStartup.rssMiB} MiB`,
    );

    let page: Page | null = null;
    let cdp: CDPSession | null = null;
    if (useUi) {
      applyChromiumLibraryPath();
      browser = await chromium.launch();
      page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
      await page.addInitScript(() => {
        const w = window as unknown as { __longTasks: Array<{ start: number; duration: number }> };
        w.__longTasks = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            w.__longTasks.push({ start: e.startTime, duration: e.duration });
        }).observe({ type: 'longtask', buffered: true });
      });
      const consoleLines: string[] = [];
      result.console = consoleLines;
      page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 300)));
      page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`.slice(0, 300)));
      page.on('worker', (w) => consoleLines.push(`worker started: ${w.url().split('/').pop()}`));
      page.context().on('response', (r) => {
        if (r.status() >= 300)
          consoleLines.push(
            `HTTP ${r.status()} ${new URL(r.url()).pathname} (${r.request().resourceType()})`,
          );
      });
      page
        .context()
        .on('requestfailed', (r) =>
          consoleLines.push(
            `request failed ${new URL(r.url()).pathname}: ${r.failure()?.errorText}`,
          ),
        );
      cdp = await page.context().newCDPSession(page);
      await cdp.send('Performance.enable');
      const started = Date.now();
      await page.goto(daemon.authUrl);
      await page
        .locator(`[data-testid="${TEST_IDS.app}"][data-ready="true"]`)
        .waitFor({ timeout: 120_000 });
      const paintMs = Date.now() - started;
      // No Inbox view since #83: the app has landed on the top worktree of the list by now.
      if (args['select-worktree']) {
        await page.locator(`[data-testid="${TEST_IDS.worktreeItem}"]`).first().click();
      }
      await sleep(1000);
      const res = await apiResources(page, started);
      result.firstPaint = {
        coldMs: paintMs,
        metrics: await pageMetrics(cdp),
        requests: res.map((r) => ({ ...r, ms: round(r.end - r.start) })),
      };
      log(`first paint ${paintMs} ms`);
    }

    // --- idle ------------------------------------------------------------------------------
    if (idleMs > 0) {
      await sleep(3000);
      log(`idle: sampling ${idleMs / 1000} s…`);
      const pageBefore = cdp ? await pageMetrics(cdp) : null;
      const idleStart = Date.now();
      const cpu = await sampleCpu(pid, idleMs);
      const idleEnd = Date.now();
      phases.idle = [idleStart, idleEnd];
      const pageAfter = cdp ? await pageMetrics(cdp) : null;
      const spawns = (await readSpawns(daemon.spawnFile)).filter(
        (s) => s.t0 >= idleStart && s.t0 < idleEnd,
      );
      const top = [...cpu.intervals]
        .map((iv, index) => ({ ...iv, index, total: iv.selfPct + iv.childPct }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 6)
        .map((iv) => {
          const inside = spawns.filter((s) => s.t0 >= iv.start - 200 && s.t0 < iv.end);
          return {
            index: iv.index,
            secondsSinceDaemonStart: round((iv.start - t0) / 1000),
            totalPct: round(iv.total),
            selfPct: round(iv.selfPct),
            childPct: round(iv.childPct),
            spawns: spawnStats(inside),
          };
        });
      const dirtyReasons: Record<string, number> = {};
      for (const line of daemon.logLines) {
        if (!line.includes('"worktree dirty"')) continue;
        const parsed = JSON.parse(line) as { time: string; reason: string };
        const at = Date.parse(parsed.time);
        if (at >= idleStart && at < idleEnd)
          dirtyReasons[parsed.reason] = (dirtyReasons[parsed.reason] ?? 0) + 1;
      }
      result.idle = {
        durationMs: idleEnd - idleStart,
        averagePct: round(cpu.averagePct, 2),
        averageSelfPct: round(cpu.averageSelfPct, 2),
        maxPct: round(cpu.maxPct),
        intervals: cpu.intervals.map((iv) => round(iv.selfPct + iv.childPct)),
        spawns: spawnStats(spawns),
        dirtyReasons,
        sseEvents: events.filter((e) => e.at >= idleStart && e.at < idleEnd).length,
        top,
        browser: pageBefore && pageAfter ? diffCost(pageBefore, pageAfter) : null,
        mem: await memStats(pid),
      };
      log(
        `idle: avg ${round(cpu.averagePct, 2)} % (self ${round(cpu.averageSelfPct, 2)} %), max ${round(cpu.maxPct)} %, ${spawns.length} git spawns`,
      );
    }

    // --- refresh ---------------------------------------------------------------------------
    const { projects: list } = await client.listProjects();
    const allTargets = list
      .flatMap((p) => p.worktrees.map((w) => w.worktree))
      .filter((w) => !w.bare);
    const wanted = args['refresh-target'];
    const filtered = wanted ? allTargets.filter((w) => w.path.includes(wanted)) : allTargets;
    const targets = filtered.length ? filtered : allTargets;
    const samples: Array<Record<string, unknown>> = [];
    for (let i = 0; i < iterations; i++) {
      const target = targets[(i * 7) % targets.length];
      if (!target) break;
      const selector = `[data-testid="${TEST_IDS.worktreeItem}"][data-worktree-id="${target.id}"]`;
      const before = page ? await page.locator(selector).getAttribute('data-additions') : null;
      const metricsBefore = cdp ? await pageMetrics(cdp) : null;
      const uiWait = page
        ? page
            .waitForFunction(
              ({ sel, prev }) => {
                const el = document.querySelector(sel);
                return el && el.getAttribute('data-additions') !== prev ? Date.now() : false;
              },
              { sel: selector, prev: before },
              { polling: 'raf', timeout: 15_000 },
            )
            .then((h) => h.jsonValue() as Promise<number>)
            .catch(() => null)
        : Promise.resolve(null);
      const mark = events.length;
      const tWrite = Date.now();
      await appendFile(join(target.path, 'README.md'), `profile edit ${i}\n`);
      const tSse = await new Promise<number | null>((resolve) => {
        const deadline = Date.now() + 15_000;
        const check = () => {
          const hit = events
            .slice(mark)
            .find((e) => e.event.type === 'worktree.changed' && e.event.worktreeId === target.id);
          if (hit) resolve(hit.at);
          else if (Date.now() > deadline) resolve(null);
          else setTimeout(check, 2);
        };
        check();
      });
      const tUi = await uiWait;
      // Let the UI finish its refetches before reading resource timings.
      await sleep(800);
      const dirtyLine = daemon.logLines.find((line) => {
        if (!line.includes('"worktree dirty"') || !line.includes(target.id)) return false;
        return Date.parse((JSON.parse(line) as { time: string }).time) >= tWrite;
      });
      const tDirty = dirtyLine
        ? Date.parse((JSON.parse(dirtyLine) as { time: string }).time)
        : null;
      const spawns = (await readSpawns(daemon.spawnFile)).filter(
        (s) => s.t0 >= tWrite && s.t0 <= (tSse ?? tWrite + 2000),
      );
      const own = spawns.filter((s) => s.cwd === target.path);
      const gitStart = own.length ? Math.min(...own.map((s) => s.t0)) : null;
      const gitEnd = own.length ? Math.max(...own.map((s) => s.t1)) : null;
      const res = page ? await apiResources(page, tWrite) : [];
      const metricsAfter = cdp ? await pageMetrics(cdp) : null;
      const sample = {
        worktree: target.path,
        sseMs: tSse === null ? null : tSse - tWrite,
        uiMs: tUi === null ? null : tUi - tWrite,
        dirtyMs: tDirty === null ? null : tDirty - tWrite,
        gitStartMs: gitStart === null ? null : round(gitStart - tWrite),
        gitEndMs: gitEnd === null ? null : round(gitEnd - tWrite),
        gitSpawns: own.map((s) => `${s.sub} ${s.ms}ms`),
        otherSpawns: spawns.length - own.length,
        requests: res.map((r) => ({
          name: r.name,
          startMs: round(r.start - tWrite),
          ms: round(r.end - r.start),
          ttfb: round(r.ttfb),
          bytes: r.bytes,
        })),
        browser: metricsBefore && metricsAfter ? diffCost(metricsBefore, metricsAfter) : null,
      };
      samples.push(sample);
      log(
        `refresh ${i + 1}: dirty ${sample.dirtyMs} ms, git ${sample.gitStartMs}–${sample.gitEndMs} ms, SSE ${sample.sseMs} ms, UI ${sample.uiMs} ms, ${res.length} requests ${res.reduce((a, r) => a + r.bytes, 0)} B`,
      );
      await sleep(700);
    }
    const pick = (key: string) =>
      samples.map((s) => s[key]).filter((v): v is number => typeof v === 'number');
    result.refresh = {
      sse: summarize(pick('sseMs')),
      ui: summarize(pick('uiMs')),
      dirty: summarize(pick('dirtyMs')),
      gitEnd: summarize(pick('gitEndMs')),
      samples,
    };

    // --- direct client cost ----------------------------------------------------------------
    const endpoints = ['/api/projects', '/api/inbox?scope=working'];
    const direct: Record<string, unknown> = {};
    for (const ep of endpoints) {
      const times: number[] = [];
      let bytes = 0;
      for (let i = 0; i < 10; i++) {
        const started = performance.now();
        const response = await fetch(`${daemon.url}${ep}`, {
          headers: { authorization: `Bearer ${daemon.token}` },
        });
        const text = await response.text();
        times.push(performance.now() - started);
        bytes = Buffer.byteLength(text);
      }
      const st = summarize(times);
      direct[ep] = { bytes, p50: round(st.p50), p95: round(st.p95), min: round(st.min) };
    }
    result.direct = direct;
    log(`direct: ${JSON.stringify(direct)}`);

    // --- large diff in the UI ----------------------------------------------------------------
    if (page && cdp && largeDiff) {
      const ld = largeDiff;
      const wt = allTargets.find((w) => w.path === ld.root);
      if (wt) {
        await page
          .locator(`[data-testid="${TEST_IDS.worktreeItem}"][data-worktree-id="${wt.id}"]`)
          .click();
        await sleep(1500);
        const ltBefore = await page.evaluate(
          () => (window as unknown as { __longTasks: unknown[] }).__longTasks.length,
        );
        // Open another file first, so the large one is fetched and rendered on click.
        await page
          .locator(`[data-testid="${TEST_IDS.fileItem}"]:not([data-path="${ld.rel}"])`)
          .first()
          .click();
        await sleep(1000);
        const m0 = await pageMetrics(cdp);
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
        await cdp.send('Profiler.start');
        const tClick = Date.now();
        await page
          .locator(`[data-testid="${TEST_IDS.fileItem}"][data-path="${ld.rel}"]`)
          .first()
          .click();
        await page
          .locator(
            `[data-testid="${TEST_IDS.diffViewer}"][data-path="${ld.rel}"][data-state="ready"]`,
          )
          .waitFor({ timeout: 60_000 });
        const tReady = Date.now();
        await sleep(2000);
        const { profile } = (await cdp.send('Profiler.stop')) as { profile: unknown };
        await writeFile(join(OUT, 'page-large-diff.cpuprofile'), JSON.stringify(profile));
        const m1 = await pageMetrics(cdp);
        const res = await apiResources(page, tClick);
        // Scroll the diff to the bottom in steps and record frame times.
        const frames = await page.evaluate(async () => {
          const viewer = document.querySelector('[data-testid="diff-viewer"]');
          const all: Element[] = [];
          // No nested named functions here: tsx would inject a `__name` helper the page lacks.
          const stack: Array<Element | ShadowRoot> = viewer ? [viewer] : [];
          if (viewer) all.push(viewer);
          while (stack.length > 0) {
            const root = stack.pop() as Element | ShadowRoot;
            for (const el of root.querySelectorAll('*')) {
              all.push(el);
              if (el.shadowRoot) stack.push(el.shadowRoot);
            }
            if (root instanceof Element && root.shadowRoot) stack.push(root.shadowRoot);
          }
          const scrollers = all
            .filter(
              (el): el is HTMLElement =>
                el instanceof HTMLElement &&
                el.scrollHeight > el.clientHeight + 10 &&
                getComputedStyle(el).overflowY !== 'visible',
            )
            .sort((a, b) => b.scrollHeight - a.scrollHeight);
          const el = scrollers[0];
          if (!el) return { frames: [] as number[], scrollHeight: 0 };
          const out: number[] = [];
          let last = performance.now();
          for (let i = 0; i < 240 && el.scrollTop + el.clientHeight < el.scrollHeight; i++) {
            el.scrollTop += el.clientHeight * 0.8;
            await new Promise((r) => requestAnimationFrame(() => r(null)));
            const now = performance.now();
            out.push(now - last);
            last = now;
          }
          return { frames: out, scrollHeight: el.scrollHeight };
        });
        const longTasks = await page.evaluate(
          (from) =>
            (window as unknown as { __longTasks: Array<{ duration: number }> }).__longTasks.slice(
              from,
            ),
          ltBefore,
        );
        const fst = summarize(frames.frames);
        result.largeDiff = {
          lines: largeDiffLines,
          clickToReadyMs: tReady - tClick,
          requests: res.map((r) => ({ name: r.name, ms: round(r.end - r.start), bytes: r.bytes })),
          browser: diffCost(m0, m1),
          longTasks: longTasks.map((t) => round(t.duration)),
          scroll: {
            frames: fst.count,
            p50: round(fst.p50),
            p95: round(fst.p95),
            max: round(fst.max),
            scrollHeight: frames.scrollHeight,
          },
          domNodes: await page.evaluate(() => document.querySelectorAll('*').length),
        };
        log(`large diff: ${JSON.stringify(result.largeDiff)}`);
      }
    }

    // --- burst -----------------------------------------------------------------------------
    if (burstMs > 0) {
      const burstTargets = targets.slice(0, Number(args['burst-worktrees']));
      log(`burst: ${burstTargets.length} simulators for ${burstMs / 1000} s…`);
      const mark = events.length;
      const burstStart = Date.now();
      const sims: SimulatorHandle[] = burstTargets.map((t, i) =>
        startAgentSimulator({
          targets: [{ path: t.path }],
          env: fixtures.env,
          seed: 100 + i,
          durationMs: burstMs,
          minIntervalMs: Number(args['burst-min-ms']),
          maxIntervalMs: Number(args['burst-max-ms']),
        }),
      );
      const cpuPromise = sampleCpu(pid, burstMs + 4000);
      const reports = await Promise.all(sims.map((s) => s.done));
      const burstEnd = Date.now();
      const cpu = await cpuPromise;
      // Wait for quiet: no worktree.changed for 2 s.
      let lastEventAt = burstEnd;
      for (;;) {
        const last = events
          .slice(mark)
          .filter((e) => e.event.type === 'worktree.changed')
          .at(-1);
        lastEventAt = last?.at ?? burstEnd;
        if (Date.now() - lastEventAt > 2000) break;
        await sleep(200);
      }
      const spawns = (await readSpawns(daemon.spawnFile)).filter(
        (s) => s.t0 >= burstStart && s.t0 <= lastEventAt + 100,
      );
      const res = page ? await apiResources(page, burstStart) : [];
      const sse = events.slice(mark);
      result.burst = {
        simulators: burstTargets.length,
        actions: reports.reduce((a, r) => a + r.actions.length, 0),
        errors: reports.reduce((a, r) => a + r.errors, 0),
        durationMs: burstEnd - burstStart,
        settleAfterEndMs: lastEventAt - burstEnd,
        cpuAvgPct: round(cpu.averagePct),
        cpuSelfAvgPct: round(cpu.averageSelfPct),
        cpuMaxPct: round(cpu.maxPct),
        sseEvents: sse.length,
        sseByType: sse.reduce<Record<string, number>>((acc, e) => {
          acc[e.event.type] = (acc[e.event.type] ?? 0) + 1;
          return acc;
        }, {}),
        spawns: spawnStats(spawns),
        uiRequests: res.length,
        uiBytes: res.reduce((a, r) => a + r.bytes, 0),
        uiByEndpoint: res.reduce<Record<string, { count: number; bytes: number }>>((acc, r) => {
          const key = r.name.replace(/[0-9a-f]{16}/g, ':id');
          acc[key] ??= { count: 0, bytes: 0 };
          acc[key].count++;
          acc[key].bytes += r.bytes;
          return acc;
        }, {}),
        mem: await memStats(pid),
      };
      log(`burst: ${JSON.stringify(result.burst)}`);
    }
    sub.close();
    result.final = { mem: await memStats(pid), inotify: await inotifyStats(pid) };
    result.phases = phases;
  } finally {
    closeSub?.();
    await browser?.close().catch(() => {});
    if (daemon) await stopChild(daemon.child);
    await writeFile(join(OUT, 'profile.json'), `${JSON.stringify(result, null, 2)}\n`);
    await fixtures.cleanup();
    log(`wrote ${join(OUT, 'profile.json')}`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[profile] FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
