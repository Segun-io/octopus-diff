import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import {
  collectChecks,
  type DoctorCheck,
  formatChecks,
  MIN_GIT_VERSION,
  parseGitVersion,
} from '../src/commands/doctor.js';
import type { ReadTextSync } from '../src/platform.js';
import { detectWsl, isWindowsMountPath } from '../src/platform.js';
import { writeRuntimeInfo } from '../src/runtime.js';
import {
  clientFactory,
  healthBody,
  makeDeps,
  makeTempDirs,
  type TempDirs,
  writeConfig,
} from './helpers.js';

let dirs: TempDirs;
let webDir: string;
beforeEach(async () => {
  dirs = await makeTempDirs();
  webDir = path.join(dirs.root, 'web');
  await mkdir(webDir);
  await writeFile(path.join(webDir, 'index.html'), '<!doctype html>');
});
afterEach(async () => {
  await dirs.cleanup();
});

function procFiles(files: Record<string, string>): ReadTextSync {
  return (file) => files[file] ?? null;
}

const HEALTHY_PROC = procFiles({
  '/proc/sys/fs/inotify/max_user_watches': '1048576\n',
  '/proc/sys/fs/inotify/max_user_instances': '1024\n',
  '/proc/sys/kernel/osrelease': '6.8.0-generic\n',
});

function byId(checks: DoctorCheck[], id: string): DoctorCheck | undefined {
  return checks.find((c) => c.id === id);
}

