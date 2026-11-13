import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { APP_NAME } from '@octopus-diff/contracts';
import { MIN_GIT_VERSION } from '@octopus-diff/git-core';
import type { DoctorFlags } from '../args.js';
import type { ResolvedConfig } from '../config.js';
import type { CliDeps } from '../deps.js';
import { EXIT_FAILURE, EXIT_OK, errorMessage, UsageError } from '../errors.js';
import { resolveUserPath, tildify } from '../paths.js';
import { detectWsl, isWindowsMountPath } from '../platform.js';
import { readToken, runtimeFilePath, tokenFilePath } from '../runtime.js';
import {
  baseUrlFor,
  loadContext,
  resolveAddress,
  resolveConfigLocation,
  resolveStateDir,
} from '../settings.js';
import { resolveWebRoot, webRootCandidates } from '../web-assets.js';
import { findRunningDaemon, verifyDaemon } from './daemon-client.js';

/** Oldest supported git: git-core owns it (it refuses older versions with `git_unsupported`). */
export { MIN_GIT_VERSION };
export const MIN_NODE_MAJOR = 24;
/** Below these, watching many worktrees can exhaust inotify (PLAN §5.6, §9). */
export const RECOMMENDED_INOTIFY_WATCHES = 524_288;
export const RECOMMENDED_INOTIFY_INSTANCES = 512;

export type CheckStatus = 'ok' | 'info' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** Commands or steps that fix the problem. */
  fix?: string[];
}

export interface DoctorHooks {
  webRootCandidates?: string[];
}

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

function formatVersion(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function compareVersions(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** Parses `git version 2.53.0` (also `2.39.3 (Apple Git-146)`, `2.45.1.windows.1`). */
export function parseGitVersion(output: string): SemVer | null {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) };
}

async function checkGit(config: ResolvedConfig, deps: CliDeps): Promise<DoctorCheck> {
  const binary = config.git?.gitBinary ?? 'git';
  const need = formatVersion(MIN_GIT_VERSION);
  const title = 'git';
  let output: string;
  try {
    // Only `git --version`, run from the temp dir: it never touches a repository. `runProgram`
    // resolves a bare name through the absolute PATH entries only (SEC-03).
    output = (await deps.runProgram(binary, ['--version'])).stdout;
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      id: 'git',
      title,
      status: 'fail',
      detail: missing
        ? `"${binary}" not found on PATH (absolute entries only)`
        : `"${binary} --version" failed: ${errorMessage(error)}`,
      fix: [`install git ${need} or newer`],
    };
  }
  const version = parseGitVersion(output);
  if (!version) {
    return { id: 'git', title, status: 'warn', detail: `could not parse "${output.trim()}"` };
  }
  if (compareVersions(version, MIN_GIT_VERSION) < 0) {
    return {
      id: 'git',
      title,
      status: 'fail',
      detail: `${formatVersion(version)} is older than the minimum ${need}`,
      fix: [`upgrade git to ${need} or newer`],
    };
  }
  return { id: 'git', title, status: 'ok', detail: `${formatVersion(version)} (need >= ${need})` };
}

async function checkGitHelper(config: ResolvedConfig, deps: CliDeps): Promise<DoctorCheck> {
  const probe = await deps.probeGitHelper({
    gitBinary: config.git?.gitBinary ?? 'git',
    enabled: config.git?.helper !== false,
  });
  const title = 'git helper';
  if (probe.state === 'on') return { id: 'git-helper', title, status: 'ok', detail: probe.detail };
  if (probe.state === 'off')
    return { id: 'git-helper', title, status: 'info', detail: probe.detail };
  return {
    id: 'git-helper',
    title,
    status: 'warn',
    detail: probe.detail,
    fix: [
      'reinstall octopus-diff; git still works, but every git process blocks the daemon briefly',
    ],
  };
}

