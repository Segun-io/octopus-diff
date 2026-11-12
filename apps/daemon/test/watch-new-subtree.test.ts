import { mkdirSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WatchTargets } from '@octopus-diff/contracts';
import { noopLogger } from '@octopus-diff/contracts';
import parcelWatcher from '@parcel/watcher';
import { describe, expect, it } from 'vitest';
import {
  burstThreshold,
  findUnwatchedSubdir,
  isIgnoredGitDirChild,
  ResubscribeGate,
} from '../src/watch-subtree.js';
import { type DirtyReason, type SubscribeFn, WatcherService } from '../src/watcher.js';
import { eventually, onCleanup, sleep, tempDir } from './helpers.js';

/**
 * Issue #36 (DECISIONS #213): `@parcel/watcher`'s inotify backend watches a directory that appears,
 * for that directory only. A subdirectory that already exists by then (`mkdir -p a/b/c`) is never
 * watched: the stream reports `create a` and nothing else, ever. These tests run the real
 * `@parcel/watcher` on temp directories through the `subscribe` seam. They wait on the event
 * stream and on real conditions (deadlines), never on fixed sleeps, except for the one negative
 * check that has no event to wait for (marked below).
 */

interface RawEvent {
  type: string;
  path: string;
  at: number;
}

interface Check {
  target: 'worktree' | 'git';
  inspected: number;
  reason: string | null;
}

async function makeLayout() {
  const base = await tempDir();
  const root = path.join(base, 'repo');
  const common = path.join(root, '.git');
  await mkdir(path.join(common, 'refs', 'heads'), { recursive: true });
  await mkdir(path.join(common, 'info'), { recursive: true });
  await mkdir(path.join(root, 'src'), { recursive: true });
  const targets: WatchTargets = {
    worktreeRoot: root,
    gitDir: common,
    commonDir: common,
    gitPaths: [
      path.join(common, 'HEAD'),
      path.join(common, 'index'),
      path.join(common, 'refs'),
      path.join(common, 'packed-refs'),
      path.join(common, 'worktrees'),
      path.join(common, 'config'),
      path.join(common, 'info', 'exclude'),
    ],
  };
  const worktree = {
    projectId: 'p1',
    worktreeId: 'main',
    root,
    bare: false,
    isMain: true,
    targets,
  };
  return { base, root, common, worktree };
}

function setup() {
  const dirty: Array<{ id: string; reason: DirtyReason; at: number }> = [];
  const checks: Check[] = [];
  /** Every event handed to the watcher, per directory. */
  const raw: Array<RawEvent & { dir: string }> = [];
  /** Completed subscriptions per directory. */
  const subscribed: string[] = [];
  const callbacks = new Map<string, parcelWatcher.SubscribeCallback>();
  const subscribe: SubscribeFn = async (dir, fn, opts) => {
    const deliver: parcelWatcher.SubscribeCallback = (error, events) => {
      // Recorded before the watcher handles them: ordered by the stream.
      for (const e of events) raw.push({ dir, type: e.type, path: e.path, at: Date.now() });
      fn(error, events);
    };
    const sub = await parcelWatcher.subscribe(dir, deliver, opts);
    callbacks.set(dir, deliver);
    subscribed.push(dir);
    return sub;
  };
  const watcher = new WatcherService({
    logger: noopLogger,
    debounceMs: 150,
    pollFocusedMs: 600_000,
    pollIdleMs: 600_000,
    relistMs: 600_000,
    guardDirs: { home: null, tmp: null },
    subscribe,
    // The behaviour under test, forced on every platform (it defaults to Linux only).
    watchNewSubtrees: true,
    newSubtreeGapMs: 50,
    onWorktreeDirty: (id, reason) => dirty.push({ id, reason, at: Date.now() }),
    onWorktreeListDirty: () => {},
    onSubtreeCheck: (info) =>
      checks.push({ target: info.target, inspected: info.inspected, reason: info.reason }),
  });
  onCleanup(() => watcher.close());
  const count = (dir: string) => subscribed.filter((d) => d === dir).length;
  /** Waits until the watcher was handed an event for `file` (after `from`, an index into `raw`). */
  const seen = (file: string, from = 0) =>
    eventually(() => raw.slice(from).find((e) => e.path === file), 10_000);
  /**
   * Writes a new file into `dir` every 50 ms until the watcher is handed an event for one of
   * them. A write made before the tree is subscribed again is not reported, so the loop is the
   * real condition: the first event proves that `dir` is watched.
   */
  const writesUntilSeen = (dir: string) => {
    let n = 0;
    return eventually(
      async () => {
        await writeFile(path.join(dir, `probe-${n++}.txt`), 'x');
        return raw.find(
          (e) => path.dirname(e.path) === dir && path.basename(e.path).startsWith('probe-'),
        );
      },
      10_000,
      50,
    );
  };
  return { watcher, dirty, checks, raw, subscribed, callbacks, count, seen, writesUntilSeen };
}

