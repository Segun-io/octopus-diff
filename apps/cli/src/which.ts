import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import type { Env } from './paths.js';

export interface WhichOptions {
  env: Env;
  platform: NodeJS.Platform;
  /** Injectable for tests. Default: a regular file, executable on POSIX. */
  isExecutable?: (file: string) => boolean;
}

function defaultIsExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** `PATH` (any case on Windows) split into its absolute entries; empty and relative ones dropped. */
export function absolutePathEntries(env: Env, platform: NodeJS.Platform): string[] {
  const p = pathApi(platform);
  const key =
    platform === 'win32'
      ? (Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH')
      : 'PATH';
  return (env[key] ?? '')
    .split(p.delimiter)
    .map((entry) => (platform === 'win32' ? entry.replace(/^"(.*)"$/, '$1') : entry))
    .filter((entry) => entry !== '' && p.isAbsolute(entry));
}

/**
 * Resolves `command` to an absolute path (SEC-03). A bare name is looked up in the **absolute**
 * entries of `PATH` only: an empty or relative entry (`PATH=/usr/bin:`), or on Windows the
 * current directory (which libuv searches first), would let a binary planted in a repository
 * run. Commands that already contain a path separator must be absolute. Returns null when not
 * found.
 */
export function resolveExecutable(command: string, options: WhichOptions): string | null {
  const p = pathApi(options.platform);
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  if (command.includes('/') || (options.platform === 'win32' && command.includes('\\'))) {
    return p.isAbsolute(command) && isExecutable(command) ? command : null;
  }
  const names =
    options.platform === 'win32' && p.extname(command) === ''
      ? [`${command}.exe`, `${command}.com`]
      : [command];
  for (const dir of absolutePathEntries(options.env, options.platform)) {
    for (const name of names) {
      const candidate = p.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** `%SystemRoot%\System32\<name>` on Windows when `SystemRoot` is an absolute path. */
export function windowsSystemExecutable(name: string, env: Env): string | null {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
  if (!root || !path.win32.isAbsolute(root)) return null;
  return path.win32.join(root, 'System32', name);
}

/** `env` with `PATH` reduced to its absolute entries (passed to helpers that spawn others). */
export function withSafePath(env: Env, platform: NodeJS.Platform): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  const key =
    platform === 'win32'
      ? (Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH')
      : 'PATH';
  out[key] = absolutePathEntries(env, platform).join(pathApi(platform).delimiter);
  return out;
}
