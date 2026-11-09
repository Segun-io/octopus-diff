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
    // Open requests: the local ones open the worktree's Request tab.
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
    const { store, calls } = setup();
    const sidebar = await screen.findByTestId(TEST_IDS.sidebar);
    const code = sidebar.querySelector<HTMLElement>('[data-folder-id]') as HTMLElement;
    store.setState({ view: { kind: 'folder', scanRootId: code.dataset.folderId ?? '' } });
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
