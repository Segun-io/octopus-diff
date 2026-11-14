/**
 * The installer's flow (docs/DESKTOP.md §3.2, roadmap #21) with the filesystem, PATH and the
 * Windows user-PATH editor faked: status, install, update, refuse, the races, the messages, refresh.
 */
import { DesktopCliInstallResultSchema, DesktopCliStatusSchema } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { type FileFacts, MARKER, renderLauncher } from '../src/cli-shim.js';
import {
  type CliShimDeps,
  createCliShim,
  ShimExistsError,
  type ShimFs,
  ShimNotOursError,
  type UserPathEditor,
} from '../src/cli-shim-service.js';

class FakeFs implements ShimFs {
  files = new Map<string, FileFacts>();
  dirs: string[] = [];
  writes: { op: 'create' | 'replace'; file: string; content: string }[] = [];
  /** Run once right before the next `create`: a file appearing in the race window. */
  beforeCreate: (() => void) | null = null;
  failWith: Error | null = null;

  inspect(file: string): FileFacts {
    return this.files.get(file) ?? { kind: 'missing' };
  }
  mkdirp(dir: string): void {
    if (this.failWith) throw this.failWith;
    this.dirs.push(dir);
  }
  create(file: string, content: string): void {
    this.beforeCreate?.();
    this.beforeCreate = null;
    if (this.files.has(file)) throw new ShimExistsError(file);
    this.writes.push({ op: 'create', file, content });
    this.files.set(file, { kind: 'file', content });
  }
  replaceOwn(file: string, content: string): void {
    const now = this.files.get(file);
    if (now?.kind !== 'file' || !now.content.includes(MARKER)) throw new ShimNotOursError(file);
    this.writes.push({ op: 'replace', file, content });
    this.files.set(file, { kind: 'file', content });
  }
}

class FakeUserPath implements UserPathEditor {
  value: string | null = null;
  kind: 'String' | 'ExpandString' = 'ExpandString';
  writes: { value: string; kind: string }[] = [];
  fail: Error | null = null;
  async read() {
    return { value: this.value, kind: this.kind };
  }
  async write(value: string, kind: 'String' | 'ExpandString') {
    if (this.fail) throw this.fail;
    this.writes.push({ value, kind });
    this.value = value;
    this.kind = kind;
  }
}

const EXE = '/opt/octopus-diff/octopus-diff-desktop';
const ENTRY = '/opt/octopus-diff/resources/app.asar/dist/cli/index.js';
const TARGET = '/home/a/.local/bin/octopus-diff';
const foreign: FileFacts = { kind: 'file', content: '#!/usr/bin/env node\nimport "x";\n' };
const desiredLinux = renderLauncher({ kind: 'direct', executable: EXE, entry: ENTRY });
const oldLauncher = renderLauncher({
  kind: 'direct',
  executable: '/old/place/app',
  entry: '/old/place/index.js',
});

function setup(over: Partial<CliShimDeps> = {}) {
  const fs = new FakeFs();
  const deps: CliShimDeps = {
    platform: 'linux',
    env: {},
    homedir: '/home/a',
    execPath: EXE,
    entry: ENTRY,
    isPackaged: true,
    fs,
    pathValue: async () => '/usr/bin:/home/a/.local/bin',
    ...over,
  };
  return { fs, shim: createCliShim(deps), deps };
}

describe('status', () => {
  it('a development run: unavailable, with the reason', async () => {
    const { shim } = setup({ isPackaged: false });
    const status = await shim.status();
    expect(status.state).toBe('unavailable');
    expect(status.reason).toMatch(/installed app/);
    expect(status.path).toBeUndefined();
  });

  it('nothing installed: not-installed, with the path and whether its directory is on PATH', async () => {
    expect(await setup().shim.status()).toEqual({
      state: 'not-installed',
      path: TARGET,
      onPath: true,
    });
    const off = setup({ pathValue: async () => '/usr/bin' });
    expect(await off.shim.status()).toEqual({
      state: 'not-installed',
      path: TARGET,
      onPath: false,
    });
  });

  it('our launcher pointing at this app: current; pointing elsewhere: outdated', async () => {
    const a = setup();
    a.fs.files.set(TARGET, { kind: 'file', content: desiredLinux });
    expect((await a.shim.status()).state).toBe('current');
    const b = setup();
    b.fs.files.set(TARGET, { kind: 'file', content: oldLauncher });
    expect((await b.shim.status()).state).toBe('outdated');
  });

  it('a file we did not write at the target: conflict', async () => {
    const { fs, shim } = setup();
    fs.files.set(TARGET, foreign);
    expect(await shim.status()).toEqual({
      state: 'conflict',
      path: TARGET,
      onPath: true,
      conflict: { kind: 'at-target', path: TARGET },
    });
  });

  it('a real install elsewhere on PATH (npm): conflict, naming it; a symlink counts', async () => {
    for (const facts of [foreign, { kind: 'symlink' } as FileFacts]) {
      const { fs, shim } = setup({ pathValue: async () => '/usr/local/bin:/home/a/.local/bin' });
      fs.files.set('/usr/local/bin/octopus-diff', facts);
      const status = await shim.status();
      expect(status.state, facts.kind).toBe('conflict');
      expect(status.conflict).toEqual({ kind: 'on-path', path: '/usr/local/bin/octopus-diff' });
    }
  });

  it('our own launcher in another PATH directory, or a directory of that name, is no conflict', async () => {
    const { fs, shim } = setup({ pathValue: async () => '/opt/bin:/srv:/home/a/.local/bin' });
    fs.files.set('/opt/bin/octopus-diff', { kind: 'file', content: oldLauncher });
    fs.files.set('/srv/octopus-diff', { kind: 'other' });
    expect((await shim.status()).state).toBe('not-installed');
  });

  it('every status parses against the contract', async () => {
    const { fs, shim } = setup();
    fs.files.set(TARGET, foreign);
    DesktopCliStatusSchema.parse(await shim.status());
    DesktopCliStatusSchema.parse(await setup({ isPackaged: false }).shim.status());
  });
});

