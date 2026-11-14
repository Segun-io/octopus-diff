import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPathRefusal } from '../src/open-safety.js';
import {
  isInside,
  relPathSegments,
  resolveWorktreeTarget,
  type TargetFs,
  type WorktreeRecord,
} from '../src/path-guard.js';

const nodeFs: TargetFs = { realpath, stat };

let dir: string;
let root: string;
let outside: string;
let worktrees: WorktreeRecord[];
const ID = '0123456789abcdef';
const SIBLING_ID = 'fedcba9876543210';

beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'octopus-diff-')));
  root = path.join(dir, 'repo');
  outside = path.join(dir, 'outside');
  await mkdir(path.join(root, 'src', 'deep'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(path.join(dir, 'repo2'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), 'hi\n');
  await writeFile(path.join(root, 'src', 'deep', 'a.ts'), 'x\n');
  await writeFile(path.join(root, 'with space #?.txt'), 'x\n');
  await writeFile(path.join(outside, 'secret.txt'), 'secret\n');
  await writeFile(path.join(dir, 'repo2', 'b.txt'), 'b\n');
  // Escapes: a file link, a directory link, a relative link, and a link to the sibling with a
  // shared name prefix (`repo` vs `repo2`).
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link-file'));
  await symlink(outside, path.join(root, 'link-dir'));
  await symlink('../../outside/secret.txt', path.join(root, 'src', 'rel-link'));
  await symlink(path.join(dir, 'repo2'), path.join(root, 'link-sibling'));
  // Allowed: a link that stays inside.
  await symlink(path.join(root, 'README.md'), path.join(root, 'src', 'inside-link'));
  await writeFile(path.join(root, 'run.sh'), '#!/bin/sh\n');
  await chmod(path.join(root, 'run.sh'), 0o755);
  worktrees = [
    { id: ID, path: root, missing: false, bare: false },
    { id: SIBLING_ID, path: path.join(dir, 'repo2'), missing: false, bare: false },
    { id: 'aaaaaaaaaaaaaaaa', path: path.join(dir, 'gone'), missing: true, bare: false },
    { id: 'bbbbbbbbbbbbbbbb', path: path.join(dir, 'gone-unflagged'), missing: false, bare: false },
  ];
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const resolve = (worktreeId: string, relPath?: string) =>
  resolveWorktreeTarget({ worktreeId, relPath, worktrees, platform: 'linux', fs: nodeFs });

describe('resolveWorktreeTarget (the path check)', () => {
  it('resolves a file, a nested file, a directory and the worktree root', async () => {
    expect(await resolve(ID, 'README.md')).toMatchObject({
      ok: true,
      path: path.join(root, 'README.md'),
      root,
      kind: 'file',
    });
    expect(await resolve(ID, 'src/deep/a.ts')).toMatchObject({
      ok: true,
      path: path.join(root, 'src', 'deep', 'a.ts'),
    });
    expect(await resolve(ID, 'src')).toMatchObject({ ok: true, kind: 'directory' });
    expect(await resolve(ID)).toMatchObject({ ok: true, path: root, kind: 'directory' });
    expect(await resolve(ID, 'with space #?.txt')).toMatchObject({ ok: true });
  });

  it('follows a symlink that stays inside the worktree to its target', async () => {
    expect(await resolve(ID, 'src/inside-link')).toMatchObject({
      ok: true,
      path: path.join(root, 'README.md'),
    });
  });

  it('refuses symlinks that escape the worktree (file, directory, relative, sibling prefix)', async () => {
    for (const rel of [
      'link-file',
      'link-dir',
      'link-dir/secret.txt',
      'src/rel-link',
      'link-sibling',
      'link-sibling/b.txt',
    ]) {
      expect(await resolve(ID, rel), rel).toMatchObject({ ok: false, reason: 'outside-worktree' });
    }
  });

  it('refuses traversal and absolute paths before touching the disk', async () => {
    for (const rel of [
      '../outside/secret.txt',
      'src/../../outside/secret.txt',
      '..',
      '.',
      'src/./a',
      '/etc/passwd',
      `${outside}/secret.txt`,
      'src//a.ts',
      'src/',
      '',
      'a\u0000b',
    ]) {
      expect(await resolve(ID, rel), JSON.stringify(rel)).toMatchObject({
        ok: false,
        reason: 'invalid',
      });
    }
  });

  it('refuses unknown, missing and vanished worktrees, and paths that do not exist', async () => {
    expect(await resolve('ffffffffffffffff', 'README.md')).toMatchObject({
      ok: false,
      reason: 'unknown-worktree',
    });
    expect(await resolve('aaaaaaaaaaaaaaaa')).toMatchObject({
      ok: false,
      reason: 'missing-worktree',
    });
    expect(await resolve('bbbbbbbbbbbbbbbb')).toMatchObject({
      ok: false,
      reason: 'missing-worktree',
    });
    expect(await resolve(ID, 'nope.txt')).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('refuses a worktree the daemon reports missing even if its path exists', async () => {
    const result = await resolveWorktreeTarget({
      worktreeId: ID,
      relPath: 'README.md',
      worktrees: [{ id: ID, path: root, missing: true, bare: false }],
      platform: 'linux',
      fs: nodeFs,
    });
    expect(result).toMatchObject({ ok: false, reason: 'missing-worktree' });
  });

  it('says not-ready when the daemon could not be asked', async () => {
    expect(
      await resolveWorktreeTarget({
        worktreeId: ID,
        relPath: 'README.md',
        worktrees: null,
        platform: 'linux',
        fs: nodeFs,
      }),
    ).toMatchObject({ ok: false, reason: 'not-ready' });
  });

  it('checks the realpath of the root too (a worktree reached through a link)', async () => {
    const linked = path.join(dir, 'repo-link');
    await symlink(root, linked);
    const result = await resolveWorktreeTarget({
      worktreeId: ID,
      relPath: 'README.md',
      worktrees: [{ id: ID, path: linked, missing: false, bare: false }],
      platform: 'linux',
      fs: nodeFs,
    });
    expect(result).toMatchObject({ ok: true, path: path.join(root, 'README.md'), root });
  });

  it('refuses a Windows path that a drive, a backslash or a stream could redirect', async () => {
    const fake: TargetFs = {
      realpath: async (p) => p,
      stat: async () => ({ isDirectory: () => false, isFile: () => true, mode: 0o644 }),
    };
    const win: WorktreeRecord[] = [{ id: ID, path: 'C:\\code\\repo', missing: false, bare: false }];
    const run = (relPath: string) =>
      resolveWorktreeTarget({
        worktreeId: ID,
        relPath,
        worktrees: win,
        platform: 'win32',
        fs: fake,
      });
    expect(await run('src/a.ts')).toMatchObject({ ok: true, path: 'C:\\code\\repo\\src\\a.ts' });
    for (const rel of ['D:x', 'src\\..\\..\\x', 'a.txt:stream', '.. ', 'src/. ', 'C:/x']) {
      expect(await run(rel), rel).toMatchObject({ ok: false, reason: 'invalid' });
    }
  });

  it('refuses a Windows realpath on another drive or above the root', async () => {
    const win: WorktreeRecord[] = [{ id: ID, path: 'C:\\code\\repo', missing: false, bare: false }];
    for (const target of ['D:\\code\\repo\\a.txt', 'C:\\code\\repo2\\a.txt', 'C:\\code']) {
      const fake: TargetFs = {
        realpath: async (p) => (p === 'C:\\code\\repo' ? p : target),
        stat: async () => ({ isDirectory: () => false, isFile: () => true, mode: 0o644 }),
      };
      const result = await resolveWorktreeTarget({
        worktreeId: ID,
        relPath: 'a.txt',
        worktrees: win,
        platform: 'win32',
        fs: fake,
      });
      expect(result, target).toMatchObject({ ok: false, reason: 'outside-worktree' });
    }
  });
});

describe('relPathSegments / isInside', () => {
  it('splits a repo-relative path and refuses anything that could leave the root', () => {
    expect(relPathSegments(undefined, 'linux')).toEqual([]);
    expect(relPathSegments('a/b c/d', 'linux')).toEqual(['a', 'b c', 'd']);
    expect(relPathSegments('a\\b', 'linux')).toEqual(['a\\b']); // a legal POSIX file name
    expect(relPathSegments('a\\b', 'win32')).toBeNull();
    expect(relPathSegments('a/../b', 'linux')).toBeNull();
    expect(relPathSegments('/a', 'linux')).toBeNull();
  });

  it('isInside compares whole segments, not string prefixes', () => {
    expect(isInside('/x/repo', '/x/repo', 'linux')).toBe(true);
    expect(isInside('/x/repo', '/x/repo/a', 'linux')).toBe(true);
    expect(isInside('/x/repo', '/x/repo/..a', 'linux')).toBe(true);
    expect(isInside('/x/repo', '/x/repo2/a', 'linux')).toBe(false);
    expect(isInside('/x/repo', '/x', 'linux')).toBe(false);
    expect(isInside('/x/repo', '/etc/passwd', 'linux')).toBe(false);
    expect(isInside('C:\\repo', 'D:\\repo\\a', 'win32')).toBe(false);
    expect(isInside('C:\\repo', 'C:\\repo\\a', 'win32')).toBe(true);
  });
});

describe('openPathRefusal (openPath never runs a program)', () => {
  const file = (p: string, mode = 0o644) => ({ path: p, root: '/r', kind: 'file' as const, mode });
  const folder = (p: string) => ({ path: p, root: '/r', kind: 'directory' as const, mode: 0o755 });

  it('allows documents, images and plain folders', () => {
    for (const p of ['/r/a.png', '/r/doc.pdf', '/r/README.md', '/r/notes']) {
      expect(openPathRefusal(file(p), 'linux'), p).toBeNull();
    }
    expect(openPathRefusal(folder('/r/src'), 'darwin')).toBeNull();
  });

  it('refuses executables and scripts by type on every platform', () => {
    for (const p of [
      '/r/a.exe',
      '/r/A.EXE',
      '/r/setup.msi',
      '/r/x.bat',
      '/r/x.cmd',
      '/r/x.ps1',
      '/r/x.vbs',
      '/r/x.js',
      '/r/x.lnk',
      '/r/x.url',
      '/r/x.jar',
      '/r/x.sh',
      '/r/x.py',
      '/r/x.command',
      '/r/x.desktop',
      '/r/x.AppImage',
      '/r/x.scpt',
      '/r/x.fileloc',
      '/r/x.reg',
    ]) {
      for (const platform of ['linux', 'darwin', 'win32'] as const) {
        expect(openPathRefusal(file(p), platform), `${platform} ${p}`).toMatchObject({
          ok: false,
          reason: 'unsafe-file',
        });
      }
    }
  });

  it('refuses Windows names that the OS trims to an executable type', () => {
    for (const p of ['C:\\r\\a.exe.', 'C:\\r\\a.exe ', 'C:\\r\\a.bat. .']) {
      expect(openPathRefusal(file(p), 'win32'), p).toMatchObject({ reason: 'unsafe-file' });
    }
  });

  it('refuses app bundles (a folder that launches) and files with an execute bit', () => {
    expect(openPathRefusal(folder('/r/Evil.app'), 'darwin')).toMatchObject({
      reason: 'unsafe-file',
    });
    expect(openPathRefusal(file('/r/tool', 0o755), 'linux')).toMatchObject({
      reason: 'unsafe-file',
    });
    expect(openPathRefusal(file('/r/tool', 0o744), 'darwin')).toMatchObject({
      reason: 'unsafe-file',
    });
    // Windows has no execute bit (stat reports 0o666 / 0o444 style modes).
    expect(openPathRefusal(file('C:\\r\\notes', 0o777), 'win32')).toBeNull();
  });

  it('refuses things that are neither a file nor a folder (sockets, devices)', () => {
    expect(
      openPathRefusal({ path: '/r/sock', root: '/r', kind: 'other', mode: 0 }, 'linux'),
    ).toMatchObject({ reason: 'unsafe-file' });
  });

  it('works with the real file from the temp worktree', async () => {
    const result = await resolve(ID, 'run.sh');
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(openPathRefusal(result, 'linux')).toMatchObject({ reason: 'unsafe-file' });
  });
});
