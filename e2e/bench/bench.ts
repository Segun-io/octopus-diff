/**
 * Perf bench (PLAN §6 WS4, §8 item 10; issue #26): a layout (default `small`: N repos × M
 * worktrees, 30 × 3; or `large` / `large-ci`: one monorepo with a stale-index worktree, an
 * untracked-heavy worktree and a 300k-line rewrite) against the built daemon running as a child
 * process with every git spawn traced (`spawn-trace.mjs`).
 *
 * Measures:
 * - daemon startup (spawn → listening → every summary computed) with the git spawns by subcommand
 *   and their wall time, per worktree;
 * - time to first paint (navigation → `[data-testid=app][data-ready=true]`), cold and warm (the
 *   median of three reloads), with the spawns each one causes;
 * - idle CPU of the daemon process incl. its git children (`/proc/<pid>/stat`), with the UI open;
 * - single-file refresh latency: file write → SSE `worktree.changed` (p50 / p95 / max, per
 *   worktree role) and → sidebar update in the UI, with the spawns per edit;
 * - API payload sizes (raw, gzip, and what the daemon sends when asked for gzip);
 * - daemon RSS (idle and peak).
 *
 * `--after-fetch` (small layout only, issue #35): every repository gets a bare `origin`, every linked
 * worktree merged `origin/main` and a fetch moved `origin/main` before the daemon starts, so every
 * worktree's file labels have to be computed from scratch; after the usual phases a second fetch
 * moves it again while the daemon runs (every label invalidated at once). It records the cold paint,
 * the startup spawns by subcommand, the time until every worktree's labels are known, the relabel
 * time after the live fetch with its spawns, and RSS. Written to `results-after-fetch.{json,md}`.
 *
 * Budgets (see `BUDGETS`) decide the exit code. A budget in `TRACKED` is known to fail until the
 * issue it names lands: it is reported as `FAIL (tracked #n)` and does not fail the run (`--strict`
 * counts it). Large layouts are report-only except the spawn budget.
 *
 * Usage: pnpm --filter @octopus-diff/fixtures bench --layout large-ci --idle-seconds 60 ...
 * Writes docs/bench/results[-<layout>].json and .md (override the directory with --out <dir>).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { cpus, platform, release } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  appendScopeParams,
  createApiClient,
  type DiffScope,
  type ServerEvent,
  TEST_IDS,
} from '@octopus-diff/contracts';
import {
  addBenchOrigins,
  type BenchOrigins,
  generateFixtures,
  generateLargeFixtures,
  type IsolatedGitEnv,
  LARGE_LAYOUTS,
  type LargeLayoutName,
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
import { gitSpawns, readSpawns, type SpawnStats, spawnStats, within } from './trace.js';

const { values: args } = parseArgs({
  // pnpm 12 forwards a literal `--`; tolerate it.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    layout: { type: 'string', default: 'small' },
    repos: { type: 'string', default: '30' },
    worktrees: { type: 'string', default: '3' },
    'idle-seconds': { type: 'string', default: '60' },
    iterations: { type: 'string', default: '15' },
    out: { type: 'string', default: join(REPO_ROOT, 'docs', 'bench') },
    'no-ui': { type: 'boolean', default: false },
    seed: { type: 'string', default: '1' },
    strict: { type: 'boolean', default: false },
    'after-fetch': { type: 'boolean', default: false },
    'to-review': { type: 'boolean', default: false },
  },
});

const LAYOUTS = ['small', ...Object.keys(LARGE_LAYOUTS)];
if (!LAYOUTS.includes(args.layout as string)) {
  throw new Error(`--layout must be one of ${LAYOUTS.join(', ')}`);
}
const LAYOUT = args.layout as 'small' | LargeLayoutName;
const AFTER_FETCH = args['after-fetch'];
/** The UI opens on To review (every review state, and with origins every label, is part of the paint). */
const TO_REVIEW = args['to-review'] || AFTER_FETCH;
if (TO_REVIEW && LAYOUT !== 'small') {
  throw new Error('--after-fetch and --to-review need --layout small');
}
/** How long one edit may take to show up. The 100k-file layout needs minutes while the UI refetches. */
const EDIT_WAIT_MS = LAYOUT === 'large' ? 300_000 : LAYOUT === 'small' ? 10_000 : 60_000;

/** PLAN §8.10 targets, the warm reload (#26) and the startup spawns per worktree (#26). */
const TARGETS = {
  firstPaintMs: 3000,
  idleCpuPercent: 10,
  refreshMs: 1000,
  warmReloadMs: 300,
  startupSpawnsPerWorktree: 8,
};

/**
 * Budgets that fail today and are tracked by an issue: reported as `FAIL (tracked #n)`, they do not
 * turn the run red until the issue lands (then delete the entry). `--strict` ignores this list.
 */
export const TRACKED: Readonly<Record<string, string>> = {};

/** The 2026-11-11 profiling pass (issue #24), 12-core WSL2, Node 26, git 2.53. Static reference. */
const BASELINE_2026_11_11 = [
  ['Warm reload, 30 × 3', '864 ms (72 ms on 2026-11-08)'],
  ['Cold UI paint, 30 × 3 / with big repos', '2.5 s / 4.4 s'],
  [
    'Default view ("All on branch"), 30 × 3',
    '540 spawns, about 700 ms per load; fetched twice on first load',
  ],
  [
    'Startup git spawns, 90 worktrees',
    '1357 (180 `status`: every summary twice), about 15 per worktree',
  ],
  ['One-file edit → SSE, 100k-file repo', '440 ms, 8–13 spawns'],
  ['One-file edit → SSE, stale-index worktree', '1.0 s'],
  ['`git status`, 100k files: normal / stale index', '98 ms / 320 ms (their machine)'],
  ['Inbox payload, 4.5k files', '1.18 MB raw, 129 KB gzipped'],
  ['File list, 30k untracked files', '8 MB'],
] as const;

