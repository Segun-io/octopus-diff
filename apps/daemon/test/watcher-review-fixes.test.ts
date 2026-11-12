import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WatchTargets } from '@octopus-diff/contracts';
import { noopLogger } from '@octopus-diff/contracts';
import parcelWatcher from '@parcel/watcher';
import { describe, expect, it } from 'vitest';
import { dirRefusal, worktreeRootRefusal } from '../src/watch-guard.js';
import { parseBuildDirRules } from '../src/watch-ignores.js';
import {
  type DirtyReason,
  type SubscribeFn,
  type WatchedWorktree,
  WatcherService,
  type WatcherServiceOptions,
} from '../src/watcher.js';
import { eventually, onCleanup, sleep, tempDir } from './helpers.js';

/**
 * Regression tests for the watcher findings of review-code (F1, F3, F5, F6) and
 * review-security (SEC-07), against the real `@parcel/watcher` and temp directories.
 */

interface Recorder {
  dirty: Array<{ id: string; reason: DirtyReason; at: number }>;
  lists: Array<{ projectId: string; reason: string }>;
  replaced: string[];
}

function makeWatcher(overrides: Partial<WatcherServiceOptions> = {}): {
  watcher: WatcherService;
  rec: Recorder;
} {
  const rec: Recorder = { dirty: [], lists: [], replaced: [] };
  const watcher = new WatcherService({
    logger: noopLogger,
    debounceMs: 150,
    pollFocusedMs: 60_000,
    pollIdleMs: 60_000,
    relistMs: 60_000,
    guardDirs: { home: null, tmp: null },
    onWorktreeDirty: (id, reason) => rec.dirty.push({ id, reason, at: Date.now() }),
    onWorktreeListDirty: (projectId, reason) => rec.lists.push({ projectId, reason }),
    onWorktreeReplaced: (id) => rec.replaced.push(id),
    ...overrides,
  });
  onCleanup(() => watcher.close());
  return { watcher, rec };
}

const idsOf = (rec: Recorder, from = 0) =>
  [...new Set(rec.dirty.slice(from).map((d) => d.id))].sort();

function targetsFor(common: string, gitDir: string, root: string): WatchTargets {
  return {
    worktreeRoot: root,
    gitDir,
    commonDir: common,
    gitPaths: [
      path.join(gitDir, 'HEAD'),
      path.join(gitDir, 'index'),
      path.join(common, 'refs'),
      path.join(common, 'packed-refs'),
      path.join(common, 'worktrees'),
      path.join(common, 'config'),
      path.join(common, 'info', 'exclude'),
    ],
  };
}

async function makeLayout() {
  const base = await tempDir();
  const main = path.join(base, 'repo');
  const common = path.join(main, '.git');
  const linked = path.join(base, 'repo-wt');
  const linkedGitDir = path.join(common, 'worktrees', 'wt');
  await mkdir(path.join(common, 'refs', 'heads'), { recursive: true });
  await mkdir(path.join(common, 'objects', 'ab'), { recursive: true });
  await mkdir(path.join(common, 'info'), { recursive: true });
  await mkdir(linkedGitDir, { recursive: true });
  await mkdir(path.join(linked, 'src'), { recursive: true });
  await mkdir(path.join(main, 'src'), { recursive: true });
  const worktree = (id: string, root: string, gitDir: string, isMain: boolean) => ({
    projectId: 'p1',
    worktreeId: id,
    root,
    bare: false,
    isMain,
    targets: targetsFor(common, gitDir, root),
  });
  return {
    base,
    main,
    common,
    linked,
    linkedGitDir,
    mainWt: worktree('main', main, common, true),
    linkedWt: worktree('linked', linked, linkedGitDir, false),
    get worktrees(): WatchedWorktree[] {
      return [this.mainWt, this.linkedWt];
    },
  };
}

interface RawEvent {
  dir: string;
  path: string;
}

/**
 * Simulates FSEvents (macOS): it replays changes made just before subscribing (DECISIONS #164)
 * some time after the subscription started, and in stream order: events made after subscribing
 * arrive behind the replay. `events(dir)` lists the replayed events of one subscription.
 */
interface ReplayOptions {
  delayMs: number;
  events: (dir: string) => parcelWatcher.Event[];
}

