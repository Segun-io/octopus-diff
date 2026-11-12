/**
 * #32: `readFileOrigins` tells the worktree's own work from changes that came from the default
 * branch (merge noise). Every scenario is a scratch repository in the temp dir with isolated git
 * config; `origin` is a bare repository filled with `clone` / `push` / `fetch` between local
 * directories (no network). Each test classifies the "To review" list the daemon would show: the
 * review range's base (`O`) and `listChangedFiles({ kind: 'review', base: O })`.
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type GitCore, isGitCoreError } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore } from '../src/index.js';
import { locator } from './helpers/core.js';
import { createFixture, type Fixture, lines, RAW_NAMES_SUPPORTED } from './helpers/fixture.js';

let fx: Fixture;

beforeAll(() => {
  fx = createFixture();
});
afterAll(() => {
  fx.dispose();
});

const rev = (cwd: string, name: string) => fx.git(cwd, ['rev-parse', name]).trim();

interface Scenario {
  /** The clone with the feature branch checked out. */
  work: string;
  /** A second clone, to make `origin/main` move. */
  other: string;
  /**
   * Where `feature` started: the bookmark the daemon stores on first sight (the merge-base with
   * the default branch at that time), so later merges of `main` land inside the review range.
   */
  start: string;
}

let counter = 0;

/** `origin` (bare) with `main` holding `files`; `work` (on `feature`) and `other` clone it. */
function scenario(files: Record<string, string> = {}): Scenario {
  counter += 1;
  const name = `s${counter}`;
  const origin = path.join(fx.root, `${name}-origin.git`);
  const seed = fx.repo(`${name}-seed`, { files: { 'base.txt': 'base\n', ...files } });
  fx.git(fx.root, ['clone', '-q', '--bare', seed, origin]);
  const work = path.join(fx.root, `${name}-work`);
  const other = path.join(fx.root, `${name}-other`);
  fx.git(fx.root, ['clone', '-q', origin, work]);
  fx.git(fx.root, ['clone', '-q', origin, other]);
  fx.git(work, ['switch', '-q', '-c', 'feature']);
  return { work, other, start: rev(work, 'HEAD') };
}

function write(dir: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fx.write(path.join(dir, file), content);
  }
}

/** Writes and commits in `dir`. */
function commit(dir: string, files: Record<string, string>, message = 'change'): string {
  write(dir, files);
  return fx.commitAll(dir, message);
}

/** A commit on `origin/main` made from the other clone (then pushed). */
function upstream(s: Scenario, files: Record<string, string>): string {
  fx.git(s.other, ['pull', '-q', '--ff-only']);
  const sha = commit(s.other, files, 'upstream');
  fx.git(s.other, ['push', '-q', 'origin', 'main']);
  return sha;
}

/** Brings `origin/main` into the work clone's refs (local `main` stays where it was). */
const fetch = (s: Scenario) => fx.git(s.work, ['fetch', '-q', 'origin']);

/** Moves the work clone's local `main` to `origin/main` without leaving `feature`. */
const syncMain = (s: Scenario) => {
  fetch(s);
  fx.git(s.work, ['update-ref', 'refs/heads/main', 'refs/remotes/origin/main']);
};

const merge = (dir: string, what: string, allowFail = false) =>
  fx.git(dir, ['merge', '-q', '--no-edit', what], { allowFail });

type Origins = Record<string, string>;

/**
 * The review list's origins as `{ path: 'own' | 'base:merge' | ... }`. `bookmark` null = first
 * sight (the range starts at the merge-base with the default branch).
 */
async function classify(
  core: GitCore,
  dir: string,
  options: { bookmark?: string | null; defaultBranch?: string; withFiles?: boolean } = {},
): Promise<{ origins: Origins; integrationRef: string | null; n: string | null }> {
  const wt = locator(dir);
  const range = await core.readReviewRange?.(wt, {
    bookmark: options.bookmark ?? null,
    defaultBranch: options.defaultBranch,
  });
  const base = range?.base ?? null;
  const files = await core.listChangedFiles(
    wt,
    base ? { kind: 'review', base } : { kind: 'review' },
  );
  const result = await core.readFileOrigins?.(wt, {
    base,
    defaultBranch: options.defaultBranch,
    ...(options.withFiles === false ? {} : { files }),
  });
  if (!result) throw new Error('readFileOrigins missing');
  const origins: Origins = {};
  for (const [key, info] of [...result.origins].sort(([a], [b]) => (a < b ? -1 : 1))) {
    origins[key] = info.via ? `${info.origin}:${info.via}` : info.origin;
  }
  if (options.withFiles !== false) expect(Object.keys(origins).sort()).toEqual(keys(files));
  return { origins, integrationRef: result.integrationRef, n: result.n };
}

