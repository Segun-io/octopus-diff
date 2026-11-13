/**
 * The file explorer, PR #99 review (Greptile), against real repositories:
 *
 * 1. a listing never lays the file list of one commit over another commit's tree (a gate lets a
 *    commit land around the list);
 * 2. one row per name when the working copy replaced a file with a directory or the reverse;
 * 3. a rename from a name that is not UTF-8 marks the real source deleted;
 * 4. `worktree.changed.dirs` names every directory whose listing moved: the `MM` A/B/C case, a
 *    table of transitions, and a brute-force property over random operations.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type ApiClient,
  type GitCore,
  type ServerEventOf,
  type TreeEntry,
  treeDirIdentity,
} from '@octopus-diff/contracts';
import { createGitCore } from '@octopus-diff/git-core';
import { describe, expect, it } from 'vitest';
import { type Daemon, startDaemon } from '../src/daemon.js';
import { hashId } from '../src/ids.js';
import {
  client,
  errorOf,
  eventually,
  http,
  onCleanup,
  recordEvents,
  TEST_TOKEN,
  tempDir,
} from './helpers.js';
import { makeRealGitFixture, makeRealRepo, type RealGitFixture } from './real-git-fixture.js';

type Changed = ServerEventOf<'worktree.changed'>;

async function start(fx: RealGitFixture, wrap?: (core: GitCore) => GitCore) {
  const real = createGitCore({ env: fx.env });
  const daemon: Daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir: await tempDir(),
    logLevel: 'silent',
    gitCore: wrap ? wrap(real) : real,
    watch: { enabled: false },
  });
  onCleanup(() => daemon.close());
  return { daemon, api: client(daemon) };
}

function gitBuf(fx: RealGitFixture, cwd: string, args: string[], input?: Buffer): Buffer {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('GIT_')) env[k] = v;
  }
  return execFileSync('git', args, { cwd, env: { ...env, ...fx.env, LC_ALL: 'C' }, input });
}

const names = (entries: readonly TreeEntry[]) => entries.map((e) => e.name);

describe('1. one state per listing', () => {
  it('a commit that lands before the list is read: the listing is of the new commit, whole', async () => {
    const fx = await makeRealGitFixture();
    const repo = await makeRealRepo(fx, 'gate', { 'a.txt': 'a\n' });
    writeFileSync(path.join(repo, 'n.txt'), 'new\n');
    fx.git(repo, 'add', 'n.txt');
    const gate = { armed: false };
    const { api } = await start(fx, (real) => ({
      ...real,
      listChangedFilesWithState: async (worktree, scope, options) => {
        if (gate.armed) {
          gate.armed = false;
          fx.git(repo, 'commit', '-q', '-m', 'landed during the listing');
        }
        const list = real.listChangedFilesWithState;
        if (!list) throw new Error('no listChangedFilesWithState');
        return list.call(real, worktree, scope, options);
      },
    }));
    await api.addProject({ path: repo });
    const id = hashId(repo);
    const before = await api.refreshWorktree(id);
    gate.armed = true;
    const tree = await api.getTree(id, {});
    const head = fx.git(repo, 'rev-parse', 'HEAD').trim();
    expect(gate.armed).toBe(false);
    expect(head).not.toBe(before.summary.headSha);
    // The file committed meanwhile is listed (it was in neither input of a mixed listing).
    expect(names(tree.entries)).toEqual(['a.txt', 'n.txt']);
    expect(tree.commit).toBe(head);
    expect(tree.entries.every((e) => e.status === undefined)).toBe(true);
    expect(tree.stateHash).not.toBe(before.summary.stateHash);
  });

  it('a commit that lands between the list and the tree read: still one state', async () => {
    const fx = await makeRealGitFixture();
    const repo = await makeRealRepo(fx, 'gate2', { 'a.txt': 'a\n' });
    writeFileSync(path.join(repo, 'n.txt'), 'new\n');
    fx.git(repo, 'add', 'n.txt');
    const gate = { armed: false };
    const { api } = await start(fx, (real) => ({
      ...real,
      listChangedFilesWithState: async (worktree, scope, options) => {
        const list = real.listChangedFilesWithState;
        if (!list) throw new Error('no listChangedFilesWithState');
        const result = await list.call(real, worktree, scope, options);
        if (gate.armed) {
          gate.armed = false;
          fx.git(repo, 'commit', '-q', '-m', 'landed after the listing');
        }
        return result;
      },
    }));
    await api.addProject({ path: repo });
    const id = hashId(repo);
    await api.refreshWorktree(id);
    gate.armed = true;
    const tree = await api.getTree(id, {});
    expect(tree.commit).toBe(fx.git(repo, 'rev-parse', 'HEAD').trim());
    expect(tree.entries.map((e) => [e.name, e.status ?? null])).toEqual([
      ['a.txt', null],
      ['n.txt', null],
    ]);
  });

  it('a list of a newer state than the summary is never labelled with the older summary', async () => {
    const fx = await makeRealGitFixture();
    const repo = await makeRealRepo(fx, 'label', { 'a.txt': 'a\n' });
    const gate = { armed: false };
    const { api } = await start(fx, (real) => ({
      ...real,
      listChangedFilesWithState: async (worktree, scope, options) => {
        if (gate.armed) {
          gate.armed = false;
          // The worktree moves on and git-core's own summary follows it before the daemon's does:
          // git-core then lists the worktree as it is now (`summaryState: null`).
          writeFileSync(path.join(repo, 'late.txt'), 'late\n');
          await real.getSummary(worktree, {});
        }
        const list = real.listChangedFilesWithState;
        if (!list) throw new Error('no listChangedFilesWithState');
        return list.call(real, worktree, scope, options);
      },
    }));
    await api.addProject({ path: repo });
    const id = hashId(repo);
    const before = await api.refreshWorktree(id);
    gate.armed = true;
    const tree = await api.getTree(id, {});
    expect(tree.entries.map((e) => [e.name, e.status ?? null])).toEqual([
      ['a.txt', null],
      ['late.txt', 'untracked'],
    ]);
    // The listing holds `late.txt`, which the earlier summary did not: it is not that state's.
    expect(tree.stateHash).not.toBe(before.summary.stateHash);
    const { projects } = await api.listProjects();
    const row = projects.flatMap((p) => p.worktrees).find((w) => w.worktree.id === id);
    expect(row?.summary?.stateHash).toBe(tree.stateHash);
  });

  it('a HEAD that keeps moving: a retryable 409, never a mix', async () => {
    const fx = await makeRealGitFixture();
    const repo = await makeRealRepo(fx, 'moving', { 'a.txt': 'a\n' });
    let calls = 0;
    const { daemon, api } = await start(fx, (real) => ({
      ...real,
      listChangedFilesWithState: async (worktree, scope, options) => {
        calls++;
        fx.git(repo, 'commit', '-q', '--allow-empty', '-m', `moving ${calls}`);
        const list = real.listChangedFilesWithState;
        if (!list) throw new Error('no listChangedFilesWithState');
        return list.call(real, worktree, scope, options);
      },
    }));
    await api.addProject({ path: repo });
    const id = hashId(repo);
    await api.refreshWorktree(id);
    const res = await http(daemon, `/api/worktrees/${id}/tree`);
    expect(res.status).toBe(409);
    const error = await errorOf(res);
    expect(error.code).toBe('conflict');
    expect(error.details).toEqual({ retryable: true });
    // Three listing attempts (summary refreshes between them may list too).
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

describe('2. one row per name', () => {
  it('a tracked file replaced by a directory, and a directory replaced by a file', async () => {
    const fx = await makeRealGitFixture();
    const repo = await makeRealRepo(fx, 'replace', { d: 'a file\n', keep: 'k\n' });
    mkdirSync(path.join(repo, 'e'));
    writeFileSync(path.join(repo, 'e/x.txt'), 'x\n');
    writeFileSync(path.join(repo, 'e/y.txt'), 'y\n');
    fx.git(repo, 'add', '-A');
    fx.git(repo, 'commit', '-q', '-m', 'e');
    rmSync(path.join(repo, 'd'));
    mkdirSync(path.join(repo, 'd'));
    writeFileSync(path.join(repo, 'd/new.txt'), 'now a directory\n');
    rmSync(path.join(repo, 'e'), { recursive: true });
    writeFileSync(path.join(repo, 'e'), 'now a file\n');
    const { api } = await start(fx);
    await api.addProject({ path: repo });
    const id = hashId(repo);
    await api.refreshWorktree(id);
    const root = await api.getTree(id, {});
    expect(root.entries.map((e) => [e.name, e.kind, e.status ?? null, e.replaces ?? null])).toEqual(
      [
        ['d', 'dir', 'untracked', 'file'],
        ['e', 'file', 'untracked', 'dir'],
        ['keep', 'file', null, null],
      ],
    );
    // HEAD's side stays reachable: the old directory lists its deleted files.
    const old = await api.getTree(id, { path: 'e' });
    expect(old.entries.map((e) => [e.name, e.status])).toEqual([
      ['x.txt', 'deleted'],
      ['y.txt', 'deleted'],
    ]);
    const now = await api.getTree(id, { path: 'd' });
    expect(now.entries.map((e) => [e.name, e.status])).toEqual([['new.txt', 'untracked']]);
  });
});

describe('3. a rename from a name that is not UTF-8', () => {
  it('marks the raw source deleted and invents no lossy one', async () => {
    const fx = await makeRealGitFixture();
    const repo = await makeRealRepo(fx, 'rawren', { 'keep.txt': 'k\n' });
    const content = 'a rename source, long enough to pair\n'.repeat(4);
    const raw = Buffer.from([0x72, 0xff, 0x2e, 0x74]); // "r\xff.t"
    // HEAD holds the raw name and the index renames it; the file system never sees it (APFS).
    const oid = gitBuf(fx, repo, ['hash-object', '-w', '--stdin'], Buffer.from(content))
      .toString()
      .trim();
    const keep = fx.git(repo, 'rev-parse', 'HEAD:keep.txt').trim();
    const sub = gitBuf(
      fx,
      repo,
      ['mktree', '-z'],
      Buffer.concat([Buffer.from(`100644 blob ${oid}\t`), raw, Buffer.from([0])]),
    )
      .toString()
      .trim();
    const root = gitBuf(
      fx,
      repo,
      ['mktree', '-z'],
      Buffer.from(`100644 blob ${keep}\tkeep.txt\u0000040000 tree ${sub}\tsrc\u0000`),
    )
      .toString()
      .trim();
    const parent = fx.git(repo, 'rev-parse', 'HEAD').trim();
    const commit = fx.git(repo, 'commit-tree', root, '-p', parent, '-m', 'raw').trim();
    fx.git(repo, 'update-ref', 'refs/heads/main', commit);
    fx.git(repo, 'read-tree', 'HEAD');
    gitBuf(
      fx,
      repo,
      ['update-index', '-z', '--index-info'],
      Buffer.concat([
        Buffer.from(`0 ${'0'.repeat(40)}\tsrc/`),
        raw,
        Buffer.from([0]),
        Buffer.from(`100644 ${oid}\tsrc/renamed.txt\u0000`),
      ]),
    );
    mkdirSync(path.join(repo, 'src'), { recursive: true });
    writeFileSync(path.join(repo, 'src/renamed.txt'), content);
    const { api } = await start(fx);
    await api.addProject({ path: repo });
    const id = hashId(repo);
    await api.refreshWorktree(id);
    const src = await api.getTree(id, { path: 'src' });
    const rawPath = Buffer.concat([Buffer.from('src/'), raw]).toString('base64');
    expect(src.entries).toHaveLength(2);
    expect(src.entries.find((e) => e.rawPath === rawPath)).toMatchObject({
      status: 'deleted',
      renamedTo: 'src/renamed.txt',
      oid,
    });
    expect(src.entries.find((e) => e.name === 'renamed.txt')).toMatchObject({
      status: 'renamed',
      oldPath: 'src/r�.t',
      oldRawPath: rawPath,
    });
    // No row for the lossy display name of the source.
    expect(src.entries.filter((e) => e.rawPath === undefined).map((e) => e.name)).toEqual([
      'renamed.txt',
    ]);
  });
});

// --- 4. directory deltas: a superset of the directories whose listing moved -----------------

/** Every directory's working-view listing (identity → entries JSON), walked through the route. */
async function listings(api: ApiClient, id: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const queue: Array<{ path: string; rawPath?: string }> = [{ path: '' }];
  while (queue.length > 0) {
    const dir = queue.shift() as { path: string; rawPath?: string };
    const page = await api.getTree(id, { ...dir, limit: 5000 });
    out.set(treeDirIdentity(dir), JSON.stringify(page.entries));
    for (const e of page.entries) {
      if (e.kind === 'dir') {
        queue.push(
          e.rawPath !== undefined ? { path: e.path, rawPath: e.rawPath } : { path: e.path },
        );
      }
    }
  }
  return out;
}

