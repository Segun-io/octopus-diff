// @vitest-environment jsdom
/**
 * #42, PR #97 review: the web on paged lists when things move under it. A selection a refresh
 * removed is handed over, and one still on its way is not repaired early (1); `n` pages from the
 * daemon's order, not the tree's (2); a page that keeps failing is retried a bounded number of
 * times, then offered again (3); a navigation the user overtook (a click, `j`/`k`, `J`, another
 * jump) or whose load failed selects nothing (4). Every step goes through the app's own controls.
 */

import { orderFiles, TEST_IDS } from '@octopus-diff/contracts';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filesPaging } from '../src/api/files.ts';
import type { NavEntry } from '../src/lib/model.ts';
import { sortFilesTreeOrder } from '../src/lib/model.ts';
import {
  FILES,
  listOf,
  loaded,
  loadMore,
  markFirst,
  PAGE,
  paletteOpen,
  press,
  selectedPath,
  setup,
} from './paged-harness.tsx';

vi.mock('../src/components/diff/DiffRenderer.tsx', () => ({
  DiffRenderer: ({ patch }: { patch: string }) => <pre data-testid="stub-diff">{patch}</pre>,
}));
// @pierre/trees needs a real browser: the tree shows its entries in the order it is given.
vi.mock('../src/components/FileTreeView.tsx', () => ({
  FileTreeView: ({ entries }: { entries: NavEntry[] }) => (
    <ul data-testid="stub-tree">
      {entries.map((e) => (
        <li key={e.key} data-testid="stub-tree-item" data-path={e.file.path} />
      ))}
    </ul>
  ),
}));

const isLookup = (url: string) =>
  url.includes('/files?') &&
  url.includes('after=') &&
  url.includes('limit=1') &&
  !url.includes('unreviewed');
const isPage = (url: string) => url.includes('/files?') && url.includes('cursor=');
const isAsk = (url: string) => url.includes('/files?') && url.includes('unreviewed=true');

/** A file of the list that the mock can revert (text, not deleted), from `from` on. */
function revertable(list: ReturnType<typeof listOf>, from: number) {
  for (let i = from; i < list.length; i++) {
    const f = list[i];
    if (f && f.status !== 'deleted' && !f.binary && f.status !== 'untracked') return i;
  }
  throw new Error('no revertable file');
}

beforeEach(() => {
  localStorage.clear();
  filesPaging.pageSize = PAGE;
  filesPaging.inboxFiles = 5;
  filesPaging.retryDelaysMs = [5, 10, 15];
});
afterEach(() => {
  cleanup();
  filesPaging.pageSize = 500;
  filesPaging.inboxFiles = 200;
  filesPaging.retryDelaysMs = [1000, 3000, 10_000];
});

describe('selection repair on a partly loaded list (review 1)', () => {
  it('hands a removed file over to its neighbour once the lookup is done', async () => {
    const h = await setup();
    await waitFor(() => expect(loaded()).toBe(PAGE));
    await loadMore(2 * PAGE);
    const before = listOf(h.backend, h.first);
    const i = revertable(before, PAGE + 5);
    const removed = before[i]?.path as string;
    const neighbour = before[i + 1]?.path as string;
    await paletteOpen(removed);
    await waitFor(() => expect(selectedPath(h.store)).toBe(removed));
    const lookups = () => h.requests.filter(isLookup).length;
    const asked = lookups();
    await act(async () => {
      h.backend.mutate(h.first, 'revert', removed);
    });
    // The list still has more pages: the selection is looked up first, then handed over.
    await waitFor(() => expect(lookups()).toBeGreaterThan(asked));
    await waitFor(() => expect(selectedPath(h.store)).toBe(neighbour));
  });

  it('does not repair a selection whose pages are still on their way', async () => {
    const h = await setup();
    await waitFor(() => expect(loaded()).toBe(PAGE));
    await loadMore(2 * PAGE);
    const pick = listOf(h.backend, h.first)[2 * PAGE - 1]?.path as string;
    await paletteOpen(pick);
    await waitFor(() => expect(selectedPath(h.store)).toBe(pick));
    const release = h.hold(isLookup);
    const asked = h.requests.filter(isLookup).length;
    // A new file sorts before it and pushes it past the loaded rows; its lookup is held.
    await act(async () => {
      h.backend.mutate(h.first, 'add');
    });
    await waitFor(() => expect(h.requests.filter(isLookup).length).toBeGreaterThan(asked));
    // Another render meanwhile (the eye: the list's visibility changes).
    await press(h.user, 'h');
    await press(h.user, 'h');
    expect(selectedPath(h.store)).toBe(pick);
    release();
    await waitFor(() => expect(loaded()).toBeGreaterThan(2 * PAGE));
    expect(selectedPath(h.store)).toBe(pick);
  });
});

