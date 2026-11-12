// @vitest-environment jsdom
import { createApiClient, type ServerEvent, TEST_IDS } from '@octopus-diff/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockBackend, type MockDataset } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { App } from '../src/App.tsx';
import type { EventSourceLike } from '../src/api/hooks.ts';
import { createQueryClient } from '../src/api/queries.ts';
import { scopeForPref } from '../src/state/prefs.ts';
import { actions, createUiStore, type UiStore } from '../src/state/ui.tsx';

// @pierre/diffs needs a real browser (web components, workers); stub the renderer.
vi.mock('../src/components/diff/DiffRenderer.tsx', () => ({
  DiffRenderer: ({ patch, mode }: { patch: string; mode: string }) => (
    <pre data-testid="stub-diff" data-mode={mode}>
      {patch}
    </pre>
  ),
}));

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
  requests: string[];
}

function setup(
  dataset: MockDataset = 'demo',
  opts: { token?: string; latencyMs?: number; lastWorktree?: string } = {},
): Harness {
  const backend = new MockBackend({ dataset });
  const mockFetch = createMockFetch(backend, {
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.latencyMs ? { latencyMs: opts.latencyMs } : {}),
  });
  const requests: string[] = [];
  const api = createApiClient({
    baseUrl: 'http://mock.local',
    fetch: (input, init) => {
      requests.push(`${init?.method ?? 'GET'} ${input}`);
      return mockFetch(input, init);
    },
  });
  // The Settled shelf is closed by default; these tests read settled rows, so open it.
  // An older (non status-flow) mock has no To review range: the tests use Uncommitted, which the
  // app used to fall back to for such daemons before #10 made To review always available.
  const store = createUiStore(
    {
      settledOpen: true,
      scope: scopeForPref('working'),
      ...(opts.lastWorktree ? { lastWorktree: opts.lastWorktree } : {}),
    },
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
const viewer = () => screen.getByTestId(TEST_IDS.diffViewer);
const viewerPath = () => viewer().getAttribute('data-path');

async function ready() {
  await waitFor(() => expect(app().getAttribute('data-ready')).toBe('true'));
  await waitFor(() => expect(viewer().getAttribute('data-state')).toBe('ready'));
}

/** The sidebar row of a project's branch (`data-branch`, `data-project-name`). */
function rowOf(branch: string | null, project?: string): HTMLElement {
  const row = screen
    .getAllByTestId(TEST_IDS.worktreeItem)
    .find(
      (el) =>
        (branch === null ? !el.dataset.branch : el.dataset.branch === branch) &&
        (project === undefined || el.dataset.projectName === project),
    );
  if (!row) throw new Error(`no row for ${project ?? ''} ${branch}`);
  return row;
}
const currentWorktree = () =>
  document
    .querySelector(`[data-testid="${TEST_IDS.worktreeItem}"][aria-current="true"]`)
    ?.getAttribute('data-worktree-id');

async function press(user: Harness['user'], keys: string) {
  await act(async () => {
    await user.keyboard(keys);
  });
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  document.documentElement.className = '';
});

