/**
 * #30: the branch scope and "All on branch" diff against the integration base `N`, the newest
 * default-branch commit HEAD has absorbed from the local branch or its remote-tracking ref. A stale
 * local `main` (the usual `fetch` + `merge origin/main`) no longer shows other people's files as
 * the branch's own change. Repositories use a bare repository as `origin`, filled with
 * `git clone` / `push` / `fetch` between directories of the temp dir: no network.
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { noopLogger } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitContext } from '../src/context.js';
import { resolveRefName } from '../src/discovery.js';
import { createGitCore } from '../src/index.js';
import { integrationBase, remoteTrackingOf, resolveTip } from '../src/integration-base.js';
import { GitRunner } from '../src/runner/runner.js';
import { listFiles, locator } from './helpers/core.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

let fx: Fixture;

beforeAll(() => {
  fx = createFixture();
});
afterAll(() => {
  fx.dispose();
});

const rev = (cwd: string, name: string) => fx.git(cwd, ['rev-parse', name]).trim();

interface Scenario {
  origin: string;
  /** The clone with the feature branch checked out. */
  work: string;
  /** A second clone, to make `origin/main` move. */
  other: string;
}

/** `origin` (bare) with `main`; `work` and `other` are clones of it. */
function scenario(name: string): Scenario {
  const origin = path.join(fx.root, `${name}-origin.git`);
  const seed = fx.repo(`${name}-seed`, { files: { 'base.txt': 'base\n' } });
  fx.git(fx.root, ['clone', '-q', '--bare', seed, origin]);
  const work = path.join(fx.root, `${name}-work`);
  const other = path.join(fx.root, `${name}-other`);
  fx.git(fx.root, ['clone', '-q', origin, work]);
  fx.git(fx.root, ['clone', '-q', origin, other]);
  return { origin, work, other };
}

/** A commit on `origin/main` made from the other clone. */
function upstreamCommit(s: Scenario, file: string): void {
  fx.write(path.join(s.other, file), `${file}\n`);
  fx.commitAll(s.other, `upstream ${file}`);
  fx.git(s.other, ['push', '-q', 'origin', 'main']);
}

/** The stale-main story: feature branched, origin/main moved, fetched, merged into the feature. */
function staleMain(name: string): Scenario {
  const s = scenario(name);
  fx.git(s.work, ['switch', '-q', '-c', 'feature']);
  fx.write(path.join(s.work, 'own.txt'), 'own\n');
  fx.commitAll(s.work, 'own work');
  upstreamCommit(s, 'theirs.txt');
  fx.git(s.work, ['fetch', '-q', 'origin']);
  fx.git(s.work, ['merge', '-q', '--no-edit', 'origin/main']);
  return s;
}

const paths = (files: { path: string }[]) => files.map((f) => f.path).sort();

