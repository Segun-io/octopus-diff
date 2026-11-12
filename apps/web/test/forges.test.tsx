// @vitest-environment jsdom
import {
  type ChangeRequest,
  createApiClient,
  type ServerEvent,
  TEST_IDS,
  type WorktreeForge,
} from '@octopus-diff/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { App } from '../src/App.tsx';
import type { EventSourceLike } from '../src/api/hooks.ts';
import { createQueryClient } from '../src/api/queries.ts';
import { changeRequestTitle, indexForges, lookOf, shortRef } from '../src/lib/forge.ts';
import { createUiStore } from '../src/state/ui.tsx';

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

function setup() {
  const backend = new MockBackend({ dataset: 'demo' });
  const mockFetch = createMockFetch(backend);
  const api = createApiClient({ baseUrl: 'http://mock.local', fetch: mockFetch });
  const store = createUiStore({ confirmBulk: false, settledOpen: true }, false);
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
  return { backend, store };
}

afterEach(() => cleanup());

const cr = (over: Partial<ChangeRequest> = {}): ChangeRequest => ({
  kind: 'github',
  number: 12,
  title: 'Add forges',
  url: 'https://github.com/o/r/pull/12',
  state: 'open',
  draft: false,
  author: 'octo',
  baseBranch: 'main',
  headBranch: 'feat',
  headSha: null,
  crossRepository: false,
  headRepository: 'o/r',
  updatedAt: null,
  checks: { state: 'failure', passed: 3, failed: 1, pending: 0, total: 4 },
  review: 'changes_requested',
  conflicts: true,
  comments: 1,
  ...over,
});

describe('forge presentation', () => {
  it('names and describes requests', () => {
    expect(lookOf(cr())).toBe('open');
    expect(lookOf(cr({ draft: true }))).toBe('draft');
    expect(lookOf(cr({ state: 'merged' }))).toBe('merged');
    expect(shortRef(cr())).toBe('PR #12');
    expect(shortRef(cr({ kind: 'gitlab' }))).toBe('MR !12');
    const wf: WorktreeForge = {
      worktreeId: 'x',
      branch: 'feat',
      changeRequest: cr(),
      sync: 'differs',
    };
    expect(changeRequestTitle(wf, cr()).split('\n')).toEqual([
      'PR #12: Add forges',
      'open pull request · feat → main · by octo',
      'checks: 1 failing, 3 passed · changes requested · has conflicts · 1 comment',
      "The pull request's head differs from this worktree's HEAD (unpushed or unpulled commits)",
    ]);
    expect(
      changeRequestTitle(
        wf,
        cr({
          kind: 'gitlab',
          checks: { state: 'pending', passed: null, failed: null, pending: null, total: null },
          review: null,
          conflicts: false,
          comments: 0,
          state: 'merged',
        }),
      ).split('\n')[2],
    ).toBe('pipeline: running');
  });

  it('indexes nothing when disabled', () => {
    expect(
      indexForges({
        enabled: false,
        clis: [],
        projects: [],
        generatedAt: '2026-11-08T00:00:00.000Z',
      }).size,
    ).toBe(0);
    expect(indexForges(null).size).toBe(0);
  });
});

describe('forge UI (mock daemon)', () => {
  it('shows request chips on rows, links the selected one, and turns off from Settings', async () => {
    const { backend } = setup();
    const chips = await screen.findAllByTestId(TEST_IDS.changeRequestChip);
    const states = new Set(chips.map((c) => c.dataset.state));
    expect(states).toEqual(new Set(['open', 'draft', 'merged', 'closed']));
    const expected = backend
      .forges()
      .projects.flatMap((p) => p.worktrees.filter((w) => w.changeRequest));
    expect(chips.length).toBeGreaterThanOrEqual(expected.length);

    // Select the worktree of the first open request: the toolbar links to it.
    const open = expected.find((w) => w.changeRequest?.state === 'open' && !w.changeRequest.draft);
    if (!open?.changeRequest) throw new Error('demo data has no open request');
    const row = screen
      .getAllByTestId(TEST_IDS.worktreeItem)
      .find((r) => r.dataset.worktreeId === open.worktreeId);
    if (!row) throw new Error('row not found');
    fireEvent.click(row);
    const badge = await screen.findByTestId(TEST_IDS.changeRequestBadge);
    expect(badge.getAttribute('href')).toBe(open.changeRequest.url);
    expect(badge.getAttribute('target')).toBe('_blank');
    expect(badge.getAttribute('rel')).toBe('noopener noreferrer');
    expect(badge.dataset.number).toBe(String(open.changeRequest.number));

    // Settings → Forges lists both CLIs; switching off removes every chip (forge.updated).
    fireEvent.click(screen.getByTestId(TEST_IDS.settingsOpenButton));
    const dialog = await screen.findByTestId(TEST_IDS.settingsDialog);
    const section = within(dialog)
      .getAllByTestId(TEST_IDS.settingsSection)
      .find((s) => s.dataset.section === 'forges');
    if (!section) throw new Error('no forges section');
    fireEvent.click(section);
    const clis = await within(dialog).findAllByTestId(TEST_IDS.forgeCliStatus);
    expect(clis.map((c) => [c.dataset.kind, c.dataset.auth])).toEqual([
      ['github', 'authenticated'],
      ['gitlab', 'authenticated'],
    ]);
    const toggle = within(dialog).getByTestId(TEST_IDS.settingsForgesEnabled);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.queryAllByTestId(TEST_IDS.changeRequestChip)).toHaveLength(0),
    );
    expect(backend.settings.forges?.enabled).toBe(false);
  });
});

