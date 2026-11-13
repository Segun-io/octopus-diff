// Reads the Electron fuses of a PACKAGED app and fails unless they match docs/DESKTOP.md §5 (and
// electron-builder.yml's `electronFuses`). CI runs it on every OS after packaging.
//
//   node apps/desktop/scripts/check-fuses.mjs <app>
//
// <app> is the executable, a `*-unpacked` directory, or a macOS `.app` bundle. Also checks that the
// asar integrity data the `EnableEmbeddedAsarIntegrityValidation` fuse needs is embedded: the
// `ElectronAsarIntegrity` key of Info.plist (macOS) or the `INTEGRITY`/`ELECTRONASAR` resource of
// the executable (Windows). Electron validates the asar on macOS and Windows only; on Linux the fuse
// is set but has no effect (the packaged-app e2e spec records what happens there).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { FuseV1Options, getCurrentFuseWire } = require('@electron/fuses');

/** The fuse state DESKTOP.md §5 requires (true = enabled). */
export const EXPECTED_FUSES = {
  RunAsNode: true,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  GrantFileProtocolExtraPrivileges: false,
};

const ENABLE = '1'.charCodeAt(0);
const DISABLE = '0'.charCodeAt(0);

/** The Electron executable inside <app> (see the header). */
export function findExecutable(app) {
  const abs = path.resolve(app);
  if (!existsSync(abs)) throw new Error(`check-fuses: ${abs} does not exist`);
  if (statSync(abs).isFile()) return abs;
  if (abs.endsWith('.app')) {
    const macos = path.join(abs, 'Contents', 'MacOS');
    const name = readdirSync(macos)[0];
    if (!name) throw new Error(`check-fuses: nothing in ${macos}`);
    return path.join(macos, name);
  }
  const apps = readdirSync(abs).filter((f) => f.endsWith('.app'));
  if (apps[0]) return findExecutable(path.join(abs, apps[0]));
  const exe = readdirSync(abs).find(
    (f) =>
      (f.endsWith('.exe') && !/^(Uninstall|elevate)/i.test(f)) ||
      f === 'octopus-diff-desktop' ||
      f === 'octopus-diff',
  );
  if (!exe) throw new Error(`check-fuses: no app executable in ${abs}`);
  return path.join(abs, exe);
}

/** Problems with the fuse wire of `executable` (empty = all as expected). */
export async function fuseProblems(executable) {
  const wire = await getCurrentFuseWire(executable);
  const problems = [];
  const lines = [];
  for (const [name, enabled] of Object.entries(EXPECTED_FUSES)) {
    const state = wire[FuseV1Options[name]];
    const actual = state === ENABLE ? true : state === DISABLE ? false : null;
    lines.push(`  ${name}: ${actual === null ? `state ${state}` : actual ? 'on' : 'off'}`);
    if (actual !== enabled) {
      problems.push(`${name} is ${actual === null ? `in state ${state}` : actual ? 'on' : 'off'}, expected ${enabled ? 'on' : 'off'}`);
    }
  }
  return { problems, lines };
}

/** Problems with the embedded asar integrity data (macOS, Windows); null where not applicable. */
export function integrityProblem(executable) {
  if (executable.includes('.app/Contents/MacOS/')) {
    const plist = path.join(executable.split('.app/')[0] + '.app', 'Contents', 'Info.plist');
    const text = readFileSync(plist, 'utf8');
    return text.includes('<key>ElectronAsarIntegrity</key>') && text.includes('Resources/app.asar')
      ? null
      : `${plist} has no ElectronAsarIntegrity entry for Resources/app.asar`;
  }
  if (executable.toLowerCase().endsWith('.exe')) {
    const bytes = readFileSync(executable);
    return bytes.includes(Buffer.from('ELECTRONASAR', 'utf16le')) &&
      bytes.includes(Buffer.from('INTEGRITY', 'utf16le'))
      ? null
      : `${executable} has no INTEGRITY/ELECTRONASAR resource`;
  }
  return undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = process.argv[2];
  if (!app) {
    console.error('usage: node apps/desktop/scripts/check-fuses.mjs <app executable, dir or .app>');
    process.exit(2);
  }
  try {
    const executable = findExecutable(app);
    const { problems, lines } = await fuseProblems(executable);
    console.log(`check-fuses: ${executable}`);
    for (const line of lines) console.log(line);
    const integrity = integrityProblem(executable);
    if (integrity === undefined) {
      console.log('  asar integrity data: not embedded on this platform (Linux)');
    } else if (integrity === null) {
      console.log('  asar integrity data: embedded');
    } else {
      problems.push(integrity);
    }
    if (problems.length > 0) {
      for (const p of problems) console.error(`check-fuses: FAIL ${p}`);
      process.exit(1);
    }
    console.log('check-fuses: ok');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
