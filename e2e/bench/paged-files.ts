/**
 * Paged file lists bench (#42): the `large-paged` layout's `many-changed` worktree (36k rewritten
 * tracked files) against the built daemon in a child process.
 *
 * Measures:
 * - `GET /files` of that worktree, unpaged (an old client) and paged (`limit`, following
 *   `nextCursor` to the end): time, bytes raw and on the wire (gzip), the largest response, and
 *   that the pages add up to the unpaged list's files (with a daemon that pages);
 * - `GET /api/inbox` (working, All on branch): time and bytes;
 * - the daemon's CPU (process + git children) for the first list of the worktree (cold) and a
 *   repeat (warm);
 * - the web: the app opened on that worktree (navigation → first file row painted), opening it from
 *   another worktree (click → first row), and the browser's `/api/*` traffic for one edit in it.
 *
 * Usage: pnpm --filter @octopus-diff/e2e bench:paged [--out <dir>] [--no-ui] [--files N --changed N]
 * Writes docs/bench/results-paged.{json,md} (or into `--out`).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { cpus, platform, release } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  appendScopeParams,
  createApiClient,
  type DiffScope,
  type FilesResponse,
  TEST_IDS,
} from '@octopus-diff/contracts';
import {
  clockTicksPerSecond,
  generateLargeFixtures,
  LARGE_LAYOUTS,
  type LargeFixtureSet,
  largeFilePath,
  readProcCpu,
} from '@octopus-diff/fixtures';
import { chromium, type Request } from '@playwright/test';
import {
  applyChromiumLibraryPath,
  assertBuilt,
  E2E_DIR,
  REPO_ROOT,
  WEB_DIST,
  webUiProblem,
} from '../support/env.js';

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    out: { type: 'string' },
    'no-ui': { type: 'boolean', default: false },
    files: { type: 'string' },
    changed: { type: 'string' },
    limit: { type: 'string', default: '500' },
    keep: { type: 'boolean', default: false },
    /** Writes a CPU profile of the daemon into this directory. */
    profile: { type: 'string' },
  },
});

const PAGE = Number(args.limit);
const log = (message: string) => process.stderr.write(`[bench:paged] ${message}\n`);
const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
const fmt = (ms: number | null) => (ms === null ? 'n/a' : `${Math.round(ms)} ms`);

interface Raw {
  status: number;
  wireBytes: number;
  body: Buffer;
  ms: number;
}

