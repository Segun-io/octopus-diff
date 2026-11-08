// Builds a self-contained npm tarball of the CLI (PLAN §5.1 distribution) WITHOUT publishing it.
//
//   pnpm --filter octopus-diff run pack:tarball   →   apps/cli/.pack/octopus-diff-<version>.tgz
//
// The workspace packages (@octopus-diff/contracts, git-core, daemon) are private and never
// published, so they are bundled into one ESM file with esbuild, resolving their TypeScript
// sources through the `@octopus-diff/source` export condition. Third-party packages are bundled
// too, except native modules (`@parcel/watcher`), which stay real dependencies of the tarball.
// The built web UI (apps/web/dist) is copied to dist/web. Run `pnpm build` first.
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const outDir = path.join(packageRoot, '.pack');
const stage = path.join(outDir, 'package');

/** Runtime dependencies that cannot be bundled (native addons), with the version range to use. */
const EXTERNAL_PACKAGES = ['@parcel/watcher'];

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const cliPkg = await readJson(path.join(packageRoot, 'package.json'));
const daemonPkg = await readJson(path.join(repoRoot, 'apps', 'daemon', 'package.json'));

const webDist = path.join(repoRoot, 'apps', 'web', 'dist');
if (!(await exists(path.join(webDist, 'index.html')))) {
  console.error(`pack: ${webDist}/index.html not found; run \`pnpm build\` first`);
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(path.join(stage, 'dist'), { recursive: true });

await build({
  entryPoints: [path.join(packageRoot, 'src', 'index.ts')],
  outfile: path.join(stage, 'dist', 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  conditions: ['@octopus-diff/source'],
  external: EXTERNAL_PACKAGES,
  sourcemap: true,
  legalComments: 'linked',
  logLevel: 'warning',
  // Some bundled CommonJS code calls require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __octopusCreateRequire } from 'node:module';\nconst require = __octopusCreateRequire(import.meta.url);",
  },
});
await chmod(path.join(stage, 'dist', 'index.js'), 0o755);
await cp(webDist, path.join(stage, 'dist', 'web'), { recursive: true });

const dependencies = {};
for (const name of EXTERNAL_PACKAGES) {
  const range = daemonPkg.dependencies?.[name];
  if (!range) throw new Error(`pack: no version range for ${name} in apps/daemon/package.json`);
  dependencies[name] = range;
}

const manifest = {
  name: cliPkg.name,
  version: cliPkg.version,
  description: 'Read-only, diff-first git UI for many repositories and worktrees at once.',
  license: cliPkg.license,
  type: 'module',
  bin: { 'octopus-diff': './dist/index.js' },
  files: ['dist', 'README.md', 'LICENSE'],
  engines: cliPkg.engines,
  dependencies,
};
await writeFile(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await cp(path.join(repoRoot, 'README.md'), path.join(stage, 'README.md'));
await cp(path.join(repoRoot, 'LICENSE'), path.join(stage, 'LICENSE'));

// `npm pack` only writes a local file; it never contacts the registry.
const output = execFileSync('npm', ['pack', '--pack-destination', outDir, '--json'], {
  cwd: stage,
  encoding: 'utf8',
});
const [info] = JSON.parse(output);
console.log(
  `pack: wrote ${path.relative(repoRoot, path.join(outDir, info.filename))} (${info.size} bytes, ${info.entryCount} files)`,
);
