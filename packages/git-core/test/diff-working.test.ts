import { chmodSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import path from 'node:path';
import type { GitCore, WorktreeLocator } from '@octopus-diff/contracts';
import { isGitCoreError } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore } from '../src/index.js';
import {
  expectConsistentHashes,
  expectFile,
  fileDiff,
  listFiles,
  locator,
} from './helpers/core.js';
import { createFixture, type Fixture, lines } from './helpers/fixture.js';

const NON_UTF8 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74, 0x78, 0x74]); // "caf\xe9.txt"
const NON_UTF8_UNTRACKED = Buffer.from([0x6e, 0x65, 0x77, 0xff, 0x2e, 0x74, 0x78, 0x74]);

describe('working / staged / unstaged scopes', () => {
  let fx: Fixture;
  let core: GitCore;
  let repo: string;
  let wt: WorktreeLocator;

  beforeAll(() => {
    fx = createFixture();
    repo = fx.repo('scopes', {
      files: {
        'keep.txt': 'keep\n',
        'modify.txt': lines(10),
        'delete.txt': lines(3, 'gone'),
        'rename-src.txt': lines(20, 'rename'),
        'copy-src.txt': lines(20, 'copy'),
        'mode.sh': '#!/bin/sh\necho hi\n',
        'crlf.txt': 'one\r\ntwo\r\nthree\r\n',
        'ws.txt': 'a\nb\nc\n',
        'tc.txt': 'was a file\n',
        'both.txt': lines(5, 'both'),
        'space name.txt': 'x\n',
        'dir/nested.txt': 'nested\n',
      },
    });
    fx.write(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 5]));
    fx.writeRaw(repo, NON_UTF8, '');
    fx.git(repo, ['add', '-A']);
    fx.git(repo, ['commit', '-q', '-m', 'second']);

    // Staged changes.
    fx.write(path.join(repo, 'staged.txt'), 'new staged\n');
    fx.git(repo, ['add', 'staged.txt']);
    fx.write(path.join(repo, 'both.txt'), lines(5, 'both').replace('both 2', 'both 2 staged'));
    fx.git(repo, ['add', 'both.txt']);
    fx.git(repo, ['mv', 'rename-src.txt', 'renamed.txt']);
    fx.write(path.join(repo, 'copy-src.txt'), lines(20, 'copy').replace('copy 20', 'copy 20!'));
    fx.write(path.join(repo, 'copy-dst.txt'), lines(20, 'copy'));
    fx.git(repo, ['add', 'copy-src.txt', 'copy-dst.txt']);
    // Unstaged changes.
    fx.write(
      path.join(repo, 'both.txt'),
      lines(5, 'both').replace('both 2', 'both 2 staged').replace('both 4', 'both 4 unstaged'),
    );
    fx.write(path.join(repo, 'modify.txt'), lines(10).replace('line 5', 'line five'));
    unlinkSync(path.join(repo, 'delete.txt'));
    chmodSync(path.join(repo, 'mode.sh'), 0o755);
    fx.write(path.join(repo, 'crlf.txt'), 'one\r\nTWO\r\nthree\r\n');
    fx.write(path.join(repo, 'ws.txt'), 'a\n  b\nc\n');
    rmSync(path.join(repo, 'tc.txt'));
    fx.symlink('keep.txt', path.join(repo, 'tc.txt'));
    fx.write(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 6, 7]));
    fx.write(path.join(repo, 'space name.txt'), 'y\n');
    fx.writeRaw(repo, NON_UTF8, 'now has content\n');
    // Untracked.
    fx.write(path.join(repo, 'untracked.txt'), lines(4, 'u'));
    fx.write(path.join(repo, 'untracked-noeol.txt'), 'no newline');
    fx.write(path.join(repo, 'untracked-empty.txt'), '');
    fx.write(path.join(repo, 'untracked.bin'), Buffer.from([1, 0, 2]));
    fx.symlink('keep.txt', path.join(repo, 'untracked-link'));
    fx.write(path.join(repo, 'sub dir', 'deep.txt'), 'deep\n');
    fx.writeRaw(repo, NON_UTF8_UNTRACKED, 'a\nb\n');
    fx.git(path.join(repo), ['init', '-q', 'nested-repo']);

    core = createGitCore(fx.coreOptions());
    wt = locator(repo, path.join(repo, '.git'));
  });

  afterAll(async () => {
    await core.dispose();
    fx.dispose();
  });

  it('lists the working scope (tracked + untracked) with correct statuses', async () => {
    const files = await listFiles(core, wt, { kind: 'working' });
    const paths = files.map((f) => f.path);
    expect([...paths].sort()).toEqual(paths.slice().sort());
    expectFile(files, 'staged.txt', {
      status: 'added',
      staged: true,
      unstaged: false,
      additions: 1,
      deletions: 0,
      oldMode: null,
      newMode: '100644',
    });
    expectFile(files, 'both.txt', {
      status: 'modified',
      staged: true,
      unstaged: true,
      additions: 2,
      deletions: 2,
    });
    expectFile(files, 'renamed.txt', {
      status: 'renamed',
      oldPath: 'rename-src.txt',
      staged: true,
      additions: 0,
      deletions: 0,
    });
    // Copies are detected only in scopes that do not read the worktree (see ScopePlan).
    expectFile(files, 'copy-dst.txt', { status: 'added', oldPath: null });
    expectFile(files, 'copy-src.txt', { status: 'modified' });
    expectFile(files, 'modify.txt', {
      status: 'modified',
      staged: false,
      unstaged: true,
      additions: 1,
      deletions: 1,
    });
    expectFile(files, 'delete.txt', {
      status: 'deleted',
      newMode: null,
      oldMode: '100644',
      deletions: 3,
      additions: 0,
    });
    expectFile(files, 'mode.sh', {
      status: 'modified',
      oldMode: '100644',
      newMode: '100755',
      additions: 0,
      deletions: 0,
    });
    expectFile(files, 'tc.txt', { status: 'typechange', oldMode: '100644', newMode: '120000' });
    expectFile(files, 'bin.dat', {
      status: 'modified',
      binary: true,
      additions: null,
      deletions: null,
    });
    expectFile(files, 'space name.txt', { status: 'modified' });
    expectFile(files, 'untracked.txt', {
      status: 'untracked',
      staged: false,
      unstaged: true,
      additions: 4,
      deletions: 0,
      newMode: '100644',
      oldMode: null,
    });
    expectFile(files, 'untracked-noeol.txt', { status: 'untracked', additions: 1 });
    expectFile(files, 'untracked-empty.txt', { status: 'untracked', additions: 0 });
    expectFile(files, 'untracked.bin', { status: 'untracked', binary: true, additions: null });
    expectFile(files, 'untracked-link', { status: 'untracked', newMode: '120000', additions: 1 });
    expectFile(files, 'sub dir/deep.txt', { status: 'untracked' });
    expectFile(files, 'nested-repo', { status: 'untracked', newMode: '160000', additions: null });
    expect(paths).not.toContain('keep.txt');
    expect(paths).not.toContain('dir/nested.txt');
    const odd = files.filter((f) => f.rawPath !== undefined);
    expect(odd.map((f) => Buffer.from(f.rawPath as string, 'base64'))).toEqual([
      NON_UTF8,
      NON_UTF8_UNTRACKED,
    ]);
    for (const f of odd) expect(f.path).toContain('�');
  });

  it('lists the staged scope', async () => {
    const files = await listFiles(core, wt, { kind: 'staged' });
    expect(files.map((f) => f.path).sort()).toEqual(
      ['both.txt', 'copy-dst.txt', 'copy-src.txt', 'renamed.txt', 'staged.txt'].sort(),
    );
    expectFile(files, 'both.txt', { staged: true, unstaged: true, additions: 1, deletions: 1 });
    expectFile(files, 'staged.txt', { staged: true, unstaged: false });
    expectFile(files, 'copy-dst.txt', { status: 'copied', oldPath: 'copy-src.txt' });
  });

  it('lists the unstaged scope', async () => {
    const files = await listFiles(core, wt, { kind: 'unstaged' });
    const paths = files.map((f) => f.path);
    for (const p of [
      'both.txt',
      'modify.txt',
      'delete.txt',
      'mode.sh',
      'crlf.txt',
      'ws.txt',
      'tc.txt',
      'bin.dat',
    ]) {
      expect(paths).toContain(p);
    }
    expect(paths).not.toContain('staged.txt');
    expect(paths).not.toContain('untracked.txt');
    expectFile(files, 'both.txt', { staged: true, unstaged: true, additions: 1, deletions: 1 });
  });

  for (const kind of ['working', 'staged', 'unstaged'] as const) {
    it(`getFileDiff agrees with listChangedFiles for every file (${kind})`, async () => {
      const files = await listFiles(core, wt, { kind });
      await expectConsistentHashes(core, wt, { kind }, files);
    });
  }

  it('returns sensible patches', async () => {
    const scope = { kind: 'working' } as const;
    const modify = await fileDiff(core, wt, scope, { path: 'modify.txt' });
    expect(modify.patch).toContain('diff --git a/modify.txt b/modify.txt\n');
    expect(modify.patch).toContain('-line 5\n+line five\n');
    expect(modify.tooLarge).toBe(false);
    expect(modify.truncated).toBe(false);
    expect(modify.byteLength).toBe(Buffer.byteLength(modify.patch));

    const crlf = await fileDiff(core, wt, scope, { path: 'crlf.txt' });
    expect(crlf.patch).toContain('-two\r\n+TWO\r\n');

    const ws = await fileDiff(core, wt, scope, { path: 'ws.txt' });
    expect(ws.patch).toContain('+  b\n');
    const wsHidden = await fileDiff(
      core,
      wt,
      scope,
      { path: 'ws.txt' },
      { ignoreWhitespace: true },
    );
    expect(wsHidden.patch).not.toContain('@@');

    const narrow = await fileDiff(core, wt, scope, { path: 'modify.txt' }, { contextLines: 0 });
    expect(narrow.patch).toContain('@@ -5 +5 @@');
    expect(narrow.byteLength).toBe(modify.byteLength);

    const tc = await fileDiff(core, wt, scope, { path: 'tc.txt' });
    expect(tc.patch.match(/^diff --git /gm)).toHaveLength(2);
    expect(tc.patch).toContain('deleted file mode 100644');
    expect(tc.patch).toContain('new file mode 120000');

    const renamed = await fileDiff(core, wt, scope, { path: 'renamed.txt' });
    expect(renamed.patch).toContain('rename from rename-src.txt\nrename to renamed.txt\n');

    const copied = await fileDiff(core, wt, { kind: 'staged' }, { path: 'copy-dst.txt' });
    expect(copied.patch).toContain('copy from copy-src.txt\ncopy to copy-dst.txt\n');

    const bin = await fileDiff(core, wt, scope, { path: 'bin.dat' });
    expect(bin).toMatchObject({ binary: true, patch: '', tooLarge: false });

    const space = await fileDiff(core, wt, scope, { path: 'space name.txt' });
    expect(space.patch).toContain('+++ b/space name.txt\t\n');
  });

  it('diffs untracked files like git diff --no-index', async () => {
    const scope = { kind: 'working' } as const;
    const text = await fileDiff(core, wt, scope, { path: 'untracked.txt' });
    const expected = fx.git(
      repo,
      ['diff', '--no-index', '--full-index', '--', '/dev/null', 'untracked.txt'],
      { allowFail: true },
    );
    expect(text.patch).toBe(expected);
    const link = await fileDiff(core, wt, scope, { path: 'untracked-link' });
    expect(link.patch).toContain('new file mode 120000');
    expect(link.patch).toContain('+keep.txt\n\\ No newline at end of file');
    const bin = await fileDiff(core, wt, scope, { path: 'untracked.bin' });
    expect(bin).toMatchObject({ binary: true, patch: '' });
    const nested = await fileDiff(core, wt, scope, { path: 'nested-repo' });
    expect(nested).toMatchObject({ status: 'untracked', patch: '' });
  });

  it('handles non-UTF-8 paths through rawPath', async () => {
    const files = await listFiles(core, wt, { kind: 'working' });
    const tracked = files.find((f) => f.rawPath === NON_UTF8.toString('base64'));
    const untracked = files.find((f) => f.rawPath === NON_UTF8_UNTRACKED.toString('base64'));
    expect(tracked).toMatchObject({ status: 'modified', additions: 1, deletions: 0 });
    expect(untracked).toMatchObject({ status: 'untracked', additions: 2 });
    const trackedDiff = await fileDiff(core, wt, { kind: 'working' }, tracked as never);
    expect(trackedDiff.patchHash).toBe(tracked?.patchHash);
    expect(trackedDiff.patch).toContain('+now has content');
    const untrackedDiff = await fileDiff(core, wt, { kind: 'working' }, untracked as never);
    expect(untrackedDiff.patchHash).toBe(untracked?.patchHash);
    expect(untrackedDiff.patch).toContain('@@ -0,0 +1,2 @@\n+a\n+b\n');
  });

  it('rejects files that are not changed, and bad input', async () => {
    const notFound = await core
      .getFileDiff(wt, { kind: 'working' }, { path: 'keep.txt' })
      .catch((e: unknown) => e);
    expect(isGitCoreError(notFound, 'not_found')).toBe(true);
    const staged = await core
      .getFileDiff(wt, { kind: 'staged' }, { path: 'untracked.txt' })
      .catch((e: unknown) => e);
    expect(isGitCoreError(staged, 'not_found')).toBe(true);
    for (const bad of [
      () => core.getFileDiff(wt, { kind: 'working' }, { path: '../etc/passwd' }),
      () => core.getFileDiff(wt, { kind: 'working' }, { path: '/etc/passwd' }),
      () => core.getFileDiff(wt, { kind: 'working' }, { path: 'modify.txt' }, { contextLines: -1 }),
      () => core.listChangedFiles(wt, { kind: 'nope' } as never),
      () => core.listChangedFiles(wt, { kind: 'branch', base: '--output=/tmp/x' }),
      () => core.listChangedFiles(wt, { kind: 'commit', sha: 'HEAD~1' }),
      () => core.listChangedFiles({ ...wt, path: 'relative/path' }, { kind: 'working' }),
    ]) {
      const error = await bad().catch((e: unknown) => e);
      expect(isGitCoreError(error, 'invalid_argument'), String(error)).toBe(true);
    }
  });

  it('ignores stat-only changes and never refreshes the index', async () => {
    const index = path.join(repo, '.git', 'index');
    const before = statSync(index, { bigint: true });
    const future = new Date(Date.now() + 120_000);
    utimesSync(path.join(repo, 'keep.txt'), future, future);
    utimesSync(path.join(repo, 'dir', 'nested.txt'), future, future);
    for (const kind of ['working', 'unstaged'] as const) {
      const files = await listFiles(core, wt, { kind });
      expect(files.map((f) => f.path)).not.toContain('keep.txt');
      expect(files.map((f) => f.path)).not.toContain('dir/nested.txt');
      const error = await core
        .getFileDiff(wt, { kind }, { path: 'keep.txt' })
        .catch((e: unknown) => e);
      expect(isGitCoreError(error, 'not_found')).toBe(true);
    }
    const summary = await core.getSummary(wt);
    const working = await listFiles(core, wt, { kind: 'working' });
    expect(summary.changedFiles).toBe(working.length);
    const after = statSync(index, { bigint: true });
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ino).toBe(before.ino);
  });

  it('works the same when the locator points at a subdirectory', async () => {
    const fromRoot = await listFiles(core, wt, { kind: 'working' });
    const fromSubdir = await listFiles(
      core,
      { ...wt, path: path.join(repo, 'dir') },
      { kind: 'working' },
    );
    expect(fromSubdir).toEqual(fromRoot);
  });

  it('caps untracked inspection with maxUntrackedFiles', async () => {
    // Sorted by raw bytes the first two untracked entries are `nested-repo/` (a directory, never
    // read) and the non-UTF-8 file, so exactly one file gets line counts.
    const capped = createGitCore(fx.coreOptions({ maxUntrackedFiles: 2 }));
    try {
      const files = await listFiles(capped, wt, { kind: 'working' });
      const untracked = files.filter((f) => f.status === 'untracked' && f.newMode !== '160000');
      const withCounts = untracked.filter((f) => f.additions !== null || f.binary);
      expect(withCounts.map((f) => f.rawPath)).toEqual([NON_UTF8_UNTRACKED.toString('base64')]);
      await expectConsistentHashes(capped, wt, { kind: 'working' }, untracked);
    } finally {
      await capped.dispose();
    }
  });
});