describe('app shell', () => {
  it('lands on the top row of the flat list and opens its first file (#83)', async () => {
    const { store } = setup();
    await ready();
    // No Inbox, no project or folder headers: just worktree rows, and the first one is open.
    expect(screen.queryByTestId(TEST_IDS.inboxItem)).toBeNull();
    const top = screen.getAllByTestId(TEST_IDS.worktreeItem)[0] as HTMLElement;
    expect(currentWorktree()).toBe(top.dataset.worktreeId);
    expect(store.getState().view).toMatchObject({
      kind: 'worktree',
      worktreeId: top.dataset.worktreeId,
    });
    expect(screen.getByTestId('context-bar').dataset.view).toBe('worktree');
    expect(screen.queryByTestId(TEST_IDS.projectItem)).toBeNull();
    expect(
      screen.getAllByTestId(TEST_IDS.worktreeItem).filter((el) => el.dataset.dirty === 'true'),
    ).toHaveLength(5);
    const auth = screen
      .getAllByTestId(TEST_IDS.worktreeItem)
      .find((el) => el.getAttribute('data-branch') === 'feat/auth');
    expect(auth?.dataset).toMatchObject({
      dirty: 'true',
      ahead: '4',
      behind: '0',
      conflicted: '1',
    });
    const infra = screen
      .getAllByTestId(TEST_IDS.worktreeItem)
      .find((el) => el.getAttribute('data-branch') === 'trunk');
    // No default branch and no upstream: ahead/behind are null → empty attributes.
    expect(infra?.dataset).toMatchObject({ dirty: 'false', ahead: '', behind: '' });
    // One worktree is open: one group of files.
    expect(screen.getAllByTestId(TEST_IDS.fileGroup)).toHaveLength(1);
    expect(viewerPath()).toBe('README.md');
  });

  it('opens the worktree that was open last when the app loads again (#83)', async () => {
    const probe = setup();
    await ready();
    const other = rowOf('fix/cache');
    fireEvent.click(other);
    await waitFor(() => expect(currentWorktree()).toBe(other.dataset.worktreeId));
    expect(probe.store.getState().lastWorktree).toBe(other.dataset.worktreeId);
    cleanup();
    // A new page with the same prefs: the store starts at `none` with the remembered id.
    const again = setup('demo', { lastWorktree: other.dataset.worktreeId });
    await ready();
    expect(currentWorktree()).toBe(other.dataset.worktreeId);
    expect(again.store.getState().view).toMatchObject({ worktreeId: other.dataset.worktreeId });
  });

  it('shows an empty state that says what to do when the filters hide every worktree (#83)', async () => {
    const { store, user } = setup();
    await ready();
    expect(screen.queryByTestId('no-worktree')).toBeNull();
    // Nothing is open once the landing ran and the list is empty: close the worktree, then filter.
    act(() => {
      store.setState({ view: { kind: 'none' }, filterWorktrees: ['nothing-matches'] });
    });
    // A filter that matches no worktree id leaves no row to land on.
    const empty = await screen.findByTestId('no-worktree');
    expect(empty.textContent).toContain('hide every worktree');
    expect(screen.queryByTestId(TEST_IDS.worktreeItem)).toBeNull();
    // The way back: "Clear filters" lists the worktrees again and lands on the top row.
    await user.click(within(empty).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.queryByTestId('no-worktree')).toBeNull());
    await waitFor(() =>
      expect(currentWorktree()).toBe(
        screen.getAllByTestId(TEST_IDS.worktreeItem)[0]?.dataset.worktreeId,
      ),
    );
    // And the other button opens the folder picker.
    act(() => {
      store.setState({ view: { kind: 'none' }, filterWorktrees: ['nothing-matches'] });
    });
    await user.click(
      within(await screen.findByTestId('no-worktree')).getByRole('button', {
        name: /Add repositories/,
      }),
    );
    expect(store.getState().addProjectOpen).toBe(true);
  });

  it('lands again on the top row when the open worktree disappears (#83)', async () => {
    const { store } = setup();
    await ready();
    const top = screen.getAllByTestId(TEST_IDS.worktreeItem)[0] as HTMLElement;
    act(() => {
      store.setState({ view: { kind: 'worktree', worktreeId: 'removed-meanwhile' } });
    });
    await waitFor(() => expect(currentWorktree()).toBe(top.dataset.worktreeId));
  });

  it('has no Inbox: no sidebar entry, no palette command, no `g i`, no Inbox view (#83)', async () => {
    const { user, store } = setup();
    await ready();
    expect(screen.queryByTestId(TEST_IDS.inboxItem)).toBeNull();
    expect(document.querySelector('[data-view="inbox"]')).toBeNull();
    await press(user, '{Control>}k{/Control}');
    const palette = await screen.findByTestId(TEST_IDS.commandPalette);
    const input = within(palette).getByTestId(TEST_IDS.commandPaletteInput);
    await user.type(input, 'inbox');
    // Nothing is called Inbox, whatever the fuzzy match finds.
    expect(
      within(palette)
        .queryAllByTestId(TEST_IDS.commandPaletteItem)
        .some((i) => /inbox/i.test(i.textContent ?? '')),
    ).toBe(false);
    await press(user, '{Escape}');
    // The help dialog does not list it either.
    await press(user, '?');
    expect(within(screen.getByTestId(TEST_IDS.helpDialog)).queryByText(/Inbox/)).toBeNull();
    expect(store.getState().view.kind).toBe('worktree');
  });

  it('falls back to the top row when the remembered worktree is gone (#83)', async () => {
    const { store } = setup('demo', { lastWorktree: 'gone' });
    await ready();
    const top = screen.getAllByTestId(TEST_IDS.worktreeItem)[0] as HTMLElement;
    expect(currentWorktree()).toBe(top.dataset.worktreeId);
    expect(store.getState().lastWorktree).toBe(top.dataset.worktreeId);
  });

  it('shows the empty state and adds a project by typing its path', async () => {
    const { user } = setup('empty');
    await waitFor(() => screen.getByTestId(TEST_IDS.emptyState));
    const input = screen.getByTestId(TEST_IDS.folderPickerInput);
    await user.clear(input);
    await user.type(input, '/home/dev/code/fresh');
    await user.click(screen.getByTestId(TEST_IDS.addProjectSubmit));
    await ready();
    expect(screen.getAllByTestId(TEST_IDS.worktreeItem)[0]?.dataset.projectName).toBe('fresh');
  });

  describe('folder picker', () => {
    const picker = () => screen.getByTestId(TEST_IDS.folderPicker);
    const input = () => screen.getByTestId(TEST_IDS.folderPickerInput) as HTMLInputElement;
    const names = () =>
      screen
        .queryAllByTestId(TEST_IDS.folderPickerEntry)
        .map((el) => el.getAttribute('data-path')?.split('/').pop());
    const row = (name: string) => {
      const el = screen
        .getAllByTestId(TEST_IDS.folderPickerEntry)
        .find((r) => r.getAttribute('data-path')?.endsWith(`/${name}`));
      if (!el) throw new Error(`no row ${name}`);
      return el;
    };
    const listed = (path: string) =>
      waitFor(() => expect(picker().getAttribute('data-path')).toBe(path));

    it('starts at home, hides dot folders, and opens a folder by clicking it', async () => {
      const { user } = setup('empty');
      await listed('/home/dev');
      expect(input().value).toBe('~/');
      expect(names()).toEqual(['code', 'Documents', 'Downloads']);
      expect(picker().textContent).toContain('2 hidden folders');
      await user.click(row('code'));
      await listed('/home/dev/code');
      expect(input().value).toBe('~/code/');
      expect(row('fresh').getAttribute('data-kind')).toBe('repo');
      expect(row('scratch').getAttribute('data-kind')).toBe('dir');
      expect(picker().textContent).toContain('~/code has 2 repositories directly inside');
    });

    it('adds a repository straight from its row and marks it added', async () => {
      const { user } = setup('empty');
      await listed('/home/dev');
      await user.click(row('code'));
      await listed('/home/dev/code');
      await user.click(within(row('side-project')).getByTestId(TEST_IDS.folderPickerEntryAdd));
      await ready();
      expect(screen.getAllByTestId(TEST_IDS.worktreeItem)[0]?.dataset.projectName).toBe(
        'side-project',
      );
    });

    it('filters as you type, completes with Tab and watches with Enter', async () => {
      const { user, backend } = setup('empty');
      await listed('/home/dev');
      await user.click(input());
      await user.type(input(), 'code/s');
      await listed('/home/dev/code');
      expect(names()).toEqual(['scratch', 'side-project']);
      await user.type(input(), 'c');
      expect(names()).toEqual(['scratch']);
      await user.keyboard('{Tab}');
      await listed('/home/dev/code/scratch');
      expect(input().value).toBe('~/code/scratch/');
      expect(document.activeElement).toBe(input());
      expect(picker().textContent).toContain('has 1 repository directly inside');
      await user.keyboard('{Enter}');
      await waitFor(() =>
        expect(backend.scanRoots.map((r) => r.path)).toContain('/home/dev/code/scratch'),
      );
    });

    it('moves with the arrows: Enter opens the highlighted row, .. goes up', async () => {
      const { user } = setup('empty');
      await listed('/home/dev');
      await user.click(input());
      await user.type(input(), 'code/');
      await listed('/home/dev/code');
      await user.keyboard('{ArrowDown}');
      expect(screen.getByTestId(TEST_IDS.folderPickerUp).getAttribute('aria-selected')).toBe(
        'true',
      );
      await user.keyboard('{Enter}');
      await listed('/home/dev');
      expect(input().value).toBe('~/');
      await user.type(input(), '.');
      expect(names()).toEqual(['.cache', '.config']);
    });

    it('says when a typed folder does not exist and disables the actions', async () => {
      const { user } = setup('empty');
      await listed('/home/dev');
      await user.type(input(), 'nope');
      await waitFor(() => expect(picker().textContent).toContain('No folder named “nope” in ~'));
      expect(screen.getByTestId(TEST_IDS.addProjectSubmit)).toHaveProperty('disabled', true);
      expect(screen.getByTestId(TEST_IDS.addScanRootSubmit)).toHaveProperty('disabled', true);
    });

    it('keeps focus in the text box when a row is clicked', async () => {
      const { user } = setup('empty');
      await listed('/home/dev');
      await user.click(input());
      await user.click(row('code'));
      await listed('/home/dev/code');
      expect(document.activeElement).toBe(input());
    });

    it('a pasted full path replaces the prefilled folder and is unquoted', async () => {
      const { user } = setup('empty');
      await listed('/home/dev');
      await user.click(input());
      input().setSelectionRange(2, 2);
      await user.paste("'/home/dev/code/scratch'");
      expect(input().value).toBe('/home/dev/code/scratch');
      input().select(); // a WSL path copied from Windows Explorer, over the whole box
      await user.paste('\\\\wsl.localhost\\Ubuntu\\home\\dev\\code\\');
      expect(input().value).toBe('/home/dev/code');
    });

    it('the dialog opens a repository once added, and opens an added one instead', async () => {
      const { user, store } = setup();
      await ready();
      fireEvent.click(screen.getByTestId(TEST_IDS.addProjectButton));
      // The start folder was loaded before the dialog opened: no loading flash.
      await screen.findByTestId(TEST_IDS.folderPickerInput);
      expect(names()).toContain('code');
      await user.type(input(), 'code/octopus-api');
      await waitFor(() => expect(row('octopus-api').dataset.registered).toBe('true'));
      const button = () => screen.getByRole('button', { name: /^Open/ });
      expect(button().dataset.action).toBe('open');
      await user.keyboard('{Enter}');
      await waitFor(() => expect(screen.queryByTestId(TEST_IDS.folderPicker)).toBeNull());
      expect(store.getState().view.kind).toBe('worktree');

      fireEvent.click(screen.getByTestId(TEST_IDS.addProjectButton));
      await screen.findByTestId(TEST_IDS.folderPickerInput);
      await user.type(input(), 'code/fresh');
      await waitFor(() =>
        expect(screen.getByTestId(TEST_IDS.addProjectSubmit)).toHaveProperty('disabled', false),
      );
      await user.keyboard('{Enter}');
      await waitFor(() => expect(screen.queryByTestId(TEST_IDS.folderPicker)).toBeNull());
      const view = store.getState().view;
      expect(view.kind).toBe('project');
      await screen.findByRole('heading', { level: 1, name: 'fresh' });
    });

    it('opens in the start folder from Settings', async () => {
      const { store } = setup('empty');
      store.setState({ folderStart: '~/code' });
      await waitFor(() => expect(input().value).toBe('~/code/'));
      await listed('/home/dev/code');
    });

    it('../ in the palette starts from the repository in view', async () => {
      const { user, store, backend } = setup();
      await ready();
      const api = backend.projects.find((p) => p.project.name === 'octopus-api');
      const main = api?.worktrees.find((w) => w.worktree.isMain)?.worktree;
      if (!main) throw new Error('no octopus-api main worktree');
      act(() => store.setState({ view: { kind: 'worktree', worktreeId: main.id } }));
      await press(user, '{Control>}k{/Control}');
      const palette = await screen.findByTestId(TEST_IDS.commandPalette);
      await user.type(within(palette).getByTestId(TEST_IDS.commandPaletteInput), '../');
      await waitFor(() => expect(names()).toContain('octopus-api'));
      expect(names()).toContain('fresh');
    });

    it('the palette browses when its text is a path, and adds with Enter', async () => {
      const { user, store } = setup();
      await ready();
      await press(user, '{Control>}k{/Control}');
      const palette = await screen.findByTestId(TEST_IDS.commandPalette);
      const box = within(palette).getByTestId(TEST_IDS.commandPaletteInput) as HTMLInputElement;
      await user.type(box, 'add repos');
      expect(within(palette).getAllByTestId(TEST_IDS.commandPaletteItem)[0]?.dataset.id).toBe(
        'cmd:addRepositories',
      );
      await press(user, '{Enter}');
      await waitFor(() => expect(box.value).toBe('~/'));
      await waitFor(() =>
        expect(within(palette).queryAllByTestId(TEST_IDS.folderPickerEntry).length).toBeGreaterThan(
          0,
        ),
      );
      await user.type(box, 'code/s');
      await waitFor(() => expect(names()).toEqual(['scratch', 'side-project']));
      await user.keyboard('{Tab}');
      expect(box.value).toBe('~/code/s');
      await user.type(box, 'i');
      await user.keyboard('{Tab}');
      await waitFor(() => expect(box.value).toBe('~/code/side-project/'));
      expect(document.activeElement).toBe(box);
      await user.keyboard('{Enter}');
      await waitFor(() => expect(screen.queryByTestId(TEST_IDS.commandPalette)).toBeNull());
      expect(store.getState().view.kind).toBe('project');
      await screen.findByRole('heading', { level: 1, name: 'side-project' });
    });
  });

  it('explains how to authenticate on 401', async () => {
    setup('demo', { token: 'secret' });
    const banner = await screen.findByTestId(TEST_IDS.errorBanner);
    expect(banner.getAttribute('data-kind')).toBe('auth');
    expect(banner.textContent).toContain('octopus-diff serve');
    expect(app().getAttribute('data-ready')).toBe('false');
  });
});

