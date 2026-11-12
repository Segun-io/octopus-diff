// @vitest-environment jsdom
/**
 * Merge noise in the web UI (roadmap #34, DECISIONS #205): the files a merge, rebase or update of
 * the default branch brought are wrapped in a collapsed "From <ref>" group, never hidden.
 */
import {
  type ChangedFile,
  createApiClient,
  type DiffScope,
  type ServerEvent,
  TEST_IDS,
  type WorktreeListItem,
} from '@octopus-diff/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { App } from '../src/App.tsx';
import type { EventSourceLike } from '../src/api/hooks.ts';
import { createQueryClient } from '../src/api/queries.ts';
import { ORIGIN_TEST_IDS } from '../src/components/OriginGroupHeader.tsx';
import { planBulk } from '../src/lib/bulk.ts';
import {
  buildSidebar,
  countOwn,
  type FileGroup,
  flattenGroups,
  NO_SIDEBAR_FILTERS,
  nextUnreviewed,
  noiseGroupLabel,
  type OriginView,
  originStats,
  originTag,
  originVisibleIf,
  ownFirst,
  shortRef,
  stepFile,
  viaLabel,
  visibleIf,
} from '../src/lib/model.ts';
import { scopeForPref } from '../src/state/prefs.ts';
import { actions, createUiStore, type UiStore } from '../src/state/ui.tsx';

vi.mock('../src/components/diff/DiffRenderer.tsx', () => ({
  DiffRenderer: ({ patch, mode }: { patch: string; mode: string }) => (
    <pre data-testid="stub-diff" data-mode={mode}>
      {patch}
    </pre>
  ),
}));

// jsdom has no layout: give the virtualized list a viewport tall enough for every row.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 4000,
  });
});

afterEach(() => cleanup());

// --- pure functions ---------------------------------------------------------------------------

function file(path: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    binary: false,
    oldMode: null,
    newMode: null,
    additions: 1,
    deletions: 0,
    patchHash: `hash-${path}`,
    staged: false,
    unstaged: false,
    reviewed: false,
    ...extra,
  };
}

const FILES: ChangedFile[] = [
  file('a-base.ts', { origin: 'base', originVia: 'merge' }),
  file('b-own.ts'),
  file('c-mixed.ts', { origin: 'mixed', originVia: 'merge' }),
  file('d-base.ts', { origin: 'base', originVia: 'same-as-base' }),
  file('e-own.ts'),
];

function groupOf(files: ChangedFile[], id = 'w1'): FileGroup {
  return {
    project: { id: 'p1', name: 'proj' } as FileGroup['project'],
    worktree: { id } as FileGroup['worktree'],
    files,
  };
}

const COLLAPSED: OriginView = { fromMainOnly: false, expanded: new Set() };

