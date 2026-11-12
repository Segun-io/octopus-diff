// @vitest-environment jsdom
import { createApiClient, TEST_IDS } from '@octopus-diff/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { App } from '../src/App.tsx';
import { createQueryClient } from '../src/api/queries.ts';
import { remoteLabel } from '../src/lib/forge.ts';
import { relativeTime } from '../src/lib/time.ts';
import { createUiStore } from '../src/state/ui.tsx';

vi.mock('../src/components/diff/DiffRenderer.tsx', () => ({
  DiffRenderer: ({ patch }: { patch: string }) => <pre data-testid="stub-diff">{patch}</pre>,
}));

afterEach(cleanup);

function setup() {
  const backend = new MockBackend({ dataset: 'demo' });
  const mockFetch = createMockFetch(backend);
  const calls: string[] = [];
  const recording = (input: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(input, 'http://mock.local').pathname}`);
    return mockFetch(input, init);
  };
  const api = createApiClient({ baseUrl: 'http://mock.local', fetch: recording });
  const store = createUiStore({ confirmBulk: false, settledOpen: true }, false);
  render(
    <App api={api} queryClient={createQueryClient()} uiStore={store} eventSourceFactory={null} />,
  );
  return { backend, store, calls };
}

describe('repository information helpers', () => {
  it('labels remotes as host/path', () => {
    expect(remoteLabel('https://github.com/o/r.git')).toBe('github.com/o/r');
    expect(remoteLabel('git@GitHub.com:o/r')).toBe('github.com/o/r');
    expect(remoteLabel('ssh://git@gitlab.example.com:2222/g/s/p.git')).toBe(
      'gitlab.example.com/g/s/p',
    );
    expect(remoteLabel('/srv/git/app.git')).toBeNull();
    expect(remoteLabel('file:///srv/git/app.git')).toBeNull();
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-11-09T12:00:00.000Z');
    expect(relativeTime('2026-11-09T11:59:30.000Z', now)).toBe('just now');
    expect(relativeTime('2026-11-09T11:40:00.000Z', now)).toBe('20 min ago');
    expect(relativeTime('2026-11-09T07:00:00.000Z', now)).toBe('5 h ago');
    expect(relativeTime('2026-11-08T07:00:00.000Z', now)).toBe('yesterday');
    expect(relativeTime('2026-11-01T07:00:00.000Z', now)).toBe('8 days ago');
    expect(relativeTime('2026-01-01T07:00:00.000Z', now)).toBe('1 Jan');
    expect(relativeTime('2025-01-01T07:00:00.000Z', now)).toBe('1 Jan 2025');
    expect(relativeTime(null, now)).toBe('unknown');
  });
});

async function overviewTab(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const tab = screen.getAllByTestId(TEST_IDS.overviewTab).find((t) => t.dataset.tab === id);
    if (!tab) throw new Error(`no ${id} tab`);
    return tab;
  });
}

async function openProject(name: string) {
  const ctx = setup();
  await screen.findAllByTestId(TEST_IDS.worktreeItem);
  const project = ctx.backend.listProjects().projects.find((p) => p.project.name === name);
  if (!project) throw new Error(`no ${name}`);
  ctx.store.setState({ view: { kind: 'project', projectId: project.project.id } });
  await screen.findByTestId(TEST_IDS.repoInfoLocal);
  return { ...ctx, project };
}

describe('project Overview lists (mock daemon)', () => {
  it('tabs: Worktrees first with the default branch on top; arrows move between tabs', async () => {
    await openProject('octopus-api');
    const worktrees = await overviewTab('worktrees');
    expect(worktrees.getAttribute('aria-selected')).toBe('true');
    expect(worktrees.textContent).toBe('Worktrees4');
    const rows = await screen.findAllByTestId('overview-worktree-row');
    expect(rows[0]?.dataset.default).toBe('true');
    expect(within(rows[0] as HTMLElement).getByTestId(TEST_IDS.defaultBranchChip)).toBeTruthy();
    expect(rows.filter((r) => r.dataset.default === 'true')).toHaveLength(1);
    // Roving tab stop: only the selected tab is in the Tab order; → selects the next one.
    expect(worktrees.tabIndex).toBe(0);
    expect((await overviewTab('branches')).tabIndex).toBe(-1);
    worktrees.focus();
    fireEvent.keyDown(worktrees, { key: 'ArrowRight' });
    const branches = await overviewTab('branches');
    await waitFor(() => expect(branches.getAttribute('aria-selected')).toBe('true'));
    expect(document.activeElement).toBe(branches);
    fireEvent.keyDown(branches, { key: 'End' });
    await waitFor(() => expect(document.activeElement?.getAttribute('data-tab')).toBe('requests'));
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(
      document.activeElement?.id,
    );
  });

  it('Branches lists local branches without a worktree, 15 a page', async () => {
    await openProject('octopus-api');
    const tab = await overviewTab('branches');
    await waitFor(() => expect(tab.textContent).toBe('Branches18'));
    fireEvent.click(tab);
    const rows = await screen.findAllByTestId(TEST_IDS.overviewBranchRow);
    expect(rows).toHaveLength(15);
    const names = rows.map((r) => r.dataset.branch);
    expect(names).not.toContain('main');
    expect(names).not.toContain('feat/auth');
    const pager = screen.getByTestId(TEST_IDS.pager);
    expect(pager.dataset.pages).toBe('2');
    expect(pager.textContent).toContain('1–15 of 18');
    fireEvent.click(within(pager).getByRole('button', { name: 'Next branches' }));
    await waitFor(() => expect(screen.getAllByTestId(TEST_IDS.overviewBranchRow)).toHaveLength(3));
    expect(screen.getByTestId(TEST_IDS.pager).textContent).toContain('16–18 of 18');
    // An open request whose head is a local branch links to it; merged branches say so.
    const all = screen.getAllByTestId(TEST_IDS.overviewBranchRow);
    expect(all.some((r) => r.dataset.merged === 'true')).toBe(true);
    expect(screen.getByText(/merged into/)).toBeTruthy();
  });

  it('Pull requests shows at most 15 and links to the rest on the forge', async () => {
    await openProject('octopus-api');
    const tab = await overviewTab('requests');
    expect(tab.textContent).toBe('Pull requests27');
    fireEvent.click(tab);
    const rows = await screen.findAllByTestId(TEST_IDS.repoOpenRequest);
    expect(rows).toHaveLength(15);
    const more = screen.getByRole('link', { name: /12 more on github\.com/ });
    expect(more.getAttribute('href')).toBe('https://github.com/octo-demo/octopus-api/pulls');
    expect(screen.queryByTestId(TEST_IDS.pager)).toBeNull();
  });

  it('pages the worktree table at 15 rows', async () => {
    const backend = new MockBackend({
      dataset: 'large',
      largeProjects: 1,
      largeWorktreesPerProject: 20,
      largeFilesPerWorktree: 1,
    });
    const api = createApiClient({ baseUrl: 'http://mock.local', fetch: createMockFetch(backend) });
    const store = createUiStore({ confirmBulk: false }, false);
    render(
      <App api={api} queryClient={createQueryClient()} uiStore={store} eventSourceFactory={null} />,
    );
    await screen.findAllByTestId(TEST_IDS.worktreeItem);
    const project = backend.listProjects().projects[0];
    if (!project) throw new Error('no project');
    store.setState({ view: { kind: 'project', projectId: project.project.id } });
    await waitFor(() => expect(screen.getAllByTestId('overview-worktree-row')).toHaveLength(15));
    const pager = screen.getByTestId(TEST_IDS.pager);
    expect(pager.textContent).toContain(`1–15 of ${project.worktrees.length}`);
    expect(within(pager).getByRole('button', { name: 'Previous worktrees' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(within(pager).getByRole('button', { name: 'Next worktrees' }));
    await waitFor(() =>
      expect(screen.getAllByTestId('overview-worktree-row')).toHaveLength(
        project.worktrees.length - 15,
      ),
    );
  });
});

describe('Overview repository information (mock daemon)', () => {
  it('the project Overview shows local facts, forge facts and the open requests', async () => {
    const { store, backend } = setup();
    await screen.findAllByTestId(TEST_IDS.worktreeItem);
    const project = backend.listProjects().projects.find((p) => p.project.name === 'octopus-api');
    if (!project) throw new Error('no octopus-api');
    store.setState({ view: { kind: 'project', projectId: project.project.id } });
    const local = await screen.findByTestId(TEST_IDS.repoInfoLocal);
    await waitFor(() => expect(local.textContent).toContain('origin'));
    expect(local.textContent).toContain('github.com/octo-demo/octopus-api');
    expect(local.textContent).toMatch(/\d+ branches · \d+ tags · 4 worktrees/);
    expect(local.textContent).toContain('vs origin/main');
    const forge = await screen.findByTestId(TEST_IDS.repoInfoForge);
    expect(forge.dataset.status).toBe('ok');
    await waitFor(() => expect(forge.textContent).toContain('pull requests'));
    expect(forge.textContent).toContain('github.com/octo-demo/octopus-api');
    // Open requests (their tab): the local ones open the worktree's Request tab.
    fireEvent.click(await overviewTab('requests'));
    const rows = await screen.findAllByTestId(TEST_IDS.repoOpenRequest);
    const mine = rows.find((r) => r.dataset.worktree);
    if (!mine) throw new Error('no local open request');
    fireEvent.click(mine);
    await waitFor(() =>
      expect(store.getState().view).toEqual({
        kind: 'worktree',
        worktreeId: mine.dataset.worktree,
        tab: 'request',
      }),
    );
    expect(rows.some((r) => !r.dataset.worktree)).toBe(true);
  });

  it('the folder Overview adds repository columns and roll-ups without forge queries', async () => {
    const { store, calls, backend } = setup();
    await screen.findAllByTestId(TEST_IDS.worktreeItem);
    // No folder headers in the sidebar any more (#13): the Overview opens from the palette or a
    // row's menu; here the view is set directly.
    const code = backend.scanRoots[0];
    expect(code).toBeDefined();
    store.setState({ view: { kind: 'folder', scanRootId: code?.id ?? '' } });
    const header = await screen.findByRole('columnheader', { name: 'Default branch' });
    const table = header.closest('table') as HTMLElement;
    await waitFor(() => expect(table.textContent).toContain('github.com/octo-demo/octopus-api'));
    expect(within(table).getByRole('columnheader', { name: 'PRs' })).toBeTruthy();
    expect(screen.getByText('open pull requests')).toBeTruthy();
    expect(screen.getByText('need attention')).toBeTruthy();
    expect(calls.filter((c) => c.includes('/api/forges/projects/'))).toEqual([]);
    expect(calls.filter((c) => c.startsWith('GET /api/repositories')).length).toBeGreaterThan(0);
  });
});
