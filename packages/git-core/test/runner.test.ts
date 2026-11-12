import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isGitCoreError } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALLOWED_SUBCOMMANDS,
  assertAllowedGitArgs,
  assertStdinAllowed,
  buildGitArgv,
  buildGitEnv,
  CONFIG_PINS,
  createGitCore,
  GitRunner,
  resolveExecutable,
  SAFETY_ENV,
} from '../src/index.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

function rejects(args: string[]): void {
  expect(() => assertAllowedGitArgs(args), args.join(' ')).toThrowError(
    expect.objectContaining({ code: 'command_not_allowed' }),
  );
}

describe('patch-id and stdin (status flow)', () => {
  it('allows patch-id with --stable only', () => {
    expect(() => assertAllowedGitArgs(['patch-id', '--stable'])).not.toThrow();
    expect(() => assertAllowedGitArgs(['patch-id'])).not.toThrow();
    rejects(['patch-id', '--unstable']);
    rejects(['patch-id', '--verbatim']);
    rejects(['patch-id', '--stable', 'x']);
    rejects(['patch-id', '--', '--stable']);
  });

  it('allows stdin only for check-attr --stdin and patch-id', () => {
    expect(() => assertStdinAllowed(['patch-id', '--stable'])).not.toThrow();
    expect(() => assertStdinAllowed(['check-attr', '-z', '--stdin', 'diff'])).not.toThrow();
    for (const args of [
      ['check-attr', 'diff', '--', 'a'],
      ['log', '--format=%H'],
      ['diff', 'HEAD'],
      ['rev-list', '--stdin'],
      ['cat-file', '--batch'],
    ]) {
      expect(() => assertStdinAllowed(args), args.join(' ')).toThrowError(
        expect.objectContaining({ code: 'command_not_allowed' }),
      );
    }
  });
});