function checkNode(deps: CliDeps): DoctorCheck {
  const major = Number(deps.nodeVersion.split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? {
        id: 'node',
        title: 'Node.js',
        status: 'ok',
        detail: `v${deps.nodeVersion} (need >= ${MIN_NODE_MAJOR})`,
      }
    : {
        id: 'node',
        title: 'Node.js',
        status: 'fail',
        detail: `v${deps.nodeVersion} is older than the minimum ${MIN_NODE_MAJOR}`,
        fix: [`install Node.js ${MIN_NODE_MAJOR} or newer`],
      };
}

function inotifyFix(
  current: { watches: number | null; instances: number | null },
  wsl: boolean,
): string[] {
  // Never lower a value that is already higher than the recommendation.
  const watches = Math.max(current.watches ?? 0, RECOMMENDED_INOTIFY_WATCHES);
  const instances = Math.max(current.instances ?? 0, RECOMMENDED_INOTIFY_INSTANCES);
  const conf = `fs.inotify.max_user_watches=${watches}\\nfs.inotify.max_user_instances=${instances}`;
  const fix = [
    `printf '${conf}\\n' | sudo tee /etc/sysctl.d/60-octopus-diff.conf && sudo sysctl --system`,
  ];
  if (wsl) {
    fix.push(
      'WSL without systemd does not apply /etc/sysctl.d at boot; run `sudo sysctl --system` after ' +
        'each start, or add it to the [boot] command in /etc/wsl.conf',
    );
  }
  fix.push('or run `octopus-diff serve --poll` to avoid native watchers');
  return fix;
}

function checkInotify(deps: CliDeps, wsl: boolean): DoctorCheck[] {
  if (deps.platform !== 'linux') return [];
  const read = (name: string): number | null => {
    const text = deps.readText(`/proc/sys/fs/inotify/${name}`);
    const value = text === null ? Number.NaN : Number(text.trim());
    return Number.isFinite(value) ? value : null;
  };
  const checks: DoctorCheck[] = [];
  const current = { watches: read('max_user_watches'), instances: read('max_user_instances') };
  const items = [
    {
      id: 'inotify-watches',
      name: 'max_user_watches',
      title: 'inotify watches',
      want: RECOMMENDED_INOTIFY_WATCHES,
      value: current.watches,
    },
    {
      id: 'inotify-instances',
      name: 'max_user_instances',
      title: 'inotify instances',
      want: RECOMMENDED_INOTIFY_INSTANCES,
      value: current.instances,
    },
  ];
  for (const item of items) {
    const { value } = item;
    if (value === null) {
      checks.push({
        id: item.id,
        title: item.title,
        status: 'warn',
        detail: `could not read /proc/sys/fs/inotify/${item.name}`,
      });
    } else if (value < item.want) {
      checks.push({
        id: item.id,
        title: item.title,
        status: 'warn',
        detail: `${item.name} = ${value}, low for many worktrees (recommended >= ${item.want}); the daemon falls back to polling when it runs out`,
        fix: inotifyFix(current, wsl),
      });
    } else {
      checks.push({
        id: item.id,
        title: item.title,
        status: 'ok',
        detail: `${item.name} = ${value}`,
      });
    }
  }
  return checks;
}

function checkPlatform(deps: CliDeps, config: ResolvedConfig): DoctorCheck[] {
  const wsl = detectWsl(deps.platform, deps.env, deps.readText);
  if (!wsl.wsl) {
    return [{ id: 'platform', title: 'platform', status: 'info', detail: deps.platform }];
  }
  const name = `WSL${wsl.version ?? ''}${wsl.distro ? ` (${wsl.distro})` : ''}`;
  const checks: DoctorCheck[] = [
    {
      id: 'platform',
      title: 'platform',
      status: 'info',
      detail:
        `${name}. Keep repositories in the Linux filesystem (e.g. ~/code): on /mnt/* (Windows ` +
        'drives) git is slow and file watching does not see edits made from Windows.',
    },
  ];
  const configured = [...(config.projects ?? []), ...(config.scanRoots ?? []).map((r) => r.path)];
  const onMount = configured.filter(isWindowsMountPath);
  if (onMount.length > 0) {
    const polling = config.watch?.forcePolling === true;
    checks.push({
      id: 'wsl-mounts',
      title: 'Windows drives',
      status: polling ? 'info' : 'warn',
      detail: `configured on /mnt/*: ${onMount.join(', ')}${polling ? ' (polling is on)' : ''}`,
      ...(polling
        ? {}
        : {
            fix: [
              'move the repositories into the Linux filesystem, or set "watch": { "forcePolling": true }',
            ],
          }),
    });
  }
  return checks;
}

function checkConfig(file: string, exists: boolean, home: string): DoctorCheck {
  return exists
    ? { id: 'config', title: 'config file', status: 'ok', detail: `${tildify(file, home)} (valid)` }
    : {
        id: 'config',
        title: 'config file',
        status: 'info',
        detail: `${tildify(file, home)} (not found; using defaults)`,
      };
}

async function checkStateDir(stateDir: string, home: string): Promise<DoctorCheck[]> {
  const show = tildify(stateDir, home);
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(stateDir);
  } catch {
    return [
      {
        id: 'state-dir',
        title: 'state dir',
        status: 'info',
        detail: `${show} (created on first serve)`,
      },
    ];
  }
  const checks: DoctorCheck[] = [];
  if (!st.isDirectory()) {
    return [
      { id: 'state-dir', title: 'state dir', status: 'fail', detail: `${show} is not a directory` },
    ];
  }
  try {
    await access(stateDir, constants.W_OK);
    const loose = (st.mode & 0o077) !== 0;
    checks.push({
      id: 'state-dir',
      title: 'state dir',
      status: loose ? 'warn' : 'ok',
      detail: `${show} (mode ${(st.mode & 0o777).toString(8)}${loose ? ', accessible by other users' : ''})`,
      ...(loose ? { fix: [`chmod 700 ${stateDir}`] } : {}),
    });
  } catch {
    checks.push({
      id: 'state-dir',
      title: 'state dir',
      status: 'fail',
      detail: `${show} is not writable`,
    });
  }

  const token = tokenFilePath(stateDir);
  try {
    const tst = await stat(token);
    const loose = (tst.mode & 0o077) !== 0;
    checks.push({
      id: 'token',
      title: 'token file',
      status: loose ? 'fail' : 'ok',
      detail: `${tildify(token, home)} (mode ${(tst.mode & 0o777).toString(8)}${loose ? ', readable by other users' : ''})`,
      // It may already have been copied: replace it, don't just chmod it (SEC-11). The daemon
      // also replaces such a file on its next start.
      ...(loose ? { fix: [`${APP_NAME} token --rotate, then restart the daemon`] } : {}),
    });
  } catch {
    checks.push({
      id: 'token',
      title: 'token file',
      status: 'info',
      detail: 'not created yet (created on first serve)',
    });
  }
  return checks;
}