interface Checker {
  step(name: string, op: () => void): Promise<void>;
}

async function deltaChecker(fx: RealGitFixture, repo: string): Promise<Checker> {
  const { daemon, api } = await start(fx);
  await api.addProject({ path: repo });
  const id = hashId(repo);
  const events = recordEvents(daemon);
  await events.opened;
  let state = (await api.refreshWorktree(id)).summary.stateHash;
  let before = await listings(api, id);
  return {
    async step(name, op) {
      const mark = events.events.length;
      op();
      const summary = (await api.refreshWorktree(id)).summary;
      const after = await listings(api, id);
      const moved = new Set<string>();
      for (const [k, v] of after) if (before.get(k) !== v) moved.add(k);
      for (const k of before.keys()) if (!after.has(k)) moved.add(k);
      if (summary.stateHash === state) {
        expect([...moved], `${name}: listings moved without a new state`).toEqual([]);
      } else {
        const changed = (await eventually(
          () =>
            events.events
              .slice(mark)
              .find(
                (e): e is Changed =>
                  e.type === 'worktree.changed' &&
                  e.worktreeId === id &&
                  e.stateHash === summary.stateHash,
              ),
          8000,
        )) as Changed;
        const named = new Set<string>();
        let all = false;
        for (const e of events.events.slice(mark)) {
          if (e.type !== 'worktree.changed' || e.worktreeId !== id) continue;
          if (!e.dirs || e.dirs.all) all = true;
          for (const d of e.dirs?.dirs ?? []) named.add(treeDirIdentity(d));
        }
        expect(changed.dirs, `${name}: the event carries dirs`).toBeDefined();
        if (!all) {
          const missed = [...moved].filter((k) => !named.has(k));
          expect(missed, `${name}: moved but not named`).toEqual([]);
        }
      }
      state = summary.stateHash;
      before = after;
    },
  };
}