const keys = (files: { path: string; rawPath?: string }[]) =>
  files.map((f) => f.rawPath ?? f.path).sort();

describe('readFileOrigins: committed history', () => {
  let core: GitCore;
  beforeAll(() => {
    core = createGitCore(fx.coreOptions());
  });
  afterAll(async () => {
    await core.dispose();
  });

  it('merge main in, clean: own work stays own, main-only files are base (merge)', async () => {
    const s = scenario();
    commit(s.work, { 'own.txt': 'own\n' });
    upstream(s, { 'theirs.txt': 't\n', 'dir/deep.txt': 'd\n' });
    syncMain(s);
    merge(s.work, 'main');
    const { origins, integrationRef, n } = await classify(core, s.work, { bookmark: s.start });
    expect(origins).toEqual({
      'dir/deep.txt': 'base:merge',
      'own.txt': 'own',
      'theirs.txt': 'base:merge',
    });
    expect(integrationRef).toBe('origin/main');
    expect(n).toBe(rev(s.work, 'main'));
  });

  it('fetch + merge origin/main with a stale local main: the same answer', async () => {
    const s = scenario();
    commit(s.work, { 'own.txt': 'own\n' });
    upstream(s, { 'theirs.txt': 't\n' });
    fetch(s);
    merge(s.work, 'origin/main');
    expect(rev(s.work, 'main')).not.toBe(rev(s.work, 'origin/main'));
    const { origins, integrationRef, n } = await classify(core, s.work, { bookmark: s.start });
    // O is the merge-base with the stale local main, so the list shows theirs.txt; it is noise.
    expect(origins).toEqual({ 'own.txt': 'own', 'theirs.txt': 'base:merge' });
    expect(integrationRef).toBe('origin/main');
    expect(n).toBe(rev(s.work, 'origin/main'));
  });

  it('a file both sides changed (clean merge) is mixed', async () => {
    const s = scenario({ 'shared.txt': lines(20) });
    commit(s.work, { 'shared.txt': lines(20).replace('line 2', 'own two') });
    upstream(s, { 'shared.txt': lines(20).replace('line 18', 'their eighteen') });
    syncMain(s);
    merge(s.work, 'main');
    expect((await classify(core, s.work, { bookmark: s.start })).origins).toEqual({
      'shared.txt': 'mixed:merge',
    });
  });

  it('a conflict resolved by hand is mixed; one resolved as theirs is base', async () => {
    const s = scenario({ 'hand.txt': 'base\n', 'theirs-wins.txt': 'base\n' });
    commit(s.work, { 'hand.txt': 'own\n', 'theirs-wins.txt': 'own\n', 'own.txt': 'own\n' });
    upstream(s, { 'hand.txt': 'main\n', 'theirs-wins.txt': 'main\n' });
    syncMain(s);
    merge(s.work, 'main', true);
    write(s.work, { 'hand.txt': 'own\nmain\n' });
    fx.git(s.work, ['checkout', '--theirs', '--', 'theirs-wins.txt']);
    fx.git(s.work, ['add', '--', 'hand.txt', 'theirs-wins.txt']);
    fx.git(s.work, ['commit', '-q', '--no-edit']);
    expect((await classify(core, s.work, { bookmark: s.start })).origins).toEqual({
      'hand.txt': 'mixed:merge',
      'own.txt': 'own',
      'theirs-wins.txt': 'base:merge',
    });
  });

  it('a cherry-pick from main is base, "same as main"', async () => {
    const s = scenario();
    commit(s.work, { 'own.txt': 'own\n' });
    const picked = upstream(s, { 'fix.txt': 'fix\n' });
    upstream(s, { 'later.txt': 'later\n' });
    syncMain(s);
    fx.git(s.work, ['cherry-pick', picked]);
    // later.txt is not in the list (never brought in); fix.txt matches main's newest version.
    expect((await classify(core, s.work, { bookmark: s.start })).origins).toEqual({
      'fix.txt': 'base:same-as-base',
      'own.txt': 'own',
    });
  });

  it('own work squash-landed on main is "same as main"; merged back it is base (merge)', async () => {
    const s = scenario();
    commit(s.work, { 'own.txt': 'own\n' });
    fx.git(s.work, ['push', '-q', 'origin', 'feature']);
    // The forge squash-merges the branch into main.
    fx.git(s.other, ['fetch', '-q', 'origin']);
    fx.git(s.other, ['merge', '-q', '--squash', 'origin/feature']);
    fx.git(s.other, ['commit', '-q', '-m', 'squash']);
    fx.git(s.other, ['push', '-q', 'origin', 'main']);
    upstream(s, { 'theirs.txt': 't\n' });
    fetch(s);
    expect((await classify(core, s.work, { bookmark: s.start })).origins).toEqual({
      'own.txt': 'base:same-as-base',
    });
    merge(s.work, 'origin/main');
    expect((await classify(core, s.work, { bookmark: s.start })).origins).toEqual({
      'own.txt': 'base:merge',
      'theirs.txt': 'base:merge',
    });
  });

  it('rebase onto origin/main (stale local main): main files are base (rebase)', async () => {
    const s = scenario({ 'shared.txt': lines(20) });
    commit(s.work, { 'own.txt': 'own\n', 'shared.txt': lines(20).replace('line 2', 'own') });
    upstream(s, { 'theirs.txt': 't\n', 'shared.txt': lines(20).replace('line 18', 'theirs') });
    fetch(s);
    fx.git(s.work, ['rebase', '-q', 'origin/main']);
    expect((await classify(core, s.work, { bookmark: s.start })).origins).toEqual({
      'own.txt': 'own',
      'shared.txt': 'mixed:rebase',
      'theirs.txt': 'base:rebase',
    });
  });

  it('a rebase with an up-to-date main shows no noise at all (the list starts at N)', async () => {
    const s = scenario();
    const reviewed = commit(s.work, { 'own.txt': 'own\n' });
    upstream(s, { 'theirs.txt': 't\n' });
    syncMain(s);
    fx.git(s.work, ['rebase', '-q', 'main']);
    // The bookmark (the pre-rebase commit) is unreachable: the range falls back to N.
    expect((await classify(core, s.work, { bookmark: reviewed })).origins).toEqual({
      'own.txt': 'own',
    });
  });

  it('a branch fast-forwarded along main (no own commits) is base (update)', async () => {
    const s = scenario();
    const start = rev(s.work, 'HEAD');
    upstream(s, { 'theirs.txt': 't\n' });
    syncMain(s);
    merge(s.work, 'main');
    expect(rev(s.work, 'HEAD')).toBe(rev(s.work, 'main'));
    expect((await classify(core, s.work, { bookmark: start })).origins).toEqual({
      'theirs.txt': 'base:update',
    });
  });

  it('renames: own renames are own, main renames are base, own rename of a file main changed is mixed', async () => {
    // Distinct contents: rename detection pairs identical files arbitrarily.
    const s = scenario({
      'theirs-old.txt': lines(20).replaceAll('line', 'theirs'),
      'mine-old.txt': lines(20).replaceAll('line', 'mine'),
      'both.txt': lines(20),
    });
    fx.git(s.work, ['mv', 'mine-old.txt', 'mine-new.txt']);
    fx.git(s.work, ['mv', 'both.txt', 'both-new.txt']);
    fx.commitAll(s.work, 'own renames');
    fx.git(s.other, ['mv', 'theirs-old.txt', 'theirs-new.txt']);
    write(s.other, { 'both.txt': lines(20).replace('line 18', 'theirs') });
    fx.commitAll(s.other, 'their rename');
    fx.git(s.other, ['push', '-q', 'origin', 'main']);
    syncMain(s);
    merge(s.work, 'main');
    expect(readFileSync(path.join(s.work, 'both-new.txt'), 'utf8')).toContain('theirs');
    expect((await classify(core, s.work, { bookmark: s.start })).origins).toEqual({
      'both-new.txt': 'mixed:merge',
      'mine-new.txt': 'own',
      'theirs-new.txt': 'base:merge',
    });
  });

  it("own work reverted after the bookmark stays own (HEAD has N's version, main never touched it)", async () => {
    const s = scenario({ 'x.txt': 'x\n' });
    const reviewed = commit(s.work, { 'x.txt': 'changed\n' });
    commit(s.work, { 'x.txt': 'x\n' }, 'revert');
    expect((await classify(core, s.work, { bookmark: reviewed })).origins).toEqual({
      'x.txt': 'own',
    });
  });

  it('a merge of a sibling branch (not the default branch) is own (decision 6)', async () => {
    const s = scenario();
    commit(s.work, { 'own.txt': 'own\n' });
    fx.git(s.work, ['switch', '-q', '-c', 'sibling', 'main']);
    commit(s.work, { 'sibling.txt': 's\n' });
    fx.git(s.work, ['switch', '-q', 'feature']);
    merge(s.work, 'sibling');
    expect((await classify(core, s.work, { bookmark: s.start })).origins).toEqual({
      'own.txt': 'own',
      'sibling.txt': 'own',
    });
  });

  it('uncommitted changes are own even on a base file', async () => {
    const s = scenario();
    commit(s.work, { 'own.txt': 'own\n' });
    upstream(s, { 'theirs.txt': 't\n', 'staged.txt': 's\n' });
    syncMain(s);
    merge(s.work, 'main');
    write(s.work, { 'theirs.txt': 't\nedited\n', 'staged.txt': 's\nstaged\n', 'new.txt': 'n\n' });
    fx.git(s.work, ['add', '--', 'staged.txt']);
    expect((await classify(core, s.work, { bookmark: s.start })).origins).toEqual({
      'new.txt': 'own',
      'own.txt': 'own',
      'staged.txt': 'own',
      'theirs.txt': 'own',
    });
  });

  it.runIf(RAW_NAMES_SUPPORTED)('keys paths that are not UTF-8 by rawPath', async () => {
    const s = scenario();
    commit(s.work, { 'own.txt': 'own\n' });
    fx.git(s.other, ['pull', '-q', '--ff-only']);
    const name = Buffer.from([0x72, 0x61, 0x77, 0xff]);
    fx.writeRaw(s.other, name, 'raw\n');
    fx.commitAll(s.other, 'raw name');
    fx.git(s.other, ['push', '-q', 'origin', 'main']);
    syncMain(s);
    merge(s.work, 'main');
    const { origins } = await classify(core, s.work, { bookmark: s.start });
    expect(origins).toEqual({ 'own.txt': 'own', [name.toString('base64')]: 'base:merge' });
  });
});

