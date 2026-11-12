// @vitest-environment jsdom
import { createApiClient, type ServerEvent, TEST_IDS } from '@octopus-diff/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockBackend, type MockBackendOptions } from '../mock/backend.ts';
import type { ForgeSim } from '../mock/forges.ts';
import { createMockFetch, type MockRouterOptions } from '../mock/router.ts';
import { App } from '../src/App.tsx';
import type { EventSourceLike } from '../src/api/hooks.ts';
import { createQueryClient } from '../src/api/queries.ts';
import { SkeletonLines, StaleNote, WaitNote } from '../src/components/WaitNote.tsx';
import { useDelayedFlag, useExpiring } from '../src/lib/useWait.ts';
import {
  budgetPhrase,
  describeStale,
  forgeSource,
  forgeStale,
  LOCAL_WAIT,
  pendingForgeWait,
  REVIEW_WAIT_GIVE_UP_MS,
  staleText,
  WAIT_NOTE_DELAY_MS,
  waitText,
  worstBudget,
} from '../src/lib/wait.ts';
import { scopeForPref } from '../src/state/prefs.ts';
import { createUiStore, type UiState } from '../src/state/ui.tsx';

// @pierre/diffs needs a real browser; stub the renderer.
vi.mock('../src/components/diff/DiffRenderer.tsx', () => ({
  DiffRenderer: ({ patch }: { patch: string }) => <pre data-testid="stub-diff">{patch}</pre>,
}));

const clock = (iso: string) => iso.slice(11, 16);

