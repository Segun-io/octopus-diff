// @vitest-environment jsdom
/**
 * #42: the web on paged file lists (the mock pages like the daemon, `pageFileList`). The first
 * page renders, more load on demand; `n`, the palette's file search, bulk review, the diff pane
 * and the selection keep working on files that are not loaded yet.
 */
import {
  createApiClient,
  fileListEntryKey,
  orderFiles,
  type ServerEvent,
  TEST_IDS,
} from '@octopus-diff/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { App } from '../src/App.tsx';
import { filesPaging } from '../src/api/files.ts';
import type { EventSourceLike } from '../src/api/hooks.ts';
import { createQueryClient, queryKeys } from '../src/api/queries.ts';
import { FILE_LIST_MORE_TEST_ID } from '../src/components/FileList.tsx';
import { scopeForPref } from '../src/state/prefs.ts';
import { createUiStore, type UiState, type UiStore } from '../src/state/ui.tsx';

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

const SCOPE = { kind: 'working' as const };
const PAGE = 20;
const FILES = 120;

interface Harness {
  backend: MockBackend;
  store: UiStore;
  qc: QueryClient;
  user: ReturnType<typeof userEvent.setup>;
  requests: string[];
  bulkBodies: Array<{ target: { kind: string; worktreeId?: string }; paths?: unknown[] }>;
  /** Worktree ids in sidebar order (the landing one first). */
  first: string;
}

async function setup(
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
  const api = createApiClient({
    baseUrl: 'http://mock.local',
    fetch: async (input, init) => {
      requests.push(`${init?.method ?? 'GET'} ${input}`);
      if (String(input).endsWith('/api/review/bulk') && typeof init?.body === 'string') {
        bulkBodies.push(JSON.parse(init.body));
      }
      return mockFetch(input, init);
    },
  });
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
  };
}

/** The mock's list of a worktree in the paging order (what the daemon pages). */
function listOf(backend: MockBackend, worktreeId: string) {
  return orderFiles(backend.listFiles(worktreeId, SCOPE, { limit: 2000 }).files);
}