describe('readFileOrigins: operations in progress', () => {
  let core: GitCore;
  beforeAll(() => {
    core = createGitCore(fx.coreOptions());
  });
  afterAll(async () => {
    await core.dispose();
  });

  it('a merge of main stopped on a conflict: staged main files are base, both-sides mixed, the conflict own', async () => {
    const s = scenario({ 'conflict.txt': 'base\n', 'both.txt': lines(20) });
    commit(s.work, {
      'own.txt': 'own\n',
      'conflict.txt': 'own\n',
      'both.txt': lines(20).replace('line 2', 'own'),
    });
    upstream(s, {
      'theirs.txt': 't\n',
      'conflict.txt': 'main\n',
      'both.txt': lines(20).replace('line 18', 'theirs'),
    });
    syncMain(s);
    merge(s.work, 'main', true);
    expect(fx.git(s.work, ['status', '--porcelain'])).toContain('UU conflict.txt');
    write(s.work, { 'own.txt': 'own\nwip\n' });
    const { origins } = await classify(core, s.work, { bookmark: s.start });
    expect(origins).toEqual({
      'both.txt': 'mixed:in-progress',
      'conflict.txt': 'own',
      'own.txt': 'own',
      'theirs.txt': 'base:in-progress',
    });
    // Committing the merge turns in-progress into merge.
    write(s.work, { 'conflict.txt': 'own\nmain\n' });
    fx.git(s.work, ['add', '--', 'conflict.txt']);
    fx.git(s.work, ['commit', '-q', '--no-edit']);
    fx.git(s.work, ['checkout', '--', 'own.txt']);
    expect((await classify(core, s.work, { bookmark: s.start })).origins).toEqual({
      'both.txt': 'mixed:merge',
      'conflict.txt': 'mixed:merge',
      'own.txt': 'own',
      'theirs.txt': 'base:merge',
    });
  });

  it('a cherry-pick of a main commit stopped on a conflict: its clean files are base', async () => {
    const s = scenario({ 'conflict.txt': 'base\n' });
    commit(s.work, { 'conflict.txt': 'own\n' });
    const picked = upstream(s, { 'conflict.txt': 'main\n', 'clean.txt': 'c\n' });
    syncMain(s);
    fx.git(s.work, ['cherry-pick', picked], { allowFail: true });
    expect(fx.git(s.work, ['status', '--porcelain'])).toContain('UU conflict.txt');
    expect((await classify(core, s.work, { bookmark: s.start })).origins).toEqual({
      'clean.txt': 'base:in-progress',
      'conflict.txt': 'own',
    });
  });

  it('a merge in progress of a sibling branch is own (decision 6)', async () => {
    const s = scenario({ 'conflict.txt': 'base\n' });
    commit(s.work, { 'conflict.txt': 'own\n' });
    fx.git(s.work, ['switch', '-q', '-c', 'sibling', 'main']);
    commit(s.work, { 'conflict.txt': 'sibling\n', 'sibling.txt': 's\n' });
    fx.git(s.work, ['switch', '-q', 'feature']);
    merge(s.work, 'sibling', true);
    expect((await classify(core, s.work, { bookmark: s.start })).origins).toEqual({
      'conflict.txt': 'own',
      'sibling.txt': 'own',
    });
  });

  it('a revert in progress is own', async () => {
    const s = scenario({ 'conflict.txt': 'base\n' });
    const reverted = upstream(s, { 'conflict.txt': 'main\n', 'r.txt': 'r\n' });
    syncMain(s);
    merge(s.work, 'main');
    const start = rev(s.work, 'HEAD');
    commit(s.work, { 'conflict.txt': 'own\n' });
    fx.git(s.work, ['revert', '--no-edit', reverted], { allowFail: true });
    expect(fx.git(s.work, ['status', '--porcelain'])).toContain('conflict.txt');
    expect((await classify(core, s.work, { bookmark: start })).origins).toEqual({
      'conflict.txt': 'own',
      'r.txt': 'own',
    });
  });
});