describe('n in the tree layout pages from the daemon order (review 2)', () => {
  it('asks after the last loaded file of the list, not the last row of the tree', async () => {
    const h = await setup();
    await waitFor(() => expect(loaded()).toBe(PAGE));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Tree view' }));
    });
    await screen.findByTestId('stub-tree');
    for (let n = 2; n <= 5; n++) await loadMore(n * PAGE);
    expect(loaded()).toBe(5 * PAGE);
    const list = listOf(h.backend, h.first);
    const shown = sortFilesTreeOrder(list.slice(0, 5 * PAGE));
    const lastRow = shown[shown.length - 1]?.path as string;
    // The case under test: the tree's last row is not the last loaded file.
    expect(lastRow).not.toBe(list[5 * PAGE - 1]?.path);
    await paletteOpen(lastRow);
    await waitFor(() => expect(selectedPath(h.store)).toBe(lastRow));
    await press(h.user, 'n');
    // Nothing after the selection is loaded in the tree: the first file past the loaded pages.
    await waitFor(() => expect(selectedPath(h.store)).toBe(list[5 * PAGE]?.path));
    const ask = h.requests.filter(isAsk).at(-1) ?? '';
    expect(decodeURIComponent(ask)).toContain(`after=${list[5 * PAGE - 1]?.path}`);
  });
});

