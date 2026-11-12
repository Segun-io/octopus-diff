/**
 * Live feed, git-core side (#37): the per-file snapshot `getSummary` can return from the status
 * and numstat it already runs (zero extra git processes, the default result untouched), and the
 * size-capped blob read by object id (so a deleted file's last content stays readable).
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  BLOB_MAX_BYTES_DEFAULT,
  BlobReadSchema,
  type GitCore,
  isGitCoreError,
  type SummarySnapshotEntry,
  SummarySnapshotSchema,
  type WorktreeLocator,
} from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore } from '../src/index.js';
import { locator } from './helpers/core.js';
import { createFixture, type Fixture, lines, RAW_NAMES_SUPPORTED } from './helpers/fixture.js';

let fx: Fixture;

/** A git wrapper that logs each process's argv (one file per process), see git-metadata.test.ts. */
function spawnLog(name: string) {
  const dir = path.join(fx.root, `${name}.spawns`);
  mkdirSync(dir, { recursive: true });
  const wrapper = path.join(fx.root, `${name}.sh`);
  writeFileSync(
    wrapper,
    `#!/bin/sh\nf=$(mktemp '${dir}/XXXXXXXX')\nfor a in "$@"; do printf '%s\\001' "$a" >> "$f"; done\nexec git "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  const seen = new Set<string>();
  /** The argv (without the runner's global options) of the processes since the last `take()`. */
  const take = (): string[][] =>
    readdirSync(dir)
      .filter((file) => !seen.has(file))
      .map((file) => {
        seen.add(file);
        const args = readFileSync(path.join(dir, file), 'utf8')
          .split('\u0001')
          .filter((a) => a.length > 0);
        let i = 0;
        while (i < args.length) {
          const a = args[i] as string;
          if (a === '-c' || a === '-C') i += 2;
          else if (a.startsWith('-')) i += 1;
          else break;
        }
        return args.slice(i);
      });
  return { wrapper, take };
}

const subs = (spawned: string[][]): string[] => spawned.map((args) => args[0] as string).sort();

const git = (cwd: string, args: string[]) => fx.git(cwd, args).trim();

beforeAll(() => {
  fx = createFixture();
});

afterAll(() => {
  fx?.dispose();
});

function byPath(entries: readonly SummarySnapshotEntry[]): Map<string, SummarySnapshotEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

describe('getSummary snapshot', () => {
  let repo: string;
  let wt: WorktreeLocator;
  let core: GitCore;
  let spawns: ReturnType<typeof spawnLog>;
  const oid: Record<string, string> = {};

  beforeAll(() => {
    repo = fx.repo('snap', {
      files: {
        'a.txt': lines(20),
        'b.txt': 'to delete\n',
        'c.txt': 'to rename, with some content\nover two lines\n',
        'f.txt': 'staged delete\n',
        'g.txt': 'one\n',
        'bin.dat': Buffer.from([0, 1, 2, 3]).toString('latin1'),
        'keep.txt': 'unchanged\n',
      },
    });
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'f.txt', 'g.txt']) {
      oid[name] = git(repo, ['rev-parse', `HEAD:${name}`]);
    }
    fx.write(path.join(repo, 'a.txt'), lines(20).replace('line 7', 'seven'));
    unlinkSync(path.join(repo, 'b.txt'));
    git(repo, ['mv', 'c.txt', 'c2.txt']);
    git(repo, ['rm', '-q', 'f.txt']);
    fx.write(path.join(repo, 'added.txt'), 'new\nfile\n');
    git(repo, ['add', 'added.txt']);
    fx.write(path.join(repo, 'g.txt'), 'one\ntwo\nthree\n');
    git(repo, ['add', 'g.txt']);
    fx.write(path.join(repo, 'g.txt'), 'one\ntwo\nthree\nfour\n');
    fx.write(path.join(repo, 'bin.dat'), Buffer.from([0, 9, 9, 9, 9]));
    fx.write(path.join(repo, 'untracked.txt'), 'u1\nu2\nu3\n');
    fx.write(path.join(repo, 'dir', 'deep.txt'), 'deep\n');
    spawns = spawnLog('snap');
    core = createGitCore(fx.coreOptions({ gitBinary: spawns.wrapper }));
    wt = locator(repo, path.join(repo, '.git'));
  });

  afterAll(async () => {
    await core?.dispose();
  });

  it('lists every changed path with status, oids, signature and counts', async () => {
    const summary = await core.getSummary(wt, { snapshot: true });
    const snapshot = SummarySnapshotSchema.parse(summary.snapshot);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.total).toBe(snapshot.entries.length);
    const entries = byPath(snapshot.entries);
    expect([...entries.keys()].sort()).toEqual([
      'a.txt',
      'added.txt',
      'b.txt',
      'bin.dat',
      'c2.txt',
      'dir/deep.txt',
      'f.txt',
      'g.txt',
      'untracked.txt',
    ]);

    // modified in the worktree
    expect(entries.get('a.txt')).toMatchObject({
      xy: '.M',
      hH: oid['a.txt'],
      hI: oid['a.txt'],
      added: 1,
      deleted: 1,
    });
    // deleted in the worktree: the blob that is gone comes from hI (and hH)
    expect(entries.get('b.txt')).toMatchObject({
      xy: '.D',
      hH: oid['b.txt'],
      hI: oid['b.txt'],
      sig: 'missing',
      added: 0,
      deleted: 1,
    });
    // staged delete: only HEAD has the blob
    expect(entries.get('f.txt')).toMatchObject({
      xy: 'D.',
      hH: oid['f.txt'],
      hI: null,
      sig: 'missing',
      added: 0,
      deleted: 1,
    });
    // renamed in the index
    expect(entries.get('c2.txt')).toMatchObject({
      xy: 'R.',
      oldPath: 'c.txt',
      hH: oid['c.txt'],
      hI: oid['c.txt'],
    });
    expect(entries.get('c2.txt')?.rawPath).toBeUndefined();
    // added to the index: not in HEAD
    expect(entries.get('added.txt')).toMatchObject({
      xy: 'A.',
      hH: null,
      hI: git(repo, ['rev-parse', ':added.txt']),
      added: 2,
      deleted: 0,
    });
    // staged and then modified again: HEAD, index and worktree all differ
    expect(entries.get('g.txt')).toMatchObject({
      xy: 'MM',
      hH: oid['g.txt'],
      hI: git(repo, ['rev-parse', ':g.txt']),
      added: 3,
      deleted: 0,
    });
    expect(entries.get('g.txt')?.hI).not.toBe(oid['g.txt']);
    // binary: no line counts
    expect(entries.get('bin.dat')).toMatchObject({ xy: '.M', added: null, deleted: null });
    // untracked: no oids (git has no object for them), counts from the file read
    expect(entries.get('untracked.txt')).toMatchObject({
      xy: '??',
      hH: null,
      hI: null,
      added: 3,
      deleted: 0,
    });
    expect(entries.get('dir/deep.txt')).toMatchObject({ xy: '??', added: 1 });
    // the summary's own totals agree
    expect(summary.changedFiles).toBe(snapshot.entries.length);
    // Tracked entries come before untracked ones.
    const firstUntracked = snapshot.entries.findIndex((entry) => entry.xy === '??');
    expect(snapshot.entries.slice(firstUntracked).every((entry) => entry.xy === '??')).toBe(true);
  });

  it('carries the signature that stateHash covers: stable, and changed by an edit', async () => {
    const first = (await core.getSummary(wt, { snapshot: true })).snapshot;
    const again = (await core.getSummary(wt, { snapshot: true })).snapshot;
    expect(again).toEqual(first);
    const before = byPath(first?.entries ?? []);
    expect(before.get('a.txt')?.sig).toMatch(/^\d+:\d+:\d+:\d+:\d+$/);
    expect(before.get('untracked.txt')?.sig).toMatch(/^\d+:\d+:\d+:\d+:\d+$/);
    const future = new Date(Date.now() + 5000);
    utimesSync(path.join(repo, 'a.txt'), future, future);
    utimesSync(path.join(repo, 'untracked.txt'), future, future);
    const after = byPath((await core.getSummary(wt, { snapshot: true })).snapshot?.entries ?? []);
    expect(after.get('a.txt')?.sig).not.toBe(before.get('a.txt')?.sig);
    expect(after.get('untracked.txt')?.sig).not.toBe(before.get('untracked.txt')?.sig);
    expect(after.get('b.txt')?.sig).toBe(before.get('b.txt')?.sig);
  });

  it('costs no extra git process, and the default result has no snapshot key', async () => {
    // Warm up until a call no longer reads the config: the scan git-core reuses is not stored while
    // a config file is younger than 2 s (the racy guard, DECISIONS #191), and this fixture wrote
    // config a moment ago, so the first call after that window costs one `config` read, once. The
    // spawns of the calls below are then comparable (macOS CI: `expected [diff, status] to equal
    // [config, diff, status]`).
    for (let attempt = 0; attempt < 15; attempt++) {
      spawns.take();
      await core.getSummary(wt);
      if (!subs(spawns.take()).includes('config')) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const plain = await core.getSummary(wt);
    const plainSpawns = subs(spawns.take());
    const withSnapshot = await core.getSummary(wt, { snapshot: true });
    const snapshotSpawns = subs(spawns.take());
    const capped = await core.getSummary(wt, { snapshot: { maxEntries: 3 } });
    const cappedSpawns = subs(spawns.take());
    expect(plainSpawns.length).toBeGreaterThan(0);
    expect(plainSpawns).toContain('status');
    expect(snapshotSpawns).toEqual(plainSpawns);
    expect(cappedSpawns).toEqual(plainSpawns);
    // Same summary, field for field (the timestamp aside); the default one gained nothing.
    expect('snapshot' in plain).toBe(false);
    expect(Object.keys(plain)).toEqual(Object.keys(withSnapshot).filter((k) => k !== 'snapshot'));
    // `activityAt` is clamped to now, as `updatedAt` is: two calls differ by milliseconds.
    const { snapshot, updatedAt: _u1, activityAt: _a1, ...rest } = withSnapshot;
    const { updatedAt: _u2, activityAt: _a2, ...plainRest } = plain;
    expect(snapshot).toBeDefined();
    expect(rest).toEqual(plainRest);
    expect('snapshot' in (await core.getSummary(wt, { snapshot: false }))).toBe(false);
    expect(JSON.stringify(plain)).not.toContain('snapshot');
    expect(capped.stateHash).toBe(plain.stateHash);
  });

  it('caps the entries, tracked ones first, and says so', async () => {
    const capped = (await core.getSummary(wt, { snapshot: { maxEntries: 3 } })).snapshot;
    expect(capped?.entries).toHaveLength(3);
    expect(capped?.total).toBe(9);
    expect(capped?.truncated).toBe(true);
    expect(capped?.entries.every((entry) => entry.xy !== '??')).toBe(true);
    const exact = (await core.getSummary(wt, { snapshot: { maxEntries: 9 } })).snapshot;
    expect(exact).toMatchObject({ total: 9, truncated: false });
    expect(exact?.entries).toHaveLength(9);
  });

  it('rejects a malformed snapshot option before reading any field (PR #70 review)', async () => {
    for (const snapshot of [null, 5, 'yes', [], { max: 10 }, { maxEntries: '10' }]) {
      const error = await core
        .getSummary(wt, { snapshot: snapshot as never })
        .catch((e: unknown) => e);
      expect(isGitCoreError(error, 'invalid_argument'), JSON.stringify(snapshot)).toBe(true);
    }
    // Still fine: the documented shapes, and `false` (no snapshot).
    expect((await core.getSummary(wt, { snapshot: false })).snapshot).toBeUndefined();
    expect((await core.getSummary(wt, { snapshot: {} })).snapshot?.entries.length).toBeGreaterThan(
      0,
    );
  });

  it('rejects a cap outside 1..20000', async () => {
    for (const maxEntries of [0, -1, 1.5, 20_001, Number.NaN]) {
      const error = await core.getSummary(wt, { snapshot: { maxEntries } }).catch((e) => e);
      expect(isGitCoreError(error, 'invalid_argument'), String(maxEntries)).toBe(true);
    }
  });

  it('a clean worktree has an empty snapshot; a bare repository too', async () => {
    const clean = fx.repo('snap-clean', { files: { 'a.txt': 'a\n' } });
    const summary = await core.getSummary(locator(clean, path.join(clean, '.git')), {
      snapshot: true,
    });
    expect(summary.snapshot).toEqual({
      entries: [],
      total: 0,
      truncated: false,
      contentHash: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    const bare = path.join(fx.root, 'snap-bare.git');
    fx.git(fx.root, ['clone', '-q', '--bare', clean, bare]);
    const bareSummary = await core.getSummary(locator(bare), { snapshot: true });
    expect(bareSummary.snapshot).toEqual({ entries: [], total: 0, truncated: false });
    expect('snapshot' in (await core.getSummary(locator(bare)))).toBe(false);
  });

  it.skipIf(!RAW_NAMES_SUPPORTED)('keeps names that are not UTF-8 as rawPath', async () => {
    const dir = fx.repo('snap-raw', { files: { 'a.txt': 'a\n' } });
    fx.writeRaw(dir, Buffer.from([0x78, 0xff, 0x2e, 0x74]), 'raw\n');
    const summary = await core.getSummary(locator(dir, path.join(dir, '.git')), {
      snapshot: true,
    });
    const [entry] = summary.snapshot?.entries ?? [];
    expect(entry?.xy).toBe('??');
    expect(entry?.rawPath).toBe(Buffer.from([0x78, 0xff, 0x2e, 0x74]).toString('base64'));
    expect(entry?.path).toContain('�');
  });

  it('keeps a 30k-untracked worktree bounded', async () => {
    const dir = fx.repo('snap-many', { files: { 'a.txt': 'a\n' } });
    for (let i = 0; i < 100; i += 1) {
      for (let j = 0; j < 300; j += 1) {
        mkdirSync(path.join(dir, `d${i}`), { recursive: true });
        writeFileSync(path.join(dir, `d${i}`, `f${j}.txt`), '');
      }
    }
    fx.write(path.join(dir, 'a.txt'), 'changed\n');
    const many = locator(dir, path.join(dir, '.git'));
    const summary = await core.getSummary(many, { snapshot: true });
    expect(summary.snapshot?.total).toBe(30_001);
    expect(summary.snapshot?.entries).toHaveLength(2000);
    expect(summary.snapshot?.truncated).toBe(true);
    // The tracked change is never cut off by the untracked flood.
    expect(summary.snapshot?.entries[0]).toMatchObject({ path: 'a.txt', xy: '.M' });
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});

describe('getSummary snapshot: one entry per path (PR #70 review)', () => {
  it('a file removed from the index but still on disk appears once, as the staged deletion', async () => {
    const repo = fx.repo('snap-uncached', { files: { 'f.txt': 'content\n', 'keep.txt': 'k\n' } });
    const blob = git(repo, ['rev-parse', 'HEAD:f.txt']);
    git(repo, ['rm', '-q', '--cached', 'f.txt']);
    const core = createGitCore(fx.coreOptions());
    try {
      const wt = locator(repo, path.join(repo, '.git'));
      const snapshot = (await core.getSummary(wt, { snapshot: true })).snapshot;
      const entries = snapshot?.entries.filter((entry) => entry.path === 'f.txt') ?? [];
      // Keyed by path, nothing is lost or overwritten: one entry, the deletion with its blob.
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ xy: 'D.', hH: blob, hI: null });
      expect(snapshot?.total).toBe(1);
      expect(new Set(snapshot?.entries.map((entry) => entry.path)).size).toBe(
        snapshot?.entries.length,
      );
      // The cap counts it once too.
      const capped = (await core.getSummary(wt, { snapshot: { maxEntries: 1 } })).snapshot;
      expect(capped).toMatchObject({ total: 1, truncated: false });
    } finally {
      await core.dispose();
    }
  });
});

describe('readBlob', () => {
  let repo: string;
  let wt: WorktreeLocator;
  let core: GitCore;
  let spawns: ReturnType<typeof spawnLog>;
  const secret = 'API_KEY=1234\nline two\n';

  const read = (options: Parameters<NonNullable<GitCore['readBlob']>>[1]) =>
    (core.readBlob as NonNullable<GitCore['readBlob']>)(wt, options);
  const reject = async (options: unknown) =>
    ((await read(options as never).then(
      () => null,
      (error: unknown) => error,
    )) ?? null) as { code?: string } | null;

  beforeAll(() => {
    repo = fx.repo('blob', {
      files: {
        'gone.txt': secret,
        'keep.txt': 'keep\n',
        'big.txt': 'x'.repeat(5000),
        'bin.dat': 'head\u0000tail',
        'late-nul.txt': `${'a'.repeat(9000)}\u0000z`,
        'empty.txt': '',
        'latin1.txt': 'café x\n',
      },
    });
    spawns = spawnLog('blob');
    core = createGitCore(fx.coreOptions({ gitBinary: spawns.wrapper }));
    wt = locator(repo, path.join(repo, '.git'));
  });

  afterAll(async () => {
    await core?.dispose();
  });

  it('reads a deleted tracked file by the oid status gave, before and after a commit', async () => {
    unlinkSync(path.join(repo, 'gone.txt'));
    const snapshot = (await core.getSummary(wt, { snapshot: true })).snapshot;
    const entry = snapshot?.entries.find((e) => e.path === 'gone.txt');
    expect(entry).toMatchObject({ xy: '.D' });
    const oid = entry?.hI as string;
    expect(oid).toBe(git(repo, ['rev-parse', 'HEAD:gone.txt']));

    const before = BlobReadSchema.parse(await read({ oid }));
    expect(before).toEqual({
      oid,
      kind: 'text',
      size: Buffer.byteLength(secret),
      maxBytes: BLOB_MAX_BYTES_DEFAULT,
      content: secret,
    });

    // Staged delete (`D.`): only hH has it.
    git(repo, ['rm', '-q', '--cached', 'gone.txt']);
    const staged = (await core.getSummary(wt, { snapshot: true })).snapshot?.entries.find(
      (e) => e.path === 'gone.txt',
    );
    expect(staged).toMatchObject({ xy: 'D.', hH: oid, hI: null });
    expect((await read({ oid: staged?.hH as string })).content).toBe(secret);

    // Committed: the file leaves the summary, the content is still there.
    git(repo, ['commit', '-q', '-m', 'delete gone.txt']);
    const after = await core.getSummary(wt, { snapshot: true });
    expect(after.snapshot?.entries.find((e) => e.path === 'gone.txt')).toBeUndefined();
    expect((await read({ oid })).content).toBe(secret);
    // ... and after a hard reset of that commit away.
    git(repo, ['reset', '-q', '--hard', 'HEAD~1']);
    git(repo, ['reset', '-q', '--hard', 'HEAD~0']);
    expect((await read({ oid })).content).toBe(secret);
    git(repo, ['reset', '-q', '--hard', 'main']);
  });

  it('reads the content of a file that was staged and unstaged (unreferenced, until gc)', async () => {
    fx.write(path.join(repo, 'staged-once.txt'), 'staged once\n');
    git(repo, ['add', 'staged-once.txt']);
    const staged = (await core.getSummary(wt, { snapshot: true })).snapshot?.entries.find(
      (e) => e.path === 'staged-once.txt',
    );
    expect(staged).toMatchObject({ xy: 'A.', hH: null });
    git(repo, ['rm', '-q', '--cached', 'staged-once.txt']);
    unlinkSync(path.join(repo, 'staged-once.txt'));
    expect((await read({ oid: staged?.hI as string })).content).toBe('staged once\n');
  });

  it('runs cat-file -t then cat-file blob, and nothing else', async () => {
    const oid = git(repo, ['rev-parse', 'HEAD:keep.txt']);
    spawns.take();
    expect((await read({ oid })).content).toBe('keep\n');
    expect(
      spawns
        .take()
        .map((args) => args.join(' '))
        .sort(),
    ).toEqual([`cat-file -t ${oid}`, `cat-file blob ${oid}`].sort());
  });

  it('refuses anything that is not a full oid, without starting git', async () => {
    const full = git(repo, ['rev-parse', 'HEAD:keep.txt']);
    spawns.take();
    for (const bad of [
      '',
      'HEAD',
      'HEAD:keep.txt',
      'main',
      full.slice(0, 7),
      full.slice(0, 39),
      `${full}0`,
      full.toUpperCase(),
      `-${full.slice(1)}`,
      '--batch',
      '0'.repeat(40),
      `${full}\n`,
      `${full} HEAD`,
      42,
      null,
      undefined,
    ]) {
      const error = await reject({ oid: bad });
      expect(error?.code, JSON.stringify(bad)).toBe('invalid_argument');
    }
    for (const maxBytes of [0, -5, 1.5, 17 * 1024 * 1024, Number.NaN]) {
      expect((await reject({ oid: full, maxBytes }))?.code, String(maxBytes)).toBe(
        'invalid_argument',
      );
    }
    expect((await reject(undefined))?.code).toBe('invalid_argument');
    expect(spawns.take()).toEqual([]);
  });

  it('refuses objects that are not blobs', async () => {
    git(repo, ['tag', '-a', '-m', 'annotated', 'v1']);
    const objects = {
      tree: git(repo, ['rev-parse', 'HEAD^{tree}']),
      commit: git(repo, ['rev-parse', 'HEAD']),
      tag: git(repo, ['rev-parse', 'v1']),
    };
    for (const [type, oid] of Object.entries(objects)) {
      spawns.take();
      const error = (await reject({ oid })) as { code?: string; message?: string };
      expect(error.code, type).toBe('invalid_argument');
      expect(error.message).toContain(type);
      // Refused after one cat-file -t: the content is never read.
      expect(spawns.take().map((args) => args.slice(0, 2).join(' '))).toEqual(['cat-file -t']);
    }
  });

  it('says not_found for an object the repository does not have', async () => {
    expect((await reject({ oid: 'ab'.repeat(20) }))?.code).toBe('not_found');
    expect((await reject({ oid: 'cd'.repeat(32) }))?.code).toBe('not_found');
    // The hash of a file that was only ever in the working tree is not an object: untracked
    // content cannot be read from here.
    fx.write(path.join(repo, 'untracked-secret.txt'), 'only on disk\n');
    const hash = git(repo, ['hash-object', 'untracked-secret.txt']);
    expect((await reject({ oid: hash }))?.code).toBe('not_found');
    const snapshot = (await core.getSummary(wt, { snapshot: true })).snapshot;
    const entry = snapshot?.entries.find((e) => e.path === 'untracked-secret.txt');
    expect(entry).toMatchObject({ xy: '??', hH: null, hI: null });
    unlinkSync(path.join(repo, 'untracked-secret.txt'));
  });

  it('flags a blob over the cap as too large, with its size, and returns no bytes', async () => {
    const oid = git(repo, ['rev-parse', 'HEAD:big.txt']);
    spawns.take();
    const result = BlobReadSchema.parse(await read({ oid, maxBytes: 1000 }));
    expect(result).toEqual({ oid, kind: 'too_large', size: 5000, maxBytes: 1000, content: null });
    expect(
      spawns
        .take()
        .map((args) => args.slice(0, 2).join(' '))
        .sort(),
    ).toEqual(['cat-file -t', 'cat-file blob', 'cat-file -s'].sort());
    // Exactly at the cap is fine; one byte under it is too.
    expect(await read({ oid, maxBytes: 5000 })).toMatchObject({ kind: 'text', size: 5000 });
    expect(await read({ oid, maxBytes: 4999 })).toMatchObject({ kind: 'too_large', size: 5000 });
  });

  it('defaults the cap to 1 MiB', async () => {
    const exact = fx.repo('blob-cap', {
      files: {
        'exact.txt': 'a'.repeat(BLOB_MAX_BYTES_DEFAULT),
        'over.txt': 'a'.repeat(BLOB_MAX_BYTES_DEFAULT + 1),
      },
    });
    const w = locator(exact, path.join(exact, '.git'));
    const readHere = core.readBlob as NonNullable<GitCore['readBlob']>;
    const exactResult = await readHere(w, { oid: git(exact, ['rev-parse', 'HEAD:exact.txt']) });
    expect(exactResult).toMatchObject({ kind: 'text', size: BLOB_MAX_BYTES_DEFAULT });
    expect(exactResult.content).toHaveLength(BLOB_MAX_BYTES_DEFAULT);
    const over = await readHere(w, { oid: git(exact, ['rev-parse', 'HEAD:over.txt']) });
    expect(over).toMatchObject({
      kind: 'too_large',
      size: BLOB_MAX_BYTES_DEFAULT + 1,
      maxBytes: BLOB_MAX_BYTES_DEFAULT,
      content: null,
    });
  });

  it('flags binary content and sends no bytes', async () => {
    const binary = await read({ oid: git(repo, ['rev-parse', 'HEAD:bin.dat']) });
    expect(BlobReadSchema.parse(binary)).toMatchObject({ kind: 'binary', size: 9, content: null });
    // git's heuristic looks at the first 8000 bytes only.
    const late = await read({ oid: git(repo, ['rev-parse', 'HEAD:late-nul.txt']) });
    expect(late).toMatchObject({ kind: 'text', size: 9002 });
  });

  it('handles an empty blob and decodes invalid UTF-8 lossily', async () => {
    expect(await read({ oid: git(repo, ['rev-parse', 'HEAD:empty.txt']) })).toMatchObject({
      kind: 'text',
      size: 0,
      content: '',
    });
    const oid = fx.git(repo, ['hash-object', '-w', '--stdin'], { input: 'café\n' }).trim();
    expect((await read({ oid })).content).toBe('café\n');
    const raw = spawnSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repo,
      env: { ...process.env, ...fx.env },
      input: Buffer.from([0x63, 0xe9, 0x0a]),
    });
    const latin = await read({ oid: raw.stdout.toString().trim() });
    expect(latin).toMatchObject({ kind: 'text', size: 3, content: 'c�\n' });
  });

  it('is unaffected by repository config that rewrites content on read', async () => {
    const dir = fx.repo('blob-filter', {
      files: { '.gitattributes': '*.txt filter=evil text eol=crlf\n', 'a.txt': 'line\n' },
    });
    const marker = path.join(fx.root, 'filter-ran');
    git(dir, ['config', 'filter.evil.smudge', `touch ${marker}; cat`]);
    git(dir, ['config', 'filter.evil.clean', `touch ${marker}; cat`]);
    git(dir, ['config', 'core.fsmonitor', `touch ${marker}`]);
    git(dir, ['config', 'diff.evil.textconv', `touch ${marker}; cat`]);
    rmSync(marker, { force: true });
    const result = await (core.readBlob as NonNullable<GitCore['readBlob']>)(
      locator(dir, path.join(dir, '.git')),
      { oid: git(dir, ['rev-parse', 'HEAD:a.txt']) },
    );
    expect(result.content).toBe('line\n');
    expect(() => readFileSync(marker)).toThrow();
  });

  it('rejects after dispose', async () => {
    const own = createGitCore(fx.coreOptions());
    await own.dispose();
    const error = await (own.readBlob as NonNullable<GitCore['readBlob']>)(wt, {
      oid: 'a'.repeat(40),
    }).catch((e: unknown) => e);
    expect(isGitCoreError(error, 'disposed')).toBe(true);
  });
});

