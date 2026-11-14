/**
 * Opt-in measurement (DECISIONS #595): launches the packaged app `OCTOPUS_DESKTOP_WINDOW_REPEAT`
 * times (default 0: skipped) and counts how often the window reached the web UI, and how often it
 * needed more than one load attempt, the way the macOS CI flake was measured. Each launch does what
 * packaged-app.spec.ts does before it looks at the window, under the same load (the read-only proof
 * polling every fixture repo, the agent simulator writing to live-agent): wait for the backend,
 * `status`, `add` every project and scan root with the bundled CLI, then wait for the UI page and
 * `data-ready`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_IDS } from '@octopus-diff/contracts';
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
import { failedUiAttempts, redact, windowTimeline } from './support/diagnostics.js';
import {
  alive,
  appDirs,
  cli,
  daemonInfo,
  daemonLog,
  launchApp,
  type PackagedApp,
  packagedApp,
  until,
  withWindowDiagnostics,
} from './support/packaged-app.js';

const REPEAT = Number(process.env.OCTOPUS_DESKTOP_WINDOW_REPEAT ?? '0');

test.describe.configure({ mode: 'serial' });

let app: PackagedApp;
let fixtures: FixtureSet;
let root: string;
let env: NodeJS.ProcessEnv;

test.skip(!(REPEAT > 0) || process.platform === 'win32', 'set OCTOPUS_DESKTOP_WINDOW_REPEAT=<n>');

test.beforeAll(async () => {
  app = packagedApp();
  fixtures = await generateFixtures({ seed: 1902 });
  root = mkdtempSync(join(tmpdir(), 'octopus-diff-desktop-repeat-'));
  env = { ...process.env, ...fixtures.env.vars };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && !(key in fixtures.env.vars)) delete env[key];
  }
});

test.afterAll(async () => {
  await fixtures?.cleanup();
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

test(`the window reaches the web UI, ${REPEAT} launches`, async () => {
  test.setTimeout(REPEAT * 150_000);
  const paths = registeredProjects(fixtures.manifest)
    .map((p) => (p.registration?.kind === 'path' ? p.registration.path : null))
    .filter((p): p is string => p !== null);
  const { manifest } = fixtures;
  const proof = await startReadOnlyProof({
    env: fixtures.env,
    targets: proofTargetsFromManifest(manifest),
  });
  const live = findWorktree(manifest, 'live-agent').worktree;
  const results: string[] = [];
  let failed = 0;
  let retried = 0;
  for (let i = 1; i <= REPEAT; i++) {
    const dirs = appDirs(root, `launch-${i}`);
    const run = launchApp(app, dirs, env);
    const sim = startAgentSimulator({
      targets: [{ path: live.path, name: 'live-agent' }],
      env: fixtures.env,
      seed: 19 + i,
      durationMs: 15_000,
      minIntervalMs: 150,
      maxIntervalMs: 500,
    });
    let daemonPid: number | null = null;
    const t0 = Date.now();
    try {
      await until(() => daemonLog(dirs).includes('backend ready: started'), 60_000, 'the backend');
      const daemon = await until(() => daemonInfo(dirs), 10_000, 'daemon.json');
      daemonPid = daemon.pid;
      cli(app, dirs, env, 'status', '--json');
      for (const path of paths) cli(app, dirs, env, 'add', path);
      for (const scanRoot of manifest.scanRoots) {
        cli(app, dirs, env, 'add', '--scan', scanRoot.path, '--depth', String(scanRoot.depth));
      }
      const origin = new URL(daemon.url).origin;
      const page = await withWindowDiagnostics(run, dirs, [daemon.token], () =>
        run.cdp.page((url) => url.startsWith(origin), 60_000),
      );
      await withWindowDiagnostics(run, dirs, [daemon.token], () =>
        page.waitFor(
          `document.querySelector('[data-testid="${TEST_IDS.app}"]')?.getAttribute('data-ready') === 'true'`,
          60_000,
          'the web UI to be ready',
        ),
      );
      const timeline = windowTimeline(daemonLog(dirs));
      const attempts = failedUiAttempts(timeline);
      if (attempts > 0) retried++;
      results.push(`launch ${i}: UI after ${Date.now() - t0} ms, ${attempts} failed attempt(s)`);
      if (attempts > 0) console.log(redact(timeline.join('\n'), [daemon.token]));
    } catch (error) {
      failed++;
      results.push(`launch ${i}: FAILED after ${Date.now() - t0} ms`);
      console.log(`launch ${i} failed:\n${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await sim.stop();
      run.child.kill('SIGTERM');
      const exit = await Promise.race([
        run.exited,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 20_000)),
      ]);
      if (exit === 'timeout') run.child.kill('SIGKILL');
      const pid = daemonPid ?? daemonInfo(dirs)?.pid ?? null;
      if (pid !== null) await until(() => !alive(pid), 20_000, 'the daemon to stop').catch(() => 0);
    }
  }
  const summary = `window repeat (${process.platform}): ${REPEAT} launches, ${failed} failed, ${retried} needed a retry`;
  console.log(`${summary}\n${results.join('\n')}`);
  test.info().annotations.push({ type: 'window repeat', description: summary });
  expect(failed, summary).toBe(0);
  assertReadOnly(await proof.finish());
});
