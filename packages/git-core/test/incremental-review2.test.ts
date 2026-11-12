/**
 * PR #89, second review: read signatures survive list updates (F1), a forgotten state never
 * takes a list stored for the old one (F2), and an untrusted index cannot hang a summary (F3).
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { DiffScope, GitCore } from '@octopus-diff/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { listLimits, listRefreshCounts } from '../src/diff.js';
import { indexHasGitlinks, stampReads } from '../src/incremental.js';
import { createGitCore } from '../src/index.js';
import { locator } from './helpers/core.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

let fx: Fixture;
let reference: GitCore;

beforeAll(() => {
  fx = createFixture('octopus-diff-incr2-');
  reference = createGitCore(fx.coreOptions({ incremental: false }));
});

afterAll(async () => {
  await reference.dispose();
  fx.dispose();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('F1: rows kept by a list update keep their read signatures', () => {
  it('a committed file read mid-edit by a seed survives an update, then a blind summary', async () => {
    const repo = fx.repo('f1', { files: { 'c.txt': 'c\n', 'd.txt': 'd\n' } });
    const base = fx.git(repo, ['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(repo, 'c.txt'), 'c changed in a commit\n');
    fx.commitAll(repo, 'change c');
    const scope: DiffScope = { kind: 'review', base };
    const core = createGitCore(fx.coreOptions());
    try {
      const wt = locator(repo);
      const s1 = await core.getSummary(wt);
      // Mid-edit, and never named by any hint.
      writeFileSync(path.join(repo, 'c.txt'), 'c changed in a commit\nand edited\n');
      await core.listChangedFiles(wt, scope, { summaryState: s1.stateHash }); // seed reads it
      writeFileSync(path.join(repo, 'd.txt'), 'd edited\n');
      const s2 = await core.getSummary(wt, { changedPaths: ['d.txt'] });
      await core.listChangedFiles(wt, scope, { summaryState: s2.stateHash }); // update: d only
      writeFileSync(path.join(repo, 'c.txt'), 'c changed in a commit\n');
      const s3 = await core.getSummary(wt); // full: blind
      const got = await core.listChangedFiles(wt, scope, { summaryState: s3.stateHash });
      expect(got).toEqual(await reference.listChangedFiles(wt, scope));
    } finally {
      await core.dispose();
    }
  });
});

describe('F4: read signatures only where the state has none, and a bound', () => {
  function committedAndDirty(name: string): { repo: string; scope: DiffScope } {
    const repo = fx.repo(name, { files: { 'c.txt': 'c\n', 'd.txt': 'd\n', 'e.txt': 'e\n' } });
    const base = fx.git(repo, ['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(repo, 'c.txt'), 'c changed in a commit\n');
    fx.commitAll(repo, 'change c');
    // Dirty: signed by the summary state already.
    writeFileSync(path.join(repo, 'd.txt'), 'd dirty\n');
    writeFileSync(path.join(repo, 'e.txt'), 'e dirty\n');
    return { repo, scope: { kind: 'review', base } };
  }

  it('a dirty path is not signed again: one committed-clean path fits a cap of one', async () => {
    const { repo, scope } = committedAndDirty('f4-sign');
    const core = createGitCore(fx.coreOptions());
    const cap = listLimits.maxLateSignatures;
    listLimits.maxLateSignatures = 1;
    try {
      const wt = locator(repo);
      const s1 = await core.getSummary(wt);
      const first = await core.listChangedFiles(wt, scope, { summaryState: s1.stateHash });
      const before = { ...listRefreshCounts };
      const again = await core.listChangedFiles(wt, scope, { summaryState: s1.stateHash });
      // Cached: answered without a seed (or an update).
      expect(listRefreshCounts.seeded).toBe(before.seeded);
      expect(listRefreshCounts.uncached).toBe(before.uncached);
      expect(again).toEqual(first);
    } finally {
      listLimits.maxLateSignatures = cap;
      await core.dispose();
    }
  });

  it('above the bound the list is served, not kept (and an older one is dropped)', async () => {
    const { repo, scope } = committedAndDirty('f4-cap');
    const core = createGitCore(fx.coreOptions());
    const cap = listLimits.maxLateSignatures;
    try {
      const wt = locator(repo);
      const s1 = await core.getSummary(wt);
      await core.listChangedFiles(wt, scope, { summaryState: s1.stateHash }); // cached
      listLimits.maxLateSignatures = 0;
      writeFileSync(path.join(repo, 'e.txt'), 'e dirty again\n');
      const s2 = await core.getSummary(wt, { changedPaths: ['e.txt'] });
      const before = { ...listRefreshCounts };
      const got = await core.listChangedFiles(wt, scope, { summaryState: s2.stateHash });
      expect(listRefreshCounts.uncached).toBe(before.uncached + 1);
      expect(got).toEqual(await reference.listChangedFiles(wt, scope));
      // Nothing kept: the next answer is computed again (a seed), and still right.
      const seeded = listRefreshCounts.seeded;
      expect(await core.listChangedFiles(wt, scope, { summaryState: s2.stateHash })).toEqual(got);
      expect(listRefreshCounts.seeded).toBe(seeded + 1);
    } finally {
      listLimits.maxLateSignatures = cap;
      await core.dispose();
    }
  });
});

describe('F2: a list in flight across forgetState is not stored for the new state', () => {
  it('stores nothing for the old track, so the new one never serves its rows', async () => {
    const repo = fx.repo('f2', { files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
    const marker = path.join(fx.root, 'f2-slow');
    const wrapper = path.join(fx.root, 'f2-git.sh');
    writeFileSync(
      wrapper,
      [
        '#!/bin/sh',
        'for a in "$@"; do',
        `  if [ "$a" = "-p" ] && [ -e '${marker}' ]; then sleep 1.5; fi`,
        'done',
        'exec git "$@"',
        '',
      ].join('\n'),
    );
    chmodSync(wrapper, 0o755);
    const core = createGitCore(fx.coreOptions({ gitBinary: wrapper }));
    try {
      const wt = locator(repo);
      const a = path.join(repo, 'a.txt');
      const b = path.join(repo, 'b.txt');
      writeFileSync(a, 'a\nB1\n');
      await core.getSummary(wt); // v1
      for (let i = 0; i < 4; i++) {
        writeFileSync(b, `b\n${'x\n'.repeat(i + 1)}`);
        await core.getSummary(wt, { changedPaths: ['b.txt'] }); // v5
      }
      writeFileSync(marker, '');
      const inflight = core.listChangedFiles(wt, { kind: 'working' });
      await sleep(400);
      rmSync(marker);
      await core.getSummary(wt, { forgetState: true }); // a new track, v1
      await inflight; // finishes for the old track
      writeFileSync(a, 'a\nC1\nC2\nC3\n');
      let s = await core.getSummary(wt, { changedPaths: ['a.txt'] }); // v2
      for (let i = 0; i < 3; i++) {
        writeFileSync(b, `b\n${'y\n'.repeat(i + 1)}`);
        s = await core.getSummary(wt, { changedPaths: ['b.txt'] }); // v5
      }
      const got = await core.listChangedFiles(
        wt,
        { kind: 'working' },
        { summaryState: s.stateHash },
      );
      expect(got).toEqual(await reference.listChangedFiles(wt, { kind: 'working' }));
    } finally {
      await core.dispose();
    }
  }, 20_000);
});

describe('F3: an index that is no regular file cannot hang anything', () => {
  const fifos: string[] = [];
  /** Releases a reader blocked in open(2) on a FIFO (a failing-first run would hang there). */
  afterEach(() => {
    for (const fifo of fifos.splice(0)) {
      try {
        closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      } catch {
        // no reader: nothing to release
      }
    }
  });
  const mkfifo = (file: string) => {
    const made = spawnSync('mkfifo', [file]);
    if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr}`);
    fifos.push(file);
  };
  const settlesWithin = <T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> =>
    Promise.race([promise, sleep(ms).then(() => 'timeout' as const)]);

  it.runIf(process.platform !== 'win32')(
    'a FIFO, a symlink to a FIFO and a symlink to /dev/zero: the safe answer at once',
    async () => {
      const dir = path.join(fx.root, 'f3-files');
      fx.write(path.join(dir, 'keep'), '');
      const fifo = path.join(dir, 'index-fifo');
      mkfifo(fifo);
      const toFifo = path.join(dir, 'index-to-fifo');
      symlinkSync(fifo, toFifo);
      const toZero = path.join(dir, 'index-to-zero');
      symlinkSync('/dev/zero', toZero);
      for (const file of [fifo, toFifo, toZero]) {
        expect(await settlesWithin(indexHasGitlinks(file, `sig-${file}`, 'sha1'), 1000)).toBe(true);
      }
    },
  );

  it('incremental: false reads no stamp and scans no index (the old calls exactly)', async () => {
    const repo = fx.repo('f3-off', { files: { 'a.txt': 'a\n' } });
    const core = createGitCore(fx.coreOptions({ incremental: false }));
    try {
      const before = stampReads.count;
      await core.getSummary(locator(repo), { changedPaths: ['a.txt'] });
      await core.listChangedFiles(locator(repo), { kind: 'working' });
      expect(stampReads.count).toBe(before);
    } finally {
      await core.dispose();
    }
  });

  for (const incremental of [true, false]) {
    it.runIf(process.platform !== 'win32')(
      `getSummary settles on a repository whose index is a FIFO (incremental: ${incremental})`,
      async () => {
        const repo = fx.repo(`f3-${incremental}`, { files: { 'a.txt': 'a\n' } });
        const index = path.join(repo, '.git', 'index');
        rmSync(index);
        mkfifo(index);
        // git itself blocks on the FIFO too: the runner's timeout ends it, as before this PR.
        const core = createGitCore(fx.coreOptions({ incremental, timeoutMs: 1500 }));
        try {
          const outcome = await settlesWithin(
            core.getSummary(locator(repo)).then(
              () => 'settled',
              () => 'settled',
            ),
            6000,
          );
          expect(outcome).toBe('settled');
        } finally {
          await core.dispose();
        }
      },
      15_000,
    );
  }
});
