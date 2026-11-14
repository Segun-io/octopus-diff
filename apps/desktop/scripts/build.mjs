// Builds the desktop app into dist/ (docs/DESKTOP.md §4, §7):
//
//   dist/main.js   the main process (ESM; contracts and zod inlined; `electron` external)
//   dist/preload.cjs  the preload (`src/preload.ts`, bundled to CommonJS: sandboxed preloads
//                  cannot be ESM; phase C, #20, DECISIONS #531)
//   dist/cli/      the CLI bundle (index.js, git-helper.js, web/) from apps/cli/scripts/bundle.mjs,
//                  the same step that builds the npm tarball (reused, not forked). `@parcel/watcher`
//                  resolves from apps/desktop/node_modules (a dependency of this package).
//
//   node scripts/build.mjs              everything (needs apps/web/dist: the root `pnpm build`
//                                       builds web and cli first, both are devDependencies)
//   node scripts/build.mjs --main-only  dist/main.js only (the dev loop runs the CLI from sources)
//   node scripts/build.mjs --watch      --main-only, rebuilt on change (scripts/dev.mjs)
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';
import { bundleCli } from '../../cli/scripts/bundle.mjs';

export const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const distDir = path.join(desktopRoot, 'dist');
const repoRoot = path.resolve(desktopRoot, '..', '..');

export async function mainBuildOptions() {
  const cliPkg = JSON.parse(
    await readFile(path.join(repoRoot, 'apps', 'cli', 'package.json'), 'utf8'),
  );
  return {
    entryPoints: [path.join(desktopRoot, 'src', 'main.ts')],
    outfile: path.join(distDir, 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    conditions: ['@octopus-diff/source'],
    external: ['electron'],
    // The version of the CLI bundled with the app (compared with an attached daemon's).
    define: { __OCTOPUS_CLI_VERSION__: JSON.stringify(String(cliPkg.version)) },
    sourcemap: true,
    logLevel: 'warning',
    banner: {
      js: "import { createRequire as __octopusCreateRequire } from 'node:module';\nconst require = __octopusCreateRequire(import.meta.url);",
    },
  };
}

export const preloadSource = path.join(desktopRoot, 'src', 'preload.ts');

export function preloadBuildOptions() {
  return {
    entryPoints: [preloadSource],
    outfile: path.join(distDir, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    conditions: ['@octopus-diff/source'],
    external: ['electron'],
    sourcemap: true,
    logLevel: 'warning',
  };
}

export async function buildMain() {
  await build(await mainBuildOptions());
  await build(preloadBuildOptions());
}

/** Everything `pnpm build` produces here: dist/main.js (+ preload) and dist/cli/. */
export async function buildAll() {
  await rm(distDir, { recursive: true, force: true });
  await buildMain();
  await bundleCli({ outDir: path.join(distDir, 'cli') });
}

export async function watchMain(onRebuild) {
  const options = await mainBuildOptions();
  const ctx = await context({
    ...options,
    plugins: [
      {
        name: 'notify',
        setup(b) {
          b.onEnd((result) => {
            if (result.errors.length === 0) onRebuild?.();
          });
        },
      },
    ],
  });
  await ctx.watch();
  return ctx;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mainOnly = process.argv.includes('--main-only') || process.argv.includes('--watch');
  try {
    if (process.argv.includes('--watch')) {
      await watchMain(() => console.log('desktop: dist/main.js rebuilt'));
    } else {
      if (mainOnly) await buildMain();
      else await buildAll();
      console.log(
        `desktop: wrote ${path.relative(repoRoot, distDir)}${mainOnly ? '/main.js' : ' (main.js, cli/)'}`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
