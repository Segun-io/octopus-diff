/**
 * The file explorer's listing (#9): `GitCore.listTree` / `countTreeFiles` against real git.
 *
 * - Differential: every directory of a random repository is compared with `git ls-tree -z -l`
 *   run by the fixture (names, modes, kinds, object ids, sizes, order).
 * - Security: a path never reaches git's command line (every spawn is logged), symlinks and
 *   submodules are never entered, the working tree is never read, traversal and option-like input
 *   is refused or treated as a plain name.
 * - Caching: a listing is cached by (common dir, tree oid) and shared by every worktree.
 *
 * Trees with names a file system may refuse (case collisions, non-UTF-8 bytes, a symlink to `/`)
 * are built with `git mktree` from raw bytes, so these tests run on every platform.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type GitCore,
  type GitTreeEntry,
  type GitTreeListing,
  isGitCoreError,
  type WorktreeLocator,
} from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore, parseLsTree, TreeCache } from '../src/index.js';
import { locator } from './helpers/core.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

let fx: Fixture;
let core: GitCore;
let log: string;
let repo: string;
let wt: WorktreeLocator;

/** Every git process the core started, one line per spawn (its argv). */
function spawns(): string[] {
  return readFileSync(log, 'utf8').split('\n').filter(Boolean);
}

function gitBytes(cwd: string, args: string[], input?: Buffer): Buffer {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('GIT_')) env[k] = v;
  }
  const result = spawnSync('git', args, {
    cwd,
    env: { ...env, ...fx.env, LC_ALL: 'C' },
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString('utf8')}`);
  }
  return result.stdout;
}

function blob(cwd: string, content: string | Buffer): string {
  return gitBytes(cwd, ['hash-object', '-w', '--stdin'], Buffer.from(content)).toString().trim();
}

/** `git mktree -z` from raw entries: name bytes as given. */
function mktree(
  cwd: string,
  entries: Array<{ mode: string; type: string; oid: string; name: Buffer | string }>,
): string {
  const input = Buffer.concat(
    entries.map((e) =>
      Buffer.concat([
        Buffer.from(`${e.mode} ${e.type} ${e.oid}\t`),
        Buffer.from(e.name),
        Buffer.from([0]),
      ]),
    ),
  );
  return gitBytes(cwd, ['mktree', '-z'], input).toString().trim();
}

function commitTree(cwd: string, tree: string): string {
  return gitBytes(cwd, ['commit-tree', tree, '-m', 'synthetic']).toString().trim();
}

/** What the fixture's own `git ls-tree -z -l <treeish>` says, as listTree entries. */
function expectedEntries(cwd: string, treeish: string, dir: string | Buffer): GitTreeEntry[] {
  const out = gitBytes(cwd, ['ls-tree', '-z', '-l', treeish]).toString('latin1');
  const prefix = (typeof dir === 'string' ? Buffer.from(dir, 'utf8') : dir).toString('latin1');
  return parseLsTree(out).map((e) => {
    const nameBuf = Buffer.from(e.name, 'latin1');
    const fullBuf = Buffer.from(prefix === '' ? e.name : `${prefix}/${e.name}`, 'latin1');
    const valid = (b: Buffer) => {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(b);
        return true;
      } catch {
        return false;
      }
    };
    return {
      name: new TextDecoder().decode(nameBuf),
      ...(valid(nameBuf) ? {} : { rawName: nameBuf.toString('base64') }),
      path: new TextDecoder().decode(fullBuf),
      ...(valid(fullBuf) ? {} : { rawPath: fullBuf.toString('base64') }),
      kind: e.kind,
      mode: e.mode,
      oid: e.oid,
      size: e.kind === 'file' || e.kind === 'symlink' ? e.size : null,
    };
  });
}

async function list(options: {
  ref: string;
  path: string;
  rawPath?: string;
}): Promise<GitTreeListing> {
  const listTree = core.listTree;
  if (!listTree) throw new Error('listTree missing');
  return listTree.call(core, wt, options);
}

beforeAll(async () => {
  fx = createFixture();
  log = path.join(fx.root, 'spawn.log');
  writeFileSync(log, '');
  const wrapper = path.join(fx.root, 'git-wrapper.sh');
  // One line per spawn, written by one printf of a string built first (macOS CI, DECISIONS #391).
  writeFileSync(
    wrapper,
    `#!/bin/sh\nline="$*"\nprintf '%s\\n' "$line" >> '${log}'\nexec git "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  core = createGitCore(fx.coreOptions({ gitBinary: wrapper }));
  repo = fx.repo('main', {
    files: {
      'README.md': '# readme\n',
      'src/index.ts': 'export {};\n',
      'src/lib/a.ts': 'a\n',
      'src/lib/deep/b.ts': 'bb\n',
      'docs/guide.md': 'guide\n',
      'bin/run.sh': '#!/bin/sh\n',
      '-n/option-like.txt': 'dash\n',
      'a-b': 'file before a/\n',
      'a/inside.txt': 'x\n',
      a0: 'after a/\n',
    },
  });
  chmodSync(path.join(repo, 'bin/run.sh'), 0o755);
  fx.symlink('src/lib', path.join(repo, 'link-inside'));
  fx.symlink('/', path.join(repo, 'link-root'));
  fx.symlink('../..', path.join(repo, 'src/link-up'));
  fx.commitAll(repo, 'second');
  // A submodule (gitlink) without cloning anything: a commit id in the index.
  const lib = fx.repo('lib', { files: { 'lib.txt': 'lib\n' } });
  const libHead = fx.git(lib, ['rev-parse', 'HEAD']).trim();
  fx.git(repo, ['update-index', '--add', '--cacheinfo', `160000,${libHead},vendor/lib`]);
  fx.git(repo, ['commit', '-q', '-m', 'gitlink']);
  fx.git(repo, ['tag', '-a', '-m', 'annotated', 'v1']);
  fx.git(repo, ['branch', 'side']);
  wt = locator(repo, path.join(repo, '.git'));
  await core.version();
});

