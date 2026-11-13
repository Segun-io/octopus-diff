// The Electron binary of apps/desktop's `electron` package, found WITHOUT triggering its lazy
// download (`require('electron')` downloads ~100 MB when the binary is missing; Electron 45 has no
// install script). Returns null when it is not there: scripts that need it skip.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function electronBinary() {
  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    const p = path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH, binaryName());
    return existsSync(p) ? p : null;
  }
  let pkgDir;
  try {
    pkgDir = path.dirname(
      createRequire(path.join(desktopRoot, 'package.json')).resolve('electron/package.json'),
    );
  } catch {
    return null;
  }
  const pathFile = path.join(pkgDir, 'path.txt');
  if (!existsSync(pathFile)) return null;
  const binary = path.join(pkgDir, 'dist', readFileSync(pathFile, 'utf8').trim());
  return existsSync(binary) ? binary : null;
}

function binaryName() {
  if (process.platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron';
  return process.platform === 'win32' ? 'electron.exe' : 'electron';
}
