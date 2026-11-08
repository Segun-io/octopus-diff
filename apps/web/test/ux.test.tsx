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
import { createUiStore, type UiStore } from '../src/state/ui.tsx';

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

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

interface Harness {
  backend: MockBackend;
  store: UiStore;
  user: ReturnType<typeof userEvent.setup>;
  requests: { method: string; url: string; body: unknown }[];
}

function setup(
  dataset: MockDataset = 'demo',
  opts: {
    wrap?: (fetch: Fetch) => Fetch;
    store?: Partial<Parameters<typeof createUiStore>[0]>;
  } = {},
): Harness {
  const backend = new MockBackend({ dataset });
  const base = createMockFetch(backend);
  const mockFetch = opts.wrap ? opts.wrap(base) : base;
  const requests: Harness['requests'] = [];
  const api = createApiClient({
    baseUrl: 'http://mock.local',
    fetch: (input, init) => {
      const method = init?.method ?? 'GET';
      requests.push({
        method,
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return mockFetch(input, init);
    },
  });
  const store = createUiStore({ confirmBulk: false, ...opts.store }, false);
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

async function ready() {
  await waitFor(() => expect(app().getAttribute('data-ready')).toBe('true'));
  await waitFor(() => expect(viewer().getAttribute('data-state')).toBe('ready'));
}

async function press(user: Harness['user'], keys: string) {
  await act(async () => {
    await user.keyboard(keys);
  });
}

function bodyOf<T>(request: Harness['requests'][number] | undefined): T {
  if (!request) throw new Error('request not found');
  return request.body as T;
}

function worktreeOf(projectName: string, branch: string): HTMLElement {
  const project = screen
    .getAllByTestId(TEST_IDS.projectItem)
    .find((p) => p.dataset.projectName === projectName);
  const el = screen
    .getAllByTestId(TEST_IDS.worktreeItem)
    .find((e) => e.dataset.branch === branch && e.dataset.projectId === project?.dataset.projectId);
  if (!el) throw new Error(`no worktree ${projectName} ${branch}`);
  return el;
}

function worktreeItem(branch: string): HTMLElement {
  const el = screen.getAllByTestId(TEST_IDS.worktreeItem).find((e) => e.dataset.branch === branch);
  if (!el) throw new Error(`no worktree item ${branch}`);
  return el;
}

/** Makes `/api/settings` (and the other new routes) 404 like an older daemon. */
function olderDaemon(fetch: Fetch): Fetch {
  return async (input, init) => {
    const url = String(input);
    if (/\/api\/(settings|review-policy|review\/bulk|review\/undo)/.test(url)) {
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no route' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const res = await fetch(input, init);
    // Older daemons also do not attach `review` to projects and inbox entries.
    if (/\/api\/(projects|inbox)(\?|$)/.test(url) && (init?.method ?? 'GET') === 'GET') {
      const body = await res.json();
      for (const p of body.projects ?? []) for (const w of p.worktrees) delete w.review;
      for (const e of body.entries ?? []) delete e.review;
      return new Response(JSON.stringify(body), {
        status: res.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return res;
  };
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  document.documentElement.className = '';
  document.documentElement.removeAttribute('data-theme');
});

describe('settings screen', () => {
  it('opens with , and the gear, has six sections, toggles the daemon default and closes with Esc', async () => {
    const { user, requests, backend } = setup();
    await ready();
    await press(user, ',');
    const dialog = await screen.findByTestId(TEST_IDS.settingsDialog);
    const sections = within(dialog).getAllByTestId(TEST_IDS.settingsSection);
    expect(sections.map((s) => s.dataset.section)).toEqual([
      'general',
      'review',
      'appearance',
      'folders',
      'keyboard',
      'about',
    ]);
    fireEvent.click(sections[1] as HTMLElement);
    const toggle = await within(dialog).findByTestId(TEST_IDS.settingsReviewDefault);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('false'));
    expect(
      requests.find((r) => r.method === 'PATCH' && r.url.endsWith('/api/settings'))?.body,
    ).toEqual({
      review: { defaultEnabled: false },
    });
    expect(backend.settings.review.defaultEnabled).toBe(false);
    // the overrides table lists the demo overrides
    expect(within(dialog).getAllByRole('row').length).toBeGreaterThanOrEqual(3);
    await press(user, '{Escape}');
    await waitFor(() => expect(screen.queryByTestId(TEST_IDS.settingsDialog)).toBeNull());
    fireEvent.click(screen.getByTestId(TEST_IDS.settingsOpenButton));
    await screen.findByTestId(TEST_IDS.settingsDialog);
  });

  it('theme picker switches themes and persists a v2 preference', async () => {
    const { user, store } = setup();
    await ready();
    await press(user, ',');
    const dialog = await screen.findByTestId(TEST_IDS.settingsDialog);
    fireEvent.click(within(dialog).getAllByTestId(TEST_IDS.settingsSection)[2] as HTMLElement);
    const picker = await within(dialog).findByTestId(TEST_IDS.themePicker);
    const options = within(picker).getAllByTestId(TEST_IDS.themeOption);
    expect(options.map((o) => o.dataset.themeId)).toEqual([
      'octopus-dark',
      'octopus-light',
      'octopus-contrast',
    ]);
    fireEvent.click(options[2] as HTMLElement);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('octopus-contrast'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(store.getState().theme).toEqual({
      mode: 'dark',
      light: 'octopus-light',
      dark: 'octopus-contrast',
    });
    fireEvent.click(options[1] as HTMLElement);
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('octopus-light'));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    // t flips the mode only; the slots keep their themes
    await press(user, '{Escape}');
    await press(user, 't');
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('octopus-contrast'));
  });

  it('hides policy and bulk controls against an older daemon', async () => {
    const { user } = setup('demo', { wrap: olderDaemon });
    await ready();
    fireEvent.click(worktreeItem('feat/auth'));
    await waitFor(() => expect(viewer().getAttribute('data-worktree-id')).not.toBe(''));
    expect(screen.queryByTestId(TEST_IDS.reviewPolicyChip)).toBeNull();
    expect(screen.queryByTestId(TEST_IDS.markAllButton)).toBeNull();
    expect(screen.queryByTestId(TEST_IDS.reviewOffBadge)).toBeNull();
    await press(user, 'R');
    expect(screen.queryByTestId(TEST_IDS.bulkReviewToast)).toBeNull();
    await press(user, ',');
    const dialog = await screen.findByTestId(TEST_IDS.settingsDialog);
    fireEvent.click(within(dialog).getAllByTestId(TEST_IDS.settingsSection)[1] as HTMLElement);
    await within(dialog).findByText(/no settings API/);
    expect(within(dialog).queryByTestId(TEST_IDS.settingsReviewDefault)).toBeNull();
  });
});

describe('mark all as verified', () => {
  it('marks the visible files of a worktree, shows the toast and undoes', async () => {
    const { requests, backend } = setup();
    await ready();
    fireEvent.click(worktreeItem('feat/auth'));
    const button = await screen.findByTestId(TEST_IDS.markAllButton);
    await waitFor(() => expect(button.dataset.count).toBe('19'));
    expect(button.dataset.target).toBe('worktree');
    fireEvent.click(button);
    const toast = await screen.findByTestId(TEST_IDS.bulkReviewToast);
    expect(toast.dataset.changed).toBe('19');
    expect(toast.dataset.reviewed).toBe('true');
    const bulk = requests.find((r) => r.url.endsWith('/api/review/bulk'));
    expect(bulk?.body).toMatchObject({
      target: { kind: 'worktree' },
      reviewed: true,
      expectedStateHashes: expect.any(Object),
    });
    expect(bodyOf<{ paths: unknown[] }>(bulk).paths).toHaveLength(19);
    await waitFor(() =>
      expect(
        screen.getAllByTestId(TEST_IDS.fileItem).every((f) => f.dataset.reviewed === 'true'),
      ).toBe(true),
    );
    expect(backend.reviews.size).toBe(19);
    fireEvent.click(screen.getByTestId(TEST_IDS.bulkReviewUndo));
    await waitFor(() => expect(backend.reviews.size).toBe(0));
    await waitFor(() =>
      expect(
        screen.getAllByTestId(TEST_IDS.fileItem).every((f) => f.dataset.reviewed === 'false'),
      ).toBe(true),
    );
    expect(screen.getByTestId(TEST_IDS.bulkReviewToast).textContent).toContain('Undone');
  });

  it('Shift+R in the Inbox marks everything with one all request; Ctrl+Z undoes; confirm asks first', async () => {
    const { user, requests, backend, store } = setup();
    await ready();
    await press(user, 'R');
    const toast = await screen.findByTestId(TEST_IDS.bulkReviewToast);
    expect(toast.dataset.changed).toBe('30');
    const bulk = requests.find((r) => r.url.endsWith('/api/review/bulk'));
    expect(bulk?.body).toMatchObject({ target: { kind: 'all' } });
    expect(
      Object.keys(bodyOf<{ expectedStateHashes: object }>(bulk).expectedStateHashes),
    ).toHaveLength(5);
    await press(user, '{Control>}z{/Control}');
    await waitFor(() => expect(backend.reviews.size).toBe(0));

    store.setState({ confirmBulk: true });
    await press(user, 'R');
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain('Across 5 worktrees');
    fireEvent.click(within(confirm).getByText(/^Mark verified$/));
    await waitFor(() => expect(backend.reviews.size).toBe(30));
  });

  it('respects a hidden-reviewed filter: only unreviewed visible files are sent', async () => {
    const { store, requests } = setup();
    await ready();
    fireEvent.click(worktreeItem('fix/cache'));
    const button = await screen.findByTestId(TEST_IDS.markAllButton);
    await waitFor(() => expect(button.dataset.count).toBe('2'));
    // mark one file by hand, hide reviewed, then mark all: one path
    fireEvent.click(screen.getByTestId(TEST_IDS.reviewToggle));
    await waitFor(() => expect(button.dataset.count).toBe('1'));
    store.setState({ showReviewed: false });
    fireEvent.click(button);
    await screen.findByTestId(TEST_IDS.bulkReviewToast);
    const bulk = requests.find((r) => r.url.endsWith('/api/review/bulk'));
    expect(bodyOf<{ paths: unknown[] }>(bulk).paths).toHaveLength(1);
  });
});

describe('review policy', () => {
  it('chip shows the effective policy; turning a worktree off hides review controls and n skips it', async () => {
    const { user, backend } = setup();
    await ready();
    fireEvent.click(worktreeItem('fix/cache'));
    const chip = await screen.findByTestId(TEST_IDS.reviewPolicyChip);
    expect(chip.dataset).toMatchObject({ enabled: 'true', source: 'default' });
    fireEvent.click(chip);
    const menu = await screen.findByTestId(TEST_IDS.reviewPolicyMenu);
    const items = within(menu).getAllByTestId(TEST_IDS.reviewPolicyItem);
    expect(items.map((i) => i.dataset.target)).toEqual([
      'worktree',
      'worktree',
      'worktree',
      'branch',
      'branch',
      'branch',
      'project',
      'project',
      'project',
      'folder',
      'folder',
      'folder',
    ]);
    const off = items.find((i) => i.dataset.target === 'worktree' && i.dataset.state === 'off');
    fireEvent.click(off as HTMLElement);
    await waitFor(() =>
      expect(chip.dataset).toMatchObject({ enabled: 'false', source: 'worktree' }),
    );
    expect(backend.overrides.size).toBe(3);
    await waitFor(() =>
      expect(within(worktreeItem('fix/cache')).getByTestId(TEST_IDS.reviewOffBadge)).toBeTruthy(),
    );
    expect(screen.queryByTestId(TEST_IDS.reviewToggle)).toBeNull();
    // the sidebar badge count is gone, the group header says review off in the inbox
    await press(user, 'gi');
    await waitFor(() => expect(screen.getAllByTestId(TEST_IDS.fileGroup).length).toBe(5));
    // n never lands in the disabled worktree
    const visited = new Set<string>();
    for (let i = 0; i < 30; i++) {
      await press(user, 'n');
      visited.add(viewer().getAttribute('data-worktree-id') ?? '');
    }
    expect(visited.has(worktreeItem('fix/cache').dataset.worktreeId ?? '')).toBe(false);
    // inherit again from the menu
    fireEvent.click(worktreeItem('fix/cache'));
    fireEvent.click(await screen.findByTestId(TEST_IDS.reviewPolicyChip));
    const inherit = within(await screen.findByTestId(TEST_IDS.reviewPolicyMenu))
      .getAllByTestId(TEST_IDS.reviewPolicyItem)
      .find((i) => i.dataset.target === 'worktree' && i.dataset.state === 'inherit');
    fireEvent.click(inherit as HTMLElement);
    await waitFor(() => expect(backend.overrides.size).toBe(2));
  });

  it('shows the demo overrides as badges with their source', async () => {
    setup();
    await ready();
    const badges = await screen.findAllByTestId(TEST_IDS.reviewOffBadge);
    expect(badges.map((b) => b.dataset.source).sort()).toEqual(['branch', 'project', 'project']);
  });
});

describe('F2: review marks what is displayed', () => {
  it('r sends the patchHash of the diff on screen, not the list entry', async () => {
    const shownHash = 'f'.repeat(40);
    const { user, requests } = setup('demo', {
      wrap: (fetch) => async (input, init) => {
        const res = await fetch(input, init);
        if (String(input).includes('/diff?')) {
          const body = await res.json();
          body.diff.patchHash = shownHash;
          body.diff.reviewed = false;
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return res;
      },
    });
    await ready();
    await press(user, 'r');
    await waitFor(() =>
      expect(requests.some((r) => r.method === 'PUT' && r.url.endsWith('/api/review'))).toBe(true),
    );
    const put = requests.find((r) => r.method === 'PUT' && r.url.endsWith('/api/review'));
    expect(put?.body).toMatchObject({ patchHash: shownHash, reviewed: true });
    // the button reflects the displayed diff's state
    await waitFor(() =>
      expect(screen.getByTestId(TEST_IDS.reviewToggle).getAttribute('aria-pressed')).toBe('true'),
    );
  });
});

describe('folder tier, overview and palette', () => {
  it('indexes projects under their folder with an "Added directly" group, collapses and persists', async () => {
    const { store } = setup();
    await ready();
    const sidebar = screen.getByTestId(TEST_IDS.sidebar);
    const folders = [...sidebar.querySelectorAll<HTMLElement>('[data-folder-id]')];
    expect(folders.map((f) => f.textContent?.includes('Added directly'))).toEqual([false, true]);
    const code = folders[0] as HTMLElement;
    expect(
      within(code)
        .getAllByTestId(TEST_IDS.projectItem)
        .map((p) => p.dataset.projectName),
    ).toEqual(['docs-site', 'octopus-api', 'web-dashboard']);
    // main vs linked and the source chip
    expect(worktreeItem('feat/auth').dataset).toMatchObject({ main: 'false', source: 't3' });
    expect(worktreeItem('fix/cache').dataset).toMatchObject({ main: 'false', source: 'claude' });
    expect(worktreeItem('main').dataset.main).toBe('true');
    // collapse the folder: its project rows disappear from the index, the pref persists
    fireEvent.click(within(code).getByLabelText('Collapse folder'));
    expect(within(code).queryAllByTestId(TEST_IDS.projectItem)).toHaveLength(0);
    expect(store.getState().collapsed).toEqual([code.dataset.folderId]);
    fireEvent.click(within(code).getByLabelText('Expand folder'));
    expect(within(code).queryAllByTestId(TEST_IDS.projectItem)).toHaveLength(3);
  });

  it('partitions worktrees into cards and a settled tail; marks settle, pins lift', async () => {
    const { store, backend } = setup();
    await ready();
    const sidebar = screen.getByTestId(TEST_IDS.sidebar);
    const section = (name: string) =>
      [
        ...sidebar.querySelectorAll<HTMLElement>(
          `li[data-section="${name}"] [data-testid="worktree-item"]`,
        ),
      ].map((el) => el.dataset.branch);
    // blocked first (docs-site is mid-rebase with a conflict), then the unreviewed ones in project order
    expect(section('card')).toEqual(['', 'feat/auth', 'main', 'fix/cache', 'main']);
    // settled: clean, verified, review off, missing, error: one word each, no counts
    expect(section('settled')).toEqual([
      'trunk',
      'master',
      'old-experiment',
      '',
      'agent/codex-123',
    ]);
    expect(worktreeItem('trunk').textContent).toContain('clean');
    expect(worktreeItem('agent/codex-123').dataset.state).toBe('settled');
    expect(
      within(worktreeItem('agent/codex-123')).getByTestId(TEST_IDS.reviewOffBadge).dataset.source,
    ).toBe('branch');

    // mark every file of fix/cache reviewed: it settles and says "verified"
    const cache = worktreeItem('fix/cache');
    const cacheId = cache.dataset.worktreeId as string;
    const files = backend.listFiles(cacheId, { kind: 'working' }).files;
    for (const f of files) {
      backend.setReview({
        projectId: cache.dataset.projectId as string,
        scopeKind: 'working',
        path: f.path,
        patchHash: f.patchHash,
        reviewed: true,
      });
    }
    await waitFor(() => expect(worktreeItem('fix/cache').dataset.state).toBe('settled'));
    expect(section('settled')).toContain('fix/cache');
    expect(worktreeItem('fix/cache').textContent).toContain('verified');

    // pin it: back to the top of the cards, whatever its state
    fireEvent.click(
      within(worktreeItem('fix/cache').parentElement as HTMLElement).getByLabelText(/^Actions for/),
    );
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin to the top' }));
    await waitFor(() => expect(section('card')[0]).toBe('fix/cache'));
    expect(store.getState().pinned).toEqual([cacheId]);
    expect(worktreeItem('fix/cache').textContent).toContain('pinned');

    // collapsing the settled tail hides its rows; selecting one of them reopens it
    const trunkId = worktreeItem('trunk').dataset.worktreeId as string;
    fireEvent.click(within(sidebar).getByLabelText('Collapse settled'));
    expect(section('settled')).toEqual([]);
    expect(store.getState().collapsed).toContain('settled');
    store.setState({ view: { kind: 'worktree', worktreeId: trunkId } });
    await waitFor(() => expect(section('settled')).toContain('trunk'));
    expect(store.getState().collapsed).not.toContain('settled');
  });

  it('selecting a folder or project shows the Overview; the view registry routes it', async () => {
    const { store } = setup();
    await ready();
    const sidebar = screen.getByTestId(TEST_IDS.sidebar);
    const code = sidebar.querySelector<HTMLElement>('[data-folder-id]') as HTMLElement;
    fireEvent.click(within(code).getByTitle('/home/dev/code (depth 3)'));
    expect(store.getState().view).toEqual({ kind: 'folder', scanRootId: code.dataset.folderId });
    const heading = await screen.findByRole('heading', { level: 1, name: '~/code' });
    expect(heading).toBeTruthy();
    expect(screen.queryByTestId(TEST_IDS.diffViewer)).toBeNull();
    // project rows navigate to the project overview, worktree rows to changes
    fireEvent.click(screen.getByText('octopus-api', { selector: 'td button' }));
    await screen.findByRole('heading', { level: 1, name: 'octopus-api' });
    expect(store.getState().view.kind).toBe('project');
    fireEvent.click(screen.getByText('feat/auth', { selector: 'td span' }));
    await waitFor(() => expect(store.getState().view).toMatchObject({ kind: 'worktree' }));
    await waitFor(() => expect(viewer().getAttribute('data-state')).toBe('ready'));
  });

  it('Ctrl+K opens the palette; fuzzy search and Enter navigate; commands run', async () => {
    const { user, store } = setup();
    await ready();
    await press(user, '{Control>}k{/Control}');
    const palette = await screen.findByTestId(TEST_IDS.commandPalette);
    const input = within(palette).getByTestId(TEST_IDS.commandPaletteInput);
    expect(document.activeElement).toBe(input);
    await user.type(input, 'fixcache');
    const items = within(palette).getAllByTestId(TEST_IDS.commandPaletteItem);
    expect(items[0]?.dataset.id).toContain('go:worktree:');
    expect(items[0]?.textContent).toContain('fix/cache');
    await press(user, '{Enter}');
    await waitFor(() => expect(screen.queryByTestId(TEST_IDS.commandPalette)).toBeNull());
    expect(store.getState().view).toEqual({
      kind: 'worktree',
      worktreeId: worktreeItem('fix/cache').dataset.worktreeId,
    });
    // a command: open settings → review
    await press(user, '{Control>}k{/Control}');
    await user.type(
      within(await screen.findByTestId(TEST_IDS.commandPalette)).getByTestId(
        TEST_IDS.commandPaletteInput,
      ),
      'settings review',
    );
    await press(user, '{Enter}');
    await screen.findByTestId(TEST_IDS.settingsDialog);
    expect(store.getState().settingsSection).toBe('review');
    // a theme
    await press(user, '{Escape}');
    await press(user, '{Control>}k{/Control}');
    await user.type(
      within(await screen.findByTestId(TEST_IDS.commandPalette)).getByTestId(
        TEST_IDS.commandPaletteInput,
      ),
      'theme contrast',
    );
    await press(user, '{Enter}');
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('octopus-contrast'));
  });

  it('context menu on a project offers bulk and policy actions', async () => {
    const { backend } = setup();
    await ready();
    const project = screen
      .getAllByTestId(TEST_IDS.projectItem)
      .find((p) => p.dataset.projectName === 'web-dashboard') as HTMLElement;
    fireEvent.click(within(project).getByLabelText('Actions for web-dashboard'));
    const menu = await screen.findByRole('menu');
    const off = within(menu)
      .getAllByTestId(TEST_IDS.reviewPolicyItem)
      .find((i) => i.dataset.state === 'off');
    fireEvent.click(off as HTMLElement);
    await waitFor(() => expect(backend.overrides.size).toBe(3));
    await waitFor(() =>
      expect(within(worktreeItem('main')).queryByTestId(TEST_IDS.reviewOffBadge)).toBeNull(),
    );
    const web = screen
      .getAllByTestId(TEST_IDS.worktreeItem)
      .filter((w) => w.dataset.projectId === project.dataset.projectId);
    expect(web.every((w) => within(w).queryByTestId(TEST_IDS.reviewOffBadge) !== null)).toBe(true);
  });
});

describe('F9, F10 and SEC-05', () => {
  it('switching scope does not show the "changed on disk" banner (F9)', async () => {
    // Like real git-core, give each scope its own patchHash.
    const { store } = setup('demo', {
      wrap: (fetch) => async (input, init) => {
        const res = await fetch(input, init);
        const url = String(input);
        if (url.includes('/diff?')) {
          const body = await res.json();
          body.diff.patchHash = `${body.diff.patchHash.slice(0, 32)}${body.scope.kind}`.padEnd(
            40,
            '0',
          );
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return res;
      },
    });
    await ready();
    fireEvent.click(worktreeOf('octopus-api', 'main'));
    await waitFor(() => expect(viewer().getAttribute('data-path')).toBe('README.md'));
    fireEvent.click(
      document.querySelector(
        `[data-testid="${TEST_IDS.fileItem}"][data-path="src/server/router.ts"]`,
      ) as HTMLElement,
    );
    await waitFor(() => expect(viewer().getAttribute('data-state')).toBe('ready'));
    const hashBefore = viewer().getAttribute('data-patch-hash');
    store.setState({ scope: { kind: 'staged' } });
    await waitFor(() => expect(viewer().getAttribute('data-patch-hash')).not.toBe(hashBefore));
    await waitFor(() => expect(viewer().getAttribute('data-state')).toBe('ready'));
    expect(screen.queryByTestId(TEST_IDS.diffUpdatedBanner)).toBeNull();
  });

  it('tree layout orders j/k by the tree (folders first, case-insensitive) (F10)', async () => {
    const { user, store } = setup();
    await ready();
    fireEvent.click(worktreeItem('feat/auth'));
    await waitFor(() => expect(viewer().getAttribute('data-worktree-id')).not.toBe(''));
    const order = () => store.getState().selected?.path;
    store.setState({ fileListLayout: 'tree' });
    // first entry in tree order is inside the deepest-first folder, not the byte-first path
    await waitFor(() => expect(order()).toBeDefined());
    const visited: string[] = [];
    for (let i = 0; i < 6; i++) {
      await press(user, 'j');
      visited.push(order() ?? '');
    }
    // folders (assets, config, data, docs, notes, scripts, src/…) come before top-level files
    expect(visited.every((p) => p.includes('/'))).toBe(true);
    const idx = (p: string) => visited.indexOf(p);
    expect(idx('config/current.json')).toBeLessThan(idx('data/fixtures.min.json'));
  });

  it('flags bidi / invisible characters in names and patches (SEC-05)', async () => {
    const { user } = setup();
    await ready();
    fireEvent.click(worktreeOf('web-dashboard', 'main'));
    await waitFor(() => expect(viewer().getAttribute('data-worktree-id')).not.toBe(''));
    await waitFor(() =>
      expect(screen.getAllByTestId(TEST_IDS.fileItem).map((f) => f.dataset.path)).toContain(
        'src/lib/access.ts',
      ),
    );
    const evil = document.querySelector(
      `[data-testid="${TEST_IDS.fileItem}"][data-suspicious="true"]`,
    ) as HTMLElement;
    expect(
      evil,
      screen
        .getAllByTestId(TEST_IDS.fileItem)
        .map((f) => f.dataset.path)
        .join(','),
    ).toBeTruthy();
    expect(evil.textContent).toContain('⟨U+202E⟩');
    expect(within(evil).getByRole('img', { name: /invisible or bidirectional/ })).toBeTruthy();
    fireEvent.click(
      document.querySelector(
        `[data-testid="${TEST_IDS.fileItem}"][data-path="src/lib/access.ts"]`,
      ) as HTMLElement,
    );
    const warning = await screen.findByTestId('diff-unicode-warning');
    expect(warning.textContent).toContain('U+202E');
    await waitFor(() =>
      expect(screen.getByTestId('stub-diff').textContent ?? '').toContain('⟨U+202E⟩'),
    );
    expect(screen.getByTestId('stub-diff').textContent).not.toContain('\u202E');
    await press(user, 'k');
    await waitFor(() => expect(screen.queryByTestId('diff-unicode-warning')).toBeNull());
  });
});

describe('favicon dot (P2)', () => {
  it('swaps the svg icon href to a data url with the dot and back', async () => {
    const { applyFaviconDot, FAVICON_HREF, faviconWithDot } = await import('../src/lib/favicon.ts');
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    link.setAttribute('href', '/favicon.svg');
    document.head.appendChild(link);
    applyFaviconDot(true);
    const href = link.getAttribute('href') ?? '';
    expect(href.startsWith('data:image/svg+xml,')).toBe(true);
    expect(decodeURIComponent(href)).toContain('<circle cx="26" cy="6" r="5" fill="#e0ae52"/>');
    expect(href).toBe(faviconWithDot());
    applyFaviconDot(false);
    expect(link.getAttribute('href')).toBe(FAVICON_HREF);
    link.remove();
  });
});

describe('Escape closes overlays even when focus left them (ux-e2e seam fix)', () => {
  it('settings: after the focused control disappears or is disabled, Esc still closes', async () => {
    const { user } = setup();
    await ready();
    await press(user, ',');
    const dialog = await screen.findByTestId(TEST_IDS.settingsDialog);
    fireEvent.click(within(dialog).getAllByTestId(TEST_IDS.settingsSection)[1] as HTMLElement);
    const inherit = (await within(dialog).findAllByRole('button', { name: 'Inherit' }))[0];
    if (!inherit) throw new Error('no override row');
    inherit.focus();
    fireEvent.click(inherit); // the row (and the focused button) is removed
    await waitFor(() => expect(document.activeElement).toBe(document.body));
    await press(user, '{Escape}');
    await waitFor(() => expect(screen.queryByTestId(TEST_IDS.settingsDialog)).toBeNull());
  });

  it('add-project dialog: Esc closes it after focus left the form', async () => {
    const { user } = setup();
    await ready();
    fireEvent.click(screen.getByTestId(TEST_IDS.addProjectButton));
    await screen.findByTestId(TEST_IDS.folderPickerInput);
    (document.activeElement as HTMLElement | null)?.blur?.();
    expect(document.activeElement).toBe(document.body);
    await press(user, '{Escape}');
    await waitFor(() => expect(screen.queryByTestId(TEST_IDS.folderPickerInput)).toBeNull());
  });

  it('review policy menu: Esc closes it after a choice moved focus away', async () => {
    const { user } = setup();
    await ready();
    fireEvent.click(worktreeItem('fix/cache'));
    fireEvent.click(await screen.findByTestId(TEST_IDS.reviewPolicyChip));
    const menu = await screen.findByTestId(TEST_IDS.reviewPolicyMenu);
    const off = within(menu)
      .getAllByTestId(TEST_IDS.reviewPolicyItem)
      .find((i) => i.dataset.target === 'worktree' && i.dataset.state === 'off');
    if (!off) throw new Error('no item');
    fireEvent.click(off);
    (document.activeElement as HTMLElement | null)?.blur?.();
    await waitFor(() =>
      expect(screen.getByTestId(TEST_IDS.reviewPolicyChip).dataset.enabled).toBe('false'),
    );
    expect(screen.queryByTestId(TEST_IDS.reviewPolicyMenu)).not.toBeNull();
    await press(user, '{Escape}');
    await waitFor(() => expect(screen.queryByTestId(TEST_IDS.reviewPolicyMenu)).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId(TEST_IDS.reviewPolicyChip));
  });
});
