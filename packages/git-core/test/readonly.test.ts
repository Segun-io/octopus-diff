/**
 * Read-only proof (PLAN §5.5): call every GitCore method on fixture repositories whose index is
 * stat-dirty (so a normal `git status` would refresh and rewrite it), then assert that
 * - no `*.lock` file was ever created in any git dir (watched with inotify via fs.watch),
 * - every file under every git dir is byte-for-byte unchanged, with the same size, mtime and
 *   inode (this covers `.git/index`, `HEAD`, refs, `packed-refs`, worktree admin dirs), and
 * - `git status --porcelain` output is unchanged.
 */
import { createHash } from 'node:crypto';
import { type FSWatcher, readdirSync, readFileSync, statSync, utimesSync, watch } from 'node:fs';
import path from 'node:path';
import type { DiffScope, GitCore, WorktreeLocator } from '@octopus-diff/contracts';
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

    const unborn = fx.repo('unborn', { empty: true });
    fx.write(path.join(unborn, 'staged.txt'), 's\n');
    fx.git(unborn, ['add', 'staged.txt']);

    bare = path.join(fx.root, 'bare.git');
    fx.git(fx.root, ['clone', '-q', '--bare', main, bare]);

    worktrees = [main, linked, conflict, unborn];
    gitDirs = [
      path.join(main, '.git'),
      path.join(conflict, '.git'),
      path.join(unborn, '.git'),
      bare,
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
      [...worktrees, bare, path.join(worktrees[0] as string, 'sub'), gitDirs[0] as string].map(
        (p) => core.resolveProject(p),
      ),
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
    for (const wt of locators) {
      await core.getSummary(wt);
      await core.getSummary(wt, { defaultBranch: 'main' });
      await core.getWatchTargets(wt);
      const commits = await core.listCommits(wt, { limit: 5 });
      const scopes: DiffScope[] = [
        { kind: 'working' },
        { kind: 'staged' },
        { kind: 'unstaged' },
        { kind: 'branch', base: 'main' },
        ...commits.slice(0, 2).map((c) => ({ kind: 'commit' as const, sha: c.sha })),
      ];
      for (const scope of scopes) {
        const files = await core.listChangedFiles(wt, scope).catch((error: unknown) => {
          // Branch scope on an unborn HEAD is expected to fail; anything else is not.
          if (scope.kind === 'branch') return [];
          throw error;
        });
        for (const file of files) {
          await core.getFileDiff(wt, scope, file);
          await core.getFileDiff(wt, scope, file, {
            ignoreWhitespace: true,
            contextLines: 10,
            full: true,
          });
          diffs += 1;
        }
      }
    }
    expect(diffs).toBeGreaterThan(10);
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
  });
});
