/**
 * Branch-scope inbox cache measurement (#27): N repos × M worktrees (default 30 × 3), the built
 * daemon as a child process with `spawn-trace.mjs` preloaded so every git spawn is counted.
 *
 * Reports, for `GET /api/inbox?scope=branch&working=1`: the first (cold) call, repeat calls, the
 * call after an edit, after a commit, and after the default branch moved (each: ms and git
 * spawns, and whether the result shows the change). Then, with a browser, the requests the UI
 * makes after an edit (`/files` per scope) and the warm reload time.
 *
 * Usage (from e2e/): pnpm exec tsx bench/inbox-cache.ts [--repos 30 --worktrees 3 --no-ui
 *   --out /tmp/inbox-cache.json]
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createApiClient, type ServerEvent, TEST_IDS } from '@octopus-diff/contracts';
import {
  type FixtureSet,
  generateFixtures,
  registeredProjects,
  runGit,
} from '@octopus-diff/fixtures';
import { type Browser, chromium, type Page } from '@playwright/test';
import {
  applyChromiumLibraryPath,
  assertBuilt,
  E2E_DIR,
  WEB_DIST,
  webUiProblem,
} from '../support/env.js';

const { values: args } = parseArgs({
  options: {
    repos: { type: 'string', default: '30' },
    worktrees: { type: 'string', default: '3' },
    out: { type: 'string', default: '' },
    'no-ui': { type: 'boolean', default: false },
  },
});

const BRANCH_ALL = { kind: 'branch', includeWorking: true } as const;

function log(message: string) {
  process.stderr.write(`[inbox-cache] ${message}\n`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  assertBuilt();
  const repos = Number(args.repos);
  const fixtures: FixtureSet = await generateFixtures({
    seed: 1,
    acceptance: false,
    bench: { repos, worktreesPerRepo: Number(args.worktrees) },
    prefix: 'octopus-diff-inbox-cache-',
  });
  let child: ChildProcess | null = null;
  let browser: Browser | null = null;
  try {
    const stateBase = join(fixtures.root, 'daemon');
    const traceFile = join(fixtures.root, 'spawns.jsonl');
    await writeFile(traceFile, '');
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
    child = spawn(
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
          OCTOPUS_SPAWN_TRACE: traceFile,
          OCTOPUS_BENCH_DAEMON_OPTIONS: JSON.stringify(options),
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    const first = await new Promise<string>((resolve, reject) => {
      lines.once('line', resolve);
      child?.once('exit', (code) => reject(new Error(`daemon child exited early (code ${code})`)));
    });
    const ready = JSON.parse(first) as { ready: boolean; url: string; authUrl: string };
    if (!ready.ready) throw new Error('daemon failed to start');
    const client = createApiClient({ baseUrl: ready.url, token });
    const events: ServerEvent[] = [];
    const sub = client.subscribe({ onEvent: (e) => events.push(e) });

    const deadline = Date.now() + 120_000;
    for (;;) {
      const { projects } = await client.listProjects();
      const wts = projects.flatMap((p) => p.worktrees);
      if (projects.length >= repos && wts.every((w) => w.summary !== null || w.error !== null))
        break;
      if (Date.now() > deadline) throw new Error('timed out waiting for summaries');
      await sleep(100);
    }
    await sleep(1500);
    const { projects } = await client.listProjects();
    const worktrees = projects
      .flatMap((p) => p.worktrees.map((w) => w.worktree))
      .filter((w) => !w.bare);
    log(`${worktrees.length} worktrees ready`);

    const spawnCount = async (): Promise<number> => {
      await sleep(80);
      return (await readFile(traceFile, 'utf8')).split('\n').filter(Boolean).length;
    };
    const waitChanged = async (worktreeId: string, since: number) => {
      const end = Date.now() + 10_000;
      while (Date.now() < end) {
        if (
          events
            .slice(since)
            .some((e) => e.type === 'worktree.changed' && e.worktreeId === worktreeId)
        )
          return true;
        await sleep(10);
      }
      return false;
    };
    const timed = async <T>(label: string, fn: () => Promise<T>) => {
      const before = await spawnCount();
      const t0 = performance.now();
      const value = await fn();
      const ms = performance.now() - t0;
      const spawns = (await spawnCount()) - before;
      log(`${label}: ${ms.toFixed(1)} ms, ${spawns} spawns`);
      return { value, ms: Math.round(ms * 10) / 10, spawns };
    };
    const branchInbox = () => client.inbox({ scope: BRANCH_ALL });
    const filesOf = (r: Awaited<ReturnType<typeof branchInbox>>, id: string) =>
      r.entries.find((e) => e.worktree.id === id)?.files ?? [];

    const result: Record<string, unknown> = { layout: { repos, worktrees: worktrees.length } };
    result.cold = await timed('branch inbox, cold', branchInbox).then(strip);
    const repeats = [];
    for (let i = 0; i < 5; i++)
      repeats.push(strip(await timed(`branch inbox, repeat ${i + 1}`, branchInbox)));
    result.repeat = repeats;
    result.workingRepeat = strip(
      await timed('working inbox (repeat)', () => client.inbox({ scope: { kind: 'working' } })),
    );

    // Edit: append to a tracked file in the first worktree of the first project.
    const target = worktrees.find((w) => !w.isMain) ?? worktrees[0];
    if (!target) throw new Error('no worktree');
    const baseline = await branchInbox();
    const beforeAdds = filesOf(baseline, target.id).reduce((n, f) => n + (f.additions ?? 0), 0);
    let mark = events.length;
    await appendFile(join(target.path, 'README.md'), 'cache edit\n');
    result.editEvent = await waitChanged(target.id, mark);
    const afterEdit = await timed('branch inbox after an edit', branchInbox);
    const editAdds = filesOf(afterEdit.value, target.id).reduce(
      (n, f) => n + (f.additions ?? 0),
      0,
    );
    result.afterEdit = { ...strip(afterEdit), fresh: editAdds > beforeAdds };
    result.afterEditRepeat = strip(await timed('branch inbox repeat after edit', branchInbox));

    // Commit that edit: HEAD moves, the diff against the merge base is unchanged.
    mark = events.length;
    const env = { cwd: target.path, env: fixtures.env.vars };
    await runGit(['add', '-A'], env);
    await runGit(['commit', '-q', '-m', 'cache commit'], env);
    result.commitEvent = await waitChanged(target.id, mark);
    const afterCommit = await timed('branch inbox after a commit', branchInbox);
    const commitAdds = filesOf(afterCommit.value, target.id).reduce(
      (n, f) => n + (f.additions ?? 0),
      0,
    );
    result.afterCommit = { ...strip(afterCommit), sameAdditions: commitAdds >= editAdds };

    // Default branch move: fast-forward `main` to the commit just made (merge base moves).
    const main = worktrees.find((w) => w.projectId === target.projectId && w.isMain);
    if (main) {
      const head = (await runGit(['rev-parse', 'HEAD'], env)).stdout.toString().trim();
      mark = events.length;
      await runGit(['update-ref', 'refs/heads/main', head], {
        cwd: main.path,
        env: fixtures.env.vars,
      });
      await sleep(1200);
      const afterMove = await timed('branch inbox after main moved', branchInbox);
      const moveAdds = filesOf(afterMove.value, target.id).reduce(
        (n, f) => n + (f.additions ?? 0),
        0,
      );
      result.afterDefaultMove = {
        ...strip(afterMove),
        fresh: moveAdds < commitAdds || moveAdds === 0,
      };
    }
    sub.close();

    if (!args['no-ui'] && !webUiProblem()) {
      applyChromiumLibraryPath();
      browser = await chromium.launch();
      const page: Page = await (
        await browser.newContext({ viewport: { width: 1440, height: 900 } })
      ).newPage();
      const requests: Array<{ t: number; url: string }> = [];
      page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.pathname.startsWith('/api/') && !u.pathname.includes('/events'))
          requests.push({ t: Date.now(), url: u.pathname + u.search });
      });
      const paint = async (url: string) => {
        const t0 = performance.now();
        await page.goto(url);
        await page
          .locator(`[data-testid="${TEST_IDS.app}"][data-ready="true"]`)
          .waitFor({ timeout: 60_000 });
        return performance.now() - t0;
      };
      const cold = await paint(ready.authUrl);
      const firstLoad = requests.map((r) => r.url);
      requests.length = 0;
      const warm = await paint(ready.url);
      const warmRequests = requests.map((r) => r.url);
      result.ui = {
        coldMs: Math.round(cold),
        warmMs: Math.round(warm),
        firstLoadRequests: firstLoad,
        warmRequests,
      };
      log(`UI cold ${cold.toFixed(0)} ms, warm ${warm.toFixed(0)} ms`);
      // Open a worktree, edit it, count the requests the UI makes.
      await page
        .locator(`[data-testid="${TEST_IDS.worktreeItem}"][data-worktree-id="${target.id}"]`)
        .first()
        .click();
      await sleep(1500);
      requests.length = 0;
      await appendFile(join(target.path, 'README.md'), 'ui edit\n');
      await sleep(2500);
      const after = requests.map((r) => r.url);
      const files = after.filter((u) => u.includes('/files'));
      const counts = new Map<string, number>();
      for (const u of files) counts.set(u, (counts.get(u) ?? 0) + 1);
      const duplicateFiles = [...counts.entries()].filter(([, n]) => n > 1).map(([u]) => u);
      result.ui = {
        ...(result.ui as object),
        requestsAfterEdit: after,
        filesRequestsAfterEdit: files.length,
        duplicateFilesRequests: duplicateFiles,
      };
      log(
        `requests after an edit: ${after.length} (files: ${files.length}, duplicated: ${duplicateFiles.length})`,
      );
    }

    const text = `${JSON.stringify(result, null, 2)}\n`;
    process.stdout.write(text);
    if (args.out) await writeFile(args.out, text);
  } finally {
    await browser?.close().catch(() => {});
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child?.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child?.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    }
    await fixtures.cleanup();
  }
}

function strip<T extends { ms: number; spawns: number }>(t: T): { ms: number; spawns: number } {
  return { ms: t.ms, spawns: t.spawns };
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[inbox-cache] FAILED: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
