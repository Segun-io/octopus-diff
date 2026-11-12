// @vitest-environment jsdom
/**
 * The flat, virtualised sidebar (#13, DECISIONS #241): the model (order by last activity, pinned
 * first, Hidden, own-only counts, the folder filter) and the list (only a window of rows mounted,
 * the selected row always there, scrolling and J/K move the window). jsdom has no layout, so
 * `test/layout.ts` stubs the scroller's height and the rows' heights (see its header).
 */
import { createApiClient, TEST_IDS, type WorktreeListItem } from '@octopus-diff/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockBackend, type MockBackendOptions } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { App } from '../src/App.tsx';
import { createQueryClient } from '../src/api/queries.ts';
import { OVERSCAN } from '../src/components/SidebarList.tsx';
import {
  buildSidebar,
  compareRows,
  DIRECT_FOLDER_ID,
  NO_SIDEBAR_FILTERS,
} from '../src/lib/model.ts';
import { scopeForPref } from '../src/state/prefs.ts';
import { createUiStore } from '../src/state/ui.tsx';
import { scrollSidebarTo, setSidebarLayout } from './layout.ts';

vi.mock('../src/components/diff/DiffRenderer.tsx', () => ({
  DiffRenderer: ({ patch }: { patch: string }) => <pre data-testid="stub-diff">{patch}</pre>,
}));

// --- the model ------------------------------------------------------------------------------

function demoProjects() {
  return new MockBackend({ dataset: 'demo' }).listProjects().projects;
}

/** The demo's projects with chosen `activityAt` per branch (`null` removes it). */
function withActivity(at: Record<string, string | null>) {
  return demoProjects().map((p) => ({
    ...p,
    worktrees: p.worktrees.map((w): WorktreeListItem => {
      const key = `${p.project.name}:${w.worktree.branch ?? ''}`;
      if (!(key in at) || !w.summary) return w;
      const { activityAt: _drop, ...rest } = w.summary;
      const next = at[key];
      return { ...w, summary: next === null ? rest : { ...rest, activityAt: next } };
    }),
  }));
}