describe('stale local main (fetch + merge origin/main into the feature branch)', () => {
  let s: Scenario;
  const core = () => createGitCore(fx.coreOptions());
  beforeAll(() => {
    s = staleMain('stale');
  });

  it('the fixture is what we think it is: local main is behind origin/main', () => {
    expect(rev(s.work, 'main')).not.toBe(rev(s.work, 'origin/main'));
    expect(
      fx.git(s.work, ['merge-base', '--is-ancestor', 'main', 'origin/main'], { allowFail: true }),
    ).toBe('');
    expect(fx.git(s.work, ['diff', '--name-only', 'main', 'HEAD'])).toContain('theirs.txt');
  });

  it('the branch scope excludes origin/main-only files', async () => {
    const c = core();
    const wt = locator(s.work);
    expect(paths(await listFiles(c, wt, { kind: 'branch' }))).toEqual(['own.txt']);
    await c.dispose();
  });

  it('"All on branch" (branch + working) excludes them too and keeps uncommitted work', async () => {
    const c = core();
    const wt = locator(s.work);
    fx.write(path.join(s.work, 'wip.txt'), 'wip\n');
    fx.write(path.join(s.work, 'own.txt'), 'own\nmore\n');
    const files = await listFiles(c, wt, { kind: 'branch', includeWorking: true });
    expect(paths(files)).toEqual(['own.txt', 'wip.txt']);
    fx.git(s.work, ['checkout', '--', 'own.txt']);
    writeFileSync(path.join(s.work, 'wip.txt'), '');
    fx.git(s.work, ['clean', '-fdq']);
    await c.dispose();
  });

  it('a configured defaultBranch (local name) gets the same base; a remote name is taken as is', async () => {
    const c = core();
    const wt = locator(s.work);
    expect(paths(await listFiles(c, wt, { kind: 'branch' }, { defaultBranch: 'main' }))).toEqual([
      'own.txt',
    ]);
    // `origin/main` is already the remote-tracking ref: nothing to pair, same answer.
    expect(
      paths(await listFiles(c, wt, { kind: 'branch' }, { defaultBranch: 'origin/main' })),
    ).toEqual(['own.txt']);
    await c.dispose();
  });

  it('an explicit scope base is used exactly as given (it is not the default branch)', async () => {
    const c = core();
    const wt = locator(s.work);
    expect(paths(await listFiles(c, wt, { kind: 'branch', base: 'main' }))).toEqual([
      'own.txt',
      'theirs.txt',
    ]);
    await c.dispose();
  });

  it('the summary still measures ahead/behind against the default branch it always did', async () => {
    const c = core();
    const summary = await c.getSummary(locator(s.work));
    expect(summary).toMatchObject({ aheadBehindRef: 'main', ahead: 3, behind: 0 });
    await c.dispose();
  });

  it('readBranchBase reports the remote-tracking ref, and follows a fetch', async () => {
    const c = core();
    const project = { id: 'p', commonDir: path.join(s.work, '.git') };
    const before = await c.readBranchBase?.(project, { defaultBranch: 'main' });
    expect(before).toEqual({
      name: 'main',
      ref: 'refs/heads/main',
      oid: rev(s.work, 'main'),
      remote: {
        name: 'origin/main',
        ref: 'refs/remotes/origin/main',
        oid: rev(s.work, 'origin/main'),
      },
    });
    // An explicit base and a remote name carry no pairing.
    expect(await c.readBranchBase?.(project, { base: 'main' })).toEqual({
      name: 'main',
      ref: 'refs/heads/main',
      oid: rev(s.work, 'main'),
    });
    expect((await c.readBranchBase?.(project, { defaultBranch: 'origin/main' }))?.remote).toBe(
      undefined,
    );

    upstreamCommit(s, 'later.txt');
    fx.git(s.work, ['fetch', '-q', 'origin']);
    const after = await c.readBranchBase?.(project, { defaultBranch: 'main' });
    expect(after?.oid).toBe(before?.oid);
    expect(after?.remote?.oid).toBe(rev(s.work, 'origin/main'));
    expect(after?.remote?.oid).not.toBe(before?.remote?.oid);
    // The feature branch has not merged the new commit: the scope is unchanged (N stays put).
    expect(paths(await listFiles(c, locator(s.work), { kind: 'branch' }))).toEqual(['own.txt']);
    await c.dispose();
  });

  it('answers the same from packed refs and from git when the files cannot tell', async () => {
    const c = core();
    const project = { id: 'p', commonDir: path.join(s.work, '.git') };
    const loose = await c.readBranchBase?.(project, { defaultBranch: 'main' });
    fx.git(s.work, ['pack-refs', '--all', '--prune']);
    expect(await c.readBranchBase?.(project, { defaultBranch: 'main' })).toEqual(loose);
    // A symbolic `refs/remotes/origin/main` sends the lookup to git; same commit, same answer.
    fx.git(s.work, ['symbolic-ref', 'refs/remotes/origin/alias', 'refs/remotes/origin/main']);
    expect((await c.readBranchBase?.(project, { defaultBranch: 'main' }))?.remote?.oid).toBe(
      loose?.remote?.oid,
    );
    await c.dispose();
  });
});