describe('install', () => {
  it('writes a new launcher, creating the directory; says nothing about PATH when it is on it', async () => {
    const { fs, shim } = setup();
    const r = await shim.install();
    expect(r.outcome).toBe('installed');
    expect(fs.dirs).toEqual(['/home/a/.local/bin']);
    expect(fs.writes).toEqual([{ op: 'create', file: TARGET, content: desiredLinux }]);
    expect(r.status).toEqual({ state: 'current', path: TARGET, onPath: true });
    expect(r.message).toContain(TARGET);
    expect(r.message).not.toMatch(/not on your PATH/);
    DesktopCliInstallResultSchema.parse(r);
  });

  it('tells the user when the directory is not on PATH, with the line to add', async () => {
    const { shim } = setup({ pathValue: async () => '/usr/bin' });
    const r = await shim.install();
    expect(r.outcome).toBe('installed');
    expect(r.status.onPath).toBe(false);
    expect(r.message).toMatch(/\/home\/a\/\.local\/bin is not on your PATH/);
    expect(r.message).toContain('export PATH="$HOME/.local/bin:$PATH"');
  });

  it('rewrites only our own launcher, and says it updated', async () => {
    const { fs, shim } = setup();
    fs.files.set(TARGET, { kind: 'file', content: oldLauncher });
    const r = await shim.install();
    expect(r.outcome).toBe('updated');
    expect(fs.writes).toEqual([{ op: 'replace', file: TARGET, content: desiredLinux }]);
    expect(r.status.state).toBe('current');
  });

  it('an identical launcher is left alone', async () => {
    const { fs, shim } = setup();
    fs.files.set(TARGET, { kind: 'file', content: desiredLinux });
    const r = await shim.install();
    expect(r.outcome).toBe('unchanged');
    expect(fs.writes).toEqual([]);
  });

  it('never overwrites a file at the target that is not ours', async () => {
    for (const facts of [foreign, { kind: 'symlink' }, { kind: 'other' }] as FileFacts[]) {
      const { fs, shim } = setup();
      fs.files.set(TARGET, facts);
      const r = await shim.install();
      expect(r.outcome, facts.kind).toBe('refused');
      expect(fs.writes, facts.kind).toEqual([]);
      expect(fs.files.get(TARGET)).toEqual(facts);
      expect(r.message).toContain(TARGET);
      expect(r.message).toMatch(/left alone|not written/);
    }
  });

  it('says so and installs nothing when another octopus-diff is on PATH', async () => {
    const { fs, shim } = setup({
      pathValue: async () => '/home/a/.npm-global/bin:/home/a/.local/bin',
    });
    fs.files.set('/home/a/.npm-global/bin/octopus-diff', foreign);
    const r = await shim.install();
    expect(r.outcome).toBe('refused');
    expect(fs.writes).toEqual([]);
    expect(fs.dirs).toEqual([]);
    expect(r.message).toContain('/home/a/.npm-global/bin/octopus-diff');
    expect(r.message).toMatch(/already installed/);
    expect(r.status.state).toBe('conflict');
  });

  it('also refuses to update our launcher when another install has appeared on PATH', async () => {
    const { fs, shim } = setup({ pathValue: async () => '/usr/local/bin:/home/a/.local/bin' });
    fs.files.set(TARGET, { kind: 'file', content: oldLauncher });
    fs.files.set('/usr/local/bin/octopus-diff', foreign);
    expect((await shim.install()).outcome).toBe('refused');
    expect(fs.writes).toEqual([]);
  });

  it('a real file that appears between the check and the write is not overwritten', async () => {
    const { fs, shim } = setup();
    fs.beforeCreate = () => fs.files.set(TARGET, foreign);
    const r = await shim.install();
    expect(r.outcome).toBe('refused');
    expect(fs.files.get(TARGET)).toEqual(foreign);
    expect(fs.writes).toEqual([]);
  });

  it('a launcher replaced by a foreign file before the rewrite is not overwritten either', async () => {
    const { fs, shim } = setup();
    fs.files.set(TARGET, { kind: 'file', content: oldLauncher });
    const replace = fs.replaceOwn.bind(fs);
    fs.replaceOwn = (file, content) => {
      fs.files.set(file, foreign);
      replace(file, content);
    };
    const r = await shim.install();
    expect(r.outcome).toBe('refused');
    expect(fs.files.get(TARGET)).toEqual(foreign);
  });

  it('a write error is reported as failed, not thrown', async () => {
    const { fs, shim } = setup();
    fs.failWith = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const r = await shim.install();
    expect(r.outcome).toBe('failed');
    expect(r.message).toMatch(/EACCES/);
    expect(r.message).toContain(TARGET);
    expect(r.status.state).toBe('not-installed');
  });

  it('unavailable: nothing is touched', async () => {
    const { fs, shim } = setup({ isPackaged: false });
    const r = await shim.install();
    expect(r.outcome).toBe('unavailable');
    expect(r.message).toMatch(/installed app/);
    expect(fs.writes).toEqual([]);
    expect(fs.dirs).toEqual([]);
  });

  it('an AppImage run writes a launcher that runs the AppImage file', async () => {
    const { fs, shim } = setup({
      env: { APPIMAGE: '/home/a/Apps/octopus-diff.AppImage', APPDIR: '/tmp/.mount_abc123' },
      execPath: '/tmp/.mount_abc123/octopus-diff-desktop',
      entry: '/tmp/.mount_abc123/resources/app.asar/dist/cli/index.js',
    });
    await shim.install();
    const written = fs.files.get(TARGET);
    expect(written?.kind === 'file' && written.content).toContain(
      "app='/home/a/Apps/octopus-diff.AppImage'",
    );
    expect(written?.kind === 'file' && written.content).not.toContain('.mount_abc123');
  });

  it('a launcher whose path cannot be quoted is unavailable, not half written', async () => {
    const { fs, shim } = setup({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\L' },
      homedir: 'C:\\Users\\a',
      execPath: 'C:\\bad"dir\\octopus-diff.exe',
      entry: 'C:\\bad"dir\\resources\\app.asar\\dist\\cli\\index.js',
      userPath: new FakeUserPath(),
      pathValue: async () => '',
    });
    const r = await shim.install();
    expect(r.outcome).toBe('unavailable');
    expect(fs.writes).toEqual([]);
  });
});