describe('subcommand allowlist', () => {
  it('allows exactly the PLAN §5.5 subcommands', () => {
    expect([...ALLOWED_SUBCOMMANDS].sort()).toEqual(
      [
        'status',
        'diff',
        'diff-index',
        'diff-tree',
        'rev-parse',
        'rev-list',
        'merge-base',
        'worktree',
        'for-each-ref',
        'symbolic-ref',
        'show',
        'cat-file',
        'ls-files',
        'log',
        'config',
        'check-attr',
        'patch-id',
      ].sort(),
    );
    for (const args of [
      ['status', '--porcelain=v2', '-z'],
      ['diff', '--raw', 'HEAD', '--', 'file'],
      ['diff', '--no-index', '--', '/dev/null', 'x'],
      ['worktree', 'list', '--porcelain', '-z'],
      ['config', '--get', 'core.bare'],
      ['config', '--null', '--show-scope', '--get-regexp', '^filter\\.'],
      ['symbolic-ref', '--quiet', 'HEAD'],
      ['rev-parse', '--git-dir', '--git-common-dir'],
      ['log', '-z', '--format=%H', 'HEAD', '--'],
      ['cat-file', '-t', 'HEAD'],
      // The live feed's blob read (#37): type, size, then the content of a full oid.
      ['cat-file', '-t', 'a'.repeat(40)],
      ['cat-file', '-s', 'a'.repeat(40)],
      ['cat-file', 'blob', 'a'.repeat(40)],
      ['check-attr', '-z', '--stdin', 'diff'],
      ['check-attr', 'diff', 'text', '--', 'a.txt', '--source=x'],
    ]) {
      expect(() => assertAllowedGitArgs(args), args.join(' ')).not.toThrow();
    }
  });

  it('rejects every writing subcommand', () => {
    for (const sub of [
      'add',
      'commit',
      'checkout',
      'switch',
      'restore',
      'reset',
      'apply',
      'am',
      'fetch',
      'pull',
      'push',
      'gc',
      'prune',
      'merge',
      'rebase',
      'cherry-pick',
      'revert',
      'stash',
      'tag',
      'branch',
      'rm',
      'mv',
      'clean',
      'update-index',
      'update-ref',
      'hash-object',
      'write-tree',
      'commit-tree',
      'read-tree',
      'init',
      'clone',
      'remote',
      'submodule',
      'maintenance',
      'repack',
      'notes',
      'replace',
      'reflog',
      'fsmonitor--daemon',
      'filter-branch',
      'difftool',
      'mergetool',
      'grep',
    ]) {
      rejects([sub]);
    }
  });

  it('rejects writing forms of allowed subcommands and dangerous options', () => {
    rejects([]);
    rejects(['']);
    rejects(['-c', 'core.fsmonitor=/tmp/x', 'status']);
    rejects(['--git-dir=/tmp/x', 'status']);
    rejects(['-C', '/tmp', 'status']);
    rejects(['worktree', 'add', '/tmp/x']);
    rejects(['worktree', 'remove', 'x']);
    rejects(['worktree', 'prune']);
    rejects(['worktree', 'lock', 'x']);
    rejects(['worktree', 'list', '--expire', 'now']);
    rejects(['config', 'core.bare', 'true']);
    rejects(['config', 'core.bare']);
    rejects(['config', '--unset', 'core.bare']);
    rejects(['config', '--get', '--unset', 'core.bare']);
    rejects(['config', '--add', 'x.y', 'z']);
    rejects(['config', '--get', '--file', '/etc/passwd', 'x']);
    rejects(['config', '--edit']);
    rejects(['config', 'set', 'x.y', 'z']);
    rejects(['config', '--get', 'a', 'b', 'c']);
    rejects(['symbolic-ref', 'HEAD', 'refs/heads/evil']);
    rejects(['symbolic-ref', '--delete', 'HEAD']);
    rejects(['symbolic-ref', '-m', 'msg', 'HEAD']);
    rejects(['diff', '--output=/tmp/x']);
    rejects(['log', '--output', '/tmp/x']);
    rejects(['diff', '--ext-diff']);
    rejects(['show', '--textconv', 'HEAD:x']);
    rejects(['cat-file', '--filters', 'HEAD:x']);
    rejects(['cat-file', '--textconv', 'HEAD:x']);
    rejects(['log', '--show-signature']);
    rejects(['diff', '--color=always']);
    rejects(['status', 'x\u0000y']);
    rejects(['check-attr', '--source=HEAD', 'diff', '--', 'x']);
    rejects(['check-attr', '--output=/tmp/x', 'diff']);
    rejects(['check-attr', '-o', 'diff']);
    // After `--`, arguments are paths, not options.
    expect(() => assertAllowedGitArgs(['diff', 'HEAD', '--', '--output=x'])).not.toThrow();
  });

  it('rejects disallowed commands in the runner before spawning anything', async () => {
    const runner = new GitRunner({ gitBinary: '/nonexistent/git' });
    for (const args of [['commit', '-m', 'x'], ['fetch'], ['gc'], ['worktree', 'add', 'x']]) {
      const error = await runner.run(args, { cwd: '/' }).catch((e: unknown) => e);
      expect(isGitCoreError(error, 'command_not_allowed')).toBe(true);
    }
    await runner.dispose();
  });
});

