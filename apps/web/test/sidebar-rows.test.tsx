// @vitest-environment jsdom
/**
 * The sidebar row (#14, DECISIONS #249-#256): the status indicator for every look, the clamped
 * counts, the two-line layout, the actions by state, the accessible name and the memoisation.
 * The fixture is the mock's `gallery` dataset, which has a worktree for every look (and is what
 * `pnpm shots` photographs), so the tests and the screenshots cannot drift apart.
 */
import { createApiClient, type WorktreeListItem } from '@octopus-diff/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { App } from '../src/App.tsx';
import { ApiContext, createQueryClient } from '../src/api/queries.ts';
import { WorktreeItem } from '../src/components/SidebarRow.tsx';
import {
  buildSidebar,
  countLabel,
  NO_SIDEBAR_FILTERS,
  type RowIndicatorKind,
  rowIndicator,
  type WorktreeRow,
} from '../src/lib/model.ts';
import { RECENT_MS, shortAge } from '../src/lib/time.ts';
import { scopeForPref } from '../src/state/prefs.ts';
import { createUiStore } from '../src/state/ui.tsx';

// `rowIndicator` runs once per render of a row (and nowhere else while nothing is hovered): a
// spy on it counts the renders of a memoised `WorktreeItem`. (A React Profiler cannot: it fires
// whenever its own element is re-created, which is exactly what a parent re-render does.)
vi.mock('../src/lib/model.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/model.ts')>();
  return { ...actual, rowIndicator: vi.fn(actual.rowIndicator) };
});

vi.mock('../src/components/diff/DiffRenderer.tsx', () => ({
  DiffRenderer: ({ patch }: { patch: string }) => <pre data-testid="stub-diff">{patch}</pre>,
}));

// --- fixtures -------------------------------------------------------------------------------

const LONG_BRANCH =
  'agent/refactor-the-authentication-middleware-and-session-handling-for-oauth-device-flow';
const LONG_REPO = 'platform-services-monorepo-with-a-very-long-repository-name';

function galleryRows(): Map<string, WorktreeRow> {
  const backend = new MockBackend({ dataset: 'gallery' });
  const forges = new Map(
    backend
      .forges()
      .projects.flatMap((p) => p.worktrees)
      .map((w) => [w.worktreeId, w] as const),
  );
  const model = buildSidebar(
    backend.listProjects().projects,
    NO_SIDEBAR_FILTERS,
    undefined,
    [],
    [],
    forges,
  );
  return new Map([...model.byId.values()].map((r) => [r.worktree.branch ?? 'detached', r]));
}

function mount() {
  const backend = new MockBackend({ dataset: 'gallery' });
  const api = createApiClient({ baseUrl: 'http://mock.local', fetch: createMockFetch(backend) });
  const store = createUiStore({ confirmBulk: false, scope: scopeForPref('working') }, false);
  render(
    <App api={api} queryClient={createQueryClient()} uiStore={store} eventSourceFactory={null} />,
  );
  return { backend, store, user: userEvent.setup() };
}

const item = (branch: string): HTMLElement => {
  const el = screen
    .getAllByTestId('worktree-item')
    .find((e) => (e.dataset.branch || 'detached') === branch);
  if (!el) throw new Error(`no row for ${branch}`);
  return el;
};

/** What a sighted user reads: the row's text without the `sr-only` sentence. */
function visibleText(row: HTMLElement): string {
  const copy = row.cloneNode(true) as HTMLElement;
  for (const el of copy.querySelectorAll('.sr-only')) el.remove();
  return copy.textContent ?? '';
}

/** The same without the names (a branch may be called "reviewed"): only the status words. */
function statusText(row: HTMLElement): string {
  const copy = row.cloneNode(true) as HTMLElement;
  for (const el of copy.querySelectorAll(
    '.sr-only, [data-testid="row-branch"], [data-testid="row-repo"]',
  )) {
    el.remove();
  }
  return copy.textContent ?? '';
}

async function listed() {
  await waitFor(() => expect(screen.getByTestId('sidebar-list').dataset.total).toBe('22'));
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
});

