// Copies the built web UI (apps/web/dist) into dist/web so the CLI package carries its own UI.
// Runs after `tsc` in `pnpm build`. `@octopus-diff/web` is a devDependency of this package, so
// `pnpm -r build` builds the web app first. If the web build is missing (e.g. only the CLI was
// built), this warns and exits 0: in the workspace the CLI serves apps/web/dist directly anyway.
import { cp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(packageRoot, '..', 'web', 'dist');
const target = path.join(packageRoot, 'dist', 'web');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

await rm(target, { recursive: true, force: true });
if (!(await exists(path.join(source, 'index.html')))) {
  console.warn(`copy-web-assets: ${source}/index.html not found; skipping (build apps/web first)`);
} else {
  await cp(source, target, { recursive: true });
  console.log(`copy-web-assets: copied ${path.relative(packageRoot, source)} -> dist/web`);
}