describe('doctor', () => {
  it('passes on a healthy machine and exits 0', async () => {
    const deps = makeDeps(dirs, { readText: HEALTHY_PROC });
    const code = await run(['doctor'], deps, { doctor: { webRootCandidates: [webDir] } });
    expect(deps.out.text).toContain('No problems found.');
    expect(code).toBe(0);
    const checks = await collectChecks({}, deps, { webRootCandidates: [webDir] });
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['node', 'ok'],
      ['config', 'info'],
      ['git', 'ok'],
      ['platform', 'info'],
      ['inotify-watches', 'ok'],
      ['inotify-instances', 'ok'],
      ['state-dir', 'info'],
      ['port', 'ok'],
      ['web', 'ok'],
    ]);
  });

  it('fails when git is missing or too old', async () => {
    const missing = makeDeps(dirs, {
      readText: HEALTHY_PROC,
      runProgram: async () => {
        throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(await run(['doctor'], missing, { doctor: { webRootCandidates: [webDir] } })).toBe(1);
    expect(missing.out.text).toMatch(/FAIL {2}git +"git" not found on PATH/);

    const old = makeDeps(dirs, {
      readText: HEALTHY_PROC,
      runProgram: async () => ({ stdout: 'git version 2.17.1\n', stderr: '' }),
    });
    const checks = await collectChecks({}, old, { webRootCandidates: [webDir] });
    expect(byId(checks, 'git')).toMatchObject({ status: 'fail' });
    expect(byId(checks, 'git')?.detail).toContain('older than the minimum');
  });

  it('uses the git binary from the config file', async () => {
    await writeConfig(dirs, { git: { gitBinary: '/opt/git/bin/git' } });
    const calls: string[][] = [];
    const deps = makeDeps(dirs, {
      runProgram: async (command, args) => {
        calls.push([command, ...args]);
        return { stdout: 'git version 2.53.0', stderr: '' };
      },
    });
    await collectChecks({}, deps, { webRootCandidates: [webDir] });
    expect(calls).toEqual([['/opt/git/bin/git', '--version']]);
  });

  it('fails on old Node', async () => {
    const deps = makeDeps(dirs, { nodeVersion: '22.11.0', readText: HEALTHY_PROC });
    const checks = await collectChecks({}, deps, { webRootCandidates: [webDir] });
    expect(byId(checks, 'node')).toMatchObject({ status: 'fail' });
  });

  it('warns about low inotify limits with a fix that never lowers a value', async () => {
    const deps = makeDeps(dirs, {
      readText: procFiles({
        '/proc/sys/fs/inotify/max_user_watches': '2000000',
        '/proc/sys/fs/inotify/max_user_instances': '128',
      }),
    });
    const checks = await collectChecks({}, deps, { webRootCandidates: [webDir] });
    expect(byId(checks, 'inotify-watches')?.status).toBe('ok');
    const instances = byId(checks, 'inotify-instances');
    expect(instances?.status).toBe('warn');
    expect(instances?.fix?.[0]).toContain('max_user_watches=2000000');
    expect(instances?.fix?.[0]).toContain('max_user_instances=512');
    // Warnings alone don't fail the command.
    expect(await run(['doctor'], deps, { doctor: { webRootCandidates: [webDir] } })).toBe(0);
  });

  it('skips inotify on macOS', async () => {
    const deps = makeDeps(dirs, { platform: 'darwin' });
    const checks = await collectChecks({}, deps, { webRootCandidates: [webDir] });
    expect(byId(checks, 'inotify-watches')).toBeUndefined();
    expect(byId(checks, 'platform')?.detail).toBe('darwin');
  });

  it('explains the WSL /mnt caveat and flags configured Windows-drive paths', async () => {
    await writeConfig(dirs, { scanRoots: ['/mnt/c/code'] });
    const deps = makeDeps(dirs, {
      env: { HOME: dirs.home, WSL_DISTRO_NAME: 'Ubuntu' },
      readText: procFiles({
        '/proc/sys/kernel/osrelease': '6.18.54.1-microsoft-standard-WSL2',
        '/proc/sys/fs/inotify/max_user_watches': '8192',
        '/proc/sys/fs/inotify/max_user_instances': '128',
      }),
    });
    const checks = await collectChecks({}, deps, { webRootCandidates: [webDir] });
    expect(byId(checks, 'platform')?.detail).toMatch(/^WSL2 \(Ubuntu\)\. Keep repositories/);
    expect(byId(checks, 'wsl-mounts')).toMatchObject({ status: 'warn' });
    expect(byId(checks, 'inotify-watches')?.fix?.join('\n')).toContain('/etc/wsl.conf');
  });

  it('fails on a token file readable by other users', async () => {
    await mkdir(dirs.stateDir, { recursive: true, mode: 0o700 });
    await chmod(dirs.stateDir, 0o700);
    const token = path.join(dirs.stateDir, 'token');
    await writeFile(token, 'x');
    await chmod(token, 0o644);
    const deps = makeDeps(dirs, { readText: HEALTHY_PROC });
    let checks = await collectChecks({}, deps, { webRootCandidates: [webDir] });
    expect(byId(checks, 'state-dir')?.status).toBe('ok');
    expect(byId(checks, 'token')).toMatchObject({ status: 'fail', fix: [`chmod 600 ${token}`] });
    await chmod(token, 0o600);
    checks = await collectChecks({}, deps, { webRootCandidates: [webDir] });
    expect(byId(checks, 'token')?.status).toBe('ok');
  });

  it('warns about a state dir accessible by others', async () => {
    await mkdir(dirs.stateDir, { recursive: true });
    await chmod(dirs.stateDir, 0o755);
    const deps = makeDeps(dirs, { readText: HEALTHY_PROC });
    const checks = await collectChecks({}, deps, { webRootCandidates: [webDir] });
    expect(byId(checks, 'state-dir')?.status).toBe('warn');
  });

  it('reports an invalid config file as a failure but still runs the other checks', async () => {
    await writeConfig(dirs, '{ nope');
    const deps = makeDeps(dirs, { readText: HEALTHY_PROC });
    const checks = await collectChecks({}, deps, { webRootCandidates: [webDir] });
    expect(byId(checks, 'config')?.status).toBe('fail');
    expect(byId(checks, 'port')).toBeDefined();
  });

  it('checks the port: busy by another program fails, busy by octopus-diff is fine', async () => {
    const busy = makeDeps(dirs, { readText: HEALTHY_PROC, probePort: async () => 'in_use' });
    let checks = await collectChecks({ port: 8080 }, busy, { webRootCandidates: [webDir] });
    expect(byId(checks, 'port')).toMatchObject({ status: 'fail' });
    expect(byId(checks, 'port')?.detail).toContain('127.0.0.1:8080 is in use');

    const api = clientFactory((req) =>
      req.url.endsWith('/api/health') ? { body: healthBody() } : undefined,
    );
    const ours = makeDeps(dirs, {
      readText: HEALTHY_PROC,
      probePort: async () => 'in_use',
      createApiClient: api.createApiClient,
    });
    checks = await collectChecks({}, ours, { webRootCandidates: [webDir] });
    expect(byId(checks, 'port')).toMatchObject({ status: 'ok' });
    expect(byId(checks, 'port')?.detail).toContain('already running');
  });

  it('recognizes the running daemon from the runtime file', async () => {
    await writeRuntimeInfo(dirs.stateDir, {
      pid: 5,
      url: 'http://127.0.0.1:40002',
      host: '127.0.0.1',
      port: 40_002,
      version: '0',
      startedAt: '2026-11-08T00:00:00.000Z',
    });
    const api = clientFactory((req) =>
      req.url === 'http://127.0.0.1:40002/api/health' ? { body: healthBody() } : undefined,
    );
    const deps = makeDeps(dirs, {
      createApiClient: api.createApiClient,
      isProcessAlive: () => true,
      probePort: async () => {
        throw new Error('should not probe');
      },
    });
    const checks = await collectChecks({}, deps, { webRootCandidates: [webDir] });
    expect(byId(checks, 'port')?.detail).toContain('running at http://127.0.0.1:40002 (pid 5)');
  });

  it('fails when the web assets are missing', async () => {
    const deps = makeDeps(dirs, { readText: HEALTHY_PROC });
    expect(
      await run(['doctor', '--json'], deps, {
        doctor: { webRootCandidates: [path.join(dirs.root, 'none')] },
      }),
    ).toBe(1);
    const json = JSON.parse(deps.out.text) as { ok: boolean; checks: DoctorCheck[] };
    expect(json.ok).toBe(false);
    expect(byId(json.checks, 'web')).toMatchObject({ status: 'fail' });
  });

  it('formats checks with fixes and a summary', () => {
    const text = formatChecks(
      [
        { id: 'a', title: 'alpha', status: 'ok', detail: 'fine' },
        { id: 'b', title: 'beta', status: 'fail', detail: 'broken', fix: ['do this'] },
        { id: 'c', title: 'gamma', status: 'warn', detail: 'meh' },
      ],
      '1.0.0',
    );
    expect(text).toContain('ok    alpha  fine');
    expect(text).toContain('FAIL  beta   broken');
    expect(text).toContain('fix: do this');
    expect(text).toContain('1 problem, 1 warning.');
  });
});

describe('version and platform helpers', () => {
  it('parses git version strings', () => {
    expect(parseGitVersion('git version 2.53.0\n')).toEqual({ major: 2, minor: 53, patch: 0 });
    expect(parseGitVersion('git version 2.39.3 (Apple Git-146)')).toEqual({
      major: 2,
      minor: 39,
      patch: 3,
    });
    expect(parseGitVersion('git version 2.45.1.windows.1')).toEqual({
      major: 2,
      minor: 45,
      patch: 1,
    });
    expect(parseGitVersion('git version 3.0')).toEqual({ major: 3, minor: 0, patch: 0 });
    expect(parseGitVersion('nonsense')).toBeNull();
    expect(MIN_GIT_VERSION).toEqual({ major: 2, minor: 31, patch: 0 });
  });

  it('detects WSL', () => {
    const wsl2 = procFiles({ '/proc/sys/kernel/osrelease': '6.18.54.1-microsoft-standard-WSL2' });
    expect(detectWsl('linux', {}, wsl2)).toEqual({ wsl: true, version: 2, distro: null });
    expect(detectWsl('linux', { WSL_DISTRO_NAME: 'Debian' }, wsl2).distro).toBe('Debian');
    const wsl1 = procFiles({ '/proc/sys/kernel/osrelease': '4.4.0-19041-Microsoft' });
    expect(detectWsl('linux', {}, wsl1)).toEqual({ wsl: true, version: 1, distro: null });
    expect(
      detectWsl('linux', {}, procFiles({ '/proc/sys/kernel/osrelease': '6.8.0-45-generic' })).wsl,
    ).toBe(false);
    expect(detectWsl('darwin', { WSL_DISTRO_NAME: 'x' }, wsl2).wsl).toBe(false);
  });

  it('recognizes Windows drive mounts', () => {
    expect(isWindowsMountPath('/mnt/c/Users/me')).toBe(true);
    expect(isWindowsMountPath('/mnt/d')).toBe(true);
    expect(isWindowsMountPath('/mnt/data/repo')).toBe(false);
    expect(isWindowsMountPath('/home/me/mnt/c')).toBe(false);
  });
});