describe('new directories with subdirectories (issue #36)', { timeout: 30_000 }, () => {
  it('watches a nested directory created in one go, and reports a write inside it', async () => {
    const layout = await makeLayout();
    const t = setup();
    await t.watcher.setProject('p1', layout.common, [layout.worktree]);
    expect(t.count(layout.root)).toBe(1);

    // `mkdir -p vendor-x/pkg/deep`: the watcher reports `create vendor-x` and nothing below it.
    const deep = path.join(layout.root, 'vendor-x', 'pkg', 'deep');
    mkdirSync(deep, { recursive: true });
    // A write at the bottom is reported once the tree is watched (before the fix: never)...
    const event = await t.writesUntilSeen(deep);
    // ...and refreshes the worktree.
    await eventually(() => t.dirty.some((d) => d.id === 'main' && d.at >= event.at), 10_000);
    expect(t.count(layout.root)).toBeGreaterThanOrEqual(1);
    expect(t.watcher.status().mode).toBe('native');
  });

  it.each([
    ['a plain name', 'lib/pkg/deep'],
    ['build', 'build/pkg/deep'],
    ['dist (no rule ignores it, so it is watched)', 'dist/pkg/deep'],
    ['a vendor directory', 'vendor/github.com/acme/pkg'],
    ['out', 'out/a/b/c/d/e/f'],
    ['target', 'target/debug/deps'],
  ])('%s: %s', async (_label, rel) => {
    const layout = await makeLayout();
    const t = setup();
    await t.watcher.setProject('p1', layout.common, [layout.worktree]);
    const bottom = path.join(layout.root, ...rel.split('/'));
    mkdirSync(bottom, { recursive: true });
    await t.writesUntilSeen(bottom);
  });

  it('keeps the files of a big tree visible: writes after thousands of files are reported', async () => {
    const layout = await makeLayout();
    const t = setup();
    await t.watcher.setProject('p1', layout.common, [layout.worktree]);
    const deep = path.join(layout.root, 'vendor-big', 'pkg', 'deep');
    mkdirSync(deep, { recursive: true });
    for (let i = 0; i < 2000; i++) await writeFile(path.join(deep, `f${i}.txt`), 'x');
    const written = Date.now();
    const event = await t.writesUntilSeen(deep);
    await eventually(() => t.dirty.some((d) => d.at >= Math.min(event.at, written)), 10_000);
  });

  it('does not re-subscribe for directories that were reported one by one', async () => {
    const layout = await makeLayout();
    const t = setup();
    await t.watcher.setProject('p1', layout.common, [layout.worktree]);
    // Each directory is created after the watcher reported the previous one: all are watched.
    let from = t.raw.length;
    const a = path.join(layout.root, 'one');
    await mkdir(a);
    await t.seen(a, from);
    from = t.raw.length;
    const b = path.join(a, 'two');
    await mkdir(b);
    await t.seen(b, from);
    from = t.raw.length;
    const c = path.join(b, 'three');
    await mkdir(c);
    await t.seen(c, from);
    // The pass that looks at the last creation has run when it reports (inspected > 0).
    await eventually(
      () => t.checks.some((c) => c.target === 'worktree' && c.inspected > 0),
      10_000,
    );
    await eventually(() => t.checks.length >= 1, 10_000);
    // Negative check: there is no event for "nothing happened", so give a re-subscribe, which
    // would follow a pass at once (gap 50 ms), time to show.
    await sleep(400);
    expect(t.count(layout.root)).toBe(1);
    expect(t.checks.every((c) => c.reason === null)).toBe(true);
  });

  it('ignores subdirectories the watcher skips by design (node_modules, ignored build dirs)', async () => {
    const layout = await makeLayout();
    await writeFile(path.join(layout.root, '.gitignore'), 'dist\n');
    const t = setup();
    await t.watcher.setProject('p1', layout.common, [layout.worktree]);
    // `app` appears with a `node_modules` and a git-ignored `dist` inside: neither is watched
    // (and no one wants them to be), so there is nothing to repair.
    const app = path.join(layout.root, 'app');
    await mkdir(path.join(app, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(path.join(app, 'dist', 'x'), { recursive: true });
    await t.seen(app);
    await eventually(() => t.checks.some((c) => c.inspected > 0), 10_000);
    await sleep(400); // negative check, see above
    expect(t.checks.filter((c) => c.reason !== null)).toEqual([]);
    expect(t.count(layout.root)).toBe(1);
  });

  it('re-subscribes after a burst big enough to overflow the inotify queue', async () => {
    const layout = await makeLayout();
    const t = setup();
    await t.watcher.setProject('p1', layout.common, [layout.worktree]);
    const deliver = t.callbacks.get(layout.root);
    if (!deliver) throw new Error('no subscription');
    // @parcel/watcher skips IN_Q_OVERFLOW silently, so the stream cannot say that events were
    // dropped: a burst this size might have lost the creation of a directory.
    const events: parcelWatcher.Event[] = Array.from({ length: burstThreshold() }, (_, i) => ({
      type: 'create',
      path: path.join(layout.root, 'src', `gone-${i}.txt`),
    }));
    deliver(null, events);
    await eventually(() => t.count(layout.root) >= 2, 10_000);
    expect(t.checks.some((c) => c.target === 'worktree' && c.reason === 'burst')).toBe(true);
  });

  it('git dir: a nested ref directory created in one go is watched (git branch a/b/c)', async () => {
    const layout = await makeLayout();
    const t = setup();
    await t.watcher.setProject('p1', layout.common, [layout.worktree]);
    expect(t.count(layout.common)).toBe(1);
    const dir = path.join(layout.common, 'refs', 'heads', 'feat', 'x');
    mkdirSync(dir, { recursive: true });
    const event = await t.writesUntilSeen(dir);
    await eventually(
      () => t.dirty.some((d) => d.id === 'main' && d.reason === 'git' && d.at >= event.at),
      10_000,
    );
  });

  it('is off when watchNewSubtrees is false', async () => {
    const layout = await makeLayout();
    const dirty: string[] = [];
    const subscribed: string[] = [];
    const subscribe: SubscribeFn = async (dir, fn, opts) => {
      subscribed.push(dir);
      return parcelWatcher.subscribe(dir, fn, opts);
    };
    const watcher = new WatcherService({
      logger: noopLogger,
      debounceMs: 150,
      pollFocusedMs: 600_000,
      pollIdleMs: 600_000,
      relistMs: 600_000,
      guardDirs: { home: null, tmp: null },
      subscribe,
      watchNewSubtrees: false,
      onWorktreeDirty: (id) => dirty.push(id),
      onWorktreeListDirty: () => {},
    });
    onCleanup(() => watcher.close());
    await watcher.setProject('p1', layout.common, [layout.worktree]);
    await mkdir(path.join(layout.root, 'a', 'b'), { recursive: true });
    await eventually(() => dirty.length > 0, 10_000);
    await sleep(500); // negative check: a re-subscribe would be well under this
    expect(subscribed.filter((d) => d === layout.root)).toHaveLength(1);
  });
});

describe('findUnwatchedSubdir', () => {
  it('finds a subdirectory nobody reported, and skips reported, ignored and non-directories', async () => {
    const base = await tempDir();
    const a = path.join(base, 'a');
    const b = path.join(a, 'b');
    await mkdir(b, { recursive: true });
    await mkdir(path.join(a, 'node_modules'), { recursive: true });
    await writeFile(path.join(a, 'file.txt'), 'x');
    await symlink(base, path.join(a, 'link'));
    const never = () => false;
    const nodeModules = (child: string) => child.endsWith('node_modules');
    expect(await findUnwatchedSubdir(new Set([a]), never)).toBe(true);
    // `b` reported in the same pass, `node_modules` ignored, the symlink is not a directory.
    expect(await findUnwatchedSubdir(new Set([a, b]), nodeModules)).toBe(false);
    // `b` reported in the previous pass.
    expect(await findUnwatchedSubdir(new Set([a]), nodeModules, new Set([b]))).toBe(false);
    expect(await findUnwatchedSubdir(new Set([a]), never, new Set([b]))).toBe(true);
    // A created file and a vanished path are nothing to watch.
    const missing = new Set([path.join(a, 'file.txt'), path.join(a, 'gone')]);
    expect(await findUnwatchedSubdir(missing, never)).toBe(false);
  });
});

describe('isIgnoredGitDirChild', () => {
  it('mirrors GIT_DIR_IGNORES', () => {
    const common = '/r/.git';
    const ignored = (rel: string) => isIgnoredGitDirChild(common, path.join(common, rel));
    for (const rel of ['objects', 'logs', 'hooks', 'lfs', 'rr-cache', 'fsmonitor--daemon']) {
      expect(ignored(rel)).toBe(true);
    }
    expect(ignored('worktrees/wt/logs')).toBe(true);
    expect(ignored('modules/sub/objects')).toBe(true);
    expect(ignored('modules/a/b/hooks')).toBe(true);
    expect(ignored('worktrees/wt/modules/sub/logs')).toBe(true);
    for (const rel of [
      'refs',
      'refs/heads/feat',
      'refs/heads/logs',
      'worktrees/wt',
      'modules/sub',
      'info',
    ]) {
      expect(ignored(rel)).toBe(false);
    }
  });
});

describe('ResubscribeGate', () => {
  it('runs one at a time, a gap apart, and coalesces requests made meanwhile', async () => {
    const gate = new ResubscribeGate(150);
    const starts: number[] = [];
    const release: Array<() => void> = [];
    const run = () => {
      starts.push(Date.now());
      return new Promise<void>((resolve) => {
        release.push(resolve);
      });
    };
    gate.request(run);
    gate.request(run); // coalesced with the pending run
    await eventually(() => starts.length === 1, 5000);
    gate.request(run);
    gate.request(run); // both while running: one more run, after the gap
    release[0]?.();
    await eventually(() => starts.length === 2, 5000);
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(140);
    release[1]?.();
    await sleep(300); // negative check: a third run would start within the gap
    expect(starts).toHaveLength(2);
    gate.dispose();
  });
});
