// @vitest-environment jsdom
/**
 * The live view in the web UI (roadmap #39, DECISIONS #229): the Activity strip under the diff,
 * its incremental refresh from `worktree.changed.activitySeq`, and the state-based "N deleted"
 * chip on the sidebar row. The app runs against the mock backend's simulated agent
 * (`MockBackend.mutate`), the same routes the daemon serves (#38).
 */
import {
  type ActivityEntry,
  type ActivityResponse,
  createApiClient,
  type ServerEvent,
  TEST_IDS,
} from '@octopus-diff/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MockActivity } from '../mock/activity.ts';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { App } from '../src/App.tsx';
import type { EventSourceLike } from '../src/api/hooks.ts';
import { createQueryClient } from '../src/api/queries.ts';
import { ACTIVITY_TEST_IDS } from '../src/components/diff/ActivityStrip.tsx';
import {
  DELETED_CHIP_TEST_ID,
  DeletedChip,
  deletedCount,
} from '../src/components/WorktreeChips.tsx';
import {
  ago,
  bulkKinds,
  headLabel,
  mergeActivity,
  newestFirst,
  watchNote,
} from '../src/lib/activity.ts';
import { DIRECT_FOLDER_ID, type WorktreeRow } from '../src/lib/model.ts';
import { DEFAULT_PREFS, scopeForPref } from '../src/state/prefs.ts';
import { actions, createUiStore, type UiStore } from '../src/state/ui.tsx';

vi.mock('../src/components/diff/DiffRenderer.tsx', () => ({
  DiffRenderer: ({ patch }: { patch: string }) => <pre data-testid="stub-diff">{patch}</pre>,
}));

// jsdom has no layout: give the virtualized list a viewport tall enough for every row.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 4000,
  });
});

afterEach(() => cleanup());

// --- pure functions ---------------------------------------------------------------------------

const T0 = '2026-11-12T10:00:00.000Z';

function entry(id: number, extra: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id,
    seq: id,
    kind: 'modified',
    at: T0,
    updatedAt: T0,
    count: 1,
    path: `f${id}.ts`,
    ...extra,
  };
}

function response(extra: Partial<ActivityResponse> = {}): ActivityResponse {
  const entries = extra.entries ?? [];
  return {
    worktreeId: 'w1',
    entries,
    seq: Math.max(0, ...entries.map((e) => e.seq)),
    dropped: false,
    live: true,
    run: 'r1',
    watch: { mode: 'native', pollMs: null },
    ...extra,
  };
}