describe('readFileOrigins: when it cannot tell, everything is own', () => {
  let core: GitCore;
  beforeAll(() => {
    core = createGitCore(fx.coreOptions());
  });
  afterAll(async () => {
    await core.dispose();
  });

  it('the default branch worktree after a pull is own (decision 4)', async () => {
    const s = scenario();
    fx.git(s.work, ['switch', '-q', 'main']);
    const before = rev(s.work, 'HEAD');
    upstream(s, { 'theirs.txt': 't\n' });
    fx.git(s.work, ['pull', '-q', '--ff-only']);
    const { origins, n, integrationRef } = await classify(core, s.work, { bookmark: before });
    expect(origins).toEqual({ 'theirs.txt': 'own' });
    expect(n).toBeNull();
    expect(integrationRef).toBe('origin/main');
  });

  it('a detached HEAD is own', async () => {
    const s = scenario();
    const start = rev(s.work, 'HEAD');
    upstream(s, { 'theirs.txt': 't\n' });
    fetch(s);
    fx.git(s.work, ['switch', '-q', '--detach', 'origin/main']);
    expect((await classify(core, s.work, { bookmark: start })).origins).toEqual({
      'theirs.txt': 'own',
    });
  });

  it('an unborn branch: everything own, no N', async () => {
    const s = scenario();
    fx.git(s.work, ['switch', '-q', '--orphan', 'fresh']);
    write(s.work, { 'new.txt': 'n\n', 'staged.txt': 's\n' });
    fx.git(s.work, ['add', '--', 'staged.txt']);
    const { origins, n } = await classify(core, s.work, { bookmark: s.start });
    expect(origins).toEqual({ 'new.txt': 'own', 'staged.txt': 'own' });
    expect(n).toBeNull();
  });

  it('a repository without a default branch: everything own, no integration ref', async () => {
    const repo = fx.repo('no-default', { files: { 'a.txt': 'a\n' } });
    fx.git(repo, ['branch', '-q', '-m', 'main', 'work']);
    commit(repo, { 'b.txt': 'b\n' });
    write(repo, { 'c.txt': 'c\n' });
    const wt = locator(repo);
    const first = (await core.listCommits(wt, { limit: 5 })).at(-1)?.sha ?? null;
    const files = await core.listChangedFiles(wt, { kind: 'review', base: first ?? undefined });
    const result = await core.readFileOrigins?.(wt, { base: first, files });
    expect(result?.integrationRef).toBeNull();
    expect(result?.n).toBeNull();
    expect([...(result?.origins.values() ?? [])].map((o) => o.origin)).toEqual(['own', 'own']);
  });

  it('no remote: the local default branch is the integration base', async () => {
    const repo = fx.repo('no-remote', { files: { 'a.txt': 'a\n' } });
    fx.git(repo, ['switch', '-q', '-c', 'feature']);
    const start = rev(repo, 'HEAD');
    commit(repo, { 'own.txt': 'own\n' });
    fx.git(repo, ['switch', '-q', 'main']);
    commit(repo, { 'theirs.txt': 't\n' });
    fx.git(repo, ['switch', '-q', 'feature']);
    merge(repo, 'main');
    const { origins, integrationRef } = await classify(core, repo, { bookmark: start });
    expect(origins).toEqual({ 'own.txt': 'own', 'theirs.txt': 'base:merge' });
    expect(integrationRef).toBe('main');
  });

  it('no shared history with the default branch: own', async () => {
    const s = scenario();
    fx.git(s.work, ['switch', '-q', '--orphan', 'island']);
    fx.git(s.work, ['clean', '-fdq']);
    const root = commit(s.work, { 'island.txt': 'i\n' });
    commit(s.work, { 'island2.txt': 'i\n' });
    const { origins, n } = await classify(core, s.work, { bookmark: root });
    expect(origins).toEqual({ 'island2.txt': 'own' });
    expect(n).toBeNull();
  });
});