describe('what stays as it was', () => {
  it('no remote: the branch scope is measured against local main', async () => {
    const repo = fx.repo('no-remote', { files: { 'a.txt': 'a\n' } });
    fx.git(repo, ['switch', '-q', '-c', 'feature']);
    fx.write(path.join(repo, 'f.txt'), 'f\n');
    fx.commitAll(repo, 'feature');
    const c = createGitCore(fx.coreOptions());
    expect(paths(await listFiles(c, locator(repo), { kind: 'branch' }))).toEqual(['f.txt']);
    const base = await c.readBranchBase?.(
      { id: 'p', commonDir: path.join(repo, '.git') },
      { defaultBranch: 'main' },
    );
    expect(base).toEqual({ name: 'main', ref: 'refs/heads/main', oid: rev(repo, 'main') });
    await c.dispose();
  });

  it('a remote without a remote-tracking ref for the default branch is the same', async () => {
    const s = scenario('no-tracking');
    fx.git(s.work, ['update-ref', '-d', 'refs/remotes/origin/main']);
    fx.git(s.work, ['switch', '-q', '-c', 'feature']);
    fx.write(path.join(s.work, 'f.txt'), 'f\n');
    fx.commitAll(s.work, 'feature');
    const c = createGitCore(fx.coreOptions());
    expect(paths(await listFiles(c, locator(s.work), { kind: 'branch' }))).toEqual(['f.txt']);
    await c.dispose();
  });

  it("the default branch's own worktree has nothing on its branch, however stale it is", async () => {
    const s = scenario('own-worktree');
    upstreamCommit(s, 'theirs.txt');
    fx.git(s.work, ['fetch', '-q', 'origin']);
    const c = createGitCore(fx.coreOptions());
    expect(await listFiles(c, locator(s.work), { kind: 'branch' })).toEqual([]);
    fx.write(path.join(s.work, 'wip.txt'), 'wip\n');
    expect(
      paths(await listFiles(c, locator(s.work), { kind: 'branch', includeWorking: true })),
    ).toEqual(['wip.txt']);
    await c.dispose();
  });

  it('a feature branch that never merged origin/main still diffs from its fork point', async () => {
    const s = scenario('never-merged');
    fx.git(s.work, ['switch', '-q', '-c', 'feature']);
    fx.write(path.join(s.work, 'own.txt'), 'own\n');
    fx.commitAll(s.work, 'own');
    upstreamCommit(s, 'theirs.txt');
    fx.git(s.work, ['fetch', '-q', 'origin']);
    const c = createGitCore(fx.coreOptions());
    expect(paths(await listFiles(c, locator(s.work), { kind: 'branch' }))).toEqual(['own.txt']);
    await c.dispose();
  });

  it('local main ahead of origin/main (unpushed commits) and merged into the feature', async () => {
    const s = scenario('local-ahead');
    fx.write(path.join(s.work, 'local-main.txt'), 'x\n');
    fx.commitAll(s.work, 'unpushed on main');
    fx.git(s.work, ['switch', '-q', '-c', 'feature']);
    fx.write(path.join(s.work, 'own.txt'), 'own\n');
    fx.commitAll(s.work, 'own');
    const c = createGitCore(fx.coreOptions());
    expect(paths(await listFiles(c, locator(s.work), { kind: 'branch' }))).toEqual(['own.txt']);
    await c.dispose();
  });

  it('diverged main and origin/main: the feature absorbed origin/main only', async () => {
    const s = scenario('diverged');
    fx.write(path.join(s.work, 'local-main.txt'), 'x\n');
    fx.commitAll(s.work, 'unpushed on main');
    fx.git(s.work, ['switch', '-q', '-c', 'feature', 'main~1']);
    fx.write(path.join(s.work, 'own.txt'), 'own\n');
    fx.commitAll(s.work, 'own');
    upstreamCommit(s, 'theirs.txt');
    fx.git(s.work, ['fetch', '-q', 'origin']);
    fx.git(s.work, ['merge', '-q', '--no-edit', 'origin/main']);
    const c = createGitCore(fx.coreOptions());
    expect(paths(await listFiles(c, locator(s.work), { kind: 'branch' }))).toEqual(['own.txt']);
    await c.dispose();
  });

  it('a remote-tracking ref whose object is missing falls back to local main', async () => {
    const s = staleMain('missing-object');
    writeFileSync(
      path.join(s.work, '.git', 'refs', 'remotes', 'origin', 'main'),
      `${'ab'.repeat(20)}\n`,
    );
    const c = createGitCore(fx.coreOptions());
    expect(paths(await listFiles(c, locator(s.work), { kind: 'branch' }))).toEqual([
      'own.txt',
      'theirs.txt',
    ]);
    await c.dispose();
  });
});

