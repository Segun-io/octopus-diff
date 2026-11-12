/**
 * getFileDiff from the summary state (#41). The summary route (the state git-core kept per worktree
 * vouches for the file, so one `git diff <base> -- <path>` or nothing at all reads it) must give the
 * bytes the whole-scope route gives, for every kind of file, and must step aside (with a stated
 * reason) whenever the state cannot vouch. Every case compares one core (default options) with a
 * reference core (`incremental: false`, which has no summary route): the whole `GitFileDiff`, patch
 * text and `patchHash` included, or the same error. The fuzz test (`diff-from-summary-fuzz.test.ts`)
 * does the same at random; the races are in `diff-from-summary-races.test.ts`.
 *
 * On a case-folding filesystem (macOS, `OCTOPUS_DIFF_TEST_FOLDS_CASE=1`) the summary route is off by
 * design (#288): the expected route becomes `case-insensitive` and equality is still asserted.
 */
import { chmodSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type DiffOptions,
  type DiffScope,
  type GitCore,
  type GitFileDiff,
  isGitCoreError,
} from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileDiffRoutes } from '../src/diff.js';
import { stampReads } from '../src/incremental.js';
import { createGitCore } from '../src/index.js';
import { locator } from './helpers/core.js';
import { createFixture, type Fixture, lines, RAW_NAMES_SUPPORTED } from './helpers/fixture.js';
import { worktreesFoldCase } from './helpers/folds.js';

const FOLDS = await worktreesFoldCase();
const WORKING: DiffScope = { kind: 'working' };

let fx: Fixture;
let fast: GitCore;
let reference: GitCore;
/** Every git process `fast` started, as argv (the config scan is a shared cache: not counted). */
const spawns: string[][] = [];
/** And the reference core's. */
const referenceSpawns: string[][] = [];

function isolated(): Record<string, string> {
  return {
    HOME: path.join(fx.root, 'empty-home'),
    XDG_CONFIG_HOME: path.join(fx.root, 'empty-xdg'),
    GIT_ATTR_NOSYSTEM: '1',
  };
}

function recordingLogger(into: string[][] = spawns) {
  return {
    debug(message: string, fields?: Record<string, unknown>) {
      const args = fields?.args;
      if (message === 'git' && Array.isArray(args) && args[0] !== 'config') {
        into.push(args.map(String));
      }
    },
    info() {},
    warn() {},
    error() {},
  };
}

beforeAll(() => {
  fx = createFixture('octopus-diff-dfs-');
  fast = createGitCore(fx.coreOptions({ logger: recordingLogger(), env: isolated() }));
  reference = createGitCore(
    fx.coreOptions({
      incremental: false,
      logger: recordingLogger(referenceSpawns),
      env: isolated(),
    }),
  );
});

afterAll(async () => {
  await fast.dispose();
  await reference.dispose();
  fx.dispose();
});

type Settled = { ok: GitFileDiff } | { error: string };

async function settle(call: Promise<GitFileDiff>): Promise<Settled> {
  try {
    return { ok: await call };
  } catch (error) {
    return { error: isGitCoreError(error) ? error.code : String(error) };
  }
}

const reasonsNow = (): Map<string, number> => new Map(fileDiffRoutes.reasons);

interface Outcome {
  /** `summary`, or the reason the whole-scope route answered. */
  route: string;
  result: Settled;
  /** Git processes the fast core started for this call (argv). */
  spawned: string[][];
}

/** Asks both cores and asserts they agree; reports how the fast one answered. */
async function diffBoth(
  repo: string,
  scope: DiffScope,
  file: string | { path: string; rawPath?: string },
  options?: DiffOptions,
  cores: { fast: GitCore; reference: GitCore } = { fast, reference },
): Promise<Outcome> {
  const selector = typeof file === 'string' ? { path: file } : file;
  const wt = locator(repo);
  const summaryBefore = fileDiffRoutes.summary;
  const reasonsBefore = reasonsNow();
  spawns.length = 0;
  const got = await settle(cores.fast.getFileDiff(wt, scope, selector, options));
  const spawned = spawns.map((args) => [...args]);
  // How the fast core answered, before the reference core (whose answers count too) is asked.
  let route = 'summary';
  if (fileDiffRoutes.summary === summaryBefore) {
    route = 'none';
    for (const [reason, count] of fileDiffRoutes.reasons) {
      if (count !== (reasonsBefore.get(reason) ?? 0)) route = reason;
    }
  }
  const want = await settle(cores.reference.getFileDiff(wt, scope, selector, options));
  expect(got).toEqual(want);
  return { route, result: got, spawned };
}

