// @vitest-environment jsdom
import {
  type ChangeRequestCheck,
  type ChangeRequestConversation,
  type ChangeRequestDetail,
  createApiClient,
  FORGE_CHECKS_POLL_MS,
  TEST_IDS,
} from '@octopus-diff/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { App } from '../src/App.tsx';
import { createQueryClient } from '../src/api/queries.ts';
import { liveRefreshInterval, requestFingerprint } from '../src/api/request.ts';
import { Markdown } from '../src/components/request/Markdown.tsx';
import {
  hostAllowed,
  safeHref,
  safeImageSrc,
  splitReferences,
  visibleBody,
} from '../src/lib/markdown.ts';
import {
  buildTimeline,
  conversationItems,
  describeChecks,
  filterItems,
  groupChecks,
  initials,
  pageItems,
} from '../src/lib/request.ts';
import { scopeForPref } from '../src/state/prefs.ts';
import { createUiStore } from '../src/state/ui.tsx';
import { activeView } from '../src/views/registry.ts';

vi.mock('../src/components/diff/DiffRenderer.tsx', () => ({
  DiffRenderer: ({ patch }: { patch: string }) => <pre data-testid="stub-diff">{patch}</pre>,
}));

afterEach(cleanup);

const BASE = 'https://github.com/o/r';
const HOSTS = ['github.com', '*.githubusercontent.com'];

