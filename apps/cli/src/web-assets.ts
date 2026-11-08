import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTextSync } from './platform.js';

/**
 * Where the built web UI can be found, in order:
 *
 * 1. In the octopus-diff workspace (`../web/package.json` is `@octopus-diff/web`): `apps/web/dist`,
 *    so a fresh `pnpm --filter @octopus-diff/web build` is picked up without rebuilding the CLI.
 * 2. `<cli package>/dist/web`: copied there by the CLI build (`scripts/copy-web-assets.mjs`), so a
 *    packed/installed CLI carries its own UI.
 *
 * The workspace check matters: in an installed package `../web` would be some unrelated
 * `node_modules/web`. `--web-root` / config `webRoot` override both.
 */
export function webRootCandidates(
  moduleUrl: string = import.meta.url,
  readText: (file: string) => string | null = readTextSync,
): string[] {
  // This module lives in `<pkg>/src/` (dev) or `<pkg>/dist/` (built or bundled); either way the
  // package root is one level up.
  const packageRoot = path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..');
  const bundled = path.join(packageRoot, 'dist', 'web');
  const webPackage = path.resolve(packageRoot, '..', 'web');
  let isWorkspace = false;
  try {
    const pkg = JSON.parse(readText(path.join(webPackage, 'package.json')) ?? 'null') as {
      name?: unknown;
    } | null;
    isWorkspace = pkg?.name === '@octopus-diff/web';
  } catch {
    isWorkspace = false;
  }
  return isWorkspace ? [path.join(webPackage, 'dist'), bundled] : [bundled];
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