// --- the statuses (model) -------------------------------------------------------------------

describe('row indicator', () => {
  const rows = galleryRows();
  const kindOf = (branch: string): RowIndicatorKind => {
    const row = rows.get(branch);
    if (!row) throw new Error(`no ${branch}`);
    return rowIndicator(row).kind;
  };

  it('has one kind per look, with a sentence for screen readers', () => {
    const expected: Record<string, [RowIndicatorKind, RegExp]> = {
      'feat/one': ['review', /^1 unreviewed file to review$/],
      'feat/nine': ['review', /^9 unreviewed files to review$/],
      'feat/one-thousand-files': ['review', /^1000 unreviewed files to review$/],
      'feat/reviewed': ['reviewed', /^reviewed$/],
      'chore/nothing-to-review': ['clean', /^no changes$/],
      'fix/conflicts': ['conflicts', /^3 conflicts$/],
      'feat/rebase-in-progress': ['operation', /^rebase in progress$/],
      'feat/pr-merged': ['merged', /^request merged$/],
      'feat/pr-closed': ['closed', /^request closed$/],
      'feat/review-off': ['reviewOff', /^review off$/],
      'feat/pr-changes-requested': ['request', /^open request, changes requested$/],
      'old-experiment': ['missing', /^missing/],
      'broken/status': ['error', /^error: git status timed out/],
    };
    for (const [branch, [kind, label]] of Object.entries(expected)) {
      const row = rows.get(branch);
      if (!row) throw new Error(`no ${branch}`);
      const got = rowIndicator(row);
      expect(got.kind, branch).toBe(kind);
      expect(got.label, branch).toMatch(label);
    }
  });

  it('covers loading and "changes, open to review" too: every kind is reachable', () => {
    const row = rows.get('feat/nine');
    if (!row?.summary) throw new Error('gallery changed');
    expect(rowIndicator({ ...row, summary: null }).kind).toBe('loading');
    // The daemon has not computed the review state yet (#10): changes, not "to review".
    const { review: _drop, ...bare } = row.summary;
    expect(rowIndicator({ ...row, summary: bare, unreviewed: 0, stage: 'changed' }).kind).toBe(
      'changed',
    );
    const seen = new Set<RowIndicatorKind>(
      [...rows.values()].map((r) => rowIndicator(r).kind).concat(['loading', 'changed']),
    );
    expect([...seen].sort()).toEqual(
      [
        'changed',
        'clean',
        'closed',
        'conflicts',
        'error',
        'loading',
        'merged',
        'missing',
        'operation',
        'request',
        'reviewOff',
        'review',
        'reviewed',
      ].sort(),
    );
  });

  it('blocked work beats everything else; a missing or failed worktree beats blocked', () => {
    expect(kindOf('fix/conflicts')).toBe('conflicts');
    const row = rows.get('fix/conflicts');
    if (!row) throw new Error('gallery changed');
    expect(rowIndicator({ ...row, worktree: { ...row.worktree, missing: true } }).kind).toBe(
      'missing',
    );
    expect(rowIndicator({ ...row, error: { code: 'x', message: 'boom' } as never }).kind).toBe(
      'error',
    );
  });

  it('counts the own files only: merge noise never reaches a status', () => {
    const projects = new MockBackend({ dataset: 'gallery' }).listProjects().projects.map((p) => ({
      ...p,
      worktrees: p.worktrees.map(
        (w): WorktreeListItem =>
          w.worktree.branch === 'feat/nine' && w.summary?.review
            ? {
                ...w,
                summary: {
                  ...w.summary,
                  review: {
                    ...w.summary.review,
                    // 20 unreviewed files, 17 of them came from a merge.
                    unreviewedFiles: 20,
                    unreviewedOwnFiles: 3,
                    baseFiles: 17,
                  },
                },
              }
            : w,
      ),
    }));
    const row = [...buildSidebar(projects, NO_SIDEBAR_FILTERS).byId.values()].find(
      (r) => r.worktree.branch === 'feat/nine',
    );
    if (!row) throw new Error('gallery changed');
    expect(row.unreviewed).toBe(3);
    expect(rowIndicator(row).label).toBe('3 unreviewed files to review');
  });

  it('clamps counts at 99+', () => {
    expect([0, 1, 9, 99, 100, 1000].map(countLabel)).toEqual(['0', '1', '9', '99', '99+', '99+']);
  });

  it('shows ages short, and "now" inside the recent window', () => {
    const now = Date.parse('2026-11-12T12:00:00.000Z');
    const ago = (ms: number) => new Date(now - ms).toISOString();
    const MIN = 60_000;
    expect(shortAge(ago(10_000), now)).toBe('now');
    expect(shortAge(ago(7 * MIN), now)).toBe('7m');
    expect(shortAge(ago(3 * 60 * MIN), now)).toBe('3h');
    expect(shortAge(ago(2 * 24 * 60 * MIN), now)).toBe('2d');
    expect(shortAge(ago(21 * 24 * 60 * MIN), now)).toBe('3w');
    expect(shortAge(ago(120 * 24 * 60 * MIN), now)).toBe('4mo');
    expect(shortAge(null, now)).toBeNull();
    expect(shortAge('not a date', now)).toBeNull();
    expect(RECENT_MS).toBeGreaterThan(MIN);
  });
});