describe('markdown safety rules', () => {
  it('allows https, mailto and fragments; resolves relative links against the forge', () => {
    expect(safeHref('https://x.io/a', BASE)).toBe('https://x.io/a');
    expect(safeHref('mailto:a@b.c', BASE)).toBe('mailto:a@b.c');
    expect(safeHref('#top', BASE)).toBe('#top');
    expect(safeHref('docs/a.md', BASE)).toBe('https://github.com/o/r/docs/a.md');
    expect(safeHref('/o/r/pull/1', BASE)).toBe('https://github.com/o/r/pull/1');
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,x',
      'http://x.io',
      '//evil.io/a',
      'vbscript:x',
      'https://u:p@x.io',
    ]) {
      expect(safeHref(bad, BASE), bad).toBe('');
    }
    expect(safeHref('docs/a.md', null)).toBe('');
  });

  it('loads images only from allowed hosts', () => {
    expect(hostAllowed('avatars.githubusercontent.com', HOSTS)).toBe(true);
    expect(hostAllowed('githubusercontent.com', HOSTS)).toBe(false);
    expect(hostAllowed('evilgithub.com', HOSTS)).toBe(false);
    expect(safeImageSrc('https://user-images.githubusercontent.com/1/a.png', BASE, HOSTS)).toBe(
      'https://user-images.githubusercontent.com/1/a.png',
    );
    expect(safeImageSrc('https://evil.example/p.png', BASE, HOSTS)).toBeNull();
    expect(safeImageSrc('http://github.com/a.png', BASE, HOSTS)).toBeNull();
    expect(safeImageSrc('https://github.com/a.png', BASE, [])).toBeNull();
  });

  it('strips HTML comments and links references', () => {
    expect(visibleBody('<!-- bot -->\n  ')).toBeNull();
    expect(visibleBody('a <!-- x --> b')).toBe('a  b');
    expect(splitReferences('see #12 and x#3', 'github', BASE)).toEqual([
      { text: 'see ' },
      { text: '#12', url: 'https://github.com/o/r/issues/12' },
      { text: ' and x#3' },
    ]);
    expect(
      splitReferences('!7 #8', 'gitlab', 'https://gitlab.com/g/p').map((p) => p.url ?? null),
    ).toEqual([
      'https://gitlab.com/g/p/-/merge_requests/7',
      null,
      'https://gitlab.com/g/p/-/issues/8',
    ]);
  });

  it('renders no active content from hostile markdown', async () => {
    const text = [
      '# Title',
      '<script>window.__pwned = 1</script>',
      '<img src="x" onerror="window.__pwned = 2">',
      '<a href="javascript:alert(1)">raw link</a>',
      '[md link](javascript:alert(1)) [ok](https://example.com/x) [rel](docs/a.md)',
      '![pic](https://user-images.githubusercontent.com/1/a.png) ![pixel](https://evil.example/p.png)',
      '- [x] done',
      'Fixes #42',
      '<details><summary>More</summary>hidden text</details>',
    ].join('\n\n');
    const { container } = render(
      <Markdown text={text} base={BASE} kind="github" imageHosts={HOSTS} />,
    );
    await screen.findByText('Title');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs.some((h) => h?.toLowerCase().startsWith('javascript'))).toBe(false);
    expect(hrefs).toContain('https://example.com/x');
    expect(hrefs).toContain('https://github.com/o/r/docs/a.md');
    expect(hrefs).toContain('https://github.com/o/r/issues/42');
    expect(screen.getByText('md link').closest('a')).toBeNull();
    for (const a of container.querySelectorAll('a[href^="https"]')) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
    const images = [...container.querySelectorAll('img')];
    expect(images.map((i) => i.getAttribute('src'))).toEqual([
      'https://user-images.githubusercontent.com/1/a.png',
    ]);
    expect(images[0]?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(images[0]?.getAttribute('loading')).toBe('lazy');
    expect(screen.getByText('image: pixel ↗').getAttribute('href')).toBe(
      'https://evil.example/p.png',
    );
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

const check = (name: string, status: ChangeRequestCheck['status']): ChangeRequestCheck => ({
  name,
  group: 'CI',
  status,
  description: null,
  url: null,
});

describe('request presentation logic', () => {
  it('groups and describes checks with T3 Code wording', () => {
    expect(describeChecks([])).toBe('No checks reported');
    expect(describeChecks([check('a', 'success'), check('b', 'success')])).toBe(
      'All checks passed',
    );
    expect(describeChecks([check('a', 'failure'), check('b', 'success')])).toBe('1 of 2 failing');
    expect(
      describeChecks([check('a', 'pending'), check('b', 'failure'), check('c', 'success')]),
    ).toBe('1 of 3 running · 1 failed');
    const g = groupChecks([
      check('a', 'action_required'),
      check('b', 'pending'),
      check('c', 'skipped'),
      check('d', 'cancelled'),
    ]);
    expect([g.attention.length, g.running.length, g.completed.length]).toEqual([2, 1, 1]);
  });

  it('polls checks only while live, running and not idle', () => {
    const running = { state: 'open' as const, checkList: [check('a', 'pending')] };
    const done = { state: 'open' as const, checkList: [check('a', 'success')] };
    expect(liveRefreshInterval(running, true, false)).toBe(FORGE_CHECKS_POLL_MS);
    expect(liveRefreshInterval(running, false, false)).toBe(false);
    expect(liveRefreshInterval(running, true, true)).toBe(false);
    expect(liveRefreshInterval(done, true, false)).toBe(false);
    expect(liveRefreshInterval({ ...running, state: 'merged' }, true, false)).toBe(false);
    expect(liveRefreshInterval(null, true, false)).toBe(false);
  });

  it('the detail key follows the batch entry (updatedAt, head, checks)', () => {
    const cr = {
      number: 1,
      updatedAt: 'a',
      headSha: 'b'.repeat(40),
      checks: { state: 'pending' as const, passed: 0, failed: 0, pending: 1, total: 1 },
    };
    const before = requestFingerprint(cr as never);
    expect(requestFingerprint({ ...cr, updatedAt: 'b' } as never)).not.toBe(before);
    expect(
      requestFingerprint({ ...cr, checks: { ...cr.checks, state: 'success' } } as never),
    ).not.toBe(before);
    expect(requestFingerprint(null)).toBe('none');
  });

  const conversation: ChangeRequestConversation = {
    comments: Array.from({ length: 14 }, (_, i) => ({
      id: `c${i}`,
      author: { login: i % 2 ? 'bot[bot]' : 'ada', name: null, avatarUrl: null, bot: i % 2 === 1 },
      body: i === 13 ? '<!-- only a marker -->' : `comment ${i}`,
      bodyTruncated: false,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      editedAt: null,
      url: null,
    })),
    reviews: [],
    threads: [
      {
        id: 't',
        path: 'a.ts',
        line: 1,
        side: 'right',
        resolved: true,
        outdated: false,
        comments: [
          {
            id: 'tc',
            author: null,
            body: 'x',
            bodyTruncated: false,
            createdAt: '2026-01-02T00:00:00.000Z',
            editedAt: null,
            url: null,
          },
        ],
        commentsTotal: 1,
      },
    ],
    commentsTotal: 14,
    reviewsTotal: 0,
    threadsTotal: 1,
    truncated: false,
  };

  it('filters bots and finished items, and pages 10 at a time', () => {
    const items = conversationItems(conversation);
    expect(items.length).toBe(14); // 13 visible comments + 1 thread
    expect(filterItems(items, { bots: false, resolved: true }).length).toBe(8);
    expect(filterItems(items, { bots: true, resolved: false }).length).toBe(13);
    const page = pageItems(items, 10, false);
    expect(page.hidden).toBe(4);
    expect(page.visible.at(-1)?.kind).toBe('thread');
    const newest = pageItems(items, 10, true);
    expect(newest.visible[0]?.kind).toBe('thread');
  });

  it('builds a timeline with lifecycle, commits and the conversation', () => {
    const detail = {
      createdAt: '2026-01-01T00:00:00.000Z',
      author: 'ada',
      state: 'merged',
      mergedAt: '2026-01-03T00:00:00.000Z',
      closedAt: '2026-01-03T00:00:00.000Z',
      mergedBy: { login: 'linus', name: null, avatarUrl: null, bot: false },
      commits: [
        {
          sha: 'a'.repeat(40),
          headline: 'feat',
          committedAt: '2026-01-01T01:00:00.000Z',
          authorName: null,
          authorLogin: 'ada',
        },
      ],
    } as unknown as ChangeRequestDetail;
    const events = buildTimeline(detail, conversation, false);
    expect(events[0]?.kind).toBe('opened');
    expect(events.filter((e) => e.kind === 'commit').length).toBe(1);
    expect(events.at(-1)?.kind).toBe('merged');
    expect(buildTimeline(detail, null, true)[0]?.kind).toBe('merged');
  });

  it('initials for avatar placeholders', () => {
    expect(initials({ login: 'octo', name: 'Ada Lovelace' })).toBe('AL');
    expect(initials({ login: 'renovate[bot]', name: null })).toBe('RE');
    expect(initials(null)).toBe('?');
  });

  it('the registry routes a worktree to its chosen tab when it applies', () => {
    const view = { kind: 'worktree', worktreeId: 'a', tab: 'request' } as const;
    expect(activeView(view, { hasRequest: true }).id).toBe('request');
    expect(activeView(view, { hasRequest: false }).id).toBe('changes');
    expect(activeView({ kind: 'worktree', worktreeId: 'a' }, { hasRequest: true }).id).toBe(
      'changes',
    );
  });
});

function setup() {
  const backend = new MockBackend({ dataset: 'demo' });
  const api = createApiClient({ baseUrl: 'http://mock.local', fetch: createMockFetch(backend) });
  const store = createUiStore(
    { confirmBulk: false, settledOpen: true, scope: scopeForPref('review') },
    false,
  );
  render(
    <App api={api} queryClient={createQueryClient()} uiStore={store} eventSourceFactory={null} />,
  );
  return { backend, store };
}

function openRow(branch: string) {
  const row = screen.getAllByTestId(TEST_IDS.worktreeItem).find((r) => r.dataset.branch === branch);
  if (!row) throw new Error(`no row ${branch}`);
  fireEvent.click(row);
  return row;
}

describe('Request tab (mock daemon)', () => {
  it('appears only for worktrees with a request, and keeps the tab across worktrees', async () => {
    const { store, backend } = setup();
    await screen.findAllByTestId(TEST_IDS.changeRequestChip);
    const forges = backend.forges().projects.flatMap((p) => p.worktrees);
    const withRequest = new Set(forges.filter((w) => w.changeRequest).map((w) => w.worktreeId));
    openRow('feat/auth');
    const tabs = await screen.findByTestId(TEST_IDS.worktreeTabs);
    expect(
      within(tabs)
        .getAllByTestId(TEST_IDS.worktreeTab)
        .map((t) => t.dataset.tab),
    ).toEqual(['changes', 'request']);
    // The toolbar link to the forge stays.
    expect(screen.getByTestId(TEST_IDS.changeRequestBadge)).toBeTruthy();
    fireEvent.click(within(tabs).getAllByTestId(TEST_IDS.worktreeTab)[1] as HTMLElement);
    const view = await screen.findByTestId(TEST_IDS.requestView);
    await waitFor(() => expect(view.dataset.status).toBe('ok'));
    expect(screen.queryByTestId(TEST_IDS.diffViewer)).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'feat auth' })).toBeTruthy();
    expect(view.textContent).toMatch(/main\s*←\s*feat\/auth/);
    // A worktree without a request: Changes, and no tab control.
    const plain = screen
      .getAllByTestId(TEST_IDS.worktreeItem)
      .find((r) => r.dataset.worktreeId && !withRequest.has(r.dataset.worktreeId));
    if (!plain) throw new Error('no plain row');
    fireEvent.click(plain);
    await waitFor(() => expect(screen.queryByTestId(TEST_IDS.requestView)).toBeNull());
    expect(screen.queryByTestId(TEST_IDS.worktreeTabs)).toBeNull();
    expect(store.getState().view).toMatchObject({ kind: 'worktree', tab: 'request' });
    // Back to a worktree with a request: the Request tab again.
    openRow('fix/cache');
    expect(await screen.findByTestId(TEST_IDS.requestView)).toBeTruthy();
  });

  it('Summary: reviewers, labels, merge word, description, grouped checks, conversation', async () => {
    const { store } = setup();
    await screen.findAllByTestId(TEST_IDS.changeRequestChip);
    const row = openRow('feat/auth');
    store.setState({
      view: { kind: 'worktree', worktreeId: row.dataset.worktreeId ?? '', tab: 'request' },
    });
    const view = await screen.findByTestId(TEST_IDS.requestView);
    await waitFor(() => expect(view.dataset.status).toBe('ok'));
    expect(view.textContent).toContain('changes requested');
    expect(view.textContent).toContain('stale');
    expect(view.textContent).toContain('enhancement');
    // The description and the conversation both render markdown; either may land first.
    expect((await screen.findAllByTestId(TEST_IDS.markdown)).length).toBeGreaterThan(0);
    expect(view.querySelector('script')).toBeNull();
    const checks = within(view).getAllByTestId(TEST_IDS.requestCheck);
    expect(checks.map((c) => c.dataset.status)).toContain('failure');
    expect(view.textContent).toMatch(/running|failing|passed/);
    const firstPage = await within(view).findAllByTestId(TEST_IDS.requestConversationItem);
    expect(firstPage.length).toBe(10);
    // Paging: older items come in pages of 10.
    fireEvent.click(within(view).getByRole('button', { name: /Show \d+ older/ }));
    const items = await within(view).findAllByTestId(TEST_IDS.requestConversationItem);
    expect(items.length).toBeGreaterThan(10);
    expect(view.textContent).toContain('only partially loaded');
    // Resolved threads are collapsed to one line, and expand on click.
    expect(items.some((i) => i.textContent?.startsWith('▸Dismissed review'))).toBe(true);
    const collapsed = items.find(
      (i) => i.dataset.collapsed === 'true' && i.textContent?.includes('Resolved'),
    );
    if (!collapsed) throw new Error('no collapsed resolved thread');
    fireEvent.click(collapsed);
    await waitFor(() =>
      expect(
        within(view)
          .getAllByTestId(TEST_IDS.requestConversationItem)
          .some((i) => i.dataset.kind === 'thread' && i.dataset.resolved === 'true'),
      ).toBe(true),
    );
    // Filter out bots.
    const before = within(view).getAllByTestId(TEST_IDS.requestConversationItem).length;
    fireEvent.click(within(view).getByLabelText('Bots'));
    await waitFor(() =>
      expect(within(view).getAllByTestId(TEST_IDS.requestConversationItem).length).toBeLessThan(
        before,
      ),
    );
  });

  it('Timeline and Files; a file changed here opens the Changes tab on it', async () => {
    const { store } = setup();
    await screen.findAllByTestId(TEST_IDS.changeRequestChip);
    const row = openRow('feat/auth');
    const worktreeId = row.dataset.worktreeId ?? '';
    store.setState({ view: { kind: 'worktree', worktreeId, tab: 'request' } });
    const view = await screen.findByTestId(TEST_IDS.requestView);
    await waitFor(() => expect(view.dataset.status).toBe('ok'));
    const tab = (id: string) =>
      within(view)
        .getAllByTestId(TEST_IDS.requestTab)
        .find((t) => t.dataset.tab === id) as HTMLElement;
    fireEvent.click(tab('timeline'));
    const events = await within(view).findAllByTestId(TEST_IDS.requestTimelineItem);
    expect(new Set(events.map((e) => e.dataset.kind))).toEqual(
      new Set(['opened', 'commit', 'comment', 'review', 'thread']),
    );
    fireEvent.click(tab('files'));
    const files = await within(view).findAllByTestId(TEST_IDS.requestFile);
    await waitFor(() => expect(files.some((f) => f.dataset.changedHere === 'true')).toBe(true));
    const here = within(view)
      .getAllByTestId(TEST_IDS.requestFile)
      .find((f) => f.dataset.changedHere === 'true') as HTMLElement;
    fireEvent.click(within(here).getByRole('button'));
    await waitFor(() =>
      expect(store.getState().view).toEqual({ kind: 'worktree', worktreeId, tab: 'changes' }),
    );
    expect(store.getState().selected).toMatchObject({ worktreeId, path: here.dataset.path });
    expect(screen.queryByTestId(TEST_IDS.requestView)).toBeNull();
  });
});

