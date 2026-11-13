/**
 * The file explorer (#9): `GET /api/worktrees/:id/tree` against real repositories.
 *
 * - **Differential.** The working view of every directory (walked through the route, in small
 *   pages) is compared with what git itself says: `git ls-tree -r HEAD` for what is tracked,
 *   `git status --porcelain=v1 -z -uall` for every change, `--ignored` for what must never be
 *   listed. Shapes: modified, staged, both, deleted (whole and partial directories), staged rename,
 *   untracked directories, staged additions, ignored files and directories, tracked files matching
 *   an ignore rule, symlinks (to a directory, outside the repo, retargeted, untracked), type and
 *   mode changes, a submodule with a moved commit, names that are not UTF-8, names differing only
 *   in case, conflicts, and a sparse checkout.
 * - **Paging.** Random page sizes with refreshes mid-paging always add up to the full listing.
 * - **Security.** Traversal, option-like refs and paths, symlinked directories; the tree view never
 *   reads the working copy.
 * - **Warm.** A repeat listing spawns no git process.
 * - **Deltas.** `worktree.changed.dirs` names the directories whose listing moved.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type ApiClient,
  type ServerEventOf,
  type TreeEntry,
  TreeResponseSchema,
} from '@octopus-diff/contracts';
import { createGitCore } from '@octopus-diff/git-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Daemon, startDaemon } from '../src/daemon.js';
import { hashId } from '../src/ids.js';
import {
  client,
  errorOf,
  eventually,
  http,
  onCleanup,
  recordEvents,
  TEST_TOKEN,
  tempDir,
} from './helpers.js';
import {
  makeRealGitFixture,
  makeRealRepo,
  type RealGitFixture,
  startRealGitDaemon,
} from './real-git-fixture.js';

type Changed = ServerEventOf<'worktree.changed'>;

/** Linux file systems take any bytes in a name; APFS refuses names that are not UTF-8. */
const RAW_NAMES = (() => {
  const dir = execFileSync('mktemp', ['-d']).toString().trim();
  try {
    writeFileSync(Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0x78, 0xff])]), '');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