describe('readFileOrigins: inputs', () => {
  let core: GitCore;
  beforeAll(() => {
    core = createGitCore(fx.coreOptions());
  });
  afterAll(async () => {
    await core.dispose();
  });

  it('without files it lists base..HEAD and git status itself, with the same answer', async () => {
    const s = scenario({ 'conflict.txt': 'base\n', 'both.txt': lines(20) });
    commit(s.work, { 'conflict.txt': 'own\n', 'both.txt': lines(20).replace('line 2', 'own') });
    upstream(s, {
      'theirs.txt': 't\n',
      'conflict.txt': 'main\n',
      'both.txt': lines(20).replace('line 18', 'theirs'),
    });
    syncMain(s);
    merge(s.work, 'main', true);
    write(s.work, { 'untracked.txt': 'u\n' });
    const listed = await classify(core, s.work, { bookmark: s.start });
    const self = await classify(core, s.work, { bookmark: s.start, withFiles: false });
    expect(self.origins).toEqual(listed.origins);
    expect(self.origins['theirs.txt']).toBe('base:in-progress');
  });

  it('rejects a base that is not a full commit id, and malformed files', async () => {
    const s = scenario();
    const wt = locator(s.work);
    for (const options of [
      { base: 'HEAD' },
      { base: 'abc123' },
      { base: rev(s.work, 'HEAD'), files: [{ path: '../x' }] },
      { base: rev(s.work, 'HEAD'), files: 'a.txt' },
    ]) {
      const error = await core.readFileOrigins?.(wt, options as never).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isGitCoreError(error, 'invalid_argument'), JSON.stringify(options)).toBe(true);
    }
  });

  it('a configured default branch is used (local name paired with origin/<name>)', async () => {
    const s = scenario();
    commit(s.work, { 'own.txt': 'own\n' });
    upstream(s, { 'theirs.txt': 't\n' });
    fetch(s);
    merge(s.work, 'origin/main');
    const { origins, integrationRef } = await classify(core, s.work, {
      bookmark: s.start,
      defaultBranch: 'main',
    });
    expect(origins).toEqual({ 'own.txt': 'own', 'theirs.txt': 'base:merge' });
    expect(integrationRef).toBe('origin/main');
  });
});

