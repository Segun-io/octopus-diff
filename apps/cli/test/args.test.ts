import { describe, expect, it } from 'vitest';
import { parseCommandLine } from '../src/args.js';
import { UsageError } from '../src/errors.js';

describe('parseCommandLine', () => {
  it('defaults to serve with no arguments or a leading option', () => {
    expect(parseCommandLine([])).toMatchObject({
      command: 'serve',
      flags: { scan: [], projects: [] },
    });
    expect(parseCommandLine(['--port', '9000'])).toMatchObject({
      command: 'serve',
      flags: { port: 9000 },
    });
  });

  it('parses every serve flag', () => {
    const parsed = parseCommandLine([
      'serve',
      'repo-a',
      '--port=0',
      '--host',
      '::1',
      '--open',
      '--scan',
      '~/code',
      '-s',
      '/srv/work',
      '--depth',
      '5',
      '--allow-non-loopback',
      '--allowed-host',
      'box.local',
      '--no-watch',
      '--poll',
      '--web-root',
      './web',
      '--state-dir',
      '/tmp/s',
      '--config-dir',
      '/tmp/c',
      '--config',
      '/tmp/c/x.json',
      '--log-level',
      'debug',
      'repo-b',
    ]);
    expect(parsed).toEqual({
      command: 'serve',
      flags: {
        projects: ['repo-a', 'repo-b'],
        port: 0,
        host: '::1',
        open: true,
        scan: ['~/code', '/srv/work'],
        depth: 5,
        allowNonLoopback: true,
        allowedHosts: ['box.local'],
        watch: false,
        poll: true,
        webRoot: './web',
        stateDir: '/tmp/s',
        configDir: '/tmp/c',
        config: '/tmp/c/x.json',
        logLevel: 'debug',
      },
    });
  });

  it('supports --no-open to override the config file', () => {
    expect(parseCommandLine(['serve', '--no-open'])).toMatchObject({ flags: { open: false } });
  });

  it('parses --ready-fd and --exit-with-stdin (and leaves them unset otherwise)', () => {
    expect(parseCommandLine(['serve', '--ready-fd', '3', '--exit-with-stdin'])).toMatchObject({
      command: 'serve',
      flags: { readyFd: 3, exitWithStdin: true },
    });
    expect(parseCommandLine(['serve', '--ready-fd=12'])).toMatchObject({ flags: { readyFd: 12 } });
    const plain = parseCommandLine(['serve']);
    expect(plain).toMatchObject({ command: 'serve' });
    if (plain.command !== 'serve') throw new Error('unreachable');
    expect(plain.flags).not.toHaveProperty('readyFd');
    expect(plain.flags).not.toHaveProperty('exitWithStdin');
  });

  it('parses --ready-stdout <nonce> (#22)', () => {
    const nonce = 'n0nce_N0NCE-abcdef';
    expect(parseCommandLine(['serve', '--ready-stdout', nonce, '--exit-with-stdin'])).toMatchObject(
      {
        command: 'serve',
        flags: { readyStdout: nonce, exitWithStdin: true },
      },
    );
    const plain = parseCommandLine(['serve']);
    if (plain.command !== 'serve') throw new Error('unreachable');
    expect(plain.flags).not.toHaveProperty('readyStdout');
  });

  it('a nonce that starts with "-" is taken in the --ready-stdout=<nonce> form (#22 review)', () => {
    const nonce = '-leading-dash-nonce_0123';
    expect(parseCommandLine(['serve', `--ready-stdout=${nonce}`])).toMatchObject({
      flags: { readyStdout: nonce },
    });
    // The separate-argument form is ambiguous to parseArgs: that is why the app uses `=`.
    expect(() => parseCommandLine(['serve', '--ready-stdout', nonce])).toThrow(/ambiguous/);
  });

  it.each([
    [['serve', '--ready-stdout', 'short'], /--ready-stdout needs a nonce of 16-128/],
    [['serve', '--ready-stdout', 'a b c d e f g h i j'], /--ready-stdout needs a nonce/],
    [['serve', '--ready-stdout', `${'a'.repeat(16)}\n`], /--ready-stdout needs a nonce/],
    [['serve', '--ready-stdout', ''], /--ready-stdout needs a nonce/],
    [['serve', '--ready-stdout'], /--ready-stdout/],
    [
      ['serve', '--ready-stdout', 'a'.repeat(16), '--ready-fd', '3'],
      /--ready-fd and --ready-stdout cannot be combined/,
    ],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCommandLine(argv)).toThrow(UsageError);
    expect(() => parseCommandLine(argv)).toThrow(message);
  });

  it.each([
    [['serve', '--ready-fd', '0'], /--ready-fd must be a file descriptor of 3 or more/],
    [['serve', '--ready-fd', '2'], /--ready-fd must be a file descriptor of 3 or more/],
    [['serve', '--ready-fd', '99999999999'], /--ready-fd must be a file descriptor of 3 or more/],
    [['serve', '--ready-fd', 'abc'], /--ready-fd must be an integer/],
    [['serve', '--ready-fd', '3.5'], /--ready-fd must be an integer/],
    [['serve', '--ready-fd=-1'], /--ready-fd must be an integer/],
    [['serve', '--ready-fd', ''], /--ready-fd must be an integer/],
    [['serve', '--ready-fd'], /--ready-fd/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCommandLine(argv)).toThrow(UsageError);
    expect(() => parseCommandLine(argv)).toThrow(message);
  });

  it.each([
    [['serve', '--port', 'abc'], /--port must be an integer/],
    [['serve', '--port', '70000'], /--port must be between 0 and 65535/],
    [['serve', '--port', '-1'], /--port/],
    [['serve', '--depth', '9'], /--depth must be between 0 and 8/],
    [['serve', '--log-level', 'loud'], /--log-level must be one of/],
    [['serve', '--bogus'], /serve: Unknown option '--bogus'/],
    [['serve', '--host', ''], /--host must not be empty/],
    [['add'], /at least one repository path/],
    [['add', 'x', '--depth', '2'], /--depth only applies to --scan/],
    [['status', 'extra'], /status: Unexpected argument/],
    [['frobnicate'], /unknown command "frobnicate"/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCommandLine(argv)).toThrow(UsageError);
    expect(() => parseCommandLine(argv)).toThrow(message);
  });

  it('parses add with paths and scan roots', () => {
    expect(
      parseCommandLine([
        'add',
        'a',
        'b',
        '--scan',
        'dir',
        '--depth',
        '2',
        '--url',
        'http://127.0.0.1:1',
      ]),
    ).toEqual({
      command: 'add',
      flags: { paths: ['a', 'b'], scan: ['dir'], depth: 2, url: 'http://127.0.0.1:1' },
    });
    expect(parseCommandLine(['add', '--scan', 'dir'])).toMatchObject({
      command: 'add',
      flags: { paths: [], scan: ['dir'] },
    });
  });

  it('parses doctor, status and config', () => {
    expect(parseCommandLine(['doctor', '--json', '-p', '1234'])).toEqual({
      command: 'doctor',
      flags: { json: true, port: 1234 },
    });
    expect(parseCommandLine(['status', '--open'])).toEqual({
      command: 'status',
      flags: { open: true },
    });
    expect(parseCommandLine(['config', '--schema'])).toEqual({
      command: 'config',
      flags: { schema: true },
    });
  });

  it('handles help and version', () => {
    expect(parseCommandLine(['--help'])).toEqual({ command: 'help' });
    expect(parseCommandLine(['help', 'add'])).toEqual({ command: 'help', topic: 'add' });
    expect(parseCommandLine(['serve', '--help'])).toEqual({ command: 'help', topic: 'serve' });
    expect(parseCommandLine(['add', '-h'])).toEqual({ command: 'help', topic: 'add' });
    expect(parseCommandLine(['--version'])).toEqual({ command: 'version' });
    expect(parseCommandLine(['-v'])).toEqual({ command: 'version' });
  });
});