describe('spawn cost', () => {
  it('N is one memoized merge-base per (HEAD, local, remote); the default worktree needs none', async () => {
    const s = staleMain('spawns');
    const dir = path.join(fx.root, 'spawns.log.d');
    mkdirSync(dir);
    const wrapper = path.join(fx.root, 'spawns.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nf=$(mktemp '${dir}/XXXXXXXX')\nfor a in "$@"; do printf '%s\\001' "$a" >> "$f"; done\nexec git "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    const mergeBases = () =>
      readdirSync(dir)
        .map((f) => readFileSync(path.join(dir, f), 'utf8').split('\u0001'))
        .filter((args) => args.includes('merge-base')).length;
    const c = createGitCore(fx.coreOptions({ gitBinary: wrapper }));
    const wt = locator(s.work);
    await listFiles(c, wt, { kind: 'branch' });
    expect(mergeBases()).toBe(1);
    await listFiles(c, wt, { kind: 'branch', includeWorking: true });
    await listFiles(c, wt, { kind: 'branch' });
    expect(mergeBases()).toBe(1);
    await c.dispose();

    // HEAD is a default-branch tip: no merge-base at all.
    const c2 = createGitCore(fx.coreOptions({ gitBinary: wrapper }));
    fx.git(s.work, ['switch', '-q', 'main']);
    const before = mergeBases();
    expect(await listFiles(c2, locator(s.work), { kind: 'branch' })).toEqual([]);
    expect(mergeBases()).toBe(before);
    await c2.dispose();
  });
});

describe('N and TIP', () => {
  const ctx = () =>
    new GitContext(
      new GitRunner({
        bigFileThreshold: 50 * 1024 * 1024,
        concurrency: 4,
        timeoutMs: 15_000,
        maxOutputBytes: 64 * 1024 * 1024,
        env: fx.env,
        logger: noopLogger,
      }),
      {
        timeoutMs: 15_000,
        maxOutputBytes: 64 * 1024 * 1024,
        maxPatchBytes: 1024 * 1024,
        maxUntrackedFiles: 2000,
        bigFileThreshold: 50 * 1024 * 1024,
        logger: noopLogger,
      },
    );

  it('N is the newest absorbed default-branch commit; TIP is the newer of the two refs', async () => {
    const s = staleMain('tip');
    const c = ctx();
    const repo = await c.repo(s.work);
    const main = await resolveRefName(c, repo, 'main');
    const remote = main ? await remoteTrackingOf(c, repo, main) : null;
    if (!main || !remote) throw new Error('refs missing');
    expect(remote.name).toBe('origin/main');
    const head = rev(s.work, 'HEAD');
    // The feature branch merged origin/main: that tip is the base, local main is the stale one.
    expect(await integrationBase(c, repo, head, main, remote)).toBe(remote.oid);
    expect(await integrationBase(c, repo, head, main, null)).toBe(main.oid);
    expect((await resolveTip(c, repo, main, remote)).ref).toBe('refs/remotes/origin/main');
    expect((await resolveTip(c, repo, main, null)).ref).toBe('refs/heads/main');

    // Local main fast-forwards to origin/main: same commit, local named.
    fx.git(s.work, ['branch', '-f', 'main', 'origin/main']);
    const ff = await resolveRefName(c, repo, 'main');
    expect(ff && (await resolveTip(c, repo, ff, remote)).ref).toBe('refs/heads/main');

    // Local main ahead: local wins; diverged: remote.
    fx.git(s.work, ['switch', '-q', 'main']);
    fx.write(path.join(s.work, 'ahead.txt'), 'x\n');
    fx.commitAll(s.work, 'ahead');
    const ahead = await resolveRefName(c, repo, 'main');
    expect(ahead && (await resolveTip(c, repo, ahead, remote)).ref).toBe('refs/heads/main');
    fx.git(s.work, ['reset', '-q', '--hard', 'origin/main~1']);
    fx.write(path.join(s.work, 'diverged.txt'), 'x\n');
    fx.commitAll(s.work, 'diverged');
    const diverged = await resolveRefName(c, repo, 'main');
    expect(diverged && (await resolveTip(c, repo, diverged, remote)).ref).toBe(
      'refs/remotes/origin/main',
    );
  });
});
