/**
 * The packaged-app e2e must never run the app with the developer's real home: the app rewrites its
 * `octopus-diff` launcher in `~/.local/bin` (or `%LOCALAPPDATA%`) at startup (PR #110 review).
 */
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AppDirs, isolatedAppEnv } from '../desktop/support/packaged-app.js';

const dirs: AppDirs = {
  root: join(sep, 'tmp', 'octopus-e2e', 'run'),
  stateDir: join(sep, 'tmp', 'octopus-e2e', 'run', 'state'),
  configDir: join(sep, 'tmp', 'octopus-e2e', 'run', 'config'),
  appData: join(sep, 'tmp', 'octopus-e2e', 'run', 'appdata'),
};

describe('isolatedAppEnv', () => {
  const real = {
    HOME: '/home/dev',
    USERPROFILE: 'C:\\Users\\dev',
    LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
    APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
    XDG_CONFIG_HOME: '/home/dev/.config',
    XDG_DATA_HOME: '/home/dev/.local/share',
    XDG_STATE_HOME: '/home/dev/.local/state',
    PATH: '/usr/bin',
    GIT_CONFIG_GLOBAL: '/tmp/x/gitconfig',
    ELECTRON_RUN_AS_NODE: '1',
  };

  it('points every home-like variable at a directory under the run', () => {
    const env = isolatedAppEnv(real, dirs);
    for (const key of [
      'HOME',
      'USERPROFILE',
      'LOCALAPPDATA',
      'APPDATA',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
    ] as const) {
      expect(env[key]?.startsWith(dirs.root), key).toBe(true);
      expect(env[key], key).not.toBe(real[key]);
    }
    expect(env.HOME).not.toBe(homedir());
  });

  it('keeps everything else and drops RUN_AS_NODE, without changing its input', () => {
    const input = { ...real };
    const env = isolatedAppEnv(input, dirs);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.GIT_CONFIG_GLOBAL).toBe('/tmp/x/gitconfig');
    expect('ELECTRON_RUN_AS_NODE' in env).toBe(false);
    expect(input).toEqual(real);
  });

  it('the Windows launcher directory (%LOCALAPPDATA%\\octopus-diff\\bin) is under the run too', () => {
    const env = isolatedAppEnv(real, dirs);
    expect(join(env.LOCALAPPDATA ?? '', 'octopus-diff', 'bin').startsWith(dirs.root)).toBe(true);
  });
});
