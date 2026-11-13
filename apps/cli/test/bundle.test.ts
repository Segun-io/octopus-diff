/**
 * The standalone bundle (`scripts/bundle.mjs --out <dir>`, desktop phase A0): written somewhere
 * with no package.json above it, it must still serve its UI and report the CLI version (PR #106).
 * Skipped when the web UI has not been built (`pnpm build`).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ServeReadySchema } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webIndex = path.resolve(cliRoot, '..', 'web', 'dist', 'index.html');

describe.skipIf(!existsSync(webIndex))('standalone CLI bundle', () => {
  let root: string;
  let out: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'octopus-diff-bundle-'));
    out = path.join(root, 'cli');
    const { bundleCli } = (await import(
      pathToFileURL(path.join(cliRoot, 'scripts', 'bundle.mjs')).href
    )) as { bundleCli: (options: { outDir: string }) => Promise<void> };
    await bundleCli({ outDir: out });
    // The one external package, resolvable from the bundle as a shipped app would have it.
    const daemonRequire = createRequire(path.join(cliRoot, '..', 'daemon', 'package.json'));
    const watcher = await realpath(
      path.dirname(daemonRequire.resolve('@parcel/watcher/package.json')),
    );
    await mkdir(path.join(out, 'node_modules', '@parcel'), { recursive: true });
    await symlink(watcher, path.join(out, 'node_modules', '@parcel', 'watcher'), 'junction');
  }, 120_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('serves its UI from next to index.js and reports the CLI version', async () => {
    const cliVersion = (
      JSON.parse(await readFile(path.join(cliRoot, 'package.json'), 'utf8')) as { version: string }
    ).version;
    const child = spawn(
      process.execPath,
      [
        path.join(out, 'index.js'),
        'serve',
        '--port',
        '0',
        '--no-watch',
        '--no-open',
        '--ready-fd',
        '3',
        '--state-dir',
        path.join(root, 'state'),
        '--config-dir',
        path.join(root, 'config'),
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME: root, USERPROFILE: root },
        windowsHide: true,
      },
    );
    let err = '';
    child.stderr?.on('data', (c: Buffer) => {
      err += c.toString();
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      const fd3 = child.stdio[3] as NodeJS.ReadableStream;
      const line = await new Promise<string>((resolve, reject) => {
        let text = '';
        fd3.on('data', (c: Buffer) => {
          text += c.toString();
        });
        fd3.on('end', () => resolve(text));
        fd3.on('error', reject);
        setTimeout(() => reject(new Error(`no ready line\n${err}`)), 30_000).unref();
      });
      const ready = ServeReadySchema.parse(JSON.parse(line));
      expect(ready.version).toBe(cliVersion);
      const page = await fetch(ready.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<div id="root"');
    } finally {
      child.stdin?.end(); // no --exit-with-stdin here: stop it the plain way
      child.kill();
      await exited;
    }
  }, 60_000);
});
