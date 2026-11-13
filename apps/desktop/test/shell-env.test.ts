import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  defaultRunShell,
  extractPath,
  mergePath,
  PATH_MARKER_END,
  PATH_MARKER_START,
  PATH_SCRIPT,
  type RunShell,
  resolveShellPath,
  usableShell,
} from '../src/shell-env.js';

const wrap = (p: string) => `${PATH_MARKER_START}${p}${PATH_MARKER_END}`;

describe('extractPath', () => {
  it('reads the value between the markers, ignoring rc-file noise', () => {
    expect(extractPath(wrap('/a:/b'))).toBe('/a:/b');
    expect(
      extractPath(`Welcome!\n\u001b[32mmotd\u001b[0m\n${wrap('/opt/homebrew/bin:/usr/bin')}bye\n`),
    ).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('null without markers or with an empty value', () => {
    expect(extractPath('/usr/bin')).toBeNull();
    expect(extractPath(PATH_MARKER_START)).toBeNull();
    expect(extractPath(wrap(''))).toBeNull();
  });
});

describe('mergePath', () => {
  it('login entries first, then missing inherited ones, no duplicates or blanks', () => {
    expect(mergePath('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin::/usr/sbin')).toBe(
      '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin',
    );
    expect(mergePath('/a', undefined)).toBe('/a');
  });
});

describe('usableShell', () => {
  it('accepts absolute POSIX-like shells only', () => {
    for (const s of [
      '/bin/zsh',
      '/bin/bash',
      '/usr/bin/fish',
      '/bin/sh',
      '/bin/dash',
      '/bin/ksh',
    ]) {
      expect(usableShell(s), s).toBe(s);
    }
    for (const s of [
      undefined,
      '',
      'zsh',
      './zsh',
      '/bin/tcsh',
      '/bin/csh',
      '/usr/bin/nu',
      '/bin/zsh5',
    ]) {
      expect(usableShell(s), String(s)).toBeNull();
    }
  });
});

describe('resolveShellPath', () => {
  const calls: {
    shell: string;
    args: readonly string[];
    env: Record<string, string | undefined>;
    timeoutMs: number;
  }[] = [];
  const run =
    (out: string | Error): RunShell =>
    async (shell, args, options) => {
      calls.push({ shell, args, ...options });
      if (out instanceof Error) throw out;
      return out;
    };

  it('asks the login shell (-ilc, constant script, timeout) and merges its PATH', async () => {
    calls.length = 0;
    const result = await resolveShellPath({
      platform: 'darwin',
      env: { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
      run: run(`noise${wrap('/opt/homebrew/bin:/usr/bin')}`),
    });
    expect(result).toEqual({
      source: 'login-shell',
      path: '/opt/homebrew/bin:/usr/bin:/bin',
      shell: '/bin/zsh',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.shell).toBe('/bin/zsh');
    expect(calls[0]?.args).toEqual(['-ilc', PATH_SCRIPT]);
    expect(calls[0]?.timeoutMs).toBe(5_000);
    expect(calls[0]?.env.OCTOPUS_DIFF_RESOLVING_ENVIRONMENT).toBe('1');
  });

  it('also on Linux; never on Windows', async () => {
    calls.length = 0;
    const linux = await resolveShellPath({
      platform: 'linux',
      env: { SHELL: '/bin/bash', PATH: '/usr/bin' },
      run: run(wrap('/home/u/.local/bin:/usr/bin')),
    });
    expect(linux.source).toBe('login-shell');
    const win = await resolveShellPath({
      platform: 'win32',
      env: { SHELL: '/bin/bash', PATH: 'C:\\Windows' },
      run: run(wrap('/x')),
    });
    expect(win).toEqual({
      source: 'inherited',
      path: 'C:\\Windows',
      reason: 'Windows keeps its PATH',
    });
    expect(calls).toHaveLength(1);
  });

  it('falls back to the inherited PATH when the shell is unusable, fails or prints nothing', async () => {
    const env = { SHELL: '/bin/zsh', PATH: '/usr/bin' };
    expect(
      await resolveShellPath({ platform: 'darwin', env: { PATH: '/usr/bin' }, run: run('') }),
    ).toEqual({
      source: 'inherited',
      path: '/usr/bin',
      reason: 'no usable $SHELL',
    });
    expect(
      await resolveShellPath({ platform: 'darwin', env, run: run(new Error('timed out')) }),
    ).toEqual({
      source: 'inherited',
      path: '/usr/bin',
      reason: '/bin/zsh failed: timed out',
    });
    expect(await resolveShellPath({ platform: 'darwin', env, run: run('just noise') })).toEqual({
      source: 'inherited',
      path: '/usr/bin',
      reason: '/bin/zsh printed no PATH',
    });
  });
});

describe.skipIf(process.platform === 'win32')('defaultRunShell with a real /bin/sh', () => {
  it('prints the real PATH between the markers (printenv, so fish parses it too)', async () => {
    const out = await defaultRunShell('/bin/sh', ['-c', PATH_SCRIPT], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      timeoutMs: 5_000,
    });
    expect(extractPath(out)).toBe('/usr/local/bin:/usr/bin:/bin');
  });

  it('the script uses no braced or command-substitution expansion, which fish rejects (PR #108)', () => {
    expect(PATH_SCRIPT).not.toMatch(/\$[{(]/);
    expect(PATH_SCRIPT).not.toContain('"');
  });

  it.skipIf(!existsSync('/usr/bin/fish') && !existsSync('/opt/homebrew/bin/fish'))(
    'prints the PATH under a real fish',
    async () => {
      const fish = existsSync('/usr/bin/fish') ? '/usr/bin/fish' : '/opt/homebrew/bin/fish';
      const out = await defaultRunShell(fish, ['-ilc', PATH_SCRIPT], {
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' },
        timeoutMs: 5_000,
      });
      expect(extractPath(out)?.split(':')).toContain('/usr/bin');
    },
  );

  it('does not wait for a background job an rc file left holding stdout (PR #108 review)', async () => {
    const started = Date.now();
    const out = await defaultRunShell('/bin/sh', ['-c', `(sleep 3 &); ${PATH_SCRIPT}`], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      timeoutMs: 5_000,
    });
    expect(extractPath(out)).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('rejects on a non-zero exit and kills at the timeout', async () => {
    await expect(
      defaultRunShell('/bin/sh', ['-c', 'exit 3'], {
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow('exited with code 3');
    const started = Date.now();
    await expect(
      defaultRunShell('/bin/sh', ['-c', 'sleep 5'], {
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 200,
      }),
    ).rejects.toThrow('timed out after 200 ms');
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