describe('wait messages (pure)', () => {
  const budget = (state: 'ok' | 'busy' | 'low' | 'backoff', kind: 'github' | 'gitlab' = 'github') =>
    ({
      host: kind === 'github' ? 'github.com' : 'gitlab.com',
      kind,
      state,
      spentLastHour: 10,
      backgroundLimit: 1500,
      hourlyLimit: 4000,
      remaining: null,
      resetAt: null,
      resumeAt: '2026-11-12T14:05:00.000Z',
      message: null,
    }) as const;

  it('attributes a wait to the forge by kind, or to the computer', () => {
    expect(waitText(LOCAL_WAIT)).toBe('Loading from your computer…');
    expect(waitText(forgeSource('github'))).toBe('Waiting for GitHub…');
    expect(waitText(forgeSource('gitlab'))).toBe('Waiting for GitLab…');
    expect(waitText(forgeSource(['gitlab', 'github', 'github']))).toBe(
      'Waiting for GitHub and GitLab…',
    );
  });

  it('says why a host is held back instead of a plain wait', () => {
    expect(waitText(forgeSource('github', budget('backoff')), clock)).toBe(
      'GitHub is rate-limiting requests, retrying at 14:05',
    );
    expect(budgetPhrase(budget('backoff'), clock)).toBe(
      'GitHub is rate-limiting requests, retrying at 14:05',
    );
    expect(budgetPhrase(budget('busy'), clock)).toBe(
      'Using a lot of your GitHub quota, polling slower',
    );
    expect(budgetPhrase(budget('low', 'gitlab'), clock)).toBe(
      'Your GitLab quota is nearly used up, checking only on request until 14:05',
    );
    // A healthy host adds nothing.
    expect(budgetPhrase(budget('ok'))).toBeNull();
    expect(waitText(forgeSource('github', budget('ok')))).toBe('Waiting for GitHub…');
    expect(worstBudget([budget('busy'), budget('backoff', 'gitlab'), budget('ok')])?.state).toBe(
      'backoff',
    );
    expect(worstBudget([budget('ok')])).toBeNull();
  });

  it('words staleness from the data time', () => {
    const now = Date.parse('2026-11-12T10:00:00.000Z');
    expect(staleText('2026-11-12T09:57:00.000Z', now)).toBe('Last updated 3 min ago');
    expect(staleText(now - 20_000, now)).toBe('Last updated just now');
    expect(staleText(null, now)).toBe('Last updated a while ago');
  });

  it('is stale only for a real reason: held back, failed fetch, failed refetch', () => {
    const base = { forge: 'github', fetchedAt: '2026-11-12T09:57:00.000Z', message: null } as const;
    expect(describeStale({ ...base, budget: budget('ok') })).toBeNull();
    // Old data is not stale data: no timer decides it.
    expect(
      describeStale({ ...base, fetchedAt: '2020-01-01T00:00:00.000Z', budget: null }),
    ).toBeNull();
    expect(describeStale({ ...base, budget: budget('busy') })).toBeNull();
    expect(describeStale({ ...base, budget: budget('backoff'), clock })?.reason).toBe(
      'GitHub is rate-limiting requests, retrying at 14:05',
    );
    expect(describeStale({ ...base, message: 'gh exited 1', budget: null })).toMatchObject({
      reason: 'Could not refresh from GitHub',
      detail: 'gh exited 1',
      held: false,
    });
    expect(
      describeStale({
        forge: null,
        fetchedAt: null,
        message: null,
        budget: null,
        failed: true,
        dataUpdatedAt: 5,
      }),
    ).toMatchObject({ reason: 'Could not refresh', updatedAt: 5 });
  });

  it('reads the pending lookups and the oldest stale data off the forges response', () => {
    const backend = new MockBackend({ dataset: 'demo' });
    backend.setForgeSim({ pending: true });
    const pending = pendingForgeWait(backend.forges());
    expect(pending).toMatchObject({ kind: 'forge', forge: ['github', 'gitlab'] });
    backend.setForgeSim({});
    expect(pendingForgeWait(backend.forges())).toBeNull();
    expect(forgeStale(backend.forges())).toBeNull();
    backend.setForgeSim({ error: 'boom', fetchedAgoMs: 180_000 });
    expect(forgeStale(backend.forges())).toMatchObject({ reason: 'Could not refresh from GitHub' });
    backend.setForgeSim({ budget: 'backoff', fetchedAgoMs: 180_000 });
    expect(forgeStale(backend.forges())?.held).toBe(true);
  });

  it('a cold-start lookup with no forge named yet is a wait too (PR #76 review)', () => {
    const backend = new MockBackend({ dataset: 'demo' });
    const forges = backend.forges();
    // The daemon answers `pending` with `forge: null` until it has worked out which forge a
    // project's remotes are on.
    const cold = {
      ...forges,
      projects: forges.projects.map((p) => ({ ...p, status: 'pending' as const, forge: null })),
    };
    const source = pendingForgeWait(cold);
    expect(source).toMatchObject({ kind: 'forge', forge: [] });
    expect(waitText(source as NonNullable<typeof source>)).toBe('Waiting for the forge…');
    // Once the forge is named the note names it.
    const first = forges.projects[0];
    if (!first) throw new Error('no project');
    expect(
      pendingForgeWait({ ...cold, projects: [{ ...first, status: 'pending' as const }] }),
    ).toMatchObject({ forge: [first.forge?.kind] });
  });
});

function Probe({ active }: { active: boolean }) {
  return <span data-testid="probe">{String(useDelayedFlag(active))}</span>;
}

function Exp({ k }: { k: string }) {
  return <span data-testid="exp">{String(useExpiring(true, k, 1000))}</span>;
}