describe('keyboard', () => {
  it('j/k move between files and J/K between worktrees; g i is not bound (#83)', async () => {
    const { user, store } = setup();
    await ready();
    expect(viewerPath()).toBe('README.md');
    await press(user, 'j');
    expect(viewerPath()).toBe('src/server/router.ts');
    await press(user, 'k');
    expect(viewerPath()).toBe('README.md');

    // J/K walk the sidebar's flat list, top to bottom (most recent activity first). The landing
    // view is the first row: K there stays on it (there is no Inbox above it).
    const order = screen
      .getAllByTestId(TEST_IDS.worktreeItem)
      .map((el) => el.dataset.worktreeId as string);
    expect(currentWorktree()).toBe(order[0]);
    await press(user, 'K');
    expect(currentWorktree()).toBe(order[0]);
    await press(user, 'J');
    await waitFor(() => expect(currentWorktree()).toBe(order[1]));
    await press(user, 'J');
    await waitFor(() => expect(currentWorktree()).toBe(order[2]));
    await press(user, 'K');
    await waitFor(() => expect(currentWorktree()).toBe(order[1]));
    await press(user, 'K');
    await waitFor(() => expect(currentWorktree()).toBe(order[0]));
    await press(user, 'K');
    expect(currentWorktree()).toBe(order[0]);
    expect(store.getState().view.kind).toBe('worktree');

    // `g i` was "go to the Inbox": it is not bound any more, and `g` alone is not swallowed.
    fireEvent.click(rowOf('fix/cache'));
    await waitFor(() => expect(viewerPath()).toBe('src/lib/cache.ts'));
    const before = store.getState().view;
    await press(user, 'gi');
    expect(store.getState().view).toBe(before);
    expect(viewerPath()).toBe('src/lib/cache.ts');
    const g = new KeyboardEvent('keydown', { key: 'g', bubbles: true, cancelable: true });
    window.dispatchEvent(g);
    expect(g.defaultPrevented).toBe(false);
  });

  it('r toggles reviewed optimistically and n jumps to the next unreviewed file', async () => {
    const { user, requests } = setup();
    await ready();
    const toggle = () => screen.getByTestId(TEST_IDS.reviewToggle);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    await press(user, 'r');
    // Optimistic: the toggle flips before any refetch.
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    await waitFor(() =>
      expect(requests.some((r) => r.startsWith('PUT http://mock.local/api/review'))).toBe(true),
    );
    const item = document.querySelector(
      `[data-testid="${TEST_IDS.fileItem}"][data-path="README.md"]`,
    );
    expect(item?.getAttribute('data-reviewed')).toBe('true');

    await press(user, 'n');
    expect(viewerPath()).toBe('src/server/router.ts');
    await press(user, 'r');
    // Hide reviewed files: the two reviewed files leave the list.
    fireEvent.click(screen.getByTestId(TEST_IDS.showReviewedToggle));
    await waitFor(() =>
      expect(
        document.querySelector(`[data-testid="${TEST_IDS.fileItem}"][data-path="README.md"]`),
      ).toBeNull(),
    );
    expect(screen.getByTestId(TEST_IDS.showReviewedToggle).getAttribute('aria-pressed')).toBe(
      'false',
    );
    // Showing reviewed files again brings them back, with their checkmark.
    fireEvent.click(screen.getByTestId(TEST_IDS.showReviewedToggle));
    await waitFor(() =>
      expect(
        document
          .querySelector(`[data-testid="${TEST_IDS.fileItem}"][data-path="README.md"]`)
          ?.getAttribute('data-reviewed'),
      ).toBe('true'),
    );
  });

  it('n crosses projects from a worktree view and switches worktree', async () => {
    const { user, store } = setup();
    await ready();
    fireEvent.click(
      screen
        .getAllByTestId(TEST_IDS.worktreeItem)
        .find((el) => el.dataset.branch === 'fix/cache') as HTMLElement,
    );
    await waitFor(() => expect(viewerPath()).toBe('src/lib/cache.ts'));
    await press(user, 'j'); // test/cache.test.ts, the last file of fix/cache
    expect(viewerPath()).toBe('test/cache.test.ts');
    await press(user, 'n'); // next worktree in sidebar order with unreviewed files: web-dashboard main
    await waitFor(() => expect(viewerPath()).toBe('package.json'));
    const view = store.getState().view;
    expect(view.kind === 'worktree' && view.worktreeId).toBe(
      viewer().getAttribute('data-worktree-id'),
    );
  });

  it('n and J/K from an Overview open a worktree (#83)', async () => {
    const { user, store } = setup();
    await ready();
    const rows = screen.getAllByTestId(TEST_IDS.worktreeItem);
    const projectId = (rows[0] as HTMLElement).dataset.projectId as string;
    act(() => actions.setView(store, { kind: 'project', projectId }));
    await screen.findByRole('heading', { level: 1 });
    await press(user, 'n');
    await waitFor(() => expect(store.getState().view.kind).toBe('worktree'));
    expect(store.getState().selected).not.toBeNull();
    act(() => actions.setView(store, { kind: 'project', projectId }));
    await press(user, 'J');
    await waitFor(() =>
      expect(store.getState().view).toMatchObject({
        kind: 'worktree',
        worktreeId: (rows[0] as HTMLElement).dataset.worktreeId,
      }),
    );
  });

  it('s toggles split/unified and shortcuts do not fire while typing', async () => {
    const { user } = setup();
    await ready();
    const modeToggle = screen.getByTestId(TEST_IDS.diffModeToggle);
    expect(modeToggle.getAttribute('data-mode')).toBe('split');
    await press(user, 's');
    expect(modeToggle.getAttribute('data-mode')).toBe('unified');
    expect(viewer().getAttribute('data-mode')).toBe('unified');

    // `/` opens the filter dropdown with its search focused; typing searches the options.
    await press(user, '/');
    const search = screen.getByTestId(TEST_IDS.sidebarFilterSearch) as HTMLInputElement;
    expect(document.activeElement).toBe(search);
    await press(user, 'cache');
    expect(search.value).toBe('cache');
    expect(viewer().getAttribute('data-mode')).toBe('unified'); // 's' was typed, not a shortcut
    expect(viewerPath()).toBe('README.md'); // 'c','a','h','e' did nothing either
    const worktreeOptions = screen
      .getAllByTestId(TEST_IDS.sidebarFilterOption)
      .filter((o) => o.dataset.kind === 'worktree');
    expect(worktreeOptions[0]?.textContent).toContain('fix/cache');
    // Enter picks the best match (status options do not match "cache"): one worktree shows.
    await press(user, '{Enter}');
    expect(worktreeOptions[0]?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByTestId(TEST_IDS.worktreeItem)).toHaveLength(1);
    await press(user, '{Escape}');
    expect(search.value).toBe('');
    await press(user, '{Escape}');
    expect(screen.queryByTestId(TEST_IDS.sidebarFilterSearch)).toBeNull();
    const trigger = screen.getByTestId(TEST_IDS.sidebarFilter);
    expect(document.activeElement).toBe(trigger);
    expect(trigger.dataset.filtering).toBe('true');
    expect(trigger.textContent).toContain('fix/cache');
    fireEvent.click(screen.getByTestId(TEST_IDS.sidebarFilterClear));
    expect(screen.getAllByTestId(TEST_IDS.worktreeItem).length).toBeGreaterThan(1);

    await press(user, '?');
    expect(screen.getByTestId(TEST_IDS.helpDialog)).toBeTruthy();
    await press(user, '{Escape}');
    expect(screen.queryByTestId(TEST_IDS.helpDialog)).toBeNull();
  });
});