/** Subscribe wrapper that counts subscriptions per directory and active ones. */
function tracking(
  filter?: (dir: string, e: parcelWatcher.Event) => boolean,
  options: { replay?: ReplayOptions } = {},
) {
  const subscribed: string[] = [];
  /** Every event handed to the watcher, in order; recorded after the watcher handled it. */
  const raw: RawEvent[] = [];
  let active = 0;
  const subscribe: SubscribeFn = async (dir, fn, opts) => {
    if (dir === '/') throw new Error('refusal failed: subscribed to /');
    const deliver = (error: Error | null, events: parcelWatcher.Event[]) => {
      fn(error, filter ? events.filter((e) => filter(dir, e)) : events);
      for (const e of events) raw.push({ dir, path: e.path });
    };
    let gate: Promise<void> = Promise.resolve();
    if (options.replay) {
      const { delayMs, events } = options.replay;
      gate = sleep(delayMs).then(() => deliver(null, events(dir)));
    }
    const sub = await parcelWatcher.subscribe(
      dir,
      (error, events) => {
        gate = gate.then(() => deliver(error, events));
      },
      opts,
    );
    subscribed.push(dir);
    active++;
    return {
      unsubscribe: async () => {
        active--;
        await sub.unsubscribe();
      },
    };
  };
  return {
    subscribe,
    subscribed,
    raw,
    get active() {
      return active;
    },
  };
}