describe('merge noise: the model', () => {
  it('lists own and mixed files first, base files last, each in its own order', () => {
    expect(ownFirst(FILES).map((f) => f.path)).toEqual([
      'b-own.ts',
      'c-mixed.ts',
      'e-own.ts',
      'a-base.ts',
      'd-base.ts',
    ]);
    // Nothing to partition: the same files, in the same order.
    const plain = [file('x.ts'), file('y.ts')];
    expect(ownFirst(plain)).toEqual(plain);
  });

  it('counts own + mixed files only', () => {
    expect(countOwn(FILES)).toBe(3);
    expect(countOwn([file('x.ts'), file('y.ts')])).toBe(2);
  });

  it('wraps base files unless their worktree is expanded; the chip lists only them', () => {
    const entries = flattenGroups([groupOf(ownFirst(FILES))]);
    const paths = (v: OriginView) => entries.filter(visibleIf(true, v)).map((e) => e.file.path);
    expect(paths(COLLAPSED)).toEqual(['b-own.ts', 'c-mixed.ts', 'e-own.ts']);
    expect(paths({ fromMainOnly: false, expanded: new Set(['w1']) })).toHaveLength(5);
    expect(paths({ fromMainOnly: false, expanded: new Set(['w2']) })).toHaveLength(3);
    expect(paths({ fromMainOnly: true, expanded: new Set() })).toEqual(['a-base.ts', 'd-base.ts']);
    // Without an origin view (an older caller) nothing is wrapped.
    expect(entries.filter(visibleIf(true))).toHaveLength(5);
  });

  it('j/k skip a collapsed group and reach it once expanded', () => {
    const entries = flattenGroups([groupOf(ownFirst(FILES))]);
    const collapsed = visibleIf(true, COLLAPSED);
    const open = visibleIf(true, { fromMainOnly: false, expanded: new Set(['w1']) });
    const key = (path: string) => entries.find((e) => e.file.path === path)?.key ?? null;
    // From the last own file there is nowhere to go while collapsed...
    expect(stepFile(entries, key('e-own.ts'), 1, collapsed)).toBeNull();
    // ...and once expanded `j` reaches the first base file.
    expect(stepFile(entries, key('e-own.ts'), 1, open)?.file.path).toBe('a-base.ts');
    // `k` from a selection inside the (now collapsed) group goes to the last own file.
    expect(stepFile(entries, key('a-base.ts'), -1, collapsed)?.file.path).toBe('e-own.ts');
    expect(stepFile(entries, key('a-base.ts'), 1, collapsed)?.file.path).toBeUndefined();
    // With nothing selected `k` starts at the last visible file, not at a wrapped one.
    expect(stepFile(entries, null, -1, collapsed)?.file.path).toBe('e-own.ts');
  });

  it('n skips the files of a collapsed group', () => {
    const entries = flattenGroups([groupOf(ownFirst(FILES))]);
    const selected = entries.find((e) => e.file.path === 'e-own.ts')?.key ?? null;
    const reviewedOwn = entries.map((e) => ({
      ...e,
      file: { ...e.file, reviewed: !e.file.path.endsWith('own.ts') && e.file.origin !== 'base' },
    }));
    const eligible = originVisibleIf(COLLAPSED);
    // Unreviewed: b-own, e-own, a-base, d-base. From e-own `n` wraps to b-own, never a base file.
    expect(nextUnreviewed(reviewedOwn, selected, eligible)?.file.path).toBe('b-own.ts');
    expect(nextUnreviewed(reviewedOwn, selected)?.file.path).toBe('a-base.ts');
    const open = originVisibleIf({ fromMainOnly: false, expanded: new Set(['w1']) });
    expect(nextUnreviewed(reviewedOwn, selected, open)?.file.path).toBe('a-base.ts');
  });

  it('labels the group by how its files arrived', () => {
    expect(noiseGroupLabel('origin/main', new Set(['merge']), 5)).toBe(
      'From origin/main - merge (5 files)',
    );
    expect(noiseGroupLabel('origin/main', new Set(['rebase']), 1)).toBe(
      'From origin/main - rebase (1 file)',
    );
    expect(noiseGroupLabel('main', new Set(['same-as-base']), 2)).toBe(
      'From main - same as main (2 files)',
    );
    expect(noiseGroupLabel('main', new Set(['in-progress']), 2)).toBe(
      'From main - in progress (2 files)',
    );
    expect(noiseGroupLabel('main', new Set(['update']), 4)).toBe('From main - update (4 files)');
    // Different vias in one group: no via in the label, each row carries its own.
    expect(noiseGroupLabel('origin/main', new Set(['merge', 'rebase']), 3)).toBe(
      'From origin/main (3 files)',
    );
    // A daemon that sent no via.
    expect(noiseGroupLabel('origin/main', new Set([undefined]), 3)).toBe(
      'From origin/main (3 files)',
    );
  });

  it('tags rows: +main for mixed, the via for base, nothing for own', () => {
    expect(originTag(file('x'))).toBeNull();
    expect(originTag(file('x', { origin: 'own' }))).toBeNull();
    expect(originTag(file('x', { origin: 'mixed', originVia: 'rebase' }))).toBe('+main');
    expect(originTag(file('x', { origin: 'base', originVia: 'update' }))).toBe('update');
    expect(originTag(file('x', { origin: 'base' }))).toBe('main');
    expect(viaLabel('same-as-base')).toBe('same as main');
    expect(shortRef('origin/main')).toBe('main');
    expect(shortRef('upstream/main')).toBe('upstream/main');
  });

  it('counts per worktree after the eye', () => {
    const entries = flattenGroups([
      groupOf(ownFirst([...FILES, file('f-base.ts', { origin: 'base', reviewed: true })])),
    ]);
    const all = originStats(entries, visibleIf(true)).get('w1');
    expect(all).toMatchObject({ own: 3, base: 3, mixed: 1 });
    expect([...(all?.vias ?? [])].sort()).toEqual(['merge', 'same-as-base', undefined]);
    // The eye hides the reviewed base file from the count too.
    expect(originStats(entries, visibleIf(false)).get('w1')).toMatchObject({ own: 3, base: 2 });
  });

  it('Review N shown counts own + mixed files, never base ones', () => {
    const group = groupOf(ownFirst(FILES));
    const entries = flattenGroups([group]);
    const plan = (view: OriginView) =>
      planBulk({
        scope: { kind: 'working' },
        reviewed: true,
        groups: [group],
        entries,
        visible: visibleIf(true, view),
        stateHashes: new Map([['w1', 'h']]),
        disabled: new Set(),
        inboxUnfiltered: false,
        view: 'worktree',
      });
    expect(plan(COLLAPSED).count).toBe(3);
    // Expanded, the base files are listed but are not part of the bulk request.
    const open = plan({ fromMainOnly: false, expanded: new Set(['w1']) });
    expect(open.count).toBe(3);
    const paths = (open.requests[0] as { paths?: { path: string }[] }).paths?.map((p) => p.path);
    expect(paths).toEqual(['b-own.ts', 'c-mixed.ts', 'e-own.ts']);
    // The chip lists only base files: nothing to review in bulk.
    expect(plan({ fromMainOnly: true, expanded: new Set() }).count).toBe(0);
  });

  it('Review all in To review also moves the bookmark of a worktree with base files only (PR #67 review)', () => {
    const own = groupOf(ownFirst(FILES), 'w1');
    const baseOnly = groupOf(
      [
        file('x-base.ts', { origin: 'base', originVia: 'merge' }),
        file('y-base.ts', { origin: 'base' }),
      ],
      'w2',
    );
    const entries = flattenGroups([own, baseOnly]);
    const plan = (reviewed: boolean, scope: DiffScope) =>
      planBulk({
        scope,
        reviewed,
        groups: [own, baseOnly],
        entries,
        visible: visibleIf(true, COLLAPSED),
        stateHashes: new Map([
          ['w1', 'h1'],
          ['w2', 'h2'],
        ]),
        disabled: new Set(),
        inboxUnfiltered: false,
        view: 'inbox',
      });
    const review = plan(true, { kind: 'review' });
    // Nothing of w2 is marked (so it is not in the count), but its bookmark moves like w1's.
    expect(review.count).toBe(3);
    expect(review.worktrees).toBe(2);
    const targets = review.requests.map((r) => [
      (r.target as { worktreeId?: string }).worktreeId,
      r.advanceBookmarks,
      'paths' in r ? r.paths : undefined,
    ]);
    expect(targets).toEqual([
      ['w1', true, undefined],
      ['w2', true, undefined],
    ]);
    // With the chip on only base files are listed and own files are hidden: bulk review does nothing
    // (a bookmark-only request would mark the hidden own files of w1; PR #67 review).
    const chip = planBulk({
      scope: { kind: 'review' },
      reviewed: true,
      groups: [own, baseOnly],
      entries,
      visible: visibleIf(true, { fromMainOnly: true, expanded: new Set() }),
      stateHashes: new Map([['w1', 'h1']]),
      disabled: new Set(),
      inboxUnfiltered: false,
      view: 'inbox',
    });
    expect(chip.count).toBe(0);
    // w1 hides own files, so it gets nothing; w2 has none hidden, and its bookmark-only request
    // marks nothing (no own files, no paths): the same as without the chip.
    expect(
      chip.requests.map((r) => (r.target as { worktreeId?: string }).worktreeId),
    ).not.toContain('w1');
    // Only "Review all" in To review moves bookmarks: other scopes and un-reviewing do not.
    expect(plan(true, { kind: 'working' }).requests).toHaveLength(1);
    expect(plan(false, { kind: 'review' }).requests.every((r) => !r.advanceBookmarks)).toBe(true);
  });
});