/** What the summary route's reason is on this filesystem. */
const SUMMARY = FOLDS ? 'case-insensitive' : 'summary';

/** A repository with `files` committed, `mutate`d, and summarized by the fast core. */
async function prepare(
  name: string,
  files: Record<string, string | Buffer>,
  mutate: (repo: string) => void,
): Promise<{ repo: string; stateHash: string }> {
  const repo = fx.repo(name, { files: files as Record<string, string> });
  mutate(repo);
  const summary = await fast.getSummary(locator(repo));
  return { repo, stateHash: summary.stateHash };
}

const text = (repo: string, rel: string, content: string | Buffer): void =>
  fx.write(path.join(repo, rel), content);

describe('the summary route gives the whole-scope route’s answer (working scope)', () => {
  it('a modified file: one git diff of the path, same bytes and patchHash as the list’s', async () => {
    const { repo, stateHash } = await prepare(
      'modified',
      { 'a.txt': lines(40), 'b.txt': lines(3), 'dir/c.txt': lines(5) },
      (r) => text(r, 'a.txt', `${lines(20)}edited\n${lines(19, 'tail')}`),
    );
    referenceSpawns.length = 0;
    const outcome = await diffBoth(repo, WORKING, 'a.txt');
    expect(outcome.route).toBe(SUMMARY);
    if (!FOLDS) {
      expect(outcome.spawned.map((args) => args[0])).toEqual(['diff']);
      const args = outcome.spawned[0] as string[];
      // A literal pathspec after `--`, the same pins and canonical context as every other diff:
      // exactly the argv the whole-scope route's narrowed patch run uses (its third process).
      expect(args.slice(-2)).toEqual(['--', 'a.txt']);
      expect(args).toContain('-U3');
      const old = referenceSpawns.slice(-3);
      expect(old.map((a) => a[0])).toEqual(['diff', 'status', 'diff']);
      expect(args).toEqual(old[2]);
    }
    // The diff and the list (at the same state) agree on the hash the review marks are keyed by.
    const rows = await fast.listChangedFiles(locator(repo), WORKING, { summaryState: stateHash });
    const row = rows.find((file) => file.path === 'a.txt');
    expect((outcome.result as { ok: GitFileDiff }).ok.patchHash).toBe(row?.patchHash);
  });

  it('staged only, staged and unstaged, deleted, staged deletion', async () => {
    const { repo } = await prepare(
      'kinds',
      {
        'staged.txt': lines(10),
        'both.txt': lines(10),
        'gone.txt': lines(6),
        'rm.txt': lines(4),
        'same.txt': 's\n',
      },
      (r) => {
        text(r, 'staged.txt', `${lines(10)}staged\n`);
        fx.git(r, ['add', 'staged.txt']);
        text(r, 'both.txt', `${lines(10)}staged\n`);
        fx.git(r, ['add', 'both.txt']);
        text(r, 'both.txt', `${lines(10)}staged\nunstaged\n`);
        rmSync(path.join(r, 'gone.txt'));
        fx.git(r, ['rm', '-q', 'rm.txt']);
      },
    );
    expect((await diffBoth(repo, WORKING, 'staged.txt')).route).toBe(SUMMARY);
    expect((await diffBoth(repo, WORKING, 'both.txt')).route).toBe(SUMMARY);
    // A deletion is safe while nothing is added anywhere (no rename partner).
    expect((await diffBoth(repo, WORKING, 'gone.txt')).route).toBe(SUMMARY);
    expect((await diffBoth(repo, WORKING, 'rm.txt')).route).toBe(SUMMARY);
    // A clean file is not in the state: the whole-scope route says not_found.
    const clean = await diffBoth(repo, WORKING, 'same.txt');
    expect(clean.route).toBe(FOLDS ? 'case-insensitive' : 'not-in-state');
    expect(clean.result).toEqual({ error: 'not_found' });
  });

  it('a mode change, a symlink target change and a type-preserving binary change', async () => {
    const { repo } = await prepare(
      'modes',
      {
        'run.sh': '#!/bin/sh\necho hi\n',
        'bin.dat': Buffer.from([0, 1, 2, 3, 0, 10]),
        'cfg.txt': lines(3),
      },
      (r) => {
        symlinkSync('cfg.txt', path.join(r, 'link'));
        fx.git(r, ['add', 'link']);
        fx.git(r, ['commit', '-q', '-m', 'link']);
        chmodSync(path.join(r, 'run.sh'), 0o755);
        text(r, 'bin.dat', Buffer.from([0, 9, 9, 9, 0, 10, 11]));
        rmSync(path.join(r, 'link'));
        symlinkSync('other-target', path.join(r, 'link'));
      },
    );
    const mode = await diffBoth(repo, WORKING, 'run.sh');
    expect(mode.route).toBe(SUMMARY);
    expect((mode.result as { ok: GitFileDiff }).ok.oldMode).toBe('100644');
    expect((mode.result as { ok: GitFileDiff }).ok.newMode).toBe('100755');
    const bin = await diffBoth(repo, WORKING, 'bin.dat');
    expect(bin.route).toBe(SUMMARY);
    expect((bin.result as { ok: GitFileDiff }).ok.binary).toBe(true);
    expect((await diffBoth(repo, WORKING, 'link')).route).toBe(SUMMARY);
  });

  it('whitespace only, CRLF, a file without a final newline', async () => {
    const { repo } = await prepare(
      'whitespace',
      { 'ws.txt': 'a\n  b\nc\n', 'crlf.txt': 'one\ntwo\nthree\n', 'nonl.txt': 'x\ny' },
      (r) => {
        text(r, 'ws.txt', 'a\n\tb\nc \n');
        text(r, 'crlf.txt', 'one\r\ntwo\r\nthree\r\n');
        text(r, 'nonl.txt', 'x\ny\nz');
      },
    );
    for (const file of ['ws.txt', 'crlf.txt', 'nonl.txt']) {
      expect((await diffBoth(repo, WORKING, file)).route).toBe(SUMMARY);
      // View options change the shown patch, never the identity; two processes (canonical + view).
      for (const options of [
        { ignoreWhitespace: true },
        { contextLines: 0 },
        { contextLines: 25, ignoreWhitespace: true },
        { full: true },
      ]) {
        const outcome = await diffBoth(repo, WORKING, file, options);
        expect(outcome.route).toBe(SUMMARY);
        if (!FOLDS && !options.full) {
          expect(outcome.spawned.map((args) => args[0])).toEqual(['diff', 'diff']);
        }
      }
    }
  });

  it('a very large patch: too large to show, shown whole with full, hash unchanged', async () => {
    const big = createGitCore(
      fx.coreOptions({ maxPatchBytes: 2_000, logger: recordingLogger(), env: isolated() }),
    );
    const bigReference = createGitCore(
      fx.coreOptions({ maxPatchBytes: 2_000, incremental: false, env: isolated() }),
    );
    try {
      const repo = fx.repo('large', { files: { 'big.txt': lines(300) } });
      text(repo, 'big.txt', lines(300, 'changed'));
      await big.getSummary(locator(repo));
      const cores = { fast: big, reference: bigReference };
      const plain = await diffBoth(repo, WORKING, 'big.txt', undefined, cores);
      expect(plain.route).toBe(SUMMARY);
      expect((plain.result as { ok: GitFileDiff }).ok.tooLarge).toBe(true);
      expect((plain.result as { ok: GitFileDiff }).ok.patch).toBe('');
      const full = await diffBoth(repo, WORKING, 'big.txt', { full: true }, cores);
      expect(full.route).toBe(SUMMARY);
      // `full` lifts the soft limit: the whole patch is shown (the hard output cap is far above).
      expect((full.result as { ok: GitFileDiff }).ok.tooLarge).toBe(false);
      expect((full.result as { ok: GitFileDiff }).ok.patch).toContain('+changed 300');
      expect((full.result as { ok: GitFileDiff }).ok.patchHash).toBe(
        (plain.result as { ok: GitFileDiff }).ok.patchHash,
      );
    } finally {
      await big.dispose();
      await bigReference.dispose();
    }
  });

  it('names with spaces and Unicode', async () => {
    const { repo } = await prepare(
      'names',
      { 'sp ace.txt': lines(4), 'ünï/çödé.txt': lines(4) },
      (r) => {
        text(r, 'sp ace.txt', lines(5));
        text(r, 'ünï/çödé.txt', lines(6));
        text(r, 'ünï/new ünï.txt', 'fresh\n');
      },
    );
    expect((await diffBoth(repo, WORKING, 'sp ace.txt')).route).toBe(SUMMARY);
    expect((await diffBoth(repo, WORKING, 'ünï/çödé.txt')).route).toBe(SUMMARY);
    expect((await diffBoth(repo, WORKING, 'ünï/new ünï.txt')).route).toBe(SUMMARY);
  });

  it.skipIf(!RAW_NAMES_SUPPORTED)(
    'a name that is not UTF-8 is read by the whole-scope route',
    async () => {
      const name = Buffer.from([0x78, 0xff, 0x2e, 0x74, 0x78, 0x74]);
      const repo = fx.repo('raw-name', { files: { 'a.txt': 'a\n' } });
      fx.writeRaw(repo, name, 'one\n');
      fx.git(repo, ['add', '-A']);
      fx.git(repo, ['commit', '-q', '-m', 'raw']);
      fx.writeRaw(repo, name, 'one\ntwo\n');
      fx.writeRaw(repo, Buffer.from([0x79, 0xfe]), 'untracked\n');
      await fast.getSummary(locator(repo));
      const files = await reference.listChangedFiles(locator(repo), WORKING);
      expect(files.filter((f) => f.rawPath !== undefined)).toHaveLength(2);
      for (const file of files.filter((f) => f.rawPath !== undefined)) {
        const outcome = await diffBoth(repo, WORKING, { path: file.path, rawPath: file.rawPath });
        expect(outcome.route).toBe(FOLDS ? 'case-insensitive' : 'undecodable-path');
      }
    },
  );

  it('an image: both sides previewed as the whole-scope route does', async () => {
    const png = (n: number): Buffer =>
      Buffer.concat([
        Buffer.from('89504e470d0a1a0a', 'hex'),
        Buffer.from([0, 0, 0, 13, 73, 72, 68, 82, n]),
      ]);
    const { repo } = await prepare('image', { 'pic.png': png(1), 'a.txt': 'a\n' }, (r) =>
      text(r, 'pic.png', png(2)),
    );
    const outcome = await diffBoth(repo, WORKING, 'pic.png');
    expect(outcome.route).toBe(SUMMARY);
    expect((outcome.result as { ok: GitFileDiff }).ok.images?.after?.mime).toBe('image/png');
  });
});