function log(message: string) {
  process.stderr.write(`[bench] ${message}\n`);
}

interface ChildDaemon {
  child: ChildProcess;
  url: string;
  authUrl: string;
  token: string;
  spawnFile: string;
  /** '+' per git child started, '-' per child gone: its balance is how many are running. */
  activeFile: string;
}

/** What the bench runs against, whichever layout generated it. */
interface BenchSetup {
  root: string;
  description: string;
  generationMs: number;
  projectPaths: string[];
  gitVars: Record<string, string>;
  gitEnv: IsolatedGitEnv;
  /** Worktree path → role (`bench`, `main`, `stale-index`, `untracked-heavy`). */
  roles: Map<string, string>;
  layout: Record<string, unknown>;
  /** `--after-fetch`: the bare origins and the fetch that moves them. */
  origins: BenchOrigins | null;
  /** `--after-fetch`: how long the first fetch (before the daemon starts) took. */
  firstFetchMs: number | null;
  cleanup(): Promise<void>;
}

async function setUp(): Promise<BenchSetup> {
  const started = performance.now();
  if (LAYOUT === 'small') {
    const repos = Number(args.repos);
    const worktreesPerRepo = Number(args.worktrees);
    log(`generating ${repos} repos × ${worktreesPerRepo} worktrees…`);
    const fixtures = await generateFixtures({
      seed: Number(args.seed),
      acceptance: false,
      bench: { repos, worktreesPerRepo },
      prefix: 'octopus-diff-bench-',
    });
    const roles = new Map<string, string>();
    for (const p of fixtures.manifest.projects)
      for (const w of p.worktrees) if (!w.bare) roles.set(w.path, 'bench');
    let origins: BenchOrigins | null = null;
    let firstFetchMs: number | null = null;
    if (AFTER_FETCH) {
      log('adding a bare origin to every repo, merging origin/main in the linked worktrees…');
      origins = await addBenchOrigins(fixtures.manifest, fixtures.env, fixtures.root);
      // The simulated fetch: origin/main moves in every repository before the daemon starts.
      firstFetchMs = (await origins.fetchMovesOrigin(1)).ms;
      log(`origin/main moved in ${origins.repos} repos by a fetch (${firstFetchMs} ms)`);
    }
    return {
      root: fixtures.root,
      description: `${repos} repos × ${worktreesPerRepo} worktrees (all dirty)${TO_REVIEW ? ', the UI opens on To review' : ''}${AFTER_FETCH ? ', each linked worktree merged origin/main, then a fetch moved origin/main in every repo' : ''}`,
      generationMs: performance.now() - started,
      projectPaths: registeredProjects(fixtures.manifest).flatMap((p) =>
        p.registration?.kind === 'path' ? [p.registration.path] : [],
      ),
      gitVars: { ...fixtures.manifest.git.vars },
      gitEnv: fixtures.env,
      roles,
      layout: {
        name: 'small',
        repos,
        worktreesPerRepo,
        toReview: TO_REVIEW,
        afterFetch: AFTER_FETCH,
      },
      origins,
      firstFetchMs,
      cleanup: () => fixtures.cleanup(),
    };
  }
  log(`generating the ${LAYOUT} layout (${LARGE_LAYOUTS[LAYOUT].files} tracked files)…`);
  const set = await generateLargeFixtures({ layout: LAYOUT, prefix: 'octopus-diff-bench-' });
  return {
    root: set.root,
    description: `one monorepo, ${set.options.files} tracked files, 3 worktrees (main with a ${set.options.rewriteLines}-line rewrite, a stale index, ${set.options.untracked + set.options.manyUntracked} untracked files)`,
    generationMs: performance.now() - started,
    projectPaths: [set.projectPath],
    gitVars: { ...set.env.vars },
    gitEnv: set.env,
    roles: new Map(set.worktrees.map((w) => [w.path, w.role])),
    layout: { name: LAYOUT, ...set.options },
    origins: null,
    firstFetchMs: null,
    cleanup: () => set.cleanup(),
  };
}

