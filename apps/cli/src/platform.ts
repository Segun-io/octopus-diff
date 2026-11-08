import { readFileSync } from 'node:fs';
import type { Env } from './paths.js';

export type ReadTextSync = (file: string) => string | null;

export const readTextSync: ReadTextSync = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

export interface WslInfo {
  wsl: boolean;
  /** 1 or 2 when known. */
  version: 1 | 2 | null;
  distro: string | null;
}

/** Detects Windows Subsystem for Linux (env vars set by WSL, else the kernel release string). */
export function detectWsl(platform: NodeJS.Platform, env: Env, readText: ReadTextSync): WslInfo {
  if (platform !== 'linux') return { wsl: false, version: null, distro: null };
  const release = readText('/proc/sys/kernel/osrelease') ?? readText('/proc/version') ?? '';
  const kernelSaysWsl = /microsoft|wsl/i.test(release);
  const envSaysWsl = env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined;
  if (!kernelSaysWsl && !envSaysWsl) return { wsl: false, version: null, distro: null };
  const version =
    /wsl2|microsoft-standard/i.test(release) || env.WSL_INTEROP ? 2 : kernelSaysWsl ? 1 : null;
  return { wsl: true, version, distro: env.WSL_DISTRO_NAME ?? null };
}

/** True for paths on mounted Windows drives under WSL (`/mnt/c/...`), which watch and scan poorly. */
export function isWindowsMountPath(p: string): boolean {
  return /^\/mnt\/[a-z](\/|$)/i.test(p);
}
