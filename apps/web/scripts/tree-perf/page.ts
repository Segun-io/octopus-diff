/**
 * The tree bench page (dev only, #9): renders `@pierre/trees` with the 100k-path layout of the
 * large fixture (`largeFilePath`, tools/fixtures/src/large.ts) in two designs and measures it.
 * Driven by `../tree-perf.ts` through `window.treeBench`; never part of the app bundle.
 *
 * - `full`: every path at once (`paths`), as `FileTreeView` feeds changed files today.
 * - `lazy`: the root listing only (`GET /tree` of `''`), then each expanded directory's listing
 *   added with one `batch` of adds (what `useTree` + a tree component would do).
 */
import { FileTree, type GitStatusEntry, preparePresortedFileTreeInput } from '@pierre/trees';

/** Path of tracked file `i` (a copy of `largeFilePath` in tools/fixtures: 8 × 10 × 10 × 5 × 25). */
function largeFilePath(i: number): string {
  const d = i % 125;
  const rest = Math.floor(i / 125);
  const c = rest % 10;
  const b = Math.floor(rest / 10) % 10;
  const a = Math.floor(rest / 100);
  return `apps/app${a % 8}/packages/pkg${b}/src/mod${c}/sub${Math.floor(d / 25)}/file_${a}_${d}.ts`;
}

function allPaths(n: number): string[] {
  const out = new Array<string>(n);
  for (let i = 0; i < n; i++) out[i] = largeFilePath(i);
  return out;
}

/** One directory's listing (what `GET /tree` answers), as tree paths: `dir/` for a directory. */
function childrenIndex(paths: readonly string[]): Map<string, string[]> {
  const index = new Map<string, Set<string>>();
  for (const p of paths) {
    const parts = p.split('/');
    let dir = '';
    for (let i = 0; i < parts.length; i++) {
      const isDir = i < parts.length - 1;
      const child = `${dir}${parts[i]}${isDir ? '/' : ''}`;
      let set = index.get(dir);
      if (!set) {
        set = new Set();
        index.set(dir, set);
      }
      set.add(child);
      if (!isDir) break;
      dir = child;
    }
  }
  const out = new Map<string, string[]>();
  for (const [k, v] of index) out.set(k, [...v].sort());
  return out;
}

const frame = () => new Promise<number>((r) => requestAnimationFrame(() => r(performance.now())));
const painted = async () => {
  await frame();
  return frame();
};

let tree: FileTree | null = null;

function mount(): HTMLElement {
  const el = document.getElementById('mount');
  if (!el) throw new Error('no #mount');
  return el;
}

/** The tree's scroll container, inside its shadow root; null when nothing overflows. */
function scroller(): HTMLElement | null {
  const host = [...mount().querySelectorAll('*')].find((e) => e.shadowRoot) as
    | HTMLElement
    | undefined;
  const root = host?.shadowRoot;
  if (!root) throw new Error('no shadow root');
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    const style = getComputedStyle(el);
    if (
      (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
      el.scrollHeight > el.clientHeight + 10
    ) {
      return el;
    }
  }
  return null;
}

function mountedRows(): number {
  const host = [...mount().querySelectorAll('*')].find((e) => e.shadowRoot) as
    | HTMLElement
    | undefined;
  return host?.shadowRoot?.querySelectorAll('[role="treeitem"]').length ?? 0;
}

function reset(): void {
  tree?.cleanUp();
  tree = null;
  mount().replaceChildren();
}

interface FullOptions {
  count: number;
  expansion: 'open' | 'closed';
  prepared?: boolean;
  /** Paths with a git status (the first N), as a working tree's changes. */
  statuses?: number;
}

async function full(options: FullOptions) {
  reset();
  const paths = allPaths(options.count);
  const gitStatus: GitStatusEntry[] = paths
    .slice(0, options.statuses ?? 0)
    .map((path) => ({ path, status: 'modified' }));
  await painted();
  const t0 = performance.now();
  const input = options.prepared ? preparePresortedFileTreeInput([...paths].sort()) : null;
  const t1 = performance.now();
  tree = new FileTree({
    ...(input ? { preparedInput: input } : { paths }),
    initialExpansion: options.expansion,
    flattenEmptyDirectories: true,
    ...(gitStatus.length ? { gitStatus } : {}),
  });
  const t2 = performance.now();
  tree.render({ containerWrapper: mount() });
  const t3 = performance.now();
  const t4 = await painted();
  return {
    prepareMs: t1 - t0,
    modelMs: t2 - t1,
    renderMs: t3 - t2,
    toPaintMs: t4 - t0,
    visibleRows: tree.getVisibleCount(),
    mountedRows: mountedRows(),
  };
}

/** Lazy: the root listing, then `opens` directories along the tree, one listing at a time. */
async function lazy(options: { count: number; opens: number }) {
  reset();
  const index = childrenIndex(allPaths(options.count));
  await painted();
  const t0 = performance.now();
  tree = new FileTree({ paths: index.get('') ?? [], initialExpansion: 'closed' });
  tree.render({ containerWrapper: mount() });
  const firstPaint = (await painted()) - t0;
  const opens: number[] = [];
  /** The synchronous part of each open: the batch of adds and the expand (no frame wait). */
  const opensSync: number[] = [];
  const queue = [...(index.get('') ?? [])].filter((p) => p.endsWith('/'));
  let added = (index.get('') ?? []).length;
  while (opens.length < options.opens && queue.length > 0) {
    const dir = queue.shift() as string;
    const children = index.get(dir) ?? [];
    const s = performance.now();
    tree.batch(children.map((path) => ({ type: 'add' as const, path })));
    const item = tree.getItem(dir);
    if (item && 'expand' in item) item.expand();
    opensSync.push(performance.now() - s);
    await painted();
    opens.push(performance.now() - s);
    added += children.length;
    queue.push(...children.filter((p) => p.endsWith('/')));
  }
  return {
    firstPaintMs: firstPaint,
    opens,
    opensSync,
    loadedPaths: added,
    visibleRows: tree.getVisibleCount(),
  };
}

/** Scrolls the mounted tree by `step` px per frame, `steps` times (or to the end); frame times. */
async function scroll(options: { step: number; steps: number }) {
  const el = scroller();
  if (!el) {
    const none: number[] = [];
    return { frames: none, jumps: none, longTasks: none, height: 0, mountedRows: mountedRows() };
  }
  el.scrollTop = 0;
  await painted();
  const frames: number[] = [];
  const since = performance.now();
  let last = since;
  for (let i = 0; i < options.steps && el.scrollTop + el.clientHeight < el.scrollHeight - 1; i++) {
    el.scrollTop += options.step;
    const t = await frame();
    frames.push(t - last);
    last = t;
  }
  // Long jumps: the middle and the end of the list.
  const jumps: number[] = [];
  for (const at of [0.5, 1, 0.25]) {
    const s = performance.now();
    el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) * at);
    jumps.push((await painted()) - s);
  }
  const longTasks = window.__longTasks.filter((t) => t.start >= since).map((t) => t.duration);
  return { frames, jumps, longTasks, height: el.scrollHeight, mountedRows: mountedRows() };
}

declare global {
  interface Window {
    treeBench: { full: typeof full; lazy: typeof lazy; scroll: typeof scroll; reset: typeof reset };
    __longTasks: { start: number; duration: number }[];
  }
}

window.treeBench = { full, lazy, scroll, reset };
document.body.dataset.ready = '1';
