/**
 * Regression tests for review-code F3, F4, F7 and F8 (docs/reports/review-code.md).
 */
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GitChangedFile, GitCore, WorktreeLocator } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore } from '../src/index.js';
import { expectConsistentHashes, fileDiff, listFiles, locator } from './helpers/core.js';
import { createFixture, type Fixture, lines } from './helpers/fixture.js';

let fx: Fixture;
let core: GitCore;

beforeAll(() => {
  fx = createFixture();
  core = createGitCore(fx.coreOptions());
});

afterAll(async () => {
  await core.dispose();
  fx.dispose();
});

function key(file: GitChangedFile): string {
  return file.rawPath ?? file.path;
}

async function working(wt: WorktreeLocator): Promise<Map<string, GitChangedFile>> {
  return new Map((await listFiles(core, wt, { kind: 'working' })).map((f) => [key(f), f]));
}

describe('F4: an untracked file keeps its patchHash through git add -N and git add', () => {
  const NON_UTF8 = Buffer.from([0x6e, 0xe9, 0x2e, 0x74, 0x78, 0x74]); // "n\xe9.txt"
  const contents: Record<string, string | Buffer> = {
    'new.ts': 'export const x = 1;\n',
    'empty.txt': '',
    'no-newline.txt': 'a\nb',
    'blank-lines.txt': '\n\na\n\n',
    'crlf.txt': 'one\r\ntwo\r\n',
    'with space.txt': 'spaced\n',
    'quote"and\\backslash.txt': 'q\n',
    'tab\tname.txt': 't\n',
    'binary.bin': Buffer.from([0, 1, 2, 3, 10, 0, 255]),
    'unicode-ü.txt': 'ü\n',
    // Larger than the 1 MiB single-read buffer: hashed in two streaming passes.
    'large.txt': lines(90_000, 'a fairly long line of text'),
    'dir/nested/deep.txt': 'deep\n',
    'attr.dat': 'text under a binary attribute\n',
  };

  async function check(objectFormat: 'sha1' | 'sha256'): Promise<void> {
    const repo = path.join(fx.root, `f4-${objectFormat}`);
    fx.write(path.join(repo, 'README.md'), '# f4\n');
    fx.git(repo, ['init', '-q', `--object-format=${objectFormat}`, '.']);
    fx.write(path.join(repo, '.gitattributes'), '*.dat binary\n');
    fx.commitAll(repo, 'initial');
    for (const [name, content] of Object.entries(contents)) {
      fx.write(path.join(repo, name), content);
    }
    fx.write(path.join(repo, 'exec.sh'), '#!/bin/sh\n');
    chmodSync(path.join(repo, 'exec.sh'), 0o755);
    fx.symlink('new.ts', path.join(repo, 'link'));
    fx.writeRaw(repo, NON_UTF8, 'raw name\n');
    const wt = locator(repo);

    const untracked = await working(wt);
    expect(untracked.size).toBe(Object.keys(contents).length + 3);
    for (const file of untracked.values()) expect(file.status, file.path).toBe('untracked');
    await expectConsistentHashes(core, wt, { kind: 'working' }, [...untracked.values()]);
    // The displayed patch is the canonical text the hash is computed from.
    const shown = await fileDiff(core, wt, { kind: 'working' }, { path: 'no-newline.txt' });
    expect(shown.patch).toMatch(/\+b\n\\ No newline at end of file\n$/);

    fx.git(repo, ['add', '-N', '--', '.']);
    const intentToAdd = await working(wt);
    fx.git(repo, ['add', '-A']);
    const added = await working(wt);
    for (const [name, file] of untracked) {
      expect(intentToAdd.get(name)?.status, name).toBe('added');
      expect(added.get(name)?.status, name).toBe('added');
      expect(intentToAdd.get(name)?.patchHash, `${name} after add -N`).toBe(file.patchHash);
      expect(added.get(name)?.patchHash, `${name} after add`).toBe(file.patchHash);
      expect(added.get(name)?.binary, name).toBe(file.binary);
      expect(added.get(name)?.additions, name).toBe(file.additions);
    }
  }

  it('sha1 repository', async () => {
    await check('sha1');
  });

  it('sha256 repository', async () => {
    await check('sha256');
  });

  it('a nested repository: follows its HEAD, and matches the gitlink once added', async () => {
    const repo = fx.repo('f4-nested', { files: { 'r.txt': 'r\n' } });
    const nested = fx.repo('f4-nested/inner', { files: { 'n.txt': 'n1\n' } });
    const wt = locator(repo);
    const before = (await working(wt)).get('inner') as GitChangedFile;
    expect(before).toMatchObject({ status: 'untracked', newMode: '160000' });
    const summary1 = await core.getSummary(wt);
    const diff = await fileDiff(core, wt, { kind: 'working' }, before);
    expect(diff.patchHash).toBe(before.patchHash);
    const sha = fx.git(nested, ['rev-parse', 'HEAD']).trim();
    expect(diff.patch).toContain(`+Subproject commit ${sha}\n`);

    // A commit inside the nested repository (its directory entries unchanged) is a new patch.
    writeFileSync(path.join(nested, 'n.txt'), 'n2\n');
    fx.git(nested, ['commit', '-qam', 'n2']);
    const moved = (await working(wt)).get('inner') as GitChangedFile;
    expect(moved.patchHash).not.toBe(before.patchHash);
    expect((await core.getSummary(wt)).stateHash).not.toBe(summary1.stateHash);
    // Packed refs and a detached HEAD resolve too.
    fx.git(nested, ['pack-refs', '--all']);
    expect((await working(wt)).get('inner')?.patchHash).toBe(moved.patchHash);
    fx.git(nested, ['checkout', '-q', '--detach', 'HEAD~1']);
    expect((await working(wt)).get('inner')?.patchHash).toBe(before.patchHash);
    fx.git(nested, ['checkout', '-q', 'main']);

    fx.git(repo, ['add', 'inner'], { allowFail: true }); // warns about an embedded repository
    const added = (await working(wt)).get('inner') as GitChangedFile;
    expect(added).toMatchObject({ status: 'added', newMode: '160000' });
    expect(added.patchHash).toBe(moved.patchHash);
  });

  it('an unborn nested repository still changes hash when its HEAD changes', async () => {
    const repo = fx.repo('f4-unborn', { files: { 'r.txt': 'r\n' } });
    const inner = path.join(repo, 'inner');
    fx.git(repo, ['init', '-q', 'inner']);
    const wt = locator(repo);
    const first = (await working(wt)).get('inner') as GitChangedFile;
    expect(first.newMode).toBe('160000');
    fx.write(path.join(inner, 'x'), 'x\n');
    fx.commitAll(inner, 'first');
    expect((await working(wt)).get('inner')?.patchHash).not.toBe(first.patchHash);
  });
});