async function checkPort(
  flags: DoctorFlags,
  config: ResolvedConfig,
  stateDir: string,
  deps: CliDeps,
): Promise<DoctorCheck> {
  const { host, port } = resolveAddress(flags, config);
  const title = 'port';
  // A daemon only counts as ours if it proves it holds the token (health challenge, SEC-02).
  const running = await findRunningDaemon(stateDir, deps);
  if (running?.verified) {
    return {
      id: 'port',
      title,
      status: 'ok',
      detail: `${APP_NAME} is running at ${running.url} (pid ${running.pid})`,
    };
  }
  if (running) {
    return {
      id: 'port',
      title,
      status: 'warn',
      detail: `${running.url} (recorded in the state dir) answers but could not prove it holds the token`,
      fix: [`stop it, or remove ${runtimeFilePath(stateDir)}`],
    };
  }
  if (port === 0)
    return { id: 'port', title, status: 'ok', detail: 'port 0: a free port is picked at startup' };
  const probe = await deps.probePort(host, port);
  if (probe === 'free')
    return { id: 'port', title, status: 'ok', detail: `${host}:${port} is free` };
  if (probe === 'in_use') {
    const url = baseUrlFor(host, port);
    const answer = await verifyDaemon(url, await readToken(stateDir), deps).catch(() => null);
    if (answer?.verified) {
      return {
        id: 'port',
        title,
        status: 'ok',
        detail: `${APP_NAME} is already running at ${url}`,
      };
    }
    if (answer) {
      return {
        id: 'port',
        title,
        status: 'warn',
        detail: `${host}:${port} answers like ${APP_NAME} but could not prove it holds this state dir's token`,
        fix: ['another --state-dir or an older version? Otherwise pass --port <n>'],
      };
    }
    return {
      id: 'port',
      title,
      status: 'fail',
      detail: `${host}:${port} is in use by another program`,
      fix: ['pass --port <n> (or set "port" in the config file)'],
    };
  }
  return {
    id: 'port',
    title,
    status: 'fail',
    detail:
      probe === 'denied' ? `not allowed to bind ${host}:${port}` : `cannot bind ${host}:${port}`,
    fix: ['use a port above 1024 and an address of this machine (default 127.0.0.1)'],
  };
}

