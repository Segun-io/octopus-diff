import { homedir } from 'node:os';
import path from 'node:path';
import { APP_NAME } from '@octopus-diff/contracts';

/** Environment variables, injectable for tests (never read `process.env` below the entry point). */
export type Env = Readonly<Record<string, string | undefined>>;

export const CONFIG_FILE_NAME = 'config.json';
/** Written by the daemon (PLAN §5.4, DECISIONS #16). */
export const TOKEN_FILE_NAME = 'token';
/** Written by `octopus-diff serve` so `add` / `status` can find the running daemon. */
export const RUNTIME_FILE_NAME = 'daemon.json';

export function homeDir(env: Env): string {
  const home = env.HOME;
  return home && path.isAbsolute(home) ? home : homedir();
}

/** Expands a leading `~` or `~/` to the home directory. `~user` is not supported. */
export function expandHome(input: string, home: string): string {
  if (input === '~') return home;
  if (input.startsWith('~/')) return path.join(home, input.slice(2));
  return input;
}

/** Resolves a user-supplied path (may start with `~`, may be relative to `base`). */
export function resolveUserPath(input: string, base: string, home: string): string {
  return path.resolve(base, expandHome(input, home));
}

// The XDG Base Directory spec says relative values must be ignored.
function xdgDir(env: Env, name: string, fallback: string): string {
  const value = env[name];
  return value && path.isAbsolute(value) ? value : path.join(homeDir(env), fallback);
}

/** `$XDG_CONFIG_HOME/octopus-diff`, default `~/.config/octopus-diff`. */
export function defaultConfigDir(env: Env): string {
  return path.join(xdgDir(env, 'XDG_CONFIG_HOME', '.config'), APP_NAME);
}

/** `$XDG_STATE_HOME/octopus-diff`, default `~/.local/state/octopus-diff`. */
export function defaultStateDir(env: Env): string {
  return path.join(xdgDir(env, 'XDG_STATE_HOME', path.join('.local', 'state')), APP_NAME);
}

/** Replaces the home directory prefix with `~` for display. */
export function tildify(input: string, home: string): string {
  if (input === home) return '~';
  return input.startsWith(home + path.sep) ? `~${input.slice(home.length)}` : input;
}