describe('Refresh in the Request tab (#12)', () => {
  /** A daemon whose forge changes the title when "refresh" is asked (reads before are cached). */
  function setupRefresh() {
    const backend = new MockBackend({ dataset: 'demo' });
    const inner = createMockFetch(backend);
    const calls: string[] = [];
    let renamed = false;
    const retitle = async (res: Response, match: boolean) => {
      if (!renamed || !match) return res;
      const body = await res.json();
      if (body.request) body.request = { ...body.request, title: 'Renamed on the forge' };
      for (const project of body.projects ?? []) {
        for (const w of project.worktrees) {
          if (w.changeRequest?.headBranch === 'feat/auth') {
            w.changeRequest = { ...w.changeRequest, title: 'Renamed on the forge' };
          }
        }
      }
      return new Response(JSON.stringify(body), {
        status: res.status,
        headers: { 'content-type': 'application/json' },
      });
    };
    const mockFetch: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.pathname}`);
      if (method === 'POST' && url.pathname.endsWith('/request/refresh')) renamed = true;
      const res = await inner(url.href, init);
      return retitle(
        res,
        url.pathname === '/api/forges' || /\/forges\/worktrees\/[^/]+\/request$/.test(url.pathname),
      );
    };
    const api = createApiClient({ baseUrl: 'http://mock.local', fetch: mockFetch });
    const store = createUiStore(
      { confirmBulk: false, settledOpen: true, scope: scopeForPref('review') },
      false,
    );
    render(
      <App api={api} queryClient={createQueryClient()} uiStore={store} eventSourceFactory={null} />,
    );
    return { calls, store };
  }

  it('shows the refreshed version everywhere and refetches the forge batch', async () => {
    const { calls, store } = setupRefresh();
    await screen.findAllByTestId(TEST_IDS.changeRequestChip);
    const row = openRow('feat/auth');
    store.setState({
      view: { kind: 'worktree', worktreeId: row.dataset.worktreeId ?? '', tab: 'request' },
    });
    const view = await screen.findByTestId(TEST_IDS.requestView);
    await waitFor(() => expect(view.dataset.status).toBe('ok'));
    expect(screen.getByRole('heading', { level: 1, name: 'feat auth' })).toBeTruthy();
    const batches = calls.filter((c) => c === 'GET /api/forges').length;
    fireEvent.click(within(view).getByRole('button', { name: 'Refresh' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Renamed on the forge' }),
    ).toBeTruthy();
    // The batch (chip, hover card, cache keys) was refetched, not only the detail.
    await waitFor(() =>
      expect(calls.filter((c) => c === 'GET /api/forges').length).toBeGreaterThan(batches),
    );
    expect(
      calls.filter((c) => c.startsWith('POST') && c.endsWith('/request/refresh')),
    ).toHaveLength(1);
  });
});
