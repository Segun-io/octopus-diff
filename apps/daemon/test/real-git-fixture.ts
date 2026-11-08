import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Daemon, startDaemon } from '../src/daemon.js';
import { onCleanup, TEST_TOKEN, tempDir } from './helpers.js';

/**
 * Real-git fixtures for integration tests (AGENTS.md "Tests that create git repositories"):
 * temp dir, isolated global config, fixed identities and dates. Git is only used here to build
 * fixtures; everything the daemon does goes through git-core.
 */
export interface RealGitFixture {
  root: string;
  env: Record<string, string>;
  git: (cwd: string, ...args: string[]) => string;
}

export async function makeRealGitFixture(): Promise<RealGitFixture> {
  const root = realpathSync(await tempDir('octopus-diff-it-'));
  const gitconfig = path.join(root, 'gitconfig');
  await writeFile(
    gitconfig,
    [
      '[user]',
      '\tname = Fixture',
      '\temail = fixture@example.com',
      '[init]',
      '\tdefaultBranch = main',
      '[commit]',
      '\tgpgsign = false',
      '[core]',
      '\tautocrlf = false',
      '',
    ].join('\n'),
  );
  const env: Record<string, string> = {
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('GIT_')) baseEnv[k] = v;
  }
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: { ...baseEnv, ...env }, encoding: 'utf8' });
  return { root, env, git };
}

export async function makeRealRepo(
  fx: RealGitFixture,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = path.join(fx.root, name);
  fx.git(fx.root, 'init', '-q', name);
  for (const [file, content] of Object.entries(files))
    await writeFile(path.join(dir, file), content);
  fx.git(dir, 'add', '-A');
  fx.git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

export async function startRealGitDaemon(fx: RealGitFixture, stateDir: string): Promise<Daemon> {
  const daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir,
    logLevel: process.env.OCTOPUS_DIFF_TEST_LOGS ? 'debug' : 'silent',
    git: { env: fx.env },
    watch: { debounceMs: 150 },
  });
  onCleanup(() => daemon.close());
  return daemon;
}
