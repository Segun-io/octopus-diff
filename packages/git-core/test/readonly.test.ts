/**
 * Read-only proof (PLAN §5.5): call every GitCore method on fixture repositories whose index is
 * stat-dirty (so a normal `git status` would refresh and rewrite it), then assert that
 * - no `*.lock` file was ever created in any git dir (watched with inotify via fs.watch),
 * - every file under every git dir is byte-for-byte unchanged, with the same size, mtime and
 *   inode (this covers `.git/index`, `HEAD`, refs, `packed-refs`, worktree admin dirs), and
 * - `git status --porcelain` output is unchanged.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  type FSWatcher,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  watch,
} from 'node:fs';
import path from 'node:path';
import {
  type DiffScope,
  type GitCore,
  isGitCoreError,
  type WorktreeLocator,
} from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore, hashId } from '../src/index.js';
import { createFixture, type Fixture, lines } from './helpers/fixture.js';

interface FileState {
  size: number;
  mtimeNs: bigint;
  ino: bigint;
  hash: string;
}

function snapshot(dir: string, out = new Map<string, FileState>()): Map<string, FileState> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.set(`${full}/`, {
        size: 0,
        mtimeNs: statSync(full, { bigint: true }).mtimeNs,
        ino: 0n,
        hash: '',
      });
      snapshot(full, out);
    } else if (entry.isFile()) {
      const info = statSync(full, { bigint: true });
      out.set(full, {
        size: Number(info.size),
        mtimeNs: info.mtimeNs,
        ino: info.ino,
        hash: createHash('sha256').update(readFileSync(full)).digest('hex'),
      });
    }
  }
  return out;
}

describe('read-only proof', () => {
  let fx: Fixture;
  let core: GitCore;
  let gitDirs: string[];
  let worktrees: string[];
  let bare: string;
  let unreadable: string | null = null;
  const events: string[] = [];
  const watchers: FSWatcher[] = [];

  beforeAll(() => {
    fx = createFixture();
    const main = fx.repo('main', {
      files: { 'a.txt': lines(20), 'b.txt': 'b\n', 'c.txt': 'c\n', 'sub/d.txt': 'd\n' },
    });
    fx.git(main, ['switch', '-q', '-c', 'feature']);
    fx.write(path.join(main, 'feature.txt'), 'f\n');
    fx.commitAll(main, 'feature');
    fx.git(main, ['switch', '-q', 'main']);
    fx.git(main, ['pack-refs', '--all']);
    const linked = path.join(fx.root, 'linked');
    fx.git(main, ['worktree', 'add', '-q', linked, 'feature']);
    // Dirty state everywhere.
    fx.write(path.join(main, 'a.txt'), lines(20).replace('line 7', 'seven'));
    fx.write(path.join(main, 'b.txt'), 'B\n');
    fx.git(main, ['add', 'b.txt']);
    fx.git(main, ['mv', 'c.txt', 'c-renamed.txt']);
    fx.write(path.join(main, 'untracked.txt'), 'u\n');
    fx.write(path.join(linked, 'feature.txt'), 'F\n');
    fx.write(path.join(linked, 'new.txt'), 'n\n');

    const conflict = fx.repo('conflict', { files: { 'x.txt': 'base\n' } });
    fx.git(conflict, ['switch', '-q', '-c', 'other']);
    fx.write(path.join(conflict, 'x.txt'), 'other\n');
    fx.commitAll(conflict, 'other');
    fx.git(conflict, ['switch', '-q', 'main']);
    fx.write(path.join(conflict, 'x.txt'), 'main\n');
    fx.commitAll(conflict, 'main');
    fx.git(conflict, ['merge', 'other'], { allowFail: true });

    // Merge noise (#32): a feature branch with `main` merged in, and a second merge of `main`
    // stopped on a conflict (readFileOrigins' index-only `diff --cached MERGE_HEAD`).
    const noisy = fx.repo('noisy', { files: { 'n.txt': 'base\n', 'm.txt': 'm\n' } });
    fx.git(noisy, ['switch', '-q', '-c', 'feature']);
    fx.write(path.join(noisy, 'n.txt'), 'feature\n');
    fx.commitAll(noisy, 'feature');
    fx.git(noisy, ['switch', '-q', 'main']);
    fx.write(path.join(noisy, 'theirs.txt'), 't\n');
    fx.commitAll(noisy, 'theirs');
    fx.git(noisy, ['switch', '-q', 'feature']);
    fx.git(noisy, ['merge', '-q', '--no-edit', 'main']);
    fx.git(noisy, ['switch', '-q', 'main']);
    fx.write(path.join(noisy, 'n.txt'), 'main\n');
    fx.write(path.join(noisy, 'm.txt'), 'm2\n');
    fx.commitAll(noisy, 'main again');
    fx.git(noisy, ['switch', '-q', 'feature']);
    fx.git(noisy, ['merge', 'main'], { allowFail: true });

    const unborn = fx.repo('unborn', { empty: true });
    fx.write(path.join(unborn, 'staged.txt'), 's\n');
    fx.git(unborn, ['add', 'staged.txt']);

    bare = path.join(fx.root, 'bare.git');
    fx.git(fx.root, ['clone', '-q', '--bare', main, bare]);

    // Superproject: a moved submodule pointer (git-core reads the submodule's HEAD), an
    // attributes file with an untracked binary-attribute file (git check-attr), an untracked
    // nested repository, and (unless root) an unreadable modified tracked file.
    const lib = fx.repo('lib', { files: { 'l.txt': 'l1\n' } });
    fx.write(path.join(lib, 'l.txt'), 'l2\n');
    fx.commitAll(lib, 'l2');
    const sup = fx.repo('super', {
      files: { '.gitattributes': '*.dat binary\n', 'r.txt': 'r\n', 'locked.txt': 'k\n' },
    });
    fx.git(sup, ['submodule', 'add', '-q', lib, 'sub']);
    fx.commitAll(sup, 'sub');
    fx.git(path.join(sup, 'sub'), ['checkout', '-q', '--detach', 'HEAD~1']);
    fx.write(path.join(sup, 'x.dat'), 'text under binary\n');
    const nested = fx.repo('super/nested', { files: { 'n.txt': 'n\n' } });
    if (process.getuid?.() !== 0) {
      unreadable = path.join(sup, 'locked.txt');
      fx.write(unreadable, 'changed\n');
      chmodSync(unreadable, 0o000);
    }

    worktrees = [main, linked, conflict, noisy, unborn, sup];
    gitDirs = [
      path.join(main, '.git'),
      path.join(conflict, '.git'),
      path.join(noisy, '.git'),
      path.join(unborn, '.git'),
      bare,
      path.join(sup, '.git'),
      path.join(nested, '.git'),
      path.join(lib, '.git'),
    ];

    // Make the index stat-dirty: tracked files get new mtimes with unchanged content, which
    // makes `git status` re-hash them and (without --no-optional-locks) rewrite the index.
    const future = new Date(Date.now() + 60_000);
    for (const [dir, file] of [
      [main, 'sub/d.txt'],
      [main, 'a.txt'],
      [linked, 'a.txt'],
      [conflict, 'x.txt'],
    ] as const) {
      utimesSync(path.join(dir, file), future, future);
    }
    core = createGitCore(fx.coreOptions());
  });

  afterAll(async () => {
    if (unreadable) chmodSync(unreadable, 0o644);
    for (const watcher of watchers) watcher.close();
    await core.dispose();
    fx.dispose();
  });

  it('never writes to any repository', async () => {
    const statusBefore = worktrees.map((dir) =>
      fx.git(dir, ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch', '-uall']),
    );
    const before = new Map<string, FileState>();
    for (const dir of gitDirs) snapshot(dir, before);
    for (const dir of gitDirs) {
      watchers.push(
        watch(dir, { recursive: true }, (eventType, filename) => {
          events.push(`${eventType} ${path.join(dir, String(filename))}`);
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    // --- Exercise every GitCore method. ---
    const version = await core.version();
    expect(version.features.supported).toBe(true);
    const scan = await core.scan(fx.root, { depth: 2 });
    expect(scan.repositories.length).toBeGreaterThanOrEqual(5);
    const projects = await Promise.all(
      [
        ...worktrees,
        bare,
        path.join(worktrees[0] as string, 'sub'),
        gitDirs[0] as string,
        path.join(fx.root, 'super', 'sub'),
      ].map((p) => core.resolveProject(p)),
    );
    const locators: WorktreeLocator[] = [];
    for (const { project, worktrees: list } of projects) {
      await core.listWorktrees(project);
      await core.detectDefaultBranch(project);
      for (const worktree of list) {
        if (!locators.some((l) => l.worktreeId === worktree.id)) {
          locators.push({ projectId: project.id, worktreeId: worktree.id, path: worktree.path });
        }
      }
    }
    expect(locators.map((l) => l.worktreeId)).toContain(hashId(bare));
    let diffs = 0;
    let reviewCalls = 0;
    let originCalls = 0;
    const noise = new Set<string>();
    let snapshots = 0;
    const blobKinds = new Set<string>();
    for (const wt of locators) {
      await core.getSummary(wt);
      await core.getSummary(wt, { defaultBranch: 'main' });
      // Live feed (#37): the snapshot, then every blob id it carries (deleted, modified, staged,
      // renamed files), by `readBlob`; and a tree, which it must refuse without reading.
      const snapshot = (await core.getSummary(wt, { snapshot: true })).snapshot;
      expect(snapshot).toBeDefined();
      for (const entry of snapshot?.entries ?? []) {
        snapshots += 1;
        for (const oid of [entry.hH, entry.hI]) {
          if (oid === null) continue;
          const blob = await core.readBlob?.(wt, { oid }).catch((error: unknown) => {
            // A submodule's commit id is not an object of the superproject; nothing else may fail.
            if (isGitCoreError(error, 'not_found')) return null;
            throw error;
          });
          if (blob) blobKinds.add(blob.kind);
        }
      }
      const treeOid = fx
        .git(wt.path, ['rev-parse', '--verify', '-q', 'HEAD^{tree}'], { allowFail: true })
        .trim();
      if (treeOid) {
        const refused = await core.readBlob?.(wt, { oid: treeOid }).catch((e: unknown) => e);
        expect(isGitCoreError(refused, 'invalid_argument')).toBe(true);
        // The file explorer (#9): every directory of HEAD, and the file count of the root.
        const dirs = [''];
        while (dirs.length > 0) {
          const dir = dirs.pop() as string;
          const listing = await core.listTree?.(wt, { ref: 'HEAD', path: dir });
          for (const entry of listing?.entries ?? []) {
            if (entry.kind === 'dir' && entry.rawPath === undefined) dirs.push(entry.path);
          }
        }
        await core.countTreeFiles?.(wt, { tree: treeOid });
      }
      await core.getWatchTargets(wt);
      const commits = await core.listCommits(wt, { limit: 5 });
      const scopes: DiffScope[] = [
        { kind: 'working' },
        { kind: 'staged' },
        { kind: 'unstaged' },
        { kind: 'branch', base: 'main' },
        { kind: 'branch', base: 'main', includeWorking: true },
        { kind: 'review' },
        ...commits.slice(1, 2).map((c) => ({ kind: 'review' as const, base: c.sha })),
        ...commits.slice(0, 2).map((c) => ({ kind: 'commit' as const, sha: c.sha })),
      ];
      // Status flow v2: review range, commit details (log, patch-id on stdin), range patch-id.
      for (const bookmark of [null, commits[1]?.sha ?? null, 'ab'.repeat(20)]) {
        const range = await core.readReviewRange?.(wt, { bookmark, defaultBranch: 'main' });
        expect(range).toBeDefined();
      }
      if (commits.length > 0) {
        const details = await core.describeCommits?.(
          wt,
          commits.map((c) => c.sha),
        );
        expect(details?.length).toBe(commits.length);
        reviewCalls += 1;
      }
      const [newest, older] = commits;
      if (newest && older) await core.rangePatchId?.(wt, older.sha, newest.sha);
      // Merge noise (#32): with the listed files and without (git-core lists them itself).
      for (const bookmark of [null, commits.at(-1)?.sha ?? null]) {
        const range = await core.readReviewRange?.(wt, { bookmark, defaultBranch: 'main' });
        const base = range?.base ?? null;
        const files = await core.listChangedFiles(
          wt,
          base ? { kind: 'review', base } : { kind: 'review' },
        );
        const given = await core.readFileOrigins?.(wt, { base, defaultBranch: 'main', files });
        expect(given?.origins.size).toBe(files.length);
        for (const info of given?.origins.values() ?? []) noise.add(`${info.origin}:${info.via}`);
        await core.readFileOrigins?.(wt, { base, defaultBranch: 'main' });
        originCalls += 1;
      }
      for (const scope of scopes) {
        const files = await core.listChangedFiles(wt, scope).catch((error: unknown) => {
          // Branch scope on an unborn HEAD is expected to fail; anything else is not.
          if (scope.kind === 'branch') return [];
          throw error;
        });
        for (const file of files) {
          const expectFailure = unreadable !== null && path.join(wt.path, file.path) === unreadable;
          const run = async (promise: Promise<unknown>): Promise<void> => {
            // The unreadable file's own diff fails (F7); nothing else may.
            if (!expectFailure) return void (await promise);
            const error = await promise.then(
              () => null,
              (e: unknown) => e,
            );
            expect(isGitCoreError(error, 'git_failed') || error === null).toBe(true);
          };
          await run(core.getFileDiff(wt, scope, file));
          await run(
            core.getFileDiff(wt, scope, file, {
              ignoreWhitespace: true,
              contextLines: 10,
              full: true,
            }),
          );
          diffs += 1;
        }
      }
    }
    expect(snapshots).toBeGreaterThan(10);
    expect(blobKinds).toContain('text');
    expect(diffs).toBeGreaterThan(10);
    expect(reviewCalls).toBeGreaterThan(3);
    expect(originCalls).toBeGreaterThan(6);
    // The in-progress merge of `main` took the index-only path, and a committed merge was seen.
    expect(noise).toContain('base:in-progress');
    expect(noise).toContain('base:merge');
    await new Promise((resolve) => setTimeout(resolve, 200));

    // --- Nothing changed. ---
    expect(events.filter((event) => event.endsWith('.lock'))).toEqual([]);
    expect(events).toEqual([]);
    const after = new Map<string, FileState>();
    for (const dir of gitDirs) snapshot(dir, after);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, state] of before) {
      expect(after.get(file), file).toEqual(state);
    }
    for (const name of ['index', 'HEAD', 'packed-refs']) {
      expect(before.has(path.join(gitDirs[0] as string, name)), name).toBe(true);
    }
    const statusAfter = worktrees.map((dir) =>
      fx.git(dir, ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch', '-uall']),
    );
    expect(statusAfter).toEqual(statusBefore);
    // Exercises every read path (hundreds of git processes): ~2.5 s on a 12-core machine, over
    // the 5 s default on a 4-core CI runner that runs the other packages' tests at the same time.
    // ~13 s alone on macOS (git spawns are slower there); the full parallel suite can double it.
  }, 60_000);
});

describe('read-only proof: split index (documented exception)', () => {
  it('changes nothing except the mtime of .git/sharedindex.* (git freshens it on every read)', async () => {
    const fx = createFixture();
    const core = createGitCore(fx.coreOptions());
    try {
      const repo = fx.repo('split', { files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
      fx.git(repo, ['update-index', '--split-index']);
      fx.write(path.join(repo, 'a.txt'), 'changed\n');
      fx.write(path.join(repo, 'c.txt'), 'c\n');
      fx.git(repo, ['add', 'c.txt']);
      const gitDir = path.join(repo, '.git');
      const before = snapshot(gitDir);
      const wt = { projectId: hashId(gitDir), worktreeId: hashId(repo), path: repo };
      await core.getSummary(wt);
      for (const scope of [
        { kind: 'working' },
        { kind: 'staged' },
        { kind: 'unstaged' },
      ] as const) {
        for (const file of await core.listChangedFiles(wt, scope))
          await core.getFileDiff(wt, scope, file);
      }
      const after = snapshot(gitDir);
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      for (const [file, state] of before) {
        const now = after.get(file) as FileState;
        if (path.basename(file).startsWith('sharedindex.')) {
          expect({ ...now, mtimeNs: 0n }, file).toEqual({ ...state, mtimeNs: 0n });
        } else {
          expect(now, file).toEqual(state);
        }
      }
    } finally {
      await core.dispose();
      fx.dispose();
    }
  });
});
