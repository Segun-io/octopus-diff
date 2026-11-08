import { chmod, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { APP_NAME } from '@octopus-diff/contracts';

/** Expands a leading `~` / `~/` to the user's home directory. `~user` is not supported. */
export function expandHome(input: string, home = os.homedir()): string {
  if (input === '~') return home;
  if (input.startsWith('~/') || (path.sep === '\\' && input.startsWith('~\\'))) {
    return path.join(home, input.slice(2));
  }
  return input;
}

/** Expands `~` and resolves a user-supplied path against `cwd` (the daemon's cwd by default). */
export function resolveInputPath(input: string, cwd = process.cwd(), home = os.homedir()): string {
  return path.resolve(cwd, expandHome(input.trim(), home));
}

function xdgDir(envValue: string | undefined, fallback: string[]): string {
  // The XDG spec says relative values must be ignored.
  if (envValue && path.isAbsolute(envValue)) return envValue;
  return path.join(os.homedir(), ...fallback);
}

export interface ResolvedDirs {
  stateDir: string;
  configDir: string;
}

/**
 * Resolves the state and config directories (PLAN §5.1): explicit options win, then
 * `$XDG_STATE_HOME` / `$XDG_CONFIG_HOME`, then `~/.local/state` / `~/.config`. The same layout
 * is used on every platform (see DECISIONS, WS2).
 */
export function resolveDirs(
  options: { stateDir?: string; configDir?: string },
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDirs {
  const stateDir = options.stateDir
    ? resolveInputPath(options.stateDir)
    : path.join(xdgDir(env.XDG_STATE_HOME, ['.local', 'state']), APP_NAME);
  const configDir = options.configDir
    ? resolveInputPath(options.configDir)
    : path.join(xdgDir(env.XDG_CONFIG_HOME, ['.config']), APP_NAME);
  return { stateDir, configDir };
}

/**
 * Creates `dir` (and parents) with mode 0700 and tightens an existing directory that is group-
 * or world-accessible. Returns a warning message when permissions had to be fixed.
 */
export async function ensurePrivateDir(dir: string): Promise<string | null> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return null;
  const info = await stat(dir);
  if ((info.mode & 0o077) !== 0) {
    await chmod(dir, 0o700);
    return `tightened permissions of ${dir} to 0700`;
  }
  return null;
}

/** True if `child` is `parent` or inside it (both absolute, normalized). */
export function isSameOrInside(parent: string, child: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(prefix);
}