describe('activity feed: merging answers', () => {
  it('appends new entries and keeps the cursor', () => {
    const a = mergeActivity(undefined, response({ entries: [entry(1), entry(2)] }));
    const b = mergeActivity(a, response({ entries: [entry(3)] }));
    expect(b.entries.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(b.seq).toBe(3);
    expect(b.replaced).toBe(false);
  });

  it('replaces a coalesced entry by id (new seq, moved to the end) instead of duplicating it', () => {
    const a = mergeActivity(undefined, response({ entries: [entry(1), entry(2)] }));
    const b = mergeActivity(a, response({ entries: [entry(1, { seq: 3, count: 2 })] }));
    expect(b.entries.map((e) => [e.id, e.seq, e.count])).toEqual([
      [2, 2, 1],
      [1, 3, 2],
    ]);
  });

  it('an empty answer keeps what is held and the cursor', () => {
    const a = mergeActivity(undefined, response({ entries: [entry(1)] }));
    const b = mergeActivity(a, response({ entries: [], seq: 1 }));
    expect(b.entries).toHaveLength(1);
    expect(b.seq).toBe(1);
  });

  it('a dropped answer replaces the list: the cursor was stale', () => {
    const a = mergeActivity(undefined, response({ entries: [entry(1), entry(2), entry(3)] }));
    const b = mergeActivity(a, response({ entries: [entry(2), entry(5)], dropped: true }));
    expect(b.entries.map((e) => e.id)).toEqual([2, 5]);
    expect(b.seq).toBe(5);
    expect(b.replaced).toBe(true);
  });

  it('a dropped answer may lower the cursor (a restarted daemon starts over)', () => {
    const a = mergeActivity(undefined, response({ entries: [entry(40)] }));
    const b = mergeActivity(a, response({ entries: [entry(2)], dropped: true, run: 'r2' }));
    expect(b.seq).toBe(2);
    expect(b.run).toBe('r2');
  });

  it('never merges into a list from another daemon run', () => {
    const a = mergeActivity(undefined, response({ entries: [entry(1), entry(2)] }));
    const b = mergeActivity(a, response({ entries: [entry(3)], run: 'r2' }));
    expect(b.entries.map((e) => e.id)).toEqual([3]);
  });

  it('keeps at most the ring size', () => {
    const many = Array.from({ length: 230 }, (_, i) => entry(i + 1));
    const feed = mergeActivity(undefined, response({ entries: many }));
    expect(feed.entries).toHaveLength(200);
    expect(feed.entries[0]?.id).toBe(31);
  });

  it('newest first, by seq', () => {
    expect(
      newestFirst([entry(1), entry(3, { seq: 2 }), entry(2, { seq: 5 })]).map((e) => e.id),
    ).toEqual([2, 3, 1]);
  });
});

describe('activity feed: words', () => {
  it('says "polling every N s" for a degraded worktree and nothing for a native one', () => {
    expect(watchNote({ mode: 'native', pollMs: null })).toBeNull();
    expect(watchNote({ mode: 'polling', pollMs: 5000 })).toBe('polling every 5 s');
    expect(watchNote({ mode: 'polling', pollMs: 1500 })).toBe('polling every 2 s');
    expect(watchNote({ mode: 'polling', pollMs: null })).toBe('polling');
    expect(watchNote({ mode: 'disabled', pollMs: 30000 })).toContain('every 30 s');
  });

  it('shortens times', () => {
    const now = Date.parse(T0);
    expect(ago(T0, now + 1000)).toBe('now');
    expect(ago(T0, now + 12_000)).toBe('12s');
    expect(ago(T0, now + 5 * 60_000)).toBe('5m');
    expect(ago(T0, now + 3 * 3_600_000)).toBe('3h');
  });

  it('labels head moves and bulk kinds', () => {
    expect(
      headLabel(entry(1, { kind: 'head', op: 'checkout', branch: 'feat/x', fromBranch: 'main' })),
    ).toBe('Checked out feat/x (from main)');
    expect(headLabel(entry(1, { kind: 'head', op: 'reset', branch: 'main' }))).toBe(
      'Reset on main',
    );
    expect(
      bulkKinds(
        entry(1, { kind: 'bulk', kinds: { added: 3, modified: 12, deleted: 0, restored: 0 } }),
      ),
    ).toBe('12 modified, 3 added');
  });
});

// --- the "N deleted" chip ---------------------------------------------------------------------

function rowWith(deleted: number | undefined): WorktreeRow {
  return {
    summary: {
      counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, deleted },
    },
  } as unknown as WorktreeRow;
}

describe('the "N deleted" chip', () => {
  it('is shown while tracked deletions are uncommitted, with the count', () => {
    render(<DeletedChip row={rowWith(3)} />);
    const chip = screen.getByTestId(DELETED_CHIP_TEST_ID);
    expect(chip.textContent).toBe('3 deleted');
    expect(chip.title).toContain('3 tracked files are deleted and not committed');
  });

  it('says "1 deleted" with a singular title', () => {
    render(<DeletedChip row={rowWith(1)} />);
    expect(screen.getByTestId(DELETED_CHIP_TEST_ID).title).toContain('1 tracked file is deleted');
  });

  it('is hidden at 0 and when the daemon does not say (older daemon)', () => {
    const zero = render(<DeletedChip row={rowWith(0)} />);
    expect(screen.queryByTestId(DELETED_CHIP_TEST_ID)).toBeNull();
    zero.unmount();
    render(<DeletedChip row={rowWith(undefined)} />);
    expect(screen.queryByTestId(DELETED_CHIP_TEST_ID)).toBeNull();
    expect(deletedCount({ summary: null })).toBe(0);
  });
});

// --- the mock routes the UI runs against -----------------------------------------------------

