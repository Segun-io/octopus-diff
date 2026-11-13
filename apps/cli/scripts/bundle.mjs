// The reusable CLI bundle step (desktop phase A0, issue #17): the same files go into the npm
// tarball (`pack.mjs`) and, later, into the desktop app.
//
//   node apps/cli/scripts/bundle.mjs --out <dir>      (run `pnpm build` first, for apps/web/dist)
//
// writes, under <dir>:
//   index.js        the CLI as one ESM file (shebang, executable): contracts, git-core, forge,
//                   daemon and every third-party package inlined, resolved through the
//                   `@octopus-diff/source` export condition. Only EXTERNAL_PACKAGES stay `import`s.
//   index.js.map    its source map (and index.js.LEGAL.txt with the bundled licenses' notices)
//   git-helper.js   git-core's spawn helper (#45): a separate process entry, found next to index.js
//   web/            the built web UI (apps/web/dist); `serve` serves <index.js dir>/web
//                   (the CLI version is embedded in index.js, so <dir> needs no package.json)
//
// Whoever ships <dir> must make EXTERNAL_PACKAGES resolvable from it (`node_modules/@parcel/watcher`
// next to or above it) and run it with Node >= 24: `node <dir>/index.js serve ...`.
import { chmod, cp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(packageRoot, '..', '..');
export const webDist = path.join(repoRoot, 'apps', 'web', 'dist');

/** Runtime dependencies that cannot be bundled (native addons); the daemon's range is used. */
export const EXTERNAL_PACKAGES = ['@parcel/watcher'];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The version range of each external package, from apps/daemon/package.json: what the shipped
 * package (tarball manifest, desktop app) must depend on so the bundle can import them.
 */
export async function externalDependencies() {
  const daemonPkg = JSON.parse(
    await readFile(path.join(repoRoot, 'apps', 'daemon', 'package.json'), 'utf8'),
  );
  const dependencies = {};
  for (const name of EXTERNAL_PACKAGES) {
    const range = daemonPkg.dependencies?.[name];
    if (!range) throw new Error(`bundle: no version range for ${name} in apps/daemon/package.json`);
    dependencies[name] = range;
  }
  return dependencies;
}

/**
 * Builds the bundle into `outDir` (created; existing `index.js`, `git-helper.js` and `web` are
 * replaced, other files are left alone). Needs `apps/web/dist` (`pnpm build`).
 */
export async function bundleCli({ outDir }) {
  if (!(await exists(path.join(webDist, 'index.html')))) {
    throw new Error(`bundle: ${webDist}/index.html not found; run \`pnpm build\` first`);
  }
  await mkdir(outDir, { recursive: true });
  await rm(path.join(outDir, 'web'), { recursive: true, force: true });
  // The version travels inside the bundle: `outDir` need not have a package.json above it.
  const cliPkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));

  await build({
    entryPoints: [path.join(packageRoot, 'src', 'index.ts')],
    outfile: path.join(outDir, 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    conditions: ['@octopus-diff/source'],
    external: EXTERNAL_PACKAGES,
    define: { __OCTOPUS_CLI_VERSION__: JSON.stringify(String(cliPkg.version)) },
    sourcemap: true,
    legalComments: 'linked',
    logLevel: 'warning',
    // Some bundled CommonJS code calls require(); give the ESM bundle one.
    banner: {
      js: "import { createRequire as __octopusCreateRequire } from 'node:module';\nconst require = __octopusCreateRequire(import.meta.url);",
    },
  });
  // git-core's spawn helper (#45) runs as its own process, so it is a separate file; the bundled
  // runner finds it next to itself (`new URL('./git-helper.js', import.meta.url)`).
  await build({
    entryPoints: [path.join(repoRoot, 'packages', 'git-core', 'src', 'runner', 'git-helper.ts')],
    outfile: path.join(outDir, 'git-helper.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: true,
    logLevel: 'warning',
  });
  await chmod(path.join(outDir, 'index.js'), 0o755);
  await cp(webDist, path.join(outDir, 'web'), { recursive: true });
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = argValue('--out');
  if (!out) {
    console.error('usage: node apps/cli/scripts/bundle.mjs --out <dir>');
    process.exit(2);
  }
  try {
    await bundleCli({ outDir: path.resolve(out) });
    console.log(`bundle: wrote ${path.resolve(out)} (index.js, git-helper.js, web/)`);
    console.log(
      `bundle: external packages to install next to it: ${JSON.stringify(await externalDependencies())}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