function checkWebAssets(
  explicit: string | undefined,
  home: string,
  hooks: DoctorHooks,
): DoctorCheck {
  const result = resolveWebRoot(explicit, hooks.webRootCandidates ?? webRootCandidates());
  if (result.kind === 'found') {
    return { id: 'web', title: 'web UI', status: 'ok', detail: tildify(result.dir, home) };
  }
  return {
    id: 'web',
    title: 'web UI',
    status: 'fail',
    detail: result.explicit
      ? `${tildify(result.dir, home)} has no index.html`
      : `built assets not found (looked in ${result.searched.map((d) => tildify(d, home)).join(', ')})`,
    fix: ['run `pnpm build` in the octopus-diff checkout'],
  };
}

export async function collectChecks(
  flags: DoctorFlags,
  deps: CliDeps,
  hooks: DoctorHooks = {},
): Promise<DoctorCheck[]> {
  const ctx = { env: deps.env, cwd: deps.cwd };
  const checks: DoctorCheck[] = [checkNode(deps)];
  const location = resolveConfigLocation(flags, ctx);
  let config: ResolvedConfig = {};
  try {
    const { loaded } = await loadContext(flags, ctx);
    config = loaded.config;
    checks.push(checkConfig(loaded.path, loaded.exists, location.home));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    checks.push({
      id: 'config',
      title: 'config file',
      status: 'fail',
      detail: error.message,
      fix: [`fix or remove ${location.configFile} (see \`${APP_NAME} config --schema\`)`],
    });
  }
  const stateDir = resolveStateDir(flags, ctx, config.stateDir);
  const git = await checkGit(config, deps);
  checks.push(git);
  if (git.status !== 'fail') checks.push(await checkGitHelper(config, deps));
  const wsl = detectWsl(deps.platform, deps.env, deps.readText).wsl;
  checks.push(...checkPlatform(deps, config));
  checks.push(...checkInotify(deps, wsl));
  checks.push(...(await checkStateDir(stateDir, location.home)));
  checks.push(await checkPort(flags, config, stateDir, deps));
  const explicitWeb = flags.webRoot
    ? resolveUserPath(flags.webRoot, deps.cwd, location.home)
    : config.webRoot;
  checks.push(checkWebAssets(explicitWeb, location.home, hooks));
  return checks;
}

const LABEL: Record<CheckStatus, string> = { ok: 'ok  ', info: 'info', warn: 'warn', fail: 'FAIL' };

export function formatChecks(checks: DoctorCheck[], version: string): string {
  const width = Math.max(...checks.map((c) => c.title.length));
  const lines = [`${APP_NAME} doctor (${version})`, ''];
  for (const check of checks) {
    lines.push(`  ${LABEL[check.status]}  ${check.title.padEnd(width)}  ${check.detail}`);
    for (const fix of check.fix ?? []) lines.push(`        ${' '.repeat(width)}  fix: ${fix}`);
  }
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  lines.push('');
  lines.push(
    fails === 0 && warns === 0
      ? 'No problems found.'
      : `${fails} problem${fails === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}.`,
  );
  return `${lines.join('\n')}\n`;
}

/** `octopus-diff doctor`: exit code 1 when any check fails (warnings don't fail). */
export async function runDoctor(
  flags: DoctorFlags,
  deps: CliDeps,
  version: string,
  hooks: DoctorHooks = {},
): Promise<number> {
  const checks = await collectChecks(flags, deps, hooks);
  const failed = checks.some((c) => c.status === 'fail');
  if (flags.json) {
    deps.stdout.write(`${JSON.stringify({ version, ok: !failed, checks }, null, 2)}\n`);
  } else {
    deps.stdout.write(formatChecks(checks, version));
  }
  return failed ? EXIT_FAILURE : EXIT_OK;
}
