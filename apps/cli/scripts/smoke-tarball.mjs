// Smoke test of an installed CLI tarball (the CI `package` job; issue #45): starts
// `octopus-diff serve` on a scratch repository, reads one file's diff through the API, checks that
// git ran through the spawn helper (a helper process is a child of the daemon), then SIGKILLs the
// daemon and checks that the helper and every git process it started are gone (no orphans).
//
//   node apps/cli/scripts/smoke-tarball.mjs <dir with node_modules/.bin/octopus-diff>
//
// POSIX only (the helper is not used on Windows). Never touches a real repository: the fixture is
// a temp dir with its own git config.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const installDir = path.resolve(process.argv[2] ?? '.');
const bin = path.join(installDir, 'node_modules', '.bin', 'octopus-diff');
const root = mkdtempSync(path.join(os.tmpdir(), 'octopus-diff-smoke-'));
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(root, '.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
};
writeFileSync(
  gitEnv.GIT_CONFIG_GLOBAL,
  '[user]\n\tname = Smoke\n\temail = smoke@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n[commit]\n\tgpgsign = false\n',
);
const repo = path.join(root, 'repo');
const git = (...args) => execFileSync('git', args, { cwd: root, env: gitEnv, stdio: 'pipe' });

function fail(message) {
  console.error(`smoke: FAIL ${message}`);
  process.exitCode = 1;
}

/** pid → { ppid, args } of every process (POSIX `ps`). */
function processes() {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const table = new Map();
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), args: match[3] });
  }
  return table;
}

async function until(condition, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let daemon;
try {
  git('init', '-q', repo);
  writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  git('-C', repo, 'add', '.');
  git('-C', repo, 'commit', '-q', '-m', 'init');
  writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\n');

  const stateDir = path.join(root, 'state');
  daemon = spawn(
    bin,
    [
      'serve',
      repo,
      '--port',
      '0',
      '--no-open',
      '--state-dir',
      stateDir,
      '--config-dir',
      path.join(root, 'config'),
      '--log-level',
      'warn',
    ],
    { env: gitEnv, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const runtime = await until(
    () => {
      try {
        return JSON.parse(readFileSync(path.join(stateDir, 'daemon.json'), 'utf8'));
      } catch {
        return null;
      }
    },
    20_000,
    'daemon.json',
  );
  const token = readFileSync(path.join(stateDir, 'token'), 'utf8').trim();
  const api = async (route) => {
    const response = await fetch(new URL(route, runtime.url), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
    return response.json();
  };
  const { projects } = await until(
    async () => {
      const body = await api('/api/projects');
      return body.projects?.[0]?.worktrees?.[0]?.summary ? body : null;
    },
    20_000,
    'the first summary',
  );
  const worktreeId = projects[0].worktrees[0].worktree.id;
  const { diff } = await api(`/api/worktrees/${worktreeId}/diff?scope=working&path=a.txt`);
  const patch = JSON.stringify(diff);
  if (!patch.includes('TWO')) fail(`the diff of a.txt does not show the change: ${patch}`);
  else console.log('smoke: diff of a.txt through the daemon: ok');

  const table = processes();
  const helpers = [...table]
    .filter(([, p]) => p.ppid === daemon.pid && p.args.includes('--octopus-diff-git-helper'))
    .map(([pid]) => pid);
  if (process.env.OCTOPUS_DIFF_GIT_HELPER === '0') {
    if (helpers.length > 0) fail('helper processes run although OCTOPUS_DIFF_GIT_HELPER=0');
  } else if (helpers.length === 0) {
    fail('no git helper process under the daemon');
  } else {
    console.log(`smoke: ${helpers.length} git helper process(es) under the daemon: ok`);
  }

  // The daemon dies without any cleanup: the helpers must notice and exit, killing their git.
  daemon.kill('SIGKILL');
  await until(
    () => {
      const now = processes();
      return (
        helpers.every((pid) => !now.has(pid)) &&
        ![...now.values()].some((p) => p.args.includes(repo) && /\bgit\b/.test(p.args))
      );
    },
    10_000,
    'the helpers and their git processes to exit after SIGKILL of the daemon',
  );
  console.log('smoke: after SIGKILL of the daemon no helper or git process is left: ok');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
  rmSync(root, { recursive: true, force: true });
}