async function spawnDaemon(setup: BenchSetup, stateBase: string): Promise<ChildDaemon> {
  const token = randomBytes(24).toString('hex');
  const spawnFile = join(setup.root, 'spawns.jsonl');
  await writeFile(spawnFile, '');
  const activeFile = join(setup.root, 'spawns.active');
  await writeFile(activeFile, '');
  const options = {
    host: '127.0.0.1',
    port: 0,
    token,
    stateDir: join(stateBase, 'state'),
    configDir: join(stateBase, 'config'),
    webRoot: WEB_DIST,
    projects: setup.projectPaths,
    git: { env: setup.gitVars },
    logLevel: 'warn',
    version: 'bench',
  };
  const child = spawn(
    process.execPath,
    [
      '--import',
      join(E2E_DIR, 'bench', 'spawn-trace.mjs'),
      join(E2E_DIR, 'bench', 'daemon-child.mjs'),
    ],
    {
      cwd: E2E_DIR,
      env: {
        ...process.env,
        OCTOPUS_BENCH_DAEMON_OPTIONS: JSON.stringify(options),
        OCTOPUS_SPAWN_TRACE: spawnFile,
        OCTOPUS_SPAWN_ACTIVE: activeFile,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
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
  return { child, url: message.url, authUrl: message.authUrl, token, spawnFile, activeFile };
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
  timeoutMs = 300_000,
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
    .waitFor({ timeout: 600_000 });
  const ms = performance.now() - started;
  const fcp = await page.evaluate(
    () => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
  );
  return { ms, fcp };
}

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)] ?? Number.NaN;

interface RawResponse {
  status: number;
  encoding: string | null;
  /** Bytes on the wire (what the browser downloads). */
  wireBytes: number;
  /** Decoded body. */
  body: Buffer;
  ms: number;
}

/** GET with an explicit `accept-encoding`, counting the bytes before any decoding. */
function rawGet(
  base: string,
  path: string,
  token: string,
  acceptEncoding: string,
): Promise<RawResponse> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      new URL(path, base),
      { headers: { authorization: `Bearer ${token}`, 'accept-encoding': acceptEncoding } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const wire = Buffer.concat(chunks);
          const encoding = (res.headers['content-encoding'] as string | undefined) ?? null;
          let body = wire;
          // Only gzip is requested explicitly below; anything else is left undecoded.
          if (encoding === 'gzip') body = gunzipSync(wire);
          resolve({
            status: res.statusCode ?? 0,
            encoding,
            wireBytes: wire.length,
            body,
            ms: performance.now() - started,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

interface PayloadRow {
  name: string;
  path: string;
  status: number;
  rawBytes: number;
  gzipBytes: number;
  /** `content-encoding` the daemon answered an `accept-encoding: gzip` request with. */
  wireEncoding: string | null;
  wireBytes: number;
  /** First request, then the best of the next two (a warm cache shows here). */
  firstMs: number;
  warmMs: number;
}

async function measurePayload(
  base: string,
  token: string,
  name: string,
  path: string,
): Promise<PayloadRow> {
  const first = await rawGet(base, path, token, 'identity');
  const again = [
    await rawGet(base, path, token, 'identity'),
    await rawGet(base, path, token, 'identity'),
  ];
  const gz = await rawGet(base, path, token, 'gzip');
  return {
    name,
    path,
    status: first.status,
    rawBytes: first.body.length,
    gzipBytes: gzipSync(first.body).length,
    wireEncoding: gz.encoding,
    wireBytes: gz.wireBytes,
    firstMs: first.ms,
    warmMs: Math.min(...again.map((r) => r.ms)),
  };
}

function scopePath(path: string, scope: DiffScope): string {
  return `${path}?${appendScopeParams(new URLSearchParams(), scope)}`;
}

/**
 * Waits until no git child is running and the spawn trace has not grown for `quietMs` (at most
 * `maxMs`). A slow command produces no trace growth while it runs (the trace is written when a child
 * closes), so the running count from `activeFile` is what keeps the next edit from starting behind
 * the previous one's work.
 */
async function settled(
  traceFile: string,
  activeFile: string,
  quietMs = 1000,
  maxMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  let size = -1;
  let since = Date.now();
  while (Date.now() < deadline) {
    const next = (await readFile(traceFile).catch(() => Buffer.alloc(0))).length;
    const marks = await readFile(activeFile, 'utf8').catch(() => '');
    let running = 0;
    for (const mark of marks) running += mark === '+' ? 1 : -1;
    if (next !== size || running > 0) {
      size = next;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function memory(pid: number) {
  const text = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
  const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0);
  return { rssBytes: kb('VmRSS') * 1024, peakRssBytes: kb('VmHWM') * 1024 };
}

interface Budget {
  id: string;
  label: string;
  actual: number | null;
  /** Pass when `actual` is below (`max`) / at most (`atMost`) this. */
  limit: number;
  unit: string;
  /** False: reported, never judged (the layout is not the one the target is defined for). */
  applies: boolean;
}

interface BudgetResult extends Budget {
  tracked: string | null;
  /** `pass` | `fail` | `tracked-fail` | `skipped` | `report-only`; `tracked-pass` = tracked but passing. */
  status: 'pass' | 'fail' | 'tracked-fail' | 'tracked-pass' | 'skipped' | 'report-only';
}

function judge(budgets: Budget[], strict: boolean): BudgetResult[] {
  return budgets.map((b) => {
    const tracked = strict ? null : (TRACKED[b.id] ?? null);
    if (!b.applies) return { ...b, tracked, status: 'report-only' };
    if (b.actual === null || Number.isNaN(b.actual)) return { ...b, tracked, status: 'skipped' };
    const ok = b.id === 'startupSpawns' ? b.actual <= b.limit : b.actual < b.limit;
    if (ok) return { ...b, tracked, status: tracked ? 'tracked-pass' : 'pass' };
    return { ...b, tracked, status: tracked ? 'tracked-fail' : 'fail' };
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `--after-fetch`: polls `/api/projects` until every worktree's review summary carries its file
 * labels (`review.baseFiles`, which the daemon fills once `readFileOrigins` has run for that worktree).
 * `ms` is measured from `startedAt`; null when the labels were not all known in time.
 */
async function waitForLabels(
  client: ReturnType<typeof createApiClient>,
  expected: number,
  startedAt: number,
  timeoutMs = 120_000,
): Promise<{ ms: number | null; known: number }> {
  let known = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const worktrees = (await client.listProjects()).projects.flatMap((p) => p.worktrees);
    known = worktrees.filter((w) => w.summary?.review?.baseFiles !== undefined).length;
    if (known >= expected) return { ms: Date.now() - startedAt, known };
    await sleep(50);
  }
  return { ms: null, known };
}

/** What the To review inbox says about merge noise: worktrees and files by label. */
async function labelStats(client: ReturnType<typeof createApiClient>) {
  const { entries } = await client.inbox({ scope: { kind: 'review' } });
  let withBase = 0;
  let baseFiles = 0;
  let sameAsBase = 0;
  let viaMerge = 0;
  for (const entry of entries) {
    const base = entry.files.filter((f) => f.origin === 'base');
    if (base.length > 0) withBase++;
    baseFiles += base.length;
    if (base.some((f) => f.originVia === 'same-as-base')) sameAsBase++;
    viaMerge += base.filter((f) => f.originVia === 'merge').length;
  }
  return { worktrees: entries.length, withBase, baseFiles, sameAsBase, viaMerge };
}

async function main() {
  assertBuilt();
  const idleMs = Number(args['idle-seconds']) * 1000;
  const iterations = Number(args.iterations);
  const uiProblem = args['no-ui'] ? 'disabled with --no-ui' : webUiProblem();
  if (uiProblem) log(`UI metrics skipped: ${uiProblem.split('\n')[0]}`);

  const setup = await setUp();
  log(`generated in ${Math.round(setup.generationMs)} ms at ${setup.root}`);
  let daemon: ChildDaemon | null = null;
  let browser: Browser | null = null;
  try {
    const stateBase = join(setup.root, 'daemon');
    const spawnStarted = performance.now();
    const startEpoch = Date.now();
    daemon = await spawnDaemon(setup, stateBase);
    const listeningMs = performance.now() - spawnStarted;
    const client = createApiClient({ baseUrl: daemon.url, token: daemon.token });
    const worktreeCount = await waitForSummaries(client, setup.projectPaths.length);
    const summariesMs = performance.now() - spawnStarted;
    const summariesEpoch = Date.now();
    log(
      `daemon pid ${daemon.child.pid}: listening ${listeningMs.toFixed(0)} ms, ${worktreeCount} summaries ${summariesMs.toFixed(0)} ms`,
    );

    const events: Array<{ at: number; event: ServerEvent }> = [];
    const sub = client.subscribe({ onEvent: (event) => events.push({ at: Date.now(), event }) });

    let page: Page | null = null;
    let paint: { cold: number; warm: number[]; fcp: number | null } | null = null;
    // --after-fetch: when is every worktree's merge-noise labelling known? Counted from the start of
    // the cold paint's navigation (a browser opening the app right after the daemon came up), the
    // same starting point as `firstPaint()`'s clock and not before the browser is launched. Without
    // a UI it starts here.
    const labelsState: { start: number; poll: ReturnType<typeof waitForLabels> | null } = {
      start: Date.now(),
      poll: null,
    };
    const startLabels = () => {
      labelsState.start = Date.now();
      labelsState.poll = AFTER_FETCH
        ? waitForLabels(client, worktreeCount, labelsState.start)
        : null;
    };
    if (uiProblem) startLabels();
    const phases: Record<string, [number, number]> = { startup: [startEpoch, summariesEpoch] };
    if (!uiProblem) {
      applyChromiumLibraryPath();
      browser = await chromium.launch();
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      if (TO_REVIEW) {
        // A fresh profile opens on All on branch; this one opens on To review, the default of a
        // reviewer's profile, which makes the daemon compute every review state (and label) at paint.
        await context.addInitScript(() => {
          localStorage.setItem(
            'octopus-diff:prefs',
            JSON.stringify({ version: 2, defaultScope: 'review' }),
          );
        });
      }
      page = await context.newPage();
      let from = Date.now();
      startLabels();
      const cold = await firstPaint(page, daemon.authUrl);
      phases.coldPaint = [from, Date.now()];
      const warm: number[] = [];
      for (let i = 0; i < 3; i++) {
        from = Date.now();
        warm.push((await firstPaint(page, daemon.url)).ms);
        phases[`warmReload${i + 1}`] = [from, Date.now()];
      }
      paint = { cold: cold.ms, warm, fcp: cold.fcp };
      await page.locator(`[data-testid="${TEST_IDS.inboxItem}"]`).click();
      log(
        `first paint: cold ${cold.ms.toFixed(0)} ms, warm ${warm.map((w) => w.toFixed(0)).join(' / ')} ms`,
      );
    }

    let labels: {
      knownMs: number | null;
      known: number;
      triggeredByBench: boolean;
      stats: Awaited<ReturnType<typeof labelStats>>;
    } | null = null;
    const labelsPoll = labelsState.poll;
    if (labelsPoll) {
      let result = await Promise.race([labelsPoll, sleep(10_000).then(() => null)]);
      let triggeredByBench = false;
      if (result === null) {
        // Nothing the UI loaded asked for the review states (a default scope without them): ask the
        // way the To review inbox does, so the labels get computed.
        triggeredByBench = true;
        await client.inbox({ scope: { kind: 'review' } });
        result = await labelsPoll;
      }
      labels = {
        knownMs: result.ms,
        known: result.known,
        triggeredByBench,
        stats: await labelStats(client),
      };
      log(
        `labels: all ${result.known} worktrees known after ${result.ms ?? 'timeout'} ms (from the cold paint's start${triggeredByBench ? '; triggered by the bench' : ''}); ${labels.stats.withBase} worktrees with base files`,
      );
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
    const samples: Array<{
      worktree: string;
      role: string;
      sseMs: number | null;
      uiMs: number | null;
      window: [number, number];
    }> = [];
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
              { polling: 'raf', timeout: EDIT_WAIT_MS },
            )
            .then((handle) => handle.jsonValue() as Promise<number>)
            .catch(() => null)
        : Promise.resolve(null);
      const mark = events.length;
      const started = Date.now();
      await appendFile(join(target.path, 'README.md'), `bench edit ${i}\n`);
      const sseAt = await new Promise<number | null>((resolve) => {
        const deadline = Date.now() + EDIT_WAIT_MS;
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
        role: setup.roles.get(target.path) ?? 'bench',
        sseMs: sseAt === null ? null : sseAt - started,
        uiMs: uiAt === null ? null : uiAt - started,
        window: [started, started] as [number, number],
      };
      samples.push(sample);
      if (sample.sseMs !== null) sse.push(sample.sseMs);
      if (sample.uiMs !== null) ui.push(sample.uiMs);
      log(
        `refresh ${i + 1}/${iterations} (${sample.role}): SSE ${sample.sseMs ?? 'timeout'} ms, UI ${sample.uiMs ?? (page ? 'timeout' : 'n/a')} ms`,
      );
      // Let the work this edit caused (the UI refetches too) finish, so the next sample does not
      // queue behind it: no git child running and none finished for 1 s.
      await settled(daemon.spawnFile, daemon.activeFile, 1000, EDIT_WAIT_MS);
      sample.window[1] = Date.now();
    }
    sub.close();

    // Payloads, once the daemon has seen everything (second and third requests are warm).
    const payloads: PayloadRow[] = [];
    const scopes: Array<[string, DiffScope]> = [
      ['inbox, working', { kind: 'working' }],
      ['inbox, review (To review)', { kind: 'review' }],
      ['inbox, branch + working (All on branch)', { kind: 'branch', includeWorking: true }],
    ];
    payloads.push(await measurePayload(daemon.url, daemon.token, 'projects', '/api/projects'));
    for (const [name, scope] of scopes) {
      payloads.push(
        await measurePayload(daemon.url, daemon.token, name, scopePath('/api/inbox', scope)),
      );
    }
    const fileTargets = (LAYOUT === 'small' ? targets.slice(0, 1) : targets).map((w) => w);
    for (const w of fileTargets) {
      payloads.push(
        await measurePayload(
          daemon.url,
          daemon.token,
          `files ${setup.roles.get(w.path) ?? w.id}, working`,
          scopePath(`/api/worktrees/${w.id}/files`, { kind: 'working' }),
        ),
      );
    }
    // --after-fetch, second fetch while the daemon runs: every worktree's labels are invalidated at
    // once. Time until the To review inbox shows the new labels everywhere, spawns and RSS.
    let liveFetch: {
      fetchMs: number;
      relabelMs: number;
      polls: number;
      complete: boolean;
      spawns: number;
      spawnsPerWorktree: number;
      bySub: SpawnStats['bySub'];
      rssBeforeBytes: number;
      rssAfterBytes: number;
      stats: Awaited<ReturnType<typeof labelStats>>;
    } | null = null;
    if (AFTER_FETCH && setup.origins) {
      const rssBeforeBytes = (await memory(daemon.child.pid as number)).rssBytes;
      // The spawn window opens before the fetch: it updates the repositories in batches while the
      // daemon watches their refs, so the first ones are already refreshing while the rest are
      // still being fetched. The relabel timer below starts when the whole fetch is done.
      const fetchStart = Date.now();
      const fetched = await setup.origins.fetchMovesOrigin(2);
      const from = Date.now();
      const t0 = performance.now();
      let stats = await labelStats(client);
      let polls = 1;
      while (stats.sameAsBase < setup.origins.linkedWorktrees && Date.now() - from < 120_000) {
        await sleep(50);
        stats = await labelStats(client);
        polls++;
      }
      const relabelMs = performance.now() - t0;
      await settled(daemon.spawnFile, daemon.activeFile, 500, 30_000);
      const spawned = spawnStats(
        within(gitSpawns(await readSpawns(daemon.spawnFile)), fetchStart, Date.now()),
      );
      liveFetch = {
        fetchMs: fetched.ms,
        relabelMs: Math.round(relabelMs),
        polls,
        complete: stats.sameAsBase >= setup.origins.linkedWorktrees,
        spawns: spawned.total,
        spawnsPerWorktree: Math.round((spawned.total / worktreeCount) * 10) / 10,
        bySub: spawned.bySub,
        rssBeforeBytes,
        rssAfterBytes: (await memory(daemon.child.pid as number)).rssBytes,
        stats,
      };
      log(
        `live fetch: relabel ${liveFetch.relabelMs} ms, ${liveFetch.spawns} spawns, ${stats.sameAsBase}/${setup.origins.linkedWorktrees} worktrees relabelled`,
      );
    }
    const mem = await memory(daemon.child.pid as number);

    // Spawns per phase and per edit, from the trace the daemon wrote.
    const allGit = gitSpawns(await readSpawns(daemon.spawnFile));
    const startupSpawns = within(allGit, startEpoch, summariesEpoch);
    const startup: SpawnStats = spawnStats(startupSpawns);
    const phaseSpawns = Object.fromEntries(
      Object.entries(phases)
        .filter(([name]) => name !== 'startup')
        .map(([name, [from, to]]) => {
          const s = spawnStats(within(allGit, from, to));
          return [name, { spawns: s.total, wallMs: s.wallMs, bySub: s.bySub }];
        }),
    );
    const editSpawns = samples.map((sample) => {
      const s = spawnStats(within(allGit, sample.window[0], sample.window[1]));
      return { role: sample.role, spawns: s.total, wallMs: s.wallMs };
    });

    const gitVersion = (await runGit(['--version'], { cwd: setup.root, env: setup.gitEnv })).stdout
      .toString()
      .trim();
    const sseStats = summarize(sse);
    const uiStats = summarize(ui);
    const byRole: Record<string, ReturnType<typeof summarize>> = {};
    for (const role of new Set(samples.map((s) => s.role))) {
      byRole[role] = summarize(
        samples.filter((s) => s.role === role && s.sseMs !== null).map((s) => s.sseMs as number),
      );
    }
    const warmMedian = paint ? median(paint.warm) : null;
    const spawnsPerWorktree = worktreeCount > 0 ? startup.total / worktreeCount : null;
    const standard = LAYOUT === 'small';
    const isDefault30x3 = standard && Number(args.repos) === 30 && Number(args.worktrees) === 3;
    const budgets = judge(
      [
        {
          id: 'firstPaint',
          label: 'Time to first paint (cold, `data-ready`)',
          actual: paint ? paint.cold : null,
          limit: TARGETS.firstPaintMs,
          unit: 'ms',
          applies: standard,
        },
        {
          id: 'warmReload',
          label: 'Time to first paint (warm reload, median of 3)',
          actual: warmMedian,
          limit: TARGETS.warmReloadMs,
          unit: 'ms',
          applies: isDefault30x3,
        },
        {
          id: 'startupSpawns',
          label: 'Startup git spawns per worktree',
          actual: spawnsPerWorktree,
          limit: TARGETS.startupSpawnsPerWorktree,
          unit: 'spawns',
          applies: true,
        },
        {
          id: 'idleCpu',
          label: 'Idle CPU, daemon + git children (average)',
          actual: idle.supported ? idle.averagePercent : null,
          limit: TARGETS.idleCpuPercent,
          unit: '%',
          applies: standard,
        },
        {
          id: 'refreshSse',
          label: 'Refresh: write → SSE `worktree.changed` p95',
          actual: sse.length === iterations ? sseStats.p95 : Number.POSITIVE_INFINITY,
          limit: TARGETS.refreshMs,
          unit: 'ms',
          applies: standard,
        },
        {
          id: 'refreshUi',
          label: 'Refresh: write → UI sidebar update p95',
          actual: page ? (ui.length === iterations ? uiStats.p95 : Number.POSITIVE_INFINITY) : null,
          limit: TARGETS.refreshMs,
          unit: 'ms',
          applies: standard,
        },
      ],
      args.strict,
    );
    const failed = budgets.filter((b) => b.status === 'fail');
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
        ...setup.layout,
        description: setup.description,
        worktrees: worktreeCount,
        generationMs: Math.round(setup.generationMs),
      },
      startup: {
        listeningMs: Math.round(listeningMs),
        allSummariesMs: Math.round(summariesMs),
        gitSpawns: startup.total,
        gitSpawnsPerWorktree:
          spawnsPerWorktree === null ? null : Math.round(spawnsPerWorktree * 10) / 10,
        gitWallMs: startup.wallMs,
        bySubcommand: startup.bySub,
      },
      firstPaint: paint
        ? {
            coldMs: Math.round(paint.cold),
            warmMs: Math.round(median(paint.warm)),
            warmSamplesMs: paint.warm.map((w) => Math.round(w)),
            firstContentfulPaintMs: paint.fcp,
            spawns: phaseSpawns,
          }
        : { skipped: uiProblem },
      idleCpu: idle,
      memory: mem,
      refresh: {
        iterations,
        sse: sseStats,
        sseByRole: byRole,
        ui: page ? uiStats : { skipped: uiProblem },
        spawnsPerEdit: editSpawns,
        samples: samples.map(({ window: _window, ...rest }) => rest),
      },
      payloads,
      afterFetch:
        AFTER_FETCH && setup.origins
          ? {
              repos: setup.origins.repos,
              linkedWorktrees: setup.origins.linkedWorktrees,
              firstFetchMs: setup.firstFetchMs,
              labels,
              liveFetch,
            }
          : null,
      targets: TARGETS,
      tracked: TRACKED,
      strict: args.strict,
      budgets,
      pass: failed.length === 0,
    };
    await mkdir(args.out, { recursive: true });
    const stem = AFTER_FETCH
      ? 'results-after-fetch'
      : TO_REVIEW
        ? 'results-to-review'
        : LAYOUT === 'small'
          ? 'results'
          : `results-${LAYOUT}`;
    await writeFile(join(args.out, `${stem}.json`), `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(join(args.out, `${stem}.md`), markdown(result));
    process.stdout.write(markdown(result));
    log(`wrote ${join(args.out, `${stem}.json`)} and ${stem}.md`);
    if (failed.length > 0) {
      log(`FAILED budgets: ${failed.map((b) => b.id).join(', ')}`);
      process.exitCode = 1;
    } else {
      const tracked = budgets.filter((b) => b.status === 'tracked-fail');
      if (tracked.length > 0) {
        log(`tracked budgets still failing (not counted): ${tracked.map((b) => b.id).join(', ')}`);
      }
    }
  } finally {
    await browser?.close().catch(() => {});
    if (daemon) await stopChild(daemon.child);
    await setup.cleanup();
  }
}

function fmt(value: number | null | undefined, unit = ' ms'): string {
  return value === null || value === undefined || Number.isNaN(value)
    ? 'n/a'
    : `${Math.round(value)}${unit}`;
}

function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

function verdictOf(b: BudgetResult): string {
  switch (b.status) {
    case 'pass':
      return 'PASS';
    case 'fail':
      return 'FAIL';
    case 'tracked-fail':
      return `FAIL (tracked: ${b.tracked})`;
    case 'tracked-pass':
      return `PASS (tracked: ${b.tracked}; remove it from \`TRACKED\`)`;
    case 'skipped':
      return 'skipped';
    default:
      return 'report only';
  }
}

// biome-ignore lint/suspicious/noExplicitAny: report object assembled above.
function markdown(r: any): string {
  const fp = r.firstPaint.skipped ? null : r.firstPaint;
  const ui = r.refresh.ui.skipped ? null : r.refresh.ui;
  const budgets = r.budgets as BudgetResult[];
  const budgetRows = budgets
    .map((b) => {
      const op = b.id === 'startupSpawns' ? '≤' : '<';
      const actual =
        b.actual === null || Number.isNaN(b.actual) || !Number.isFinite(b.actual)
          ? b.actual === null
            ? 'n/a'
            : 'no result'
          : b.unit === '%'
            ? `${b.actual.toFixed(2)} %`
            : b.unit === 'spawns'
              ? b.actual.toFixed(1)
              : `${Math.round(b.actual)} ${b.unit}`;
      return `| ${b.label} | ${actual} | ${op} ${b.limit} ${b.unit} | ${verdictOf(b)} |`;
    })
    .join('\n');
  const sub = Object.entries(
    r.startup.bySubcommand as Record<
      string,
      { count: number; totalMs: number; p50: number; p95: number }
    >,
  )
    .map(
      ([name, g]) => `| \`${name}\` | ${g.count} | ${g.totalMs} ms | ${g.p50} ms | ${g.p95} ms |`,
    )
    .join('\n');
  const phaseRows = fp
    ? Object.entries(fp.spawns as Record<string, { spawns: number; wallMs: number }>)
        .map(([name, p]) => `| ${name} | ${p.spawns} | ${p.wallMs} ms |`)
        .join('\n')
    : '';
  const roleRows = Object.entries(
    r.refresh.sseByRole as Record<string, { p50: number; p95: number; max: number; count: number }>,
  )
    .map(([role, s]) => {
      const edits = (r.refresh.spawnsPerEdit as Array<{ role: string; spawns: number }>).filter(
        (e) => e.role === role,
      );
      const spawns = edits.length
        ? `${Math.min(...edits.map((e) => e.spawns))}–${Math.max(...edits.map((e) => e.spawns))}`
        : 'n/a';
      return `| ${role} | ${s.count} | ${fmt(s.p50)} / ${fmt(s.p95)} / ${fmt(s.max)} | ${spawns} |`;
    })
    .join('\n');
  const payloadRows = (r.payloads as PayloadRow[])
    .map(
      (p) =>
        `| ${p.name} | ${bytes(p.rawBytes)} | ${bytes(p.gzipBytes)} | ${p.wireEncoding ?? 'none'}: ${bytes(p.wireBytes)} | ${fmt(p.firstMs)} / ${fmt(p.warmMs)} |`,
    )
    .join('\n');
  const baselineRows = BASELINE_2026_11_11.map(([k, v]) => `| ${k} | ${v} |`).join('\n');
  const af = r.afterFetch as {
    repos: number;
    linkedWorktrees: number;
    firstFetchMs: number | null;
    labels: {
      knownMs: number | null;
      known: number;
      triggeredByBench: boolean;
      stats: {
        worktrees: number;
        withBase: number;
        baseFiles: number;
        sameAsBase: number;
        viaMerge: number;
      };
    } | null;
    liveFetch: {
      fetchMs: number;
      relabelMs: number;
      polls: number;
      complete: boolean;
      spawns: number;
      spawnsPerWorktree: number;
      bySub: Record<string, { count: number; totalMs: number; p50: number; p95: number }>;
      rssBeforeBytes: number;
      rssAfterBytes: number;
      stats: { worktrees: number; withBase: number; baseFiles: number; sameAsBase: number };
    } | null;
  } | null;
  const afterFetchSection = af
    ? `
## After a fetch that moved origin/main (\`--after-fetch\`, issue #35)

${af.repos} repositories each have a bare \`origin\`; the ${af.linkedWorktrees} linked worktrees committed one own file and merged \`origin/main\` (the local \`main\` is stale). A fetch then moved \`origin/main\` in every repository (${fmt(af.firstFetchMs)}) **before the daemon started**, so every worktree's labels are computed from scratch; the numbers above (startup spawns, cold paint, warm reloads, RSS) are for that cold start.

| Metric | Result |
|---|---|
| Time until every worktree's labels are known (from the cold paint's start${af.labels?.triggeredByBench ? '; the UI did not ask, the bench requested To review' : ''}) | ${af.labels ? `${fmt(af.labels.knownMs)} (${af.labels.known} worktrees)` : 'n/a'} |
| To review inbox afterwards: worktrees with base files / base files / via merge | ${af.labels ? `${af.labels.stats.withBase} / ${af.labels.stats.baseFiles} / ${af.labels.stats.viaMerge}` : 'n/a'} |
| **Live fetch** (second fetch, daemon running, every label invalidated at once): fetch time | ${af.liveFetch ? fmt(af.liveFetch.fetchMs) : 'n/a'} |
| Live fetch: time until the To review inbox shows the new labels in every worktree | ${af.liveFetch ? `${fmt(af.liveFetch.relabelMs)} (${af.liveFetch.stats.sameAsBase}/${af.linkedWorktrees} worktrees relabelled${af.liveFetch.complete ? '' : ', INCOMPLETE'})` : 'n/a'} |
| Live fetch: git spawns (per worktree) | ${af.liveFetch ? `${af.liveFetch.spawns} (${af.liveFetch.spawnsPerWorktree})` : 'n/a'} |
| Daemon RSS before / after the live fetch | ${af.liveFetch ? `${bytes(af.liveFetch.rssBeforeBytes)} / ${bytes(af.liveFetch.rssAfterBytes)}` : 'n/a'} |

${
  af.liveFetch
    ? `Live fetch, git spawns by subcommand:

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
${Object.entries(af.liveFetch.bySub)
  .map(([name, g]) => `| \`${name}\` | ${g.count} | ${g.totalMs} ms | ${g.p50} ms | ${g.p95} ms |`)
  .join('\n')}
`
    : ''
}`
    : '';
  const stem = af
    ? 'results-after-fetch'
    : r.layout.toReview
      ? 'results-to-review'
      : r.layout.name === 'small'
        ? 'results'
        : `results-${r.layout.name}`;
  const trackedNote = Object.entries(r.tracked as Record<string, string>)
    .map(([id, issue]) => `\`${id}\` → ${issue}`)
    .join('; ');
  return `# octopus-diff perf bench

Generated ${r.generatedAt} · ${r.environment.platform} · ${r.environment.cpu} (${r.environment.cores} cores) · Node ${r.environment.node} · ${r.environment.git}

Layout \`${r.layout.name}\`: ${r.layout.description} = ${r.layout.worktrees} worktrees, generated in ${fmt(r.layout.generationMs)}.

## Budgets

| Metric | Result | Budget | Verdict |
|---|---|---|---|
${budgetRows}

Tracked budgets are known to fail until the issue they name lands: they are listed as \`FAIL (tracked)\` and do not turn the run red (${r.strict ? '`--strict` was on, so they count' : trackedNote}). Large layouts report everything but judge only the startup spawns. Run \`--strict\` to count tracked budgets too.

## Numbers

| Metric | Result |
|---|---|
| Time to first paint (cold) | ${fp ? fmt(fp.coldMs) : 'skipped'} |
| Time to first paint (warm reload; 3 samples) | ${fp ? `${fmt(fp.warmMs)} (${fp.warmSamplesMs.join(' / ')} ms)` : 'skipped'} |
| Idle CPU, daemon + git children (avg over ${Math.round(r.idleCpu.durationMs / 1000)} s / worst 1 s) | ${r.idleCpu.supported ? `${r.idleCpu.averagePercent.toFixed(2)} % / ${r.idleCpu.maxIntervalPercent.toFixed(2)} %` : 'n/a'} |
| Refresh: write → SSE \`worktree.changed\` (p50 / p95 / max) | ${fmt(r.refresh.sse.p50)} / ${fmt(r.refresh.sse.p95)} / ${fmt(r.refresh.sse.max)} (${r.refresh.sse.count}/${r.refresh.iterations}) |
| Refresh: write → UI sidebar update (p50 / p95 / max) | ${ui ? `${fmt(ui.p50)} / ${fmt(ui.p95)} / ${fmt(ui.max)} (${ui.count}/${r.refresh.iterations})` : 'skipped'} |
| Daemon startup: listening / all summaries | ${fmt(r.startup.listeningMs)} / ${fmt(r.startup.allSummariesMs)} |
| Daemon RSS: end of run / peak | ${bytes(r.memory.rssBytes)} / ${bytes(r.memory.peakRssBytes)} |

## Startup git spawns (${r.startup.gitSpawns} for ${r.layout.worktrees} worktrees = ${r.startup.gitSpawnsPerWorktree} per worktree, ${r.startup.gitWallMs} ms of git wall time summed)

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
${sub}
${
  fp
    ? `
## Spawns caused by the UI

| Phase | Git spawns | Wall time (sum) |
|---|---|---|
${phaseRows}
`
    : ''
}
${afterFetchSection}
## Edit → SSE by worktree role

| Role | Edits | SSE p50 / p95 / max | Git spawns per edit |
|---|---|---|---|
${roleRows}

## API payloads

| Request | Raw | Gzipped (computed) | Sent when asked for gzip | First / warm request |
|---|---|---|---|---|
${payloadRows}

## Baseline: the 2026-11-11 profiling pass (issue #24)

Static reference from the roadmap issue (12-core WSL2, Node 26, git 2.53), not measured by this run:

| Measurement | Baseline |
|---|---|
${baselineRows}

Raw numbers: \`${stem}.json\` next to this file. Re-run: \`pnpm --filter @octopus-diff/e2e bench${af ? ' --after-fetch' : r.layout.toReview ? ' --to-review' : r.layout.name === 'small' ? '' : ` --layout ${r.layout.name}`}\`.
`;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[bench] FAILED: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