describe('4. worktree.changed.dirs covers every listing that moved', () => {
  it('MM with HEAD A, staged B, working C, then C back to A (the review case)', async () => {
    const fx = await makeRealGitFixture();
    const repo = await makeRealRepo(fx, 'abc', { 'top.txt': 't\n' });
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'src/f.txt'), 'A\n');
    fx.git(repo, 'add', '-A');
    fx.git(repo, 'commit', '-q', '-m', 'A');
    const { daemon, api } = await start(fx);
    await api.addProject({ path: repo });
    const id = hashId(repo);
    const events = recordEvents(daemon);
    await events.opened;
    writeFileSync(path.join(repo, 'src/f.txt'), 'B\n');
    fx.git(repo, 'add', 'src/f.txt');
    writeFileSync(path.join(repo, 'src/f.txt'), 'C\n');
    await api.refreshWorktree(id);
    const modified = await api.getTree(id, { path: 'src' });
    expect(modified.entries[0]).toMatchObject({ name: 'f.txt', status: 'modified' });
    expect((await api.getTree(id, {})).entries.find((e) => e.name === 'src')?.changes).toBe(1);
    const mark = events.events.length;
    writeFileSync(path.join(repo, 'src/f.txt'), 'A\n');
    const summary = (await api.refreshWorktree(id)).summary;
    expect(fx.git(repo, 'status', '--porcelain').trim()).toBe('MM src/f.txt');
    const event = (await eventually(
      () =>
        events.events
          .slice(mark)
          .find(
            (e): e is Changed => e.type === 'worktree.changed' && e.stateHash === summary.stateHash,
          ),
      8000,
    )) as Changed;
    expect(event.dirs?.all).toBe(false);
    expect(event.dirs?.dirs).toEqual([{ path: '' }, { path: 'src' }]);
    // And the listing those directories refetch has moved: the marker and the count are gone.
    const back = await api.getTree(id, { path: 'src' });
    expect(back.entries[0]?.status).toBeUndefined();
    expect(
      (await api.getTree(id, {})).entries.find((e) => e.name === 'src')?.changes,
    ).toBeUndefined();
  });

  it('a table of transitions', async () => {
    const fx = await makeRealGitFixture();
    const repo = await makeRealRepo(fx, 'table', { '.gitignore': 'ignored/\n', 'top.txt': 't\n' });
    for (const d of ['a/b', 'c']) mkdirSync(path.join(repo, d), { recursive: true });
    writeFileSync(path.join(repo, 'a/b/f.txt'), 'f content that is long enough\n'.repeat(3));
    writeFileSync(path.join(repo, 'c/g.sh'), 'echo g\n');
    fx.git(repo, 'add', '-A');
    fx.git(repo, 'commit', '-q', '-m', 'base');
    const check = await deltaChecker(fx, repo);
    const w = (p: string, c: string) => writeFileSync(path.join(repo, p), c);
    await check.step('unstaged edit', () => w('a/b/f.txt', 'edited\n'));
    await check.step('stage it', () => fx.git(repo, 'add', 'a/b/f.txt'));
    await check.step('edit again (MM)', () => w('a/b/f.txt', 'edited twice\n'));
    await check.step('back to HEAD content (MM, off the list)', () =>
      w('a/b/f.txt', 'f content that is long enough\n'.repeat(3)),
    );
    await check.step('unstage', () => fx.git(repo, 'restore', '--staged', 'a/b/f.txt'));
    await check.step('rename', () => fx.git(repo, 'mv', 'a/b/f.txt', 'c/f-moved.txt'));
    await check.step('rename back', () => fx.git(repo, 'mv', 'c/f-moved.txt', 'a/b/f.txt'));
    await check.step('mode change', () => chmodSync(path.join(repo, 'c/g.sh'), 0o755));
    await check.step('untracked file', () => {
      mkdirSync(path.join(repo, 'ignored'), { recursive: true });
      mkdirSync(path.join(repo, 'n'), { recursive: true });
      w('n/u.txt', 'u\n');
      w('ignored/i.txt', 'i\n');
    });
    await check.step('untracked becomes ignored', () => w('.gitignore', 'ignored/\nn/\n'));
    await check.step('ignored becomes untracked', () => w('.gitignore', 'ignored/\n'));
    await check.step('delete a directory', () => rmSync(path.join(repo, 'a'), { recursive: true }));
    await check.step('restore it', () => fx.git(repo, 'checkout', '--', 'a'));
  });

  it('property: random operations, the named directories are a superset of the moved ones', async () => {
    const fx = await makeRealGitFixture();
    const files: Record<string, string> = { 'top.txt': 't\n' };
    const repo = await makeRealRepo(fx, 'prop', files);
    for (const d of ['a/b', 'a/c', 'd']) mkdirSync(path.join(repo, d), { recursive: true });
    const tracked = ['a/b/1.txt', 'a/b/2.txt', 'a/c/3.txt', 'd/4.txt', 'top.txt'];
    const heads = new Map<string, string>();
    for (const f of tracked) {
      const c = `${f} original content, several words long\n`.repeat(2);
      heads.set(f, c);
      writeFileSync(path.join(repo, f), c);
    }
    fx.git(repo, 'add', '-A');
    fx.git(repo, 'commit', '-q', '-m', 'base');
    const check = await deltaChecker(fx, repo);
    let seed = 2026;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T;
    const exists = (f: string) => {
      try {
        return execFileSync('test', ['-f', path.join(repo, f)]) !== undefined;
      } catch {
        return false;
      }
    };
    const ops: Array<[string, () => void]> = [
      [
        'edit',
        () => {
          const f = pick(tracked);
          if (exists(f)) writeFileSync(path.join(repo, f), `edit ${random()}\n`);
        },
      ],
      [
        'back to HEAD',
        () => {
          const f = pick(tracked);
          if (exists(f)) writeFileSync(path.join(repo, f), heads.get(f) as string);
        },
      ],
      ['stage', () => fx.git(repo, 'add', '-A', '--', pick(['a', 'd', 'top.txt', '.']))],
      ['unstage', () => fx.git(repo, 'restore', '--staged', '--', '.')],
      [
        'untracked',
        () => {
          const dir = pick(['a/b', 'a/new', 'n/deep', 'd']);
          mkdirSync(path.join(repo, dir), { recursive: true });
          writeFileSync(path.join(repo, dir, `u${Math.floor(random() * 4)}.txt`), 'u\n');
        },
      ],
      ['delete', () => rmSync(path.join(repo, pick(tracked)), { force: true })],
      [
        'delete dir',
        () => rmSync(path.join(repo, pick(['a/c', 'd', 'n'])), { recursive: true, force: true }),
      ],
      [
        'ignore n/',
        () => writeFileSync(path.join(repo, '.gitignore'), pick(['n/\n', '', 'u0.txt\n'])),
      ],
      [
        'restore all',
        () => {
          fx.git(repo, 'reset', '-q');
          fx.git(repo, 'checkout', '--', '.');
        },
      ],
      [
        'chmod',
        () => {
          const f = pick(tracked);
          if (exists(f)) chmodSync(path.join(repo, f), pick([0o644, 0o755]));
        },
      ],
      [
        'rename',
        () => {
          const f = pick(tracked);
          if (!exists(f)) return;
          try {
            fx.git(repo, 'mv', f, `${f}.moved`);
            fx.git(repo, 'mv', `${f}.moved`, f.replace('a/b/', 'a/c/'));
          } catch {
            // A clash with an existing name: skipped.
          }
        },
      ],
    ];
    for (let i = 0; i < 40; i++) {
      const [name, op] = pick(ops);
      await check.step(`#${i} ${name}`, op);
    }
  });
});