describe('untracked files: no git process at all', () => {
  it('text, binary, empty, executable and nested; same bytes and patchHash as the whole route', async () => {
    const { repo, stateHash } = await prepare('untracked', { 'a.txt': 'a\n' }, (r) => {
      text(r, 'new.txt', lines(7));
      text(r, 'empty.txt', '');
      text(r, 'bin.dat', Buffer.from([0, 1, 2, 0, 3]));
      text(r, 'deep/er/file.txt', 'nested\n');
      text(r, 'run.sh', '#!/bin/sh\n');
      chmodSync(path.join(r, 'run.sh'), 0o755);
      symlinkSync('new.txt', path.join(r, 'alias'));
    });
    const rows = await fast.listChangedFiles(locator(repo), WORKING, { summaryState: stateHash });
    for (const row of rows.filter((file) => file.status === 'untracked')) {
      const outcome = await diffBoth(repo, WORKING, row.path);
      expect(outcome.route, row.path).toBe(SUMMARY);
      if (!FOLDS) expect(outcome.spawned, row.path).toEqual([]);
      expect((outcome.result as { ok: GitFileDiff }).ok.patchHash, row.path).toBe(row.patchHash);
    }
    expect(rows.filter((file) => file.status === 'untracked')).toHaveLength(6);
  });

  it('more untracked files than are read: stat-based hashes, still the summary route', async () => {
    const few = createGitCore(
      fx.coreOptions({ maxUntrackedFiles: 2, logger: recordingLogger(), env: isolated() }),
    );
    const fewReference = createGitCore(
      fx.coreOptions({ maxUntrackedFiles: 2, incremental: false, env: isolated() }),
    );
    try {
      const repo = fx.repo('many-untracked', { files: { 'a.txt': 'a\n' } });
      // An attributes source makes git-core ask for a verdict per file it is asked about.
      const attributes = path.join(fx.root, 'many-untracked.attributes');
      writeFileSync(attributes, '*.bin binary\n');
      fx.git(repo, ['config', 'core.attributesFile', attributes]);
      for (let i = 0; i < 5; i++) text(repo, `u${i}.txt`, `${i}\n`);
      await few.getSummary(locator(repo));
      const cores = { fast: few, reference: fewReference };
      for (let i = 0; i < 5; i++) {
        const outcome = await diffBoth(repo, WORKING, `u${i}.txt`, undefined, cores);
        expect(outcome.route).toBe(SUMMARY);
        // At most the verdict lookup (check-attr, once per file): never status or diff.
        if (!FOLDS)
          expect(outcome.spawned.map((args) => args[0]).filter((c) => c !== 'check-attr')).toEqual(
            [],
          );
      }
    } finally {
      await few.dispose();
      await fewReference.dispose();
    }
  });

  it('a path that is both a tracked entry and untracked goes the whole way', async () => {
    const { repo } = await prepare('both', { 'a.txt': lines(3), 'b.txt': 'b\n' }, (r) => {
      fx.git(r, ['rm', '-q', '--cached', 'a.txt']);
    });
    const outcome = await diffBoth(repo, WORKING, 'a.txt');
    expect(outcome.route).toBe(FOLDS ? 'case-insensitive' : 'tracked-and-untracked');
  });

  it('a .gitignore written just before the state was read is checked by the whole route', async () => {
    const repo = fx.repo('ignore-fresh', { files: { 'a.txt': 'a\n' } });
    text(repo, 'new.txt', 'new\n');
    text(repo, '.gitignore', 'ignored.txt\n');
    await fast.getSummary(locator(repo));
    expect((await diffBoth(repo, WORKING, 'new.txt')).route).toBe(
      FOLDS ? 'case-insensitive' : 'ignore-rules',
    );
    // Written long enough before the next state: it vouches again.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await fast.getSummary(locator(repo));
    expect((await diffBoth(repo, WORKING, 'new.txt')).route).toBe(SUMMARY);
  });
});