describe('F1: worktree folder deleted / replaced at the same path', { timeout: 20_000 }, () => {
  it('reports degraded watching after the root is deleted and re-subscribes on the next sync', async () => {
    const layout = await makeLayout();
    const { watcher, rec } = makeWatcher();
    await watcher.setProject('p1', layout.common, layout.worktrees);
    expect(watcher.status()).toEqual({ mode: 'native', warnings: [] });

    // `git worktree remove --force wt && git worktree add wt` as seen by the file system.
    await rm(layout.linked, { recursive: true, force: true });
    if (process.platform === 'darwin') {
      // FSEvents coalesces an immediate re-create with the delete into an `update` of the root
      // and keeps watching the path (nothing to heal; the relist sees the new inode, as in the
      // next test). Let the delete arrive first to exercise the same degraded path as inotify.
      await eventually(() => rec.lists.some((l) => l.reason === 'missing'), 5000);
    }
    await mkdir(path.join(layout.linked, 'src'), { recursive: true });
    await eventually(() => rec.lists.some((l) => l.reason === 'missing'), 5000);
    expect(rec.replaced).toEqual(['linked']); // DaemonCore re-checks the watch targets
    const degraded = watcher.status();
    expect(degraded.mode).toBe('mixed');
    expect(degraded.warnings.join('\n')).toMatch(/do not exist/);
    expect(watcher.pollIntervalFor('linked')).toBe(60_000); // degraded: focused-rate polling

    // The relist that follows keeps the same id (same path): the watcher must re-subscribe.
    await watcher.setProject('p1', layout.common, layout.worktrees);
    expect(watcher.status()).toEqual({ mode: 'native', warnings: [] });
    await eventually(() => rec.dirty.some((d) => d.id === 'linked'), 5000); // catch-up refresh
    await sleep(300);
    const mark = rec.dirty.length;
    await writeFile(path.join(layout.linked, 'src', 'agent.ts'), 'edited after recycle');
    await eventually(() => idsOf(rec, mark).includes('linked'), 5000);
  });

  it('re-subscribes when the root was replaced without a delete event (inode changed)', async () => {
    const layout = await makeLayout();
    // Drop root delete events, as on backends that do not report them.
    const t = tracking((dir, e) => e.path !== dir);
    const { watcher, rec } = makeWatcher({ subscribe: t.subscribe });
    await watcher.setProject('p1', layout.common, layout.worktrees);
    const before = t.subscribed.filter((d) => d === layout.linked).length;

    await rename(layout.linked, `${layout.linked}-old`);
    await mkdir(path.join(layout.linked, 'src'), { recursive: true });
    await watcher.setProject('p1', layout.common, layout.worktrees);
    expect(t.subscribed.filter((d) => d === layout.linked).length).toBe(before + 1);
    expect(t.active).toBe(3);
    expect(rec.replaced).toEqual(['linked']);
    await sleep(300);
    const mark = rec.dirty.length;
    await writeFile(path.join(layout.linked, 'src', 'x.ts'), 'x');
    await eventually(() => idsOf(rec, mark).includes('linked'), 5000);
  });

  it('routes a new admin dir behind the same folder to it and refreshes it', async () => {
    const layout = await makeLayout();
    const t = tracking();
    const { watcher, rec } = makeWatcher({ subscribe: t.subscribe });
    await watcher.setProject('p1', layout.common, layout.worktrees);
    const newGitDir = path.join(layout.common, 'worktrees', 'wt1');
    await mkdir(newGitDir, { recursive: true });
    await sleep(300);
    const mark = rec.dirty.length;
    const linkedWt = {
      ...layout.linkedWt,
      targets: targetsFor(layout.common, newGitDir, layout.linked),
    };
    await watcher.setProject('p1', layout.common, [layout.mainWt, linkedWt]);
    // The folder's subscription does not depend on the git dir: refresh, no re-subscribe.
    expect(t.subscribed.filter((d) => d === layout.linked)).toHaveLength(1);
    await eventually(() => rec.dirty.slice(mark).some((d) => d.id === 'linked'), 5000);
    await sleep(300);
    // Index changes of the new admin dir now route to the linked worktree only.
    const mark2 = rec.dirty.length;
    await writeFile(path.join(newGitDir, 'index'), 'x');
    await eventually(() => rec.dirty.length > mark2, 5000);
    await sleep(250);
    expect(idsOf(rec, mark2)).toEqual(['linked']);
  });

  it('heals on the fallback poll when the folder comes back without a relist', async () => {
    const layout = await makeLayout();
    const { watcher, rec } = makeWatcher({ pollFocusedMs: 200 });
    await watcher.setProject('p1', layout.common, layout.worktrees);
    await rm(layout.linked, { recursive: true, force: true });
    await eventually(() => watcher.status().mode === 'mixed', 5000);
    await mkdir(path.join(layout.linked, 'src'), { recursive: true });
    await eventually(() => watcher.status().mode === 'native', 5000);
    await sleep(200);
    const mark = rec.dirty.length;
    await writeFile(path.join(layout.linked, 'src', 'back.ts'), 'x');
    await eventually(
      () => rec.dirty.slice(mark).some((d) => d.id === 'linked' && d.reason === 'fs'),
      5000,
    );
  });

  it('re-subscribes a git dir that was deleted and re-created (re-clone at the same path)', async () => {
    const layout = await makeLayout();
    const { watcher, rec } = makeWatcher();
    await watcher.setProject('p1', layout.common, layout.worktrees);
    await rm(layout.common, { recursive: true, force: true });
    await eventually(() => rec.lists.some((l) => l.reason === 'missing'), 5000);
    expect(watcher.status().mode).toBe('polling');
    await mkdir(path.join(layout.common, 'refs', 'heads'), { recursive: true });
    await mkdir(layout.linkedGitDir, { recursive: true });
    await watcher.setProject('p1', layout.common, layout.worktrees);
    expect(watcher.status().mode).toBe('native');
    await sleep(300);
    const mark = rec.dirty.length;
    await writeFile(path.join(layout.common, 'refs', 'heads', 'main'), 'abc');
    await eventually(() => idsOf(rec, mark).length === 2, 5000);
  });
});