describe('large patches', () => {
  let fx: Fixture;
  let repo: string;

  beforeAll(() => {
    fx = createFixture();
    repo = fx.repo('large', { files: { 'big.txt': lines(2000), 'small.txt': 'a\n' } });
    fx.write(path.join(repo, 'big.txt'), lines(2000, 'changed'));
    fx.write(path.join(repo, 'small.txt'), 'b\n');
    fx.write(path.join(repo, 'big-untracked.txt'), lines(3000, 'new'));
  });

  afterAll(() => fx.dispose());

  it('omits patches above the soft limit unless full=true', async () => {
    const core = createGitCore(fx.coreOptions({ maxPatchBytes: 4096 }));
    const wt = locator(repo);
    try {
      const big = await fileDiff(core, wt, { kind: 'working' }, { path: 'big.txt' });
      expect(big).toMatchObject({ tooLarge: true, truncated: false, patch: '' });
      expect(big.byteLength).toBeGreaterThan(4096);
      const full = await fileDiff(
        core,
        wt,
        { kind: 'working' },
        { path: 'big.txt' },
        { full: true },
      );
      expect(full.tooLarge).toBe(false);
      expect(full.truncated).toBe(false);
      expect(Buffer.byteLength(full.patch)).toBe(full.byteLength);
      expect(full.patchHash).toBe(big.patchHash);
      const small = await fileDiff(core, wt, { kind: 'working' }, { path: 'small.txt' });
      expect(small.tooLarge).toBe(false);
      const untracked = await fileDiff(
        core,
        wt,
        { kind: 'working' },
        { path: 'big-untracked.txt' },
      );
      expect(untracked.tooLarge).toBe(true);
      const untrackedFull = await fileDiff(
        core,
        wt,
        { kind: 'working' },
        { path: 'big-untracked.txt' },
        { full: true },
      );
      expect(untrackedFull.patch.split('\n').length).toBeGreaterThan(3000);
      const listed = await listFiles(core, wt, { kind: 'working' });
      expect(listed.find((f) => f.path === 'big.txt')?.patchHash).toBe(big.patchHash);
      expect(listed.find((f) => f.path === 'big-untracked.txt')?.patchHash).toBe(
        untracked.patchHash,
      );
    } finally {
      await core.dispose();
    }
  });

  it('truncates at the hard cap with full=true', async () => {
    const core = createGitCore(fx.coreOptions({ maxPatchBytes: 1024, maxOutputBytes: 16 * 1024 }));
    const wt = locator(repo);
    try {
      const full = await fileDiff(
        core,
        wt,
        { kind: 'working' },
        { path: 'big.txt' },
        { full: true },
      );
      expect(full.truncated).toBe(true);
      expect(Buffer.byteLength(full.patch)).toBeLessThanOrEqual(16 * 1024);
      expect(full.patch.endsWith('\n')).toBe(true);
      expect(full.byteLength).toBeGreaterThan(16 * 1024);
      const listed = await listFiles(core, wt, { kind: 'working' });
      expect(listed.find((f) => f.path === 'big.txt')?.patchHash).toBe(full.patchHash);
    } finally {
      await core.dispose();
    }
  });
});
