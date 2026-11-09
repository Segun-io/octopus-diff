/**
 * Status flow v2 (docs/STATUS-FLOW.md): the `review` scope, `branch` with `includeWorking`,
 * `readReviewRange`, `describeCommits` and `rangePatchId`.
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { GitCore, WorktreeLocator } from '@octopus-diff/contracts';
import { isGitCoreError } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore, parseCommitPaths } from '../src/index.js';
import { byPath, expectConsistentHashes, expectFile, listFiles, locator } from './helpers/core.js';
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

function head(dir: string, rev = 'HEAD'): string {
  return fx.git(dir, ['rev-parse', rev]).trim();
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

function hashes(files: ReadonlyArray<{ path: string; patchHash: string }>): Record<string, string> {
  return Object.fromEntries(files.map((file) => [file.path, file.patchHash]));
}

describe('review scope', () => {
  let repo: string;
  let wt: WorktreeLocator;
  let first: string;

  beforeAll(() => {
    repo = fx.repo('review-scope', {
      files: { 'a.txt': lines(20), 'b.txt': lines(5, 'b'), 'gone.txt': 'gone\n' },
    });
    first = head(repo);
    fx.write(path.join(repo, 'b.txt'), lines(6, 'b'));
    fx.commitAll(repo, 'b grows');
    wt = locator(repo);
  });

  it('without base equals the working scope (staged, unstaged, untracked)', async () => {
    fx.write(path.join(repo, 'a.txt'), lines(20).replace('line 7', 'seven'));
    fx.write(path.join(repo, 'staged.txt'), 'staged\n');
    fx.git(repo, ['add', 'staged.txt']);
    fx.write(path.join(repo, 'u.txt'), 'untracked\n');
    const working = await listFiles(core, wt, { kind: 'working' });
    const review = await listFiles(core, wt, { kind: 'review' });
    expect(review).toEqual(working);
    expectFile(review, 'a.txt', { status: 'modified', staged: false, unstaged: true });
    expectFile(review, 'staged.txt', { status: 'added', staged: true, unstaged: false });
    expectFile(review, 'u.txt', { status: 'untracked', staged: false, unstaged: true });
    const withHead = await listFiles(core, wt, { kind: 'review', base: head(repo) });
    expect(withHead).toEqual(working);
    await expectConsistentHashes(core, wt, { kind: 'review', base: head(repo) }, withHead);
  });

  it('keeps a file’s patchHash when its uncommitted change is committed', async () => {
    const before = head(repo);
    const uncommitted = hashes(await listFiles(core, wt, { kind: 'review', base: before }));
    fx.git(repo, ['commit', '-q', '-m', 'seven', '--', 'a.txt']);
    const after = await listFiles(core, wt, { kind: 'review', base: before });
    expectFile(after, 'a.txt', {
      status: 'modified',
      staged: false,
      unstaged: false,
      patchHash: uncommitted['a.txt'],
    });
    expectFile(after, 'staged.txt', { patchHash: uncommitted['staged.txt'], staged: true });
    expectFile(after, 'u.txt', { patchHash: uncommitted['u.txt'], status: 'untracked' });
    // The working scope no longer lists a.txt.
    expect(byPath(await listFiles(core, wt, { kind: 'working' })).has('a.txt')).toBe(false);
    await expectConsistentHashes(core, wt, { kind: 'review', base: before }, after);
  });

  it('diffs the working tree against an older base commit', async () => {
    rmSync(path.join(repo, 'gone.txt'));
    const files = await listFiles(core, wt, { kind: 'review', base: first });
    expect(files.map((file) => file.path)).toEqual([
      'a.txt',
      'b.txt',
      'gone.txt',
      'staged.txt',
      'u.txt',
    ]);
    expectFile(files, 'b.txt', {
      status: 'modified',
      additions: 1,
      staged: false,
      unstaged: false,
    });
    expectFile(files, 'gone.txt', { status: 'deleted', staged: false, unstaged: true });
    // Short ids work too (resolved with rev-parse).
    expect(await listFiles(core, wt, { kind: 'review', base: first.slice(0, 10) })).toEqual(files);
    await expectConsistentHashes(core, wt, { kind: 'review', base: first }, files);
  });

  it('rejects a base that is not a commit', async () => {
    const missing = await errorOf(
      core.listChangedFiles(wt, { kind: 'review', base: 'deadbeef'.repeat(5) }),
    );
    expect(isGitCoreError(missing, 'not_found')).toBe(true);
    const tree = head(repo, 'HEAD^{tree}');
    const notCommit = await errorOf(core.listChangedFiles(wt, { kind: 'review', base: tree }));
    expect(isGitCoreError(notCommit, 'not_found')).toBe(true);
  });

  it('on an unborn branch equals the working scope', async () => {
    const unborn = fx.repo('review-unborn', { empty: true });
    fx.write(path.join(unborn, 's.txt'), 's\n');
    fx.git(unborn, ['add', 's.txt']);
    fx.write(path.join(unborn, 'u.txt'), 'u\n');
    const uwt = locator(unborn);
    const working = await listFiles(core, uwt, { kind: 'working' });
    expect(working.length).toBe(2);
    expect(await listFiles(core, uwt, { kind: 'review' })).toEqual(working);
    await expectConsistentHashes(core, uwt, { kind: 'review' }, working);
  });
});

describe('branch scope with includeWorking', () => {
  it('diffs the working tree against the merge-base', async () => {
    const repo = fx.repo('branch-working', { files: { 'base.txt': lines(10), 'w.txt': 'w\n' } });
    fx.git(repo, ['switch', '-q', '-c', 'feature']);
    fx.write(path.join(repo, 'f.txt'), 'feature\n');
    fx.commitAll(repo, 'feature');
    fx.git(repo, ['switch', '-q', 'main']);
    fx.write(path.join(repo, 'main.txt'), 'main moved on\n');
    fx.commitAll(repo, 'main');
    fx.git(repo, ['switch', '-q', 'feature']);
    fx.write(path.join(repo, 'w.txt'), 'W\n');
    fx.write(path.join(repo, 'h.txt'), 'untracked\n');
    const wt = locator(repo);

    const committed = await listFiles(core, wt, { kind: 'branch', base: 'main' });
    expect(committed.map((file) => file.path)).toEqual(['f.txt']);
    const all = await listFiles(core, wt, { kind: 'branch', base: 'main', includeWorking: true });
    expect(all.map((file) => file.path)).toEqual(['f.txt', 'h.txt', 'w.txt']);
    expectFile(all, 'f.txt', {
      status: 'added',
      staged: false,
      unstaged: false,
      patchHash: committed[0]?.patchHash,
    });
    expectFile(all, 'w.txt', { status: 'modified', staged: false, unstaged: true });
    expectFile(all, 'h.txt', { status: 'untracked', unstaged: true });
    // Default branch detection works the same way.
    expect(await listFiles(core, wt, { kind: 'branch', includeWorking: true })).toEqual(all);
    await expectConsistentHashes(
      core,
      wt,
      { kind: 'branch', base: 'main', includeWorking: true },
      all,
    );
  });

  it('on an unborn branch is the working tree', async () => {
    const unborn = fx.repo('branch-working-unborn', { empty: true });
    fx.write(path.join(unborn, 'x.txt'), 'x\n');
    const wt = locator(unborn);
    // Give the unborn repository a branch to compare with.
    fx.git(unborn, ['fetch', '-q', fx.repo('branch-working-unborn-main'), 'main:other']);
    const files = await listFiles(core, wt, {
      kind: 'branch',
      base: 'other',
      includeWorking: true,
    });
    expect(files).toEqual(await listFiles(core, wt, { kind: 'working' }));
    expect(await listFiles(core, wt, { kind: 'branch', base: 'other' })).toEqual([]);
  });
});

describe('readReviewRange', () => {
  let repo: string;
  let wt: WorktreeLocator;
  let c1: string;
  let c2: string;
  let f1: string;
  let f2: string;

  beforeAll(() => {
    repo = fx.repo('range', { files: { 'a.txt': 'a\n' } });
    c1 = head(repo);
    fx.write(path.join(repo, 'a.txt'), 'a2\n');
    c2 = fx.commitAll(repo, 'c2');
    fx.git(repo, ['switch', '-q', '-c', 'feature']);
    fx.write(path.join(repo, 'f.txt'), 'f1\n');
    f1 = fx.commitAll(repo, 'f1');
    fx.write(path.join(repo, 'f.txt'), 'f2\n');
    f2 = fx.commitAll(repo, 'f2');
    wt = locator(repo);
  });

  it('first sight on the default branch starts at HEAD', async () => {
    fx.git(repo, ['switch', '-q', 'main']);
    const range = await core.readReviewRange?.(wt, { bookmark: null });
    expect(range).toEqual({
      head: c2,
      startsAtHead: true,
      bookmarkReachable: false,
      initial: c2,
      base: c2,
      commits: [],
      truncated: false,
    });
    fx.git(repo, ['switch', '-q', 'feature']);
  });

  it('first sight on another branch starts at the merge-base', async () => {
    const range = await core.readReviewRange?.(wt, { bookmark: null, defaultBranch: 'main' });
    expect(range).toEqual({
      head: f2,
      startsAtHead: false,
      bookmarkReachable: false,
      initial: c2,
      base: c2,
      commits: [
        { sha: f2, parents: [f1] },
        { sha: f1, parents: [c2] },
      ],
      truncated: false,
    });
  });

  it('a reachable bookmark is the base', async () => {
    const range = await core.readReviewRange?.(wt, { bookmark: f1 });
    expect(range).toMatchObject({
      head: f2,
      bookmarkReachable: true,
      initial: null,
      base: f1,
      commits: [{ sha: f2, parents: [f1] }],
      truncated: false,
    });
    const atHead = await core.readReviewRange?.(wt, { bookmark: f2.toUpperCase() });
    expect(atHead).toMatchObject({ bookmarkReachable: true, base: f2, commits: [] });
  });

  it('truncates at maxCommits', async () => {
    const range = await core.readReviewRange?.(wt, { bookmark: c1, maxCommits: 2 });
    expect(range?.commits.map((commit) => commit.sha)).toEqual([f2, f1]);
    expect(range?.truncated).toBe(true);
    const all = await core.readReviewRange?.(wt, { bookmark: c1, maxCommits: 3 });
    expect(all?.commits.map((commit) => commit.sha)).toEqual([f2, f1, c2]);
    expect(all?.truncated).toBe(false);
  });

  it('falls back to the merge-base with the default branch when history was rewritten', async () => {
    const rewritten = fx.repo('range-rewrite', { files: { 'a.txt': 'a\n' } });
    const base = head(rewritten);
    fx.git(rewritten, ['switch', '-q', '-c', 'topic']);
    fx.write(path.join(rewritten, 't.txt'), 'old\n');
    const old = fx.commitAll(rewritten, 'old');
    fx.git(rewritten, ['reset', '-q', '--hard', base]);
    fx.write(path.join(rewritten, 't.txt'), 'new\n');
    const fresh = fx.commitAll(rewritten, 'new');
    const rwt = locator(rewritten);
    const range = await core.readReviewRange?.(rwt, { bookmark: old });
    expect(range).toEqual({
      head: fresh,
      startsAtHead: false,
      bookmarkReachable: false,
      initial: null,
      base,
      commits: [{ sha: fresh, parents: [base] }],
      truncated: false,
    });
    // An unknown bookmark (e.g. garbage-collected) is not an error.
    const unknown = await core.readReviewRange?.(rwt, { bookmark: 'ab'.repeat(20) });
    expect(unknown).toMatchObject({ bookmarkReachable: false, base, commits: [{ sha: fresh }] });

    // Rebase: same change on a moved main.
    fx.git(rewritten, ['switch', '-q', 'main']);
    fx.write(path.join(rewritten, 'm.txt'), 'm\n');
    const m = fx.commitAll(rewritten, 'main moves');
    fx.git(rewritten, ['switch', '-q', 'topic']);
    fx.git(rewritten, ['rebase', '-q', 'main']);
    const rebased = head(rewritten);
    const afterRebase = await core.readReviewRange?.(rwt, { bookmark: fresh });
    expect(afterRebase).toMatchObject({
      head: rebased,
      bookmarkReachable: false,
      base: m,
      commits: [{ sha: rebased, parents: [m] }],
    });

    // The default branch itself, reset back: merge-base(HEAD, bookmark).
    fx.git(rewritten, ['switch', '-q', 'main']);
    fx.git(rewritten, ['reset', '-q', '--hard', base]);
    fx.write(path.join(rewritten, 'n.txt'), 'n\n');
    const n = fx.commitAll(rewritten, 'main rewritten');
    const onMain = await core.readReviewRange?.(rwt, { bookmark: m });
    expect(onMain).toEqual({
      head: n,
      startsAtHead: true,
      bookmarkReachable: false,
      initial: null,
      base,
      commits: [{ sha: n, parents: [base] }],
      truncated: false,
    });
    // ...and HEAD when no merge-base can be computed.
    const lost = await core.readReviewRange?.(rwt, { bookmark: 'cd'.repeat(20) });
    expect(lost).toMatchObject({ base: n, commits: [], bookmarkReachable: false });
  });

  it('a detached HEAD starts at HEAD', async () => {
    const detached = path.join(fx.root, 'range-detached');
    fx.git(repo, ['worktree', 'add', '-q', '--detach', detached, f1]);
    const dwt = locator(detached, path.join(repo, '.git'));
    const range = await core.readReviewRange?.(dwt, { bookmark: null });
    expect(range).toMatchObject({ head: f1, startsAtHead: true, initial: f1, base: f1 });
    const rewound = await core.readReviewRange?.(dwt, { bookmark: f2 });
    expect(rewound).toMatchObject({ bookmarkReachable: false, base: f1, commits: [] });
  });

  it('an unborn branch has no range', async () => {
    const unborn = fx.repo('range-unborn', { empty: true });
    const range = await core.readReviewRange?.(locator(unborn), { bookmark: c1 });
    expect(range).toEqual({
      head: null,
      startsAtHead: false,
      bookmarkReachable: false,
      initial: null,
      base: null,
      commits: [],
      truncated: false,
    });
  });

  it('a branch without a default branch to compare with starts at HEAD', async () => {
    const lonely = fx.repo('range-lonely', { files: { 'a.txt': 'a\n' } });
    fx.git(lonely, ['branch', '-q', '-m', 'main', 'work']);
    const range = await core.readReviewRange?.(locator(lonely), { bookmark: null });
    expect(range).toMatchObject({ startsAtHead: false, initial: head(lonely), commits: [] });
  });

  it('validates its arguments', async () => {
    for (const options of [
      { bookmark: 'abc1234' },
      { bookmark: 'HEAD' },
      { bookmark: null, maxCommits: 0 },
      { bookmark: null, maxCommits: 1.5 },
    ]) {
      const error = await errorOf(Promise.resolve(core.readReviewRange?.(wt, options)));
      expect(isGitCoreError(error, 'invalid_argument'), JSON.stringify(options)).toBe(true);
    }
  });
});

describe('describeCommits and rangePatchId', () => {
  let repo: string;
  let wt: WorktreeLocator;

  beforeAll(() => {
    repo = fx.repo('describe', { files: { 'a.txt': lines(10, 'a'), 'b.txt': lines(10, 'b') } });
    wt = locator(repo);
  });

  async function describe1(sha: string) {
    const [details] = (await core.describeCommits?.(wt, [sha])) ?? [];
    return details;
  }

  it('lists both sides of renames, and patch-ids of root and normal commits', async () => {
    const root = head(repo);
    fx.git(repo, ['mv', 'a.txt', 'renamed.txt']);
    fx.write(path.join(repo, 'c.txt'), 'c\n');
    const renamed = fx.commitAll(repo, 'rename');
    const empty = fx.commitAll(repo, 'empty');
    const details = (await core.describeCommits?.(wt, [renamed, root, empty, renamed])) ?? [];
    expect(details.map((d) => d.sha)).toEqual([renamed, root, empty, renamed]);
    expect([...(details[0]?.paths ?? [])].sort()).toEqual(['a.txt', 'c.txt', 'renamed.txt']);
    expect([...(details[1]?.paths ?? [])].sort()).toEqual(['a.txt', 'b.txt']);
    expect(details[0]?.patchId).toMatch(/^[0-9a-f]{40}$/);
    expect(details[1]?.patchId).toMatch(/^[0-9a-f]{40}$/);
    expect(details[0]?.patchId).not.toBe(details[1]?.patchId);
    expect(details[2]).toEqual({ sha: empty, patchId: null, paths: [] });
    // Cached results are the same; upper-case input is normalized.
    expect(await core.describeCommits?.(wt, [renamed.toUpperCase()])).toEqual([details[0]]);
    expect(await core.describeCommits?.(wt, [])).toEqual([]);
    // rangePatchId of a single commit equals its patch-id.
    expect(await core.rangePatchId?.(wt, root, renamed)).toBe(details[0]?.patchId);
  });

  it('describes merges: clean → no paths, conflict resolution → the resolved path', async () => {
    fx.git(repo, ['switch', '-q', '-c', 'side']);
    fx.write(path.join(repo, 'b.txt'), lines(10, 'b').replace('b 2', 'side'));
    fx.commitAll(repo, 'side');
    fx.git(repo, ['switch', '-q', 'main']);
    fx.write(path.join(repo, 'm.txt'), 'm\n');
    fx.commitAll(repo, 'main');
    fx.git(repo, ['merge', '-q', '--no-edit', 'side']);
    const clean = head(repo);

    fx.git(repo, ['switch', '-q', 'side']);
    fx.write(path.join(repo, 'b.txt'), lines(10, 'b').replace('b 2', 'side').replace('b 9', 'S9'));
    fx.commitAll(repo, 'side 2');
    fx.git(repo, ['switch', '-q', 'main']);
    fx.write(path.join(repo, 'b.txt'), lines(10, 'b').replace('b 2', 'side').replace('b 9', 'M9'));
    fx.commitAll(repo, 'main 2');
    fx.git(repo, ['merge', '-q', '--no-edit', 'side'], { allowFail: true });
    fx.write(path.join(repo, 'b.txt'), lines(10, 'b').replace('b 2', 'side').replace('b 9', 'R9'));
    fx.git(repo, ['add', 'b.txt']);
    fx.git(repo, ['commit', '-q', '--no-edit']);
    const resolved = head(repo);

    const details = (await core.describeCommits?.(wt, [clean, resolved])) ?? [];
    expect(details).toEqual([
      { sha: clean, patchId: null, paths: [] },
      { sha: resolved, patchId: null, paths: ['b.txt'] },
    ]);
  });

  it('gives the same patch-id to a cherry-picked or rebased change', async () => {
    const start = head(repo);
    fx.git(repo, ['switch', '-q', '-c', 'pick-src', start]);
    fx.write(path.join(repo, 'a-pick.txt'), lines(5, 'pick'));
    fx.write(path.join(repo, 'b.txt'), `${fx.git(repo, ['show', 'HEAD:b.txt'])}tail\n`);
    const original = fx.commitAll(repo, 'pick me');
    fx.git(repo, ['switch', '-q', 'main']);
    fx.write(path.join(repo, 'other.txt'), 'other\n');
    fx.commitAll(repo, 'other');
    fx.git(repo, ['cherry-pick', original]);
    const picked = head(repo);
    expect(picked).not.toBe(original);

    fx.git(repo, ['switch', '-q', 'pick-src']);
    fx.git(repo, ['rebase', '-q', 'main~1']);
    const rebasedOnto = head(repo);

    const ids = ((await core.describeCommits?.(wt, [original, picked])) ?? []).map(
      (d) => d.patchId,
    );
    expect(ids[0]).toMatch(/^[0-9a-f]{40}$/);
    expect(ids[1]).toBe(ids[0]);
    expect((await describe1(rebasedOnto))?.patchId).toBe(ids[0]);
    fx.git(repo, ['switch', '-q', 'main']);
  });

  it('rejects unknown and malformed commit ids', async () => {
    const unknown = await errorOf(Promise.resolve(core.describeCommits?.(wt, ['ab'.repeat(20)])));
    expect(isGitCoreError(unknown, 'not_found')).toBe(true);
    const tree = head(repo, 'HEAD^{tree}');
    const notCommit = await errorOf(Promise.resolve(core.describeCommits?.(wt, [tree])));
    expect(isGitCoreError(notCommit, 'not_found')).toBe(true);
    for (const bad of ['abc1234', 'HEAD', '--all', `${'a'.repeat(39)}g`]) {
      const error = await errorOf(Promise.resolve(core.describeCommits?.(wt, [bad])));
      expect(isGitCoreError(error, 'invalid_argument'), bad).toBe(true);
    }
    const range = await errorOf(Promise.resolve(core.rangePatchId?.(wt, 'HEAD', head(repo))));
    expect(isGitCoreError(range, 'invalid_argument')).toBe(true);
    const missing = await errorOf(
      Promise.resolve(core.rangePatchId?.(wt, 'ab'.repeat(20), head(repo))),
    );
    expect(isGitCoreError(missing, 'not_found')).toBe(true);
  });

  it('rangePatchId equals the patch-id of a squash merge of the range', async () => {
    const squash = fx.repo('squash', { files: { 's.txt': lines(10, 's'), 'k.txt': 'k\n' } });
    const swt = locator(squash);
    const base = head(squash);
    fx.git(squash, ['switch', '-q', '-c', 'topic']);
    fx.write(path.join(squash, 's.txt'), lines(10, 's').replace('s 3', 'three'));
    fx.write(path.join(squash, 'new.txt'), 'new\n');
    fx.commitAll(squash, 'one');
    fx.write(
      path.join(squash, 's.txt'),
      lines(10, 's').replace('s 3', 'three').replace('s 8', 'E'),
    );
    fx.git(squash, ['mv', 'k.txt', 'k2.txt']);
    const tip = fx.commitAll(squash, 'two');
    fx.git(squash, ['switch', '-q', 'main']);
    fx.git(squash, ['merge', '-q', '--squash', 'topic']);
    fx.git(squash, ['commit', '-q', '-m', 'squashed']);
    const squashed = head(squash);

    const rangeId = await core.rangePatchId?.(swt, base, tip);
    expect(rangeId).toMatch(/^[0-9a-f]{40}$/);
    const [details] = (await core.describeCommits?.(swt, [squashed])) ?? [];
    expect(details?.patchId).toBe(rangeId);
    expect([...(details?.paths ?? [])].sort()).toEqual(['k.txt', 'k2.txt', 'new.txt', 's.txt']);

    // Repository config cannot change patch-ids (`patchid.verbatim` keeps whitespace).
    fx.git(squash, ['config', 'patchid.verbatim', 'true']);
    expect(await core.rangePatchId?.(swt, base, tip)).toBe(rangeId);
    fx.git(squash, ['config', '--unset', 'patchid.verbatim']);

    // Empty ranges: the same commit, or a change and its revert.
    expect(await core.rangePatchId?.(swt, tip, tip)).toBeNull();
    expect(await core.rangePatchId?.(swt, tip, tip.slice(0, 12))).toBeNull();
    fx.git(squash, ['revert', '--no-edit', 'HEAD']);
    expect(await core.rangePatchId?.(swt, squashed, head(squash))).not.toBeNull();
    expect(await core.rangePatchId?.(swt, base, head(squash))).toBeNull();
  });
});

describe('parseCommitPaths', () => {
  it('parses single-parent and merge records', () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const c = 'c'.repeat(40);
    const output = [
      `\u0001${a} ${b}\u0000\nx.txt\u0000dir/y\u0000`,
      `\u0001${b} ${c} ${a}\u0000\u0000\nleading-newline\u0000`,
      `\u0001${c} \u0000`,
      `\u0001${'d'.repeat(40)} ${a} ${b}\u0000\u0000`,
    ].join('');
    const parsed = parseCommitPaths(output);
    expect(parsed.get(a)).toEqual({ parents: [b], paths: ['x.txt', 'dir/y'] });
    expect(parsed.get(b)).toEqual({ parents: [c, a], paths: ['\nleading-newline'] });
    expect(parsed.get(c)).toEqual({ parents: [], paths: [] });
    expect(parsed.get('d'.repeat(40))).toEqual({ parents: [a, b], paths: [] });
  });

  it('returns non-UTF-8 paths as base64 (review-mark form)', () => {
    const raw = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('latin1');
    const parsed = parseCommitPaths(`\u0001${'a'.repeat(40)}\u0000\n${raw}\u0000`);
    expect(parsed.get('a'.repeat(40))?.paths).toEqual([
      Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64'),
    ]);
  });
});