describe('merge noise: the sidebar counts', () => {
  function item(review: Record<string, unknown> | undefined): WorktreeListItem {
    const backend = new MockBackend({ dataset: 'demo' });
    const base = backend.listProjects().projects[0]?.worktrees[1] as WorktreeListItem;
    const summary = base.summary;
    if (!summary) throw new Error('no summary');
    return {
      ...base,
      summary: {
        ...summary,
        ...(review ? { review: { ...summary.review, ...review } } : {}),
      } as WorktreeListItem['summary'],
    };
  }

  function unreviewedOf(review: Record<string, unknown>): number {
    const backend = new MockBackend({ dataset: 'demo' });
    const real = backend.listProjects().projects[0];
    if (!real) throw new Error('no project');
    const wt = item({
      bookmark: 'b',
      base: 'b',
      newCommits: 0,
      historyRewritten: false,
      ...review,
    });
    const sidebar = buildSidebar([{ project: real.project, worktrees: [wt] }], NO_SIDEBAR_FILTERS);
    return sidebar.byId.get(wt.worktree.id)?.unreviewed ?? -1;
  }

  it('prefers unreviewedOwnFiles; an older daemon (field absent) counts unreviewedFiles', () => {
    expect(unreviewedOf({ unreviewedFiles: 9, unreviewedOwnFiles: 4, baseFiles: 5 })).toBe(4);
    expect(unreviewedOf({ unreviewedFiles: 9 })).toBe(9);
    expect(unreviewedOf({ unreviewedFiles: 5, unreviewedOwnFiles: 0, baseFiles: 5 })).toBe(0);
  });
});