describe('F3: submodules', { timeout: 20_000 }, () => {
  it("routes the main worktree's submodule git dirs (HEAD, refs) to it, not objects", async () => {
    const layout = await makeLayout();
    const modDir = path.join(layout.common, 'modules', 'lib');
    await mkdir(path.join(modDir, 'refs', 'heads'), { recursive: true });
    await mkdir(path.join(modDir, 'objects', 'ab'), { recursive: true });
    const linkedMod = path.join(layout.linkedGitDir, 'modules', 'lib');
    await mkdir(path.join(linkedMod, 'objects', 'cd'), { recursive: true });
    const { watcher, rec } = makeWatcher();
    await watcher.setProject('p1', layout.common, layout.worktrees);
    // FSEvents (macOS) replays the directories created just before subscribing: let them settle.
    await sleep(300);
    const start = rec.dirty.length;

    await writeFile(path.join(modDir, 'objects', 'ab', 'cdef'), 'x');
    await writeFile(path.join(linkedMod, 'objects', 'cd', 'ef01'), 'x');
    await sleep(500);
    expect(rec.dirty.slice(start)).toEqual([]);

    await writeFile(path.join(modDir, 'refs', 'heads', 'main'), 'c2'); // commit inside the submodule
    await eventually(() => rec.dirty.length > start, 5000);
    await sleep(250);
    expect(idsOf(rec, start)).toEqual(['main']);
    expect(rec.dirty[start]?.reason).toBe('git');

    const mark = rec.dirty.length;
    await writeFile(path.join(linkedMod, 'HEAD'), 'c3'); // the linked worktree's submodule
    await eventually(() => rec.dirty.length > mark, 5000);
    await sleep(250);
    expect(idsOf(rec, mark)).toEqual(['linked']);
  });

  it('a nested registered project (submodule) also refreshes the worktree that contains it', async () => {
    const layout = await makeLayout();
    const subRoot = path.join(layout.main, 'lib');
    const subGitDir = path.join(layout.common, 'modules', 'lib');
    await mkdir(subRoot, { recursive: true });
    await mkdir(path.join(subGitDir, 'refs', 'heads'), { recursive: true });
    const { watcher, rec } = makeWatcher();
    await watcher.setProject('p1', layout.common, layout.worktrees);
    await watcher.setProject('p2', subGitDir, [
      {
        projectId: 'p2',
        worktreeId: 'sub',
        root: subRoot,
        bare: false,
        isMain: true,
        targets: targetsFor(subGitDir, subGitDir, subRoot),
      },
    ]);

    await writeFile(path.join(subRoot, 'a.txt'), 'edited inside the submodule');
    await eventually(() => idsOf(rec).length === 2, 5000);
    expect(idsOf(rec)).toEqual(['main', 'sub']);

    await sleep(300);
    const mark = rec.dirty.length;
    await writeFile(path.join(subGitDir, 'HEAD'), 'ref: refs/heads/other'); // checkout in sub
    await eventually(() => idsOf(rec, mark).length === 2, 5000);
    expect(idsOf(rec, mark)).toEqual(['main', 'sub']);
  });
});