/** Whether the temp dir folds case (macOS, Windows): `Case.txt` and `case.txt` collide. */
const FOLDS = (() => {
  const dir = execFileSync('mktemp', ['-d']).toString().trim();
  try {
    writeFileSync(path.join(dir, 'A'), '');
    try {
      readFileSync(path.join(dir, 'a'));
      return true;
    } catch {
      return process.env.OCTOPUS_DIFF_TEST_FOLDS_CASE === '1';
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

function gitBuf(fx: RealGitFixture, cwd: string, ...args: string[]): Buffer {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('GIT_')) env[k] = v;
  }
  return execFileSync('git', args, {
    cwd,
    env: { ...env, ...fx.env, LC_ALL: 'C' },
    maxBuffer: 1 << 28,
  });
}

/** NUL-separated records as byte strings (latin1). */
function records(out: Buffer): string[] {
  return out.toString('latin1').split('\u0000').filter(Boolean);
}

/** An entry's path as raw bytes (latin1). */
function keyOf(e: Pick<TreeEntry, 'path' | 'rawPath'>): string {
  return (
    e.rawPath !== undefined ? Buffer.from(e.rawPath, 'base64') : Buffer.from(e.path, 'utf8')
  ).toString('latin1');
}

type Category = 'untracked' | 'deleted' | 'conflicted' | 'changed';

const CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** What `git status` says about every changed path (bytes → category), and what it ignores. */
function gitView(fx: RealGitFixture, repo: string) {
  const status = records(gitBuf(fx, repo, 'status', '--porcelain=v1', '-z', '-uall'));
  const expected = new Map<string, Category>();
  /** Status records below each path (a rename counts its two paths). */
  const changed: string[] = [];
  for (let i = 0; i < status.length; i++) {
    const rec = status[i] as string;
    const xy = rec.slice(0, 2);
    const p = rec.slice(3);
    if (xy === '??') expected.set(p, 'untracked');
    else if (CONFLICTS.has(xy)) expected.set(p, 'conflicted');
    else if (xy[0] === 'R') {
      const old = status[++i] as string;
      expected.set(p, xy[1] === 'D' ? 'deleted' : 'changed');
      expected.set(old, 'deleted');
      changed.push(old);
    } else if (xy.includes('D')) expected.set(p, 'deleted');
    else expected.set(p, 'changed');
    changed.push(p);
  }
  const ignored = records(gitBuf(fx, repo, 'status', '--porcelain=v1', '-z', '--ignored', '-uall'))
    .filter((r) => r.startsWith('!! '))
    .map((r) => r.slice(3).replace(/\/$/, ''));
  const headFiles = new Set(
    records(gitBuf(fx, repo, 'ls-tree', '-r', '-z', '--name-only', 'HEAD')),
  );
  const headDirs = new Set(
    records(gitBuf(fx, repo, 'ls-tree', '-r', '-t', '-z', 'HEAD'))
      .filter((r) => r.split(' ')[1] === 'tree')
      .map((r) => r.slice(r.indexOf('\t') + 1)),
  );
  return { expected, changed, ignored, headFiles, headDirs };
}

function category(entry: TreeEntry): Category | 'unchanged' {
  switch (entry.status) {
    case undefined:
      return 'unchanged';
    case 'untracked':
    case 'deleted':
    case 'conflicted':
      return entry.status;
    default:
      return 'changed';
  }
}

/** Every entry of the working view (or `ref`'s tree), walked directory by directory in pages. */
async function walk(
  api: ApiClient,
  worktreeId: string,
  options: { limit?: number; ref?: string } = {},
): Promise<Map<string, TreeEntry>> {
  const out = new Map<string, TreeEntry>();
  const queue: Array<{ path: string; rawPath?: string }> = [{ path: '' }];
  while (queue.length > 0) {
    const dir = queue.shift() as { path: string; rawPath?: string };
    let cursor: string | undefined;
    let offset = 0;
    for (;;) {
      const page = await api.getTree(worktreeId, {
        ...dir,
        ...(options.ref ? { ref: options.ref } : {}),
        ...(options.limit ? { limit: options.limit } : {}),
        ...(cursor ? { cursor } : {}),
      });
      TreeResponseSchema.parse(page);
      expect(page.restarted).toBe(false);
      expect(page.offset).toBe(offset);
      offset += page.entries.length;
      for (const e of page.entries) {
        expect(out.has(keyOf(e)), `listed twice: ${e.path}`).toBe(false);
        out.set(keyOf(e), e);
        if (e.kind === 'dir') {
          queue.push(
            e.rawPath !== undefined ? { path: e.path, rawPath: e.rawPath } : { path: e.path },
          );
        }
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
  }
  return out;
}

function ancestors(key: string): string[] {
  const out: string[] = [];
  for (let at = key.lastIndexOf('/'); at > 0; at = key.lastIndexOf('/', at - 1)) {
    out.push(key.slice(0, at));
  }
  return out;
}

/** The differential check of one worktree's working view against git. */
async function expectMatchesGit(fx: RealGitFixture, repo: string, api: ApiClient, limit: number) {
  const id = hashId(repo);
  await api.refreshWorktree(id);
  const listed = await walk(api, id, { limit });
  const git = gitView(fx, repo);

  // Files: everything tracked, plus every new path that exists; nothing else.
  const expectedFiles = new Set(git.headFiles);
  for (const [p, c] of git.expected) if (c !== 'deleted') expectedFiles.add(p);
  const listedFiles = new Set([...listed].filter(([, e]) => e.kind !== 'dir').map(([k]) => k));
  expect([...listedFiles].sort()).toEqual([...expectedFiles].sort());
  for (const key of listedFiles) {
    const entry = listed.get(key) as TreeEntry;
    expect(category(entry), `${entry.path} (${entry.status})`).toBe(
      git.expected.get(key) ?? 'unchanged',
    );
    if (git.headFiles.has(key)) expect(entry.oid, entry.path).not.toBeNull();
  }

  // Directories: HEAD's, plus those holding a new path that exists.
  const expectedDirs = new Set(git.headDirs);
  for (const p of expectedFiles) for (const a of ancestors(p)) expectedDirs.add(a);
  const listedDirs = new Set([...listed].filter(([, e]) => e.kind === 'dir').map(([k]) => k));
  expect([...listedDirs].sort()).toEqual([...expectedDirs].sort());
  for (const key of listedDirs) {
    const entry = listed.get(key) as TreeEntry;
    const below = git.changed.filter((p) => p.startsWith(`${key}/`));
    expect(entry.changes ?? 0, `changes below ${entry.path}`).toBe(below.length);
    const live = [...expectedFiles].filter(
      (p) => p.startsWith(`${key}/`) && git.expected.get(p) !== 'deleted',
    );
    const tracked = [...git.headFiles].filter((p) => p.startsWith(`${key}/`));
    let status: string | undefined;
    if (!git.headDirs.has(key)) {
      const allUntracked = below.every((p) => git.expected.get(p) === 'untracked');
      status = allUntracked ? 'untracked' : 'added';
    } else if (live.length === 0 && tracked.length > 0) status = 'deleted';
    expect(entry.status, `status of ${entry.path}`).toBe(status);
  }

  // Ignored paths never appear, at any depth.
  for (const p of git.ignored) {
    expect(listed.has(p), `ignored ${p} listed`).toBe(git.headFiles.has(p));
    for (const key of listed.keys()) {
      if (!git.headFiles.has(key))
        expect(key.startsWith(`${p}/`), `${key} under ignored ${p}`).toBe(false);
    }
  }
  return listed;
}

let fx: RealGitFixture;
let daemon: Daemon;
let api: ApiClient;

// Cleanups run after each test (helpers.ts): every test gets its own fixture and daemon.
beforeEach(async () => {
  fx = await makeRealGitFixture();
  daemon = await startRealGitDaemon(fx, await tempDir());
  api = client(daemon);
});

describe('GET /tree working view vs git status (differential)', () => {
  it('matches git for many shapes', async () => {
    const files: Record<string, string> = {
      '.gitignore': 'build/\n*.log\n',
      'keep.log': 'tracked although ignored\n',
      'tc.txt': 'becomes a symlink\n',
      'run.sh': '#!/bin/sh\n',
      'Case.txt': 'upper\n',
    };
    for (const d of ['src', 'old', 'part', 'ren', 'docs/deep/er', 'dir with space']) {
      mkdirSync(path.join(fx.root, 'shapes', d), { recursive: true });
    }
    Object.assign(files, {
      'src/a.ts': 'a\n',
      'src/b.ts': 'b\n',
      'src/c.ts': 'c\n',
      'src/keep.ts': 'k\n',
      'old/x.txt': 'x\n',
      'old/y.txt': 'y\n',
      'part/p1.txt': '1\n',
      'part/p2.txt': '2\n',
      'ren/from.txt': 'rename me, a few lines\nso the similarity holds\n',
      'docs/deep/er/doc.md': 'doc\n',
      'dir with space/ü.txt': 'unicode\n',
    });
    const repo = await makeRealRepo(fx, 'shapes', files);
    fx.git(repo, 'add', '-f', 'keep.log');
    fx.git(repo, 'commit', '-q', '-m', 'keep');
    symlinkSync('src', path.join(repo, 'link-dir'));
    symlinkSync('src/a.ts', path.join(repo, 'link-file'));
    fx.git(repo, 'add', 'link-dir', 'link-file');
    fx.git(repo, 'commit', '-q', '-m', 'links');
    // A submodule whose commit then moves.
    const lib = await makeRealRepo(fx, 'lib', { 'lib.txt': 'lib\n' });
    fx.git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib');
    fx.git(repo, 'commit', '-q', '-m', 'submodule');
    if (RAW_NAMES) {
      writeFileSync(
        Buffer.concat([Buffer.from(`${repo}/src/`), Buffer.from([0x74, 0xfe, 0x2e, 0x74])]),
        't\n',
      );
      fx.git(repo, 'add', '-A');
      fx.git(repo, 'commit', '-q', '-m', 'raw');
    }

    // The changes.
    writeFileSync(path.join(repo, 'src/a.ts'), 'a changed\n');
    writeFileSync(path.join(repo, 'src/b.ts'), 'b staged\n');
    fx.git(repo, 'add', 'src/b.ts');
    writeFileSync(path.join(repo, 'src/c.ts'), 'c staged\n');
    fx.git(repo, 'add', 'src/c.ts');
    writeFileSync(path.join(repo, 'src/c.ts'), 'c staged and more\n');
    rmSync(path.join(repo, 'old/x.txt'));
    fx.git(repo, 'rm', '-q', 'old/y.txt');
    rmSync(path.join(repo, 'part/p1.txt'));
    mkdirSync(path.join(repo, 'ren2'));
    fx.git(repo, 'mv', 'ren/from.txt', 'ren2/to.txt');
    mkdirSync(path.join(repo, 'newdir/deep'), { recursive: true });
    writeFileSync(path.join(repo, 'newdir/deep/u.txt'), 'u\n');
    writeFileSync(path.join(repo, 'newdir/u2.txt'), 'u2\n');
    writeFileSync(path.join(repo, 'src/u3.ts'), 'u3\n');
    mkdirSync(path.join(repo, 'added'));
    writeFileSync(path.join(repo, 'added/a.txt'), 'staged new\n');
    fx.git(repo, 'add', 'added/a.txt');
    mkdirSync(path.join(repo, 'mix'));
    writeFileSync(path.join(repo, 'mix/a.txt'), 'staged\n');
    fx.git(repo, 'add', 'mix/a.txt');
    writeFileSync(path.join(repo, 'mix/b.txt'), 'untracked\n');
    mkdirSync(path.join(repo, 'build/sub'), { recursive: true });
    writeFileSync(path.join(repo, 'build/sub/out.js'), 'ignored\n');
    writeFileSync(path.join(repo, 'src/debug.log'), 'ignored\n');
    writeFileSync(path.join(repo, 'keep.log'), 'tracked, ignored, modified\n');
    rmSync(path.join(repo, 'link-file'));
    symlinkSync('src/b.ts', path.join(repo, 'link-file'));
    symlinkSync('/', path.join(repo, 'link-out'));
    rmSync(path.join(repo, 'tc.txt'));
    symlinkSync('src/a.ts', path.join(repo, 'tc.txt'));
    chmodSync(path.join(repo, 'run.sh'), 0o755);
    writeFileSync(path.join(repo, 'dir with space/ü.txt'), 'unicode changed\n');
    writeFileSync(path.join(lib, 'lib.txt'), 'moved\n');
    const sub = path.join(repo, 'vendor/lib');
    writeFileSync(path.join(sub, 'lib.txt'), 'moved\n');
    fx.git(sub, 'commit', '-q', '-am', 'move the submodule');
    if (RAW_NAMES) {
      writeFileSync(
        Buffer.concat([Buffer.from(`${repo}/newdir/`), Buffer.from([0x75, 0xff])]),
        'raw\n',
      );
      writeFileSync(
        Buffer.concat([Buffer.from(`${repo}/src/`), Buffer.from([0x74, 0xfe, 0x2e, 0x74])]),
        't2\n',
      );
    }
    if (!FOLDS) writeFileSync(path.join(repo, 'case.txt'), 'lower, untracked\n');

    await api.addProject({ path: repo });
    for (const limit of [2, 7, 1000]) {
      const listed = await expectMatchesGit(fx, repo, api, limit);
      // The rename's source points at its target; symlinks are not entered.
      expect(listed.get('ren/from.txt')).toMatchObject({
        status: 'deleted',
        renamedTo: 'ren2/to.txt',
      });
      expect(listed.get('ren2/to.txt')).toMatchObject({
        status: 'renamed',
        oldPath: 'ren/from.txt',
      });
      expect(listed.get('link-dir')?.kind).toBe('symlink');
      expect(listed.get('link-out')).toMatchObject({ status: 'untracked' });
      expect(listed.get('vendor/lib')).toMatchObject({ kind: 'submodule', status: 'modified' });
      expect(
        [...listed.keys()].some((k) => k.startsWith('link-dir/') || k.startsWith('link-out/')),
      ).toBe(false);
      expect(listed.get('old')?.status).toBe('deleted');
      expect(listed.get('part')?.status).toBeUndefined();
      expect(listed.get('newdir')).toMatchObject({
        status: 'untracked',
        changes: RAW_NAMES ? 3 : 2,
      });
      expect(listed.get('added')?.status).toBe('added');
      expect(listed.get('mix')?.status).toBe('added');
      expect(listed.has('build')).toBe(false);
      if (RAW_NAMES) {
        const raw = Buffer.from([0x74, 0xfe, 0x2e, 0x74]).toString('latin1');
        expect(listed.get(`src/${raw}`)).toMatchObject({
          status: 'modified',
          rawName: expect.any(String),
        });
      }
      if (!FOLDS) {
        expect(listed.get('Case.txt')?.status).toBeUndefined();
        expect(listed.get('case.txt')?.status).toBe('untracked');
      }
    }
  });

  it('matches git during a merge conflict', async () => {
    const repo = await makeRealRepo(fx, 'conflict', {
      'c.txt': 'base\n',
      'gone.txt': 'g\n',
      'k.txt': 'k\n',
    });
    fx.git(repo, 'switch', '-q', '-c', 'other');
    writeFileSync(path.join(repo, 'c.txt'), 'other\n');
    writeFileSync(path.join(repo, 'both.txt'), 'other both\n');
    fx.git(repo, 'rm', '-q', 'gone.txt');
    fx.git(repo, 'add', '-A');
    fx.git(repo, 'commit', '-q', '-m', 'other');
    fx.git(repo, 'switch', '-q', 'main');
    writeFileSync(path.join(repo, 'c.txt'), 'main\n');
    writeFileSync(path.join(repo, 'both.txt'), 'main both\n');
    writeFileSync(path.join(repo, 'gone.txt'), 'changed on main\n');
    fx.git(repo, 'add', '-A');
    fx.git(repo, 'commit', '-q', '-m', 'main');
    try {
      fx.git(repo, 'merge', 'other');
    } catch {
      // The conflict is the point.
    }
    await api.addProject({ path: repo });
    const listed = await expectMatchesGit(fx, repo, api, 3);
    expect(listed.get('c.txt')?.status).toBe('conflicted');
    expect(listed.get('both.txt')?.status).toBe('conflicted');
  });

  it('a sparse checkout lists HEAD whole; paths outside the cone are unchanged (documented)', async () => {
    const repo = await makeRealRepo(fx, 'sparse', { 'top.txt': 't\n' });
    for (const d of ['in', 'out']) mkdirSync(path.join(repo, d));
    writeFileSync(path.join(repo, 'in/a.txt'), 'a\n');
    writeFileSync(path.join(repo, 'out/b.txt'), 'b\n');
    fx.git(repo, 'add', '-A');
    fx.git(repo, 'commit', '-q', '-m', 'dirs');
    fx.git(repo, 'sparse-checkout', 'set', 'in');
    writeFileSync(path.join(repo, 'in/a.txt'), 'a changed\n');
    await api.addProject({ path: repo });
    const listed = await expectMatchesGit(fx, repo, api, 50);
    expect(listed.get('out/b.txt')?.status).toBeUndefined();
    expect(listed.get('in/a.txt')?.status).toBe('modified');
  });
});

describe('GET /tree paging (property)', () => {
  it('random page sizes with refreshes mid-paging add up to the final listing', async () => {
    const files: Record<string, string> = {};
    const repo = await makeRealRepo(fx, 'paging', { 'seed.txt': 's\n' });
    mkdirSync(path.join(repo, 'many'));
    for (let i = 0; i < 120; i++) files[`many/f${String(i).padStart(3, '0')}.txt`] = `${i}\n`;
    for (const [f, c] of Object.entries(files)) writeFileSync(path.join(repo, f), c);
    fx.git(repo, 'add', '-A');
    fx.git(repo, 'commit', '-q', '-m', 'many');
    await api.addProject({ path: repo });
    const id = hashId(repo);
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    let edits = 0;
    let totalRestarts = 0;
    for (let round = 0; round < 12; round++) {
      const seen: TreeEntry[] = [];
      let cursor: string | undefined;
      let restarts = 0;
      for (let guard = 0; guard < 500; guard++) {
        const limit = 1 + Math.floor(random() * 25);
        const page = await api.getTree(id, { path: 'many', limit, ...(cursor ? { cursor } : {}) });
        if (page.restarted) {
          restarts++;
          seen.length = 0;
        }
        expect(page.offset).toBe(seen.length);
        seen.push(...page.entries);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
        if (random() < 0.15) {
          // Change the directory's listing and make the daemon see it.
          const n = edits++;
          if (n % 3 === 0) writeFileSync(path.join(repo, `many/new${n}.txt`), 'n\n');
          else if (n % 3 === 1)
            writeFileSync(
              path.join(repo, `many/f${String(n % 120).padStart(3, '0')}.txt`),
              `edit ${n}\n`,
            );
          else
            rmSync(path.join(repo, `many/f${String((n * 7) % 120).padStart(3, '0')}.txt`), {
              force: true,
            });
          await api.refreshWorktree(id);
        }
      }
      const whole = await api.getTree(id, { path: 'many', limit: 5000 });
      expect(seen).toEqual(whole.entries);
      totalRestarts += restarts;
    }
    expect(edits).toBeGreaterThan(0);
    // The edits did land mid-paging: some pages restarted, and paging still added up.
    expect(totalRestarts).toBeGreaterThan(0);
  });
});

describe('GET /tree security', () => {
  let repo: string;
  let id: string;
  beforeEach(async () => {
    repo = await makeRealRepo(fx, 'secure', { 'a.txt': 'a\n', '-n': 'dash file\n' });
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'src/s.txt'), 's\n');
    mkdirSync(path.join(repo, '--output=x'));
    writeFileSync(path.join(repo, '--output=x/o.txt'), 'o\n');
    symlinkSync('src', path.join(repo, 'link-in'));
    symlinkSync(os.tmpdir(), path.join(repo, 'link-out'));
    fx.git(repo, 'add', '-A');
    fx.git(repo, 'commit', '-q', '-m', 'more');
    await api.addProject({ path: repo });
    id = hashId(repo);
  });

  it('refuses traversal, absolute paths, NUL and option-like refs (400)', async () => {
    for (const q of [
      'path=..',
      'path=../..',
      'path=src/../..',
      'path=%2e%2e',
      'path=/etc',
      'path=src%00x',
      'path=./src',
      'ref=-p',
      'ref=--output%3D%2Ftmp%2Fx',
      'ref=HEAD~1',
      'ref=HEAD%5E%7Btree%7D',
      'ref=main:src',
      'limit=0',
      'cursor=nope',
    ]) {
      const res = await http(daemon, `/api/worktrees/${id}/tree?${q}`);
      expect(res.status, q).toBe(400);
      expect((await errorOf(res)).code).toBe('bad_request');
    }
  });

  it('lists option-like names as plain names', async () => {
    const dash = await api.getTree(id, { path: '--output=x' });
    expect(dash.entries.map((e) => e.path)).toEqual(['--output=x/o.txt']);
    const root = await api.getTree(id, {});
    expect(root.entries.map((e) => e.name)).toContain('-n');
  });

  it('never follows a symlinked directory, in or out of the repository', async () => {
    for (const p of ['link-in', 'link-out']) {
      for (const ref of [undefined, 'HEAD']) {
        const res = await http(
          daemon,
          `/api/worktrees/${id}/tree?path=${p}${ref ? `&ref=${ref}` : ''}`,
        );
        expect(res.status, `${p} ${ref}`).toBe(400);
        expect((await errorOf(res)).message).toMatch(/not a directory \(a symlink\)/);
      }
      const below = await http(daemon, `/api/worktrees/${id}/tree?path=${p}/s.txt`);
      expect(below.status).toBe(404);
    }
    const file = await http(daemon, `/api/worktrees/${id}/tree?path=a.txt`);
    expect(file.status).toBe(400);
    expect((await http(daemon, `/api/worktrees/${id}/tree?path=missing`)).status).toBe(404);
    expect((await http(daemon, `/api/worktrees/${id}/tree?ref=nope`)).status).toBe(404);
    expect((await http(daemon, `/api/worktrees/0123456789abcdef/tree`)).status).toBe(404);
  });

  it('the tree view never reads the working copy', async () => {
    const before = await api.getTree(id, { path: 'src', ref: 'HEAD' });
    rmSync(path.join(repo, 'src'), { recursive: true });
    writeFileSync(path.join(repo, 'new.txt'), 'n\n');
    try {
      await api.refreshWorktree(id);
      const after = await api.getTree(id, { path: 'src', ref: 'HEAD' });
      expect(after.entries).toEqual(before.entries);
      expect(after.view).toBe('tree');
      expect(after.stateHash).toBeNull();
      expect((await api.getTree(id, { ref: 'main' })).entries.map((e) => e.name)).not.toContain(
        'new.txt',
      );
      // The working view does see the change.
      const working = await api.getTree(id, {});
      expect(working.entries.find((e) => e.name === 'new.txt')?.status).toBe('untracked');
      expect(working.entries.find((e) => e.name === 'src')?.status).toBe('deleted');
    } finally {
      fx.git(repo, 'checkout', '-q', '--', 'src');
      rmSync(path.join(repo, 'new.txt'));
      await api.refreshWorktree(id);
    }
  });
});

describe('GET /tree warm path and deltas', () => {
  it('a warm listing spawns no git; worktree.changed names the directories that moved', async () => {
    const counting = await startCounting(fx);
    const repo = await makeRealRepo(fx, 'warm', { 'top.txt': 't\n' });
    mkdirSync(path.join(repo, 'src/lib'), { recursive: true });
    writeFileSync(path.join(repo, 'src/lib/a.ts'), 'a\n');
    writeFileSync(path.join(repo, 'src/b.ts'), 'b\n');
    fx.git(repo, 'add', '-A');
    fx.git(repo, 'commit', '-q', '-m', 'src');
    const capi = client(counting.daemon);
    await capi.addProject({ path: repo });
    const id = hashId(repo);
    writeFileSync(path.join(repo, 'src/b.ts'), 'b changed\n');
    await capi.refreshWorktree(id);
    await capi.getTree(id, { path: 'src/lib' });
    const before = counting.spawns().length;
    const again = await capi.getTree(id, { path: 'src/lib' });
    const root = await capi.getTree(id, {});
    expect(counting.spawns().slice(before)).toEqual([]);
    expect(again.entries.map((e) => e.name)).toEqual(['a.ts']);
    expect(root.entries.find((e) => e.name === 'src')?.changes).toBe(1);

    const events = recordEvents(counting.daemon);
    await events.opened;
    const changedAfter = async (mark: number) =>
      eventually(
        () =>
          events.events
            .slice(mark)
            .find(
              (e): e is Changed =>
                e.type === 'worktree.changed' && e.worktreeId === id && e.dirs !== undefined,
            ),
        8000,
      );
    // A new untracked file: its directory and every ancestor.
    let mark = events.events.length;
    mkdirSync(path.join(repo, 'src/lib/new'));
    writeFileSync(path.join(repo, 'src/lib/new/n.ts'), 'n\n');
    await capi.refreshWorktree(id);
    let event = await changedAfter(mark);
    expect(event.dirs).toEqual({
      all: false,
      dirs: [{ path: '' }, { path: 'src' }, { path: 'src/lib' }, { path: 'src/lib/new' }],
    });
    // Editing an already modified file again moves no listing.
    mark = events.events.length;
    writeFileSync(path.join(repo, 'src/b.ts'), 'b changed again\n');
    await capi.refreshWorktree(id);
    event = await changedAfter(mark);
    expect(event.dirs).toEqual({ all: false, dirs: [] });
    // A commit moves HEAD: everything.
    mark = events.events.length;
    fx.git(repo, 'add', '-A');
    fx.git(repo, 'commit', '-q', '-m', 'commit');
    await capi.refreshWorktree(id);
    event = await changedAfter(mark);
    expect(event.dirs).toEqual({ all: true, dirs: [] });
    const fresh = await capi.getTree(id, { path: 'src/lib' });
    expect(fresh.entries.map((e) => [e.name, e.status ?? null])).toEqual([
      ['a.ts', null],
      ['new', null],
    ]);
  });

  it('an aborted request starts no git process', async () => {
    const counting = await startCounting(fx);
    const repo = await makeRealRepo(fx, 'abort', { 'a.txt': 'a\n' });
    const capi = client(counting.daemon);
    await capi.addProject({ path: repo });
    await capi.getTree(hashId(repo), {});
    const controller = new AbortController();
    controller.abort();
    const before = counting.spawns().length;
    await expect(
      capi.getTree(hashId(repo), { ref: 'main', signal: controller.signal }),
    ).rejects.toThrow();
    expect(counting.spawns().slice(before)).toEqual([]);
  });
});

async function startCounting(fixture: RealGitFixture) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'octopus-diff-'));
  onCleanup(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'spawns.log');
  writeFileSync(log, '');
  const wrapper = path.join(dir, 'git-wrapper.sh');
  writeFileSync(
    wrapper,
    `#!/bin/sh\nline="$*"\nprintf '%s\\n' "$line" >> '${log}'\nexec git "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  const started = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir: await tempDir(),
    logLevel: 'silent',
    gitCore: createGitCore({ env: fixture.env, gitBinary: wrapper }),
    watch: { enabled: false },
  });
  onCleanup(() => started.close());
  return {
    daemon: started,
    spawns: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
}