afterAll(async () => {
  await core?.dispose();
  fx?.dispose();
});

describe('listTree', () => {
  it('lists the root exactly as git ls-tree does (order, modes, kinds, ids, sizes)', async () => {
    const head = fx.git(repo, ['rev-parse', 'HEAD']).trim();
    const listing = await list({ ref: 'HEAD', path: '' });
    expect(listing.commit).toBe(head);
    expect(listing.kind).toBe('dir');
    expect(listing.tree).toBe(fx.git(repo, ['rev-parse', 'HEAD^{tree}']).trim());
    expect(listing.entries).toEqual(expectedEntries(repo, 'HEAD', ''));
    const kinds = Object.fromEntries(listing.entries.map((e) => [e.name, e.kind]));
    expect(kinds).toMatchObject({
      'README.md': 'file',
      src: 'dir',
      'link-inside': 'symlink',
      'link-root': 'symlink',
      vendor: 'dir',
    });
    // git's order: "a-b" < "a/" < "a0".
    const names = listing.entries.map((e) => e.name);
    expect(names.indexOf('a-b')).toBeLessThan(names.indexOf('a'));
    expect(names.indexOf('a')).toBeLessThan(names.indexOf('a0'));
  });

  it('lists nested directories, executables, submodules and option-like names', async () => {
    const lib = await list({ ref: 'HEAD', path: 'src/lib' });
    expect(lib.entries).toEqual(expectedEntries(repo, 'HEAD:src/lib', 'src/lib'));
    expect(lib.entries.map((e) => e.path)).toEqual(['src/lib/a.ts', 'src/lib/deep']);
    const bin = await list({ ref: 'HEAD', path: 'bin' });
    expect(bin.entries[0]).toMatchObject({
      name: 'run.sh',
      mode: '100755',
      kind: 'file',
      size: 10,
    });
    const vendor = await list({ ref: 'HEAD', path: 'vendor' });
    expect(vendor.entries).toEqual([
      expect.objectContaining({ name: 'lib', kind: 'submodule', mode: '160000', size: null }),
    ]);
    const dash = await list({ ref: 'HEAD', path: '-n' });
    expect(dash.entries.map((e) => e.path)).toEqual(['-n/option-like.txt']);
  });

  it('never enters a symlink (inside or out of the repo) or a submodule', async () => {
    for (const p of ['link-inside', 'link-root', 'src/link-up']) {
      const listing = await list({ ref: 'HEAD', path: p });
      expect(listing, p).toMatchObject({ kind: 'symlink', tree: null, entries: [] });
    }
    // Through a symlink component: the walk stops at the symlink, nothing below is listed.
    for (const p of ['link-inside/deep', 'link-root/etc', 'src/link-up/src']) {
      const listing = await list({ ref: 'HEAD', path: p });
      expect(listing, p).toMatchObject({ kind: null, tree: null, entries: [] });
    }
    expect(await list({ ref: 'HEAD', path: 'vendor/lib' })).toMatchObject({
      kind: 'submodule',
      tree: null,
      entries: [],
    });
    expect(await list({ ref: 'HEAD', path: 'README.md' })).toMatchObject({
      kind: 'file',
      entries: [],
    });
    expect(await list({ ref: 'HEAD', path: 'missing/dir' })).toMatchObject({
      kind: null,
      entries: [],
    });
  });

  it('refuses traversal and malformed paths before any git process', async () => {
    const before = spawns().length;
    for (const p of ['..', '../x', 'a/../b', './a', 'a/./b', 'a//b', '/abs', 'a/', 'a\u0000b']) {
      await expect(list({ ref: 'HEAD', path: p }), p).rejects.toMatchObject({
        code: 'invalid_argument',
      });
    }
    await expect(list({ ref: 'HEAD', path: '', rawPath: 'not base64!' })).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    await expect(
      list({ ref: 'HEAD', path: '', rawPath: Buffer.from('a/../b').toString('base64') }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(spawns().length).toBe(before);
  });

  it('resolves HEAD, branches, annotated tags, full and short commit ids', async () => {
    const head = fx.git(repo, ['rev-parse', 'HEAD']).trim();
    for (const ref of ['HEAD', 'main', 'refs/heads/main', 'side', 'v1', head, head.slice(0, 10)]) {
      expect((await list({ ref, path: '' })).commit, ref).toBe(head);
    }
    const first = fx.git(repo, ['rev-list', '--max-parents=0', 'HEAD']).trim();
    const old = await list({ ref: first, path: '' });
    expect(old.entries.map((e) => e.name)).not.toContain('vendor');
    expect(old.entries).toEqual(expectedEntries(repo, first, ''));
  });

  it('rejects unknown refs, revision syntax and option-like refs; no ref text reaches ls-tree', async () => {
    await expect(list({ ref: 'nope', path: '' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(list({ ref: 'f'.repeat(40), path: '' })).rejects.toMatchObject({
      code: 'not_found',
    });
    for (const ref of ['-p', '--output=/tmp/x', 'HEAD~1', 'HEAD^{tree}', 'main:src', '@{-1}', '']) {
      await expect(list({ ref, path: '' }), ref).rejects.toMatchObject({
        code: 'invalid_argument',
      });
    }
    // A blob's id is not a commit.
    const readme = fx.git(repo, ['rev-parse', 'HEAD:README.md']).trim();
    await expect(list({ ref: readme, path: '' })).rejects.toMatchObject({ code: 'not_found' });
    for (const line of spawns()) {
      if (!line.includes('ls-tree')) continue;
      expect(line).toMatch(/ ls-tree (-r )?-z (-l )?[0-9a-f]{40}$/);
    }
  });

  it('an unborn HEAD lists nothing', async () => {
    const empty = fx.repo('unborn', { empty: true });
    const listTree = core.listTree;
    if (!listTree) throw new Error('listTree missing');
    const listing = await listTree.call(core, locator(empty, path.join(empty, '.git')), {
      ref: 'HEAD',
      path: '',
    });
    expect(listing).toEqual({ commit: null, tree: null, kind: null, entries: [] });
  });

  it('never reads the working tree: deleted and rewritten files do not change the listing', async () => {
    const before = await list({ ref: 'HEAD', path: 'src' });
    rmSync(path.join(repo, 'src/index.ts'));
    writeFileSync(path.join(repo, 'src/new.ts'), 'new\n');
    writeFileSync(path.join(repo, 'src/lib/a.ts'), 'changed a lot\n');
    try {
      const fresh = createGitCore(fx.coreOptions());
      try {
        const after = await fresh.listTree?.(wt, { ref: 'HEAD', path: 'src' });
        expect(after).toEqual(before);
        const lib = await fresh.listTree?.(wt, { ref: 'HEAD', path: 'src/lib' });
        expect(lib?.entries.find((e) => e.name === 'a.ts')?.size).toBe(2);
      } finally {
        await fresh.dispose();
      }
    } finally {
      fx.git(repo, ['checkout', '-q', '--', 'src']);
      rmSync(path.join(repo, 'src/new.ts'));
    }
  });

  it('caches by (common dir, tree oid): a repeat and a linked worktree spawn nothing', async () => {
    const head = fx.git(repo, ['rev-parse', 'HEAD']).trim();
    await list({ ref: head, path: 'src/lib/deep' });
    const linked = path.join(fx.root, 'linked');
    fx.git(repo, ['worktree', 'add', '-q', '--detach', linked, head]);
    const listTree = core.listTree;
    if (!listTree) throw new Error('listTree missing');
    const linkedWt = locator(linked, path.join(repo, '.git'));
    // Warm the linked worktree's repository discovery (not a listing).
    await core.listCommits(linkedWt, { limit: 1 });
    const before = spawns().length;
    const again = await list({ ref: head, path: 'src/lib/deep' });
    const shared = await listTree.call(core, linkedWt, { ref: head, path: 'src/lib/deep' });
    expect(shared).toEqual(again);
    expect(spawns().slice(before)).toEqual([]);
  });

  it('lists names that are not UTF-8 (rawName / rawPath) and walks into them by rawPath', async () => {
    const raw = Buffer.from([0x64, 0xff, 0x69, 0x72]); // "d\xffir"
    const file = blob(repo, 'raw\n');
    const inner = mktree(repo, [
      { mode: '100644', type: 'blob', oid: file, name: Buffer.from([0x66, 0xfe]) },
    ]);
    const root = mktree(repo, [
      { mode: '040000', type: 'tree', oid: inner, name: raw },
      { mode: '100644', type: 'blob', oid: file, name: 'plain.txt' },
    ]);
    const commit = commitTree(repo, root);
    const listing = await list({ ref: commit, path: '' });
    expect(listing.entries).toEqual(expectedEntries(repo, commit, ''));
    const dir = listing.entries.find((e) => e.kind === 'dir');
    expect(dir?.rawName).toBe(raw.toString('base64'));
    expect(dir?.rawPath).toBe(raw.toString('base64'));
    expect(dir?.name).toBe('d�ir');
    const below = await list({ ref: commit, path: dir?.path ?? '', rawPath: dir?.rawPath });
    expect(below.entries).toEqual(expectedEntries(repo, inner, raw));
    expect(below.entries).toHaveLength(1);
    expect(below.entries[0]?.rawPath).toBe(
      Buffer.concat([raw, Buffer.from('/'), Buffer.from([0x66, 0xfe])]).toString('base64'),
    );
    // The lossy display path alone does not name the directory.
    expect((await list({ ref: commit, path: 'd�ir' })).kind).toBeNull();
  });

  it('keeps case-colliding names apart (a tree may hold both, whatever the file system)', async () => {
    const one = blob(repo, 'upper\n');
    const two = blob(repo, 'lower\n');
    const root = mktree(repo, [
      { mode: '100644', type: 'blob', oid: one, name: 'A.txt' },
      { mode: '100644', type: 'blob', oid: two, name: 'a.txt' },
      {
        mode: '040000',
        type: 'tree',
        oid: mktree(repo, [{ mode: '100644', type: 'blob', oid: one, name: 'x' }]),
        name: 'Dir',
      },
      {
        mode: '040000',
        type: 'tree',
        oid: mktree(repo, [{ mode: '100644', type: 'blob', oid: two, name: 'y' }]),
        name: 'dir',
      },
    ]);
    const commit = commitTree(repo, root);
    const listing = await list({ ref: commit, path: '' });
    expect(listing.entries.map((e) => e.name)).toEqual(['A.txt', 'Dir', 'a.txt', 'dir']);
    expect((await list({ ref: commit, path: 'Dir' })).entries.map((e) => e.path)).toEqual([
      'Dir/x',
    ]);
    expect((await list({ ref: commit, path: 'dir' })).entries.map((e) => e.path)).toEqual([
      'dir/y',
    ]);
  });

  it('matches git ls-tree for every directory of random trees (differential)', async () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const names = ['a', 'a-b', 'a.b', 'a0', 'B', 'b', 'z', '-x', 'é', '日本', 'x y', '#'];
    for (let round = 0; round < 6; round++) {
      const dirs: string[] = [];
      const build = (depth: number, prefix: string): string => {
        const entries: Array<{ mode: string; type: string; oid: string; name: string }> = [];
        const used = new Set<string>();
        const count = 1 + Math.floor(random() * 6);
        for (let i = 0; i < count; i++) {
          const name = names[Math.floor(random() * names.length)] as string;
          if (used.has(name)) continue;
          used.add(name);
          const roll = random();
          const full = prefix === '' ? name : `${prefix}/${name}`;
          if (roll < 0.35 && depth < 3) {
            dirs.push(full);
            entries.push({ mode: '040000', type: 'tree', oid: build(depth + 1, full), name });
          } else if (roll < 0.45) {
            entries.push({ mode: '120000', type: 'blob', oid: blob(repo, '../target'), name });
          } else if (roll < 0.5) {
            entries.push({ mode: '100755', type: 'blob', oid: blob(repo, `exec ${full}`), name });
          } else {
            entries.push({
              mode: '100644',
              type: 'blob',
              oid: blob(repo, `content ${full}\n`),
              name,
            });
          }
        }
        return mktree(repo, entries);
      };
      const commit = commitTree(repo, build(0, ''));
      for (const dir of ['', ...dirs]) {
        const listing = await list({ ref: commit, path: dir });
        expect(listing.entries, `${round}:${dir}`).toEqual(
          expectedEntries(repo, dir === '' ? commit : `${commit}:${dir}`, dir),
        );
      }
    }
  });
});

describe('countTreeFiles', () => {
  it('counts blobs, symlinks and gitlinks below a tree, memoized', async () => {
    const tree = fx.git(repo, ['rev-parse', 'HEAD:src']).trim();
    const expected = fx
      .git(repo, ['ls-tree', '-r', '--name-only', 'HEAD:src'])
      .split('\n')
      .filter(Boolean).length;
    expect(await core.countTreeFiles?.(wt, { tree })).toBe(expected);
    const before = spawns().length;
    expect(await core.countTreeFiles?.(wt, { tree })).toBe(expected);
    expect(spawns().length).toBe(before);
    const root = fx.git(repo, ['rev-parse', 'HEAD^{tree}']).trim();
    const all = fx
      .git(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])
      .split('\n')
      .filter(Boolean).length;
    expect(await core.countTreeFiles?.(wt, { tree: root })).toBe(all);
  });

  it('refuses anything but a full object id', async () => {
    for (const tree of ['HEAD', 'abc', '-r', `${'a'.repeat(40)} x`]) {
      await expect(core.countTreeFiles?.(wt, { tree })).rejects.toMatchObject({
        code: 'invalid_argument',
      });
    }
    const err = await core.countTreeFiles?.(wt, { tree: 'e'.repeat(40) }).catch((e: unknown) => e);
    expect(isGitCoreError(err)).toBe(true);
  });
});

describe('TreeCache', () => {
  it('stays under its byte bound and evicts the least recently used', () => {
    const cache = new TreeCache(1000);
    const entry = (bytes: number) => ({ entries: [], bytes });
    cache.set('a', entry(400));
    cache.set('b', entry(400));
    expect(cache.get('a')).toBeDefined();
    cache.set('c', entry(400));
    expect(cache.bytes).toBeLessThanOrEqual(1000);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    cache.set('huge', entry(5000));
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.bytes).toBeLessThanOrEqual(1000);
  });

  it('parses ls-tree -l output with padded sizes and skips unknown types', () => {
    const oid = 'a'.repeat(40);
    const out = `100644 blob ${oid}     12\tf\u0000040000 tree ${oid}       -\td\u0000160000 commit ${oid}       -\ts\u0000100644 weird ${oid} 1\tw\u0000`;
    expect(parseLsTree(out)).toEqual([
      { name: 'f', mode: '100644', kind: 'file', oid, size: 12 },
      { name: 'd', mode: '040000', kind: 'dir', oid, size: null },
      { name: 's', mode: '160000', kind: 'submodule', oid, size: null },
    ]);
    expect(() => parseLsTree(`100644 blob ${oid} 1 no-tab\u0000`)).toThrow();
  });
});

describe('a rename from a name that is not UTF-8 (PR #99 review)', () => {
  it('lists the source as oldRawPath (its bytes), in the list and the diff', async () => {
    const dir = fx.repo('raw-rename', { files: { 'keep.txt': 'k\n' } });
    const content = 'the same content, long enough to pair as a rename\n'.repeat(4);
    const oid = blob(dir, content);
    const raw = Buffer.from([0x6f, 0x6c, 0x64, 0xff, 0x2e, 0x74]); // "old\xff.t"
    const keep = fx.git(dir, ['rev-parse', 'HEAD:keep.txt']).trim();
    // HEAD holds the raw name; the index renames it to new.txt; the file system never sees it.
    const tree = mktree(dir, [
      { mode: '100644', type: 'blob', oid: keep, name: 'keep.txt' },
      { mode: '100644', type: 'blob', oid, name: raw },
    ]);
    const parent = fx.git(dir, ['rev-parse', 'HEAD']).trim();
    const commit = gitBytes(dir, ['commit-tree', tree, '-p', parent, '-m', 'raw'])
      .toString()
      .trim();
    fx.git(dir, ['update-ref', 'refs/heads/main', commit]);
    fx.git(dir, ['read-tree', 'HEAD']);
    gitBytes(
      dir,
      ['update-index', '-z', '--index-info'],
      Buffer.concat([
        Buffer.from(`0 ${'0'.repeat(40)}\t`),
        raw,
        Buffer.from([0]),
        Buffer.from(`100644 ${oid}\tnew.txt`),
        Buffer.from([0]),
      ]),
    );
    writeFileSync(path.join(dir, 'new.txt'), content);
    const status = gitBytes(dir, ['status', '--porcelain=v1', '-z']).toString('latin1');
    expect(status.startsWith('R  new.txt\u0000oldÿ.t')).toBe(true);
    const local = locator(dir, path.join(dir, '.git'));
    const files = await core.listChangedFiles(local, { kind: 'working' });
    const renamed = files.find((f) => f.path === 'new.txt');
    expect(renamed).toMatchObject({
      status: 'renamed',
      oldPath: 'old�.t',
      oldRawPath: raw.toString('base64'),
    });
    const diff = await core.getFileDiff(local, { kind: 'working' }, { path: 'new.txt' });
    expect(diff.oldRawPath).toBe(raw.toString('base64'));
    // A UTF-8 source carries no oldRawPath.
    fx.git(dir, ['mv', 'keep.txt', 'kept.txt']);
    const again = await core.listChangedFiles(local, { kind: 'working' });
    const kept = again.find((f) => f.path === 'kept.txt');
    expect(kept?.oldPath).toBe('keep.txt');
    expect(kept && 'oldRawPath' in kept).toBe(false);
  });
});
