/**
 * Incremental summaries and lists (#40): spawns per edit, when git-core refuses a hint, and what
 * a lost event does. The fuzz test (`incremental-fuzz.test.ts`) checks equality at random.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GitCore, SummaryResult } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkHint, MAX_HINT_PATHS, Region } from '../src/incremental.js';
import { createGitCore } from '../src/index.js';
import { locator } from './helpers/core.js';
import { createFixture, type Fixture, lines } from './helpers/fixture.js';
import { FOLDING_SKIP, worktreesFoldCase } from './helpers/folds.js';

/**
 * macOS (and `OCTOPUS_DIFF_TEST_FOLDS_CASE=1`): every hinted refresh is full by design (#288).
 * Tests about the incremental path are skipped there; refusals checked after the case probe report
 * `case-insensitive`; the fallback has its own test below.
 */
const FOLDS = await worktreesFoldCase();
/** A skipped test's title says why. */
const skipped = (title: string): string => (FOLDS ? `${title} [skipped: ${FOLDING_SKIP}]` : title);
/** A refusal the case probe comes before: what a folding filesystem reports instead. */
const afterProbe = (reason: string): string => (FOLDS ? 'case-insensitive' : reason);
/** What a hinted refresh that can be incremental is on this filesystem. */
const HINTED = FOLDS ? 'full' : 'incremental';

let fx: Fixture;
let reference: GitCore;

beforeAll(() => {
  fx = createFixture('octopus-diff-inc-');
  reference = createGitCore(fx.coreOptions({ incremental: false, env: isolated() }));
});

afterAll(async () => {
  await reference.dispose();
  fx.dispose();
});

/** Hermetic: no global (XDG) or system attributes from the machine running the tests. */
function isolated(): Record<string, string> {
  return {
    HOME: path.join(fx.root, 'empty-home'),
    XDG_CONFIG_HOME: path.join(fx.root, 'empty-xdg'),
    GIT_ATTR_NOSYSTEM: '1',
  };
}

/** A git-core whose git processes are recorded (`args` of every spawn). */
function recording(options: { incremental?: boolean } = {}): {
  core: GitCore;
  spawns: string[][];
} {
  const spawns: string[][] = [];
  const logger = {
    debug(message: string, fields?: Record<string, unknown>) {
      const args = fields?.args;
      // The config scan is a shared cache (#29), re-read while a config file is younger than two
      // seconds (its ctime, which a test cannot backdate) and every 60 s: not part of an edit.
      if (message === 'git' && Array.isArray(args) && args[0] !== 'config') {
        spawns.push(args.map(String));
      }
    },
    info() {},
    warn() {},
    error() {},
  };
  return { core: createGitCore(fx.coreOptions({ ...options, logger, env: isolated() })), spawns };
}

const comparable = (summary: SummaryResult) => {
  const { updatedAt: _u, refresh: _r, ...rest } = summary;
  return rest;
};

async function expectSameAsFull(core: GitCore, repo: string, got: SummaryResult): Promise<void> {
  const want = await reference.getSummary(locator(repo), { snapshot: true });
  expect(comparable(got)).toEqual(comparable(want));
  void core;
}

function dirtyRepo(name: string): string {
  const repo = fx.repo(name, {
    files: { 'a.txt': lines(20), 'b.txt': lines(5), 'dir/c.txt': lines(3), 'gone.txt': 'g\n' },
  });
  appendFileSync(path.join(repo, 'a.txt'), 'edit 1\n');
  fx.write(path.join(repo, 'new.txt'), 'untracked\n');
  return repo;
}