describe('what the summary route refuses (the whole-scope route answers, identically)', () => {
  const REASON = (reason: string): string => (FOLDS ? 'case-insensitive' : reason);

  it('an added file: a deleted one elsewhere could pair with it as a rename', async () => {
    const { repo } = await prepare('added', { 'a.txt': lines(10), 'old.txt': lines(12) }, (r) => {
      text(r, 'added.txt', lines(8));
      fx.git(r, ['add', 'added.txt']);
    });
    expect((await diffBoth(repo, WORKING, 'added.txt')).route).toBe(REASON('status'));
  });

  it('a rename, its source and its destination', async () => {
    const body = lines(30);
    const { repo } = await prepare('renamed', { 'old.txt': body, 'keep.txt': 'k\n' }, (r) => {
      fx.git(r, ['mv', 'old.txt', 'new.txt']);
      text(r, 'new.txt', `${body}extra\n`);
    });
    expect((await diffBoth(repo, WORKING, 'new.txt')).route).toBe(REASON('rename'));
    // The source is no entry of its own: both routes say not_found.
    const source = await diffBoth(repo, WORKING, 'old.txt');
    expect(source.result).toEqual({ error: 'not_found' });
  });

  it('a deleted file next to a staged addition: the rename pairs them, so the source is not found', async () => {
    const body = lines(30);
    const { repo } = await prepare('partner', { 'old.txt': body, 'keep.txt': 'k\n' }, (r) => {
      rmSync(path.join(r, 'old.txt'));
      text(r, 'moved.txt', body);
      fx.git(r, ['add', 'moved.txt']);
    });
    const deleted = await diffBoth(repo, WORKING, 'old.txt');
    expect(deleted.route).toBe(REASON('rename-partner'));
    expect(deleted.result).toEqual({ error: 'not_found' });
    expect((await diffBoth(repo, WORKING, 'moved.txt')).route).toBe(REASON('status'));
  });

  it('a type change, an intent-to-add file', async () => {
    const { repo } = await prepare('typechange', { 'f.txt': lines(3), 'g.txt': lines(3) }, (r) => {
      rmSync(path.join(r, 'f.txt'));
      symlinkSync('g.txt', path.join(r, 'f.txt'));
      text(r, 'ita.txt', lines(4));
      fx.git(r, ['add', '-N', 'ita.txt']);
    });
    expect((await diffBoth(repo, WORKING, 'f.txt')).route).toBe(REASON('status'));
    expect((await diffBoth(repo, WORKING, 'ita.txt')).route).toBe(REASON('status'));
  });

  it('an untracked file named like a rename’s source: the whole scope lists that path as deleted', async () => {
    const { repo } = await prepare(
      'rename-source',
      { 'old.txt': lines(30), 'keep.txt': 'k\n' },
      (r) => {
        fx.git(r, ['mv', 'old.txt', 'moved.txt']);
        // Nothing like the old content: unpaired, the diff reports old.txt deleted and moved.txt added.
        text(r, 'moved.txt', lines(30, 'entirely different'));
        text(r, 'old.txt', 'a new file that reuses the name\n');
      },
    );
    const outcome = await diffBoth(repo, WORKING, 'old.txt');
    expect(outcome.route).toBe(REASON('rename-source'));
    expect((outcome.result as { ok: GitFileDiff }).ok.status).toBe('deleted');
  });

  it('a conflicted worktree: every file goes the whole way', async () => {
    const repo = fx.repo('conflict', { files: { 'a.txt': 'base\n', 'b.txt': lines(3) } });
    fx.git(repo, ['checkout', '-q', '-b', 'other']);
    text(repo, 'a.txt', 'other\n');
    fx.commitAll(repo, 'other');
    fx.git(repo, ['checkout', '-q', 'main']);
    text(repo, 'a.txt', 'main\n');
    fx.commitAll(repo, 'main');
    fx.git(repo, ['merge', 'other'], { allowFail: true });
    text(repo, 'b.txt', lines(4));
    await fast.getSummary(locator(repo));
    expect((await diffBoth(repo, WORKING, 'a.txt')).route).toBe(REASON('conflicts'));
    expect((await diffBoth(repo, WORKING, 'b.txt')).route).toBe(REASON('conflicts'));
  });

  it('a submodule, an embedded repository (a gitlink), a nested repository', async () => {
    const lib = fx.repo('lib', { files: { 'l.txt': 'lib\n' } });
    const sub = fx.repo('with-sub', { files: { 'a.txt': lines(3) } });
    fx.git(sub, ['submodule', 'add', '-q', lib, 'vendor/lib']);
    fx.git(sub, ['commit', '-q', '-m', 'sub']);
    text(sub, 'a.txt', lines(4));
    await fast.getSummary(locator(sub));
    expect((await diffBoth(sub, WORKING, 'a.txt')).route).toBe(REASON('submodules'));

    const embedded = fx.repo('with-embedded', { files: { 'a.txt': lines(3) } });
    const head = fx.git(lib, ['rev-parse', 'HEAD']).trim();
    fx.git(embedded, ['update-index', '--add', '--cacheinfo', `160000,${head},thing`]);
    text(embedded, 'a.txt', lines(4));
    await fast.getSummary(locator(embedded));
    expect((await diffBoth(embedded, WORKING, 'a.txt')).route).toBe(REASON('submodules'));

    const nested = fx.repo('with-nested', { files: { 'a.txt': lines(3) } });
    fx.repo('with-nested/inner', { files: { 'i.txt': 'i\n' } });
    text(nested, 'a.txt', lines(4));
    await fast.getSummary(locator(nested));
    expect((await diffBoth(nested, WORKING, 'a.txt')).route).toBe(REASON('nested-repository'));
  });

  it('no summary yet, the kill switch, and a scope the state does not describe', async () => {
    const repo = fx.repo('no-state', { files: { 'a.txt': lines(3) } });
    text(repo, 'a.txt', lines(4));
    expect((await diffBoth(repo, WORKING, 'a.txt')).route).toBe(REASON('no-state'));
    await fast.getSummary(locator(repo));
    expect((await diffBoth(repo, WORKING, 'a.txt')).route).toBe(SUMMARY);

    // The kill switch: no summary route, and not even a stamp is read.
    const off = createGitCore(fx.coreOptions({ incremental: false, env: isolated() }));
    try {
      await off.getSummary(locator(repo));
      const reads = stampReads.count;
      const outcome = await diffBoth(repo, WORKING, 'a.txt', undefined, {
        fast: off,
        reference,
      });
      expect(outcome.route).toBe('disabled');
      expect(stampReads.count).toBe(reads);
    } finally {
      await off.dispose();
    }

    // Staged and unstaged scopes never take it.
    const staged = await diffBoth(repo, { kind: 'unstaged' }, 'a.txt');
    expect(staged.route).toBe('scope');
  });

  it('a file the state does not know (clean, or new since): not-in-state, same answer', async () => {
    const { repo } = await prepare('unknown', { 'a.txt': lines(3), 'b.txt': 'b\n' }, (r) =>
      text(r, 'a.txt', lines(4)),
    );
    text(repo, 'late.txt', 'created after the summary\n');
    expect((await diffBoth(repo, WORKING, 'late.txt')).route).toBe(REASON('not-in-state'));
    expect((await diffBoth(repo, WORKING, 'b.txt')).route).toBe(REASON('not-in-state'));
    expect((await diffBoth(repo, WORKING, 'missing/none.txt')).result).toEqual({
      error: 'not_found',
    });
  });
});