describe('the mock live-view routes (shaped like the daemon)', () => {
  it('serve the feed, validate the oid, 404 a blob that is not in the feed', async () => {
    const backend = new MockBackend({ dataset: 'demo' });
    const fetch = createMockFetch(backend);
    const id = backend.projects[0]?.worktrees[0]?.worktree.id as string;
    const get = (path: string) => fetch(`http://mock.local${path}`);
    const empty = (await (await get(`/api/worktrees/${id}/activity`)).json()) as ActivityResponse;
    expect(empty).toMatchObject({
      entries: [],
      seq: 0,
      dropped: false,
      live: true,
      run: 'mock-run-1',
    });
    backend.mutate(id, 'delete');
    const after = (await (
      await get(`/api/worktrees/${id}/activity?after=0`)
    ).json()) as ActivityResponse;
    const gone = after.entries.find((e) => e.kind === 'deleted');
    expect(gone?.oid).toMatch(/^[0-9a-f]{40}$/);
    expect((await get(`/api/worktrees/${id}/blob/${gone?.oid}`)).status).toBe(200);
    expect((await get(`/api/worktrees/${id}/blob/${'1'.repeat(40)}`)).status).toBe(404);
    expect((await get(`/api/worktrees/${id}/blob/not-an-oid`)).status).toBe(400);
    expect((await get(`/api/worktrees/${id}/blob/${gone?.oid}?maxBytes=0`)).status).toBe(400);
    // A cursor from another run is stale.
    const stale = (await (
      await get(`/api/worktrees/${id}/activity?after=1&run=other`)
    ).json()) as ActivityResponse;
    expect(stale.dropped).toBe(true);
  });

  it('folds like the daemon: an edit, a delete and a second edit stay three rows (PR #80 review)', () => {
    const a = new MockActivity();
    const edit = (path: string) => ({ kind: 'modified' as const, path, xy: '.M' });
    a.record('w', edit('a.ts'), 1000);
    a.record('w', { kind: 'deleted', path: 'a.ts', xy: '.D' }, 2000);
    a.record('w', edit('a.ts'), 3000);
    expect(a.read('w', 0).entries.map((e) => [e.kind, e.count])).toEqual([
      ['modified', 1],
      ['deleted', 1],
      ['modified', 1],
    ]);
    // A change to another file in between does not stop a repeat from folding...
    const b = new MockActivity();
    b.record('w', edit('a.ts'), 1000);
    b.record('w', edit('b.ts'), 2000);
    b.record('w', edit('a.ts'), 3000);
    expect(b.read('w', 0).entries.map((e) => [e.path, e.count])).toEqual([
      ['b.ts', 1],
      ['a.ts', 2],
    ]);
    // ...a commit, a HEAD move or a bulk entry does.
    for (const wall of [
      { kind: 'commit' as const, commits: [{ sha: '1'.repeat(40), subject: 's' }] },
      { kind: 'head' as const, op: 'checkout' as const },
      { kind: 'bulk' as const, pathCount: 60 },
    ]) {
      const c = new MockActivity();
      c.record('w', edit('a.ts'), 1000);
      c.record('w', wall, 2000);
      c.record('w', edit('a.ts'), 3000);
      expect(c.read('w', 0).entries.map((e) => e.kind)).toEqual([
        'modified',
        wall.kind,
        'modified',
      ]);
    }
  });

  it("stops serving a deletion's content once the entry left the feed (PR #80 review)", () => {
    const a = new MockActivity();
    a.ringSize = 2;
    const oid = 'a'.repeat(40);
    a.keepBlob('w', oid, 'gone\n');
    a.record('w', { kind: 'deleted', path: 'x.ts', xy: '.D', deleted: 1, oid }, 1000);
    expect(a.blob('w', oid, 1024)?.content).toBe('gone\n');
    // Two newer entries push it out of a ring of two: the daemon's allow-list no longer has it.
    a.record('w', { kind: 'modified', path: 'y.ts', xy: '.M' }, 2000);
    a.record('w', { kind: 'modified', path: 'z.ts', xy: '.M' }, 3000);
    expect(a.blob('w', oid, 1024)).toBeNull();
    // ...and the saved content is dropped, not kept for ever.
    expect(a.blobCount('w')).toBe(0);
  });
});

// --- the app ----------------------------------------------------------------------------------

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
  requests: { method: string; url: string }[];
}