describe('forge details from batch data (hover card, Overview column)', () => {
  it('the hover card shows the request block only on rows with a request', async () => {
    const { backend } = setup();
    await screen.findAllByTestId(TEST_IDS.changeRequestChip);
    const forges = backend.forges();
    const withRequest = forges.projects
      .flatMap((p) => p.worktrees)
      .find((w) => w.changeRequest?.state === 'open' && !w.changeRequest.draft);
    if (!withRequest?.changeRequest) throw new Error('no open request in the demo data');
    const rows = screen.getAllByTestId(TEST_IDS.worktreeItem);
    const row = rows.find((r) => r.dataset.worktreeId === withRequest.worktreeId);
    if (!row) throw new Error('row not found');
    fireEvent.pointerEnter(row, { pointerType: 'mouse' });
    const card = await screen.findByRole('tooltip', {}, { timeout: 2000 });
    const block = within(card).getByTestId(TEST_IDS.changeRequestHoverBlock);
    expect(block.dataset.number).toBe(String(withRequest.changeRequest.number));
    expect(block.textContent).toContain(withRequest.changeRequest.title);
    expect(block.textContent).toContain(
      `${withRequest.changeRequest.headBranch} → ${withRequest.changeRequest.baseBranch}`,
    );
    expect(block.textContent).toMatch(/checks passed|pipeline/);
    fireEvent.pointerLeave(row);
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());

    const matched = new Set(
      forges.projects
        .flatMap((p) => p.worktrees.filter((w) => w.changeRequest))
        .map((w) => w.worktreeId),
    );
    const plain = rows.find((r) => r.dataset.worktreeId && !matched.has(r.dataset.worktreeId));
    if (!plain) throw new Error('no row without a request');
    fireEvent.pointerEnter(plain, { pointerType: 'mouse' });
    const other = await screen.findByRole('tooltip', {}, { timeout: 2000 });
    expect(within(other).queryByTestId(TEST_IDS.changeRequestHoverBlock)).toBeNull();
  });

  it('the project Overview has a Pull request column with chip, title and review word', async () => {
    const { store, backend } = setup();
    await screen.findAllByTestId(TEST_IDS.changeRequestChip);
    const project = backend
      .forges()
      .projects.find((p) => p.worktrees.some((w) => w.changeRequest?.review));
    if (!project) throw new Error('no project with a reviewed request');
    store.setState({ view: { kind: 'project', projectId: project.projectId } });
    const header = await screen.findByRole('columnheader', { name: 'Pull request' });
    expect(header).toBeTruthy();
    const table = header.closest('table') as HTMLElement;
    const chips = within(table).getAllByTestId(TEST_IDS.changeRequestChip);
    expect(chips.length).toBe(project.worktrees.filter((w) => w.changeRequest).length);
    expect(table.textContent).toContain('review required');
  });
});

describe('rate-limit budget line (#8)', () => {
  const base = {
    host: 'github.com',
    kind: 'github' as const,
    spentLastHour: 1234,
    backgroundLimit: 1500,
    hourlyLimit: 4000,
    remaining: 3200,
    resetAt: null,
    resumeAt: null,
    message: null,
  };

  it('says what was used, and why and until when lookups are held back', async () => {
    const { budgetLine } = await import('../src/lib/forge.ts');
    expect(budgetLine({ ...base, state: 'ok' })).toEqual({
      text: "1,234 points used in the last hour, 3,200 left in github.com's window",
      warn: false,
    });
    const clock = () => '14:32';
    const held = budgetLine(
      {
        ...base,
        state: 'backoff',
        remaining: null,
        resumeAt: '2026-11-11T14:32:00.000Z',
        message: 'github.com refused a request because its rate limit is used up.',
      },
      clock,
    );
    expect(held.warn).toBe(true);
    expect(held.text).toContain('1,234 points used');
    expect(held.text).toContain('rate limit is used up');
    expect(held.text).toContain('Resumes about 14:32.');
    expect(budgetLine({ ...base, kind: 'gitlab', state: 'ok', remaining: null }).text).toBe(
      '1,234 requests used in the last hour',
    );
  });

  it('is shown in Settings → Forges', async () => {
    setup();
    fireEvent.click(await screen.findByTestId(TEST_IDS.settingsOpenButton));
    const dialog = await screen.findByTestId(TEST_IDS.settingsDialog);
    const section = within(dialog)
      .getAllByTestId(TEST_IDS.settingsSection)
      .find((s) => s.dataset.section === 'forges');
    if (!section) throw new Error('no forges section');
    fireEvent.click(section);
    expect(await within(dialog).findByText(/214 points used in the last hour/)).toBeTruthy();
    expect(within(dialog).getByText('Rate limit')).toBeTruthy();
  });
});