describe('F5: build-output directories', { timeout: 20_000 }, () => {
  type Layout = Awaited<ReturnType<typeof makeLayout>>;

  /** The watcher's debounce in these tests (`makeWatcher`). */
  const DEBOUNCE_MS = 150;

  async function layoutWith(files: Record<string, string>) {
    const layout = await makeLayout();
    // `app/build/` is ignored by a nested `.gitignore` in every layout (and by no root rule of
    // these tests): the watcher still gets its events but drops them without refreshing, which
    // makes it a quiet barrier (below). `app/out/` is the nested rule that the tests probe.
    for (const [rel, content] of Object.entries({ 'app/.gitignore': '/out\n/build\n', ...files })) {
      const file = path.join(layout.main, rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    // Created before subscribing, never during a test: inotify can miss a file written into a
    // directory in the instant it appears (the new directory is not watched yet).
    await mkdir(path.join(layout.main, 'app', 'build'), { recursive: true });
    return layout;
  }

  /** What FSEvents replays on macOS: the fixture files that are not build directories. */
  function replayOf(layout: Layout): ReplayOptions {
    const main = (rel: string): parcelWatcher.Event => ({
      type: 'create',
      path: path.join(layout.main, rel),
    });
    return {
      // Longer than the 300 ms the test used to wait, so a fixed wait cannot pass by luck.
      delayMs: 600,
      events: (dir) => {
        if (dir === layout.main) {
          return [main('.gitignore'), main('app/.gitignore'), main('tools/build/run.sh')];
        }
        if (dir === layout.common) {
          return [{ type: 'update', path: path.join(layout.common, 'info', 'exclude') }];
        }
        return [];
      },
    };
  }

  /**
   * Probes whether a write under the main worktree marks it dirty, without guessing how long
   * the file system takes to report things.
   *
   * Flaky on macOS CI (#65): FSEvents replays what happened just before the subscription (the
   * fixture files, the `.gitignore` and `info/exclude` writes) some hundreds of ms late, and a
   * fixed `sleep(300)` let a replayed `.gitignore` event mark the worktree dirty inside the
   * probe's window. Both ways are ordered by the stream instead: a replay comes before any event
   * of a write made after subscribing, so once a later write has come back, the replay is over.
   *
   * - `settle()` (after every subscription) writes a file into each stream and waits until
   *   the watcher has seen them, then lets the debounce timers of the replayed events run out
   *   (the timer set by an earlier event always expires before a later `sleep` of ours).
   * - `changed()` writes the probe, then the quiet barrier: a write under `app/build/`, which the
   *   watcher receives but drops, so it never makes the worktree dirty by itself. Once the
   *   barrier has come back, the probe has been handled (kept: a refresh is pending; dropped:
   *   nothing is), and one more debounce tells which.
   */
  function probe(layout: Layout, rec: Recorder, t: ReturnType<typeof tracking>) {
    let n = 0;
    const landed = (from: number, file: string) => t.raw.slice(from).some((e) => e.path === file);
    const quiet = () => path.join(layout.main, 'app', 'build', `.barrier-${++n}`);
    const write = async (file: string) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${Date.now()} ${n}`);
    };
    const drained = () => sleep(DEBOUNCE_MS + 50);
    return {
      async settle(): Promise<void> {
        const from = t.raw.length;
        const files = [
          path.join(layout.main, 'src', `.settle-${++n}`), // the worktree stream, refreshes
          quiet(), // the worktree stream, dropped: also warms the nested .gitignore cache
          path.join(layout.common, 'HEAD'), // the git dir stream, refreshes
        ];
        for (const file of files) await write(file);
        await eventually(() => files.every((f) => landed(from, f)), 10_000);
        await drained();
      },
      async changed(rel: string): Promise<boolean> {
        const mark = rec.dirty.length;
        const from = t.raw.length;
        const barrier = quiet();
        await write(path.join(layout.main, rel));
        await write(barrier);
        await eventually(() => landed(from, barrier), 10_000);
        await drained();
        return rec.dirty.slice(mark).some((d) => d.id === 'main');
      },
    };
  }

  async function started(
    layout: Layout,
    replay: boolean,
    extra: Partial<WatcherServiceOptions> = {},
  ) {
    const t = tracking(undefined, replay ? { replay: replayOf(layout) } : {});
    const { watcher, rec } = makeWatcher({ subscribe: t.subscribe, ...extra });
    await watcher.setProject('p1', layout.common, layout.worktrees);
    const p = probe(layout, rec, t);
    await p.settle();
    return { t, watcher, rec, ...p };
  }

  it('watches tracked dist/ and tools/build/ when git does not ignore them', async () => {
    const layout = await layoutWith({ 'dist/index.js': 'v1', 'tools/build/run.sh': 'v1' });
    const { changed } = await started(layout, false);
    expect(await changed('dist/index.js')).toBe(true);
    expect(await changed('tools/build/run.sh')).toBe(true);
  });

  for (const replay of [false, true]) {
    const variant = replay ? ' (FSEvents replays the fixture late)' : '';

    it(`skips build directories that .gitignore / info/exclude ignore, and only those${variant}`, async () => {
      const layout = await layoutWith({
        '.gitignore': 'node_modules\ndist/\n/build\n',
        'dist/index.js': 'x',
        'packages/a/dist/index.js': 'x',
        'build/out.o': 'x',
        'tools/build/run.sh': 'x',
        'target/debug/app': 'x',
        'app/out/bundle.js': 'x',
        'lib/out/keep.js': 'x',
      });
      await writeFile(path.join(layout.common, 'info', 'exclude'), 'target/\n');
      const { changed } = await started(layout, replay);
      expect(await changed('dist/index.js')).toBe(false);
      expect(await changed('packages/a/dist/index.js')).toBe(false);
      expect(await changed('build/out.o')).toBe(false);
      expect(await changed('target/debug/app')).toBe(false);
      expect(await changed('tools/build/run.sh')).toBe(true);
      // Nested .gitignore: dropped by the event filter (the directory itself is watched).
      expect(await changed('app/out/bundle.js')).toBe(false);
      expect(await changed('lib/out/keep.js')).toBe(true);
      expect(await changed('src/a.ts')).toBe(true);
    });
  }

  it('keeps watching a build directory re-included by a negation', async () => {
    const layout = await layoutWith({
      '.gitignore': 'dist/*\n!dist/action.js\n',
      'dist/action.js': 'x',
    });
    const { changed } = await started(layout, false);
    expect(await changed('dist/action.js')).toBe(true);
  });

  for (const replay of [false, true]) {
    const variant = replay ? ' (FSEvents replays the fixture late)' : '';

    it(`re-subscribes when the root .gitignore or info/exclude changes${variant}`, async () => {
      const layout = await layoutWith({ 'out/a.js': 'x', 'coverage/lcov.info': 'x' });
      const { t, changed, settle } = await started(layout, replay);
      const subscriptions = () => t.subscribed.filter((d) => d === layout.main).length;
      expect(await changed('out/a.js')).toBe(true);
      await writeFile(path.join(layout.main, '.gitignore'), 'out/\n');
      await eventually(() => subscriptions() === 2, 5000);
      await settle();
      expect(await changed('out/a.js')).toBe(false);

      expect(await changed('coverage/lcov.info')).toBe(true);
      await writeFile(path.join(layout.common, 'info', 'exclude'), 'coverage\n');
      await eventually(() => subscriptions() === 3, 5000);
      await settle();
      expect(await changed('coverage/lcov.info')).toBe(false);
    });
  }

  it('watches an ignored build directory once a file list shows tracked files in it', async () => {
    const layout = await layoutWith({
      '.gitignore': 'dist\n',
      'dist/index.js': 'force-added',
      'pkg/dist/bundle.js': 'really ignored',
    });
    const { t, watcher, changed, settle } = await started(layout, false);
    expect(await changed('dist/index.js')).toBe(false);
    watcher.noteTrackedPaths('main', ['src/a.ts', 'dist/index.js']);
    await eventually(() => t.subscribed.filter((d) => d === layout.main).length === 2, 5000);
    await settle();
    expect(await changed('dist/index.js')).toBe(true);
    // Other dist directories stay filtered (the root rule still ignores them).
    expect(await changed('pkg/dist/bundle.js')).toBe(false);
  });

  it('parses only rules that ignore a whole build directory', () => {
    const rules = parseBuildDirRules([
      [
        '# comment',
        'dist/',
        '**/coverage',
        '/build',
        'app/target/',
        'out/**',
        '*.js',
        'build.gradle',
        'docs/**/out',
        '\\#not-a-comment',
        '',
      ].join('\n'),
    ]);
    expect([...rules.anyDepth].sort()).toEqual(['coverage', 'dist']);
    expect([...rules.dirs].sort()).toEqual(['app/target', 'build', 'out']);
    const negated = parseBuildDirRules(['dist\n/build\n', '!build/keep.txt\n']);
    expect([...negated.anyDepth]).toEqual(['dist']);
    expect([...negated.dirs]).toEqual([]);
  });
});

describe('F6: info/ in the common git dir', () => {
  it('refreshes every worktree when info/exclude or info/attributes changes', async () => {
    const layout = await makeLayout();
    const { watcher, rec } = makeWatcher();
    await watcher.setProject('p1', layout.common, layout.worktrees);
    await writeFile(path.join(layout.common, 'info', 'exclude'), 'junk.log\n');
    await eventually(() => idsOf(rec).length === 2, 5000);
    expect(rec.dirty.every((d) => d.reason === 'git')).toBe(true);
    await sleep(300);
    const mark = rec.dirty.length;
    await writeFile(path.join(layout.common, 'info', 'attributes'), '*.bin binary\n');
    await eventually(() => idsOf(rec, mark).length === 2, 5000);
  });
});

describe('SEC-07: what one project can make the daemon watch', () => {
  it('refuses the filesystem root, the home directory and folders containing the git dir', async () => {
    const layout = await makeLayout();
    const home = path.join(layout.base, 'home');
    await mkdir(home, { recursive: true });
    const t = tracking();
    const { watcher } = makeWatcher({
      subscribe: t.subscribe,
      guardDirs: { home, tmp: null },
      pollFocusedMs: 1000,
      pollIdleMs: 60_000,
    });
    const forged = (id: string, root: string) => ({ ...layout.linkedWt, worktreeId: id, root });
    await watcher.setProject('p1', layout.common, [
      layout.mainWt,
      layout.linkedWt,
      forged('root', '/'),
      forged('home', home),
      forged('container', layout.base), // contains the repository's .git
    ]);
    expect(t.subscribed.sort()).toEqual([layout.common, layout.linked, layout.main].sort());
    const status = watcher.status();
    expect(status.mode).toBe('mixed');
    expect(status.warnings).toHaveLength(1);
    expect(status.warnings[0]).toMatch(/Not watching 3 worktree folder\(s\)/);
    expect(status.warnings[0]).toMatch(/home directory/);
    expect(status.warnings[0]).toMatch(/filesystem root/);
    expect(status.warnings[0]).not.toContain(home);
    // Refused folders are polled at the idle rate, not the degraded one.
    expect(watcher.pollIntervalFor('home')).toBe(60_000);
    expect(watcher.isWatched('home')).toBe(true);
  });

  it('caps natively watched worktrees per project and promotes polled ones when room frees up', async () => {
    const layout = await makeLayout();
    const extra: WatchedWorktree[] = [];
    for (const name of ['a', 'b', 'c']) {
      const root = path.join(layout.base, `repo-${name}`);
      await mkdir(root, { recursive: true });
      extra.push({ ...layout.linkedWt, worktreeId: name, root });
    }
    const t = tracking();
    const { watcher } = makeWatcher({ subscribe: t.subscribe, maxWorktreesPerProject: 2 });
    await watcher.setProject('p1', layout.common, [...extra, layout.mainWt, layout.linkedWt]);
    // Main first, then the given order.
    expect(t.subscribed.filter((d) => d !== layout.common).sort()).toEqual(
      [layout.main, extra[0]?.root].sort(),
    );
    const status = watcher.status();
    expect(status.mode).toBe('mixed');
    expect(status.warnings.join('\n')).toMatch(/3 worktree\(s\) are beyond the limit of 2/);

    // A new worktree never evicts a watched one; removing one promotes the next.
    await watcher.setProject('p1', layout.common, [layout.mainWt, ...extra.slice(1)]);
    expect(t.active).toBe(3); // git dir + main + b
    expect(t.subscribed).toContain(extra[1]?.root);
    expect(watcher.status().warnings.join('\n')).toMatch(/1 worktree\(s\) are beyond the limit/);
  });

  it('does not watch a git dir that is too broad', async () => {
    const layout = await makeLayout();
    const t = tracking();
    const { watcher } = makeWatcher({
      subscribe: t.subscribe,
      guardDirs: { home: layout.common, tmp: null },
    });
    await watcher.setProject('p1', layout.common, [layout.linkedWt]);
    expect(t.subscribed).toEqual([layout.linked]);
    const status = watcher.status();
    expect(status.mode).toBe('polling');
    expect(status.warnings.join('\n')).toMatch(/Not watching the git dir of 1 project/);
  });

  it('classifies refused folders', () => {
    const dirs = { home: '/home/u', tmp: '/tmp' };
    expect(dirRefusal('/', dirs)).toBe('filesystem-root');
    expect(dirRefusal('/home/u', dirs)).toBe('home');
    expect(dirRefusal('/home', dirs)).toBe('home');
    expect(dirRefusal('/usr', dirs)).toBe('system-dir');
    expect(dirRefusal('/tmp', dirs)).toBe('system-dir');
    expect(dirRefusal('/mnt/c', dirs)).toBe('system-dir');
    expect(dirRefusal('/home/u/code/repo', dirs)).toBeNull();
    expect(dirRefusal('/tmp/octopus-diff-x/repo', dirs)).toBeNull();
    expect(dirRefusal('/workspace', dirs)).toBeNull();
    const ctx = (isMain: boolean) => ({ commonDir: '/home/u/code/r/.git', isMain });
    expect(worktreeRootRefusal('/home/u/code/r', ctx(true), dirs)).toBeNull();
    expect(worktreeRootRefusal('/home/u/code/r', ctx(false), dirs)).toBe('contains-git-dir');
    expect(worktreeRootRefusal('/home/u/code', ctx(true), dirs)).toBe('contains-git-dir');
    expect(worktreeRootRefusal('/home/u/code/r-wt', ctx(false), dirs)).toBeNull();
    const sub = { commonDir: '/home/u/code/r/.git/modules/lib', isMain: true };
    expect(worktreeRootRefusal('/home/u/code/r/lib', sub, dirs)).toBeNull();
  });
});