describe('threshold hooks and notes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

  it('turns on only after the delay and off at once', async () => {
    const view = render(<Probe active />);
    expect(screen.getByTestId('probe').textContent).toBe('false');
    await advance(WAIT_NOTE_DELAY_MS - 1);
    expect(screen.getByTestId('probe').textContent).toBe('false');
    await advance(1);
    expect(screen.getByTestId('probe').textContent).toBe('true');
    view.rerender(<Probe active={false} />);
    expect(screen.getByTestId('probe').textContent).toBe('false');
  });

  it('a load that ends before the delay never shows, and the clock restarts', async () => {
    const view = render(<Probe active />);
    await advance(WAIT_NOTE_DELAY_MS - 100);
    view.rerender(<Probe active={false} />);
    view.rerender(<Probe active />);
    await advance(WAIT_NOTE_DELAY_MS - 100);
    expect(screen.getByTestId('probe').textContent).toBe('false');
    await advance(100);
    expect(screen.getByTestId('probe').textContent).toBe('true');
  });

  it('useExpiring stops claiming after the limit and restarts for another key', async () => {
    const view = render(<Exp k="a" />);
    expect(screen.getByTestId('exp').textContent).toBe('true');
    await advance(1000);
    expect(screen.getByTestId('exp').textContent).toBe('false');
    view.rerender(<Exp k="b" />);
    expect(screen.getByTestId('exp').textContent).toBe('true');
  });

  it('names the forge or the computer after the threshold, in one polite live region', async () => {
    const view = render(<WaitNote active source={forgeSource('gitlab')} />);
    const note = screen.getByTestId('wait-note');
    // The live region exists from the start (empty), so the text is announced once when it lands.
    expect(note.getAttribute('role')).toBe('status');
    expect(note.getAttribute('aria-live')).toBe('polite');
    expect(note.textContent).toBe('');
    await advance(WAIT_NOTE_DELAY_MS);
    expect(screen.getByTestId('wait-note')).toBe(note);
    expect(note.textContent).toBe('Waiting for GitLab…');
    expect(note.getAttribute('data-source')).toBe('gitlab');
    view.rerender(<WaitNote active source={LOCAL_WAIT} />);
    expect(note.textContent).toBe('Loading from your computer…');
    view.rerender(<WaitNote active={false} source={LOCAL_WAIT} />);
    expect(note.textContent).toBe('');
  });

  it('shows nothing for a fast load', async () => {
    const view = render(<WaitNote active source={forgeSource('github')} />);
    await advance(WAIT_NOTE_DELAY_MS - 200);
    view.rerender(<WaitNote active={false} source={forgeSource('github')} />);
    await advance(5000);
    expect(screen.getByTestId('wait-note').textContent).toBe('');
    expect(document.body.textContent).not.toMatch(/Waiting|Loading/);
  });

  it('the rate-limit text replaces the plain wait and is warned', async () => {
    const source = forgeSource('github', {
      host: 'github.com',
      kind: 'github',
      state: 'backoff',
      spentLastHour: 1500,
      backgroundLimit: 1500,
      hourlyLimit: 4000,
      remaining: 0,
      resetAt: null,
      resumeAt: new Date(2026, 10, 12, 14, 5).toISOString(),
      message: null,
    });
    render(<WaitNote active source={source} />);
    await advance(WAIT_NOTE_DELAY_MS);
    const note = screen.getByTestId('wait-note');
    expect(note.textContent).toMatch(
      /^GitHub is rate-limiting requests, retrying at \d{1,2}:\d{2}/,
    );
    expect(note.textContent).not.toMatch(/Waiting for/);
    expect(note.className).toContain('text-warn');
  });

  it('the stale note says how old the data is and refreshes by button, keyboard included', async () => {
    vi.setSystemTime(new Date('2026-11-12T10:00:00.000Z'));
    const onRefresh = vi.fn();
    render(
      <StaleNote
        updatedAt="2026-11-12T09:57:00.000Z"
        reason="Could not refresh from GitHub"
        onRefresh={onRefresh}
      />,
    );
    const note = screen.getByTestId('stale-note');
    expect(note.textContent).toContain('Could not refresh from GitHub. Last updated 3 min ago');
    expect(note.getAttribute('aria-live')).toBe('polite');
    const button = within(note).getByRole('button', { name: 'Refresh' });
    button.focus();
    expect(document.activeElement).toBe(button);
    // A real button: Enter and Space click it, like every other control.
    fireEvent.click(button);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    // The display clock moves on by itself.
    await advance(5 * 60_000);
    expect(note.textContent).toContain('Last updated 8 min ago');
  });

  it('the skeleton is silent for assistive technology', () => {
    const { container } = render(<SkeletonLines widths={[50, 60]} />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(container.textContent).toBe('');
  });
});

// --- the whole app ----------------------------------------------------------------------------

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(event: ServerEvent) {
    for (const l of this.listeners.get(event.type) ?? [])
      l(new MessageEvent(event.type, { data: JSON.stringify(event) }));
  }
  close() {
    this.readyState = 2;
  }
}

interface Hold {
  release: () => void;
  count: () => number;
}