describe('argv and environment', () => {
  it('prefixes global safety options and pins config', () => {
    const argv = buildGitArgv(['diff', '--raw']);
    expect(argv.slice(0, 2)).toEqual(['--no-pager', '--no-optional-locks']);
    expect(argv).toContain('core.fsmonitor=false');
    const sub = argv.indexOf('diff');
    expect(argv.slice(sub, sub + 4)).toEqual([
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
    ]);
    expect(buildGitArgv(['log'])).toContain('--no-show-signature');
    expect(buildGitArgv(['status'])).not.toContain('--no-ext-diff');
    for (const [key] of CONFIG_PINS)
      expect(argv).toContain(argv.find((a) => a.startsWith(`${key}=`)));
  });

  it('pins the repository location as global options (SEC-06)', () => {
    const argv = buildGitArgv(['status'], [], { gitDir: '/r/.git', workTree: '/r' });
    expect(argv.slice(0, 4)).toEqual([
      '--no-pager',
      '--no-optional-locks',
      '--git-dir=/r/.git',
      '--work-tree=/r',
    ]);
    expect(buildGitArgv(['log'], [], { gitDir: '/r.git' })).not.toContainEqual(
      expect.stringMatching(/^--work-tree/),
    );
    expect(buildGitArgv(['log'])).not.toContainEqual(expect.stringMatching(/^--git-dir/));
    expect(() => buildGitArgv(['log'], [], { gitDir: 'relative/.git' })).toThrowError(
      expect.objectContaining({ code: 'invalid_argument' }),
    );
  });

  it('lets safety variables win and strips redirections', () => {
    const env = buildGitEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/x',
        GIT_DIR: '/evil',
        GIT_WORK_TREE: '/evil',
        GIT_EXTERNAL_DIFF: '/evil',
        GIT_TRACE: '/tmp/trace',
        GIT_CONFIG_GLOBAL: '/home/x/.gitconfig-alt',
        GIT_SSH_COMMAND: 'evil',
        GIT_INDEX_FILE: '/evil',
      },
      {
        GIT_OPTIONAL_LOCKS: '1',
        GIT_TERMINAL_PROMPT: '1',
        LC_ALL: 'de_DE.UTF-8',
        GIT_DIR: '/evil2',
        GIT_TRACE2_EVENT: '/tmp/t2',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    );
    for (const [name, value] of Object.entries(SAFETY_ENV)) expect(env[name]).toBe(value);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/x');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/home/x/.gitconfig-alt');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    for (const name of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_EXTERNAL_DIFF',
      'GIT_TRACE',
      'GIT_TRACE2_EVENT',
      'GIT_SSH_COMMAND',
      'GIT_INDEX_FILE',
    ]) {
      expect(env[name], name).toBeUndefined();
    }
  });
});