// --- the app ----------------------------------------------------------------------------------

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(event: ServerEvent) {
    for (const l of this.listeners.get(event.type) ?? []) {
      l(new MessageEvent(event.type, { data: JSON.stringify(event) }));
    }
  }
  close() {
    this.readyState = 2;
  }
}

interface Harness {
  backend: MockBackend;
  store: UiStore;
  user: ReturnType<typeof userEvent.setup>;
  requests: { method: string; url: string; body: unknown }[];
}

function setup(
  opts: { mergeNoise?: boolean; store?: Partial<Parameters<typeof createUiStore>[0]> } = {},
): Harness {
  const backend = new MockBackend({
    dataset: 'demo',
    statusFlow: true,
    mergeNoise: opts.mergeNoise ?? true,
  });
  const mockFetch = createMockFetch(backend);
  const requests: Harness['requests'] = [];
  const api = createApiClient({
    baseUrl: 'http://mock.local',
    fetch: (input, init) => {
      requests.push({
        method: init?.method ?? 'GET',
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return mockFetch(input, init);
    },
  });
  const store = createUiStore(
    { confirmBulk: false, settledOpen: true, scope: scopeForPref('review'), ...opts.store },
    false,
  );
  const factory = () => {
    const es = new FakeEventSource();
    backend.subscribe((e) => es.dispatch(e));
    queueMicrotask(() => es.onopen?.(new Event('open')));
    return es;
  };
  render(
    <App
      api={api}
      queryClient={createQueryClient()}
      uiStore={store}
      eventSourceFactory={factory}
    />,
  );
  return { backend, store, user: userEvent.setup(), requests };
}

const app = () => screen.getByTestId(TEST_IDS.app);
const paths = () => screen.queryAllByTestId(TEST_IDS.fileItem).map((el) => el.dataset.path);
const group = () => screen.queryByTestId(ORIGIN_TEST_IDS.group);
const chip = () => screen.queryByTestId(ORIGIN_TEST_IDS.chip);
const scopeSelect = () => screen.getByTestId(TEST_IDS.scopeSelect) as HTMLSelectElement;

function worktreeItem(branch: string): HTMLElement {
  const el = screen.getAllByTestId(TEST_IDS.worktreeItem).find((e) => e.dataset.branch === branch);
  if (!el) throw new Error(`no worktree item ${branch}`);
  return el;
}

async function open(branch: string) {
  await waitFor(() => expect(app().getAttribute('data-ready')).toBe('true'));
  fireEvent.click(worktreeItem(branch));
  await waitFor(() => expect(screen.queryAllByTestId(TEST_IDS.fileItem).length).toBeGreaterThan(0));
}

async function press(user: Harness['user'], keys: string) {
  await act(async () => {
    await user.keyboard(keys);
  });
}

const AUTH_BASE = [
  'src/lib/http.ts',
  'src/lib/retry.ts',
  'src/server/health.ts',
  'docs/CHANGELOG.md',
  'src/lib/limits.ts',
];

describe('merge noise: the file list', () => {
  it('wraps base files in a collapsed group at the end; own and mixed files come first', async () => {
    setup();
    await open('feat/auth');
    const g = await screen.findByTestId(ORIGIN_TEST_IDS.group);
    // Different vias in one group: no via in the label.
    expect(g.textContent).toBe('From origin/main (5 files)');
    expect(g.getAttribute('aria-expanded')).toBe('false');
    for (const p of AUTH_BASE) expect(paths()).not.toContain(p);
    expect(paths()).toContain('src/auth/session.ts');
    // The mixed file is listed with its +main tag.
    const mixed = screen
      .getAllByTestId(TEST_IDS.fileItem)
      .find((el) => el.dataset.path === 'src/server/config.ts');
    expect(mixed?.dataset.origin).toBe('mixed');
    expect(within(mixed as HTMLElement).getByTestId(ORIGIN_TEST_IDS.tag).textContent).toBe('+main');
    // Own rows carry no tag.
    const own = screen
      .getAllByTestId(TEST_IDS.fileItem)
      .find((el) => el.dataset.path === 'src/auth/session.ts');
    expect(within(own as HTMLElement).queryByTestId(ORIGIN_TEST_IDS.tag)).toBeNull();
    // The group sits after the last own row.
    const list = screen.getByTestId(TEST_IDS.fileList);
    const order = Array.from(
      list.querySelectorAll<HTMLElement>(
        '[data-testid="file-item"], [data-testid="from-main-group"]',
      ),
    ).map((el) => (el.dataset.testid === 'file-item' ? 'file' : 'group'));
    expect(order.at(-1)).toBe('group');
    expect(order.filter((x) => x === 'group')).toHaveLength(1);
  });

  it('names the via when every file arrived the same way', async () => {
    setup();
    await open('fix/cache');
    const g = await screen.findByTestId(ORIGIN_TEST_IDS.group);
    expect(g.textContent).toBe('From origin/main - rebase (3 files)');
  });

  it('expands to dimmed rows tagged with their via; collapsing wraps them again', async () => {
    setup();
    await open('feat/auth');
    fireEvent.click(await screen.findByTestId(ORIGIN_TEST_IDS.group));
    await waitFor(() => expect(paths()).toContain('src/lib/http.ts'));
    const g = screen.getByTestId(ORIGIN_TEST_IDS.group);
    expect(g.getAttribute('aria-expanded')).toBe('true');
    const rows = screen.getAllByTestId(TEST_IDS.fileItem);
    const base = rows.filter((el) => el.dataset.origin === 'base');
    expect(base.map((el) => el.dataset.path)).toEqual(expect.arrayContaining(AUTH_BASE));
    // The base rows follow every own row and are dimmed.
    const firstBase = rows.indexOf(base[0] as HTMLElement);
    expect(rows.slice(firstBase).every((el) => el.dataset.origin === 'base')).toBe(true);
    for (const el of base) expect(el.className).toContain('opacity-60');
    const tags = Object.fromEntries(
      base.map((el) => [el.dataset.path, within(el).getByTestId(ORIGIN_TEST_IDS.tag).textContent]),
    );
    expect(tags['src/lib/http.ts']).toBe('merge');
    expect(tags['src/lib/limits.ts']).toBe('same as main');
    fireEvent.click(g);
    await waitFor(() => expect(paths()).not.toContain('src/lib/http.ts'));
  });

  it('the group row works from the keyboard (Enter and Space on the focused button)', async () => {
    const { user } = setup();
    await open('feat/auth');
    const g = await screen.findByTestId(ORIGIN_TEST_IDS.group);
    expect(g.tagName).toBe('BUTTON');
    g.focus();
    await act(async () => {
      await user.keyboard('{Enter}');
    });
    await waitFor(() => expect(paths()).toContain('src/lib/http.ts'));
    await act(async () => {
      await user.keyboard(' ');
    });
    await waitFor(() => expect(paths()).not.toContain('src/lib/http.ts'));
  });

  it('j/k skip the collapsed group; expanding makes its rows reachable', async () => {
    const { user, store } = setup();
    await open('feat/auth');
    await screen.findByTestId(ORIGIN_TEST_IDS.group);
    const own = paths().filter((p) => !AUTH_BASE.includes(p ?? ''));
    const lastOwn = own.at(-1) as string;
    const selectLast = async () => {
      const row = screen
        .getAllByTestId(TEST_IDS.fileItem)
        .find((el) => el.dataset.path === lastOwn) as HTMLElement;
      fireEvent.click(row);
      await waitFor(() => expect(row.getAttribute('aria-selected')).toBe('true'));
      return row;
    };
    const row = await selectLast();
    await press(user, 'j');
    // Nothing after the last own row while the group is collapsed: the selection stays.
    expect(row.getAttribute('aria-selected')).toBe('true');
    actions.toggleOriginGroup(store, worktreeItem('feat/auth').dataset.worktreeId as string, true);
    await waitFor(() => expect(paths()).toContain('src/lib/http.ts'));
    await press(user, 'j');
    await waitFor(() => {
      const selected = screen
        .getAllByTestId(TEST_IDS.fileItem)
        .find((el) => el.getAttribute('aria-selected') === 'true');
      expect(selected?.dataset.origin).toBe('base');
    });
  });

  it('ArrowUp from a base file whose group was just collapsed goes to the last own file, not the first (PR #67 review)', async () => {
    const { store } = setup();
    await open('feat/auth');
    await screen.findByTestId(ORIGIN_TEST_IDS.group);
    const worktreeId = worktreeItem('feat/auth').dataset.worktreeId as string;
    const own = paths().filter((p) => !AUTH_BASE.includes(p ?? ''));
    expect(own.length).toBeGreaterThan(1);
    // Expand, select a base file, collapse again: the selection stays on a file that is no longer listed.
    actions.toggleOriginGroup(store, worktreeId, true);
    await waitFor(() => expect(paths()).toContain('src/lib/http.ts'));
    const baseRow = screen
      .getAllByTestId(TEST_IDS.fileItem)
      .find((el) => el.dataset.path === 'src/lib/http.ts') as HTMLElement;
    fireEvent.click(baseRow);
    await waitFor(() => expect(store.getState().selected?.path).toBe('src/lib/http.ts'));
    actions.toggleOriginGroup(store, worktreeId, false);
    await waitFor(() => expect(paths()).not.toContain('src/lib/http.ts'));
    fireEvent.keyDown(screen.getByTestId(TEST_IDS.fileList), { key: 'ArrowUp' });
    await waitFor(() => expect(store.getState().selected?.path).toBe(own.at(-1)));
  });

  it('n never lands on a file of a collapsed group', async () => {
    const { user, store } = setup();
    await open('feat/auth');
    await screen.findByTestId(ORIGIN_TEST_IDS.group);
    const visited = new Set<string>();
    for (let i = 0; i < 40; i++) {
      await press(user, 'n');
      const path = store.getState().selected?.path;
      if (path) visited.add(path);
    }
    expect(visited.size).toBeGreaterThan(1);
    for (const p of AUTH_BASE) expect(visited.has(p)).toBe(false);
    // Expanded, `n` reaches them (every unreviewed file is on the way round).
    actions.toggleOriginGroup(store, worktreeItem('feat/auth').dataset.worktreeId as string, true);
    await waitFor(() => expect(paths()).toContain('src/lib/http.ts'));
    for (let i = 0; i < 40; i++) {
      await press(user, 'n');
      const path = store.getState().selected?.path;
      if (path) visited.add(path);
    }
    expect(AUTH_BASE.some((p) => visited.has(p))).toBe(true);
  });

  it('keeps the selection and the expanded group across a live refresh', async () => {
    const { backend, store } = setup();
    await open('feat/auth');
    fireEvent.click(await screen.findByTestId(ORIGIN_TEST_IDS.group));
    await waitFor(() => expect(paths()).toContain('src/lib/http.ts'));
    const target = screen
      .getAllByTestId(TEST_IDS.fileItem)
      .find((el) => el.dataset.path === 'src/lib/http.ts') as HTMLElement;
    fireEvent.click(target);
    await waitFor(() => expect(store.getState().selected?.path).toBe('src/lib/http.ts'));
    await act(async () => {
      backend.mutate(worktreeItem('feat/auth').dataset.worktreeId, 'edit', 'src/auth/session.ts');
    });
    await waitFor(() => expect(app().getAttribute('data-ready')).toBe('true'));
    expect(store.getState().selected?.path).toBe('src/lib/http.ts');
    expect(screen.getByTestId(ORIGIN_TEST_IDS.group).getAttribute('aria-expanded')).toBe('true');
    expect(paths()).toContain('src/lib/http.ts');
  });
});

describe('merge noise: the chip', () => {
  it('shows From main (N), off by default, and lists only the base files when on', async () => {
    const { store } = setup();
    await open('feat/auth');
    const c = await screen.findByTestId(ORIGIN_TEST_IDS.chip);
    expect(c.textContent).toBe('From main (5)');
    expect(c.getAttribute('aria-pressed')).toBe('false');
    expect(store.getState().fromMainOnly).toBe(false);
    fireEvent.click(c);
    await waitFor(() => expect(c.getAttribute('aria-pressed')).toBe('true'));
    await waitFor(() => expect([...new Set(paths())].sort()).toEqual([...AUTH_BASE].sort()));
    // Only the noise is listed, as plain (not dimmed) tagged rows, and there is no group row.
    expect(group()).toBeNull();
    for (const el of screen.getAllByTestId(TEST_IDS.fileItem)) {
      expect(el.className).not.toContain('opacity-60');
    }
    expect(store.getState().fromMainOnly).toBe(true);
    // Off again.
    fireEvent.click(c);
    await waitFor(() => expect(paths()).toContain('src/auth/session.ts'));
    expect(paths()).not.toContain('src/lib/http.ts');
  });

  it('is keyboard reachable: a button in the toolbar, and the m key', async () => {
    const { user, store } = setup();
    await open('feat/auth');
    const c = await screen.findByTestId(ORIGIN_TEST_IDS.chip);
    expect(c.tagName).toBe('BUTTON');
    expect(c.closest('[role="toolbar"]')).not.toBeNull();
    await press(user, 'm');
    await waitFor(() => expect(store.getState().fromMainOnly).toBe(true));
    expect(c.getAttribute('aria-pressed')).toBe('true');
    // Focus + Enter works like any button.
    c.focus();
    await act(async () => {
      await user.keyboard('{Enter}');
    });
    await waitFor(() => expect(store.getState().fromMainOnly).toBe(false));
  });

  it('is a per-device preference', async () => {
    setup({ store: { fromMainOnly: true } });
    await open('feat/auth');
    const c = await screen.findByTestId(ORIGIN_TEST_IDS.chip);
    expect(c.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect([...new Set(paths())].sort()).toEqual([...AUTH_BASE].sort()));
  });

  it('is absent where nothing came from the default branch', async () => {
    setup();
    await open('fix/cache');
    await screen.findByTestId(ORIGIN_TEST_IDS.group);
    fireEvent.click(worktreeItem('main'));
    await waitFor(() => expect(screen.queryByTestId(ORIGIN_TEST_IDS.group)).toBeNull());
    expect(chip()).toBeNull();
  });
});

describe('merge noise: counts', () => {
  it('the scope counts, the sidebar chip and the title use own + mixed only', async () => {
    const { backend } = setup();
    await open('feat/auth');
    await screen.findByTestId(ORIGIN_TEST_IDS.group);
    const review = backend
      .listProjects()
      .projects.flatMap((p) => p.worktrees)
      .find((w) => w.worktree.branch === 'feat/auth')?.summary?.review;
    expect(review?.baseFiles).toBe(5);
    expect(review?.unreviewedOwnFiles).toBeDefined();
    expect(review?.unreviewedFiles).toBe((review?.unreviewedOwnFiles ?? 0) + 5);
    const own = review?.unreviewedOwnFiles ?? 0;
    // Scope select: To review (own + mixed).
    expect(scopeSelect().textContent).toContain(`To review (${own})`);
    // Sidebar row.
    expect(worktreeItem('feat/auth').dataset.unreviewed).toBe(String(own));
    // The group header of the inbox counts own + mixed only too.
    fireEvent.click(screen.getByTestId(TEST_IDS.inboxItem));
    await waitFor(() =>
      expect(screen.queryAllByTestId(TEST_IDS.fileGroup).length).toBeGreaterThan(0),
    );
    const authGroup = screen
      .getAllByTestId(TEST_IDS.fileGroup)
      .find((el) => el.dataset.worktreeId === worktreeItem('feat/auth').dataset.worktreeId);
    expect(authGroup?.textContent).toContain(`${own} unreviewed`);
    // The document title is the sum of the rows' counts (no base file in it).
    const total = Array.from(screen.getAllByTestId(TEST_IDS.worktreeItem)).reduce(
      (n, el) => n + Number(el.dataset.unreviewed ?? 0),
      0,
    );
    await waitFor(() => expect(document.title).toBe(`(${total}) octopus-diff`));
  });

  it('expanding the group does not change the file count in the Inbox group header (PR #67 review)', async () => {
    const { user } = setup();
    await open('feat/auth');
    await screen.findByTestId(ORIGIN_TEST_IDS.group);
    // One own file is reviewed (hidden while "show reviewed" is off), so the header reads `k/total`:
    // the case where counting the expanded base files as shown used to make it read `total`.
    const before = paths().length;
    expect(before).toBeGreaterThan(1);
    await user.click(screen.getAllByTestId(TEST_IDS.fileItem)[0] as HTMLElement);
    await press(user, 'r');
    await waitFor(() => expect(paths().length).toBe(before - 1));
    fireEvent.click(screen.getByTestId(TEST_IDS.inboxItem));
    await waitFor(() =>
      expect(screen.queryAllByTestId(TEST_IDS.fileGroup).length).toBeGreaterThan(0),
    );
    const headerOf = () =>
      screen
        .getAllByTestId(TEST_IDS.fileGroup)
        .find((el) => el.dataset.worktreeId === worktreeItem('feat/auth').dataset.worktreeId)
        ?.querySelector('div.flex')?.textContent ?? '';
    const collapsed = headerOf();
    expect(collapsed).toMatch(/\d+\/\d+ files/);
    const noise = screen
      .getAllByTestId(ORIGIN_TEST_IDS.group)
      .find((el) => el.dataset.worktreeId === worktreeItem('feat/auth').dataset.worktreeId);
    expect(noise).toBeDefined();
    fireEvent.click(noise as HTMLElement);
    await waitFor(() => expect(paths().length).toBeGreaterThan(0));
    // Same text with the base files expanded: they are rows, but not part of the own-only count.
    expect(headerOf()).toBe(collapsed);
  });

  it('Review N shown counts own + mixed; Review all leaves the base files alone', async () => {
    const { backend, user, requests } = setup();
    await open('feat/auth');
    await screen.findByTestId(ORIGIN_TEST_IDS.group);
    const button = screen.getByTestId(TEST_IDS.markAllButton);
    const own = backend
      .listFiles(worktreeItem('feat/auth').dataset.worktreeId as string, { kind: 'review' })
      .files.filter((f) => f.origin !== 'base' && !f.reviewed).length;
    expect(button.dataset.count).toBe(String(own));
    // Expanding the group does not change what "Review N shown" would do.
    fireEvent.click(screen.getByTestId(ORIGIN_TEST_IDS.group));
    await waitFor(() => expect(paths()).toContain('src/lib/http.ts'));
    expect(button.dataset.count).toBe(String(own));
    // The base files of the To review list, captured before the request moves the bookmark.
    const worktreeId = worktreeItem('feat/auth').dataset.worktreeId as string;
    const baseFiles = backend
      .listFiles(worktreeId, { kind: 'review' })
      .files.filter((f) => f.origin === 'base');
    expect(baseFiles.length).toBeGreaterThan(0);
    await press(user, 'R');
    await screen.findByTestId(TEST_IDS.bulkReviewToast);
    const bulk = requests.find((r) => r.url.endsWith('/api/review/bulk'));
    expect(bulk?.body).toMatchObject({ scope: { kind: 'review' }, advanceBookmarks: true });
    // The own files were marked, and not one base file has a review mark (the marks are keyed by
    // project, scope, path and patch: `|review|<path>|<patchHash>`).
    expect(backend.reviews.size).toBeGreaterThan(0);
    for (const f of baseFiles) {
      const marked = [...backend.reviews].filter((k) => k.includes(`|${f.rawPath ?? f.path}|`));
      expect(marked, `review marks of base file ${f.path}`).toEqual([]);
    }
  });
});

describe('merge noise: mixed files', () => {
  it('+main rows come with a toggle that switches to All on branch and back', async () => {
    const { store } = setup();
    await open('feat/auth');
    const toggle = await screen.findByTestId(ORIGIN_TEST_IDS.branchToggle);
    expect(toggle.textContent).toBe("Only this branch's changes");
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(store.getState().scope.kind).toBe('branch'));
    // All on branch: the mixed file is a plain own change, and no base file is listed.
    await waitFor(() => expect(paths()).toContain('src/server/config.ts'));
    const row = screen
      .getAllByTestId(TEST_IDS.fileItem)
      .find((el) => el.dataset.path === 'src/server/config.ts') as HTMLElement;
    expect(row.dataset.origin).toBeUndefined();
    expect(within(row).queryByTestId(ORIGIN_TEST_IDS.tag)).toBeNull();
    expect(group()).toBeNull();
    expect(screen.getByTestId(ORIGIN_TEST_IDS.branchToggle).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // Back to where it came from.
    await act(async () => {
      fireEvent.click(screen.getByTestId(ORIGIN_TEST_IDS.branchToggle));
    });
    await waitFor(() => expect(store.getState().scope.kind).toBe('review'));
    await screen.findByTestId(ORIGIN_TEST_IDS.group);
  });

  it('forgets the way back when the scope is changed another way', async () => {
    const { store } = setup();
    await open('feat/auth');
    fireEvent.click(await screen.findByTestId(ORIGIN_TEST_IDS.branchToggle));
    await waitFor(() => expect(store.getState().scope.kind).toBe('branch'));
    fireEvent.change(scopeSelect(), { target: { value: 'working' } });
    await waitFor(() => expect(store.getState().scope.kind).toBe('working'));
    expect(store.getState().branchToggleFrom).toBeNull();
    // Back on All on branch by hand: no mixed files there, so no toggle.
    fireEvent.change(scopeSelect(), { target: { value: 'branch' } });
    await waitFor(() => expect(store.getState().scope.kind).toBe('branch'));
    expect(screen.queryByTestId(ORIGIN_TEST_IDS.branchToggle)).toBeNull();
  });
});

describe('merge noise: an older daemon', () => {
  it('without origin fields every file is its own: no group, no chip, no toggle', async () => {
    const { store } = setup({ mergeNoise: false });
    await open('feat/auth');
    await waitFor(() => expect(paths()).toContain('src/auth/oauth.ts'));
    expect(group()).toBeNull();
    expect(chip()).toBeNull();
    expect(screen.queryByTestId(ORIGIN_TEST_IDS.branchToggle)).toBeNull();
    expect(screen.queryAllByTestId(ORIGIN_TEST_IDS.tag)).toHaveLength(0);
    for (const el of screen.getAllByTestId(TEST_IDS.fileItem)) {
      expect(el.dataset.origin).toBeUndefined();
    }
    // The sidebar count is unreviewedFiles.
    expect(worktreeItem('feat/auth').dataset.unreviewed).toBe(
      String(
        screen.getAllByTestId(TEST_IDS.fileItem).filter((el) => el.dataset.reviewed === 'false')
          .length,
      ),
    );
    expect(store.getState().fromMainOnly).toBe(false);
  });
});

describe('merge noise: the tree layout', () => {
  it('wraps the group in a bar under the tree', async () => {
    const { store } = setup({ store: { fileListLayout: 'tree' } });
    await open('feat/auth').catch(() => undefined);
    const bar = await screen.findByTestId(ORIGIN_TEST_IDS.group);
    expect(bar.getAttribute('aria-expanded')).toBe('false');
    expect(bar.textContent).toBe('From origin/main (5 files)');
    fireEvent.click(bar);
    await waitFor(() =>
      expect(store.getState().originOpen).toContain(bar.dataset.worktreeId as string),
    );
    expect(screen.getByTestId(ORIGIN_TEST_IDS.group).getAttribute('aria-expanded')).toBe('true');
  });
});
