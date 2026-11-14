/**
 * The packaged-app e2e must never let the app rewrite a developer's real `octopus-diff` launcher
 * (the app refreshes it at startup, DECISIONS #574), and must not do so by faking HOME: on macOS
 * a fake HOME breaks Chromium (Keychain, ~/Library) and the UI never becomes ready (PR #110 CI,
 * DECISIONS #581). Instead every GUI launch carries `OCTOPUS_DESKTOP_NO_CLI_REFRESH=1`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { appLaunchEnv } from '../desktop/support/packaged-app.js';

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop');

describe('appLaunchEnv', () => {
  const real = {
    HOME: '/home/dev',
    USERPROFILE: 'C:\\Users\\dev',
    LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
    XDG_CONFIG_HOME: '/home/dev/.config',
    PATH: '/usr/bin',
    GIT_CONFIG_GLOBAL: '/tmp/x/gitconfig',
    ELECTRON_RUN_AS_NODE: '1',
  };

  it('carries the switch that stops the app rewriting a launcher', () => {
    expect(appLaunchEnv(real).OCTOPUS_DESKTOP_NO_CLI_REFRESH).toBe('1');
  });

  it('leaves the home and everything else as it is, and drops RUN_AS_NODE, without changing its input', () => {
    const input = { ...real };
    const env = appLaunchEnv(input);
    for (const key of [
      'HOME',
      'USERPROFILE',
      'LOCALAPPDATA',
      'XDG_CONFIG_HOME',
      'PATH',
      'GIT_CONFIG_GLOBAL',
    ] as const) {
      expect(env[key], key).toBe(real[key]);
    }
    expect('ELECTRON_RUN_AS_NODE' in env).toBe(false);
    expect(input).toEqual(real);
  });

  it('overrides a caller that tries to turn the switch off', () => {
    expect(
      appLaunchEnv({ OCTOPUS_DESKTOP_NO_CLI_REFRESH: '0' }).OCTOPUS_DESKTOP_NO_CLI_REFRESH,
    ).toBe('1');
  });
});

describe('every packaged-app launch in e2e/desktop gets the switch', () => {
  const files = [
    ...readdirSync(desktopDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => join(desktopDir, f)),
    join(desktopDir, 'support', 'packaged-app.ts'),
  ];

  it('launchApp and runApp (the tamper-test copies and the cli-shim spec use them) pass appLaunchEnv', () => {
    const source = readFileSync(join(desktopDir, 'support', 'packaged-app.ts'), 'utf8');
    for (const name of ['launchApp', 'runApp']) {
      const start = source.indexOf(`export function ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      const next = source.indexOf('\nexport ', start + 1);
      const body = source.slice(start, next === -1 ? undefined : next);
      expect(body, name).toContain('appLaunchEnv(env)');
    }
  });

  it('nothing else starts the app binary as the app: no direct spawn of an `.executable` outside those two', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const stripped = file.endsWith(join('support', 'packaged-app.ts'))
        ? text.replace(/export function (launchApp|runApp)\([\s\S]*?\n}\n/g, '')
        : text;
      const spawns = stripped.match(/\b(?:spawn|spawnSync)\(\s*[\w.]*executable/g) ?? [];
      expect(spawns, file).toEqual([]);
    }
  });

  it('the only other uses of the binary run it as Node (ELECTRON_RUN_AS_NODE), never as the GUI app', () => {
    let seen = 0;
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/execFileSync\(\s*[\w.]*executable[\s\S]*?\)/g)) {
        seen++;
        expect(m[0], `${file}: ${m[0].slice(0, 60)}`).toContain('ELECTRON_RUN_AS_NODE');
      }
    }
    expect(seen, 'the check looked at something').toBeGreaterThan(0);
  });
});
