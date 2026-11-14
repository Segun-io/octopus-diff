/**
 * The real effects of the command installer: the filesystem (never overwrites, never follows a
 * symlink, atomic) and the Windows user-PATH editor's scripts (run here with a fake PowerShell).
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MARKER } from '../src/cli-shim.js';
import {
  createNodeShimFs,
  createWindowsUserPath,
  encodePowerShell,
  parseUserPathOutput,
  powerShellExe,
  READ_USER_PATH_SCRIPT,
  WRITE_USER_PATH_SCRIPT,
} from '../src/cli-shim-fs.js';
import { ShimExistsError, ShimNotOursError } from '../src/cli-shim-service.js';

const posix = process.platform !== 'win32';
const root = mkdtempSync(path.join(tmpdir(), 'octopus-diff-shimfs-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fresh = () => mkdtempSync(path.join(root, 'd-'));
const ours = `#!/bin/sh\n# ${MARKER}\nexec true\n`;
const fs = createNodeShimFs();

describe('createNodeShimFs.inspect', () => {
  it('missing (also under a path that is a file)', () => {
    const d = fresh();
    writeFileSync(path.join(d, 'f'), 'x');
    expect(fs.inspect(path.join(d, 'nope'))).toEqual({ kind: 'missing' });
    expect(fs.inspect(path.join(d, 'f', 'below'))).toEqual({ kind: 'missing' });
  });

  it('a file: its text; a directory: other', () => {
    const d = fresh();
    writeFileSync(path.join(d, 'f'), ours);
    mkdirSync(path.join(d, 'dir'));
    expect(fs.inspect(path.join(d, 'f'))).toEqual({ kind: 'file', content: ours });
    expect(fs.inspect(path.join(d, 'dir'))).toEqual({ kind: 'other' });
  });

  it('only the top of a big file is read', () => {
    const d = fresh();
    writeFileSync(path.join(d, 'big'), `${ours}${'x'.repeat(500_000)}`);
    const facts = fs.inspect(path.join(d, 'big'));
    expect(facts.kind).toBe('file');
    if (facts.kind === 'file') expect(facts.content.length).toBeLessThanOrEqual(64 * 1024);
  });

  it.runIf(posix)('a symlink is a symlink, even to one of our launchers, even dangling', () => {
    const d = fresh();
    writeFileSync(path.join(d, 'real'), ours);
    symlinkSync(path.join(d, 'real'), path.join(d, 'link'));
    symlinkSync(path.join(d, 'gone'), path.join(d, 'dangling'));
    expect(fs.inspect(path.join(d, 'link'))).toEqual({ kind: 'symlink' });
    expect(fs.inspect(path.join(d, 'dangling'))).toEqual({ kind: 'symlink' });
  });
});

describe('createNodeShimFs.create', () => {
  it('writes the file, executable, and leaves no staging file behind', () => {
    const d = fresh();
    const file = path.join(d, 'sub', 'octopus-diff');
    fs.mkdirp(path.dirname(file));
    fs.create(file, ours);
    expect(readFileSync(file, 'utf8')).toBe(ours);
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o755);
    expect(readdirSync(path.dirname(file))).toEqual(['octopus-diff']);
  });

  it('never replaces what is there: a file, a symlink, a dangling symlink, a directory', () => {
    const d = fresh();
    const kinds: Record<string, () => void> = {
      file: () => writeFileSync(path.join(d, 'file'), 'npm shim'),
      dir: () => mkdirSync(path.join(d, 'dir')),
      ...(posix
        ? {
            link: () => symlinkSync(path.join(d, 'file'), path.join(d, 'link')),
            dangling: () => symlinkSync(path.join(d, 'gone'), path.join(d, 'dangling')),
          }
        : {}),
    };
    for (const make of Object.values(kinds)) make();
    for (const name of Object.keys(kinds)) {
      expect(() => fs.create(path.join(d, name), ours), name).toThrow(ShimExistsError);
    }
    expect(readFileSync(path.join(d, 'file'), 'utf8')).toBe('npm shim');
    expect(readdirSync(d).sort()).toEqual(Object.keys(kinds).sort());
    if (posix) expect(() => readFileSync(path.join(d, 'gone'))).toThrow();
  });
});

describe('createNodeShimFs.replaceOwn', () => {
  it('replaces our launcher in one step, keeping it executable', () => {
    const d = fresh();
    const file = path.join(d, 'octopus-diff');
    writeFileSync(file, ours, { mode: 0o755 });
    const next = `#!/bin/sh\n# ${MARKER}\nexec false\n`;
    fs.replaceOwn(file, next);
    expect(readFileSync(file, 'utf8')).toBe(next);
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o755);
    expect(readdirSync(d)).toEqual(['octopus-diff']);
  });

  it('refuses a file without the marker, and leaves it as it was', () => {
    const d = fresh();
    const file = path.join(d, 'octopus-diff');
    writeFileSync(file, '#!/usr/bin/env node\n');
    expect(() => fs.replaceOwn(file, ours)).toThrow(ShimNotOursError);
    expect(readFileSync(file, 'utf8')).toBe('#!/usr/bin/env node\n');
    expect(readdirSync(d)).toEqual(['octopus-diff']);
  });

  it('refuses a missing file, a directory, and a symlink (even one to our launcher)', () => {
    const d = fresh();
    mkdirSync(path.join(d, 'dir'));
    expect(() => fs.replaceOwn(path.join(d, 'missing'), ours)).toThrow(ShimNotOursError);
    expect(() => fs.replaceOwn(path.join(d, 'dir'), ours)).toThrow(ShimNotOursError);
    if (posix) {
      writeFileSync(path.join(d, 'real'), ours);
      symlinkSync(path.join(d, 'real'), path.join(d, 'link'));
      expect(() => fs.replaceOwn(path.join(d, 'link'), 'x')).toThrow(ShimNotOursError);
      expect(readFileSync(path.join(d, 'real'), 'utf8')).toBe(ours);
    }
  });

  it.runIf(posix)('does not leave a staging file when the directory is read-only', () => {
    if (process.getuid?.() === 0) return; // root ignores the mode
    const d = fresh();
    const file = path.join(d, 'octopus-diff');
    writeFileSync(file, ours);
    chmodSync(d, 0o555);
    try {
      expect(() => fs.replaceOwn(file, `${ours}# more\n`)).toThrow();
      expect(readdirSync(d)).toEqual(['octopus-diff']);
      expect(readFileSync(file, 'utf8')).toBe(ours);
    } finally {
      chmodSync(d, 0o755);
    }
  });
});

describe('Windows user PATH editor', () => {
  it('encodePowerShell is UTF-16LE base64 (what -EncodedCommand takes)', () => {
    const encoded = encodePowerShell('Write-Output "é"');
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe('Write-Output "é"');
  });

  it('runs the system PowerShell by absolute path (not from PATH)', () => {
    expect(powerShellExe({ SystemRoot: 'C:\\Windows' })).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(powerShellExe({})).toMatch(/^C:\\Windows\\System32\\WindowsPowerShell/);
  });

  it('parses the read script output: unset, REG_EXPAND_SZ, REG_SZ, BOM and CRLF', () => {
    expect(parseUserPathOutput('none\r\n')).toEqual({ value: null, kind: 'ExpandString' });
    expect(parseUserPathOutput('ExpandString\r\n%USERPROFILE%\\bin;C:\\é\r\n')).toEqual({
      value: '%USERPROFILE%\\bin;C:\\é',
      kind: 'ExpandString',
    });
    expect(parseUserPathOutput('\uFEFFString\nC:\\x\n')).toEqual({
      value: 'C:\\x',
      kind: 'String',
    });
    expect(() => parseUserPathOutput('')).toThrow();
    expect(() => parseUserPathOutput('Binary\nxx')).toThrow();
  });

  it('read: runs the read script, hidden and non-interactive, and parses the answer', async () => {
    const calls: {
      file: string;
      args: readonly string[];
      env: Record<string, string | undefined>;
    }[] = [];
    const editor = createWindowsUserPath({
      env: { SystemRoot: 'C:\\Windows' },
      run: async (file, args, env) => {
        calls.push({ file, args, env });
        return 'ExpandString\r\nC:\\a\r\n';
      },
    });
    expect(await editor.read()).toEqual({ value: 'C:\\a', kind: 'ExpandString' });
    const [call] = calls;
    expect(call?.file).toMatch(/powershell\.exe$/);
    expect(call?.args).toEqual(
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-EncodedCommand']),
    );
    const encoded = call?.args[call.args.indexOf('-EncodedCommand') + 1] ?? '';
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(READ_USER_PATH_SCRIPT);
  });

  it('write: the new value travels in the environment, never in the script or the arguments', async () => {
    const hostile = `C:\\a b;C:\\it's;C:\\"q";%X%;C:\\é日本 $(calc) \`x\`;C:\\new`;
    const calls: { args: readonly string[]; env: Record<string, string | undefined> }[] = [];
    const editor = createWindowsUserPath({
      env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows' },
      run: async (_file, args, env) => {
        calls.push({ args, env });
        return '';
      },
    });
    await editor.write(hostile, 'String');
    const [call] = calls;
    expect(call?.env.OCTOPUS_DIFF_USER_PATH).toBe(hostile);
    expect(call?.env.OCTOPUS_DIFF_USER_PATH_KIND).toBe('String');
    expect(call?.env.PATH).toBe('C:\\Windows');
    const encoded = call?.args[call.args.indexOf('-EncodedCommand') + 1] ?? '';
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(script).toBe(WRITE_USER_PATH_SCRIPT);
    expect(script).not.toContain('C:\\new');
    expect(call?.args.join(' ')).not.toContain('C:\\new');
  });

  it('write refuses an empty value or an unknown type before running anything', async () => {
    let ran = false;
    const editor = createWindowsUserPath({
      env: {},
      run: async () => {
        ran = true;
        return '';
      },
    });
    await expect(editor.write('', 'String')).rejects.toThrow();
    await expect(editor.write('C:\\x', 'Binary' as 'String')).rejects.toThrow();
    expect(ran).toBe(false);
  });

  it('a failing PowerShell rejects', async () => {
    const editor = createWindowsUserPath({
      env: {},
      run: async () => {
        throw new Error('exit 1: access denied');
      },
    });
    await expect(editor.read()).rejects.toThrow(/access denied/);
    await expect(editor.write('C:\\x', 'String')).rejects.toThrow(/access denied/);
  });

  it('the scripts guard the registry write (empty value, wrong type) and tell the shell about it', () => {
    expect(WRITE_USER_PATH_SCRIPT).toContain('$env:OCTOPUS_DIFF_USER_PATH');
    expect(WRITE_USER_PATH_SCRIPT).toMatch(/IsNullOrEmpty/);
    expect(WRITE_USER_PATH_SCRIPT).toContain("'Environment'");
    expect(WRITE_USER_PATH_SCRIPT).toContain('SendMessageTimeout');
    expect(READ_USER_PATH_SCRIPT).toContain('DoNotExpandEnvironmentVariables');
  });
});