interface Harness {
  backend: MockBackend;
  requests: string[];
  /** Holds every request `test` matches until `release()`; later ones pass once released. */
  hold: (test: (path: string, method: string) => boolean) => Hold;
  /** Makes every request `test` matches fail like an unreachable daemon, until cleared. */
  failWhile: (test: (path: string, method: string) => boolean) => { clear: () => void };
  store: ReturnType<typeof createUiStore>;
  queryClient: ReturnType<typeof createQueryClient>;
}

function setup(
  opts: {
    sim?: ForgeSim;
    backend?: MockBackendOptions;
    ui?: Partial<UiState>;
    router?: MockRouterOptions;
    /** Paths an older daemon does not have (answered 404). */
    missing?: (path: string, method: string) => boolean;
  } = {},
): Harness {
  const backend = new MockBackend({ dataset: 'demo', ...opts.backend });
  if (opts.sim) backend.setForgeSim(opts.sim);
  const holds: Array<{
    test: (path: string, method: string) => boolean;
    promise: Promise<void>;
    resolve: () => void;
    seen: number;
  }> = [];
  const failures = new Set<(path: string, method: string) => boolean>();
  const requests: string[] = [];
  const mockFetch = createMockFetch(backend, {
    ...opts.router,
    gate: async ({ path, method }) => {
      for (const test of failures) if (test(path, method)) throw new TypeError('offline');
      const held = holds.find((h) => h.test(path, method));
      if (held) {
        held.seen++;
        await held.promise;
      }
    },
  });
  const api = createApiClient({
    baseUrl: 'http://mock.local',
    fetch: (input, init) => {
      requests.push(`${init?.method ?? 'GET'} ${new URL(input).pathname}${new URL(input).search}`);
      if (opts.missing?.(new URL(input).pathname, init?.method ?? 'GET')) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'not_found', message: 'no such route' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return mockFetch(input, init);
    },
  });
  const store = createUiStore(
    { settledOpen: true, scope: scopeForPref('working'), ...opts.ui },
    false,
  );
  const queryClient = createQueryClient();
  const factory = () => {
    const es = new FakeEventSource();
    backend.subscribe((e) => es.dispatch(e));
    queueMicrotask(() => es.onopen?.(new Event('open')));
    return es;
  };
  render(<App api={api} queryClient={queryClient} uiStore={store} eventSourceFactory={factory} />);
  return {
    backend,
    requests,
    store,
    queryClient,
    hold: (test) => {
      let resolve = () => {};
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      const entry = { test, promise, resolve, seen: 0 };
      holds.unshift(entry);
      return {
        release: () => {
          resolve();
          holds.splice(holds.indexOf(entry), 1);
        },
        count: () => entry.seen,
      };
    },
    failWhile: (test) => {
      failures.add(test);
      return { clear: () => void failures.delete(test) };
    },
  };
}

const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const waitReady = () =>
  waitFor(() => expect(screen.getByTestId(TEST_IDS.app).getAttribute('data-ready')).toBe('true'));
const notes = () => screen.queryAllByTestId('wait-note');
const shownNotes = () =>
  notes()
    .filter((n) => n.textContent)
    .map((n) => n.textContent);
const sidebarStatus = () => screen.getByTestId('sidebar-status');

/** A worktree with a request on the given forge kind (the demo alternates GitHub and GitLab). */
function requestWorktree(backend: MockBackend, kind: 'github' | 'gitlab') {
  const forges = backend.forges();
  for (const p of forges.projects) {
    if (p.forge?.kind !== kind) continue;
    for (const w of p.worktrees) {
      if (w.changeRequest) {
        return { worktreeId: w.worktreeId, projectId: p.projectId };
      }
    }
  }
  throw new Error(`no ${kind} request in the demo data`);
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.className = '';
});

