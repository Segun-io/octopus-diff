// Builds UNSIGNED installers of the desktop app with electron-builder (docs/DESKTOP.md §7, roadmap
// #19). Run `pnpm build` first (it builds apps/web/dist, which the CLI bundle copies).
//
//   pnpm --filter @octopus-diff/desktop run package [-- options]
//     --platform linux|mac|win    default: this machine's
//     --arch x64,arm64            default: this machine's (both are supported on every platform)
//     --dir                       only the unpacked app (release/<platform>[-arch]-unpacked), fast
//     --targets AppImage,deb      override the platform's targets (electron-builder names)
//
// Per platform and arch, the app is STAGED in .stage/<platform>-<arch>/ instead of packaging this
// pnpm workspace package directly (DECISIONS #511):
//   package.json      generated: name, version (the CLI's), main, and ONE dependency, the exact
//                     @parcel/watcher version of the lockfile (main.js inlines everything else)
//   node_modules/     `npm install --omit=dev --os --cpu [--libc]`: @parcel/watcher with the
//                     prebuilt package of the TARGET platform and arch only (cross-arch works)
//   dist/             the desktop build (main.js, cli/), source maps left out
//   build/            the icons (resources/)
//   electron-builder.yml
// then electron-builder runs with that stage as its project dir. Installers go to release/.
//
// Nothing here signs, notarizes or publishes anything (phase E).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAll, desktopRoot, distDir } from './build.mjs';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(desktopRoot, '..', '..');
export const releaseDir = path.join(desktopRoot, 'release');
const stageRoot = path.join(desktopRoot, '.stage');

const PLATFORMS = {
  linux: { node: 'linux', builder: 'linux', libc: 'glibc', defaultTargets: ['AppImage', 'deb'] },
  mac: { node: 'darwin', builder: 'mac', libc: null, defaultTargets: ['dmg', 'zip'] },
  win: { node: 'win32', builder: 'win', libc: null, defaultTargets: ['nsis'] },
};
const ARCHES = ['x64', 'arm64'];

function hostPlatform() {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'linux') return 'linux';
  throw new Error(`package: unsupported host platform ${process.platform}`);
}

export function parsePackageArgs(argv) {
  const value = (name) => {
    const i = argv.indexOf(name);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`package: ${name} needs a value`);
    return v;
  };
  const platform = value('--platform') ?? hostPlatform();
  if (!PLATFORMS[platform]) throw new Error(`package: --platform must be linux, mac or win`);
  const arches = (value('--arch') ?? process.arch).split(',').filter(Boolean);
  for (const arch of arches) {
    if (!ARCHES.includes(arch)) throw new Error(`package: --arch must be x64 and/or arm64`);
  }
  const targets = argv.includes('--dir')
    ? ['dir']
    : (value('--targets')?.split(',').filter(Boolean) ?? PLATFORMS[platform].defaultTargets);
  return { platform, arches, targets };
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    throw new Error(
      `package: ${command} ${args.join(' ')} failed (${result.error?.message ?? `exit ${result.status}`})`,
    );
  }
}

/**
 * npm's CLI script, run with this Node (no shell, and no `npm.cmd` on Windows, which spawn cannot
 * run without one): `<node dir>/node_modules/npm` on Windows, `<prefix>/lib/node_modules/npm` else.
 */
function npmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((file) => existsSync(file));
  if (!found) throw new Error(`package: npm not found next to ${process.execPath}`);
  return found;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** The installed (lockfile) version of a dependency of apps/desktop. */
async function installedVersion(name) {
  return (await readJson(require.resolve(`${name}/package.json`, { paths: [desktopRoot] })))
    .version;
}

async function stageApp({ platform, arch }) {
  const p = PLATFORMS[platform];
  const stage = path.join(stageRoot, `${platform}-${arch}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  const cliPkg = await readJson(path.join(repoRoot, 'apps', 'cli', 'package.json'));
  const desktopPkg = await readJson(path.join(desktopRoot, 'package.json'));
  const watcherVersion = await installedVersion('@parcel/watcher');
  const pkg = {
    name: 'octopus-diff-desktop',
    productName: 'octopus-diff',
    version: cliPkg.version,
    description: 'octopus-diff desktop app: a read-only, diff-first, multi-project git UI.',
    license: desktopPkg.license,
    author: { name: 'octopus-diff contributors', email: 'noreply@octopus-diff.invalid' },
    homepage: 'https://github.com/Segun-io/octopus-diff',
    private: true,
    type: 'module',
    main: 'dist/main.js',
    // Linux: the window's WM_CLASS / app_id, matching the .desktop file (electron-builder.yml).
    desktopName: 'octopus-diff-desktop.desktop',
    dependencies: { '@parcel/watcher': watcherVersion },
  };
  await writeFile(path.join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  const npmArgs = [
    npmCli(),
    'install',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    `--os=${p.node}`,
    `--cpu=${arch}`,
    ...(p.libc ? [`--libc=${p.libc}`] : []),
  ];
  // npm, not pnpm: electron-builder copies a flat node_modules as is (it finds npm by the lockfile).
  const npmEnv = { ...process.env };
  for (const key of Object.keys(npmEnv)) {
    if (key.startsWith('npm_') || key.startsWith('NPM_')) delete npmEnv[key];
  }
  // It also writes package-lock.json, by which electron-builder picks its npm collector.
  run(process.execPath, npmArgs, { cwd: stage, env: npmEnv });
  const nativePackage = `@parcel/watcher-${p.node}-${arch}${p.libc ? `-${p.libc}` : ''}`;
  try {
    const native = await readJson(path.join(stage, 'node_modules', nativePackage, 'package.json'));
    if (native.version !== watcherVersion) {
      throw new Error(`${nativePackage} is ${native.version}, expected ${watcherVersion}`);
    }
  } catch (error) {
    throw new Error(`package: the stage lacks ${nativePackage} (${error.message})`);
  }

  await cp(distDir, path.join(stage, 'dist'), {
    recursive: true,
    filter: (src) => !src.endsWith('.map'),
  });
  await cp(path.join(desktopRoot, 'resources'), path.join(stage, 'build'), { recursive: true });
  await cp(
    path.join(desktopRoot, 'electron-builder.yml'),
    path.join(stage, 'electron-builder.yml'),
  );
  return stage;
}

async function electronBuilder({ stage, platform, arch, targets }) {
  const { build, Platform, Arch } = require('electron-builder');
  const builderPlatform = {
    linux: Platform.LINUX,
    mac: Platform.MAC,
    win: Platform.WINDOWS,
  }[platform];
  return build({
    projectDir: stage,
    targets: builderPlatform.createTarget(targets, Arch[arch]),
    config: {
      electronVersion: await installedVersion('electron'),
      directories: { output: releaseDir, buildResources: 'build' },
    },
    publish: 'never',
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { platform, arches, targets } = parsePackageArgs(process.argv.slice(2));
    // Never sign here (phase E); also no keychain/certificate lookups on a developer's Mac.
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    await buildAll();
    const artifacts = [];
    for (const arch of arches) {
      console.log(`package: ${platform} ${arch} (${targets.join(', ')})`);
      const stage = await stageApp({ platform, arch });
      artifacts.push(...(await electronBuilder({ stage, platform, arch, targets })));
    }
    for (const file of artifacts) console.log(`package: wrote ${path.relative(repoRoot, file)}`);
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  }
}