describe('scopes and placeholders', () => {
  async function openAuth(user: Harness['user']) {
    fireEvent.click(
      screen
        .getAllByTestId(TEST_IDS.worktreeItem)
        .find((el) => el.dataset.branch === 'feat/auth') as HTMLElement,
    );
    await screen.findByTestId(TEST_IDS.fileList);
    await waitFor(() => expect(viewer().getAttribute('data-path')).toBe('assets/logo.png'));
    void user;
  }
  async function openFile(path: string) {
    const list = await screen.findByTestId(TEST_IDS.fileList);
    // jsdom has no layout, so pick the row through the commands instead of scrolling.
    let item = within(list)
      .queryAllByTestId(TEST_IDS.fileItem)
      .find((el) => el.dataset.path === path);
    for (let i = 0; i < 40 && !item; i++) {
      fireEvent.keyDown(window, { key: 'j' });
      item = within(list)
        .queryAllByTestId(TEST_IDS.fileItem)
        .find((el) => el.dataset.path === path);
    }
    if (!item) throw new Error(`file ${path} not rendered`);
    fireEvent.click(item);
    await waitFor(() => expect(viewerPath()).toBe(path));
    await waitFor(() => expect(viewer().getAttribute('data-state')).toBe('ready'));
  }
  const placeholderKind = () =>
    screen.queryByTestId(TEST_IDS.diffPlaceholder)?.getAttribute('data-kind');

  it('shows placeholders for binary, submodule, symlink, too-large and truncated diffs', async () => {
    const { user } = setup();
    await ready();
    await openAuth(user);
    await openFile('assets/logo.png');
    expect(placeholderKind()).toBe('binary');
    await openFile('config/current.json');
    expect(placeholderKind()).toBe('symlink');
    await openFile('data/fixtures.min.json');
    expect(placeholderKind()).toBe('too-large');
    fireEvent.click(screen.getByTestId(TEST_IDS.diffLoadAnyway));
    await waitFor(() => expect(placeholderKind()).toBe('truncated'));
    expect((await screen.findByTestId('stub-diff')).textContent?.length).toBeGreaterThan(1000);
    await openFile('scripts/deploy.sh');
    expect(placeholderKind()).toBe('empty');
  });

  it('changes scope and requests the matching files', async () => {
    const { requests, store } = setup();
    await ready();
    const select = screen.getByTestId(TEST_IDS.scopeSelect) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'staged' } });
    await waitFor(() => expect(select.getAttribute('data-scope')).toBe('staged'));
    await waitFor(() =>
      expect(requests.some((r) => r.includes('/api/inbox?scope=staged'))).toBe(true),
    );
    await waitFor(() => expect(viewer().getAttribute('data-state')).toBe('ready'));
    // Commit scope is offered with a worktree open (the app always lands on one).
    const commitOption = within(select).getByRole('option', {
      name: /Commit/,
    }) as HTMLOptionElement;
    expect(commitOption.disabled).toBe(false);
    fireEvent.click(rowOf('main', 'web-dashboard'));
    await waitFor(() => expect(commitOption.disabled).toBe(false));
    fireEvent.change(select, { target: { value: 'commit' } });
    await waitFor(() => expect(select.getAttribute('data-scope')).toMatch(/^commit:[0-9a-f]{40}$/));
    await waitFor(() =>
      expect(requests.some((r) => /files\?scope=commit&sha=/.test(r))).toBe(true),
    );
    // Leaving the worktree for a project's Overview resets commit scope to working.
    act(() =>
      actions.setView(store, {
        kind: 'project',
        projectId: rowOf('main', 'web-dashboard').dataset.projectId as string,
      }),
    );
    await waitFor(() => expect(store.getState().scope.kind).toBe('working'));
  });

  it('whitespace toggle requests ignoreWhitespace and keeps the file', async () => {
    const { requests, user } = setup();
    await ready();
    await openAuth(user);
    await openFile('src/format.ts');
    fireEvent.click(screen.getByTestId(TEST_IDS.whitespaceToggle));
    await waitFor(() =>
      expect(requests.some((r) => r.includes('ignoreWhitespace=true'))).toBe(true),
    );
    await waitFor(() => expect(placeholderKind()).toBe('empty'));
    expect(viewerPath()).toBe('src/format.ts');
  });
});