// --- the rendered rows ----------------------------------------------------------------------

describe('rows in the sidebar', () => {
  it('is two lines: the branch with its status, then the repository and the facts', async () => {
    mount();
    await listed();
    const row = item('feat/ninety-nine');
    const lines = [...row.children] as HTMLElement[];
    // line 1, line 2, and the sr-only status sentence.
    expect(lines).toHaveLength(3);
    expect(within(lines[0] as HTMLElement).getByTestId('row-branch').textContent).toBe(
      'feat/ninety-nine',
    );
    expect(within(lines[0] as HTMLElement).queryByTestId('row-repo')).toBeNull();
    expect(within(lines[1] as HTMLElement).getByTestId('row-repo').textContent).toBe('octopus-api');
    expect(within(lines[1] as HTMLElement).queryByTestId('row-branch')).toBeNull();
    expect(lines[2]?.className).toContain('sr-only');
    // Ahead only: no "↓0".
    expect(visibleText(row)).toContain('↑4');
    expect(visibleText(row)).not.toContain('↓');
    // The row has no height of its own (the virtual list measures it).
    expect(row.closest('li')?.style.height).toBe('');
  });

  it('truncates long names and keeps the full ones in a tooltip', async () => {
    mount();
    await listed();
    const longBranch = within(item(LONG_BRANCH)).getByTestId('row-branch');
    expect(longBranch.className).toContain('truncate');
    expect(longBranch.getAttribute('title')).toBe(LONG_BRANCH);
    const longRepo = within(item('main')).getByTestId('row-repo');
    expect(longRepo.className).toContain('truncate');
    expect(longRepo.getAttribute('title')).toBe(LONG_REPO);
    expect(longRepo.textContent).toBe(LONG_REPO);
  });

  it('puts the own-file count in the pill: 0, 1, 9, 99 and 1000 (as 99+, exact in the tooltip)', async () => {
    mount();
    await listed();
    const pill = (branch: string) => item(branch).querySelector<HTMLElement>('.od-pill');
    expect(pill('chore/nothing-to-review')).toBeNull();
    expect(pill('feat/reviewed')).toBeNull();
    expect(pill('feat/one')?.textContent).toBe('1');
    expect(pill('feat/one')?.title).toBe('1 unreviewed file');
    expect(pill('feat/nine')?.textContent).toBe('9');
    expect(pill('feat/ninety-nine')?.textContent).toBe('99');
    expect(pill('feat/one-thousand-files')?.textContent).toBe('99+');
    expect(pill('feat/one-thousand-files')?.title).toBe('1000 unreviewed files');
    expect(item('feat/one-thousand-files').dataset.unreviewed).toBe('1000');
  });

  it('says only what is informative: no "clean", no "reviewed" word', async () => {
    mount();
    await listed();
    for (const branch of ['chore/nothing-to-review', 'feat/reviewed']) {
      expect(statusText(item(branch)), branch).not.toMatch(/clean|reviewed|no changes/i);
    }
    // The tick and the faint dot are there instead, with their sentence for screen readers.
    expect(item('feat/reviewed').dataset.indicator).toBe('reviewed');
    expect(item('chore/nothing-to-review').dataset.indicator).toBe('clean');
    expect(within(item('feat/reviewed')).getByTestId('row-status-text').textContent).toBe(
      'reviewed',
    );
  });

  it('says conflicts, an operation in progress, merged, closed, review off, missing and error', async () => {
    mount();
    await listed();
    expect(visibleText(item('fix/conflicts'))).toContain('3 conflicts');
    expect(visibleText(item('feat/rebase-in-progress'))).toContain('rebase');
    expect(visibleText(item('feat/pr-merged'))).toContain('merged');
    expect(visibleText(item('feat/pr-closed'))).toContain('closed');
    expect(within(item('feat/review-off')).getByTestId('review-off-badge')).toBeTruthy();
    expect(visibleText(item('old-experiment'))).toContain('missing');
    expect(visibleText(item('broken/status'))).toContain('error');
    expect(visibleText(item('feat/pr-changes-requested'))).toContain('changes requested');
    // The state indicator is a shape per kind, not only a colour.
    const kinds = new Set(
      screen.getAllByTestId('worktree-item').map((e) => e.dataset.indicator as string),
    );
    expect(kinds.size).toBeGreaterThanOrEqual(10);
  });

  it('leaves room for the "N deleted" chip and keeps ahead / behind on the second line', async () => {
    mount();
    await listed();
    const row = item('agent/deleted-files');
    const chip = within(row).getByTestId('deleted-chip');
    expect(chip.textContent).toBe('2 deleted');
    expect(visibleText(item('feat/far-behind'))).toContain('↑12 ↓134');
    // The chip is on the second line, with the repository.
    expect(row.children[1]?.contains(chip)).toBe(true);
  });

  it('marks a change from the last minutes as live, and older ones with a short age', async () => {
    mount();
    await listed();
    const live = within(item('agent/live-edit')).getByTestId('row-age');
    expect(live.dataset.recent).toBe('true');
    expect(live.textContent).toBe('now');
    const old = within(item('feat/ninety-nine')).getByTestId('row-age');
    expect(old.dataset.recent).toBe('false');
    expect(old.textContent).toMatch(/^\d+m$/);
  });

  it('has an accessible name with the branch, the repository and the status', async () => {
    mount();
    await listed();
    const cases: Array<[string, RegExp[]]> = [
      ['feat/nine', [/feat\/nine/, /octopus-api/, /9 unreviewed files to review/]],
      ['fix/conflicts', [/fix\/conflicts/, new RegExp(LONG_REPO), /3 conflicts/]],
      ['feat/pr-merged', [/feat\/pr-merged/, /web/, /request merged/]],
      ['feat/review-off', [/feat\/review-off/, /legacy-tool/, /review off/]],
      ['broken/status', [/broken\/status/, /legacy-tool/, /error: git status timed out/]],
    ];
    for (const [branch, parts] of cases) {
      const row = item(branch);
      // The name is the content, so a screen reader hears it in this order (no aria-label that
      // would hide the pieces); the glyphs are decorative.
      const name = screen
        .getAllByRole('button')
        .find((b) => b === row)
        ?.textContent?.replace(/\s+/g, ' ');
      for (const part of parts) expect(name, branch).toMatch(part);
      expect(row.querySelectorAll('svg:not([aria-hidden="true"])')).toHaveLength(0);
    }
    // Facts that are symbols have words for screen readers.
    expect(item('feat/nine').textContent).toContain('2 ahead, 1 behind');
  });
});

