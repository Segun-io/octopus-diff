import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (this file lives in `e2e/support/`). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const E2E_DIR = join(REPO_ROOT, 'e2e');
export const WEB_DIST = join(REPO_ROOT, 'apps', 'web', 'dist');

/** Environment variables global setup hands to the workers. */
export const ENV = {
  manifest: 'OCTOPUS_E2E_MANIFEST',
  root: 'OCTOPUS_E2E_ROOT',
  seed: 'OCTOPUS_E2E_SEED',
  keep: 'OCTOPUS_E2E_KEEP_FIXTURES',
  liveBudget: 'OCTOPUS_E2E_LIVE_BUDGET_MS',
  daemonLog: 'OCTOPUS_E2E_DAEMON_LOG',
  skipUiCheck: 'OCTOPUS_E2E_SKIP_UI_CHECK',
} as const;

/** PLAN §8 item 5: external edits show up within ~1.5 s. Overridable for slow CI machines. */
export function liveBudgetMs(): number {
  const value = Number(process.env[ENV.liveBudget]);
  return Number.isFinite(value) && value > 0 ? value : 1500;
}

/**
 * Dev-machine workaround (DECISIONS #19): Chromium's system libraries are extracted user-locally
 * because there is no sudo. Prepends them to LD_LIBRARY_PATH when present. Used by the Playwright
 * config, the bench and the screenshot script (all of which launch Chromium).
 */
export function applyChromiumLibraryPath(): void {
  const localChromiumLibs =
    process.env.OCTOPUS_DIFF_CHROMIUM_LIBS ??
    join(homedir(), '.cache/octopus-diff-dev/chromium-libs/usr/lib/x86_64-linux-gnu');
  if (process.platform === 'linux' && existsSync(localChromiumLibs)) {
    const current = process.env.LD_LIBRARY_PATH;
    if (!current?.split(':').includes(localChromiumLibs)) {
      process.env.LD_LIBRARY_PATH = current ? `${localChromiumLibs}:${current}` : localChromiumLibs;
    }
  }
}

/** Removes inherited `GIT_*` variables (a run from inside a git hook would leak `GIT_DIR`). */
export function scrubGitEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) delete process.env[key];
  }
}

export class E2ePreflightError extends Error {
  readonly problem: string;

  constructor(problem: string) {
    super(`\n\n  octopus-diff e2e cannot run: ${problem}\n`);
    this.name = 'E2ePreflightError';
    this.problem = problem;
  }
}

const REQUIRED_BUILDS = [
  'packages/contracts/dist/index.js',
  'packages/git-core/dist/index.js',
  'apps/daemon/dist/index.js',
  'tools/fixtures/dist/index.js',
  'apps/web/dist/index.html',
];

/** Fails fast (with instructions) when `pnpm build` has not been run. */
export function assertBuilt(): void {
  const missing = REQUIRED_BUILDS.filter((rel) => !existsSync(join(REPO_ROOT, rel)));
  if (missing.length) {
    throw new E2ePreflightError(
      `missing build output:\n${missing.map((m) => `    - ${m}`).join('\n')}\n\n  Run \`pnpm build\` at the repository root, then \`pnpm test:e2e\` again.`,
    );
  }
}

/**
 * The Phase 0 web placeholder renders no TEST_IDS hooks. Detect it from the bundle so the suite
 * fails with one clear message instead of dozens of selector timeouts.
 */
export function webUiProblem(): string | null {
  if (process.env[ENV.skipUiCheck] === '1') return null;
  const assets = join(WEB_DIST, 'assets');
  const bundles = existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith('.js')) : [];
  const hasHooks = bundles.some((file) => {
    const text = readFileSync(join(assets, file), 'utf8');
    return text.includes('data-ready') && text.includes('worktree-item');
  });
  return hasHooks
    ? null
    : 'apps/web/dist looks like the Phase 0 placeholder UI: its bundle has no TEST_IDS hooks ' +
        '(`data-ready`, `worktree-item`).\n  The e2e suite needs the WS3 web UI. Merge it, run `pnpm build`, ' +
        `and retry (or set ${ENV.skipUiCheck}=1 to skip this check).`;
}