function setup(store: Partial<Parameters<typeof createUiStore>[0]> = {}): Harness {
  const backend = new MockBackend({ dataset: 'demo', statusFlow: true });
  const mockFetch = createMockFetch(backend);
  const requests: Harness['requests'] = [];
  const api = createApiClient({
    baseUrl: 'http://mock.local',
    fetch: (input, init) => {
      requests.push({ method: init?.method ?? 'GET', url: String(input) });
      return mockFetch(input, init);
    },
  });
  const uiStore = createUiStore(
    {
      confirmBulk: false,
      settledOpen: true,
      scope: scopeForPref('working'),
      activityOpen: true,
      ...store,
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
      uiStore={uiStore}
      eventSourceFactory={factory}
    />,
  );
  return { backend, store: uiStore, requests };
}

const app = () => screen.getByTestId(TEST_IDS.app);
const rows = () => screen.queryAllByTestId(ACTIVITY_TEST_IDS.row);
const rowPaths = () => rows().map((r) => r.dataset.path);
const activityUrls = (h: Harness) => h.requests.filter((r) => r.url.includes('/activity'));

function worktreeItem(branch: string): HTMLElement {
  const el = screen.getAllByTestId(TEST_IDS.worktreeItem).find((e) => e.dataset.branch === branch);
  if (!el) throw new Error(`no worktree item ${branch}`);
  return el;
}

async function open(branch: string): Promise<string> {
  await waitFor(() => expect(app().getAttribute('data-ready')).toBe('true'));
  fireEvent.click(worktreeItem(branch));
  await waitFor(() => expect(screen.queryAllByTestId(TEST_IDS.fileItem).length).toBeGreaterThan(0));
  return worktreeItem(branch).dataset.worktreeId as string;
}

async function agent(
  h: Harness,
  worktreeId: string,
  action: Parameters<MockBackend['mutate']>[1],
  path?: string,
) {
  await act(async () => {
    h.backend.mutate(worktreeId, action, path);
  });
}

describe('the Activity strip', () => {
  it('starts collapsed for a new browser (the diff comes first)', async () => {
    const h = setup({ activityOpen: DEFAULT_PREFS.activityOpen });
    expect(h.store.getState().activityOpen).toBe(false);
    await open('feat/auth');
    expect((await screen.findByTestId(ACTIVITY_TEST_IDS.strip)).dataset.open).toBe('false');
  });

  it('is collapsed by default, only in a worktree, and asks for the open worktree only', async () => {
    const h = setup({ activityOpen: false });
    await waitFor(() => expect(app().getAttribute('data-ready')).toBe('true'));
    // The app lands on the top worktree (#83): the strip is its, and so is the one request.
    const landing = screen.getAllByTestId(TEST_IDS.worktreeItem)[0]?.dataset.worktreeId as string;
    expect((await screen.findByTestId(ACTIVITY_TEST_IDS.strip)).dataset.worktreeId).toBe(landing);
    expect(activityUrls(h).every((r) => r.url.includes(`/worktrees/${landing}/`))).toBe(true);
    // An Overview is no worktree: no strip.
    act(() => actions.setView(h.store, { kind: 'folder', scanRootId: DIRECT_FOLDER_ID }));
    await waitFor(() => expect(screen.queryByTestId(ACTIVITY_TEST_IDS.strip)).toBeNull());
    await open('feat/auth');
    const strip = await screen.findByTestId(ACTIVITY_TEST_IDS.strip);
    expect(strip.dataset.open).toBe('false');
    expect(screen.queryByTestId(ACTIVITY_TEST_IDS.list)).toBeNull();
    fireEvent.click(screen.getByTestId(ACTIVITY_TEST_IDS.toggle));
    await waitFor(() => expect(strip.dataset.open).toBe('true'));
    expect(h.store.getState().activityOpen).toBe(true);
  });

  it('lists what the agent did newest first, folding repeats of one file into one row', async () => {
    const h = setup();
    const id = await open('main');
    await screen.findByText(/Nothing has changed since/);
    await agent(h, id, 'edit', 'README.md');
    await agent(h, id, 'edit', 'src/server/router.ts');
    await agent(h, id, 'edit', 'src/server/router.ts');
    // The two edits of router.ts are one entry (x2), newest first.
    await waitFor(() => expect(within(rows()[0] as HTMLElement).getByText('×2')).toBeTruthy());
    expect(rowPaths()).toEqual(['src/server/router.ts', 'README.md']);
    expect(rows()).toHaveLength(2);
    expect(screen.getByTestId(ACTIVITY_TEST_IDS.count).textContent).toBe('2');
  });

  it('shows a deletion in red with its line count and the removed content on "View content"', async () => {
    const h = setup();
    const id = await open('feat/auth');
    await agent(h, id, 'delete', 'src/auth/session.ts');
    const row = await waitFor(() => {
      const found = rows().find((r) => r.dataset.kind === 'deleted');
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(row.className).toContain('bg-del-soft');
    expect(within(row).getByText('src/auth/session.ts').className).toContain('text-del');
    expect(within(row).getByText(/^−\d+ lines?$/)).toBeTruthy();
    expect(screen.queryByTestId(ACTIVITY_TEST_IDS.content)).toBeNull();
    // No blob is read until it is asked for.
    expect(h.requests.some((r) => r.url.includes('/blob/'))).toBe(false);
    fireEvent.click(within(row).getByTestId(ACTIVITY_TEST_IDS.viewContent));
    const content = await screen.findByTestId(ACTIVITY_TEST_IDS.content);
    expect(content.textContent).toContain('import { ');
    expect(content.textContent).toContain('// src/auth/session.ts');
    expect(h.requests.filter((r) => r.url.includes('/blob/'))).toHaveLength(1);
    // And it goes away again.
    fireEvent.click(within(row).getByTestId(ACTIVITY_TEST_IDS.viewContent));
    expect(screen.queryByTestId(ACTIVITY_TEST_IDS.content)).toBeNull();
  });

  it('says "content unavailable" for an untracked file that was deleted (no button)', async () => {
    const h = setup();
    const id = await open('feat/auth');
    await agent(h, id, 'delete-untracked', 'notes/todo.md');
    const row = await waitFor(() => {
      const found = rows().find((r) => r.dataset.kind === 'deleted');
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(within(row).getByText('content unavailable')).toBeTruthy();
    expect(within(row).queryByTestId(ACTIVITY_TEST_IDS.viewContent)).toBeNull();
  });

  it('explains a blob that is gone (404) instead of failing silently', async () => {
    const h = setup();
    const id = await open('feat/auth');
    await agent(h, id, 'delete', 'src/auth/session.ts');
    const row = await waitFor(() => {
      const found = rows().find((r) => r.dataset.kind === 'deleted');
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    // The daemon pruned it: the allow-list no longer has it.
    h.backend.activity.restart();
    fireEvent.click(within(row).getByTestId(ACTIVITY_TEST_IDS.viewContent));
    expect((await screen.findByRole('alert')).textContent).toContain('no longer available');
  });

  it('a click on a row selects that file; a file that left the list is not clickable', async () => {
    const h = setup();
    const id = await open('feat/auth');
    await agent(h, id, 'edit', 'src/auth/token.ts');
    const row = await waitFor(() => {
      expect(rows()).toHaveLength(1);
      return rows()[0] as HTMLElement;
    });
    expect(h.store.getState().selected?.path).not.toBe('src/auth/token.ts');
    fireEvent.click(within(row).getByTestId(ACTIVITY_TEST_IDS.select));
    await waitFor(() => expect(h.store.getState().selected?.path).toBe('src/auth/token.ts'));
    // Revert it away: the earlier entry stays in the feed but the file is gone from the list.
    await agent(h, id, 'revert', 'src/auth/token.ts');
    await waitFor(() => expect(rows().some((r) => r.dataset.kind === 'restored')).toBe(true));
    await waitFor(() => {
      const edit = rows().find((r) => r.dataset.kind === 'modified') as HTMLElement;
      expect(edit.dataset.present).toBe('false');
      expect(within(edit).queryByTestId(ACTIVITY_TEST_IDS.select)).toBeNull();
    });
  });

  it('shows a commit and a bulk entry folded, with their files on demand', async () => {
    const h = setup();
    const id = await open('feat/auth');
    const sample = Array.from({ length: 20 }, (_, i) => `gen/file-${i}.ts`);
    h.backend.activity.record(
      id,
      {
        kind: 'bulk',
        pathCount: 60,
        paths: sample,
        kinds: { added: 0, modified: 55, deleted: 5, restored: 0 },
      },
      Date.now(),
    );
    h.backend.activity.record(
      id,
      {
        kind: 'commit',
        sha: 'a'.repeat(40),
        subject: 'Wire the retry',
        paths: ['x.ts', 'y.ts'],
        pathCount: 2,
      },
      Date.now(),
    );
    await agent(h, id, 'edit', 'src/auth/token.ts');
    await waitFor(() => expect(rows()).toHaveLength(3));
    const [edit, commit, bulk] = rows() as HTMLElement[];
    expect(edit?.dataset.kind).toBe('modified');
    expect(commit?.textContent).toContain('Commit aaaaaaa Wire the retry');
    expect(bulk?.textContent).toContain('60 files changed');
    expect(bulk?.textContent).toContain('55 modified, 5 deleted');
    // One row for 60 files; the sample is behind a button, with the rest counted.
    expect(screen.queryByTestId(ACTIVITY_TEST_IDS.paths)).toBeNull();
    fireEvent.click(within(bulk as HTMLElement).getByRole('button', { name: '60 files' }));
    const list = within(bulk as HTMLElement).getByTestId(ACTIVITY_TEST_IDS.paths);
    expect(within(list).getAllByRole('listitem').length).toBe(21);
    expect(list.textContent).toContain('… and 40 more');
  });

  it('says "polling every N s" for a worktree the daemon polls, and nothing for a native one', async () => {
    const h = setup();
    const id = await open('feat/auth');
    await screen.findByText(/Nothing has changed since/);
    expect(screen.queryByTestId(ACTIVITY_TEST_IDS.watch)).toBeNull();
    h.backend.activity.setWatch(id, { mode: 'polling', pollMs: 5000 });
    await agent(h, id, 'edit', 'src/auth/token.ts');
    const note = await screen.findByTestId(ACTIVITY_TEST_IDS.watch);
    expect(note.textContent).toBe('polling every 5 s');
  });

  it('fetches incrementally, sends the run back and only for the open worktree', async () => {
    const h = setup();
    await waitFor(() => expect(app().getAttribute('data-ready')).toBe('true'));
    const landing = screen.getAllByTestId(TEST_IDS.worktreeItem)[0]?.dataset.worktreeId as string;
    const id = await open('feat/auth');
    await screen.findByText(/Nothing has changed since/);
    // The landing worktree's request is not this one's (#83).
    const first = activityUrls(h).filter((r) => r.url.includes(`/worktrees/${id}/`));
    expect(first).toHaveLength(1);
    expect(first[0]?.url).toContain(`/api/worktrees/${id}/activity`);
    expect(first[0]?.url).not.toContain('after=');
    await agent(h, id, 'edit', 'src/auth/token.ts');
    await waitFor(() => expect(rows()).toHaveLength(1));
    const seq = h.backend.activity.seqOf(id);
    await agent(h, id, 'edit', 'src/auth/session.ts');
    await waitFor(() => expect(rows()).toHaveLength(2));
    const later = activityUrls(h).at(-1)?.url ?? '';
    expect(later).toContain(`after=${seq}`);
    expect(later).toContain('run=mock-run-1');
    // Another worktree changing moves nothing here: no request for it.
    const other = worktreeItem('main').dataset.worktreeId as string;
    const before = activityUrls(h).length;
    await agent(h, other, 'edit', 'README.md');
    await waitFor(() => expect(app().getAttribute('data-ready')).toBe('true'));
    expect(activityUrls(h)).toHaveLength(before);
    expect(
      activityUrls(h).every(
        (r) => r.url.includes(`/worktrees/${id}/`) || r.url.includes(`/worktrees/${landing}/`),
      ),
    ).toBe(true);
  });

  it('replaces its list when the answer says dropped (the daemon restarted)', async () => {
    const h = setup();
    const id = await open('feat/auth');
    await agent(h, id, 'edit', 'src/auth/token.ts');
    await agent(h, id, 'edit', 'src/auth/session.ts');
    await waitFor(() => expect(rows()).toHaveLength(2));
    // A restart: a new run, the old feed gone, then one new change.
    await act(async () => {
      h.backend.activity.restart();
    });
    await agent(h, id, 'edit', 'src/auth/middleware.ts');
    await waitFor(() => expect(rowPaths()).toEqual(['src/auth/middleware.ts']));
    // The old entries are not merged back in.
    expect(rows()).toHaveLength(1);
  });

  it('keeps the selection (and the open file) across a refresh, and does not follow by default', async () => {
    const h = setup();
    const id = await open('feat/auth');
    const follow = screen.getByTestId(ACTIVITY_TEST_IDS.follow);
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    expect(h.store.getState().followLatest).toBe(false);
    fireEvent.click(
      screen
        .getAllByTestId(TEST_IDS.fileItem)
        .find((e) => e.dataset.path === 'src/auth/session.ts') as HTMLElement,
    );
    await waitFor(() => expect(h.store.getState().selected?.path).toBe('src/auth/session.ts'));
    await agent(h, id, 'edit', 'src/auth/token.ts');
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(app().getAttribute('data-ready')).toBe('true'));
    expect(h.store.getState().selected?.path).toBe('src/auth/session.ts');
  });

  it('"Follow latest change" selects the newest changed file as the feed moves', async () => {
    const h = setup();
    const id = await open('feat/auth');
    await agent(h, id, 'edit', 'src/auth/token.ts');
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(screen.getByTestId(ACTIVITY_TEST_IDS.follow));
    expect(h.store.getState().followLatest).toBe(true);
    // Turning it on selects the newest changed file...
    await waitFor(() => expect(h.store.getState().selected?.path).toBe('src/auth/token.ts'));
    // ...and it keeps following.
    await agent(h, id, 'edit', 'src/auth/session.ts');
    await waitFor(() => expect(h.store.getState().selected?.path).toBe('src/auth/session.ts'));
    // Off again: the selection stays where the reader put it.
    fireEvent.click(screen.getByTestId(ACTIVITY_TEST_IDS.follow));
    await agent(h, id, 'edit', 'src/auth/token.ts');
    await waitFor(() =>
      expect(
        rows().some(
          (r) =>
            r.dataset.path === 'src/auth/token.ts' &&
            r.dataset.seq === String(h.backend.activity.seqOf(id)),
        ),
      ).toBe(true),
    );
    expect(h.store.getState().selected?.path).toBe('src/auth/session.ts');
  });

  it('follows the first change of a restarted daemon, whose sequence starts at 1 again (PR #80 review)', async () => {
    const h = setup();
    const id = await open('feat/auth');
    await agent(h, id, 'edit', 'src/auth/token.ts'); // seq 1 of the first run
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(screen.getByTestId(ACTIVITY_TEST_IDS.follow));
    await waitFor(() => expect(h.store.getState().selected?.path).toBe('src/auth/token.ts'));
    await act(async () => {
      h.backend.activity.restart();
    });
    // seq 1 of the new run, a different file: it must not be taken for the change already followed.
    await agent(h, id, 'edit', 'src/auth/session.ts');
    expect(h.backend.activity.seqOf(id)).toBe(1);
    await waitFor(() => expect(h.store.getState().selected?.path).toBe('src/auth/session.ts'));
  });

  it('escapes hidden direction controls in the collapsed bar, as in the rows (PR #80 review)', async () => {
    const h = setup({ activityOpen: false });
    const id = await open('feat/auth');
    const project = h.backend.projects.find((p) => p.worktrees.some((w) => w.worktree.id === id));
    await act(async () => {
      h.backend.activity.record(
        id,
        { kind: 'modified', path: 'evil\u202Efdp.exe', xy: '.M', added: 1, deleted: 0 },
        Date.now(),
      );
      h.backend.emit({
        type: 'worktree.changed',
        projectId: project?.project.id as string,
        worktreeId: id,
        stateHash: 'x',
        activitySeq: h.backend.activity.seqOf(id),
      });
    });
    const bar = await screen.findByTestId(ACTIVITY_TEST_IDS.strip);
    await waitFor(() => expect(bar.textContent).toContain('evil'));
    expect(bar.textContent).not.toContain('\u202E');
  });
});

describe('the "N deleted" chip on the sidebar row', () => {
  const chipOf = (branch: string) =>
    within(worktreeItem(branch)).queryByTestId(DELETED_CHIP_TEST_ID);

  it('follows the state: shown with the count while deletions are uncommitted, gone after a commit', async () => {
    const h = setup();
    const id = await open('feat/auth');
    // The demo worktree already has one uncommitted deletion (src/auth/legacy.ts).
    expect(chipOf('feat/auth')?.textContent).toBe('1 deleted');
    expect(chipOf('main')).toBeNull();
    await agent(h, id, 'delete', 'src/auth/session.ts');
    await waitFor(() => expect(chipOf('feat/auth')?.textContent).toBe('2 deleted'));
    // Time does not matter, the commit does: every tracked change, deletions included, is committed.
    await agent(h, id, 'commit');
    await waitFor(() => expect(chipOf('feat/auth')).toBeNull());
  });
});