describe('the state is checked before it is believed', () => {
  const REASON = (reason: string): string => (FOLDS ? 'case-insensitive' : reason);

  it('a file edited since the summary: stale signature, and the diff shows the file as it is', async () => {
    const { repo } = await prepare('stale-file', { 'a.txt': lines(10), 'b.txt': 'b\n' }, (r) =>
      text(r, 'a.txt', `${lines(10)}one\n`),
    );
    expect((await diffBoth(repo, WORKING, 'a.txt')).route).toBe(SUMMARY);
    text(repo, 'a.txt', `${lines(10)}one\ntwo\n`);
    const outcome = await diffBoth(repo, WORKING, 'a.txt');
    expect(outcome.route).toBe(REASON('stale-signature'));
    expect((outcome.result as { ok: GitFileDiff }).ok.patch).toContain('+two');
    // Once the summary has caught up it vouches again.
    await fast.getSummary(locator(repo));
    expect((await diffBoth(repo, WORKING, 'a.txt')).route).toBe(SUMMARY);
  });

  it('an untracked file edited, deleted, or replaced since the summary', async () => {
    const { repo } = await prepare('stale-untracked', { 'a.txt': 'a\n' }, (r) => {
      text(r, 'u1.txt', 'one\n');
      text(r, 'u2.txt', 'two\n');
      text(r, 'u3.txt', 'three\n');
    });
    text(repo, 'u1.txt', 'one, edited\n');
    rmSync(path.join(repo, 'u2.txt'));
    rmSync(path.join(repo, 'u3.txt'));
    symlinkSync('a.txt', path.join(repo, 'u3.txt'));
    for (const file of ['u1.txt', 'u2.txt', 'u3.txt']) {
      expect((await diffBoth(repo, WORKING, file)).route, file).toBe(REASON('stale-signature'));
    }
  });

  it('the caller holds another state than git-core has: read the whole way', async () => {
    const { repo, stateHash } = await prepare('held-state', { 'a.txt': lines(5) }, (r) =>
      text(r, 'a.txt', lines(6)),
    );
    expect((await diffBoth(repo, WORKING, 'a.txt', { summaryState: stateHash })).route).toBe(
      SUMMARY,
    );
    const other = await diffBoth(repo, WORKING, 'a.txt', { summaryState: '0'.repeat(16) });
    expect(other.route).toBe(REASON('state-mismatch'));
    // A summary of a newer state makes the old hash a mismatch too.
    text(repo, 'a.txt', lines(7));
    await fast.getSummary(locator(repo));
    expect((await diffBoth(repo, WORKING, 'a.txt', { summaryState: stateHash })).route).toBe(
      REASON('state-mismatch'),
    );
  });

  it('the index moved: a git add since the summary', async () => {
    const { repo } = await prepare('index-moved', { 'a.txt': lines(5), 'b.txt': lines(5) }, (r) => {
      text(r, 'a.txt', lines(6));
      text(r, 'b.txt', lines(7));
    });
    fx.git(repo, ['add', 'b.txt']);
    expect((await diffBoth(repo, WORKING, 'a.txt')).route).toBe(REASON('index'));
  });

  it('HEAD moved without the index changing', async () => {
    const { repo } = await prepare('head-moved', { 'a.txt': lines(5) }, (r) => {
      // `side` is another commit with the same tree: moving HEAD there leaves the index alone.
      fx.git(r, ['checkout', '-q', '-b', 'side']);
      fx.git(r, ['commit', '-q', '--allow-empty', '-m', 'empty']);
      fx.git(r, ['checkout', '-q', 'main']);
      text(r, 'a.txt', lines(6));
    });
    fx.git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/side']);
    expect((await diffBoth(repo, WORKING, 'a.txt')).route).toBe(REASON('head-moved'));
  });

  it('config changed since the summary', async () => {
    const { repo } = await prepare('config-moved', { 'a.txt': lines(5) }, (r) =>
      text(r, 'a.txt', lines(6)),
    );
    fx.git(repo, ['config', 'core.fileMode', 'false']);
    expect((await diffBoth(repo, WORKING, 'a.txt')).route).toBe(REASON('config'));
  });
});

