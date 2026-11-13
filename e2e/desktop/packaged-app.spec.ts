/**
 * Smoke test of the PACKAGED desktop app (roadmap #19, docs/DESKTOP.md §8 phase B, acceptance D1-D4):
 * the installed binary with its fuses, its asar and its bundled CLI, not `electron .` from the
 * checkout (that is apps/desktop/scripts/smoke-app.mjs). Run: `pnpm --filter @octopus-diff/e2e
 * test:e2e:desktop` (see support/packaged-app.ts for which app).
 *
 * The window is inspected over `--remote-debugging-pipe` (support/cdp-pipe.ts: the installed app
 * refuses the TCP debugging switches that Playwright's `_electron.launch` needs). Every launch has
 * temp state/config/app-data dirs and the fixtures' isolated git config.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ApiClientError, createApiClient, TEST_IDS } from '@octopus-diff/contracts';
import {
  assertReadOnly,
  type FixtureSet,
  findWorktree,
  generateFixtures,
  proofTargetsFromManifest,
  registeredProjects,
  startAgentSimulator,
  startReadOnlyProof,
} from '@octopus-diff/fixtures';
import { expect, test } from '@playwright/test';
import {
  type AppDirs,
  alive,
  appDirs,
  childProcesses,
  cli,
  daemonInfo,
  daemonLog,
  launchApp,
  type PackagedApp,
  packagedApp,
  runApp,
  until,
} from './support/packaged-app.js';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

let app: PackagedApp;
let fixtures: FixtureSet;
let root: string;
let env: NodeJS.ProcessEnv;
const launched = new Set<number>();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  app = packagedApp();
  fixtures = await generateFixtures({ seed: 1901 });
  root = mkdtempSync(join(tmpdir(), 'octopus-diff-desktop-e2e-'));
  // The fixtures' isolated git config reaches the daemon's git (git-core inherits GIT_CONFIG_*).
  env = { ...process.env, ...fixtures.env.vars };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && !(key in fixtures.env.vars)) delete env[key];
  }
  test.info().annotations.push({ type: 'app', description: app.executable });
});

test.afterAll(async () => {
  for (const pid of launched) {
    if (alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
  // A SIGKILLed process may still be writing for a moment (a daemon logging its last lines):
  // wait for every one to be gone, and retry the removal, before the directory goes (a Linux CI
  // run failed with ENOTEMPTY after the tampered-asar test left a daemon running).
  const deadline = Date.now() + 15_000;
  while ([...launched].some(alive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await fixtures?.cleanup();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

const track = (pid: number | undefined) => {
  if (pid) launched.add(pid);
};

async function waitReady(dirs: AppDirs) {
  await until(() => daemonLog(dirs).includes('backend ready: started'), 60_000, 'the backend');
  const info = await until(() => daemonInfo(dirs), 10_000, 'daemon.json');
  track(info.pid);
  return info;
}

test('an installed build refuses dev options and debugger switches', async () => {
  for (const extra of [
    ['--dev'],
    ['--backend', 'source'],
    ['--renderer-url', 'http://localhost:5173'],
    ['--remote-debugging-port=0'],
    ['--inspect=0'],
    ['--inspect-brk'],
  ]) {
    const dirs = appDirs(root, `refused-${extra[0]?.replace(/\W/g, '')}`);
    const result = runApp(app, dirs, env, extra);
    expect(result.status, `${extra.join(' ')}: ${result.output}`).toBe(2);
    // Windows GUI binaries may not get their stderr to us; the exit code is what counts there.
    if (!IS_WIN) expect(result.output).toContain('is not available in an installed build');
    expect(result.output).not.toMatch(/DevTools listening|Debugger listening/);
    expect(existsSync(join(dirs.appData, 'logs', 'daemon.log')), 'nothing started').toBe(false);
  }
});

test('the window shows projects added with `octopus-diff add`; read-only proof; quit stops the daemon', async () => {
  test.setTimeout(300_000);
  const { manifest } = fixtures;
  const proof = await startReadOnlyProof({
    env: fixtures.env,
    targets: proofTargetsFromManifest(manifest),
  });
  const dirs = appDirs(root, 'started');
  const run = launchApp(app, dirs, env);
  track(run.child.pid);
  const live = findWorktree(manifest, 'live-agent').worktree;
  const sim = startAgentSimulator({
    targets: [{ path: live.path, name: 'live-agent' }],
    env: fixtures.env,
    seed: 19,
    durationMs: 30_000,
    minIntervalMs: 150,
    maxIntervalMs: 500,
  });
  try {
    const daemon = await waitReady(dirs);
    const origin = new URL(daemon.url).origin;

    // The CLI bundled in the app talks to the app's daemon (D6's mechanism).
    const status = JSON.parse(cli(app, dirs, env, 'status', '--json')) as { url?: string };
    expect(status.url, 'octopus-diff status sees the app daemon').toBe(daemon.url);
    const registered = registeredProjects(manifest);
    for (const project of registered) {
      if (project.registration?.kind !== 'path') continue;
      expect(cli(app, dirs, env, 'add', project.registration.path)).toContain('added');
    }
    for (const scanRoot of manifest.scanRoots) {
      cli(app, dirs, env, 'add', '--scan', scanRoot.path, '--depth', String(scanRoot.depth));
    }

    const client = createApiClient({ baseUrl: daemon.url, token: daemon.token });
    const names = registered.map((p) => p.name);
    const projects = await until(
      async () => {
        const list = (await client.listProjects()).projects;
        const listed = new Set(list.map((p) => p.project.name));
        const settled = list.every((p) =>
          p.worktrees.every((w) => w.worktree.bare || w.summary !== null || w.error !== null),
        );
        return names.every((n) => listed.has(n)) && settled ? list : null;
      },
      60_000,
      `the projects ${names.join(', ')}`,
    );

    // DESKTOP.md §10: the native watcher loads from the asar (unpacked), the git helper runs.
    const health = await client.health();
    expect(health.git.supported).toBe(true);
    expect(health.watcher.mode, JSON.stringify(health.watcher)).toBe('native');
    if (IS_WIN) {
      test.info().annotations.push({
        type: 'git helper',
        description: 'not used on Windows (git-core spawns git directly there, by design)',
      });
    } else {
      const children = childProcesses(daemon.pid);
      const helper = children.find((c) => c.args.includes('git-helper.js'));
      expect(helper, `a git helper under the daemon: ${JSON.stringify(children)}`).toBeTruthy();
      // The asar path, redirected by Electron to app.asar.unpacked (DESKTOP.md §10).
      expect(helper?.args).toContain(join('app.asar', 'dist', 'cli', 'git-helper.js'));
      expect(
        children.some((c) => c.args.includes('@parcel/watcher') || c.args.includes('watcher')),
      ).toBe(true);
    }

    // The window: the daemon's UI with the projects, and the §5 security baseline.
    const page = await run.cdp.page((url) => url.startsWith(origin), 60_000);
    await page.waitFor(
      `document.querySelector('[data-testid="${TEST_IDS.app}"]')?.getAttribute('data-ready') === 'true'`,
      60_000,
      'the web UI to be ready',
    );
    // The sidebar is one flat, virtual list of worktree rows carrying `data-project-name`: rows
    // far down are not mounted, so the check is that the mounted rows are the added projects'.
    const shown = await page.waitFor<string[]>(
      `(() => { const rows = [...document.querySelectorAll('[data-testid="${TEST_IDS.worktreeItem}"]')]
        .map((r) => r.getAttribute('data-project-name'));
        return rows.length > 0 ? [...new Set(rows)] : null; })()`,
      30_000,
      'worktree rows in the sidebar',
    );
    expect(shown.length).toBeGreaterThan(0);
    for (const name of shown)
      expect(names, 'every row is a project added with the CLI').toContain(name);
    test.info().annotations.push({ type: 'window', description: `rows of ${shown.join(', ')}` });
    expect(await page.evaluate('location.hash'), 'the token left the URL').toBe('');
    expect(await page.evaluate('typeof require + typeof process + typeof module')).toBe(
      'undefinedundefinedundefined',
    );
    expect(await page.evaluate('window.open("file:///etc/passwd") === null')).toBe(true);
    await page.evaluate('location.href = "http://example.invalid/"; true');
    await new Promise((r) => setTimeout(r, 750));
    expect(await page.evaluate('location.origin'), 'navigation stays on the daemon').toBe(origin);
    expect(daemonLog(dirs)).toContain('blocked a navigation to http://example.invalid');
    expect(await page.evaluate('Notification.requestPermission()')).toBe('denied');
    expect(
      await page.evaluate(
        'navigator.permissions.query({ name: "geolocation" }).then((p) => p.state)',
      ),
    ).toBe('denied');
    if (process.env.OCTOPUS_DESKTOP_SCREENSHOT) {
      writeFileSync(process.env.OCTOPUS_DESKTOP_SCREENSHOT, await page.screenshot());
    }

    // Every read path through the app's daemon, while the window and the simulator are live.
    const sub = client.subscribe({ onEvent: () => {} });
    await client.inbox();
    await client.inbox({ onlyUnreviewed: true });
    for (const { worktrees } of projects) {
      for (const { worktree } of worktrees) {
        if (worktree.bare || worktree.missing) continue;
        await client.refreshWorktree(worktree.id);
        const commits = worktree.headSha
          ? (await client.listCommits(worktree.id, { limit: 3 })).commits
          : [];
        const scopes = [
          { kind: 'working' as const },
          { kind: 'staged' as const },
          ...(worktree.headSha ? [{ kind: 'branch' as const }] : []),
          ...commits.slice(0, 1).map((c) => ({ kind: 'commit' as const, sha: c.sha })),
        ];
        for (const scope of scopes) {
          const { files } = await client.listFiles(worktree.id, { scope });
          for (const file of files.slice(0, 20)) {
            try {
              await client.getDiff(worktree.id, {
                scope,
                path: file.path,
                ...(file.rawPath ? { rawPath: file.rawPath } : {}),
              });
            } catch (error) {
              // The simulator edits live-agent: a listed file may be gone by the time it is read.
              const raced =
                worktree.path === live.path &&
                error instanceof ApiClientError &&
                error.code === 'not_found';
              if (!raced) throw error;
            }
          }
        }
      }
    }
    for (const scanRoot of (await client.listScanRoots()).scanRoots) {
      await client.rescanScanRoot(scanRoot.id);
    }
    sub.close();

    // Quit the way a user does: close the window (Linux, Windows) or Quit (macOS: SIGTERM, which
    // the app handles like Cmd+Q). The app-started daemon stops with it.
    const t0 = Date.now();
    if (IS_MAC) run.child.kill('SIGTERM');
    else await page.evaluate('window.close(); true').catch(() => undefined);
    const exit = await Promise.race([
      run.exited,
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30_000)),
    ]);
    expect(exit, `the app quits (${run.output().slice(-500)})`).not.toBe('timeout');
    await until(() => !alive(daemon.pid), 15_000, 'the daemon to stop');
    test.info().annotations.push({
      type: 'quit',
      description: `app and daemon gone ${Date.now() - t0} ms after the quit request`,
    });
    expect(existsSync(join(dirs.stateDir, 'daemon.json')), 'daemon.json removed').toBe(false);
    const log = daemonLog(dirs);
    expect(log).not.toContain('#token=');
    expect(log).not.toContain(daemon.token);
  } finally {
    await sim.stop();
    if (alive(run.child.pid ?? 0)) run.child.kill('SIGKILL');
  }
  const report = await proof.finish();
  test.info().annotations.push({
    type: 'readonly-proof',
    description: `${report.repos.length} repos, ${report.pollCount} polls, ${report.violations.length} violations`,
  });
  assertReadOnly(report);
});

test('killing the app leaves no daemon', async () => {
  const dirs = appDirs(root, 'killed');
  const run = launchApp(app, dirs, env);
  track(run.child.pid);
  const daemon = await waitReady(dirs);
  // SIGKILL; on Windows `kill()` is TerminateProcess, equally abrupt.
  run.child.kill('SIGKILL');
  await run.exited;
  const t0 = Date.now();
  await until(() => !alive(daemon.pid), 20_000, 'the daemon to exit after the app was killed');
  test.info().annotations.push({
    type: 'kill',
    description: `daemon exited ${Date.now() - t0} ms after the app was killed`,
  });
  expect(existsSync(join(dirs.stateDir, 'daemon.json')), 'it shut down gracefully').toBe(false);
});

test('asar integrity: a modified app.asar does not run (macOS, Windows)', async () => {
  test.setTimeout(180_000);
  // Copy the app (a .app bundle on macOS, the app directory elsewhere) and change one byte of
  // dist/main.js inside the copy's app.asar (a string literal: still valid JavaScript).
  const appRoot = IS_MAC ? dirname(dirname(dirname(app.executable))) : dirname(app.executable);
  const copyParent = mkdtempSync(join(root, 'tampered-'));
  const copyRoot = join(copyParent, IS_MAC ? 'octopus-diff.app' : 'app');
  cpSync(appRoot, copyRoot, { recursive: true, verbatimSymlinks: true });
  const relExe = app.executable.slice(appRoot.length);
  const relAsar = join(app.resources, 'app.asar').slice(appRoot.length);
  const asarPath = join(copyRoot, relAsar);
  const asar = readFileSync(asarPath);
  const dataStart = 8 + asar.readUInt32LE(4);
  const at = asar.indexOf('blocked a navigation to', dataStart, 'utf8');
  expect(at, 'the marker string is in main.js inside the asar').toBeGreaterThan(dataStart);
  asar[at] = 'B'.charCodeAt(0);
  writeFileSync(asarPath, asar);

  const tampered: PackagedApp = {
    executable: join(copyRoot, relExe),
    resources: join(copyRoot, app.resources.slice(appRoot.length)),
    cliEntry: '',
  };
  const dirs = appDirs(root, 'tampered');
  const run = launchApp(tampered, dirs, env);
  track(run.child.pid);
  const outcome = await Promise.race([
    run.exited.then((e) => ({ kind: 'exited' as const, ...e })),
    until(() => daemonLog(dirs).includes('started the backend'), 30_000, 'a backend').then(
      () => ({ kind: 'ran' as const }),
      () => ({ kind: 'hung' as const }),
    ),
  ]);
  const ran = outcome.kind === 'ran' || existsSync(join(dirs.appData, 'logs', 'daemon.log'));
  if (alive(run.child.pid ?? 0)) run.child.kill('SIGKILL');
  await run.exited;
  const info = daemonInfo(dirs);
  if (info) track(info.pid);
  const description = `${process.platform}: ${JSON.stringify(outcome)}; main.js ran: ${ran}; output: ${run
    .output()
    .split('\n')
    .filter((l) => /integrity|asar|fatal/i.test(l))
    .slice(0, 3)
    .join(' | ')}`;
  test.info().annotations.push({ type: 'asar integrity', description });
  if (process.platform === 'linux') {
    // Electron validates the asar on macOS and Windows only; on Linux the fuse is set (check-fuses)
    // but the archive is not checked. Recorded, not asserted.
    return;
  }
  expect(ran, `the tampered app must not run its main process (${description})`).toBe(false);
  expect(outcome.kind, description).toBe('exited');
  if (outcome.kind === 'exited') {
    expect(outcome.code === 0 && outcome.signal === null, description).toBe(false);
  }
  rmSync(copyParent, { recursive: true, force: true });
});
