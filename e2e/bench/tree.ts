/**
 * File explorer bench (#9): `GET /api/worktrees/:id/tree` on the `large` layout (100k tracked
 * files, three worktrees, one with 30k untracked files) against the built daemon in a child
 * process, plus git-core's own costs in this process (the same runner, no daemon).
 *
 * Measures, per worktree and directory (root, a middle level, a leaf of 25 files):
 * - **first**: the first `/tree` of the worktree (pays its `working` file list: status + diff,
 *   the same list `GET /files` builds) and the `ls-tree` of every tree on the way;
 * - **cold**: a directory not listed before, the working list already cached (one `ls-tree` per
 *   new tree on the path);
 * - **warm**: repeats (p50 / p95 of 30; no git process);
 * - **shared**: the same directory in another worktree of the project (the tree is cached by
 *   (common dir, tree oid): no `ls-tree`);
 * - the tree view (`ref=HEAD`), bytes per response, and the daemon's CPU for warm requests;
 * - git-core in process: one `ls-tree` of the root, `ls-tree -r` of the root (the whole 100k
 *   listing), and what fetching every directory or the full path list would weigh.
 *
 * Usage: pnpm --filter @octopus-diff/e2e bench:tree [--out <dir>] [--files N] [--keep]
 * Needs `pnpm build`. Writes docs/bench/results-tree.{json,md} (or into `--out`).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { cpus, platform, release } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createApiClient, type TreeResponse } from '@octopus-diff/contracts';
import {
  clockTicksPerSecond,
  generateLargeFixtures,
  LARGE_LAYOUTS,
  type LargeFixtureSet,
  largeFilePath,
  readProcCpu,
} from '@octopus-diff/fixtures';
import { createGitCore, hashId } from '@octopus-diff/git-core';
import { assertBuilt, E2E_DIR, REPO_ROOT, WEB_DIST } from '../support/env.js';

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    out: { type: 'string' },
    files: { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});

const log = (message: string) => process.stderr.write(`[bench:tree] ${message}\n`);
const WARM_RUNS = 30;

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const r = (n: number) => Math.round(n * 100) / 100;
  return { n: values.length, p50: r(at(0.5)), p95: r(at(0.95)), max: r(sorted.at(-1) ?? 0) };
}

interface Raw {
  status: number;
  bytes: number;
  body: Buffer;
  ms: number;
}

function rawGet(base: string, path: string, token: string): Promise<Raw> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      new URL(path, base),
      { headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'identity' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            bytes: body.length,
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

const DIRS = {
  root: '',
  middle: 'apps/app3/packages',
  leaf: 'apps/app5/packages/pkg7/src/mod2/sub4',
};

async function main() {
  assertBuilt();
  const layout = {
    ...LARGE_LAYOUTS.large,
    ...(args.files ? { files: Number(args.files) } : {}),
  };
  log(`generating the large layout: ${layout.files} tracked files…`);
  const set: LargeFixtureSet = await generateLargeFixtures({
    layout,
    prefix: 'octopus-diff-bench-tree-',
  });
  log(`generated in ${set.generationMs} ms at ${set.root}`);
  let child: ChildProcess | null = null;
  try {
    // --- git-core in process (the runner only) ------------------------------------------------
    const mainWt = set.worktrees.find((w) => w.role === 'main');
    if (!mainWt) throw new Error('no main worktree');
    const locator = {
      projectId: 'p',
      worktreeId: hashId(mainWt.path),
      path: mainWt.path,
    };
    const gitCore: Record<string, unknown> = {};
    {
      const lsRoot: number[] = [];
      const lsRecursive: number[] = [];
      for (let i = 0; i < 5; i++) {
        const core = createGitCore({ env: set.env.vars });
        try {
          await core.listCommits(locator, { limit: 1 }); // discovery and version, not measured
          const head = (await core.listTree?.(locator, { ref: 'HEAD', path: '' }))?.commit;
          await core.dispose();
          const fresh = createGitCore({ env: set.env.vars });
          await fresh.listCommits(locator, { limit: 1 });
          const t0 = performance.now();
          const root = await fresh.listTree?.(locator, { ref: head ?? 'HEAD', path: '' });
          lsRoot.push(performance.now() - t0);
          const t1 = performance.now();
          const count = await fresh.countTreeFiles?.(locator, { tree: root?.tree ?? '' });
          lsRecursive.push(performance.now() - t1);
          gitCore.recursiveFiles = count;
          await fresh.dispose();
        } catch (error) {
          await core.dispose();
          throw error;
        }
      }
      const paths = Array.from({ length: layout.files }, (_, i) => largeFilePath(i));
      gitCore.lsTreeRootColdMs = stats(lsRoot);
      gitCore.lsTreeRecursiveRootMs = stats(lsRecursive);
      gitCore.fullPathListJsonBytes = Buffer.byteLength(JSON.stringify(paths));
      log(
        `git-core: ls-tree root ${stats(lsRoot).p50} ms (cold, incl. commit → tree), ls-tree -r root ${stats(lsRecursive).p50} ms (${gitCore.recursiveFiles} files); a full path list would be ${(Number(gitCore.fullPathListJsonBytes) / 1e6).toFixed(1)} MB of JSON`,
      );
    }

    // --- the daemon ------------------------------------------------------------------------------
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
    child = spawn(process.execPath, [join(E2E_DIR, 'bench', 'daemon-child.mjs')], {
      cwd: E2E_DIR,
      env: { ...process.env, OCTOPUS_BENCH_DAEMON_OPTIONS: JSON.stringify(options) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const daemon = child;
    const first = await new Promise<string>((resolve, reject) => {
      createInterface({ input: daemon.stdout as NodeJS.ReadableStream }).once('line', resolve);
      daemon.once('exit', (code) => reject(new Error(`daemon exited early (${code})`)));
    });
    const ready = JSON.parse(first) as { ready: boolean; url: string };
    if (!ready.ready) throw new Error(`daemon failed: ${first}`);
    const pid = daemon.pid as number;
    const client = createApiClient({ baseUrl: ready.url, token });
    for (;;) {
      const { projects } = await client.listProjects();
      const rows = projects.flatMap((p) => p.worktrees);
      if (rows.length >= set.worktrees.length && rows.every((w) => w.summary || w.error)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    log(`daemon ready in ${Math.round(performance.now() - started)} ms`);
    const { projects } = await client.listProjects();
    const rows = projects.flatMap((p) => p.worktrees);
    const idOf = (role: string) => {
      const wt = set.worktrees.find((w) => w.role === role);
      const row = rows.find((r) => r.worktree.path === wt?.path);
      if (!row) throw new Error(`no ${role} worktree`);
      return row.worktree.id;
    };
    const tree = (id: string, dir: string, extra = '') =>
      rawGet(ready.url, `/api/worktrees/${id}/tree?path=${encodeURIComponent(dir)}${extra}`, token);

    const worktrees: Record<string, unknown> = {};
    for (const role of ['main', 'stale-index', 'untracked-heavy']) {
      const id = idOf(role);
      const row: Record<string, unknown> = {};
      // The first request of the worktree (its root): it pays the worktree's working list (the
      // list `GET /files` builds too) and, in the first worktree, the root's ls-tree. The middle
      // and leaf directories below are then cold: never listed in this worktree (in the first
      // worktree their trees were never listed at all; in the others the trees are shared).
      const firstRes = await tree(id, DIRS.root);
      if (firstRes.status !== 200) {
        throw new Error(`/tree ${role}: ${firstRes.status} ${firstRes.body}`);
      }
      row.firstMs = Math.round(firstRes.ms);
      for (const [name, dir] of Object.entries(DIRS)) {
        const cold = await tree(id, dir);
        const warm: number[] = [];
        const cpu0 = await cpuMs(pid);
        for (let i = 0; i < WARM_RUNS; i++) warm.push((await tree(id, dir)).ms);
        const cpu1 = await cpuMs(pid);
        const view = await tree(id, dir, '&ref=HEAD');
        const viewWarm: number[] = [];
        for (let i = 0; i < 10; i++) viewWarm.push((await tree(id, dir, '&ref=HEAD')).ms);
        const body = JSON.parse(cold.body.toString('utf8')) as TreeResponse;
        row[name] = {
          path: dir,
          entries: body.total,
          changed: body.entries.filter((e) => e.status !== undefined || e.changes !== undefined)
            .length,
          bytes: cold.bytes,
          coldMs: Math.round(cold.ms * 100) / 100,
          warm: stats(warm),
          warmCpuMsPerRequest: Math.round(((cpu1 - cpu0) / WARM_RUNS) * 100) / 100,
          treeViewFirstMs: Math.round(view.ms * 100) / 100,
          treeViewWarm: stats(viewWarm),
        };
      }
      worktrees[role] = row;
      log(
        `${role}: first ${row.firstMs} ms; ` +
          Object.keys(DIRS)
            .map((k) => {
              const d = row[k] as {
                coldMs: number;
                warm: { p50: number; p95: number };
                bytes: number;
                entries: number;
              };
              return `${k} (${d.entries} entries, ${d.bytes} B) cold ${d.coldMs} ms, warm p50 ${d.warm.p50} / p95 ${d.warm.p95} ms`;
            })
            .join('; '),
      );
    }

    // Every directory of HEAD (the whole tree, lazily): requests, bytes, time.
    const mainId = idOf('main');
    const walkStart = performance.now();
    let requests = 0;
    let bytes = 0;
    let entries = 0;
    const queue = [''];
    const walkCpu0 = await cpuMs(pid);
    while (queue.length > 0) {
      const dir = queue.shift() as string;
      const res = await tree(mainId, dir, '&ref=HEAD&limit=5000');
      requests++;
      bytes += res.bytes;
      const body = JSON.parse(res.body.toString('utf8')) as TreeResponse;
      entries += body.entries.length;
      for (const e of body.entries) if (e.kind === 'dir') queue.push(e.path);
    }
    const walk = {
      requests,
      entries,
      bytes,
      ms: Math.round(performance.now() - walkStart),
      daemonCpuMs: Math.round((await cpuMs(pid)) - walkCpu0),
    };
    log(
      `walk of every directory (tree view): ${requests} requests, ${entries} entries, ${(bytes / 1e6).toFixed(1)} MB, ${walk.ms} ms`,
    );

    const result = {
      date: new Date().toISOString(),
      machine: {
        platform: platform(),
        release: release(),
        cpus: cpus().length,
        node: process.version,
      },
      layout,
      generationMs: set.generationMs,
      gitCore,
      worktrees,
      walk,
    };
    const out = args.out ?? join(REPO_ROOT, 'docs', 'bench');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'results-tree.json'), `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(join(out, 'results-tree.md'), markdown(result));
    log(`wrote ${join(out, 'results-tree.{json,md}')}`);
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child?.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
    if (args.keep) log(`kept ${set.root}`);
    else await set.cleanup();
  }
}

function markdown(result: {
  date: string;
  layout: { files: number };
  gitCore: Record<string, unknown>;
  worktrees: Record<string, unknown>;
  walk: Record<string, number>;
}): string {
  const lines = [
    `# File explorer bench (${result.date})`,
    '',
    `Layout \`large\`: ${result.layout.files} tracked files. Times in ms (HTTP round trip on loopback, identity encoding).`,
    '',
    '| worktree | dir | entries | bytes | first request of the worktree | first listing of the dir (root: a repeat) | warm p50 | warm p95 | warm CPU/req | tree view warm p95 |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [role, value] of Object.entries(result.worktrees)) {
    const row = value as Record<string, unknown>;
    for (const name of Object.keys(DIRS)) {
      const d = row[name] as {
        path: string;
        entries: number;
        bytes: number;
        coldMs: number;
        warm: { p50: number; p95: number };
        warmCpuMsPerRequest: number;
        treeViewWarm: { p95: number };
      };
      lines.push(
        `| ${role} | ${name} \`${d.path || '/'}\` | ${d.entries} | ${d.bytes} | ${name === 'root' ? row.firstMs : ''} | ${d.coldMs} | ${d.warm.p50} | ${d.warm.p95} | ${d.warmCpuMsPerRequest} | ${d.treeViewWarm.p95} |`,
      );
    }
  }
  lines.push(
    '',
    `git-core in process: ls-tree of the root (cold, with commit → root tree) p50 ${(result.gitCore.lsTreeRootColdMs as { p50: number }).p50} ms; ls-tree -r of the root p50 ${(result.gitCore.lsTreeRecursiveRootMs as { p50: number }).p50} ms (${result.gitCore.recursiveFiles} files). A full path list as JSON: ${result.gitCore.fullPathListJsonBytes} bytes.`,
    '',
    `Every directory (tree view, one request each): ${result.walk.requests} requests, ${result.walk.entries} entries, ${result.walk.bytes} bytes, ${result.walk.ms} ms, daemon CPU ${result.walk.daemonCpuMs} ms.`,
    '',
  );
  return lines.join('\n');
}

main().catch((error: unknown) => {
  log(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