function markFirst(backend: MockBackend, worktreeId: string, count: number) {
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

const footer = () => screen.queryByTestId(FILE_LIST_MORE_TEST_ID);
const loaded = () => Number(footer()?.getAttribute('data-loaded') ?? Number.NaN);
const selectedPath = (store: UiStore) => store.getState().selected?.path;

async function press(user: Harness['user'], keys: string) {
  await act(async () => {
    await user.keyboard(keys);
  });
}

beforeEach(() => {
  localStorage.clear();
  filesPaging.pageSize = PAGE;
  filesPaging.inboxFiles = 5;
});
afterEach(() => {
  cleanup();
  filesPaging.pageSize = 500;
  filesPaging.inboxFiles = 200;
});

describe('paged file lists in the web (#42)', () => {
  it('renders the first page with a footer, and loads more on demand', async () => {
    const h = await setup();
    await waitFor(() => expect(loaded()).toBe(PAGE));
    expect(footer()?.getAttribute('data-total')).toBe(String(FILES));
    // The first request asked for one page, not the list.
    const firstFiles = h.requests.find((r) => r.includes(`/worktrees/${h.first}/files`));
    expect(firstFiles).toContain(`limit=${PAGE}`);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    });
    await waitFor(() => expect(loaded()).toBe(2 * PAGE));
    expect(
      h.requests.some((r) => r.includes(`/worktrees/${h.first}/files`) && r.includes('cursor=')),
    ).toBe(true);
    // The rows are the list's first files, in its order.
    const data = h.qc.getQueryData<{ files: { path: string }[] }>(queryKeys.files(h.first, SCOPE));
    expect(data?.files.map((f) => f.path)).toEqual(
      listOf(h.backend, h.first)
        .slice(0, 2 * PAGE)
        .map((f) => f.path),
    );
  });

  it('n goes past the loaded files by asking the daemon, and loads the list through it', async () => {
    const h = await setup();
    // Every file of the first page and a few more reviewed.
    markFirst(h.backend, h.first, PAGE + 7);
    const target = listOf(h.backend, h.first)[PAGE + 7]?.path as string;
    await act(async () => {
      await h.qc.invalidateQueries();
    });
    await waitFor(() => expect(loaded()).toBe(PAGE));
    await press(h.user, 'j');
    await press(h.user, 'n');
    await waitFor(() => expect(selectedPath(h.store)).toBe(target));
    expect(h.requests.some((r) => r.includes('unreviewed=true') && r.includes('after='))).toBe(
      true,
    );
    // Loaded through it: the selection is a row of the list, and the diff pane shows it.
    await waitFor(() => expect(loaded()).toBeGreaterThan(PAGE + 7));
    await waitFor(() =>
      expect(screen.getByTestId(TEST_IDS.diffViewer).getAttribute('data-path')).toBe(target),
    );
  });

  it('n goes into another worktree past its inbox row page', async () => {
    let next: { id: string; path: string } | null = null;
    const h = await setup();
    // Every file of the open worktree reviewed, the next worktrees' first 8 too (their inbox
    // rows hold 5): `n` must ask for each and land on their 9th file.
    const ids = h.backend
      .listProjects()
      .projects.flatMap((p) => p.worktrees.map((w) => w.worktree.id));
    for (const id of ids) markFirst(h.backend, id, id === h.first ? FILES : PAGE + 5);
    await act(async () => {
      await h.qc.invalidateQueries();
    });
    await waitFor(() => expect(h.store.getState().view.kind).toBe('worktree'));
    await press(h.user, 'j');
    await press(h.user, 'n');
    await waitFor(() => {
      const view = h.store.getState().view;
      expect(view.kind === 'worktree' && view.worktreeId !== h.first).toBe(true);
    });
    const view = h.store.getState().view;
    if (view.kind !== 'worktree') throw new Error('no worktree');
    next = {
      id: view.worktreeId,
      path: listOf(h.backend, view.worktreeId)[PAGE + 5]?.path as string,
    };
    await waitFor(() => expect(selectedPath(h.store)).toBe(next?.path));
    // Its list was loaded through the file, so the selection holds (no repair to the top).
    await waitFor(() =>
      expect(screen.getByTestId(TEST_IDS.diffViewer).getAttribute('data-path')).toBe(next?.path),
    );
    expect(selectedPath(h.store)).toBe(next.path);
    // Its list was asked for through the file at once (not a page, then a lookup).
    const id = next.id;
    const firstList = h.requests.find(
      (r) =>
        r.includes(`/worktrees/${id}/files?scope=working&`) &&
        !r.includes('unreviewed') &&
        !r.includes('after='),
    );
    expect(
      firstList,
      h.requests.filter((r) => r.includes(`/worktrees/${id}/files`)).join('\n'),
    ).toContain(`limit=${PAGE + 6}`);
    // The open worktree's counts said nothing was left there: it was not asked.
    expect(
      h.requests.some((r) => r.includes(`/worktrees/${h.first}/files`) && r.includes('unreviewed')),
    ).toBe(false);
  });

  it('a refresh that moves the selection past the loaded files loads through it', async () => {
    const h = await setup();
    await waitFor(() => expect(loaded()).toBe(PAGE));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    });
    await waitFor(() => expect(loaded()).toBe(2 * PAGE));
    // The last loaded row; the new file (src/agent/…) sorts before it and pushes it out.
    const pick = listOf(h.backend, h.first)[2 * PAGE - 1];
    if (!pick) throw new Error('no file');
    await act(async () => {
      h.store.setState({ selected: { worktreeId: h.first, path: pick.path } });
    });
    await act(async () => {
      h.backend.mutate(h.first, 'add');
    });
    const now = listOf(h.backend, h.first);
    expect(now.findIndex((f) => f.path === pick.path)).toBe(2 * PAGE);
    await waitFor(() => expect(loaded()).toBeGreaterThan(2 * PAGE));
    expect(selectedPath(h.store)).toBe(pick.path);
  });

  it("the palette's file search asks the daemon and jumps to a file that is not loaded", async () => {
    const h = await setup();
    await waitFor(() => expect(loaded()).toBe(PAGE));
    const far = listOf(h.backend, h.first)[FILES - 3];
    if (!far) throw new Error('no file');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    });
    const input = await screen.findByTestId(TEST_IDS.commandPaletteInput);
    await act(async () => {
      fireEvent.change(input, { target: { value: far.path } });
    });
    const item = await waitFor(() => {
      const found = screen
        .getAllByTestId(TEST_IDS.commandPaletteItem)
        .find((el) => el.dataset.kind === 'file' && el.textContent?.includes(far.path));
      if (!found) throw new Error('no file item');
      return found;
    });
    expect(h.requests.some((r) => r.includes('q='))).toBe(true);
    await act(async () => {
      fireEvent.click(item);
    });
    await waitFor(() => expect(selectedPath(h.store)).toBe(far.path));
    await waitFor(() => expect(loaded()).toBeGreaterThanOrEqual(FILES - 2));
    await waitFor(() =>
      expect(screen.getByTestId(TEST_IDS.diffViewer).getAttribute('data-path')).toBe(far.path),
    );
  });

  it('bulk review of a partly loaded worktree marks its whole list (no paths)', async () => {
    const h = await setup();
    await waitFor(() => expect(loaded()).toBe(PAGE));
    await press(h.user, '{Shift>}R{/Shift}');
    await waitFor(() => expect(h.bulkBodies.length).toBeGreaterThan(0));
    const body = h.bulkBodies.at(-1);
    expect(body?.target).toEqual({ kind: 'worktree', worktreeId: h.first });
    expect(body?.paths).toBeUndefined();
    const after = h.backend.listFiles(h.first, SCOPE, { limit: 1 });
    expect(after.counts?.reviewed).toBe(after.counts?.total);
  });

  it('keeps the loaded count and the selection across a refresh', async () => {
    const h = await setup();
    await waitFor(() => expect(loaded()).toBe(PAGE));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    });
    await waitFor(() => expect(loaded()).toBe(2 * PAGE));
    const list = listOf(h.backend, h.first);
    const pick = list[2 * PAGE - 2];
    if (!pick) throw new Error('no file');
    await act(async () => {
      h.store.setState({ selected: { worktreeId: h.first, path: pick.path } });
    });
    const before = h.requests.length;
    await act(async () => {
      h.backend.mutate(h.first, 'edit');
    });
    // The refresh asks for what was loaded, in one request.
    await waitFor(() =>
      expect(
        h.requests
          .slice(before)
          .some(
            (r) => r.includes(`/worktrees/${h.first}/files`) && r.includes(`limit=${2 * PAGE}`),
          ),
      ).toBe(true),
    );
    await waitFor(() => expect(loaded()).toBeGreaterThanOrEqual(2 * PAGE));
    expect(selectedPath(h.store)).toBe(pick.path);
    // Every page since is the list's own order.
    const data = h.qc.getQueryData<{ files: { path: string; rawPath?: string }[] }>(
      queryKeys.files(h.first, SCOPE),
    );
    const now = listOf(h.backend, h.first).map(fileListEntryKey);
    expect(data?.files.map(fileListEntryKey)).toEqual(now.slice(0, data?.files.length));
  });
});