// --- the actions by state -------------------------------------------------------------------

describe('row actions', () => {
  it('reaches the hide action with the keyboard, and Enter hides the row', async () => {
    const { user } = mount();
    await listed();
    const row = item('feat/one');
    const wrapper = row.parentElement as HTMLElement;
    const hide = within(wrapper).getByRole('button', { name: 'Hide until it changes' });
    // Visible on hover and whenever focus is inside the row, never `display: none`.
    expect(hide.parentElement?.className).toContain('focus-within:opacity-100');
    expect(hide.parentElement?.className).toContain('group-hover/wt:opacity-100');
    expect(hide.parentElement?.className).not.toMatch(/\bhidden\b/);
    // Tab order: the row, then its action.
    row.focus();
    await user.tab();
    expect(document.activeElement).toBe(hide);
    await user.keyboard('{Enter}');
    // It leaves the list for the closed Hidden section at the end.
    await user.click(await screen.findByRole('button', { name: 'Expand hidden' }));
    expect(item('feat/one').dataset.hidden).toBe('true');
    expect(item('feat/one').closest('li')?.dataset.section).toBe('hidden');
  });

  it('offers Show again on a hidden row, and the menu keeps both', async () => {
    const { user } = mount();
    await listed();
    fireEvent.contextMenu(item('feat/nine'));
    await user.click(await screen.findByRole('menuitem', { name: 'Hide until it changes' }));
    await user.click(await screen.findByRole('button', { name: 'Expand hidden' }));
    const hidden = item('feat/nine');
    expect(hidden.dataset.hidden).toBe('true');
    expect(
      within(hidden.parentElement as HTMLElement).getByRole('button', { name: 'Show again' }),
    ).toBeTruthy();
    expect(
      within(hidden.parentElement as HTMLElement).getByTestId('row-status-text').textContent,
    ).toContain('hidden');
  });

  it('cannot hide a blocked row: no action at all', async () => {
    mount();
    await listed();
    const wrapper = item('fix/conflicts').parentElement as HTMLElement;
    expect(within(wrapper).queryByRole('button', { name: 'Hide until it changes' })).toBeNull();
  });

  it('selecting a row marks it and keeps the action reachable', async () => {
    const { user } = mount();
    await listed();
    await user.click(item('feat/nine'));
    await waitFor(() => expect(item('feat/nine').getAttribute('aria-current')).toBe('true'));
    expect(item('feat/one').getAttribute('aria-current')).toBeNull();
    const wrapper = item('feat/nine').parentElement as HTMLElement;
    expect(within(wrapper).getByRole('button', { name: 'Hide until it changes' })).toBeTruthy();
  });
});