describe('F8: untracked files under binary / -diff / diff attributes', () => {
  let repo: string;
  let wt: WorktreeLocator;

  beforeAll(() => {
    repo = fx.repo('f8', {
      files: { '.gitattributes': '*.dat binary\n*.nd -diff\n*.forced diff\n' },
    });
    fx.write(path.join(repo, 'x.dat'), 'plain text\nline2\n');
    fx.write(path.join(repo, 'y.nd'), 'hello\n');
    fx.write(path.join(repo, 'z.forced'), Buffer.from('a\u0000b\nc\n', 'latin1'));
    fx.write(path.join(repo, 'plain.txt'), 'p\nq\nr\n');
    fx.write(path.join(repo, 'empty.dat'), '');
    wt = locator(repo);
  });

  it('lists, diffs and summarizes them as git does, before and after git add', async () => {
    const files = await working(wt);
    expect(files.get('x.dat')).toMatchObject({ binary: true, additions: null, deletions: null });
    expect(files.get('y.nd')).toMatchObject({ binary: true, additions: null });
    expect(files.get('z.forced')).toMatchObject({ binary: false, additions: 2, deletions: 0 });
    expect(files.get('plain.txt')).toMatchObject({ binary: false, additions: 3 });
    await expectConsistentHashes(core, wt, { kind: 'working' }, [...files.values()]);

    const dat = await fileDiff(core, wt, { kind: 'working' }, { path: 'x.dat' });
    expect(dat).toMatchObject({ binary: true, patch: '', additions: null });
    const forced = await fileDiff(core, wt, { kind: 'working' }, { path: 'z.forced' });
    expect(forced.patch).toContain('+a\u0000b\n+c\n');

    const summary = await core.getSummary(wt);
    expect(summary.additions).toBe(5); // plain.txt + z.forced; binary files count no lines
    expect(summary.changedFiles).toBe(files.size);

    fx.git(repo, ['add', '-A']);
    const added = await working(wt);
    for (const [name, file] of files) {
      expect(added.get(name), name).toMatchObject({
        status: 'added',
        binary: file.binary,
        additions: file.additions,
        patchHash: file.patchHash,
      });
    }
    expect((await core.getSummary(wt)).additions).toBe(5);
    fx.git(repo, ['reset', '-q']);
  });

  it('changes the summary when only the attributes change', async () => {
    const before = await core.getSummary(wt);
    fx.write(path.join(fx.root, 'f8', '.git', 'info', 'attributes'), 'plain.txt binary\n');
    try {
      const after = await core.getSummary(wt);
      expect(after.additions).toBe(2);
      expect(after.stateHash).not.toBe(before.stateHash);
      expect((await working(wt)).get('plain.txt')?.binary).toBe(true);
    } finally {
      rmSync(path.join(fx.root, 'f8', '.git', 'info', 'attributes'));
    }
  });
});

