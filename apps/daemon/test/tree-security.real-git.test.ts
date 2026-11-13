/**
 * The file explorer, security review of PR #99, against real repositories and a fake cache:
 *
 * - P2-2: the daemon's composed listings are bounded by bytes, and older states of a worktree go;
 * - P3-1: an untracked path whose type or mode changes names its directory in `dirs`;
 * - P3-2: a hostile tree (`..`, `a/b` entries, paths past the limits) does not break the page;
 * - P3-3: many sibling directories whose files are all deleted cost one `ls-tree -r`;
 * - P3-4: paging a cached listing decodes no entries again;
 * - P3-6: a treeless partial clone says what is missing; the path is checked without git too.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  GIT_OBJECT_MISSING,
  type GitCore,
  type ServerEventOf,
  type TreeEntry,
  TreeResponseSchema,
} from '@octopus-diff/contracts';
import { createGitCore } from '@octopus-diff/git-core';
import { describe, expect, it } from 'vitest';
import { type Daemon, startDaemon } from '../src/daemon.js';
import { hashId } from '../src/ids.js';
import { TreeListingCache, type TreeListingMemo } from '../src/tree.js';
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

async function start(
  fx: RealGitFixture,
  options: { gitBinary?: string; wrap?: (core: GitCore) => GitCore } = {},
) {
  const real = createGitCore({
    env: fx.env,
    ...(options.gitBinary ? { gitBinary: options.gitBinary } : {}),
  });
  const daemon: Daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir: await tempDir(),
    logLevel: 'silent',
    gitCore: options.wrap ? options.wrap(real) : real,
    watch: { enabled: false },
  });
  onCleanup(() => daemon.close());
  return { daemon, api: client(daemon) };
}

async function counting(fx: RealGitFixture) {
  const dir = await tempDir();
  const log = path.join(dir, 'spawns.log');
  writeFileSync(log, '');
  const bin = path.join(dir, 'git.sh');
  writeFileSync(bin, `#!/bin/sh\nline="$*"\nprintf '%s\\n' "$line" >> '${log}'\nexec git "$@"\n`);
  chmodSync(bin, 0o755);
  const started = await start(fx, { gitBinary: bin });
  return { ...started, spawns: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

function gitBuf(fx: RealGitFixture, cwd: string, args: string[], input?: Buffer): Buffer {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('GIT_')) env[k] = v;
  }
  return execFileSync('git', args, { cwd, env: { ...env, ...fx.env, LC_ALL: 'C' }, input });
}

describe('P2-2: the composed listings are bounded', { timeout: 60_000 }, () => {
  const memo = (bytes: number): TreeListingMemo => ({
    entries: [],
    listKey: 'k',
    commit: null,
    tree: null,
    skipped: null,
    bytes,
  });

  it('by bytes, least recently used first; a listing above the bound is not kept', () => {
    const cache = new TreeListingCache(1000);
    cache.set('t\u0000p\u0000a', memo(400));
    cache.set('t\u0000p\u0000b', memo(400));
    cache.get('t\u0000p\u0000a');
    cache.set('t\u0000p\u0000c', memo(400));
    expect(cache.bytes).toBeLessThanOrEqual(1000);
    expect(cache.get('t\u0000p\u0000b')).toBeUndefined();
    expect(cache.get('t\u0000p\u0000a')).toBeDefined();
    cache.set('t\u0000p\u0000huge', memo(5000));
    expect(cache.get('t\u0000p\u0000huge')).toBeUndefined();
    // ...and evicts nothing else for it.
    expect(cache.get('t\u0000p\u0000a')).toBeDefined();
    expect(cache.get('t\u0000p\u0000c')).toBeDefined();
    expect(cache.bytes).toBeLessThanOrEqual(1000);
  });

  it('drops a worktree’s older states and nothing else', () => {
    const cache = new TreeListingCache(10_000);
    cache.set('w\u0000w1\u0000s1\u0000h\u0000', memo(10));
    cache.set('w\u0000w1\u0000s1\u0000h\u0000src', memo(10));
    cache.set('w\u0000w1\u0000s2\u0000h\u0000', memo(10));
    cache.set('w\u0000w2\u0000s1\u0000h\u0000', memo(10));
    cache.set('t\u0000p\u0000c\u0000', memo(10));
    cache.dropOlderStates('w1', 's2');
    expect(cache.size).toBe(3);
    expect(cache.get('w\u0000w1\u0000s2\u0000h\u0000')).toBeDefined();
    expect(cache.get('w\u0000w2\u0000s1\u0000h\u0000')).toBeDefined();
    cache.dropOlderStates('w1', null);
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(20);
  });

  it('a big open directory under a churning worktree keeps one copy, not one per state', async () => {
    const fx = await makeRealGitFixture();
    const repo = await makeRealRepo(fx, 'churn', { 'top.txt': 't\n' });
    mkdirSync(path.join(repo, 'big'));
    for (let i = 0; i < 3000; i++) writeFileSync(path.join(repo, `big/file-${i}.txt`), `${i}\n`);
    fx.git(repo, 'add', '-A');
    fx.git(repo, 'commit', '-q', '-m', 'big');
    // The watcher brings the new states in (an explicit refresh would drop every listing anyway).
    const daemon: Daemon = await startDaemon({
      host: '127.0.0.1',
      port: 0,
      token: TEST_TOKEN,
      stateDir: await tempDir(),
      logLevel: 'silent',
      gitCore: createGitCore({ env: fx.env }),
      watch: { enabled: true, debounceMs: 50 },
    });
    onCleanup(() => daemon.close());
    const api = client(daemon);
    await api.addProject({ path: repo });
    const id = hashId(repo);
    const stateOf = async () =>
      (await api.listProjects()).projects
        .flatMap((p) => p.worktrees)
        .find((w) => w.worktree.id === id)?.summary?.stateHash;
    await eventually(stateOf, 10_000);
    await api.getTree(id, { path: 'big', limit: 10 });
    await api.getTree(id, {});
    const one = daemon.core.treeListingStats();
    expect(one.listings).toBe(2);
    for (let i = 0; i < 12; i++) {
      const was = await stateOf();
      writeFileSync(path.join(repo, `big/file-${i}.txt`), `edited ${i}\n`);
      await eventually(async () => (await stateOf()) !== was, 10_000);
      await api.getTree(id, { path: 'big', limit: 10 });
      await api.getTree(id, {});
      expect(daemon.core.treeListingStats().listings).toBe(2);
    }
    expect(daemon.core.treeListingStats().bytes).toBeLessThan(one.bytes * 2);
  });
});

describe('P3-1: an untracked path whose type or mode changes is named in dirs', {
  timeout: 60_000,
}, () => {
  it('a new script made executable, an untracked file replaced by a symlink', async () => {
    const fx = await makeRealGitFixture();
    const repo = await makeRealRepo(fx, 'modes', { 'top.txt': 't\n' });
    mkdirSync(path.join(repo, 'new'));
    writeFileSync(path.join(repo, 'new/run.sh'), 'echo run\n');
    writeFileSync(path.join(repo, 'new/u'), 'a file\n');
    const { daemon, api } = await start(fx);
    await api.addProject({ path: repo });
    const id = hashId(repo);
    const events = recordEvents(daemon);
    await events.opened;
    await api.refreshWorktree(id);
    const before = await api.getTree(id, { path: 'new' });
    expect(before.entries.map((e) => [e.name, e.kind, e.mode])).toEqual([
      ['run.sh', 'file', '100644'],
      ['u', 'file', '100644'],
    ]);
    const step = async (op: () => void) => {
      const mark = events.events.length;
      op();
      const summary = (await api.refreshWorktree(id)).summary;
      return (await eventually(
        () =>
          events.events
            .slice(mark)
            .find(
              (e): e is Changed =>
                e.type === 'worktree.changed' && e.stateHash === summary.stateHash,
            ),
        8000,
      )) as Changed;
    };
    const chmod = await step(() => chmodSync(path.join(repo, 'new/run.sh'), 0o755));
    expect(chmod.dirs).toEqual({ all: false, dirs: [{ path: '' }, { path: 'new' }] });
    const link = await step(() => {
      rmSync(path.join(repo, 'new/u'));
      symlinkSync('run.sh', path.join(repo, 'new/u'));
    });
    expect(link.dirs).toEqual({ all: false, dirs: [{ path: '' }, { path: 'new' }] });
    const after = await api.getTree(id, { path: 'new' });
    expect(after.entries.map((e) => [e.name, e.kind, e.mode])).toEqual([
      ['run.sh', 'file', '100755'],
      ['u', 'symlink', '120000'],
    ]);
  });
});

describe('P3-2: a hostile tree does not break the page', { timeout: 60_000 }, () => {
  it('entries named .., a/b or past the path limit are skipped and counted', async () => {
    const fx = await makeRealGitFixture();
    const repo = await makeRealRepo(fx, 'hostile', { 'top.txt': 't\n' });
    const blob = gitBuf(fx, repo, ['hash-object', '-w', '--stdin'], Buffer.from('x\n'))
      .toString()
      .trim();
    const raw = Buffer.from(blob, 'hex');
    const entry = (name: string) => Buffer.concat([Buffer.from(`100644 ${name}\u0000`), raw]);
    // git's tree format by hand (`--literally`: git would refuse these names in a normal tree).
    const bad = gitBuf(
      fx,
      repo,
      ['hash-object', '-t', 'tree', '--literally', '-w', '--stdin'],
      Buffer.concat([entry('..'), entry('a/b'), entry('ok')]),
    )
      .toString()
      .trim();
    // A chain of directories whose paths pass 4096 characters at the last level.
    const segment = 'd'.repeat(200);
    let deep = gitBuf(fx, repo, ['mktree'], Buffer.from(`100644 blob ${blob}\tleaf.txt\n`))
      .toString()
      .trim();
    for (let i = 0; i < 21; i++) {
      deep = gitBuf(fx, repo, ['mktree'], Buffer.from(`040000 tree ${deep}\t${segment}\n`))
        .toString()
        .trim();
    }
    const root = gitBuf(
      fx,
      repo,
      ['mktree'],
      Buffer.from(
        `040000 tree ${bad}\thostile\n040000 tree ${deep}\tdeep\n100644 blob ${blob}\ttop.txt\n`,
      ),
    )
      .toString()
      .trim();
    const commit = fx.git(repo, 'commit-tree', root, '-m', 'hostile').trim();
    const { daemon, api } = await start(fx);
    await api.addProject({ path: repo });
    const id = hashId(repo);
    // Through the validating client: the page parses.
    const hostile = await api.getTree(id, { ref: commit, path: 'hostile' });
    expect(hostile.entries.map((e) => e.name)).toEqual(['ok']);
    expect(hostile.skipped).toEqual({ invalidName: 2, tooLong: 0 });
    expect(hostile.total).toBe(1);
    // The deepest level that a request can still name: its entry's path is too long.
    const level = Array.from({ length: 20 }, () => segment);
    const dirPath = ['deep', ...level].join('/');
    expect(dirPath.length).toBeLessThanOrEqual(4096);
    const long = await api.getTree(id, { ref: commit, path: dirPath });
    expect(long.entries).toEqual([]);
    expect(long.skipped).toEqual({ invalidName: 0, tooLong: 1 });
    // A clean directory has no `skipped`.
    const clean = await http(daemon, `/api/worktrees/${id}/tree?ref=${commit}`);
    const body = TreeResponseSchema.parse(await clean.json());
    expect(body.skipped).toBeUndefined();
  });
});

describe('P3-3: many directories whose files are all deleted', { timeout: 60_000 }, () => {
  it('cost one ls-tree -r, not one each', async () => {
    const fx = await makeRealGitFixture();
    const repo = await makeRealRepo(fx, 'siblings', { 'top.txt': 't\n' });
    for (let i = 0; i < 30; i++) {
      mkdirSync(path.join(repo, `d${i}`));
      writeFileSync(path.join(repo, `d${i}/only.txt`), `${i}\n`);
    }
    mkdirSync(path.join(repo, 'kept'));
    writeFileSync(path.join(repo, 'kept/a.txt'), 'a\n');
    writeFileSync(path.join(repo, 'kept/b.txt'), 'b\n');
    fx.git(repo, 'add', '-A');
    fx.git(repo, 'commit', '-q', '-m', 'siblings');
    for (let i = 0; i < 30; i++) rmSync(path.join(repo, `d${i}`), { recursive: true });
    rmSync(path.join(repo, 'kept/a.txt'));
    const { api, spawns } = await counting(fx);
    await api.addProject({ path: repo });
    const id = hashId(repo);
    await api.refreshWorktree(id);
    const before = spawns().length;
    const root = await api.getTree(id, {});
    const recursive = spawns()
      .slice(before)
      .filter((l) => / ls-tree -r /.test(l));
    expect(recursive).toHaveLength(1);
    const byName = Object.fromEntries(
      root.entries.map((e: TreeEntry) => [e.name, e.status ?? null]),
    );
    for (let i = 0; i < 30; i++) expect(byName[`d${i}`], `d${i}`).toBe('deleted');
    expect(byName.kept).toBeNull();
  });
});

describe('P3-3 / Greptile round 3: child counts are asked for the checked directories only', () => {
  it('passes the names of the deleted-only directories', async () => {
    const fx = await makeRealGitFixture();
    const repo = await makeRealRepo(fx, 'asked', { 'top.txt': 't\n' });
    for (let i = 0; i < 6; i++) {
      mkdirSync(path.join(repo, `d${i}`));
      writeFileSync(path.join(repo, `d${i}/only.txt`), `${i}\n`);
    }
    mkdirSync(path.join(repo, 'kept'));
    writeFileSync(path.join(repo, 'kept/a.txt'), 'a\n');
    fx.git(repo, 'add', '-A');
    fx.git(repo, 'commit', '-q', '-m', 'six');
    for (let i = 0; i < 6; i++) rmSync(path.join(repo, `d${i}`), { recursive: true });
    const asked: Array<ReadonlyArray<{ name: string }> | undefined> = [];
    const { api } = await start(fx, {
      wrap: (real) => ({
        ...real,
        countTreeChildren: (worktree, options) => {
          asked.push(options.names);
          const count = real.countTreeChildren;
          if (!count) throw new Error('no countTreeChildren');
          return count.call(real, worktree, options);
        },
      }),
    });
    await api.addProject({ path: repo });
    const id = hashId(repo);
    await api.refreshWorktree(id);
    const root = await api.getTree(id, {});
    expect(root.entries.filter((e) => e.status === 'deleted').map((e) => e.name)).toEqual([
      'd0',
      'd1',
      'd2',
      'd3',
      'd4',
      'd5',
    ]);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.map((n) => n.name).sort()).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5']);
  });
});

describe('P3-4: paging a cached listing decodes nothing again', { timeout: 60_000 }, () => {
  it('after the first page, pages only resolve the commit (no entries)', async () => {
    const fx = await makeRealGitFixture();
    const repo = await makeRealRepo(fx, 'pages', { 'top.txt': 't\n' });
    mkdirSync(path.join(repo, 'many'));
    for (let i = 0; i < 200; i++) writeFileSync(path.join(repo, `many/f${i}.txt`), `${i}\n`);
    fx.git(repo, 'add', '-A');
    fx.git(repo, 'commit', '-q', '-m', 'many');
    const calls: Array<boolean> = [];
    const { api } = await start(fx, {
      wrap: (real) => ({
        ...real,
        listTree: (worktree, options) => {
          calls.push(options.withEntries !== false);
          const list = real.listTree;
          if (!list) throw new Error('no listTree');
          return list.call(real, worktree, options);
        },
      }),
    });
    await api.addProject({ path: repo });
    const id = hashId(repo);
    for (const ref of ['HEAD', undefined]) {
      calls.length = 0;
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const page = await api.getTree(id, {
          path: 'many',
          limit: 25,
          ...(ref ? { ref } : {}),
          ...(cursor ? { cursor } : {}),
        });
        pages++;
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(pages).toBe(8);
      // One decoding listing for the first page; every other call resolves only.
      expect(calls.filter(Boolean), String(ref)).toHaveLength(1);
    }
  });
});

describe('P3-6: partial clones and unchecked paths', { timeout: 60_000 }, () => {
  it('a treeless clone answers 404 with the object_missing reason, not "unknown ref"', async () => {
    const fx = await makeRealGitFixture();
    const source = await makeRealRepo(fx, 'source', { 'a.txt': 'a\n' });
    fx.git(source, 'config', 'uploadpack.allowFilter', 'true');
    const clone = path.join(fx.root, 'treeless');
    fx.git(
      fx.root,
      '-c',
      'protocol.file.allow=always',
      'clone',
      '-q',
      '--no-checkout',
      '--filter=tree:0',
      `file://${source}`,
      clone,
    );
    const { daemon, api } = await start(fx);
    await api.addProject({ path: clone });
    const id = hashId(clone);
    const res = await http(daemon, `/api/worktrees/${id}/tree?ref=HEAD`);
    expect(res.status).toBe(404);
    const error = await errorOf(res);
    expect(error.details).toEqual({ reason: GIT_OBJECT_MISSING });
    expect(error.message).toMatch(/does not have .* locally \(a partial clone\?\)/);
    expect(error.message).not.toMatch(/unknown ref/);
  });

  it('an unborn HEAD still refuses malformed paths (400), in both views', async () => {
    const fx = await makeRealGitFixture();
    const repo = path.join(fx.root, 'unborn');
    fx.git(fx.root, 'init', '-q', 'unborn');
    const { daemon, api } = await start(fx);
    await api.addProject({ path: repo });
    const id = hashId(repo);
    const raw = encodeURIComponent(Buffer.from('a/../b').toString('base64'));
    for (const q of [
      'path=a%2F%2Fb',
      `rawPath=${raw}`,
      'path=a%2F%2Fb&ref=HEAD',
      `rawPath=${raw}&ref=HEAD`,
    ]) {
      const res = await http(daemon, `/api/worktrees/${id}/tree?${q}`);
      expect(res.status, q).toBe(400);
    }
    expect((await api.getTree(id, {})).entries).toEqual([]);
  });
});
