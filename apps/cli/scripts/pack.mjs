// Builds a self-contained npm tarball of the CLI (PLAN §5.1 distribution) WITHOUT publishing it.
//
//   pnpm --filter octopus-diff run pack:tarball   →   apps/cli/.pack/octopus-diff-<version>.tgz
//
// The bundle itself (dist/index.js, dist/git-helper.js, dist/web) comes from `bundle.mjs`, the
// step the desktop app reuses; this script adds the package manifest and the docs and runs
// `npm pack`. The workspace packages (@octopus-diff/contracts, git-core, daemon) are private and
// never published, so the bundle inlines them; native modules (`@parcel/watcher`) stay real
// dependencies of the tarball. Run `pnpm build` first.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bundleCli, externalDependencies, packageRoot, repoRoot } from './bundle.mjs';

const outDir = path.join(packageRoot, '.pack');
const stage = path.join(outDir, 'package');

const cliPkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));

await rm(outDir, { recursive: true, force: true });
await mkdir(path.join(stage, 'dist'), { recursive: true });
try {
  await bundleCli({ outDir: path.join(stage, 'dist') });
} catch (error) {
  console.error(
    String(error instanceof Error ? error.message : error).replace(/^bundle:/, 'pack:'),
  );
  process.exit(1);
}

const dependencies = await externalDependencies();

const manifest = {
  name: cliPkg.name,
  version: cliPkg.version,
  description: 'Read-only, diff-first git UI for many repositories and worktrees at once.',
  license: cliPkg.license,
  type: 'module',
  bin: { 'octopus-diff': './dist/index.js' },
  files: ['dist', 'README.md', 'LICENSE', 'CREDITS.md'],
  engines: cliPkg.engines,
  dependencies,
};
await writeFile(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await cp(path.join(repoRoot, 'README.md'), path.join(stage, 'README.md'));
await cp(path.join(repoRoot, 'LICENSE'), path.join(stage, 'LICENSE'));
await cp(path.join(repoRoot, 'CREDITS.md'), path.join(stage, 'CREDITS.md'));

// `npm pack` only writes a local file; it never contacts the registry.
const output = execFileSync('npm', ['pack', '--pack-destination', outDir, '--json'], {
  cwd: stage,
  encoding: 'utf8',
});
const [info] = JSON.parse(output);
console.log(
  `pack: wrote ${path.relative(repoRoot, path.join(outDir, info.filename))} (${info.size} bytes, ${info.entryCount} files)`,
);