describe('a page that keeps failing (review 3)', () => {
  it('retries a bounded number of times, then offers a retry button', async () => {
    filesPaging.pageSize = 10; // short enough that the list's end is in view: it loads on its own
    const h = await setup();
    h.fail.matches = isPage;
    await waitFor(() => expect(loaded()).toBe(10));
    const failing = () => h.requests.filter(isPage).length;
    await screen.findByRole('button', { name: 'Retry' });
    const settled = failing();
    // 1 + 3 delayed retries, then nothing more on its own.
    expect(settled).toBe(4);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(failing()).toBe(settled);
    expect(screen.getByRole('alert').textContent).toContain('Could not load more files');
    // A manual retry tries again (and backs off again, still bounded).
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    await screen.findByRole('button', { name: 'Retry' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(failing()).toBe(settled + 4);
    // Once the daemon answers, a retry loads the page.
    h.fail.matches = null;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    await waitFor(() => expect(loaded()).toBeGreaterThan(10));
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('navigations the user overtook select nothing (review 4)', () => {
  it('a palette jump still loading is dropped when the user moves on', async () => {
    const h = await setup();
    await waitFor(() => expect(loaded()).toBe(PAGE));
    const list = listOf(h.backend, h.first);
    await waitFor(() => expect(selectedPath(h.store)).toBe(list[0]?.path));
    const release = h.hold(isLookup);
    await paletteOpen(list[FILES - 5]?.path as string);
    await waitFor(() => expect(h.requests.some(isLookup)).toBe(true));
    await press(h.user, 'j');
    expect(selectedPath(h.store)).toBe(list[1]?.path);
    release();
    await waitFor(() => expect(loaded()).toBeGreaterThan(FILES - 5));
    expect(selectedPath(h.store)).toBe(list[1]?.path);
  });

  it('a palette jump whose pages fail selects nothing', async () => {
    const h = await setup();
    await waitFor(() => expect(loaded()).toBe(PAGE));
    const list = listOf(h.backend, h.first);
    await waitFor(() => expect(selectedPath(h.store)).toBe(list[0]?.path));
    const target = list[FILES - 5]?.path as string;
    // Every selection the app makes from here (a repair could hide a wrong one again).
    const seen: string[] = [];
    const stop = h.store.subscribe(() => {
      const selected = h.store.getState().selected;
      if (selected) seen.push(selected.path);
    });
    h.fail.matches = isPage;
    await paletteOpen(target);
    await screen.findByText(/Could not load the file list to open that file/);
    stop();
    expect(seen).not.toContain(target);
    expect(selectedPath(h.store)).toBe(list[0]?.path);
  });

  it('j at the end of the loaded rows: a later k wins over the pending step', async () => {
    const h = await setup();
    await waitFor(() => expect(loaded()).toBe(PAGE));
    const list = listOf(h.backend, h.first);
    await paletteOpen(list[PAGE - 1]?.path as string);
    await waitFor(() => expect(selectedPath(h.store)).toBe(list[PAGE - 1]?.path));
    const release = h.hold(isPage);
    await press(h.user, 'j');
    await waitFor(() => expect(h.requests.some(isPage)).toBe(true));
    await press(h.user, 'k');
    expect(selectedPath(h.store)).toBe(list[PAGE - 2]?.path);
    release();
    await waitFor(() => expect(loaded()).toBe(2 * PAGE));
    expect(selectedPath(h.store)).toBe(list[PAGE - 2]?.path);
  });

  it('j at the end of the loaded rows: switching worktrees (J) drops the pending step', async () => {
    const h = await setup();
    await waitFor(() => expect(loaded()).toBe(PAGE));
    const list = listOf(h.backend, h.first);
    await paletteOpen(list[PAGE - 1]?.path as string);
    await waitFor(() => expect(selectedPath(h.store)).toBe(list[PAGE - 1]?.path));
    const release = h.hold((url) => isPage(url) && url.includes(`/worktrees/${h.first}/`));
    await press(h.user, 'j');
    await waitFor(() => expect(h.requests.some(isPage)).toBe(true));
    await press(h.user, '{Shift>}J{/Shift}');
    await waitFor(() => {
      const view = h.store.getState().view;
      expect(view.kind === 'worktree' && view.worktreeId !== h.first).toBe(true);
    });
    const view = h.store.getState().view;
    const other = view.kind === 'worktree' ? view.worktreeId : '';
    const first = listOf(h.backend, other)[0]?.path;
    await waitFor(() => expect(selectedPath(h.store)).toBe(first));
    release();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(h.store.getState().selected?.worktreeId).toBe(other);
    expect(selectedPath(h.store)).toBe(first);
  });

  it('n still asking the daemon is dropped when the user moves on', async () => {
    const h = await setup();
    // Every loaded file and a few more reviewed: `n` has to ask.
    markFirst(h.backend, h.first, 2 * PAGE + 5);
    await waitFor(() => expect(loaded()).toBe(PAGE));
    const list = listOf(h.backend, h.first);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    });
    await waitFor(() => expect(loaded()).toBe(2 * PAGE));
    await paletteOpen(list[PAGE + 2]?.path as string);
    await waitFor(() => expect(selectedPath(h.store)).toBe(list[PAGE + 2]?.path));
    // Marks are on the mock only: refresh what the app holds, so `n` must ask past 40.
    await act(async () => {
      await h.qc.invalidateQueries();
    });
    const release = h.hold(isAsk);
    await press(h.user, 'n');
    await waitFor(() => expect(h.requests.some(isAsk)).toBe(true));
    await press(h.user, 'k');
    expect(selectedPath(h.store)).toBe(list[PAGE + 1]?.path);
    const pages = h.requests.filter(isPage).length;
    release();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(selectedPath(h.store)).toBe(list[PAGE + 1]?.path);
    expect(screen.getByTestId(TEST_IDS.diffViewer).getAttribute('data-path')).toBe(
      list[PAGE + 1]?.path,
    );
    // An `n` the user overtook loads nothing either.
    expect(h.requests.filter(isPage).length).toBe(pages);
  });

  it('n loading the list through its answer is dropped when the user moves on', async () => {
    const h = await setup();
    markFirst(h.backend, h.first, 2 * PAGE + 5);
    await waitFor(() => expect(loaded()).toBe(PAGE));
    const list = listOf(h.backend, h.first);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    });
    await waitFor(() => expect(loaded()).toBe(2 * PAGE));
    await paletteOpen(list[PAGE + 2]?.path as string);
    await waitFor(() => expect(selectedPath(h.store)).toBe(list[PAGE + 2]?.path));
    await act(async () => {
      await h.qc.invalidateQueries();
    });
    // The daemon answers at once; the page through the answer is held.
    const release = h.hold(isPage);
    const pages = h.requests.filter(isPage).length;
    await press(h.user, 'n');
    await waitFor(() => expect(h.requests.filter(isPage).length).toBeGreaterThan(pages));
    await press(h.user, 'k');
    expect(selectedPath(h.store)).toBe(list[PAGE + 1]?.path);
    release();
    await waitFor(() => expect(loaded()).toBeGreaterThan(2 * PAGE));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(selectedPath(h.store)).toBe(list[PAGE + 1]?.path);
  });
});

describe('a selection lookup belongs to its scope (review of PR #97, second round)', () => {
  it('switching to a partly loaded scope without the file hands the selection over', async () => {
    const h = await setup();
    // A worktree whose working list has, as its last row after some Load more, a file that sorts
    // after the file `add` creates (src/agent/…) and is not in its unstaged list (which is longer
    // than a page).
    const ids = h.backend
      .listProjects()
      .projects.flatMap((p) => p.worktrees.map((w) => w.worktree.id));
    let pick: { id: string; rows: number; path: string } | null = null;
    for (const id of ids) {
      const work = listOf(h.backend, id);
      const unstaged = new Set(
        h.backend.listFiles(id, { kind: 'unstaged' }, { limit: 2000 }).files.map((f) => f.path),
      );
      for (const rows of [2 * PAGE, 3 * PAGE, 4 * PAGE, 5 * PAGE]) {
        const f = work[rows - 1];
        if (f && f.path > 'src/agent/' && !unstaged.has(f.path) && unstaged.size > PAGE) {
          pick = { id, rows, path: f.path };
          break;
        }
      }
      if (pick) break;
    }
    if (!pick) throw new Error('no worktree fits the scenario');
    const { id, rows, path } = pick;
    if (id !== h.first) {
      const row = screen
        .getAllByTestId(TEST_IDS.worktreeItem)
        .find((el) => el.dataset.worktreeId === id);
      if (!row) throw new Error('no sidebar row');
      await act(async () => {
        fireEvent.click(row);
      });
    }
    await waitFor(() => expect(loaded()).toBe(PAGE));
    while (loaded() < rows) await loadMore(loaded() + PAGE);
    expect(loaded()).toBe(rows);
    await paletteOpen(path);
    await waitFor(() => expect(selectedPath(h.store)).toBe(path));
    // A new file pushes it past the loaded rows: the lookup loads through it (its record: found).
    const lookups = h.requests.filter(isLookup).length;
    await act(async () => {
      h.backend.mutate(id, 'add');
    });
    await waitFor(() => expect(h.requests.filter(isLookup).length).toBeGreaterThan(lookups));
    await waitFor(() => expect(loaded()).toBeGreaterThan(rows));
    expect(selectedPath(h.store)).toBe(path);
    // Another scope, partly loaded, without that file: the selection is handed over.
    await act(async () => {
      fireEvent.change(screen.getByTestId(TEST_IDS.scopeSelect), { target: { value: 'unstaged' } });
    });
    const unstaged = orderFiles(
      h.backend.listFiles(id, { kind: 'unstaged' }, { limit: 2000 }).files,
    );
    await waitFor(() => expect(selectedPath(h.store)).toBe(unstaged[0]?.path));
    expect(h.store.getState().selected?.worktreeId).toBe(id);
  });
});

describe('keys of the paging code carry what they depend on (PR #97, second round)', () => {
  it('j at the end of the loaded rows loads the next page and steps into it', async () => {
    const h = await setup();
    await waitFor(() => expect(loaded()).toBe(PAGE));
    const list = listOf(h.backend, h.first);
    await paletteOpen(list[PAGE - 1]?.path as string);
    await waitFor(() => expect(selectedPath(h.store)).toBe(list[PAGE - 1]?.path));
    await press(h.user, 'j');
    await waitFor(() => expect(loaded()).toBe(2 * PAGE));
    await waitFor(() => expect(selectedPath(h.store)).toBe(list[PAGE]?.path));
  });

  it('j at the end of the loaded rows: switching the layout drops the pending step', async () => {
    const h = await setup();
    await waitFor(() => expect(loaded()).toBe(PAGE));
    const list = listOf(h.backend, h.first);
    await paletteOpen(list[PAGE - 1]?.path as string);
    await waitFor(() => expect(selectedPath(h.store)).toBe(list[PAGE - 1]?.path));
    const release = h.hold(isPage);
    await press(h.user, 'j');
    await waitFor(() => expect(h.requests.some(isPage)).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Tree view' }));
    });
    await screen.findByTestId('stub-tree');
    release();
    await waitFor(() => expect(loaded()).toBe(2 * PAGE));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // The step was for the list the user saw before the switch.
    expect(selectedPath(h.store)).toBe(list[PAGE - 1]?.path);
  });

  it("the palette's file search follows the list's state", async () => {
    const h = await setup();
    await waitFor(() => expect(loaded()).toBe(PAGE));
    const list = listOf(h.backend, h.first);
    const i = revertable(list, PAGE + 10);
    const path = list[i]?.path as string;
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    const input = await screen.findByTestId(TEST_IDS.commandPaletteInput);
    await act(async () => {
      fireEvent.change(input, { target: { value: path } });
    });
    const items = () =>
      screen
        .queryAllByTestId(TEST_IDS.commandPaletteItem)
        .filter((el) => el.dataset.kind === 'file' && el.textContent?.startsWith(`File${path}`));
    await waitFor(() => expect(items()).toHaveLength(1));
    // The file goes from the worktree while the palette is open: its result goes too.
    await act(async () => {
      h.backend.mutate(h.first, 'revert', path);
    });
    await waitFor(() => expect(items()).toHaveLength(0));
  });
});