describe('snapshot contentHash (PR #77 review)', () => {
  it('moves with a changed path, beyond the cap too, and not with refs', async () => {
    const repo = fx.repo('snap-hash', {
      files: { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' },
    });
    const bare = path.join(fx.root, 'snap-hash-remote.git');
    git(fx.root, ['init', '-q', '--bare', '-b', 'main', bare]);
    git(repo, ['remote', 'add', 'origin', bare]);
    git(repo, ['push', '-q', '-u', 'origin', 'main']);
    fx.write(path.join(repo, 'a.txt'), 'a1\n');
    fx.write(path.join(repo, 'b.txt'), 'b1\n');
    fx.write(path.join(repo, 'c.txt'), 'c1\n');
    const core = createGitCore(fx.coreOptions());
    try {
      const wt = locator(repo, path.join(repo, '.git'));
      const hash = async (maxEntries: number): Promise<string | undefined> =>
        (await core.getSummary(wt, { snapshot: { maxEntries } })).snapshot?.contentHash;
      const first = await hash(1);
      expect(first).toMatch(/^[0-9a-f]{32}$/);
      expect(await hash(1)).toBe(first);
      // The cap does not change what it covers.
      expect(await hash(10)).toBe(first);

      // Another clone pushes, this one fetches: the status header (ahead/behind) and the summary's
      // stateHash move, the files do not.
      const other = path.join(fx.root, 'snap-hash-other');
      git(fx.root, ['clone', '-q', bare, other]);
      fx.write(path.join(other, 'z.txt'), 'z\n');
      git(other, ['add', '-A']);
      git(other, ['commit', '-q', '-m', 'elsewhere']);
      git(other, ['push', '-q', 'origin', 'main']);
      const stateBefore = (await core.getSummary(wt)).stateHash;
      git(repo, ['fetch', '-q', 'origin']);
      expect((await core.getSummary(wt)).stateHash).not.toBe(stateBefore);
      expect(await hash(1)).toBe(first);

      // Staging is not an edit: the status letters and the index object id change, the file does not.
      git(repo, ['add', 'a.txt', 'b.txt', 'c.txt']);
      expect(await hash(1)).toBe(first);

      // An edit to a path the cap cut off moves it (the retained entry and `total` do not change).
      const kept = (await core.getSummary(wt, { snapshot: { maxEntries: 1 } })).snapshot;
      const beyond = ['a.txt', 'b.txt', 'c.txt'].filter((n) => n !== kept?.entries[0]?.path)[1];
      fx.write(path.join(repo, beyond as string), 'edited\nmore\n');
      expect(await hash(1)).not.toBe(first);
    } finally {
      await core.dispose();
    }
  });
});