describe('live updates', () => {
  it('refreshes on worktree.changed, keeps the selection and shows the updated banner', async () => {
    const { backend, requests } = setup();
    await ready();
    fireEvent.click(
      screen
        .getAllByTestId(TEST_IDS.worktreeItem)
        .find((el) => el.dataset.branch === 'feat/auth') as HTMLElement,
    );
    await waitFor(() => expect(viewer().getAttribute('data-state')).toBe('ready'));
    await waitFor(() => expect(viewerPath()).toBe('assets/logo.png'));
    fireEvent.click(
      within(await screen.findByTestId(TEST_IDS.fileList))
        .getAllByTestId(TEST_IDS.fileItem)
        .find((el) => el.dataset.path === 'src/auth/session.ts') as HTMLElement,
    );
    await waitFor(() => expect(viewerPath()).toBe('src/auth/session.ts'));
    await waitFor(() => expect(viewer().getAttribute('data-state')).toBe('ready'));
    const hash = viewer().getAttribute('data-patch-hash');
    const worktreeId = viewer().getAttribute('data-worktree-id') ?? '';
    const before = requests.length;

    act(() => {
      backend.mutate(worktreeId, 'edit', 'src/auth/session.ts');
    });
    await waitFor(() => expect(viewer().getAttribute('data-patch-hash')).not.toBe(hash));
    expect(viewerPath()).toBe('src/auth/session.ts');
    expect(screen.getByTestId(TEST_IDS.diffUpdatedBanner)).toBeTruthy();
    const refetched = requests.slice(before);
    expect(refetched.some((r) => r.includes(`/api/worktrees/${worktreeId}/files`))).toBe(true);
    expect(refetched.some((r) => r.includes(`/api/worktrees/${worktreeId}/diff`))).toBe(true);
    // Other worktrees' files are not refetched.
    expect(refetched.filter((r) => r.includes('/files') && !r.includes(worktreeId))).toHaveLength(
      0,
    );
  });

  it('applies the event delta (#51): no /api/projects refetch, the open diff stays when another file moves', async () => {
    const { backend, requests } = setup();
    await ready();
    fireEvent.click(
      screen
        .getAllByTestId(TEST_IDS.worktreeItem)
        .find((el) => el.dataset.branch === 'feat/auth') as HTMLElement,
    );
    await waitFor(() => expect(viewer().getAttribute('data-state')).toBe('ready'));
    fireEvent.click(
      within(await screen.findByTestId(TEST_IDS.fileList))
        .getAllByTestId(TEST_IDS.fileItem)
        .find((el) => el.dataset.path === 'src/auth/session.ts') as HTMLElement,
    );
    await waitFor(() => expect(viewerPath()).toBe('src/auth/session.ts'));
    await waitFor(() => expect(viewer().getAttribute('data-state')).toBe('ready'));
    const worktreeId = viewer().getAttribute('data-worktree-id') ?? '';
    const hash = viewer().getAttribute('data-patch-hash');
    const row = () =>
      screen
        .getAllByTestId(TEST_IDS.worktreeItem)
        .find((el) => el.dataset.worktreeId === worktreeId) as HTMLElement;
    const additions = row().getAttribute('data-additions');
    const before = requests.length;

    act(() => {
      backend.mutate(worktreeId, 'edit', 'src/format.ts');
    });
    // The sidebar follows the event's row; the file list follows its refetch.
    await waitFor(() => expect(row().getAttribute('data-additions')).not.toBe(additions));
    await waitFor(() =>
      expect(
        requests
          .slice(before)
          .filter((r) => r.includes(`/api/worktrees/${worktreeId}/files?scope=working`)),
      ).toHaveLength(1),
    );
    await new Promise((r) => setTimeout(r, 50));
    const after = requests.slice(before);
    expect(after.filter((r) => r.includes('/api/projects'))).toEqual([]);
    expect(after.filter((r) => r.includes('/diff'))).toEqual([]);
    expect(viewerPath()).toBe('src/auth/session.ts');
    expect(viewer().getAttribute('data-patch-hash')).toBe(hash);
  });

  it('a live edit in the Inbox shows the refresh indicator, though it refetches no list (#51)', async () => {
    // A network round trip takes time; an instant mock answer would settle within one render.
    const { backend, requests } = setup('demo', { latencyMs: 40 });
    await ready();
    const indicator = screen.getByTestId(TEST_IDS.refreshIndicator);
    await waitFor(() => expect(indicator.getAttribute('data-state')).toBe('idle'));
    const states: string[] = [];
    const observer = new MutationObserver(() => {
      states.push(indicator.getAttribute('data-state') ?? '');
    });
    observer.observe(indicator, { attributes: true, attributeFilter: ['data-state'] });
    const worktreeId = screen
      .getAllByTestId(TEST_IDS.worktreeItem)
      .find((el) => el.dataset.branch === 'fix/cache')?.dataset.worktreeId;
    const before = requests.length;
    act(() => {
      backend.mutate(worktreeId, 'edit', 'src/lib/cache.ts');
    });
    await waitFor(() => expect(states).toContain('refreshing'));
    await waitFor(() => expect(indicator.getAttribute('data-state')).toBe('idle'));
    observer.disconnect();
    const after = requests.slice(before);
    expect(after.filter((r) => r.includes('worktreeIds='))).toHaveLength(1);
    expect(after.filter((r) => r.includes('/api/projects'))).toEqual([]);
  });

  it('a reverted open file hands the selection to its neighbor', async () => {
    const { backend } = setup();
    await ready();
    fireEvent.click(
      screen
        .getAllByTestId(TEST_IDS.worktreeItem)
        .find((el) => el.dataset.branch === 'fix/cache') as HTMLElement,
    );
    await waitFor(() => expect(viewerPath()).toBe('src/lib/cache.ts'));
    const worktreeId = viewer().getAttribute('data-worktree-id') ?? '';
    act(() => {
      // Mutation "revert" removes a random editable file; target the open one.
      backend.mutate(worktreeId, 'revert', 'src/lib/cache.ts');
    });
    await waitFor(() => expect(viewerPath()).toBe('test/cache.test.ts'));
  });

  it('reports focus to the daemon', async () => {
    const { backend } = setup();
    await ready();
    fireEvent.click(
      screen
        .getAllByTestId(TEST_IDS.worktreeItem)
        .find((el) => el.dataset.branch === 'fix/cache') as HTMLElement,
    );
    const id = screen
      .getAllByTestId(TEST_IDS.worktreeItem)
      .find((el) => el.dataset.branch === 'fix/cache')?.dataset.worktreeId;
    await waitFor(() => expect(backend.focus).toBe(id));
  });
});
