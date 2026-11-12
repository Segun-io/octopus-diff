// @vitest-environment jsdom
/**
 * Auth v2 transport: the UI streams `/api/events` with the contract client's fetch-based
 * `subscribe` and the bearer token (no EventSource, no cookie), and gives up on a 401.
 */
import { createApiClient, formatSseEvent, TEST_IDS } from '@octopus-diff/contracts';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { App } from '../src/App.tsx';
import { createQueryClient } from '../src/api/queries.ts';
import { createUiStore } from '../src/state/ui.tsx';

vi.mock('../src/components/diff/DiffRenderer.tsx', () => ({
  DiffRenderer: ({ patch }: { patch: string }) => <pre data-testid="stub-diff">{patch}</pre>,
}));

const TOKEN = 'secret-token-0123456789';

interface Recorded {
  url: string;
  authorization: string | null;
  credentials: RequestCredentials | undefined;
}

/** Mock daemon requiring the bearer token, with a streaming `/api/events`. */
function setup(clientToken: string | null) {
  const backend = new MockBackend({ dataset: 'demo' });
  const routes = createMockFetch(backend, { token: TOKEN });
  const requests: Recorded[] = [];
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const authorization = headers.authorization ?? null;
    requests.push({ url: input, authorization, credentials: init.credentials });
    if (!input.includes('/api/events')) return routes(input, init);
    if (authorization !== `Bearer ${TOKEN}`) {
      return new Response('{"error":{"code":"unauthorized","message":"missing token"}}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    let id = 0;
    let unsubscribe = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(formatSseEvent(backend.hello(), ++id)));
        unsubscribe = backend.subscribe((event) => {
          controller.enqueue(encoder.encode(formatSseEvent(event, ++id)));
        });
        init.signal?.addEventListener('abort', () => {
          unsubscribe();
          controller.error(new DOMException('aborted', 'AbortError'));
        });
      },
      cancel() {
        unsubscribe();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  };
  const api = createApiClient({
    baseUrl: 'http://mock.local',
    credentials: 'omit',
    fetch,
    ...(clientToken ? { token: clientToken } : {}),
  });
  const store = createUiStore({}, false);
  render(
    <App api={api} queryClient={createQueryClient()} uiStore={store} eventSourceFactory={null} />,
  );
  return { backend, store, requests };
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
});

describe('event stream over fetch (auth v2)', () => {
  it('streams events with the bearer token and applies them', async () => {
    const { backend, store, requests } = setup(TOKEN);
    const app = () => screen.getByTestId(TEST_IDS.app);
    await waitFor(() => expect(app().getAttribute('data-ready')).toBe('true'));
    await waitFor(() => expect(store.getState().connection).toBe('open'));
    const dirty = () =>
      screen.getAllByTestId(TEST_IDS.worktreeItem).filter((el) => el.dataset.dirty === 'true')
        .length;
    const before = dirty();
    const clean = backend.listProjects().projects.flatMap((p) => p.worktrees)[0];
    expect(clean).toBeDefined();
    act(() => {
      backend.mutate(clean?.worktree.id ?? '', 'add');
    });
    await waitFor(() => expect(dirty()).toBeGreaterThanOrEqual(before));
    const events = requests.filter((r) => r.url.includes('/api/events'));
    expect(events).toHaveLength(1);
    expect(requests.length).toBeGreaterThan(1);
    for (const r of requests) {
      expect(r.authorization, r.url).toBe(`Bearer ${TOKEN}`);
      expect(r.credentials, r.url).toBe('omit');
    }
  });

  it('without a valid token: shows the unauthorized state and stops retrying the stream', async () => {
    const { store, requests } = setup(null);
    const banner = await screen.findByTestId(TEST_IDS.errorBanner);
    expect(banner.getAttribute('data-kind')).toBe('auth');
    expect(banner.textContent).toContain('#token=');
    expect(banner.textContent).not.toContain('?token=');
    await waitFor(() => expect(store.getState().connection).toBe('offline'));
    // The client's first reconnect would come after 1 s; a 401 closes the subscription.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(requests.filter((r) => r.url.includes('/api/events'))).toHaveLength(1);
  });
});
