import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the built web UI can be found, in order:
 *
 * 1. `<cli package>/dist/web` — copied there by the CLI build (`scripts/copy-web-assets.mjs`), so a
 *    packed/installed CLI carries its own UI.
 * 2. `<cli package>/../web/dist` — the workspace build of `apps/web` (dev runs from `src/` via tsx,
 *    or a CLI build made before the web build existed).
 *
 * `--web-root` / config `webRoot` override both.
 */
export function webRootCandidates(moduleUrl: string = import.meta.url): string[] {
  // This module lives in `<pkg>/src/` (dev) or `<pkg>/dist/` (built); either way the package
  // root is one level up.
  const packageRoot = path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..');
  return [path.join(packageRoot, 'dist', 'web'), path.resolve(packageRoot, '..', 'web', 'dist')];
}

export function hasWebAssets(dir: string, exists: (p: string) => boolean = existsSync): boolean {
  return exists(path.join(dir, 'index.html'));
}

export type WebRootResult =
  | { kind: 'found'; dir: string; explicit: boolean }
  | { kind: 'missing'; explicit: true; dir: string }
  | { kind: 'missing'; explicit: false; searched: string[] };

export function resolveWebRoot(
  explicit: string | undefined,
  candidates: string[] = webRootCandidates(),
  exists: (p: string) => boolean = existsSync,
): WebRootResult {
  if (explicit !== undefined) {
    return hasWebAssets(explicit, exists)
      ? { kind: 'found', dir: explicit, explicit: true }
      : { kind: 'missing', explicit: true, dir: explicit };
  }
  const dir = candidates.find((candidate) => hasWebAssets(candidate, exists));
  return dir
    ? { kind: 'found', dir, explicit: false }
    : { kind: 'missing', explicit: false, searched: candidates };
}
