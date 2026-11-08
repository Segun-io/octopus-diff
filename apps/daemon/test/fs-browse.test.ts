import { chmod, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiClientError, DirsResponseSchema } from '@octopus-diff/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { listDirs } from '../src/fs-browse.js';
import { FakeGitCore } from './fake-git-core.js';
import { client, errorOf, http, startTestDaemon, tempDir } from './helpers.js';

/**
 * base/
 *   Beta/             (plain)
 *   alpha/.git/       (repo)
 *   linked/.git       (file: worktree or submodule)
 *   .hidden/
 *   notes.txt         (file: not listed)
 *   to-alpha ->alpha  (symlink to a dir)
 *   dangling ->nope   (broken symlink: not listed)
 */
async function tree(): Promise<string> {
  const base = await realpath(await tempDir());
  await mkdir(path.join(base, 'Beta'));
  await mkdir(path.join(base, 'alpha', '.git'), { recursive: true });
  await mkdir(path.join(base, 'linked'));
  await writeFile(path.join(base, 'linked', '.git'), 'gitdir: /elsewhere/.git/worktrees/linked\n');
  await mkdir(path.join(base, '.hidden'));
  await writeFile(path.join(base, 'notes.txt'), 'x');
  await symlink(path.join(base, 'alpha'), path.join(base, 'to-alpha'));
  await symlink(path.join(base, 'nope'), path.join(base, 'dangling'));
  return base;
}

describe('listDirs', () => {
  let base: string;
  beforeEach(async () => {
    base = await tree();
  });

  it('lists subdirectories only, sorted, classified by their .git entry', async () => {
    const res = DirsResponseSchema.parse(await listDirs(base, { home: base, cwd: base }));
    expect(res.path).toBe(base);
    expect(res.parent).toBe(path.dirname(base));
    expect(res.kind).toBe('dir');
    expect(res.truncated).toBe(false);
    expect(res.entries.map((e) => [e.name, e.kind, e.hidden, e.symlink])).toEqual([
      ['.hidden', 'dir', true, false],
      ['alpha', 'repo', false, false],
      ['Beta', 'dir', false, false],
      ['linked', 'gitfile', false, false],
      ['to-alpha', 'repo', false, true],
    ]);
    expect(res.entries[1]?.path).toBe(path.join(base, 'alpha'));
  });

  it('recognises a bare repository by its layout', async () => {
    const bare = path.join(base, 'bare.git');
    await mkdir(path.join(bare, 'objects'), { recursive: true });
    await mkdir(path.join(bare, 'refs'));
    await writeFile(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n');
    const half = path.join(base, 'half');
    await mkdir(half);
    await writeFile(path.join(half, 'HEAD'), 'x');
    const res = await listDirs(base, { home: base, cwd: base });
    expect(res.entries.find((e) => e.name === 'bare.git')?.kind).toBe('repo');
    expect(res.entries.find((e) => e.name === 'half')?.kind).toBe('dir');
  });

  it('reports the kind of the listed folder and hides its .git', async () => {
    const res = await listDirs(path.join(base, 'alpha'), { home: base, cwd: base });
    expect(res.kind).toBe('repo');
    expect(res.entries).toEqual([]);
  });

  it('expands ~, resolves relative paths against cwd and resolves symlinks', async () => {
    expect((await listDirs('~/Beta', { home: base, cwd: '/' })).path).toBe(path.join(base, 'Beta'));
    expect((await listDirs('Beta', { home: '/', cwd: base })).path).toBe(path.join(base, 'Beta'));
    expect((await listDirs(path.join(base, 'to-alpha'), { home: base })).path).toBe(
      path.join(base, 'alpha'),
    );
    expect((await listDirs(undefined, { home: base, cwd: base })).path).toBe(base);
  });

  it('caps the entries and says so', async () => {
    const res = await listDirs(base, { home: base, cwd: base, maxEntries: 2 });
    expect(res.entries.map((e) => e.name)).toEqual(['.hidden', 'alpha']);
    expect(res.truncated).toBe(true);
  });

  it('offers home, cwd and root as places; root has no parent', async () => {
    const res = await listDirs('/', { home: base, cwd: path.join(base, 'Beta') });
    expect(res.parent).toBeNull();
    expect(res.places).toEqual([
      { label: 'Home', path: base },
      { label: 'Daemon folder', path: path.join(base, 'Beta') },
      { label: 'Root', path: '/' },
    ]);
  });

  it('maps filesystem errors to API errors', async () => {
    await expect(listDirs(path.join(base, 'missing'))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(listDirs(path.join(base, 'notes.txt'))).rejects.toMatchObject({
      code: 'bad_request',
    });
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const locked = path.join(base, 'locked');
      await mkdir(locked, { mode: 0o000 });
      await expect(listDirs(locked)).rejects.toMatchObject({ code: 'forbidden' });
      await chmod(locked, 0o700);
    }
  });
});

describe('GET /api/fs/dirs', () => {
  it('lists through the API client and needs the token', async () => {
    const base = await tree();
    const daemon = await startTestDaemon({ fake: new FakeGitCore(), stateDir: await tempDir() });
    const res = await client(daemon).listDirs({ path: base });
    expect(res.entries.find((e) => e.name === 'alpha')?.kind).toBe('repo');

    const anonymous = await http(daemon, `/api/fs/dirs?path=${encodeURIComponent(base)}`, {
      auth: false,
    });
    expect(anonymous.status).toBe(401);

    await expect(client(daemon).listDirs({ path: path.join(base, 'missing') })).rejects.toSatisfy(
      (e: unknown) => e instanceof ApiClientError && e.status === 404,
    );

    const nul = await http(daemon, '/api/fs/dirs?path=%00');
    expect(nul.status).toBe(400);
    expect((await errorOf(nul)).code).toBe('bad_request');
  });
});