function rawGet(base: string, path: string, token: string, gzip: boolean): Promise<Raw> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      new URL(path, base),
      {
        headers: {
          authorization: `Bearer ${token}`,
          'accept-encoding': gzip ? 'gzip' : 'identity',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const wire = Buffer.concat(chunks);
          const body = res.headers['content-encoding'] === 'gzip' ? gunzipSync(wire) : wire;
          resolve({
            status: res.statusCode ?? 0,
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

async function cpuMs(pid: number): Promise<number> {
  const t = await readProcCpu(pid);
  return ((t.selfTicks + t.childTicks) / clockTicksPerSecond()) * 1000;
}

function scoped(path: string, scope: DiffScope, extra: Record<string, string> = {}): string {
  const params = appendScopeParams(new URLSearchParams(), scope);
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  return `${path}?${params}`;
}

const fileKey = (f: { path: string; rawPath?: string | undefined }) =>
  `${f.path}\u0000${f.rawPath ?? ''}`;

async function main() {
  assertBuilt();
  const layout = {
    ...LARGE_LAYOUTS['large-paged'],
    ...(args.files ? { files: Number(args.files) } : {}),
    ...(args.changed ? { manyChanged: Number(args.changed) } : {}),
  };
  log(`generating ${layout.files} tracked files, ${layout.manyChanged} rewritten…`);
  const set: LargeFixtureSet = await generateLargeFixtures({
    layout,
    prefix: 'octopus-diff-bench-paged-',
  });
  log(`generated in ${set.generationMs} ms at ${set.root}`);
  let child: ChildProcess | null = null;
  try {
    const token = randomBytes(24).toString('hex');
    const options = {
      host: '127.0.0.1',
      port: 0,
      token,
      stateDir: join(set.root, 'daemon', 'state'),
      configDir: join(set.root, 'daemon', 'config'),
      webRoot: WEB_DIST,
      projects: [set.projectPath],
      git: { env: set.env.vars },
      logLevel: 'warn',
      version: 'bench',
    };
    const started = performance.now();
    const profile = args.profile ? ['--cpu-prof', `--cpu-prof-dir=${args.profile}`] : [];
    child = spawn(process.execPath, [...profile, join(E2E_DIR, 'bench', 'daemon-child.mjs')], {
      cwd: E2E_DIR,
      env: { ...process.env, OCTOPUS_BENCH_DAEMON_OPTIONS: JSON.stringify(options) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const daemon = child;
    const first = await new Promise<string>((resolve, reject) => {
      createInterface({ input: daemon.stdout as NodeJS.ReadableStream }).once('line', resolve);
      daemon.once('exit', (code) => reject(new Error(`daemon exited early (${code})`)));
    });
    const ready = JSON.parse(first) as { ready: boolean; url: string; authUrl: string };
    if (!ready.ready) throw new Error(`daemon failed: ${first}`);
    const pid = daemon.pid as number;
    const client = createApiClient({ baseUrl: ready.url, token });
    for (;;) {
      const { projects } = await client.listProjects();
      const rows = projects.flatMap((p) => p.worktrees);
      if (rows.length >= set.worktrees.length && rows.every((w) => w.summary || w.error)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const startupMs = performance.now() - started;
    const { projects } = await client.listProjects();
    const rows = projects.flatMap((p) => p.worktrees);
    const byPath = new Map(rows.map((w) => [w.worktree.path, w]));
    const many = set.worktrees.find((w) => w.role === 'many-changed');
    const other = set.worktrees.find((w) => w.role === 'main');
    const manyRow = many ? byPath.get(many.path) : undefined;
    const otherRow = other ? byPath.get(other.path) : undefined;
    if (!manyRow || !otherRow) throw new Error('worktrees not found');
    const id = manyRow.worktree.id;
    log(
      `daemon ready in ${Math.round(startupMs)} ms; many-changed: ${manyRow.summary?.changedFiles} changed files`,
    );

    const filesPath = `/api/worktrees/${id}/files`;
    const scopes: Array<[string, DiffScope]> = [
      ['working', { kind: 'working' }],
      ['All on branch', { kind: 'branch', includeWorking: true }],
    ];
    const files: Array<Record<string, unknown>> = [];
    for (const [name, scope] of scopes) {
      const cpu0 = await cpuMs(pid);
      const cold = await rawGet(ready.url, scoped(filesPath, scope), token, true);
      const cpu1 = await cpuMs(pid);
      const warm = await rawGet(ready.url, scoped(filesPath, scope), token, true);
      const cpu2 = await cpuMs(pid);
      const raw = await rawGet(ready.url, scoped(filesPath, scope), token, false);
      const unpaged = JSON.parse(raw.body.toString('utf8')) as FilesResponse & {
        total?: number;
        truncated?: boolean;
        nextCursor?: string | null;
      };
      // Paged: the first page with a limit, then `nextCursor` to the end.
      const pages: Array<{ ms: number; rawBytes: number; wireBytes: number; rows: number }> = [];
      const seen = new Set<string>();
      let duplicates = 0;
      let cursor: string | null | undefined;
      let paged = true;
      for (;;) {
        const extra: Record<string, string> = { limit: String(PAGE) };
        if (cursor) extra.cursor = cursor;
        const page = await rawGet(ready.url, scoped(filesPath, scope, extra), token, true);
        const body = JSON.parse(page.body.toString('utf8')) as typeof unpaged;
        pages.push({
          ms: page.ms,
          rawBytes: page.body.length,
          wireBytes: page.wireBytes,
          rows: body.files.length,
        });
        for (const f of body.files) {
          const k = fileKey(f);
          if (seen.has(k)) duplicates++;
          seen.add(k);
        }
        cursor = body.nextCursor;
        if (body.nextCursor === undefined) paged = false;
        if (!cursor || pages.length > 1000) break;
      }
      const total = unpaged.total ?? unpaged.files.length;
      const row = {
        scope: name,
        total,
        unpaged: {
          rows: unpaged.files.length,
          truncated: unpaged.truncated ?? false,
          coldMs: Math.round(cold.ms),
          warmMs: Math.round(warm.ms),
          rawBytes: raw.body.length,
          wireBytes: cold.wireBytes,
          coldCpuMs: Math.round(cpu1 - cpu0),
          warmCpuMs: Math.round(cpu2 - cpu1),
        },
        paged: paged
          ? {
              pageSize: PAGE,
              pages: pages.length,
              firstMs: Math.round(pages[0]?.ms ?? 0),
              firstRawBytes: pages[0]?.rawBytes ?? 0,
              firstWireBytes: pages[0]?.wireBytes ?? 0,
              maxRawBytes: Math.max(...pages.map((p) => p.rawBytes)),
              maxMs: Math.round(Math.max(...pages.map((p) => p.ms))),
              allMs: Math.round(pages.reduce((s, p) => s + p.ms, 0)),
              rows: seen.size,
              duplicates,
              complete: seen.size === total && duplicates === 0,
            }
          : null,
      };
      files.push(row);
      log(
        `/files ${name}: ${total} files; unpaged ${row.unpaged.rows} rows ${kib(raw.body.length)} (${kib(cold.wireBytes)} gzip), cold ${fmt(cold.ms)} (${row.unpaged.coldCpuMs} ms CPU), warm ${fmt(warm.ms)}` +
          (row.paged
            ? `; paged ${row.paged.pages} pages, first ${fmt(row.paged.firstMs)} ${kib(row.paged.firstRawBytes)}, largest ${kib(row.paged.maxRawBytes)}, complete ${row.paged.complete}`
            : '; no paging'),
      );
    }

    const inbox: Array<Record<string, unknown>> = [];
    for (const [name, scope] of scopes) {
      const cold = await rawGet(ready.url, scoped('/api/inbox', scope), token, true);
      const warm = await rawGet(ready.url, scoped('/api/inbox', scope), token, false);
      const body = JSON.parse(warm.body.toString('utf8')) as {
        entries: Array<{ files: unknown[]; filesTotal?: number }>;
      };
      const row = {
        scope: name,
        ms: Math.round(cold.ms),
        warmMs: Math.round(warm.ms),
        rawBytes: warm.body.length,
        wireBytes: cold.wireBytes,
        rows: body.entries.reduce((s, e) => s + e.files.length, 0),
        total: body.entries.reduce((s, e) => s + (e.filesTotal ?? e.files.length), 0),
      };
      inbox.push(row);
      log(
        `/api/inbox ${name}: ${row.rows} of ${row.total} rows, ${kib(row.rawBytes)} (${kib(row.wireBytes)} gzip), ${fmt(row.ms)}`,
      );
    }

    let ui: Record<string, unknown> | null = null;
    const problem = args['no-ui'] ? 'disabled with --no-ui' : webUiProblem();
    if (problem) log(`UI skipped: ${problem.split('\n')[0]}`);
    else {
      applyChromiumLibraryPath();
      const browser = await chromium.launch();
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await context.addInitScript((worktreeId: string) => {
          localStorage.setItem(
            'octopus-diff:prefs',
            JSON.stringify({ version: 2, lastWorktree: worktreeId }),
          );
        }, id);
        const page = await context.newPage();
        page.on('pageerror', (error) => log(`page error: ${error.message}`));
        const firstRow = page.locator(
          `[data-testid="${TEST_IDS.fileItem}"][data-worktree-id="${id}"]`,
        );
        const out = args.out ?? join(REPO_ROOT, 'docs', 'bench');
        // On a timeout: what the page shows, for the log.
        const waitRow = async (locator: typeof firstRow) => {
          try {
            await locator.first().waitFor({ timeout: 120_000 });
          } catch (error) {
            await mkdir(out, { recursive: true });
            await page.screenshot({ path: join(out, 'paged-timeout.png') }).catch(() => {});
            const state = await page
              .evaluate(() => ({
                ready: document.querySelector('[data-testid="app"]')?.getAttribute('data-ready'),
                current: document
                  .querySelector('[aria-current="true"][data-worktree-id]')
                  ?.getAttribute('data-worktree-id'),
                rows: document.querySelectorAll('[data-testid="file-item"]').length,
              }))
              .catch(() => null);
            log(`timed out waiting for a file row: ${JSON.stringify(state)}`);
            throw error;
          }
        };
        let t0 = performance.now();
        await page.goto(ready.authUrl);
        await waitRow(firstRow);
        const coldOpen = performance.now() - t0;
        // Warm: reload (the daemon has the list).
        t0 = performance.now();
        await page.reload();
        await waitRow(firstRow);
        const warmOpen = performance.now() - t0;
        // From another worktree: open it (its row), then click the many-changed row.
        const rowOf = (worktreeId: string) =>
          page.locator(
            `[data-testid="${TEST_IDS.worktreeItem}"][data-worktree-id="${worktreeId}"]`,
          );
        await rowOf(otherRow.worktree.id).first().click();
        await waitRow(
          page.locator(
            `[data-testid="${TEST_IDS.fileItem}"][data-worktree-id="${otherRow.worktree.id}"]`,
          ),
        );
        const sidebarRow = rowOf(id);
        t0 = performance.now();
        await sidebarRow.first().click();
        await waitRow(firstRow);
        const switchOpen = performance.now() - t0;
        const mounted = await page.locator(`[data-testid="${TEST_IDS.fileItem}"]`).count();
        // One edit in the open worktree: the browser's /api/* traffic until it is quiet.
        const traffic: Array<{ at: number; path: string; bytes: number }> = [];
        const sizing: Promise<void>[] = [];
        // Requests still running (a refetch can take seconds while the daemon lists 36k files).
        let inflight = 0;
        const isApi = (request: Request) => {
          const path = new URL(request.url()).pathname;
          return path.startsWith('/api/') && path !== '/api/events';
        };
        page.on('request', (request: Request) => {
          if (isApi(request)) inflight++;
        });
        page.on('requestfailed', (request: Request) => {
          if (isApi(request)) inflight--;
        });
        page.on('requestfinished', (request: Request) => {
          if (isApi(request)) inflight--;
          const url = new URL(request.url());
          if (!url.pathname.startsWith('/api/') || url.pathname === '/api/events') return;
          const at = Date.now();
          sizing.push(
            request
              .sizes()
              .then((sz) => {
                traffic.push({
                  at,
                  path: `${url.pathname}${[...url.searchParams]
                    .filter(([k]) => k === 'limit' || k === 'cursor' || k === 'worktreeIds')
                    .map(([k, v]) => (k === 'limit' ? `?limit=${v}` : `?${k}`))
                    .join('')}`,
                  bytes: sz.responseBodySize + sz.responseHeadersSize,
                });
              })
              .catch(() => {}),
          );
        });
        // Quiet first: no request finished for 2 s (what the click caused is not the edit's).
        const quiet = async (since: () => number, maxMs: number) => {
          const deadline = Date.now() + maxMs;
          let last = Date.now();
          let count = -1;
          while (Date.now() < deadline) {
            if (traffic.length !== count || inflight > 0) {
              count = traffic.length;
              last = Date.now();
            } else if (Date.now() - Math.max(last, since()) > 2000) return;
            await new Promise((r) => setTimeout(r, 100));
          }
        };
        await quiet(() => 0, 30_000);
        traffic.length = 0;
        const before = (await client.listProjects()).projects
          .flatMap((p) => p.worktrees)
          .find((w) => w.worktree.id === id)?.summary?.stateHash;
        // The edit's event: the daemon announces the worktree's new state.
        let announcedAt = 0;
        const announced = new Promise<void>((resolve) => {
          const sub = client.subscribe({
            onEvent: (event) => {
              if (
                event.type === 'worktree.changed' &&
                event.worktreeId === id &&
                event.stateHash !== before
              ) {
                announcedAt = Date.now();
                sub.close();
                resolve();
              }
            },
          });
        });
        const editAt = Date.now();
        const edited = join(many?.path as string, largeFilePath(7));
        await appendFile(edited, '// bench edit\n');
        await Promise.race([announced, new Promise((r) => setTimeout(r, 60_000))]);
        const sseMs = announcedAt ? announcedAt - editAt : null;
        // Then until the browser is quiet again.
        await quiet(() => announcedAt, 60_000);
        await Promise.all(sizing);
        const editBytes = traffic.reduce((s, t) => s + t.bytes, 0);
        ui = {
          coldOpenMs: Math.round(coldOpen),
          warmOpenMs: Math.round(warmOpen),
          switchOpenMs: Math.round(switchOpen),
          mountedRows: mounted,
          edit: {
            sseMs,
            bytes: editBytes,
            requests: traffic.map((t) => `${t.path} ${t.bytes}`),
          },
        };
        log(
          `UI: open cold ${fmt(coldOpen)}, warm ${fmt(warmOpen)}, from another worktree ${fmt(switchOpen)}; one edit ${kib(editBytes)} in ${traffic.length} requests`,
        );
      } finally {
        await browser.close();
      }
    }

    const result = {
      generatedAt: new Date().toISOString(),
      machine: `${platform()} ${release()}, ${cpus().length} cores, Node ${process.versions.node}`,
      layout: { ...layout, generationMs: set.generationMs },
      startupMs: Math.round(startupMs),
      pageSize: PAGE,
      files,
      inbox,
      ui,
    };
    const out = args.out ?? join(REPO_ROOT, 'docs', 'bench');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'results-paged.json'), `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(join(out, 'results-paged.md'), markdown(result));
    log(`wrote ${join(out, 'results-paged.{json,md}')}`);
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child?.once('exit', r));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child?.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    }
    if (!args.keep) await set.cleanup();
    else log(`kept ${set.root}`);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: report rendering over the JSON above.
function markdown(r: any): string {
  const lines = [
    '# Paged file lists bench (#42)',
    '',
    `${r.generatedAt}, ${r.machine}. Layout \`large-paged\`: ${r.layout.files} tracked files, ${r.layout.manyChanged} of them rewritten in the \`many-changed\` worktree (generated in ${fmt(r.layout.generationMs)}); daemon ready (every summary) in ${fmt(r.startupMs)}. Page size ${r.pageSize}.`,
    '',
    '## `GET /files` of the many-changed worktree',
    '',
    '| Scope | Files | Unpaged (old client): rows, raw / gzip | cold (CPU) / warm | Paged: pages, first page time and size | largest page | all pages | complete |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const f of r.files) {
    const u = f.unpaged;
    const p = f.paged;
    lines.push(
      `| ${f.scope} | ${f.total} | ${u.rows}${u.truncated ? ' (truncated)' : ''}, ${kib(u.rawBytes)} / ${kib(u.wireBytes)} | ${fmt(u.coldMs)} (${u.coldCpuMs} ms) / ${fmt(u.warmMs)} (${u.warmCpuMs} ms) | ${p ? `${p.pages}, ${fmt(p.firstMs)}, ${kib(p.firstRawBytes)} (${kib(p.firstWireBytes)} gzip)` : 'no paging'} | ${p ? kib(p.maxRawBytes) : 'n/a'} | ${p ? fmt(p.allMs) : 'n/a'} | ${p ? `${p.complete} (${p.rows} rows, ${p.duplicates} duplicates)` : 'n/a'} |`,
    );
  }
  lines.push(
    '',
    '## `GET /api/inbox`',
    '',
    '| Scope | Rows sent / files | Raw / gzip | First / warm |',
    '|---|---|---|---|',
  );
  for (const i of r.inbox) {
    lines.push(
      `| ${i.scope} | ${i.rows} / ${i.total} | ${kib(i.rawBytes)} / ${kib(i.wireBytes)} | ${fmt(i.ms)} / ${fmt(i.warmMs)} |`,
    );
  }
  if (r.ui) {
    lines.push(
      '',
      '## Web',
      '',
      `- App opened on the worktree (navigation → first file row), a fresh browser profile with the daemon's list of the worktree already computed (the \`/files\` phase above did it; a first open on a fresh daemon also waits for the cold list, ${fmt(r.files[0]?.unpaged.coldMs ?? null)}): ${fmt(r.ui.coldOpenMs)}; reload ${fmt(r.ui.warmOpenMs)}.`,
      `- Opened from another worktree (click on its row → first file row): ${fmt(r.ui.switchOpenMs)}; ${r.ui.mountedRows} rows mounted.`,
      `- One edit in the open worktree: \`worktree.changed\` after ${fmt(r.ui.edit.sseMs)}, then ${kib(r.ui.edit.bytes)} of \`/api/*\` traffic on the wire (${r.ui.edit.requests.length} requests: ${r.ui.edit.requests.join(', ') || 'none'}).`,
    );
  }
  lines.push('', 'Re-run: `pnpm --filter @octopus-diff/e2e bench:paged`.', '');
  return lines.join('\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