describe('install on Windows', () => {
  const winTarget = 'C:\\L\\octopus-diff\\bin\\octopus-diff.cmd';
  const winDir = 'C:\\L\\octopus-diff\\bin';
  const winSetup = (userValue: string | null, over: Partial<CliShimDeps> = {}) => {
    const userPath = new FakeUserPath();
    userPath.value = userValue;
    const s = setup({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\L', PATH: 'C:\\Windows' },
      homedir: 'C:\\Users\\a',
      execPath: 'C:\\L\\Programs\\octopus-diff\\octopus-diff.exe',
      entry: 'C:\\L\\Programs\\octopus-diff\\resources\\app.asar\\dist\\cli\\index.js',
      userPath,
      pathValue: async () => 'C:\\Windows',
      ...over,
    });
    return { ...s, userPath };
  };

  it('writes the .cmd under %LOCALAPPDATA% and appends its directory to the user PATH', async () => {
    const { fs, shim, userPath } = winSetup('%USERPROFILE%\\bin');
    const r = await shim.install();
    expect(r.outcome).toBe('installed');
    expect(fs.writes.map((w) => w.file)).toEqual([winTarget]);
    expect(fs.writes[0]?.content).toContain('\r\n');
    expect(userPath.writes).toEqual([
      { value: `%USERPROFILE%\\bin;${winDir}`, kind: 'ExpandString' },
    ]);
    expect(r.status.onPath).toBe(true);
    expect(r.message).toMatch(/new terminal/);
  });

  it('leaves the user PATH alone when the directory is already in it', async () => {
    const { shim, userPath } = winSetup(`C:\\x;${winDir.toLowerCase()}\\`);
    const r = await shim.install();
    expect(r.outcome).toBe('installed');
    expect(userPath.writes).toEqual([]);
    expect(r.message).not.toMatch(/Added/);
  });

  it('keeps a REG_SZ PATH a REG_SZ', async () => {
    const { shim, userPath } = winSetup('C:\\x');
    userPath.kind = 'String';
    await shim.install();
    expect(userPath.writes[0]?.kind).toBe('String');
  });

  it('a missing user PATH value is created', async () => {
    const { shim, userPath } = winSetup(null);
    await shim.install();
    expect(userPath.writes).toEqual([{ value: winDir, kind: 'ExpandString' }]);
  });

  it('a PATH edit that fails still installs the launcher and says how to add it', async () => {
    const { fs, shim, userPath } = winSetup('C:\\x');
    userPath.fail = new Error('access denied');
    const r = await shim.install();
    expect(r.outcome).toBe('installed');
    expect(fs.writes).toHaveLength(1);
    expect(r.status.onPath).toBe(false);
    expect(r.message).toContain(winDir);
    expect(r.message).toMatch(/could not add/i);
  });

  it('an npm install on PATH: refused, the user PATH is not touched', async () => {
    const { fs, shim, userPath } = winSetup('C:\\x', {
      pathValue: async () => 'C:\\Users\\a\\AppData\\Roaming\\npm',
    });
    fs.files.set('C:\\Users\\a\\AppData\\Roaming\\npm\\octopus-diff.cmd', foreign);
    const r = await shim.install();
    expect(r.outcome).toBe('refused');
    expect(fs.writes).toEqual([]);
    expect(userPath.writes).toEqual([]);
  });

  it('an unchanged launcher whose directory fell off the PATH is put back', async () => {
    const { shim, userPath } = winSetup('C:\\x');
    await shim.install();
    userPath.value = 'C:\\x';
    userPath.writes = [];
    const r = await shim.install();
    expect(r.outcome).toBe('unchanged');
    expect(userPath.writes).toEqual([{ value: `C:\\x;${winDir}`, kind: 'ExpandString' }]);
  });
});

