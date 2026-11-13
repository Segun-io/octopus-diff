// @vitest-environment jsdom
import { createApiClient, type ServerEvent, TEST_IDS } from '@octopus-diff/contracts';
import { createMemoryHistory, type RouterHistory } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { App } from '../src/App.tsx';
import type { EventSourceLike } from '../src/api/hooks.ts';
import { createQueryClient } from '../src/api/queries.ts';
import { scopeForPref } from '../src/state/prefs.ts';
import { createUiStore, type UiStore } from '../src/state/ui.tsx';

// The URL <-> state sync of the app (docs/DECISIONS.md #459), in jsdom with a memory history.

vi.mock('../src/components/diff/DiffRenderer.tsx', () => ({
  DiffRenderer: ({ patch }: { patch: string }) => <pre data-testid="stub-diff">{patch}</pre>,
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

function mount(initialEntry: string, opts: { lastWorktree?: string } = {}) {
  const backend = new MockBackend({ dataset: 'demo' });
  const api = createApiClient({ baseUrl: 'http://mock.local', fetch: createMockFetch(backend) });
  const store: UiStore = createUiStore(
    {
      settledOpen: true,
      scope: scopeForPref('working'),
      ...(opts.lastWorktree ? { lastWorktree: opts.lastWorktree } : {}),
    },
    false,
  );
  const history: RouterHistory = createMemoryHistory({ initialEntries: [initialEntry] });
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
      history={history}
    />,
  );
  return { store, history, backend };
}

const params = (history: RouterHistory) => new URLSearchParams(history.location.search);
const currentWorktree = () =>
  document
    .querySelector(`[data-testid="${TEST_IDS.worktreeItem}"][aria-current="true"]`)
    ?.getAttribute('data-worktree-id');
const rows = () => screen.getAllByTestId(TEST_IDS.worktreeItem);
const settled = () =>
  waitFor(() => {
    expect(screen.getByTestId(TEST_IDS.app).getAttribute('data-ready')).toBe('true');
    expect(currentWorktree()).toBeTruthy();
  });

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
});

describe('URL state in the app (#459)', () => {
  it('writes the landing worktree into the address without adding an entry', async () => {
    const { history } = mount('/');
    await settled();
    await waitFor(() => expect(params(history).get('worktree')).toBe(currentWorktree()));
    expect(params(history).get('scope')).toBeTruthy();
    expect(history.length).toBe(1);
  });

  it('opens the worktree, file and scope the address names (reload restore); URL wins over lastWorktree', async () => {
    const probe = mount('/');
    await settled();
    const [first, second] = [rows()[0], rows()[1]];
    expect(first && second).toBeTruthy();
    const target = second?.getAttribute('data-worktree-id') ?? '';
    cleanup();
    const again = mount(`/?worktree=${target}&scope=working`, {
      lastWorktree: first?.getAttribute('data-worktree-id') ?? '',
    });
    await settled();
    expect(currentWorktree()).toBe(target);
    expect(again.store.getState().scope).toEqual({ kind: 'working' });
    expect(probe.store).not.toBe(again.store);
  });

  it('a click adds a history entry and Back / Forward move between the selections', async () => {
    const { history, store } = mount('/');
    await settled();
    const landed = currentWorktree();
    const other = rows().find((r) => r.getAttribute('data-worktree-id') !== landed);
    if (!other) throw new Error('no second worktree');
    const otherId = other.getAttribute('data-worktree-id');
    fireEvent.click(other);
    await waitFor(() => expect(currentWorktree()).toBe(otherId));
    await waitFor(() => expect(params(history).get('worktree')).toBe(otherId));
    expect(history.length).toBe(2);
    act(() => history.back());
    await waitFor(() => expect(currentWorktree()).toBe(landed));
    expect(store.getState().view).toMatchObject({ worktreeId: landed });
    act(() => history.forward());
    await waitFor(() => expect(currentWorktree()).toBe(otherId));
  });

  it('a file and a scope change are in the address; a file of a deep link is selected', async () => {
    const { history, store } = mount('/');
    await settled();
    // The landing worktree's first file is selected once its list has loaded.
    await waitFor(() => expect(store.getState().selected).not.toBeNull());
    const path = store.getState().selected?.path ?? '';
    const wt = currentWorktree() ?? '';
    await waitFor(() => expect(params(history).get('file')).toBe(path));
    cleanup();
    const link = mount(`/?worktree=${wt}&file=${encodeURIComponent(path)}&scope=working`);
    await settled();
    await waitFor(() => expect(link.store.getState().selected?.path).toBe(path));
    expect(link.store.getState().selected?.worktreeId).toBe(wt);
    expect(store).not.toBe(link.store);
  });

  it('a stale or invalid address falls back to the landing flow without an error', async () => {
    for (const entry of [
      '/?worktree=0000000000000000&file=nope.ts&scope=working',
      '/?worktree=zz/zz&scope=nonsense',
      '/?project=0000000000000000',
      '/?folder=0000000000000000',
      '/some/old/path?x=1',
    ]) {
      const { history } = mount(entry);
      await settled();
      await waitFor(() => expect(params(history).get('worktree')).toBe(currentWorktree()));
      expect(screen.queryByTestId(TEST_IDS.errorBanner)).toBeNull();
      cleanup();
    }
  });

  it('never carries the daemon token into a path or query', async () => {
    const token = 'tok_0123456789-abcdefXYZ';
    const { history } = mount(`/?worktree=0000000000000000&token=${token}#token=${token}`);
    await settled();
    await waitFor(() => expect(params(history).get('worktree')).toBe(currentWorktree()));
    expect(history.location.href).not.toContain(token);
    expect(history.location.search).not.toContain('token');
    expect(history.location.hash).toBe('');
  });
});