describe('flat sidebar model', () => {
  it('orders every worktree by last activity, newest first, across projects', () => {
    const projects = withActivity({
      'octopus-api:fix/cache': '2026-11-12T10:00:00.000Z',
      'web-dashboard:main': '2026-11-12T09:00:00.000Z',
      'docs-site:': '2026-11-12T11:00:00.000Z',
      'octopus-api:feat/auth': '2026-11-11T08:00:00.000Z',
    });
    const model = buildSidebar(projects, NO_SIDEBAR_FILTERS);
    const label = (id: string) => {
      const r = model.byId.get(id);
      return `${r?.project.name}:${r?.worktree.branch ?? ''}`;
    };
    const top = model.flat.slice(0, 4).map((r) => label(r.worktree.id));
    expect(top).toEqual([
      'docs-site:',
      'octopus-api:fix/cache',
      'web-dashboard:main',
      'octopus-api:feat/auth',
    ]);
    // Every other row follows, no older than the fourth.
    const at = (i: number) => Date.parse(model.flat[i]?.summary?.activityAt ?? '') || 0;
    for (let i = 4; i < model.flat.length; i++) expect(at(i)).toBeLessThanOrEqual(at(3));
    // One list, not groups: all rows are in it, and `order` (J/K) is that list.
    expect(model.flat).toHaveLength(model.byId.size);
    expect(model.order).toEqual(model.flat.map((r) => r.worktree.id));
  });

  it('puts worktrees without an activity time last, then project and worktree order', () => {
    const projects = withActivity({ 'infra:trunk': null, 'infra:master': null });
    const model = buildSidebar(projects, NO_SIDEBAR_FILTERS);
    const ids = model.flat.map((r) => r.worktree.id);
    const none = model.flat.filter((r) => !r.summary?.activityAt);
    expect(none.length).toBeGreaterThanOrEqual(2);
    expect(ids.slice(-none.length)).toEqual(none.map((r) => r.worktree.id));
    // Ties among them are stable: the comparator is a total order.
    for (let i = 1; i < none.length; i++) {
      const [a, b] = [none[i - 1], none[i]];
      if (a && b) expect(compareRows(a, b)).toBeLessThan(0);
    }
  });

  it('lists pinned rows first, whatever their activity; only a hide by hand moves a row to Hidden', () => {
    const projects = demoProjects();
    const all = projects.flatMap((p) => p.worktrees);
    const oldest = [...all].sort((a, b) =>
      (a.summary?.activityAt ?? '').localeCompare(b.summary?.activityAt ?? ''),
    )[0];
    const target = all.find((w) => w.summary && w.worktree.branch === 'fix/cache');
    if (!oldest || !target?.summary) throw new Error('demo fixture changed');
    const pinned = buildSidebar(projects, NO_SIDEBAR_FILTERS, undefined, [oldest.worktree.id]);
    expect(pinned.flat[0]?.worktree.id).toBe(oldest.worktree.id);
    expect(pinned.flat[0]?.pinned).toBe(true);

    const hide = [
      {
        worktreeId: target.worktree.id,
        state: 'settled' as const,
        stateHash: target.summary.stateHash,
      },
    ];
    const hidden = buildSidebar(projects, NO_SIDEBAR_FILTERS, undefined, [], hide);
    expect(hidden.hidden.map((r) => r.worktree.id)).toEqual([target.worktree.id]);
    expect(hidden.flat.map((r) => r.worktree.id)).not.toContain(target.worktree.id);
    // Hidden rows still come last in `order`, so J/K reach them.
    expect(hidden.order.at(-1)).toBe(target.worktree.id);
    // A hide for another state hash no longer holds; a pin beats a hide (it stays in the list).
    const stale = buildSidebar(
      projects,
      NO_SIDEBAR_FILTERS,
      undefined,
      [],
      [{ ...(hide[0] as (typeof hide)[0]), stateHash: 'old' }],
    );
    expect(stale.hidden).toEqual([]);
    const both = buildSidebar(projects, NO_SIDEBAR_FILTERS, undefined, [target.worktree.id], hide);
    expect(both.hidden).toEqual([]);
    expect(both.flat[0]?.worktree.id).toBe(target.worktree.id);
    // Nothing else hides a row: reviewed, review-off and merged-free rows all stay in the list.
    const quiet = buildSidebar(projects, NO_SIDEBAR_FILTERS).flat.filter(
      (r) => r.state === 'settled',
    );
    expect(quiet.length).toBeGreaterThan(0);
  });

  it('counts own files only: the row follows unreviewedOwnFiles, never the merge noise', () => {
    const projects = demoProjects().map((p) => ({
      ...p,
      worktrees: p.worktrees.map((w) =>
        w.summary && w.worktree.branch === 'fix/cache'
          ? {
              ...w,
              summary: {
                ...w.summary,
                review: {
                  bookmark: null,
                  base: null,
                  newCommits: 0,
                  historyRewritten: false,
                  unreviewedFiles: 9,
                  unreviewedOwnFiles: 2,
                  baseFiles: 7,
                },
              },
            }
          : w,
      ),
    }));
    const row = buildSidebar(projects, NO_SIDEBAR_FILTERS).flat.find(
      (r) => r.worktree.branch === 'fix/cache',
    );
    expect(row?.unreviewed).toBe(2);
    // An older daemon without the own count: every file is its own.
    const older = projects.map((p) => ({
      ...p,
      worktrees: p.worktrees.map((w) => {
        if (!w.summary?.review) return w;
        const { unreviewedOwnFiles: _own, ...review } = w.summary.review;
        return { ...w, summary: { ...w.summary, review } };
      }),
    }));
    expect(
      buildSidebar(older, NO_SIDEBAR_FILTERS).flat.find((r) => r.worktree.branch === 'fix/cache')
        ?.unreviewed,
    ).toBe(9);
  });

  it('narrows to picked folders, and offers every folder to the picker', () => {
    const projects = demoProjects();
    const scanRoots = [
      {
        id: 'root-a',
        path: '/home/dev/code',
        depth: 3,
        addedAt: '2026-11-01T00:00:00.000Z',
        lastScannedAt: null,
        projectCount: 0,
      },
    ];
    const inFolder = projects.filter((p) => p.project.scanRootId !== null);
    const direct = projects.filter((p) => p.project.scanRootId === null);
    expect(inFolder.length).toBeGreaterThan(0);
    expect(direct.length).toBeGreaterThan(0);
    const rootId = inFolder[0]?.project.scanRootId as string;
    const roots = [{ ...scanRoots[0], id: rootId }] as typeof scanRoots;
    const onlyFolder = buildSidebar(projects, { ...NO_SIDEBAR_FILTERS, folders: [rootId] }, roots);
    expect(new Set(onlyFolder.flat.map((r) => r.project.scanRootId))).toEqual(new Set([rootId]));
    const onlyDirect = buildSidebar(
      projects,
      { ...NO_SIDEBAR_FILTERS, folders: [DIRECT_FOLDER_ID] },
      roots,
    );
    expect(new Set(onlyDirect.flat.map((r) => r.project.scanRootId))).toEqual(new Set([null]));
    // The picker's folders ignore the filters.
    expect(onlyDirect.folderOptions.map((f) => f.label)).toEqual(['~/code', 'Added directly']);
    expect(onlyDirect.folderOptions.reduce((n, f) => n + f.worktrees, 0)).toBe(
      onlyDirect.byId.size,
    );
  });
});

