/**
 * #40: the watcher hands the paths its native events named to `onWorktreeDirty`, relative to the
 * worktree and `/`-separated, and null whenever anything else asked for the refresh (focus, a
 * poll, git-dir events, a caller without paths) or there were too many.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WatchTargets } from '@octopus-diff/contracts';
import { noopLogger } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import {
  type DirtyReason,
  MAX_PENDING_PATHS,
  WatcherService,
  type WatcherServiceOptions,
} from '../src/watcher.js';
import { eventually, onCleanup, sleep, tempDir } from './helpers.js';

interface Fired {
  id: string;
  reason: DirtyReason;
  paths: readonly string[] | null;
}

function makeWatcher(overrides: Partial<WatcherServiceOptions> = {}) {
  const fired: Fired[] = [];
  const watcher = new WatcherService({
    logger: noopLogger,
    debounceMs: 150,
    pollFocusedMs: 60_000,
    pollIdleMs: 60_000,
    relistMs: 60_000,
    leadingEdge: false,
    onWorktreeDirty: (id, reason, paths) => fired.push({ id, reason, paths }),
    onWorktreeListDirty: () => {},
    ...overrides,
  });
  onCleanup(() => watcher.close());
  return { watcher, fired };
}

async function layout() {
  const base = await tempDir();
  const main = path.join(base, 'repo');
  const common = path.join(main, '.git');
  await mkdir(path.join(common, 'refs', 'heads'), { recursive: true });
  await mkdir(path.join(main, 'src', 'deep'), { recursive: true });
  await writeFile(path.join(common, 'HEAD'), 'ref: refs/heads/main\n');
  const targets: WatchTargets = {
    worktreeRoot: main,
    gitDir: common,
    commonDir: common,
    gitPaths: [path.join(common, 'HEAD'), path.join(common, 'index'), path.join(common, 'refs')],
  };
  return {
    main,
    common,
    worktrees: [
      { projectId: 'p1', worktreeId: 'main', root: main, bare: false, isMain: true, targets },
    ],
  };
}

const settle = () => sleep(400);

describe('watcher paths (#40)', () => {
  it('passes the files its events named, relative and /-separated', async () => {
    const l = await layout();
    const { watcher, fired } = makeWatcher();
    await watcher.setProject('p1', l.common, l.worktrees);
    // The subscription may not be up yet: write probes until an event for one arrives (the first
    // event proves the tree is watched), then let their refreshes finish before the real writes.
    let n = 0;
    await eventually(
      async () => {
        await writeFile(path.join(l.main, `probe-${n++}.txt`), 'x');
        return fired.some((f) => f.paths?.some((p) => p.startsWith('probe-')));
      },
      10_000,
      50,
    );
    await settle();
    fired.length = 0;
    await writeFile(path.join(l.main, 'a b.txt'), 'x');
    await writeFile(path.join(l.main, 'src', 'deep', 'ünï.ts'), 'y');
    const named = () => new Set(fired.filter((f) => f.id === 'main').flatMap((f) => f.paths ?? []));
    // Wait for each path, not for a fixed time: the two events may fall in different refreshes.
    await eventually(() => named().has('a b.txt') && named().has('src/deep/ünï.ts'), 10_000, 50);
    await settle();
    const all = fired.filter((f) => f.id === 'main');
    expect(all.every((f) => f.reason === 'fs' && f.paths !== null)).toBe(true);
    // Late events for the probes may still trail in; nothing else may be named.
    expect([...named()].filter((p) => !p.startsWith('probe-')).sort()).toEqual([
      'a b.txt',
      'src/deep/ünï.ts',
    ]);
  });

  it('null when focus, a caller without paths or a git-dir event asked too', async () => {
    const l = await layout();
    const { watcher, fired } = makeWatcher();
    await watcher.setProject('p1', l.common, l.worktrees);
    await settle();

    fired.length = 0;
    await writeFile(path.join(l.main, 'a.txt'), 'x');
    watcher.markDirty('main', 'fs');
    await eventually(() => fired.find((f) => f.id === 'main'), 3000);
    await settle();
    expect(fired.filter((f) => f.id === 'main').map((f) => f.paths)).toEqual([null]);

    fired.length = 0;
    await writeFile(path.join(l.common, 'HEAD'), 'ref: refs/heads/other\n');
    await eventually(() => fired.find((f) => f.id === 'main'), 3000);
    expect(fired.find((f) => f.id === 'main')).toMatchObject({ reason: 'git', paths: null });

    await settle();
    fired.length = 0;
    watcher.setFocus('main');
    await eventually(() => fired.find((f) => f.id === 'main'), 3000);
    expect(fired.find((f) => f.id === 'main')).toMatchObject({ reason: 'focus', paths: null });
  });

  it('null after more than MAX_PENDING_PATHS paths in one refresh', async () => {
    const l = await layout();
    const { watcher, fired } = makeWatcher({ debounceMs: 300 });
    await watcher.setProject('p1', l.common, l.worktrees);
    await settle();
    fired.length = 0;
    const many = Array.from({ length: MAX_PENDING_PATHS + 1 }, (_, i) => `f${i}.txt`);
    watcher.markDirty('main', 'fs', many);
    await eventually(() => fired.find((f) => f.id === 'main'), 3000);
    expect(fired.find((f) => f.id === 'main')?.paths).toBeNull();
    fired.length = 0;
    watcher.markDirty('main', 'fs', ['one.txt']);
    await eventually(() => fired.find((f) => f.id === 'main'), 3000);
    expect(fired.find((f) => f.id === 'main')?.paths).toEqual(['one.txt']);
  });
});