// --- memoisation ----------------------------------------------------------------------------

describe('row memoisation', () => {
  it('does not re-render a row when another row changes', async () => {
    const backend = new MockBackend({ dataset: 'gallery' });
    const api = createApiClient({ baseUrl: 'http://mock.local', fetch: createMockFetch(backend) });
    const queryClient = createQueryClient();
    const rows = galleryRows();
    const a = rows.get('feat/nine');
    const b = rows.get('feat/one');
    if (!a || !b) throw new Error('gallery changed');
    const callbacks = { onSelect: vi.fn(), onMenu: vi.fn(), onHide: vi.fn() };
    // A new element for the same props each time, like a parent re-rendering its rows.
    const view = (rowB: WorktreeRow) => (
      <ApiContext value={api}>
        <QueryClientProvider client={queryClient}>
          <WorktreeItem row={a} selected={false} {...callbacks} />
          <WorktreeItem row={rowB} selected={false} {...callbacks} />
        </QueryClientProvider>
      </ApiContext>
    );
    const rendersOf = (branch: string) =>
      vi.mocked(rowIndicator).mock.calls.filter(([row]) => row.worktree.branch === branch).length;
    const { rerender } = render(view(b));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(rendersOf('feat/nine')).toBeGreaterThan(0);
    vi.mocked(rowIndicator).mockClear();
    // Another row's data changes: that row renders, this one does not.
    rerender(view({ ...b, unreviewed: b.unreviewed + 1 }));
    expect(rendersOf('feat/one')).toBe(1);
    expect(rendersOf('feat/nine')).toBe(0);
    // And again (a new row object each time, so only B renders):
    rerender(view({ ...b, unreviewed: b.unreviewed + 1 }));
    expect(rendersOf('feat/nine')).toBe(0);
  });
});
