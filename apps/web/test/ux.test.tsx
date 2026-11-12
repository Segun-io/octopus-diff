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
    statusFlow?: boolean;
  } = {},
): Harness {
  const backend = new MockBackend({ dataset, statusFlow: opts.statusFlow ?? false });
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
  // The Settled shelf is closed by default; most tests read settled rows, so open it.
  const store = createUiStore(
    {
      confirmBulk: false,
      settledOpen: true,
      // Without status flow the mock has no To review range; the app used to fall back to
      // Uncommitted for such daemons before #10 made To review always available.
      scope: scopeForPref(opts.statusFlow ? 'review' : 'working'),
      ...opts.store,
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
  const el = screen
    .getAllByTestId(TEST_IDS.worktreeItem)
    .find((e) => e.dataset.branch === branch && e.dataset.projectName === projectName);
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
  it('opens with , and the gear, has seven sections, toggles the daemon default and closes with Esc', async () => {
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
      'forges',
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

  it('About credits the open-source software, with license texts and a filter', async () => {
    const { user } = setup();
    await ready();
    await press(user, ',');
    const dialog = await screen.findByTestId(TEST_IDS.settingsDialog);
    const about = within(dialog)
      .getAllByTestId(TEST_IDS.settingsSection)
      .find((s) => s.dataset.section === 'about');
    fireEvent.click(about as HTMLElement);
    await within(dialog).findByRole('heading', { name: 'Open-source software' });
    const shipped = within(dialog).getByRole('list', { name: 'Shipped with octopus-diff' });
    const dev = within(dialog).getByRole('list', { name: 'Development tools' });
    const row = (list: HTMLElement, name: string) =>
      [...list.querySelectorAll<HTMLElement>('li[data-package]')].find(
        (li) => li.dataset.package === name,
      );
    // direct runtime dependencies, what they pull in, and dev tools, each with its license
    expect(row(shipped, 'react')?.textContent).toContain('MIT');
    expect(row(shipped, '@pierre/diffs')?.textContent).toContain('Apache-2.0');
    expect(row(shipped, 'shiki')?.textContent).toContain('via @pierre/diffs');
    expect(row(dev, 'vitest')).toBeDefined();
    expect(row(shipped, 'vitest')).toBeUndefined();
    expect(row(shipped, 'hono')?.querySelector('pre')?.textContent).toMatch(/MIT License/);
    // adapted code and the programs it runs
    expect(within(dialog).getByText('T3 Code')).toBeDefined();
    expect(within(dialog).getByText('apps/web/src/lib/folderPath.ts')).toBeDefined();
    expect(within(dialog).getByText('Git')).toBeDefined();
    // the filter narrows both lists
    await user.type(within(dialog).getByLabelText('Filter packages'), 'zod');
    expect(shipped.querySelectorAll('li[data-package]').length).toBe(1);
    expect(within(dialog).getByText('1 of', { exact: false })).toBeDefined();
    expect(within(dialog).getByText('No package matches.')).toBeDefined();
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

describe('review all', () => {
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

  /** Runs a palette command by its registry id (`cmd:<id>`) and returns the item's hint. */
  async function runPaletteCommand(user: Harness['user'], id: string): Promise<string> {
    await press(user, '{Control>}k{/Control}');
    const palette = await screen.findByTestId(TEST_IDS.commandPalette);
    await user.type(within(palette).getByTestId(TEST_IDS.commandPaletteInput), 'worktrees in the');
    const item = within(palette)
      .getAllByTestId(TEST_IDS.commandPaletteItem)
      .find((i) => i.dataset.id === id);
    if (!item) throw new Error(`no palette item ${id}`);
    const hint = item.textContent ?? '';
    fireEvent.click(item);
    await waitFor(() => expect(screen.queryByTestId(TEST_IDS.commandPalette)).toBeNull());
    return hint;
  }

  it('"Review all worktrees" (palette) marks everything with one all request; Ctrl+Z undoes; confirm asks first (#83)', async () => {
    const { user, requests, backend, store } = setup();
    await ready();
    // Shift+R now acts on the open worktree only (the Inbox view that marked everything is gone).
    expect(await runPaletteCommand(user, 'cmd:markEveryVerified')).toContain(
      '30 files to mark reviewed',
    );
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
    await runPaletteCommand(user, 'cmd:markEveryVerified');
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain('Across 5 worktrees');
    fireEvent.click(within(confirm).getByText(/^Mark reviewed$/));
    await waitFor(() => expect(backend.reviews.size).toBe(30));
    // And back: the unreviewed twin of the command counts the reviewed files.
    store.setState({ confirmBulk: false });
    expect(await runPaletteCommand(user, 'cmd:markEveryUnreviewed')).toContain(
      '30 files to mark unreviewed',
    );
    await waitFor(() => expect(backend.reviews.size).toBe(0));
  });

  it('"Review all worktrees" honours the sidebar filters: one request per listed worktree, with paths (#83)', async () => {
    const { user, requests, store, backend } = setup();
    await ready();
    const cache = worktreeItem('fix/cache').dataset.worktreeId as string;
    store.setState({ filterWorktrees: [cache] });
    await waitFor(() => expect(screen.getAllByTestId(TEST_IDS.worktreeItem)).toHaveLength(1));
    expect(await runPaletteCommand(user, 'cmd:markEveryVerified')).toContain(
      '2 files to mark reviewed',
    );
    await screen.findByTestId(TEST_IDS.bulkReviewToast);
    const bulk = requests.filter((r) => r.url.endsWith('/api/review/bulk'));
    expect(bulk).toHaveLength(1);
    expect(bulk[0]?.body).toMatchObject({ target: { kind: 'worktree', worktreeId: cache } });
    expect(bodyOf<{ paths: unknown[] }>(bulk[0]).paths).toHaveLength(2);
    expect(backend.reviews.size).toBe(2);
  });

  it('Shift+R marks the open worktree only', async () => {
    const { user, requests } = setup();
    await ready();
    fireEvent.click(worktreeItem('fix/cache'));
    await waitFor(() => expect(screen.getByTestId(TEST_IDS.markAllButton).dataset.count).toBe('2'));
    await press(user, 'R');
    await screen.findByTestId(TEST_IDS.bulkReviewToast);
    const bulk = requests.filter((r) => r.url.endsWith('/api/review/bulk'));
    expect(bulk).toHaveLength(1);
    expect(bulk[0]?.body).toMatchObject({ target: { kind: 'worktree' } });
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
    // the sidebar badge count is gone
    // n never lands in the disabled worktree
    const visited = new Set<string>();
    for (let i = 0; i < 30; i++) {
      await press(user, 'n');
      visited.add(viewer().getAttribute('data-worktree-id') ?? '');
    }
    expect(visited.has(worktreeItem('fix/cache').dataset.worktreeId ?? '')).toBe(false);
    // inherit again from the menu
    fireEvent.click(worktreeItem('fix/cache'));
    await waitFor(() =>
      expect(screen.getByTestId('context-bar-worktree').textContent).toContain('fix/cache'),
    );
    // The menu of the earlier choice is still open (it stays open for the next level); a click
    // on another row closes it in a browser (mousedown outside), which fireEvent does not send.
    const chipAgain = await screen.findByTestId(TEST_IDS.reviewPolicyChip);
    if (chipAgain.getAttribute('aria-expanded') !== 'true') fireEvent.click(chipAgain);
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
  it('lists every worktree in one flat list, newest activity first, each with its repo (#13)', async () => {
    const { backend } = setup();
    await ready();
    const sidebar = screen.getByTestId(TEST_IDS.sidebar);
    // No Inbox entry, no folder or project headers: only worktree rows (and, later, "Hidden").
    expect(screen.queryByTestId(TEST_IDS.inboxItem)).toBeNull();
    expect(screen.queryByTestId(TEST_IDS.projectItem)).toBeNull();
    expect(sidebar.querySelector('[data-folder-id]')).toBeNull();
    expect(within(sidebar).queryByLabelText(/^(Collapse|Expand) (folder|project)$/)).toBeNull();

    // The order is the summaries' `activityAt`, newest first, across every project; rows without
    // one come last (ties: project name, then main checkout first).
    const rows = [...sidebar.querySelectorAll<HTMLElement>('[data-testid="worktree-item"]')];
    const all = backend.listProjects().projects.flatMap((p) => p.worktrees);
    const at = (id: string) => {
      const iso = all.find((w) => w.worktree.id === id)?.summary?.activityAt;
      return iso ? Date.parse(iso) : null;
    };
    expect(rows).toHaveLength(all.length);
    const times = rows.map((r) => at(r.dataset.worktreeId ?? ''));
    const known = times.filter((t): t is number => t !== null);
    expect(known.length).toBeGreaterThan(3);
    expect(known).toEqual([...known].sort((a, b) => b - a));
    expect(times.slice(0, known.length).every((t) => t !== null)).toBe(true);
    // Not grouped by repository: projects interleave.
    const projectsInOrder = rows.map((r) => r.dataset.projectName);
    expect(projectsInOrder.join('|')).not.toBe([...projectsInOrder].sort().join('|'));

    // Every row names its repository, so a flat list stays readable.
    for (const row of rows) {
      expect(within(row).getByTestId('row-repo').textContent).toBe(row.dataset.projectName);
    }
    // main vs linked and the source chip
    expect(worktreeItem('feat/auth').dataset).toMatchObject({ main: 'false', source: 't3' });
    expect(worktreeItem('fix/cache').dataset).toMatchObject({ main: 'false', source: 'claude' });
    expect(worktreeOf('web-dashboard', 'main').dataset.main).toBe('true');
    // Nothing is hidden by default, so there is no Hidden section either.
    expect(within(sidebar).queryByLabelText(/hidden$/i)).toBeNull();
    // A worktree that needs no review has no special state (no "clean", no "reviewed").
    expect(worktreeItem('trunk').textContent).not.toMatch(/clean|reviewed/);
  });

  it('Hidden is the closed section of what was hidden by hand; nothing else is hidden', async () => {
    const { store, backend } = setup('demo', { store: { settledOpen: false } });
    await ready();
    const sidebar = screen.getByTestId(TEST_IDS.sidebar);
    const section = (name: string) =>
      [
        ...sidebar.querySelectorAll<HTMLElement>(
          `li[data-section="${name}"] [data-testid="worktree-item"]`,
        ),
      ].map((el) => el.dataset.branch);
    const rowActions = (branch: string) =>
      within(worktreeItem(branch).parentElement as HTMLElement);
    const total = backend.listProjects().projects.flatMap((p) => p.worktrees).length;
    expect(section('flat')).toHaveLength(total);

    // Reviewed, merged-free, review-off, failed and missing rows all stay in the list.
    expect(worktreeItem('agent/codex-123').dataset.state).toBe('settled');
    expect(worktreeItem('agent/codex-123').dataset.hidden).toBe('false');
    expect(
      within(worktreeItem('agent/codex-123')).getByTestId(TEST_IDS.reviewOffBadge).dataset.source,
    ).toBe('branch');

    // Hide until it changes: the row leaves the list for the closed Hidden section, pinned to the
    // state hash.
    fireEvent.click(rowActions('fix/cache').getByLabelText('Hide until it changes'));
    await waitFor(() => expect(section('flat')).not.toContain('fix/cache'));
    expect(section('hidden')).toEqual([]); // closed
    expect(within(sidebar).getByLabelText('Expand hidden').textContent).toContain('1');
    const cacheId = backend
      .listProjects()
      .projects.flatMap((p) => p.worktrees)
      .find((w) => w.worktree.branch === 'fix/cache')?.worktree.id as string;
    expect(store.getState().settle).toMatchObject([{ worktreeId: cacheId, state: 'settled' }]);

    // Opening the section lists it (the pref persists), and "Show again" brings it back.
    fireEvent.click(within(sidebar).getByLabelText('Expand hidden'));
    expect(section('hidden')).toEqual(['fix/cache']);
    expect(store.getState().settledOpen).toBe(true);
    expect(worktreeItem('fix/cache').dataset).toMatchObject({ hidden: 'true' });
    fireEvent.click(rowActions('fix/cache').getByLabelText('Show again'));
    await waitFor(() => expect(section('flat')).toContain('fix/cache'));
    expect(store.getState().settle).toEqual([]);

    // Hide it again; the next change to the worktree brings it back (the hide expires with the hash).
    fireEvent.click(rowActions('fix/cache').getByLabelText('Hide until it changes'));
    await waitFor(() => expect(section('hidden')).toEqual(['fix/cache']));
    backend.mutate(cacheId, 'add');
    await waitFor(() => expect(section('flat')).toContain('fix/cache'));
    await waitFor(() => expect(store.getState().settle).toEqual([]));

    // A closed section still shows the selected worktree, so J/K and palette jumps have a row.
    fireEvent.click(rowActions('trunk').getByLabelText('Hide until it changes'));
    await waitFor(() => expect(section('hidden')).toEqual(['trunk']));
    const trunkId = worktreeItem('trunk').dataset.worktreeId as string;
    fireEvent.click(within(sidebar).getByLabelText('Collapse hidden'));
    expect(section('hidden')).toEqual([]);
    act(() => store.setState({ view: { kind: 'worktree', worktreeId: trunkId } }));
    await waitFor(() => expect(section('hidden')).toEqual(['trunk']));
    expect(store.getState().settledOpen).toBe(false);
    fireEvent.click(within(sidebar).getByLabelText('Expand hidden'));
    fireEvent.click(rowActions('trunk').getByLabelText('Show again'));
    await waitFor(() => expect(section('flat')).toContain('trunk'));

    // Blocked work is never hidden: no action on the row, the menu item is disabled.
    const blocked = worktreeOf('docs-site', '');
    expect(blocked.dataset.state).toBe('blocked');
    expect(
      within(blocked.parentElement as HTMLElement).queryByLabelText('Hide until it changes'),
    ).toBeNull();
    fireEvent.contextMenu(blocked);
    const blockedItem = await screen.findByRole('menuitem', { name: 'Hide (blocked)' });
    expect(blockedItem.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(blockedItem, { key: 'Escape' });

    // Marking every file of fix/cache reviewed does not hide it: it stays in the list, quietly.
    const files = backend.listFiles(cacheId, { kind: 'working' }).files;
    for (const f of files) {
      backend.setReview({
        projectId: worktreeItem('fix/cache').dataset.projectId as string,
        scopeKind: 'working',
        path: f.path,
        patchHash: f.patchHash,
        reviewed: true,
      });
    }
    await waitFor(() => expect(worktreeItem('fix/cache').dataset.stage).toBe('reviewed'));
    expect(section('flat')).toContain('fix/cache');
    expect(worktreeItem('fix/cache').dataset.unreviewed).toBe('0');
    // Quiet: no word on the row (its tick and the screen-reader sentence say "reviewed", #14).
    const visible = worktreeItem('fix/cache').cloneNode(true) as HTMLElement;
    for (const hiddenFromSight of visible.querySelectorAll('.sr-only')) hiddenFromSight.remove();
    expect(visible.textContent).not.toMatch(/reviewed|clean/);
    expect(worktreeItem('fix/cache').dataset.indicator).toBe('reviewed');

    // Pin it: listed first, whatever its activity.
    fireEvent.contextMenu(worktreeItem('fix/cache'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin to the top' }));
    await waitFor(() => expect(section('flat')[0]).toBe('fix/cache'));
    expect(store.getState().pinned).toEqual([cacheId]);
    expect(worktreeItem('fix/cache').dataset.pinned).toBe('true');
  });

  it('status flow: To review is the default; rows say N commits; Review all moves the bookmark', async () => {
    const { user, requests } = setup('demo', {
      statusFlow: true,
      store: { scope: { kind: 'review' } },
    });
    await waitFor(() => expect(app().getAttribute('data-ready')).toBe('true'));
    const select = screen.getByTestId(TEST_IDS.scopeSelect) as HTMLSelectElement;
    expect(select.dataset.scope).toBe('review');
    const row = worktreeItem('fix/cache');
    await waitFor(() => expect(Number(row.dataset.commits)).toBeGreaterThan(0));
    expect(row.dataset.stage).toBe('review');
    expect(row.textContent).toMatch(/\d+ commits? ·/);
    fireEvent.click(row);
    await waitFor(() => expect(screen.getAllByTestId(TEST_IDS.fileItem).length).toBeGreaterThan(0));
    expect(select.textContent).toMatch(/To review \(\d+\)/);
    await press(user, 'R');
    await screen.findByTestId(TEST_IDS.bulkReviewToast);
    const bulk = requests.find((r) => r.url.endsWith('/api/review/bulk'));
    expect(bulk?.body).toMatchObject({
      target: { kind: 'worktree' },
      scope: { kind: 'review' },
      advanceBookmarks: true,
    });
    expect(bodyOf<{ paths?: unknown }>(bulk).paths).toBeUndefined();
    await waitFor(() => expect(worktreeItem('fix/cache').dataset.commits).toBe('0'));
    await waitFor(() => expect(worktreeItem('fix/cache').dataset.stage).toBe('reviewed'));
  });

  it('All on branch lists everything, To review what is left, neither has the eye; counts follow the eye elsewhere', async () => {
    const { user, store } = setup('demo', {
      statusFlow: true,
      store: { scope: { kind: 'review' }, showReviewed: false },
    });
    await waitFor(() => expect(app().getAttribute('data-ready')).toBe('true'));
    const select = screen.getByTestId(TEST_IDS.scopeSelect) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'branch',
      'review',
      'working',
      'staged',
      'unstaged',
      'commit',
    ]);
    fireEvent.click(worktreeItem('fix/cache'));
    await ready();
    const paths = () => screen.queryAllByTestId(TEST_IDS.fileItem).map((el) => el.dataset.path);
    const reviewed = () =>
      screen.queryAllByTestId(TEST_IDS.fileItem).filter((el) => el.dataset.reviewed === 'true');
    const eye = () => screen.queryByTestId(TEST_IDS.showReviewedToggle);
    const option = (kind: string) => select.querySelector(`option[value="${kind}"]`)?.textContent;

    // To review: no eye, `h` does nothing, a file marked reviewed leaves the list.
    expect(eye()).toBeNull();
    const before = paths();
    expect(before.length).toBeGreaterThan(1);
    const first = viewer().dataset.path ?? before[0];
    await press(user, 'r');
    await waitFor(() => expect(paths()).not.toContain(first));
    await press(user, 'h');
    expect(store.getState().showReviewed).toBe(false);

    // All on branch: no eye, and reviewed files are listed even though the eye pref is off.
    fireEvent.change(select, { target: { value: 'branch' } });
    await waitFor(() => expect(select.dataset.scope?.startsWith('branch')).toBe(true));
    await ready();
    expect(eye()).toBeNull();
    await press(user, 'r');
    await waitFor(() => expect(reviewed().length).toBeGreaterThan(0));
    const branchTotal = paths().length;
    expect(option('branch')).toBe(`All on branch (${branchTotal})`);

    // Uncommitted has the eye: with it off, a reviewed file leaves and the count says "x of y".
    fireEvent.change(select, { target: { value: 'working' } });
    await waitFor(() => expect(eye()).not.toBeNull());
    await ready();
    expect(eye()?.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(eye() as HTMLElement);
    await waitFor(() => expect(eye()?.getAttribute('aria-pressed')).toBe('true'));
    await waitFor(() => expect(paths().length).toBeGreaterThan(1));
    const total = paths().length;
    if (reviewed().length === 0) {
      await press(user, 'r');
      await waitFor(() => expect(reviewed().length).toBe(1));
    }
    const left = total - reviewed().length;
    expect(option('working')).toBe(`Uncommitted (${total})`);
    fireEvent.click(eye() as HTMLElement);
    await waitFor(() => expect(paths()).toHaveLength(left));
    await waitFor(() => expect(option('working')).toBe(`Uncommitted (${left} of ${total})`));
  });

  it('switching the toolbar scope never moves a sidebar row (status flow v2)', async () => {
    setup('demo');
    await ready();
    const snapshot = () =>
      screen
        .getAllByTestId(TEST_IDS.worktreeItem)
        .map((el) => {
          const section = el.closest('li[data-section]')?.getAttribute('data-section');
          return `${el.dataset.worktreeId}:${section}:${el.dataset.state}:${el.dataset.stage}:${el.dataset.unreviewed}`;
        })
        .sort();
    const before = snapshot();
    const select = screen.getByTestId(TEST_IDS.scopeSelect) as HTMLSelectElement;
    for (const kind of ['branch', 'staged', 'unstaged', 'working'] as const) {
      fireEvent.change(select, { target: { value: kind } });
      await waitFor(() => expect(select.dataset.scope?.startsWith(kind)).toBe(true));
      // let the inbox for the new scope land
      await waitFor(() => expect(app().getAttribute('data-ready')).toBe('true'));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });
      expect(snapshot(), `scope ${kind}`).toEqual(before);
    }
  });

  it("a row's menu opens the folder and project Overviews; the view registry routes them", async () => {
    const { store } = setup();
    await ready();
    // The sidebar has no folder or project headers (#13): the Overviews open from a row's menu.
    fireEvent.contextMenu(worktreeOf('web-dashboard', 'main'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Overview of web-dashboard' }));
    await screen.findByRole('heading', { level: 1, name: 'web-dashboard' });
    expect(store.getState().view.kind).toBe('project');
    fireEvent.contextMenu(worktreeOf('octopus-api', 'main'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Overview of folder ~/code' }));
    expect(store.getState().view).toMatchObject({ kind: 'folder' });
    expect(await screen.findByRole('heading', { level: 1, name: '~/code' })).toBeTruthy();
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

  it('context menu on a row offers bulk and policy actions', async () => {
    const { backend } = setup();
    await ready();
    const overridesBefore = backend.overrides.size;
    const row = worktreeOf('web-dashboard', 'main');
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Mark all reviewed' })).toBeTruthy();
    const off = within(menu)
      .getAllByTestId(TEST_IDS.reviewPolicyItem)
      .find((i) => i.dataset.target === 'worktree' && i.dataset.state === 'off');
    fireEvent.click(off as HTMLElement);
    await waitFor(() => expect(backend.overrides.size).toBe(overridesBefore + 1));
    await waitFor(() =>
      expect(
        within(worktreeOf('web-dashboard', 'main')).getByTestId(TEST_IDS.reviewOffBadge).dataset
          .source,
      ).toBe('worktree'),
    );
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

describe('chrome hierarchy (docs/TOOLBAR.md)', () => {
  it('the context bar says where you are; list and diff controls sit over their own panes', async () => {
    setup();
    await ready();
    const bar = () => screen.getByTestId('context-bar');
    const listOptions = () => screen.getByRole('toolbar', { name: 'File list options' });
    // The app lands on a worktree (#83): the bar names it, and the diff header does not repeat it.
    expect(bar().dataset.view).toBe('worktree');
    expect(bar().textContent).not.toMatch(/Inbox/);
    expect(within(bar()).getByTestId('context-bar-worktree').textContent).toBe('octopus-apimain');
    expect(within(viewer()).queryByTestId('diff-header-worktree')).toBeNull();
    // List controls over the list, diff controls over the diff.
    expect(within(listOptions()).getByTestId(TEST_IDS.scopeSelect)).toBeTruthy();
    expect(within(listOptions()).getByTestId(TEST_IDS.showReviewedToggle)).toBeTruthy();
    expect(within(listOptions()).getByTestId('tree-view-toggle')).toBeTruthy();
    expect(within(viewer()).getByTestId(TEST_IDS.diffModeToggle)).toBeTruthy();
    expect(within(viewer()).getByTestId(TEST_IDS.whitespaceToggle)).toBeTruthy();

    const row = worktreeItem('feat/auth');
    fireEvent.click(row);
    await waitFor(() =>
      expect(viewer().getAttribute('data-worktree-id')).toBe(row.dataset.worktreeId),
    );
    expect(within(bar()).getByTestId('context-bar-worktree').textContent).toBe(
      'octopus-apifeat/auth',
    );
    expect(within(viewer()).queryByTestId('diff-header-worktree')).toBeNull();
    expect(within(bar()).getByTestId(TEST_IDS.worktreeTabs)).toBeTruthy();
    // The forge link says the state; the tab beside it has the number.
    const badge = await within(bar()).findByTestId(TEST_IDS.changeRequestBadge);
    expect(badge.textContent).not.toMatch(/#/);
    expect(badge.textContent).toMatch(/open/);
    await within(bar()).findByTestId(TEST_IDS.reviewPolicyChip);
    expect(within(listOptions()).getByTestId('tree-view-toggle')).toBeTruthy();

    // The layout control is a segmented pair: the group carries the mode, a button per mode.
    const modes = () => within(viewer()).getByTestId(TEST_IDS.diffModeToggle);
    expect(modes().getAttribute('data-mode')).toBe('split');
    fireEvent.click(within(modes()).getByRole('button', { name: 'Unified' }));
    expect(modes().getAttribute('data-mode')).toBe('unified');
    expect(viewer().getAttribute('data-mode')).toBe('unified');
    fireEvent.click(within(modes()).getByRole('button', { name: 'Unified' }));
    expect(modes().getAttribute('data-mode')).toBe('unified');

    // The Request tab keeps the bar (identity, tabs) and drops the pane headers below it.
    fireEvent.click(within(bar()).getAllByTestId(TEST_IDS.worktreeTab)[1] as HTMLElement);
    await screen.findByTestId(TEST_IDS.requestView);
    expect(within(bar()).getByTestId('context-bar-worktree').textContent).toBe(
      'octopus-apifeat/auth',
    );
    expect(within(bar()).getByTestId(TEST_IDS.worktreeTabs)).toBeTruthy();
    expect(within(bar()).queryByTestId(TEST_IDS.changeRequestBadge)).toBeNull();
    expect(screen.queryByTestId(TEST_IDS.scopeSelect)).toBeNull();
    expect(screen.queryByTestId(TEST_IDS.diffModeToggle)).toBeNull();
  });
});
