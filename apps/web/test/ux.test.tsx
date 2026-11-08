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
    expect((bulk?.body as { paths: unknown[] }).paths).toHaveLength(19);
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
    expect(toast.dataset.changed).toBe('28');
    const bulk = requests.find((r) => r.url.endsWith('/api/review/bulk'));
    expect(bulk?.body).toMatchObject({ target: { kind: 'all' } });
    expect(
      Object.keys((bulk?.body as { expectedStateHashes: object }).expectedStateHashes),
    ).toHaveLength(5);
    await press(user, '{Control>}z{/Control}');
    await waitFor(() => expect(backend.reviews.size).toBe(0));

    store.setState({ confirmBulk: true });
    await press(user, 'R');
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toContain('Across 5 worktrees');
    fireEvent.click(within(confirm).getByText(/^Mark verified$/));
    await waitFor(() => expect(backend.reviews.size).toBe(28));
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
    expect((bulk?.body as { paths: unknown[] }).paths).toHaveLength(1);
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