describe('F3: a submodule commit changes stateHash', () => {
  it('detects commits and checkouts inside the submodule', async () => {
    const lib = fx.repo('f3-lib', { files: { 'a.txt': 'v1\n' } });
    const c1 = fx.git(lib, ['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(lib, 'a.txt'), 'v2\n');
    fx.git(lib, ['commit', '-qam', 'v2']);
    const repo = fx.repo('f3-super', { files: { 'r.txt': 'r\n' } });
    fx.git(repo, ['submodule', 'add', '-q', lib, 'sub']);
    const sub = path.join(repo, 'sub');
    fx.git(sub, ['checkout', '-q', c1]);
    fx.commitAll(repo, 'sub at c1');
    fx.git(sub, ['checkout', '-q', 'main']); // superproject: M sub (c1 -> c2)
    const wt = locator(repo, path.join(repo, '.git'));

    const s1 = await core.getSummary(wt);
    const p1 = (await working(wt)).get('sub') as GitChangedFile;
    expect(p1).toMatchObject({ status: 'modified', newMode: '160000' });

    // In place: the submodule directory's entries do not change.
    writeFileSync(path.join(sub, 'a.txt'), 'v3\n');
    fx.git(sub, ['commit', '-qam', 'v3']);
    const s2 = await core.getSummary(wt);
    const p2 = (await working(wt)).get('sub') as GitChangedFile;
    expect(p2.patchHash).not.toBe(p1.patchHash);
    expect(s2.stateHash).not.toBe(s1.stateHash);

    // reset --soft and a detached checkout move HEAD too.
    fx.git(sub, ['reset', '-q', '--soft', 'HEAD~1']);
    const s3 = await core.getSummary(wt);
    expect(s3.stateHash).not.toBe(s2.stateHash);
    expect(s3.stateHash).toBe(s1.stateHash);
    fx.git(sub, ['checkout', '-q', '-f', '--detach', c1]);
    expect((await core.getSummary(wt)).stateHash).not.toBe(s3.stateHash);

    // Nothing changed: same hash (no false positives from reading the submodule).
    const again = await core.getSummary(wt);
    expect((await core.getSummary(wt)).stateHash).toBe(again.stateHash);

    // The daemon can watch the submodule git dirs.
    const targets = await core.getWatchTargets(wt);
    expect(targets.gitPaths).toContain(path.join(repo, '.git', 'modules'));
  });
});

describe.skipIf(process.getuid?.() === 0)('F7: an unreadable tracked file', () => {
  let repo: string;
  let wt: WorktreeLocator;
  let secret: string;

  beforeAll(() => {
    repo = fx.repo('f7', { files: { 'a.txt': 'a\n', 'secret.txt': 's\n', 'c.txt': 'c\n' } });
    fx.write(path.join(repo, 'a.txt'), 'a\nmore\n');
    secret = path.join(repo, 'secret.txt');
    fx.write(secret, 'changed secret\n');
    fx.write(path.join(repo, 'u.txt'), 'u1\nu2\n');
    chmodSync(secret, 0o000);
    wt = locator(repo);
  });

  afterAll(() => {
    chmodSync(secret, 0o644);
  });

  it('plain git diff fails on it (control)', () => {
    expect(() => fx.git(repo, ['diff', 'HEAD'])).toThrow(/Permission denied|cannot hash/);
  });

  it('summarizes the worktree with that file counted but without line counts', async () => {
    const summary = await core.getSummary(wt);
    expect(summary.changedFiles).toBe(3);
    expect(summary.counts).toMatchObject({ unstaged: 2, untracked: 1 });
    expect(summary.additions).toBe(3); // a.txt +1, u.txt +2
    const files = await listFiles(core, wt, { kind: 'working' });
    expect(summary.changedFiles).toBe(files.length);
  });

  it('lists the other files normally and the unreadable one without a diff', async () => {
    const files = await listFiles(core, wt, { kind: 'working' });
    expect(files.map((f) => [f.path, f.status, f.additions])).toEqual([
      ['a.txt', 'modified', 1],
      ['secret.txt', 'modified', null],
      ['u.txt', 'untracked', 2],
    ]);
    const readable = files.filter((f) => f.path !== 'secret.txt');
    await expectConsistentHashes(core, wt, { kind: 'working' }, readable);
    await expect(
      core.getFileDiff(wt, { kind: 'working' }, { path: 'secret.txt' }),
    ).rejects.toMatchObject({ code: 'git_failed', message: expect.stringMatching(/Permission/) });
    const unstaged = await listFiles(core, wt, { kind: 'unstaged' });
    expect(unstaged.map((f) => [f.path, f.additions])).toEqual([
      ['a.txt', 1],
      ['secret.txt', null],
    ]);
    expect(await listFiles(core, wt, { kind: 'staged' })).toEqual([]);
  });

  it('still changes stateHash and patchHash when the unreadable file changes', async () => {
    const s1 = await core.getSummary(wt);
    const h1 = (await working(wt)).get('secret.txt')?.patchHash;
    chmodSync(secret, 0o644);
    writeFileSync(secret, 'changed again\n');
    chmodSync(secret, 0o000);
    expect((await core.getSummary(wt)).stateHash).not.toBe(s1.stateHash);
    expect((await working(wt)).get('secret.txt')?.patchHash).not.toBe(h1);
  });
});
