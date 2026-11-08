import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertReadOnly,
  generateFixtures,
  proofTargetsFromManifest,
  type ReadOnlyProof,
  startReadOnlyProof,
} from '@octopus-diff/fixtures';
import type { FullConfig } from '@playwright/test';
import { TestDaemon } from './daemon.js';
import {
  assertBuilt,
  E2E_DIR,
  E2ePreflightError,
  ENV,
  scrubGitEnvironment,
  webUiProblem,
} from './env.js';

/**
 * Playwright global setup (runs once, in the runner process):
 * 1. preflight: package builds exist, the web bundle is not the placeholder;
 * 2. generate the fixture repositories (OS temp dir, isolated git config);
 * 3. start the read-only proof (snapshots + lock watching) over every control repository;
 * 4. smoke-start the daemon so a placeholder/broken daemon fails here with one clear message;
 * 5. hand the manifest to the workers via env.
 * The returned teardown finishes the proof and fails the run loudly on any violation.
 */
export default async function globalSetup(_config: FullConfig): Promise<() => Promise<void>> {
  scrubGitEnvironment();
  assertBuilt();
  const uiProblem = webUiProblem();

  const fixtures = await generateFixtures({ seed: Number(process.env[ENV.seed] ?? 1) });
  process.env[ENV.manifest] = fixtures.manifestPath;
  process.env[ENV.root] = fixtures.root;

  let proof: ReadOnlyProof | null = null;
  try {
    proof = await startReadOnlyProof({
      env: fixtures.env,
      targets: proofTargetsFromManifest(fixtures.manifest),
    });
    const daemonProblem = await smokeTestDaemon(fixtures.manifest).then(
      () => null,
      (error: unknown) => {
        if (error instanceof E2ePreflightError) return error.problem;
        throw error;
      },
    );
    const problems = [daemonProblem, uiProblem].filter((p): p is string => p !== null);
    if (problems.length) throw new E2ePreflightError(problems.join('\n\n  ...and: '));
  } catch (error) {
    await proof?.finish().catch(() => {});
    await fixtures.cleanup().catch(() => {});
    throw error;
  }

  return async () => {
    const report = await (proof as ReadOnlyProof).finish();
    const resultsDir = join(E2E_DIR, 'test-results');
    await mkdir(resultsDir, { recursive: true });
    const reportPath = join(resultsDir, 'readonly-proof.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    const keep = process.env[ENV.keep] === '1' || !report.ok;
    if (keep) {
      process.stderr.write(`[e2e] fixtures kept at ${fixtures.root}\n`);
    } else {
      await fixtures.cleanup();
    }
    process.stderr.write(
      `[e2e] read-only proof: ${report.repos.length} control repos, ${report.pollCount} lock polls, ` +
        `${report.violations.length} violation(s) → ${reportPath}\n`,
    );
    assertReadOnly(report);
  };
}

async function smokeTestDaemon(manifest: Awaited<ReturnType<typeof generateFixtures>>['manifest']) {
  const daemon = await TestDaemon.start({ manifest, register: 'none', webRoot: null });
  try {
    const health = await daemon.client.health().catch((error: unknown) => {
      throw new E2ePreflightError(
        `the daemon started but GET /api/health failed: ${String(error)}`,
      );
    });
    if (!health.git.supported) {
      throw new E2ePreflightError(`the daemon reports an unsupported git (${health.git.version})`);
    }
    const alpha = manifest.projects.find((p) => p.name === 'alpha');
    if (!alpha?.mainWorktreePath) throw new Error('fixture alpha missing');
    await daemon.client.addProject({ path: alpha.mainWorktreePath }).catch((error: unknown) => {
      throw new E2ePreflightError(
        `the daemon could not register a fixture repository (${String(error)}).\n` +
          '  If @octopus-diff/git-core is still the Phase 0 placeholder (not_implemented), merge WS1 and rebuild.',
      );
    });
  } finally {
    await daemon.close();
  }
}