describe('other scopes that read the worktree', () => {
  const REASON = (reason: string): string => (FOLDS ? 'case-insensitive' : reason);

  it('review and branch scopes against HEAD’s own commit take the summary route', async () => {
    const { repo } = await prepare('review-head', { 'a.txt': lines(5), 'u.txt': 'u\n' }, (r) => {
      text(r, 'a.txt', lines(6));
      text(r, 'fresh.txt', 'fresh\n');
    });
    const head = fx.git(repo, ['rev-parse', 'HEAD']).trim();
    for (const scope of [
      { kind: 'review', base: head } as DiffScope,
      { kind: 'branch', base: 'main', includeWorking: true } as DiffScope,
    ]) {
      expect((await diffBoth(repo, scope, 'a.txt')).route, scope.kind).toBe(SUMMARY);
      expect((await diffBoth(repo, scope, 'fresh.txt')).route, scope.kind).toBe(SUMMARY);
    }
  });

  it('against an older base: a file the commits since left alone, but not one they touched', async () => {
    const repo = fx.repo('review-old', {
      files: { 'touched.txt': lines(5), 'quiet.txt': lines(5), 'gone.txt': lines(5) },
    });
    const base = fx.git(repo, ['rev-parse', 'HEAD']).trim();
    text(repo, 'touched.txt', lines(6));
    text(repo, 'added-later.txt', 'added in a commit\n');
    fx.commitAll(repo, 'later');
    text(repo, 'touched.txt', lines(7));
    text(repo, 'quiet.txt', lines(6));
    rmSync(path.join(repo, 'gone.txt'));
    text(repo, 'fresh.txt', 'fresh\n');
    await fast.getSummary(locator(repo));
    const scope: DiffScope = { kind: 'review', base };
    expect((await diffBoth(repo, scope, 'quiet.txt')).route).toBe(SUMMARY);
    expect((await diffBoth(repo, scope, 'fresh.txt')).route).toBe(SUMMARY);
    expect((await diffBoth(repo, scope, 'touched.txt')).route).toBe(REASON('committed-since-base'));
    // A deletion could pair with an addition the commits made: not vouched against another base.
    expect((await diffBoth(repo, scope, 'gone.txt')).route).toBe(REASON('base'));
    expect((await diffBoth(repo, scope, 'added-later.txt')).route).toBe(REASON('not-in-state'));
  });
});

describe('a failed read leaves nothing behind', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an unreadable file fails like the whole route does, and the next read is right',
    async () => {
      const { repo } = await prepare(
        'unreadable',
        { 'a.txt': lines(5), 'b.txt': lines(5) },
        (r) => {
          text(r, 'a.txt', lines(6));
          text(r, 'b.txt', lines(6));
        },
      );
      expect((await diffBoth(repo, WORKING, 'b.txt')).route).toBe(SUMMARY);
      writeFileSync(path.join(repo, 'a.txt'), lines(7));
      await fast.getSummary(locator(repo));
      chmodSync(path.join(repo, 'a.txt'), 0o000);
      try {
        const failed = await diffBoth(repo, WORKING, 'a.txt');
        expect('error' in failed.result).toBe(true);
        // The state still vouches for the other file.
        expect((await diffBoth(repo, WORKING, 'b.txt')).route).toBe(SUMMARY);
      } finally {
        chmodSync(path.join(repo, 'a.txt'), 0o644);
      }
      await fast.getSummary(locator(repo));
      expect((await diffBoth(repo, WORKING, 'a.txt')).route).toBe(SUMMARY);
    },
  );
});
