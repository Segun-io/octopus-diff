/**
 * PR #89 review: a cached file list must never keep a row the summary state does not explain
 * (P1), and an embedded repository without `.gitmodules` must not get incremental refreshes (P2).
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GitChangedFile, GitCore, SummaryResult } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listRefreshCounts } from '../src/diff.js';
import { createGitCore } from '../src/index.js';
import { locator } from './helpers/core.js';
import { createFixture, type Fixture, lines } from './helpers/fixture.js';

let fx: Fixture;
let reference: GitCore;

beforeAll(() => {
  fx = createFixture('octopus-diff-incr-');
  reference = createGitCore(fx.coreOptions({ incremental: false }));
});

afterAll(async () => {
  await reference.dispose();
  fx.dispose();
});

const shape = (files: readonly GitChangedFile[]) => files.map((f) => `${f.status} ${f.path}`);
const comparable = (summary: SummaryResult) => {
  const { updatedAt: _u, refresh: _r, snapshot: _s, ...rest } = summary;
  return rest;
};

function repoAB(name: string): { repo: string; a: string; original: string } {
  const original = lines(6);
  const repo = fx.repo(name, { files: { 'a.txt': original, 'b.txt': lines(3) } });
  appendFileSync(path.join(repo, 'b.txt'), 'b edit\n');
  return { repo, a: path.join(repo, 'a.txt'), original };
}

async function fullList(repo: string): Promise<string[]> {
  return shape(await reference.listChangedFiles(locator(repo), { kind: 'working' }));
}

describe('P1: no phantom rows in cached lists', () => {
  it('repro A: a list run between an edit and its summary, then the edit reverted', async () => {
    const { repo, a, original } = repoAB('phantom-a');
    const core = createGitCore(fx.coreOptions());
    try {
      const wt = locator(repo);
      await core.getSummary(wt); // v1: a clean, b modified
      writeFileSync(a, `${original}pending edit\n`); // its event is still pending
      // A list without (or with a stale) summary state runs in full and is cached at v1.
      expect(shape(await core.listChangedFiles(wt, { kind: 'working' }))).toEqual([
        'modified a.txt',
        'modified b.txt',
      ]);
      writeFileSync(a, original); // reverted
      const s2 = await core.getSummary(wt, { changedPaths: ['a.txt'] });
      expect(s2.refresh?.mode).toBe('incremental');
      const got = await core.listChangedFiles(
        wt,
        { kind: 'working' },
        { summaryState: s2.stateHash },
      );
      expect(shape(got)).toEqual(await fullList(repo));
      // And after a full summary (the daemon's reconciliation).
      const s3 = await core.getSummary(wt);
      const again = await core.listChangedFiles(
        wt,
        { kind: 'working' },
        { summaryState: s3.stateHash },
      );
      expect(shape(again)).toEqual(['modified b.txt']);
    } finally {
      await core.dispose();
    }
  });

  it('repro B: the daemon path (summary state always held)', async () => {
    const { repo, a, original } = repoAB('phantom-b');
    const core = createGitCore(fx.coreOptions());
    try {
      const wt = locator(repo);
      const list = (state: string) =>
        core.listChangedFiles(wt, { kind: 'working' }, { summaryState: state });
      await core.getSummary(wt);
      writeFileSync(a, `${original}edit\n`);
      const s2 = await core.getSummary(wt, { changedPaths: ['a.txt'] });
      await list(s2.stateHash);
      writeFileSync(a, original);
      const s3 = await core.getSummary(wt, { changedPaths: ['a.txt'] });
      writeFileSync(a, `${original}edit again\n`); // pending: the list re-diffs a.txt
      expect(shape(await list(s3.stateHash))).toContain('modified a.txt');
      writeFileSync(a, original);
      const s4 = await core.getSummary(wt, { changedPaths: ['a.txt'] });
      expect(shape(await list(s4.stateHash))).toEqual(await fullList(repo));
      expect(shape(await list(s4.stateHash))).toEqual(['modified b.txt']);
    } finally {
      await core.dispose();
    }
  });

  it('an untracked file created and deleted around a full list', async () => {
    const { repo } = repoAB('phantom-untracked');
    const core = createGitCore(fx.coreOptions());
    try {
      const wt = locator(repo);
      await core.getSummary(wt);
      const tmp = path.join(repo, 'tmp.txt');
      writeFileSync(tmp, 'short-lived\n');
      expect(shape(await core.listChangedFiles(wt, { kind: 'working' }))).toContain(
        'untracked tmp.txt',
      );
      const { rmSync } = await import('node:fs');
      rmSync(tmp);
      const s2 = await core.getSummary(wt, { changedPaths: ['tmp.txt'] });
      const got = await core.listChangedFiles(
        wt,
        { kind: 'working' },
        { summaryState: s2.stateHash },
      );
      expect(shape(got)).toEqual(await fullList(repo));
    } finally {
      await core.dispose();
    }
  });

  it('a full summary drops a cached list it does not explain (the next list is seeded)', async () => {
    const { repo, a, original } = repoAB('drop-stale');
    const core = createGitCore(fx.coreOptions());
    try {
      const wt = locator(repo);
      await core.getSummary(wt);
      writeFileSync(a, `${original}pending\n`);
      await core.listChangedFiles(wt, { kind: 'working' }); // cached with a row v1 does not explain
      writeFileSync(a, original);
      const s2 = await core.getSummary(wt); // full
      const seeded = listRefreshCounts.seeded;
      const got = await core.listChangedFiles(
        wt,
        { kind: 'working' },
        { summaryState: s2.stateHash },
      );
      expect(listRefreshCounts.seeded).toBe(seeded + 1);
      expect(shape(got)).toEqual(['modified b.txt']);
    } finally {
      await core.dispose();
    }
  });

  it('forgetState drops the kept state and lists (an explicit refresh)', async () => {
    const { repo, a, original } = repoAB('forget');
    const core = createGitCore(fx.coreOptions());
    try {
      const wt = locator(repo);
      await core.getSummary(wt);
      writeFileSync(a, `${original}x\n`);
      await core.listChangedFiles(wt, { kind: 'working' });
      writeFileSync(a, original);
      const s = await core.getSummary(wt, { forgetState: true, changedPaths: ['a.txt'] });
      expect(s.refresh).toMatchObject({ mode: 'full', reason: 'forget' });
      const got = await core.listChangedFiles(
        wt,
        { kind: 'working' },
        { summaryState: s.stateHash },
      );
      expect(shape(got)).toEqual(['modified b.txt']);
    } finally {
      await core.dispose();
    }
  });
});

describe('P2: embedded repositories (a gitlink without .gitmodules)', () => {
  function embedded(name: string): { repo: string; sub: string } {
    const repo = fx.repo(name, { files: { 'a.txt': lines(4) } });
    const sub = path.join(repo, 'sub');
    fx.repo(path.relative(fx.root, sub), { files: { 's.txt': 's\n' } });
    fx.git(repo, ['add', 'sub', 'a.txt']);
    fx.git(repo, ['commit', '-qm', 'embed sub']);
    return { repo, sub };
  }

  it('a commit inside the embedded repository (no worktree event), then an edit elsewhere', async () => {
    const { repo, sub } = embedded('embedded-commit');
    const core = createGitCore(fx.coreOptions());
    try {
      const wt = locator(repo);
      await core.getSummary(wt);
      writeFileSync(path.join(sub, 's.txt'), 's2\n');
      fx.git(sub, ['commit', '-qam', 'inside']);
      appendFileSync(path.join(repo, 'a.txt'), 'edit\n');
      const got = await core.getSummary(wt, { changedPaths: ['a.txt'] });
      const want = await reference.getSummary(wt);
      expect(want.changedFiles).toBe(2);
      expect(comparable(got)).toEqual(comparable(want));
      expect(got.refresh).toMatchObject({ mode: 'full' });
    } finally {
      await core.dispose();
    }
  });

  it('a hinted path inside a nested repository that status does not show (ignored)', async () => {
    const repo = fx.repo('nested-ignored', {
      files: { 'a.txt': 'a\n', '.gitignore': 'vendor/\n' },
    });
    const inner = path.join(repo, 'vendor', 'inner');
    fx.repo(path.relative(fx.root, inner), { files: { 'i.txt': 'i\n' } });
    const core = createGitCore(fx.coreOptions());
    try {
      const wt = locator(repo);
      await core.getSummary(wt);
      writeFileSync(path.join(inner, 'i.txt'), 'i2\n');
      const got = await core.getSummary(wt, { changedPaths: ['vendor/inner/i.txt'] });
      expect(got.refresh).toMatchObject({ mode: 'full', reason: 'nested-repository' });
    } finally {
      await core.dispose();
    }
  });

  it('a hinted path inside the embedded repository refreshes in full', async () => {
    const { repo, sub } = embedded('embedded-hint');
    const core = createGitCore(fx.coreOptions());
    try {
      const wt = locator(repo);
      await core.getSummary(wt);
      writeFileSync(path.join(sub, 's.txt'), 's3\n');
      fx.git(sub, ['commit', '-qam', 'inside']);
      const got = await core.getSummary(wt, { changedPaths: ['sub/s.txt'] });
      expect(got.refresh?.mode).toBe('full');
      expect(comparable(got)).toEqual(comparable(await reference.getSummary(wt)));
    } finally {
      await core.dispose();
    }
  });
});