describe('incremental summary: spawns per edit', () => {
  it.skipIf(FOLDS)(
    skipped('an edit of a modified file: one status and one numstat, both limited to the path'),
    async () => {
      const repo = dirtyRepo('spawns-edit');
      const { core, spawns } = recording();
      try {
        const wt = locator(repo);
        const first = await core.getSummary(wt, { snapshot: true });
        expect(first.refresh).toEqual({ mode: 'full', reason: null, pathspecs: 0 });
        spawns.length = 0;
        appendFileSync(path.join(repo, 'a.txt'), 'edit 2\n');
        const got = await core.getSummary(wt, { snapshot: true, changedPaths: ['a.txt'] });
        expect(got.refresh).toEqual({ mode: 'incremental', reason: null, pathspecs: 1 });
        // Both at once (numstat does not wait for the status).
        expect(spawns.map((a) => a[0]).sort()).toEqual(['diff', 'status']);
        for (const args of spawns) expect(args.slice(args.indexOf('--'))).toEqual(['--', 'a.txt']);
        expect(got.stateHash).not.toBe(first.stateHash);
        await expectSameAsFull(core, repo, got);
      } finally {
        await core.dispose();
      }
    },
  );

  it.skipIf(FOLDS)(
    skipped('an untracked file: one status (a new one: status and numstat, both limited)'),
    async () => {
      const repo = dirtyRepo('spawns-new');
      const { core, spawns } = recording();
      try {
        const wt = locator(repo);
        await core.getSummary(wt);
        spawns.length = 0;
        appendFileSync(path.join(repo, 'new.txt'), 'more\n');
        const edited = await core.getSummary(wt, { snapshot: true, changedPaths: ['new.txt'] });
        expect(edited.refresh?.mode).toBe('incremental');
        expect(spawns.map((a) => a[0])).toEqual(['status']);
        await expectSameAsFull(core, repo, edited);
        // A path the last state does not know may be a clean tracked file: numstat runs too.
        spawns.length = 0;
        fx.write(path.join(repo, 'another.txt'), 'one\ntwo\n');
        const got = await core.getSummary(wt, { snapshot: true, changedPaths: ['another.txt'] });
        expect(got.refresh?.mode).toBe('incremental');
        // The numstat is speculative (a new path may be a clean tracked file) and nobody awaits it
        // when the status says untracked: under load it may start after the summary has settled.
        for (let i = 0; i < 200 && spawns.length < 2; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(spawns.map((a) => a[0]).sort()).toEqual(['diff', 'status']);
        for (const args of spawns)
          expect(args.slice(args.indexOf('--'))).toEqual(['--', 'another.txt']);
        await expectSameAsFull(core, repo, got);
      } finally {
        await core.dispose();
      }
    },
  );

  it('the list of the held summary state: one diff limited to the changed paths', async () => {
    const repo = dirtyRepo('spawns-list');
    const { core, spawns } = recording();
    try {
      const wt = locator(repo);
      const first = await core.getSummary(wt);
      await core.listChangedFiles(wt, { kind: 'working' }, { summaryState: first.stateHash });
      appendFileSync(path.join(repo, 'b.txt'), 'edit\n');
      const next = await core.getSummary(wt, { changedPaths: ['b.txt'] });
      spawns.length = 0;
      const files = await core.listChangedFiles(
        wt,
        { kind: 'working' },
        { summaryState: next.stateHash },
      );
      expect(spawns.map((a) => a[0])).toEqual(['diff']);
      const last = spawns[0] as string[];
      expect(last.slice(last.indexOf('--'))).toEqual(['--', 'b.txt']);
      expect(files).toEqual(await reference.listChangedFiles(wt, { kind: 'working' }));
      // Without the held state (any other caller), the list is computed in full.
      spawns.length = 0;
      await core.listChangedFiles(wt, { kind: 'working' });
      expect(spawns.map((a) => a[0])).toContain('status');
      // A stale held state: in full too.
      spawns.length = 0;
      await core.listChangedFiles(wt, { kind: 'working' }, { summaryState: first.stateHash });
      expect(spawns.map((a) => a[0])).toContain('status');
    } finally {
      await core.dispose();
    }
  });

  it('incremental: false ignores the hint (kill switch)', async () => {
    const repo = dirtyRepo('kill-switch');
    const { core, spawns } = recording({ incremental: false });
    try {
      const wt = locator(repo);
      await core.getSummary(wt);
      spawns.length = 0;
      appendFileSync(path.join(repo, 'a.txt'), 'x\n');
      const got = await core.getSummary(wt, { changedPaths: ['a.txt'] });
      expect(got.refresh).toEqual({ mode: 'full', reason: null, pathspecs: 0 });
      const status = spawns.find((a) => a[0] === 'status') as string[];
      expect(status).not.toContain('--');
    } finally {
      await core.dispose();
    }
  });
});

describe('incremental summary: when the hint is not used', () => {
  async function reasonAfter(
    name: string,
    change: (repo: string) => void,
    hint: string[],
    setup?: (repo: string) => void,
  ): Promise<string | null | undefined> {
    const repo = dirtyRepo(name);
    setup?.(repo);
    const core = createGitCore(fx.coreOptions({ env: isolated() }));
    try {
      const wt = locator(repo);
      await core.getSummary(wt);
      change(repo);
      const got = await core.getSummary(wt, { snapshot: true, changedPaths: hint });
      expect(got.refresh?.mode).toBe('full');
      await expectSameAsFull(core, repo, got);
      return got.refresh?.reason;
    } finally {
      await core.dispose();
    }
  }

  it('without a previous state', async () => {
    const repo = dirtyRepo('no-state');
    const core = createGitCore(fx.coreOptions({ env: isolated() }));
    try {
      const got = await core.getSummary(locator(repo), { changedPaths: ['a.txt'] });
      expect(got.refresh).toMatchObject({ mode: 'full', reason: 'no-state' });
    } finally {
      await core.dispose();
    }
  });

  it('the index changed (git add)', async () => {
    expect(await reasonAfter('r-index', (r) => fx.git(r, ['add', 'a.txt']), ['a.txt'])).toBe(
      afterProbe('index'),
    );
  });

  it('HEAD moved without an index write (symbolic-ref, a moved upstream)', async () => {
    const switched = await reasonAfter(
      'r-head',
      (r) => fx.git(r, ['symbolic-ref', 'HEAD', 'refs/heads/side']),
      ['a.txt'],
      (r) => {
        fx.git(r, ['branch', 'side']);
        fx.write(path.join(r, 'later.txt'), 'later\n');
        fx.git(r, ['add', 'later.txt']);
        fx.git(r, ['commit', '-qm', 'later']);
        fx.git(r, ['branch', '-f', 'side', 'HEAD~1']);
      },
    );
    expect(switched).toBe(afterProbe('head'));
    const moved = await reasonAfter(
      'r-upstream',
      (r) => fx.git(r, ['update-ref', 'refs/remotes/origin/main', 'HEAD~1']),
      ['a.txt'],
      (r) => {
        fx.git(r, ['commit', '-q', '--allow-empty', '-m', 'ahead']);
        fx.git(r, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
        fx.git(r, ['config', 'remote.origin.url', path.join(fx.root, 'no-such-remote')]);
        fx.git(r, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
        fx.git(r, ['config', 'branch.main.remote', 'origin']);
        fx.git(r, ['config', 'branch.main.merge', 'refs/heads/main']);
      },
    );
    // The config write above is older than the change: the header (`branch.ab`) tells.
    expect(FOLDS ? ['case-insensitive'] : ['head', 'config']).toContain(moved);
  });

  it('a .gitignore, .gitattributes or .gitmodules among the paths', async () => {
    expect(
      await reasonAfter('r-ignore', (r) => writeFileSync(path.join(r, '.gitignore'), 'new.txt\n'), [
        '.gitignore',
      ]),
    ).toBe('ignore-or-attributes');
    expect(
      await reasonAfter(
        'r-attr',
        (r) => writeFileSync(path.join(r, 'dir', '.gitattributes'), '*.txt -diff\n'),
        ['dir/.gitattributes'],
      ),
    ).toBe('ignore-or-attributes');
  });

  it('info/exclude changed', async () => {
    expect(
      await reasonAfter(
        'r-exclude',
        (r) => writeFileSync(path.join(r, '.git', 'info', 'exclude'), 'new.txt\n'),
        ['a.txt'],
      ),
    ).toBe(afterProbe('ignore-rules'));
  });

  it('a directory among the paths', async () => {
    expect(
      await reasonAfter(
        'r-dir',
        (r) => {
          mkdirSync(path.join(r, 'made', 'deep'), { recursive: true });
          writeFileSync(path.join(r, 'made', 'deep', 'f.txt'), 'f\n');
        },
        ['made'],
      ),
    ).toBe(afterProbe('directory'));
  });

  it('a sparse checkout', async () => {
    const reason = await reasonAfter(
      'r-sparse',
      (r) => appendFileSync(path.join(r, 'a.txt'), 'more\n'),
      ['a.txt'],
      (r) => {
        fx.git(r, ['sparse-checkout', 'set', '--no-cone', '/*', '!/dir/']);
      },
    );
    expect(reason).toBe('sparse-checkout');
  });

  it('a nested repository (untracked directory entry)', async () => {
    const reason = await reasonAfter(
      'r-nested',
      (r) => appendFileSync(path.join(r, 'a.txt'), 'more\n'),
      ['a.txt'],
      (r) => {
        fx.repo(path.relative(fx.root, path.join(r, 'inner')), { files: { 'i.txt': 'i\n' } });
      },
    );
    expect(reason).toBe('nested-repository');
  });

  it('a submodule', async () => {
    const lib = fx.repo('r-sub-lib', { files: { 'l.txt': 'l\n' } });
    const reason = await reasonAfter(
      'r-sub',
      (r) => appendFileSync(path.join(r, 'a.txt'), 'more\n'),
      ['a.txt'],
      (r) => {
        fx.git(r, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'sub']);
        fx.git(r, ['commit', '-qm', 'sub']);
      },
    );
    expect(reason).toBe('submodules');
  });

  it('paths inside a .git, invalid or too many paths', () => {
    expect(checkHint(['sub/.git/HEAD'])).toEqual({ ok: false, reason: 'nested-git' });
    expect(checkHint(['../x'])).toEqual({ ok: false, reason: 'invalid-path' });
    expect(checkHint(['/abs'])).toEqual({ ok: false, reason: 'invalid-path' });
    expect(checkHint(['a//b'])).toEqual({ ok: false, reason: 'invalid-path' });
    expect(checkHint(['bad�name'])).toEqual({ ok: false, reason: 'undecodable-path' });
    const many = Array.from({ length: MAX_HINT_PATHS + 1 }, (_, i) => `f${i}`);
    expect(checkHint(many)).toEqual({ ok: false, reason: 'too-many-paths' });
    expect(checkHint(['sp ace', 'new\nline', 'ünï'])).toMatchObject({ ok: true });
  });

  it('Region matches a path and everything under it, like a literal pathspec', () => {
    const region = new Region(['dir', 'a.txt']);
    expect(region.has('dir')).toBe(true);
    expect(region.has('dir/x')).toBe(true);
    expect(region.has('dir/sub/')).toBe(true);
    expect(region.has('dirx')).toBe(false);
    expect(region.has('di')).toBe(false);
    expect(region.has('a.txt')).toBe(true);
    expect(region.has('a.txt.bak')).toBe(false);
  });
});

describe('incremental summary: missed events', () => {
  it.skipIf(FOLDS)(
    skipped('trusts the hint for clean files, and a full refresh repairs a lost event'),
    async () => {
      const repo = dirtyRepo('lost');
      const core = createGitCore(fx.coreOptions({ env: isolated() }));
      try {
        const wt = locator(repo);
        await core.getSummary(wt);
        // b.txt was clean: its edit is lost (the hint names another file).
        appendFileSync(path.join(repo, 'b.txt'), 'lost edit\n');
        appendFileSync(path.join(repo, 'a.txt'), 'seen edit\n');
        const stale = await core.getSummary(wt, { changedPaths: ['a.txt'] });
        expect(stale.refresh?.mode).toBe('incremental');
        const truth = await reference.getSummary(wt);
        expect(stale.stateHash).not.toBe(truth.stateHash);
        expect(stale.changedFiles).toBe(truth.changedFiles - 1);
        // The daemon's reconciliation: a refresh without a hint.
        const repaired = await core.getSummary(wt, { snapshot: true });
        expect(repaired.refresh?.mode).toBe('full');
        await expectSameAsFull(core, repo, repaired);
        // And incremental refreshes after it start from the repaired state.
        appendFileSync(path.join(repo, 'a.txt'), 'later\n');
        const after = await core.getSummary(wt, { snapshot: true, changedPaths: ['a.txt'] });
        expect(after.refresh?.mode).toBe('incremental');
        await expectSameAsFull(core, repo, after);
      } finally {
        await core.dispose();
      }
    },
  );

  it('an already changed file whose event was lost is recomputed from its signature', async () => {
    const repo = dirtyRepo('lost-dirty');
    const core = createGitCore(fx.coreOptions({ env: isolated() }));
    try {
      const wt = locator(repo);
      await core.getSummary(wt);
      // a.txt is modified already: its new edit changes its lstat signature.
      appendFileSync(path.join(repo, 'a.txt'), 'unreported\n');
      fx.write(path.join(repo, 'other.txt'), 'reported\n');
      const got = await core.getSummary(wt, { snapshot: true, changedPaths: ['other.txt'] });
      expect(got.refresh).toMatchObject(
        FOLDS
          ? { mode: 'full', reason: 'case-insensitive' }
          : { mode: 'incremental', pathspecs: 2 },
      );
      await expectSameAsFull(core, repo, got);
    } finally {
      await core.dispose();
    }
  });

  it('a deleted directory is covered by its path (literal pathspecs match below it)', async () => {
    const repo = dirtyRepo('rm-dir');
    fx.write(path.join(repo, 'dir', 'untracked.txt'), 'u\n');
    const core = createGitCore(fx.coreOptions({ env: isolated() }));
    try {
      const wt = locator(repo);
      await core.getSummary(wt);
      rmSync(path.join(repo, 'dir'), { recursive: true });
      const got = await core.getSummary(wt, { snapshot: true, changedPaths: ['dir'] });
      expect(got.refresh?.mode).toBe(HINTED);
      expect(got.counts).toMatchObject({ unstaged: 2, untracked: 1 });
      await expectSameAsFull(core, repo, got);
    } finally {
      await core.dispose();
    }
  });

  it('a staged rename stays paired when only its destination is edited', async () => {
    const repo = dirtyRepo('rename');
    fx.git(repo, ['mv', 'b.txt', 'moved.txt']);
    const core = createGitCore(fx.coreOptions({ env: isolated() }));
    try {
      const wt = locator(repo);
      await core.getSummary(wt);
      appendFileSync(path.join(repo, 'moved.txt'), 'edit after the move\n');
      const got = await core.getSummary(wt, { snapshot: true, changedPaths: ['moved.txt'] });
      expect(got.refresh).toMatchObject(
        FOLDS
          ? { mode: 'full', reason: 'case-insensitive' }
          : { mode: 'incremental', pathspecs: 2 },
      );
      await expectSameAsFull(core, repo, got);
    } finally {
      await core.dispose();
    }
  });
});

describe.runIf(FOLDS)('a case-folding filesystem (macOS; DECISIONS #288)', () => {
  it('every hinted refresh is full (case-insensitive) and equals a full summary', async () => {
    const repo = dirtyRepo('folding');
    const core = createGitCore(fx.coreOptions({ env: isolated() }));
    try {
      const wt = locator(repo);
      await core.getSummary(wt);
      const steps: Array<[() => void, string[]]> = [
        [() => appendFileSync(path.join(repo, 'a.txt'), 'edit\n'), ['a.txt']],
        [() => fx.write(path.join(repo, 'brand-new.txt'), 'new\n'), ['brand-new.txt']],
        [() => rmSync(path.join(repo, 'dir'), { recursive: true }), ['dir']],
        [() => fx.git(repo, ['mv', 'b.txt', 'moved.txt']), ['b.txt', 'moved.txt']],
      ];
      for (const [change, hint] of steps) {
        change();
        const got = await core.getSummary(wt, { snapshot: true, changedPaths: hint });
        expect(got.refresh).toEqual({ mode: 'full', reason: 'case-insensitive', pathspecs: 0 });
        await expectSameAsFull(core, repo, got);
      }
    } finally {
      await core.dispose();
    }
  });
});

describe('keysInRegion', () => {
  it('finds what Region.has matches, once each, in order (nested pathspecs too)', async () => {
    const { keysInRegion } = await import('../src/incremental.js');
    const sorted = ['a', 'a b', 'a-x', 'a/', 'a/b', 'a/b/c', 'ab', 'b', 'dir/x', 'dir/y/z'].sort();
    for (const specs of [['a'], ['a', 'a/b'], ['dir', 'dir/y'], ['b', 'zzz'], ['a b'], []]) {
      const region = new Region(specs);
      expect(keysInRegion(sorted, region)).toEqual(sorted.filter((k) => region.has(k)));
    }
  });
});
