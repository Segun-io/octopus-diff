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
import { createUiStore, type UiStore } from '../src/state/ui.tsx';

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

function setup(dataset: MockDataset = 'demo', opts: { token?: string } = {}): Harness {
  const backend = new MockBackend({ dataset });
  const mockFetch = createMockFetch(backend, opts.token ? { token: opts.token } : {});
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
  const store = createUiStore({ settledOpen: true, scope: scopeForPref('working') }, false);
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
  it('renders the inbox, sidebar items and opens the first file', async () => {
    setup();
    await ready();
    // #13: no Inbox entry and no project or folder headers in the sidebar, just worktree rows;
    // the landing view is still the cross-worktree list of changed files (5 dirty worktrees).
    expect(screen.queryByTestId(TEST_IDS.inboxItem)).toBeNull();
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
    expect(screen.getAllByTestId(TEST_IDS.fileGroup)).toHaveLength(5);
    expect(viewerPath()).toBe('content/intro.md');
    expect((await screen.findByTestId('stub-diff')).textContent).toContain('<<<<<<< HEAD');
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
  it('j/k move between files and J/K between worktrees; g i returns to the inbox', async () => {
    const { user, store } = setup();
    await ready();
    await press(user, 'j');
    expect(viewerPath()).toBe('README.md');
    await press(user, 'j');
    expect(viewerPath()).toBe('src/server/router.ts');
    await press(user, 'k');
    expect(viewerPath()).toBe('README.md');

    // J/K walk the sidebar's flat list, top to bottom (most recent activity first).
    const order = screen
      .getAllByTestId(TEST_IDS.worktreeItem)
      .map((el) => el.dataset.worktreeId as string);
    const current = () =>
      document
        .querySelector(`[data-testid="${TEST_IDS.worktreeItem}"][aria-current="true"]`)
        ?.getAttribute('data-worktree-id');
    await press(user, 'J');
    await waitFor(() => expect(current()).toBe(order[0]));
    await press(user, 'J');
    await waitFor(() => expect(current()).toBe(order[1]));
    await press(user, 'K');
    await press(user, 'K');
    await waitFor(() => expect(store.getState().view.kind).toBe('inbox'));

    fireEvent.click(
      screen
        .getAllByTestId(TEST_IDS.worktreeItem)
        .find((el) => el.dataset.branch === 'fix/cache') as HTMLElement,
    );
    await waitFor(() => expect(viewerPath()).toBe('src/lib/cache.ts'));
    await press(user, 'gi');
    await waitFor(() => expect(store.getState().view.kind).toBe('inbox'));
    // Selection survives the view change because the file is in the inbox too.
    expect(viewerPath()).toBe('src/lib/cache.ts');
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
      `[data-testid="${TEST_IDS.fileItem}"][data-path="content/intro.md"]`,
    );
    expect(item?.getAttribute('data-reviewed')).toBe('true');

    await press(user, 'n');
    expect(viewerPath()).toBe('README.md');
    await press(user, 'r');
    await press(user, 'n');
    expect(viewerPath()).toBe('src/server/router.ts');
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
    expect(viewerPath()).toBe('content/intro.md'); // 'c','a','h','e' did nothing either
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
    const { requests, user } = setup();
    await ready();
    const select = screen.getByTestId(TEST_IDS.scopeSelect) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'staged' } });
    await waitFor(() => expect(select.getAttribute('data-scope')).toBe('staged'));
    await waitFor(() =>
      expect(requests.some((r) => r.includes('/api/inbox?scope=staged'))).toBe(true),
    );
    await waitFor(() => expect(viewer().getAttribute('data-state')).toBe('ready'));
    // Commit scope is only offered with a worktree selected.
    const commitOption = within(select).getByRole('option', {
      name: /Commit/,
    }) as HTMLOptionElement;
    expect(commitOption.disabled).toBe(true);
    fireEvent.click(
      screen
        .getAllByTestId(TEST_IDS.worktreeItem)
        .find((el) => el.dataset.branch === 'feat/auth') as HTMLElement,
    );
    await waitFor(() => expect(commitOption.disabled).toBe(false));
    fireEvent.change(select, { target: { value: 'commit' } });
    await waitFor(() => expect(select.getAttribute('data-scope')).toMatch(/^commit:[0-9a-f]{40}$/));
    await waitFor(() =>
      expect(requests.some((r) => /files\?scope=commit&sha=/.test(r))).toBe(true),
    );
    // Going back to the inbox (`g i`; the sidebar has no Inbox entry any more) resets commit
    // scope to working.
    await press(user, 'gi');
    await waitFor(() => expect(select.getAttribute('data-scope')).toBe('working'));
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