describe('process control', () => {
  let fx: Fixture;
  let fakeGit: string;
  let log: string;

  beforeAll(() => {
    fx = createFixture();
    log = path.join(fx.root, 'fake-git.log');
    fakeGit = path.join(fx.root, 'fake-git');
    // A stand-in git binary: behaviour chosen by the FAKE_MODE env var; records start times.
    writeFileSync(
      fakeGit,
      [
        '#!/bin/sh',
        `echo "start $$ $(date +%s%N) $PWD" >> "${log}"`,
        'case "$FAKE_MODE" in',
        '  sleep) sleep 0.4 ;;',
        '  hang) sleep 30 ;;',
        '  flood) head -c 3000000 /dev/zero ;;',
        '  fail) echo "fatal: something broke" >&2; exit 2 ;;',
        '  notrepo) echo "fatal: not a git repository (or any of the parent directories): .git" >&2; exit 128 ;;',
        '  env) env ;;',
        '  stdin) cat ;;',
        'esac',
        `echo "end $$ $(date +%s%N)" >> "${log}"`,
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(fakeGit, 0o755);
  });

  afterAll(() => fx.dispose());

  it('times out and kills the process', async () => {
    const runner = new GitRunner({
      gitBinary: fakeGit,
      env: { FAKE_MODE: 'hang' },
      timeoutMs: 200,
    });
    const started = Date.now();
    const error = await runner.run(['status'], { cwd: fx.root }).catch((e: unknown) => e);
    expect(isGitCoreError(error, 'timeout')).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    await runner.dispose();
  });

  it('rejects stdin for commands that may not read it, before spawning', async () => {
    const runner = new GitRunner({ gitBinary: fakeGit, env: { FAKE_MODE: 'stdin' } });
    for (const args of [
      ['log', '--format=%H'],
      ['diff', 'HEAD'],
      ['check-attr', 'diff', '--', 'a'],
    ]) {
      const error = await runner
        .run(args, { cwd: fx.root, input: Buffer.from('x') })
        .catch((e: unknown) => e);
      expect(isGitCoreError(error, 'command_not_allowed'), args.join(' ')).toBe(true);
    }
    const ok = await runner.run(['patch-id', '--stable'], {
      cwd: fx.root,
      input: Buffer.from('abc'),
    });
    expect(ok.stdout.toString()).toBe('abc');
    await runner.dispose();
  });

  it('passes input on stdin, and survives git exiting before reading it', async () => {
    const echo = new GitRunner({ gitBinary: fakeGit, env: { FAKE_MODE: 'stdin' } });
    const result = await echo.run(['check-attr', '-z', '--stdin', 'diff'], {
      cwd: fx.root,
      input: Buffer.from('a.txt\u0000b\u00ffc\u0000', 'latin1'),
    });
    expect(result.stdout.toString('latin1')).toBe('a.txt\u0000b\u00ffc\u0000');
    // Without input, stdin is closed (`cat` gets EOF at once).
    const none = await echo.run(['status'], { cwd: fx.root });
    expect(none.stdout.length).toBe(0);
    await echo.dispose();
    const failing = new GitRunner({ gitBinary: fakeGit, env: { FAKE_MODE: 'fail' } });
    const error = await failing
      .run(['check-attr', '--stdin', 'diff'], { cwd: fx.root, input: Buffer.alloc(8 << 20, 97) })
      .catch((e: unknown) => e);
    expect(isGitCoreError(error, 'git_failed')).toBe(true);
    await failing.dispose();
  });

  it('caps buffered output', async () => {
    const runner = new GitRunner({
      gitBinary: fakeGit,
      env: { FAKE_MODE: 'flood' },
      maxOutputBytes: 100_000,
    });
    const error = await runner.run(['status'], { cwd: fx.root }).catch((e: unknown) => e);
    expect(isGitCoreError(error, 'output_too_large')).toBe(true);
    await runner.dispose();
  });

  it('classifies failures', async () => {
    const failing = new GitRunner({ gitBinary: fakeGit, env: { FAKE_MODE: 'fail' } });
    const failed = await failing.run(['status'], { cwd: fx.root }).catch((e: unknown) => e);
    expect(isGitCoreError(failed, 'git_failed')).toBe(true);
    expect((failed as { details: { stderr: string } }).details.stderr).toContain('something broke');
    const notRepo = new GitRunner({ gitBinary: fakeGit, env: { FAKE_MODE: 'notrepo' } });
    const error = await notRepo.run(['status'], { cwd: fx.root }).catch((e: unknown) => e);
    expect(isGitCoreError(error, 'not_a_repository')).toBe(true);
    const missing = new GitRunner({ gitBinary: path.join(fx.root, 'no-such-git') });
    const notFound = await missing.run(['status'], { cwd: fx.root }).catch((e: unknown) => e);
    expect(isGitCoreError(notFound, 'git_not_found')).toBe(true);
    const missingCwd = await failing
      .run(['status'], { cwd: path.join(fx.root, 'no-such-dir') })
      .catch((e: unknown) => e);
    expect(isGitCoreError(missingCwd, 'not_found')).toBe(true);
    await Promise.all([failing.dispose(), notRepo.dispose(), missing.dispose()]);
  });

  it('passes the safety environment to git', async () => {
    const runner = new GitRunner({
      gitBinary: fakeGit,
      env: { FAKE_MODE: 'env', GIT_OPTIONAL_LOCKS: '1' },
    });
    const result = await runner.run(['status'], {
      cwd: fx.root,
      configEnv: [['filter.a=b.clean', '']],
    });
    const output = result.stdout.toString('utf8');
    expect(output).toContain('GIT_OPTIONAL_LOCKS=0\n');
    expect(output).toContain('GIT_TERMINAL_PROMPT=0\n');
    expect(output).toContain('LC_ALL=C\n');
    expect(output).toContain('GIT_CONFIG_KEY_0=filter.a=b.clean\n');
    expect(output).toContain('GIT_CONFIG_COUNT=1\n');
    await runner.dispose();
  });

  it('limits concurrency globally and serves repositories fairly', async () => {
    writeFileSync(log, '');
    const runner = new GitRunner({
      gitBinary: fakeGit,
      env: { FAKE_MODE: 'sleep' },
      concurrency: 2,
    });
    const jobs = [
      ...Array.from({ length: 4 }, () =>
        runner.run(['status'], { cwd: fx.root, queueKey: 'busy' }),
      ),
      runner.run(['status'], { cwd: fx.root, queueKey: 'quiet' }),
    ];
    const order: string[] = [];
    jobs.forEach((job, i) => {
      void job.then(() => order.push(i < 4 ? 'busy' : 'quiet'));
    });
    await Promise.all(jobs);
    const events = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(' '))
      .map(([kind, pid, time]) => ({ kind, pid, time: BigInt(time ?? '0') }))
      .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    let running = 0;
    let max = 0;
    for (const event of events) {
      running += event.kind === 'start' ? 1 : -1;
      max = Math.max(max, running);
    }
    expect(max).toBeLessThanOrEqual(2);
    // The quiet repository's single job runs in the second wave, not after all busy jobs.
    expect(order.indexOf('quiet')).toBeLessThan(4);
    await runner.dispose();
  });

  it('dispose kills in-flight processes and rejects queued work', async () => {
    const runner = new GitRunner({
      gitBinary: fakeGit,
      env: { FAKE_MODE: 'hang' },
      concurrency: 1,
    });
    const running = runner.run(['status'], { cwd: fx.root }).catch((e: unknown) => e);
    const queued = runner.run(['status'], { cwd: fx.root }).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await runner.dispose();
    expect(isGitCoreError(await running, 'disposed')).toBe(true);
    expect(isGitCoreError(await queued, 'disposed')).toBe(true);
    const after = await runner.run(['status'], { cwd: fx.root }).catch((e: unknown) => e);
    expect(isGitCoreError(after, 'disposed')).toBe(true);
  });

  it('GitCore rejects after dispose and reports the git version', async () => {
    const core = createGitCore(fx.coreOptions());
    const version = await core.version();
    expect(version.raw).toMatch(/^git version /);
    expect(version.major).toBeGreaterThanOrEqual(2);
    expect(version.features.supported).toBe(true);
    await core.dispose();
    const error = await core.version().catch((e: unknown) => e);
    expect(isGitCoreError(error, 'disposed')).toBe(true);
  });

  it('never resolves git through relative PATH entries', async () => {
    const repoDir = path.join(fx.root, 'repo-with-git');
    fx.write(
      path.join(repoDir, 'git'),
      `#!/bin/sh\ntouch "${path.join(fx.root, 'planted-ran')}"\n`,
    );
    chmodSync(path.join(repoDir, 'git'), 0o755);
    const realPath = process.env.PATH ?? '';
    expect(resolveExecutable('git', `:.:${realPath}`)).not.toBe(path.join(repoDir, 'git'));
    expect(path.isAbsolute(resolveExecutable('git', `.:${realPath}`))).toBe(true);
    expect(() => resolveExecutable('git', '.:relative/bin')).toThrowError(
      expect.objectContaining({ code: 'git_not_found' }),
    );
    const runner = new GitRunner({ env: { PATH: `:.:${realPath}` } });
    await runner.run(['rev-parse', '--git-dir'], { cwd: repoDir, okExitCodes: [0, 128] });
    expect(existsSync(path.join(fx.root, 'planted-ran'))).toBe(false);
    await runner.dispose();
  });

  it('refuses unsupported git versions', async () => {
    const oldGit = path.join(fx.root, 'old-git');
    writeFileSync(oldGit, '#!/bin/sh\necho "git version 2.20.1"\n');
    chmodSync(oldGit, 0o755);
    const core = createGitCore({ gitBinary: oldGit });
    expect((await core.version()).features.supported).toBe(false);
    const error = await core
      .getSummary({ projectId: '0'.repeat(16), worktreeId: '0'.repeat(16), path: fx.root })
      .catch((e: unknown) => e);
    expect(isGitCoreError(error, 'git_unsupported')).toBe(true);
    await core.dispose();
    const missing = createGitCore({ gitBinary: path.join(fx.root, 'missing-git') });
    expect(isGitCoreError(await missing.version().catch((e: unknown) => e), 'git_not_found')).toBe(
      true,
    );
    await missing.dispose();
    expect(existsSync(log)).toBe(true);
  });
});
