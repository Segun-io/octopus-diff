import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WatchTargets } from '@octopus-diff/contracts';
import { noopLogger } from '@octopus-diff/contracts';
import parcelWatcher from '@parcel/watcher';
import { describe, expect, it } from 'vitest';
import {
  buildWorktreeIgnores,
  compactIgnores,
  type DirtyReason,
  type SubscribeFn,
  WatcherService,
  type WatcherServiceOptions,
  withDescendants,
} from '../src/watcher.js';
import { eventually, onCleanup, sleep, tempDir } from './helpers.js';

interface Recorder {
  dirty: Array<{ id: string; reason: DirtyReason; at: number }>;
  lists: Array<{ projectId: string; reason: string }>;
}

function makeWatcher(overrides: Partial<WatcherServiceOptions> = {}): {
  watcher: WatcherService;
  rec: Recorder;
} {
  const rec: Recorder = { dirty: [], lists: [] };
  const watcher = new WatcherService({
    logger: noopLogger,
    debounceMs: 150,
    pollFocusedMs: 60_000,
    pollIdleMs: 60_000,
    relistMs: 60_000,
    onWorktreeDirty: (id, reason) => rec.dirty.push({ id, reason, at: Date.now() }),
    onWorktreeListDirty: (projectId, reason) => rec.lists.push({ projectId, reason }),
    ...overrides,
  });
  onCleanup(() => watcher.close());
  return { watcher, rec };
}

async function makeLayout() {
  const base = await tempDir();
  const main = path.join(base, 'repo');
  const common = path.join(main, '.git');
  const linked = path.join(base, 'repo-wt');
  const linkedGitDir = path.join(common, 'worktrees', 'wt');
  await mkdir(path.join(common, 'refs', 'heads'), { recursive: true });
  await mkdir(path.join(common, 'objects', 'ab'), { recursive: true });
  await mkdir(linkedGitDir, { recursive: true });
  await mkdir(linked, { recursive: true });
  await mkdir(path.join(main, 'src'), { recursive: true });
  await mkdir(path.join(main, 'node_modules', 'pkg'), { recursive: true });
  const targets = (gitDir: string, root: string): WatchTargets => ({
    worktreeRoot: root,
    gitDir,
    commonDir: common,
    gitPaths: [
      path.join(gitDir, 'HEAD'),
      path.join(gitDir, 'index'),
      path.join(common, 'refs'),
      path.join(common, 'packed-refs'),
      path.join(common, 'worktrees'),
    ],
  });
  return {
    base,
    main,
    common,
    linked,
    linkedGitDir,
    worktrees: [
      {
        projectId: 'p1',
        worktreeId: 'main',
        root: main,
        bare: false,
        isMain: true,
        targets: targets(common, main),
      },
      {
        projectId: 'p1',
        worktreeId: 'linked',
        root: linked,
        bare: false,
        isMain: false,
        targets: targets(linkedGitDir, linked),
      },
    ],
  };
}

const idsOf = (rec: Recorder, from = 0) =>
  [...new Set(rec.dirty.slice(from).map((d) => d.id))].sort();

