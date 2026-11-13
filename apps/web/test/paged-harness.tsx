/**
 * The harness of the paged-list web tests (#42): the app on the mock backend's `large` dataset
 * (it pages like the daemon), with every request recorded, requests that can be held until a
 * test releases them, and requests that can be made to fail.
 */
import { createApiClient, orderFiles, type ServerEvent, TEST_IDS } from '@octopus-diff/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { App } from '../src/App.tsx';
import type { EventSourceLike } from '../src/api/hooks.ts';
import { createQueryClient } from '../src/api/queries.ts';
import { FILE_LIST_MORE_TEST_ID } from '../src/components/FileList.tsx';
import { scopeForPref } from '../src/state/prefs.ts';
import { createUiStore, type UiState, type UiStore } from '../src/state/ui.tsx';

export class FakeEventSource implements EventSourceLike {
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

export const SCOPE = { kind: 'working' as const };
export const PAGE = 20;
export const FILES = 120;

export interface Harness {
  backend: MockBackend;
  store: UiStore;
  qc: QueryClient;
  user: ReturnType<typeof userEvent.setup>;
  requests: string[];
  bulkBodies: Array<{ target: { kind: string; worktreeId?: string }; paths?: unknown[] }>;
  /** The worktree the app landed on. */
  first: string;
  /** Holds the GETs `matches` accepts until the returned function is called. */
  hold(matches: (url: string) => boolean): () => void;
  /** GETs it accepts answer 503 (null: none). */
  fail: { matches: ((url: string) => boolean) | null };
}

export async function setup(
  prepare: (backend: MockBackend) => void = () => {},
  ui: Partial<UiState> = {},
): Promise<Harness> {
  const backend = new MockBackend({
    dataset: 'large',
    largeProjects: 2,
    largeWorktreesPerProject: 2,
    largeFilesPerWorktree: FILES,
    statusFlow: true,
  });
  prepare(backend);
  const mockFetch = createMockFetch(backend);
  const requests: string[] = [];
  const bulkBodies: Harness['bulkBodies'] = [];
  const holds = new Set<{ matches: (url: string) => boolean; released: Promise<void> }>();
  const fail: Harness['fail'] = { matches: null };
  const api = createApiClient({
    baseUrl: 'http://mock.local',
    fetch: async (input, init) => {
      const url = String(input);
      const get = (init?.method ?? 'GET') === 'GET';
      requests.push(`${init?.method ?? 'GET'} ${input}`);
      if (url.endsWith('/api/review/bulk') && typeof init?.body === 'string') {
        bulkBodies.push(JSON.parse(init.body));
      }
      if (get) for (const h of [...holds]) if (h.matches(url)) await h.released;
      if (get && fail.matches?.(url)) {
        return new Response(JSON.stringify({ error: { code: 'internal', message: 'boom' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      return mockFetch(input, init);
    },
  });
  const hold = (matches: (url: string) => boolean) => {
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entry = { matches, released };
    holds.add(entry);
    return () => {
      holds.delete(entry);
      release();
    };
  };
  const qc = createQueryClient();
  const store = createUiStore(
    { settledOpen: true, scope: scopeForPref('working'), showReviewed: true, ...ui },
    false,
  );
  const factory = () => {
    const es = new FakeEventSource();
    backend.subscribe((e) => es.dispatch(e));
    queueMicrotask(() => es.onopen?.(new Event('open')));
    return es;
  };
  render(<App api={api} queryClient={qc} uiStore={store} eventSourceFactory={factory} />);
  await waitFor(() =>
    expect(screen.getByTestId(TEST_IDS.app).getAttribute('data-ready')).toBe('true'),
  );
  const view = store.getState().view;
  if (view.kind !== 'worktree') throw new Error('did not land on a worktree');
  return {
    backend,
    store,
    qc,
    user: userEvent.setup(),
    requests,
    bulkBodies,
    first: view.worktreeId,
    hold,
    fail,
  };
}

/** The mock's list of a worktree in the paging order (what the daemon pages). */
export function listOf(backend: MockBackend, worktreeId: string) {
  return orderFiles(backend.listFiles(worktreeId, SCOPE, { limit: 2000 }).files);
}

export function markFirst(backend: MockBackend, worktreeId: string, count: number) {
  const projectId = backend
    .listProjects()
    .projects.find((p) => p.worktrees.some((w) => w.worktree.id === worktreeId))?.project.id;
  for (const f of listOf(backend, worktreeId).slice(0, count)) {
    backend.setReview({
      projectId: projectId as string,
      scopeKind: 'working',
      path: f.path,
      ...(f.rawPath ? { rawPath: f.rawPath } : {}),
      patchHash: f.patchHash,
      reviewed: true,
    });
  }
}

/** The list's footer, or the tree layout's bar (`file-tree-more`). */
export const footer = () =>
  screen.queryByTestId(FILE_LIST_MORE_TEST_ID) ?? screen.queryByTestId('file-tree-more');
export const loaded = () => Number(footer()?.getAttribute('data-loaded') ?? Number.NaN);
export const selectedPath = (store: UiStore) => store.getState().selected?.path;

export async function press(user: Harness['user'], keys: string) {
  await act(async () => {
    await user.keyboard(keys);
  });
}

/** Clicks the footer's (or the tree bar's) Load more and waits for the next page. */
export async function loadMore(count: number) {
  const before = loaded();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  });
  await waitFor(() => expect(loaded()).toBeGreaterThanOrEqual(Math.min(before + PAGE, count)));
}

/** Picks a file through the palette's file search (the real command path). */
export async function paletteOpen(path: string) {
  await act(async () => {
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  });
  const input = await screen.findByTestId(TEST_IDS.commandPaletteInput);
  await act(async () => {
    fireEvent.change(input, { target: { value: path } });
  });
  const item = await waitFor(() => {
    const found = screen
      .getAllByTestId(TEST_IDS.commandPaletteItem)
      .find(
        (el) =>
          el.dataset.kind === 'file' && el.textContent?.replace(/reviewed$/, '') === `File${path}`,
      );
    if (!found) throw new Error(`no file item for ${path}`);
    return found;
  });
  await act(async () => {
    fireEvent.click(item);
  });
}