describe('refresh (after an update moved the app)', () => {
  it('rewrites our outdated launcher', async () => {
    const { fs, shim } = setup();
    fs.files.set(TARGET, { kind: 'file', content: oldLauncher });
    expect(await shim.refresh()).toBe('updated');
    expect(fs.writes).toEqual([{ op: 'replace', file: TARGET, content: desiredLinux }]);
  });

  it('does nothing when there is no launcher (installing needs the user), or it is current', async () => {
    const a = setup();
    expect(await a.shim.refresh()).toBe('skipped');
    expect(a.fs.writes).toEqual([]);
    const b = setup();
    b.fs.files.set(TARGET, { kind: 'file', content: desiredLinux });
    expect(await b.shim.refresh()).toBe('skipped');
    expect(b.fs.writes).toEqual([]);
  });

  it('never touches a foreign file or a launcher when another install is on PATH', async () => {
    const a = setup();
    a.fs.files.set(TARGET, foreign);
    expect(await a.shim.refresh()).toBe('skipped');
    expect(a.fs.writes).toEqual([]);
    const b = setup({ pathValue: async () => '/usr/local/bin:/home/a/.local/bin' });
    b.fs.files.set(TARGET, { kind: 'file', content: oldLauncher });
    b.fs.files.set('/usr/local/bin/octopus-diff', foreign);
    expect(await b.shim.refresh()).toBe('skipped');
    expect(b.fs.writes).toEqual([]);
  });

  it('never throws (it runs at startup)', async () => {
    const { fs, shim } = setup();
    fs.files.set(TARGET, { kind: 'file', content: oldLauncher });
    fs.replaceOwn = () => {
      throw new Error('disk full');
    };
    expect(await shim.refresh()).toBe('skipped');
  });

  it('not in a development run', async () => {
    const { fs, shim } = setup({ isPackaged: false });
    fs.files.set(TARGET, { kind: 'file', content: oldLauncher });
    expect(await shim.refresh()).toBe('skipped');
    expect(fs.writes).toEqual([]);
  });
});

describe('concurrency', () => {
  it('two installs at once (the menu and the bridge) run one after the other', async () => {
    const { fs, shim } = setup();
    const [a, b] = await Promise.all([shim.install(), shim.install()]);
    expect([a.outcome, b.outcome].sort()).toEqual(['installed', 'unchanged']);
    expect(fs.writes).toHaveLength(1);
  });

  it('a refresh at startup and an install at once write once', async () => {
    const { fs, shim } = setup();
    fs.files.set(TARGET, { kind: 'file', content: oldLauncher });
    await Promise.all([shim.refresh(), shim.install()]);
    expect(fs.writes).toHaveLength(1);
  });
});