describe('WatcherService', () => {
  it('reports working-tree changes after a debounce, coalescing bursts', async () => {
    const layout = await makeLayout();
    const { watcher, rec } = makeWatcher();
    await watcher.setProject('p1', layout.common, layout.worktrees);
    expect(watcher.status()).toEqual({ mode: 'native', warnings: [] });

    const started = Date.now();
    for (let i = 0; i < 20; i++)
      await writeFile(path.join(layout.main, 'src', `f${i % 3}.ts`), `x${i}`);
    await eventually(() => rec.dirty.some((d) => d.id === 'main'), 2000);
    const first = rec.dirty.find((d) => d.id === 'main');
    expect((first?.at ?? 0) - started).toBeGreaterThanOrEqual(140);
    expect((first?.at ?? 0) - started).toBeLessThan(1500);
    await sleep(400);
    expect(rec.dirty.filter((d) => d.id === 'main').length).toBeLessThanOrEqual(2);
    expect(rec.dirty.every((d) => d.id === 'main' && d.reason === 'fs')).toBe(true);
  });

  it('with leadingEdge, refreshes a quiet worktree at once and still coalesces the burst', async () => {
    const layout = await makeLayout();
    const { watcher, rec } = makeWatcher({ leadingEdge: true });
    await watcher.setProject('p1', layout.common, layout.worktrees);

    const started = Date.now();
    await writeFile(path.join(layout.main, 'src', 'a.ts'), 'x');
    await eventually(() => rec.dirty.some((d) => d.id === 'main'), 2000);
    expect((rec.dirty.find((d) => d.id === 'main')?.at ?? 0) - started).toBeLessThan(120);

    await sleep(400);
    const mark = rec.dirty.length;
    for (let i = 0; i < 20; i++)
      await writeFile(path.join(layout.main, 'src', `f${i % 3}.ts`), `x${i}`);
    await sleep(600);
    const fires = rec.dirty.slice(mark).filter((d) => d.id === 'main');
    // One leading refresh plus one trailing refresh for the rest of the burst.
    expect(fires.length).toBeGreaterThanOrEqual(1);
    expect(fires.length).toBeLessThanOrEqual(3);
  });

  it('ignores node_modules, .git internals and extra ignore entries', async () => {
    const layout = await makeLayout();
    await mkdir(path.join(layout.main, 'generated'), { recursive: true });
    // Created before subscribing: a directory that appears afterwards with subdirectories inside
    // makes the watcher re-subscribe and refresh once (DECISIONS #213), which is not what this
    // test is about.
    await mkdir(path.join(layout.main, 'packages', 'a', 'node_modules', 'dep'), {
      recursive: true,
    });
    await mkdir(path.join(layout.main, 'packages', 'a', 'generated'), { recursive: true });
    const { watcher, rec } = makeWatcher({ ignore: ['generated'] });
    await watcher.setProject('p1', layout.common, layout.worktrees);
    await sleep(300); // FSEvents (macOS) replays the directories created just before
    const start = rec.dirty.length;
    await writeFile(path.join(layout.main, 'node_modules', 'pkg', 'index.js'), 'x');
    await writeFile(path.join(layout.main, 'generated', 'out.txt'), 'x');
    // Nested (monorepo) ones: FSEvents only drops paths an ignore glob matches (withDescendants).
    await writeFile(path.join(layout.main, 'packages', 'a', 'node_modules', 'dep', 'i.js'), 'x');
    await writeFile(path.join(layout.main, 'packages', 'a', 'generated', 'out.txt'), 'x');
    await writeFile(path.join(layout.common, 'objects', 'ab', 'cdef'), 'x');
    await writeFile(path.join(layout.common, 'index.lock'), 'x');
    await sleep(600);
    expect(rec.dirty.slice(start)).toEqual([]);
  });

  it('routes git-dir events to the right worktrees and detects worktree list changes', async () => {
    const layout = await makeLayout();
    const { watcher, rec } = makeWatcher();
    await watcher.setProject('p1', layout.common, layout.worktrees);

    await writeFile(path.join(layout.linkedGitDir, 'index'), 'x');
    await eventually(() => rec.dirty.length > 0, 2000);
    await sleep(250);
    expect(idsOf(rec)).toEqual(['linked']);
    expect(rec.dirty[0]?.reason).toBe('git');

    let mark = rec.dirty.length;
    await writeFile(path.join(layout.common, 'index'), 'x');
    await eventually(() => rec.dirty.length > mark, 2000);
    await sleep(250);
    expect(idsOf(rec, mark)).toEqual(['main']);

    mark = rec.dirty.length;
    await writeFile(path.join(layout.common, 'refs', 'heads', 'main'), 'abc');
    await eventually(() => idsOf(rec, mark).length === 2, 2000);

    expect(rec.lists).toEqual([]);
    await mkdir(path.join(layout.common, 'worktrees', 'new-agent'));
    await eventually(() => rec.lists.length > 0, 2000);
    expect(rec.lists[0]).toEqual({ projectId: 'p1', reason: 'git' });
  });

  it('attributes events inside a nested worktree to the nested worktree', async () => {
    const layout = await makeLayout();
    const nestedRoot = path.join(layout.main, '.claude', 'worktrees', 'agent');
    await mkdir(nestedRoot, { recursive: true });
    const { watcher, rec } = makeWatcher();
    await watcher.setProject('p1', layout.common, [
      ...layout.worktrees,
      {
        projectId: 'p1',
        worktreeId: 'nested',
        root: nestedRoot,
        bare: false,
        isMain: false,
        targets: null,
      },
    ]);
    await writeFile(path.join(nestedRoot, 'file.ts'), 'x');
    await eventually(() => rec.dirty.length > 0, 2000);
    await sleep(250);
    expect(idsOf(rec)).toEqual(['nested']);
  });

  it('falls back to polling when native watching hits inotify limits', async () => {
    const layout = await makeLayout();
    const failing: SubscribeFn = async (dir, fn, opts) => {
      if (dir === layout.main) {
        throw new Error(`inotify_add_watch on '${dir}' failed: No space left on device`);
      }
      return parcelWatcher.subscribe(dir, fn, opts);
    };
    const { watcher, rec } = makeWatcher({
      subscribe: failing,
      pollFocusedMs: 200,
      pollIdleMs: 60_000,
    });
    await watcher.setProject('p1', layout.common, layout.worktrees);
    const status = watcher.status();
    expect(status.mode).toBe('mixed');
    expect(status.warnings).toHaveLength(1);
    expect(status.warnings[0]).toMatch(/inotify watch limit/);
    expect(status.warnings[0]).toMatch(/max_user_watches/);
    expect(status.warnings[0]).not.toContain(layout.main);
    expect(watcher.pollIntervalFor('main')).toBe(200);
    expect(watcher.pollIntervalFor('linked')).toBe(60_000);
    await eventually(() => rec.dirty.some((d) => d.id === 'main' && d.reason === 'poll'), 2000);
  });

  it('reports polling mode when every watcher fails', async () => {
    const layout = await makeLayout();
    const { watcher } = makeWatcher({
      subscribe: async () => {
        throw new Error('Too many open files');
      },
    });
    await watcher.setProject('p1', layout.common, layout.worktrees);
    const status = watcher.status();
    expect(status.mode).toBe('polling');
    expect(status.warnings[0]).toMatch(/max_user_instances/);
  });

  it('polls only (no subscriptions) when forcePolling or disabled', async () => {
    const layout = await makeLayout();
    let subscribed = 0;
    const counting: SubscribeFn = async (dir, fn, opts) => {
      subscribed++;
      return parcelWatcher.subscribe(dir, fn, opts);
    };
    const forced = makeWatcher({ subscribe: counting, forcePolling: true, pollFocusedMs: 100 });
    await forced.watcher.setProject('p1', layout.common, layout.worktrees);
    expect(forced.watcher.status()).toEqual({ mode: 'polling', warnings: [] });
    await eventually(() => forced.rec.dirty.some((d) => d.reason === 'poll'), 2000);
    const disabled = makeWatcher({ subscribe: counting, enabled: false });
    await disabled.watcher.setProject('p1', layout.common, layout.worktrees);
    expect(disabled.watcher.status().mode).toBe('disabled');
    expect(subscribed).toBe(0);
  });

  it('uses the focused poll cadence and refreshes on focus', async () => {
    const layout = await makeLayout();
    const { watcher, rec } = makeWatcher({ pollFocusedMs: 30_000, pollIdleMs: 300_000 });
    await watcher.setProject('p1', layout.common, layout.worktrees);
    expect(watcher.pollIntervalFor('main')).toBe(300_000);
    watcher.setFocus('main');
    expect(watcher.pollIntervalFor('main')).toBe(30_000);
    await eventually(() => rec.dirty.some((d) => d.id === 'main' && d.reason === 'focus'), 1000);
    watcher.setFocus(null);
    expect(watcher.pollIntervalFor('main')).toBe(300_000);
  });

  it('unwatches removed worktrees and stops everything on close', async () => {
    const layout = await makeLayout();
    let active = 0;
    const tracking: SubscribeFn = async (dir, fn, opts) => {
      const sub = await parcelWatcher.subscribe(dir, fn, opts);
      active++;
      return {
        unsubscribe: async () => {
          active--;
          await sub.unsubscribe();
        },
      };
    };
    const { watcher, rec } = makeWatcher({ subscribe: tracking });
    await watcher.setProject('p1', layout.common, layout.worktrees);
    expect(active).toBe(3);
    await watcher.setProject('p1', layout.common, layout.worktrees.slice(0, 1));
    expect(active).toBe(2);
    expect(watcher.isWatched('linked')).toBe(false);
    await watcher.close();
    expect(active).toBe(0);
    await writeFile(path.join(layout.main, 'src', 'late.ts'), 'x');
    await sleep(400);
    expect(rec.dirty).toEqual([]);
  });

  it('expands plain ignore names to any depth', () => {
    const ignores = buildWorktreeIgnores(['gen', 'docs/**/*.tmp']);
    expect(ignores).toContain('node_modules');
    expect(ignores).toContain('**/node_modules');
    expect(ignores).toContain('**/gen');
    expect(ignores).toContain('docs/**/*.tmp');
    expect(ignores).not.toContain('**/docs/**/*.tmp');
  });

  it('ignores the contents of every ignored glob, not just the directory itself', () => {
    expect(withDescendants(['node_modules', '**/{dist,gen}', 'docs/**/*.tmp', 'a/**'])).toEqual([
      'node_modules',
      '**/{dist,gen}',
      '**/{dist,gen}/**',
      'docs/**/*.tmp',
      'docs/**/*.tmp/**',
      'a/**',
    ]);
  });

  it('compacts any-depth name globs into one brace glob for the native matcher', () => {
    const compact = compactIgnores(buildWorktreeIgnores(['gen', 'docs/**/*.tmp', 'a,b']));
    const brace = compact.filter((e) => e.startsWith('**/{'));
    expect(brace).toHaveLength(1);
    expect(brace[0]).toContain('node_modules');
    expect(brace[0]).toContain('gen');
    expect(compact).toContain('node_modules');
    expect(compact).toContain('docs/**/*.tmp');
    expect(compact).toContain('**/a,b');
    expect(compact.filter((e) => /^\*\*\/[^{]/.test(e))).toEqual(['**/a,b']);
  });
});
