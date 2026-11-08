import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTextSync } from '../src/platform.js';
import { resolveWebRoot, webRootCandidates } from '../src/web-assets.js';
import { makeTempDirs, type TempDirs } from './helpers.js';

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(async () => {
  await dirs.cleanup();
});

/** Lays out `<root>/<parent>/cli/dist/web-assets.js` plus a sibling `web` package. */
async function layout(
  webPackageName: string | null,
): Promise<{ moduleUrl: string; cli: string; web: string }> {
  const parent = path.join(dirs.root, 'apps');
  const cli = path.join(parent, 'cli');
  const web = path.join(parent, 'web');
  await mkdir(path.join(cli, 'dist'), { recursive: true });
  if (webPackageName !== null) {
    await mkdir(web, { recursive: true });
    await writeFile(path.join(web, 'package.json'), JSON.stringify({ name: webPackageName }));
  }
  return { moduleUrl: pathToFileURL(path.join(cli, 'dist', 'web-assets.js')).href, cli, web };
}

describe('webRootCandidates', () => {
  it('prefers apps/web/dist inside the octopus-diff workspace', async () => {
    const { moduleUrl, cli, web } = await layout('@octopus-diff/web');
    expect(webRootCandidates(moduleUrl, readTextSync)).toEqual([
      path.join(web, 'dist'),
      path.join(cli, 'dist', 'web'),
    ]);
  });

  it('never looks at an unrelated sibling "web" package (installed in node_modules)', async () => {
    const { moduleUrl, cli } = await layout('web');
    expect(webRootCandidates(moduleUrl, readTextSync)).toEqual([path.join(cli, 'dist', 'web')]);
    const none = await layout(null);
    expect(webRootCandidates(none.moduleUrl, readTextSync)).toEqual([
      path.join(none.cli, 'dist', 'web'),
    ]);
  });

  it('finds the real workspace from the source tree', () => {
    const candidates = webRootCandidates();
    expect(candidates[0]).toMatch(/apps[/\\]web[/\\]dist$/);
  });
});

describe('resolveWebRoot', () => {
  it('returns the first candidate with an index.html', async () => {
    const a = path.join(dirs.root, 'a');
    const b = path.join(dirs.root, 'b');
    await mkdir(b);
    await writeFile(path.join(b, 'index.html'), '');
    expect(resolveWebRoot(undefined, [a, b])).toEqual({ kind: 'found', dir: b, explicit: false });
    expect(resolveWebRoot(undefined, [a])).toEqual({
      kind: 'missing',
      explicit: false,
      searched: [a],
    });
    expect(resolveWebRoot(a, [b])).toEqual({ kind: 'missing', explicit: true, dir: a });
    expect(resolveWebRoot(b, [])).toEqual({ kind: 'found', dir: b, explicit: true });
  });
});