/**
 * A git wrapper that logs each invocation's argv, one file per process, so tests can count
 * spawns by subcommand (as in git-metadata.test.ts).
 */
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
  /** Subcommands of the processes started since the last `take()`. */
  const take = (): string[] => {
    const fresh = readdirSync(dir).filter((file) => !seen.has(file));
    return fresh.map((file) => {
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
      return args[i] ?? (args[0] as string);
    });
  };
  return { wrapper, take };
}

describe('readFileOrigins: spawn budget', () => {
  let s: Scenario;
  let core: GitCore;
  let spawns: ReturnType<typeof spawnLog>;
  const wt = () => locator(s.work);

  /** What the daemon does per review key: the range, the list, then the origins (counted). */
  async function originsSpawns(): Promise<{ subs: string[]; origins: Origins }> {
    const range = await core.readReviewRange?.(wt(), { bookmark: s.start });
    const base = range?.base ?? null;
    const files = await core.listChangedFiles(
      wt(),
      base ? { kind: 'review', base } : { kind: 'review' },
    );
    spawns.take();
    const result = await core.readFileOrigins?.(wt(), { base, files });
    const subs = spawns.take();
    const origins: Origins = {};
    for (const [key, info] of result?.origins ?? []) {
      origins[key] = info.via ? `${info.origin}:${info.via}` : info.origin;
    }
    return { subs, origins };
  }

  beforeAll(() => {
    s = scenario({ 'shared.txt': lines(20) });
    commit(s.work, { 'own.txt': 'own\n', 'shared.txt': lines(20).replace('line 2', 'own') });
    upstream(s, { 'theirs.txt': 't\n', 'shared.txt': lines(20).replace('line 18', 'theirs') });
    fetch(s);
    merge(s.work, 'origin/main');
    spawns = spawnLog('origins');
    core = createGitCore(fx.coreOptions({ gitBinary: spawns.wrapper }));
  });
  afterAll(async () => {
    await core.dispose();
  });

  it('first call: only commit-to-commit reads, at most 5', async () => {
    const { subs, origins } = await originsSpawns();
    expect(origins).toEqual({
      'own.txt': 'own',
      'shared.txt': 'mixed:merge',
      'theirs.txt': 'base:merge',
    });
    expect(subs.length).toBeLessThanOrEqual(5);
    expect(subs.every((sub) => ['diff-tree', 'merge-base', 'rev-list'].includes(sub))).toBe(true);
  });

  it('nothing moved: 0 spawns', async () => {
    expect((await originsSpawns()).subs).toEqual([]);
  });

  it('HEAD moves (a new own commit): at most 5 spawns, usually 2-3', async () => {
    commit(s.work, { 'own2.txt': 'own\n' });
    const { subs, origins } = await originsSpawns();
    expect(origins['own2.txt']).toBe('own');
    expect(origins['theirs.txt']).toBe('base:merge');
    expect(subs.length).toBeLessThanOrEqual(5);
    expect(subs.filter((sub) => sub === 'diff-tree').length).toBeLessThanOrEqual(2);
    expect((await originsSpawns()).subs).toEqual([]);
  });

  it('HEAD moves by merging main again: at most 5 spawns', async () => {
    upstream(s, { 'theirs2.txt': 't\n' });
    fetch(s);
    merge(s.work, 'origin/main');
    const { subs, origins } = await originsSpawns();
    expect(origins['theirs2.txt']).toBe('base:merge');
    expect(subs.length).toBeLessThanOrEqual(5);
  });

  it('origin/main moves (fetch) without HEAD moving: at most 5 spawns', async () => {
    upstream(s, { 'theirs3.txt': 't\n' });
    fetch(s);
    const { subs, origins } = await originsSpawns();
    expect(origins['theirs3.txt']).toBeUndefined();
    expect(subs.length).toBeLessThanOrEqual(5);
    expect((await originsSpawns()).subs).toEqual([]);
  });

  it('during a merge in progress: one index-only diff per call', async () => {
    upstream(s, { 'shared.txt': lines(20).replace('line 2', 'conflict'), 'theirs4.txt': 't\n' });
    fetch(s);
    merge(s.work, 'origin/main', true);
    await originsSpawns();
    const { subs, origins } = await originsSpawns();
    expect(origins['theirs4.txt']).toBe('base:in-progress');
    // (`config` is the filter-driver scan, re-read while the config files are under 2 s old.)
    expect(subs.filter((sub) => sub !== 'config')).toEqual(['diff']);
  });
});