describe('loading states in the app (#11)', () => {
  it('nothing is said when everything is fast', async () => {
    setup();
    await waitReady();
    await waitFor(() =>
      expect(screen.getByTestId(TEST_IDS.diffViewer).getAttribute('data-state')).toBe('ready'),
    );
    await advance(WAIT_NOTE_DELAY_MS * 3);
    expect(shownNotes()).toEqual([]);
    expect(screen.queryByTestId('stale-note')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Waiting for|Loading from your computer/);
    for (const n of notes()) expect(n.getAttribute('data-shown')).toBe('false');
  });

  it('the diff pane says "Loading from your computer…" only after the threshold', async () => {
    const h = setup();
    const diff = h.hold((path) => /\/api\/worktrees\/[^/]+\/diff$/.test(path));
    await waitReady();
    const viewer = screen.getByTestId(TEST_IDS.diffViewer);
    await waitFor(() => expect(viewer.getAttribute('data-state')).toBe('loading'));
    await advance(300);
    expect(within(viewer).queryByText(/Loading from your computer/)).toBeNull();
    await advance(WAIT_NOTE_DELAY_MS);
    expect(within(viewer).getByText('Loading from your computer…')).toBeTruthy();
    expect(within(viewer).getByText('Loading from your computer…').getAttribute('role')).toBe(
      'status',
    );
    diff.release();
    await waitFor(() => expect(viewer.getAttribute('data-state')).toBe('ready'));
    expect(within(viewer).queryByText(/Loading from your computer/)).toBeNull();
  });

  it('a diff that arrives before the threshold never shows the message', async () => {
    const h = setup();
    const diff = h.hold((path) => /\/api\/worktrees\/[^/]+\/diff$/.test(path));
    await waitReady();
    const viewer = screen.getByTestId(TEST_IDS.diffViewer);
    await waitFor(() => expect(viewer.getAttribute('data-state')).toBe('loading'));
    await advance(WAIT_NOTE_DELAY_MS - 300);
    diff.release();
    await waitFor(() => expect(viewer.getAttribute('data-state')).toBe('ready'));
    await advance(WAIT_NOTE_DELAY_MS * 2);
    expect(shownNotes()).toEqual([]);
  });

  it('the file list names the local work while inbox batches are still coming in', async () => {
    const h = setup({ backend: { dataset: 'large' } });
    // The second batch of the first load never lands until released.
    let batches = 0;
    const second = h.hold((path) => {
      if (path !== '/api/inbox') return false;
      batches++;
      return batches === 2;
    });
    await waitReady();
    await waitFor(() => expect(second.count()).toBe(1));
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="file-group"], [data-testid="file-row"]'),
      ).not.toBeNull(),
    );
    await advance(300);
    expect(shownNotes()).toEqual([]);
    await advance(WAIT_NOTE_DELAY_MS);
    expect(shownNotes()).toContain('Loading from your computer…');
    second.release();
    await waitFor(() => expect(shownNotes()).not.toContain('Loading from your computer…'));
  });

  it('the Request tab says "Waiting for GitHub…" for a slow lookup, GitLab for a GitLab one', async () => {
    for (const [kind, word] of [
      ['github', 'GitHub'],
      ['gitlab', 'GitLab'],
    ] as const) {
      const probe = new MockBackend({ dataset: 'demo' });
      const { worktreeId } = requestWorktree(probe, kind);
      const h = setup({ ui: { view: { kind: 'worktree', worktreeId, tab: 'request' } } });
      const detail = h.hold((path) => path === `/api/forges/worktrees/${worktreeId}/request`);
      const view = await screen.findByTestId(TEST_IDS.requestView);
      expect(view.getAttribute('data-status')).toBe('loading');
      await advance(300);
      expect(within(view).queryByText(/Waiting for/)).toBeNull();
      await advance(WAIT_NOTE_DELAY_MS);
      expect(within(view).getByText(`Waiting for ${word}…`)).toBeTruthy();
      detail.release();
      await waitFor(() => expect(view.getAttribute('data-status')).toBe('ok'));
      expect(within(view).queryByText(/Waiting for/)).toBeNull();
      cleanup();
    }
  });

  it('a slow refresh in the Request tab says who is slow next to the button', async () => {
    const probe = new MockBackend({ dataset: 'demo' });
    const { worktreeId } = requestWorktree(probe, 'github');
    const h = setup({ ui: { view: { kind: 'worktree', worktreeId, tab: 'request' } } });
    const view = await screen.findByTestId(TEST_IDS.requestView);
    await waitFor(() => expect(view.getAttribute('data-status')).toBe('ok'));
    const refresh = h.hold(
      (path, method) => method === 'POST' && path.endsWith('/request/refresh'),
    );
    fireEvent.click(within(view).getByRole('button', { name: 'Refresh' }));
    await advance(300);
    expect(within(view).queryByText(/Waiting for/)).toBeNull();
    await advance(WAIT_NOTE_DELAY_MS);
    expect(within(view).getByText('Waiting for GitHub…')).toBeTruthy();
    refresh.release();
    await waitFor(() => expect(within(view).queryByText(/Waiting for/)).toBeNull());
  });

  it('the conversation names the forge after the threshold', async () => {
    const probe = new MockBackend({ dataset: 'demo' });
    const { worktreeId } = requestWorktree(probe, 'gitlab');
    const h = setup({ ui: { view: { kind: 'worktree', worktreeId, tab: 'request' } } });
    const conversation = h.hold((path) => path.endsWith('/request/conversation'));
    const view = await screen.findByTestId(TEST_IDS.requestView);
    await waitFor(() => expect(view.getAttribute('data-status')).toBe('ok'));
    fireEvent.click(within(view).getByRole('tab', { name: /Timeline/ }));
    await advance(WAIT_NOTE_DELAY_MS + 50);
    expect(within(view).getByText('Waiting for GitLab…')).toBeTruthy();
    conversation.release();
    await waitFor(() => expect(within(view).queryByText(/Waiting for/)).toBeNull());
  });

  it('a host in backoff says so, with the time, instead of a plain wait', async () => {
    const probe = new MockBackend({ dataset: 'demo' });
    const { worktreeId } = requestWorktree(probe, 'github');
    const h = setup({
      sim: { budget: 'backoff' },
      ui: { view: { kind: 'worktree', worktreeId, tab: 'request' } },
    });
    h.hold((path) => path === `/api/forges/worktrees/${worktreeId}/request`);
    const view = await screen.findByTestId(TEST_IDS.requestView);
    await advance(WAIT_NOTE_DELAY_MS + 50);
    const said = within(view)
      .getAllByTestId('wait-note')
      .map((n) => n.textContent)
      .filter(Boolean);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^GitHub is rate-limiting requests, retrying at \d{1,2}:\d{2}/);
    expect(within(view).queryByText(/Waiting for GitHub/)).toBeNull();
  });

  it('a busy host says it is polling slower', async () => {
    const probe = new MockBackend({ dataset: 'demo' });
    const { worktreeId } = requestWorktree(probe, 'github');
    const h = setup({
      sim: { budget: 'busy' },
      ui: { view: { kind: 'worktree', worktreeId, tab: 'request' } },
    });
    h.hold((path) => path === `/api/forges/worktrees/${worktreeId}/request`);
    const view = await screen.findByTestId(TEST_IDS.requestView);
    await advance(WAIT_NOTE_DELAY_MS + 50);
    expect(within(view).getByText('Using a lot of your GitHub quota, polling slower')).toBeTruthy();
  });

  it('the Request tab shows the last data with "Last updated … · Refresh" when a refresh failed', async () => {
    const probe = new MockBackend({ dataset: 'demo' });
    const { worktreeId } = requestWorktree(probe, 'github');
    const h = setup({
      sim: { error: 'GraphQL: timeout', fetchedAgoMs: 3 * 60_000 },
      ui: { view: { kind: 'worktree', worktreeId, tab: 'request' } },
    });
    const view = await screen.findByTestId(TEST_IDS.requestView);
    await waitFor(() => expect(view.getAttribute('data-status')).toBe('ok'));
    const stale = within(view).getByTestId('stale-note');
    expect(stale.textContent).toContain('Could not refresh from GitHub. Last updated 3 min ago');
    expect(stale.getAttribute('title')).toBe('GraphQL: timeout');
    // No threshold for a state: it is there as soon as the data is.
    const before = h.requests.filter((r) => r.endsWith('/request/refresh')).length;
    const button = within(stale).getByRole('button', { name: 'Refresh' });
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(h.requests.filter((r) => r.endsWith('/request/refresh')).length).toBe(before + 1),
    );
  });

  it('a host in backoff makes the Request tab say the data is held back', async () => {
    const probe = new MockBackend({ dataset: 'demo' });
    const { worktreeId } = requestWorktree(probe, 'github');
    setup({
      sim: { budget: 'backoff', fetchedAgoMs: 10 * 60_000 },
      ui: { view: { kind: 'worktree', worktreeId, tab: 'request' } },
    });
    const view = await screen.findByTestId(TEST_IDS.requestView);
    await waitFor(() => expect(view.getAttribute('data-status')).toBe('ok'));
    const stale = within(view).getByTestId('stale-note');
    expect(stale.textContent).toMatch(/rate-limiting requests, retrying at \d{1,2}:\d{2}/);
    expect(stale.textContent).toContain('Last updated 10 min ago');
  });

  it('the sidebar names the forges its PR chips wait for, after the threshold', async () => {
    const h = setup({ sim: { pending: true } });
    await waitReady();
    expect(sidebarStatus().textContent).toBe('');
    await advance(300);
    expect(sidebarStatus().textContent).toBe('');
    await advance(WAIT_NOTE_DELAY_MS);
    expect(sidebarStatus().textContent).toBe('Waiting for GitHub and GitLab…');
    expect(sidebarStatus().getAttribute('data-state')).toBe('waiting');
    // The lookups finish (forge.updated): the note goes.
    act(() => void h.backend.setForgeSim({}));
    await waitFor(() => expect(sidebarStatus().textContent).toBe(''));
  });

  it('the sidebar says why lookups are held back when the host is rate-limiting', async () => {
    setup({ sim: { pending: true, budget: 'backoff' } });
    await waitReady();
    await advance(WAIT_NOTE_DELAY_MS + 50);
    expect(sidebarStatus().textContent).toMatch(
      /^GitHub is rate-limiting requests, retrying at \d{1,2}:\d{2}/,
    );
  });

  it('the sidebar offers "Last updated … · Refresh" while a host holds lookups back', async () => {
    const h = setup({ sim: { budget: 'backoff', fetchedAgoMs: 3 * 60_000 } });
    await waitReady();
    const stale = await within(sidebarStatus()).findByTestId('stale-note');
    expect(sidebarStatus().getAttribute('data-state')).toBe('stale');
    expect(stale.textContent).toMatch(/rate-limiting requests, retrying at/);
    expect(stale.textContent).toContain('Last updated 3 min ago');
    const button = within(stale).getByRole('button', { name: 'Refresh' });
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    await waitFor(() => expect(h.requests).toContain('POST /api/forges/refresh'));
  });

  it('the sidebar says the last fetch failed, with the data time', async () => {
    setup({ sim: { error: 'gh: exit 1', fetchedAgoMs: 3 * 60_000 } });
    await waitReady();
    const stale = await within(sidebarStatus()).findByTestId('stale-note');
    expect(stale.textContent).toContain('Could not refresh from GitHub. Last updated 3 min ago');
    // A "busy" host alone is not stale: Settings shows it, the sidebar stays quiet.
  });

  it('stays quiet for a busy host when nothing waits on it', async () => {
    setup({ sim: { budget: 'busy' } });
    await waitReady();
    await advance(WAIT_NOTE_DELAY_MS * 2);
    expect(sidebarStatus().textContent).toBe('');
  });

  it('a project overview says what its repository facts wait for', async () => {
    const probe = new MockBackend({ dataset: 'demo' });
    const { projectId } = requestWorktree(probe, 'github');
    const h = setup({ ui: { view: { kind: 'project', projectId } } });
    const forge = h.hold((path, method) => method === 'GET' && path.endsWith('/repository'));
    const local = h.hold((path) => path === '/api/repositories');
    await screen.findByTestId(TEST_IDS.repoInfoLocal);
    const facts = await screen.findByTestId(TEST_IDS.repoInfoForge);
    expect(facts.getAttribute('data-status')).toBe('loading');
    await advance(300);
    expect(shownNotes()).toEqual([]);
    await advance(WAIT_NOTE_DELAY_MS);
    expect(
      within(screen.getByTestId(TEST_IDS.repoInfoForge)).getByText('Waiting for GitHub…'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId(TEST_IDS.repoInfoLocal)).getByText('Loading from your computer…'),
    ).toBeTruthy();
    forge.release();
    local.release();
    await waitFor(() => expect(shownNotes()).toEqual([]));
  });

  it('an older daemon without the repository facts route shows nothing, not a skeleton that never ends (PR #76 review)', async () => {
    const probe = new MockBackend({ dataset: 'demo' });
    const { projectId } = requestWorktree(probe, 'github');
    setup({
      ui: { view: { kind: 'project', projectId } },
      missing: (path, method) => method === 'GET' && path.endsWith('/repository'),
    });
    await screen.findByTestId(TEST_IDS.repoInfoLocal);
    await advance(WAIT_NOTE_DELAY_MS * 3);
    // The route answered 404: a finished answer, rendered as nothing.
    expect(screen.queryByTestId(TEST_IDS.repoInfoForge)).toBeNull();
    expect(shownNotes()).not.toContain('Waiting for GitHub…');
  });

  it('a folder overview names the local work behind its table', async () => {
    const scanRootId = new MockBackend({ dataset: 'demo' }).listScanRoots().scanRoots[0]?.id ?? '';
    const h = setup({ ui: { view: { kind: 'folder', scanRootId } } });
    const local = h.hold((path) => path === '/api/repositories');
    await waitReady();
    await advance(WAIT_NOTE_DELAY_MS + 50);
    await waitFor(() => expect(shownNotes()).toContain('Loading from your computer…'));
    local.release();
    await waitFor(() => expect(shownNotes()).toEqual([]));
  });

  it('after a project is opened, says the review states are being worked out until they land', async () => {
    const probe = new MockBackend({ dataset: 'demo', reviewOnDemand: true });
    const projectId = probe.listProjects().projects[0]?.project.id ?? '';
    const h = setup({
      backend: { reviewOnDemand: true },
      ui: { view: { kind: 'project', projectId } },
    });
    // The daemon is slow to take the focus: its states do not land.
    const focus = h.hold((path, method) => path === '/api/focus' && method === 'PUT');
    await waitReady();
    await advance(300);
    expect(sidebarStatus().textContent).toBe('');
    await advance(WAIT_NOTE_DELAY_MS);
    expect(sidebarStatus().textContent).toBe('Loading from your computer…');
    expect(screen.getAllByTestId('wait-note').some((n) => n.textContent)).toBe(true);
    focus.release();
    await waitFor(() => expect(sidebarStatus().textContent).toBe(''));
    expect(shownNotes()).toEqual([]);
  });

  it('stops claiming the review states are coming when they never do', async () => {
    const probe = new MockBackend({ dataset: 'demo', reviewOnDemand: true });
    const projectId = probe.listProjects().projects[0]?.project.id ?? '';
    const h = setup({
      backend: { reviewOnDemand: true },
      ui: { view: { kind: 'project', projectId } },
    });
    h.hold((path, method) => path === '/api/focus' && method === 'PUT');
    await waitReady();
    await advance(WAIT_NOTE_DELAY_MS + 50);
    expect(sidebarStatus().textContent).toBe('Loading from your computer…');
    await advance(REVIEW_WAIT_GIVE_UP_MS);
    expect(sidebarStatus().textContent).toBe('');
  });

  it('a failed refetch keeps the last data and offers Refresh with the real data time', async () => {
    const h = setup();
    await waitReady();
    await waitFor(() =>
      expect(screen.getByTestId(TEST_IDS.diffViewer).getAttribute('data-state')).toBe('ready'),
    );
    const failing = h.failWhile((path) => path === '/api/projects');
    await advance(5 * 60_000);
    void h.queryClient.invalidateQueries({ queryKey: ['projects'] });
    // Retries with backoff (500 ms, 1 s), then the error shows over the cached sidebar.
    await advance(4000);
    const banner = await screen.findByTestId(TEST_IDS.errorBanner);
    expect(banner.textContent).toContain('showing the last known state');
    const stale = screen.getByTestId('stale-note');
    expect(stale.textContent).toContain('Last updated 5 min ago');
    failing.clear();
    fireEvent.click(within(stale).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.queryByTestId('stale-note')).toBeNull());
  });
});