// --- the list -------------------------------------------------------------------------------

function mount(options: MockBackendOptions, ui: Parameters<typeof createUiStore>[0] = {}) {
  const backend = new MockBackend(options);
  const mockFetch = createMockFetch(backend);
  const api = createApiClient({ baseUrl: 'http://mock.local', fetch: mockFetch });
  const store = createUiStore({ confirmBulk: false, scope: scopeForPref('working'), ...ui }, false);
  render(
    <App api={api} queryClient={createQueryClient()} uiStore={store} eventSourceFactory={null} />,
  );
  return { backend, store, user: userEvent.setup() };
}

const LARGE: MockBackendOptions = {
  dataset: 'large',
  largeProjects: 30,
  largeWorktreesPerProject: 11,
  largeFilesPerWorktree: 2,
};
const TOTAL = 30 * 11;

const list = () => screen.getByTestId('sidebar-list');
const scroller = () => screen.getByTestId('sidebar-scroll');
const mountedRows = () =>
  [...list().querySelectorAll<HTMLElement>('[data-testid="worktree-item"]')].map(
    (el) => el.dataset.worktreeId as string,
  );
async function listed(total: number) {
  await waitFor(() => expect(list().dataset.total).toBe(String(total)));
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
});

describe('virtualised sidebar', () => {
  it('mounts a window of the rows, not all of them; scrolling moves the window', async () => {
    setSidebarLayout({ viewport: 580, row: 58 }); // 10 rows visible
    mount(LARGE);
    await listed(TOTAL);
    const first = mountedRows();
    // The viewport's 10 rows plus the overscan below (and the selected row, here none).
    expect(first.length).toBeGreaterThanOrEqual(10);
    expect(first.length).toBeLessThanOrEqual(10 + OVERSCAN + 1);
    expect(first.length).toBeLessThan(TOTAL / 10);
    // The spacer is as tall as the whole list, so the scrollbar is the real one.
    expect(list().style.height).toBe(`${TOTAL * 58}px`);

    act(() => scrollSidebarTo(scroller(), 100 * 58));
    await waitFor(() => expect(mountedRows()).not.toContain(first[0]));
    const moved = mountedRows();
    expect(moved.length).toBeLessThanOrEqual(10 + 2 * OVERSCAN + 1);
    // Rows are absolutely positioned at their own offset.
    const li = list().querySelector<HTMLElement>(`li[data-index="${100}"]`);
    expect(li?.style.top).toBe(`${100 * 58}px`);
    expect(within(li as HTMLElement).getByTestId('worktree-item')).toBeTruthy();
  });

  it('keeps the selected row mounted outside the window and scrolls to it on J', async () => {
    setSidebarLayout({ viewport: 580, row: 58 });
    const { store, user } = mount(LARGE);
    await listed(TOTAL);
    // Jump the selection far down (the palette, a link): its row is mounted although it is not
    // in the window, and the list scrolls to it.
    const model = [...document.querySelectorAll('li[data-index]')];
    expect(model.length).toBeLessThan(40);
    await act(async () => {
      await user.keyboard('J');
    });
    const firstId = mountedRows()[0] as string;
    await waitFor(() => expect(store.getState().view).toMatchObject({ kind: 'worktree' }));
    expect(store.getState().view).toMatchObject({ worktreeId: firstId });
    // Press J 25 more times: the 26th row is past the first window of 10 rows.
    for (let i = 0; i < 25; i++) {
      await act(async () => {
        await user.keyboard('J');
      });
    }
    const current = () =>
      document
        .querySelector('[data-testid="worktree-item"][aria-current="true"]')
        ?.getAttribute('data-worktree-id');
    await waitFor(() => expect(current()).toBeTruthy());
    expect(current()).not.toBe(firstId);
    expect(mountedRows()).toContain(current());
    // The window followed the selection: the scroller moved and the first rows are gone.
    expect(scroller().scrollTop).toBeGreaterThan(0);
    expect(mountedRows()).not.toContain(firstId);
    expect(mountedRows().length).toBeLessThanOrEqual(10 + 2 * OVERSCAN + 1);
  });

  it('keeps the selected row mounted when the user scrolls away from it', async () => {
    setSidebarLayout({ viewport: 580, row: 58 });
    const { store } = mount(LARGE);
    await listed(TOTAL);
    const selected = mountedRows()[2] as string;
    act(() => store.setState({ view: { kind: 'worktree', worktreeId: selected } }));
    await waitFor(() =>
      expect(
        document.querySelector('[aria-current="true"][data-testid="worktree-item"]'),
      ).toBeTruthy(),
    );
    act(() => scrollSidebarTo(scroller(), 200 * 58));
    await waitFor(() => expect(list().querySelector('li[data-index="200"]')).toBeTruthy());
    // Far outside the window, yet still mounted (so focus, `aria-current` and J/K keep their row).
    expect(mountedRows()).toContain(selected);
    expect(mountedRows().length).toBeLessThanOrEqual(10 + 2 * OVERSCAN + 2);
  });

  it('keeps the row whose menu is open mounted, so closing the menu can return focus to it (PR #82 review)', async () => {
    setSidebarLayout({ viewport: 580, row: 58 });
    mount(LARGE);
    await listed(TOTAL);
    const opener = mountedRows()[3] as string;
    const item = document.querySelector<HTMLElement>(
      `[data-testid="worktree-item"][data-worktree-id="${opener}"]`,
    ) as HTMLElement;
    fireEvent.contextMenu(item);
    await screen.findByRole('menu');
    // The list scrolls far away while the menu is open: the opener is not in the window...
    act(() => scrollSidebarTo(scroller(), 200 * 58));
    await waitFor(() => expect(list().querySelector('li[data-index="200"]')).toBeTruthy());
    // ...and is still there, to take focus back when the menu closes.
    expect(mountedRows()).toContain(opener);
    expect(mountedRows().length).toBeLessThanOrEqual(10 + 2 * OVERSCAN + 2);
    // Closed, the row follows the window again.
    await act(async () => {
      await userEvent.setup().keyboard('{Escape}');
    });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    act(() => scrollSidebarTo(scroller(), 201 * 58));
    await waitFor(() => expect(mountedRows()).not.toContain(opener));
  });

  it('mounts the selected row once when its own menu is open and it is scrolled away (PR #82 review)', async () => {
    setSidebarLayout({ viewport: 580, row: 58 });
    const { store } = mount(LARGE);
    await listed(TOTAL);
    const selected = mountedRows()[2] as string;
    act(() => store.setState({ view: { kind: 'worktree', worktreeId: selected } }));
    await waitFor(() =>
      expect(
        document.querySelector('[aria-current="true"][data-testid="worktree-item"]'),
      ).toBeTruthy(),
    );
    fireEvent.contextMenu(
      document.querySelector(
        `[data-testid="worktree-item"][data-worktree-id="${selected}"]`,
      ) as HTMLElement,
    );
    await screen.findByRole('menu');
    act(() => scrollSidebarTo(scroller(), 200 * 58));
    await waitFor(() => expect(list().querySelector('li[data-index="200"]')).toBeTruthy());
    // Selected and the menu's opener at once: one row, not two.
    expect(mountedRows().filter((id) => id === selected)).toHaveLength(1);
    const indexes = [...list().querySelectorAll('li[data-index]')].map((li) =>
      li.getAttribute('data-index'),
    );
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  it('keeps every row of a small list mounted and names the repository on each', async () => {
    setSidebarLayout({ viewport: 6000 });
    mount({ dataset: 'demo' });
    await waitFor(() => expect(list().dataset.total).not.toBe('0'));
    expect(mountedRows()).toHaveLength(Number(list().dataset.total));
    for (const row of screen.getAllByTestId(TEST_IDS.worktreeItem)) {
      expect(within(row).getByTestId('row-repo').textContent).toBe(row.dataset.projectName);
    }
  });

  it('has a Hidden section at the end of the list: closed by default, a header plus its rows once open', async () => {
    setSidebarLayout({ viewport: 6000 });
    const { backend, store } = mount({ dataset: 'demo' });
    await waitFor(() => expect(list().dataset.total).not.toBe('0'));
    const total = Number(list().dataset.total);
    expect(screen.queryByLabelText(/^(Expand|Collapse) hidden$/)).toBeNull();
    const row = screen
      .getAllByTestId(TEST_IDS.worktreeItem)
      .find((el) => el.dataset.branch === 'fix/cache') as HTMLElement;
    fireEvent.click(
      within(row.parentElement as HTMLElement).getByLabelText('Hide until it changes'),
    );
    // Closed: one header, the row gone from the list (total: rows - 1 + header).
    await waitFor(() => expect(list().dataset.total).toBe(String(total)));
    const header = screen.getByLabelText('Expand hidden');
    expect(header.textContent).toContain('1');
    expect(list().querySelector('li[data-section="hidden-header"]')).toBeTruthy();
    expect(list().querySelector('li[data-section="hidden"]')).toBeNull();
    expect(list().lastElementChild?.getAttribute('data-section')).toBe('hidden-header');
    fireEvent.click(header);
    await waitFor(() => expect(list().dataset.total).toBe(String(total + 1)));
    const hiddenRow = list().querySelector(
      'li[data-section="hidden"] [data-testid="worktree-item"]',
    );
    expect((hiddenRow as HTMLElement).dataset.branch).toBe('fix/cache');
    expect(store.getState().settledOpen).toBe(true);
    void backend;
  });
});

describe('sidebar perf: 300+ worktrees', () => {
  it('stays bounded: a window of rows and DOM nodes, however many worktrees there are', async () => {
    setSidebarLayout({ viewport: 780, row: 58 }); // a 900px tall window's sidebar: 13 rows
    mount(LARGE);
    await listed(TOTAL);
    expect(TOTAL).toBeGreaterThan(300);
    const rows = mountedRows();
    const nodes = scroller().querySelectorAll('*').length;
    const perRow = nodes / rows.length;
    // 13 visible + 6 overscan: never the 330 of the old sidebar.
    expect(rows.length).toBeLessThanOrEqual(13 + OVERSCAN + 1);
    expect(rows.length).toBeGreaterThanOrEqual(13);
    // A row is a few dozen nodes (the old sidebar mounted ~80 per worktree and grew with them).
    expect(perRow).toBeLessThan(60);
    expect(nodes).toBeLessThan(1500);
    // After interaction (selecting a row, opening the filter) it is still bounded.
    fireEvent.click(screen.getByTestId(TEST_IDS.sidebarFilter));
    expect(scroller().querySelectorAll('*').length).toBeLessThan(1500);
    fireEvent.click(screen.getAllByTestId(TEST_IDS.worktreeItem)[3] as HTMLElement);
    await waitFor(() =>
      expect(
        document.querySelector('[aria-current="true"][data-testid="worktree-item"]'),
      ).toBeTruthy(),
    );
    expect(mountedRows().length).toBeLessThanOrEqual(13 + OVERSCAN + 1);
    expect(scroller().querySelectorAll('*').length).toBeLessThan(1500);
  });

  it('with the filter picker narrowing the list, the total follows and the window shrinks', async () => {
    setSidebarLayout({ viewport: 780, row: 58 });
    const { store } = mount(LARGE);
    await listed(TOTAL);
    const project = store.getState();
    expect(project.filterFolders).toEqual([]);
    fireEvent.click(screen.getByTestId(TEST_IDS.sidebarFilter));
    const search = await screen.findByTestId(TEST_IDS.sidebarFilterSearch);
    fireEvent.change(search, { target: { value: 'service-07' } });
    const option = await waitFor(() => {
      const el = screen
        .getAllByTestId(TEST_IDS.sidebarFilterOption)
        .find((o) => o.dataset.kind === 'project');
      if (!el) throw new Error('no project option');
      return el;
    });
    fireEvent.click(option);
    await listed(11);
    expect(mountedRows()).toHaveLength(11);
    expect(
      new Set(
        [...list().querySelectorAll<HTMLElement>('[data-project-name]')].map(
          (e) => e.dataset.projectName,
        ),
      ),
    ).toEqual(new Set(['service-07']));
  });

  it('the filter picker offers folders: picking one narrows the list to its projects', async () => {
    setSidebarLayout({ viewport: 6000 });
    const { store, backend } = mount({ dataset: 'demo' });
    await waitFor(() => expect(list().dataset.total).not.toBe('0'));
    const all = backend.listProjects().projects;
    const direct = all.filter((p) => p.project.scanRootId === null);
    fireEvent.click(screen.getByTestId(TEST_IDS.sidebarFilter));
    const options = await screen.findAllByTestId(TEST_IDS.sidebarFilterOption);
    const folders = options.filter((o) => o.dataset.kind === 'folder');
    expect(folders.map((o) => o.textContent)).toEqual([
      expect.stringContaining('~/code'),
      expect.stringContaining('Added directly'),
    ]);
    fireEvent.click(folders[1] as HTMLElement);
    expect(store.getState().filterFolders).toEqual([DIRECT_FOLDER_ID]);
    const wanted = direct.reduce((n, p) => n + p.worktrees.length, 0);
    await waitFor(() => expect(mountedRows()).toHaveLength(wanted));
    const names = new Set(direct.map((p) => p.project.name));
    for (const row of screen.getAllByTestId(TEST_IDS.worktreeItem)) {
      expect(names.has(row.dataset.projectName ?? '')).toBe(true);
    }
    // The trigger says what is filtered.
    expect(screen.getByTestId(TEST_IDS.sidebarFilter).getAttribute('aria-label')).toContain(
      'Added directly',
    );
  });
});
