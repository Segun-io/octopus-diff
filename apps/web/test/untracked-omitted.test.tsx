// @vitest-environment jsdom
/**
 * #43: what the web says when the daemon left untracked files out: the notice over the file list,
 * the row's marker, the bulk toast (PR #91 P2-4, P2-5, P3-2).
 */
import {
  type BulkReviewResponse,
  createApiClient,
  FilesResponseSchema,
  type UntrackedOmission,
} from '@octopus-diff/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { describeBulkResult } from '../src/api/bulk.ts';
import { ApiContext, createQueryClient } from '../src/api/queries.ts';
import { WorktreeItem } from '../src/components/SidebarRow.tsx';
import {
  UNTRACKED_OMITTED_TEST_ID,
  UntrackedOmittedNotice,
} from '../src/components/UntrackedOmittedNotice.tsx';
import {
  buildSidebar,
  NO_SIDEBAR_FILTERS,
  rowIndicator,
  type WorktreeRow,
} from '../src/lib/model.ts';
import { mergeResponses } from '../src/state/bulk.ts';
import { createUiStore, UiStoreProvider } from '../src/state/ui.tsx';

afterEach(cleanup);

const OMISSION: UntrackedOmission = {
  count: 30_000,
  limit: 2000,
  directories: [
    {
      path: 'packages/a/node_modules',
      count: 18_000,
      ignoreLine: 'node_modules/',
      generated: true,
    },
    { path: 'packages/b/node_modules', count: 9000, ignoreLine: 'node_modules/', generated: true },
    { path: 'scratch/many', count: 2900, ignoreLine: '/scratch/many/', generated: false },
    { path: 'scratch/more', count: 100, ignoreLine: '/scratch/more/', generated: false },
  ],
};

function show(omission: UntrackedOmission | undefined) {
  return render(
    <UiStoreProvider store={createUiStore({}, false)}>
      <UntrackedOmittedNotice omission={omission} />
    </UiStoreProvider>,
  );
}

const items = (note: HTMLElement) =>
  [...note.querySelectorAll('[data-omitted-dir]')].map((el) => ({
    dir: el.getAttribute('data-omitted-dir'),
    text: el.textContent,
    line: el.querySelector('code')?.textContent ?? null,
    copy: el.querySelector('button')?.getAttribute('aria-label') ?? null,
  }));

describe('UntrackedOmittedNotice (#43)', () => {
  it('says how many files are not listed and puts each line next to its directory', () => {
    show(OMISSION);
    const note = screen.getByTestId(UNTRACKED_OMITTED_TEST_ID);
    expect(note.dataset.count).toBe('30000');
    expect(note.textContent).toContain('30,000 untracked files not listed (more than 2,000)');
    const shown = items(note);
    expect(shown.map((i) => [i.dir, i.line])).toEqual([
      ['packages/a/node_modules', 'node_modules/'],
      ['packages/b/node_modules', 'node_modules/'],
      ['scratch/many', '/scratch/many/'],
    ]);
    // Generated names are called that; other directories are not.
    expect(shown[0]?.text).toContain('dependencies or build output');
    expect(shown[2]?.text).not.toMatch(/build output|dependencies/);
    expect(note.textContent).toContain('and 100 more');
    expect(screen.getAllByRole('button', { name: 'Copy node_modules/' })).toHaveLength(2);
  });

  it('never calls a source directory build output', () => {
    show({
      count: 2500,
      limit: 2000,
      directories: [{ path: 'src', count: 2500, ignoreLine: '/src/', generated: false }],
    });
    const note = screen.getByTestId(UNTRACKED_OMITTED_TEST_ID);
    expect(note.textContent).not.toMatch(/build output|dependencies/);
    expect(note.textContent).toContain('2,500 in src/');
  });

  it('a cut in path order suggests no line', () => {
    show({ count: 700, limit: 2000, directories: [] });
    const note = screen.getByTestId(UNTRACKED_OMITTED_TEST_ID);
    expect(note.textContent).toContain('700 untracked files not listed (more than 2,000)');
    expect(note.textContent).toContain('the last ones in path order');
    expect(note.textContent).not.toContain('.gitignore');
    expect(note.querySelector('code')).toBeNull();
  });

  it('escapes bidi and invisible characters, and offers no copy without a line (SEC-05)', () => {
    show({
      count: 40,
      limit: 5,
      directories: [
        { path: '‮gnp.exe', count: 30, ignoreLine: null, generated: false },
        { path: 'a​b', count: 10, ignoreLine: '/a​b/', generated: false },
      ],
    });
    const note = screen.getByTestId(UNTRACKED_OMITTED_TEST_ID);
    expect(note.textContent).not.toMatch(/[‮​]/);
    expect(note.textContent).toContain('⟨U+202E⟩gnp.exe/');
    const shown = items(note);
    expect(shown[0]).toMatchObject({ line: null, copy: null });
    // A line with such characters (an older daemon) is shown escaped and not offered for copying.
    expect(shown[1]).toMatchObject({ line: '/a⟨U+200B⟩b/', copy: null });
  });

  it('shows nothing without an omission (older daemons, under the cap)', () => {
    show(undefined);
    expect(screen.queryByTestId(UNTRACKED_OMITTED_TEST_ID)).toBeNull();
  });

  it('the files response keeps the field through the client schema', () => {
    const parsed = FilesResponseSchema.parse({
      worktreeId: '0123456789abcdef',
      scope: { kind: 'working' },
      stateHash: 'abc',
      files: [],
      untrackedOmitted: OMISSION,
    });
    expect(parsed.untrackedOmitted).toEqual(OMISSION);
  });
});

// PR #91 P2-5: what "Mark all" could not mark reaches the user, and a reviewed row with omitted
// files does not look like a plainly reviewed one.
describe('omitted files in review (#43)', () => {
  const response = (over: Partial<BulkReviewResponse>): BulkReviewResponse => ({
    ok: true,
    reviewed: true,
    changed: 2,
    unchanged: 0,
    worktrees: 1,
    skippedDisabled: [],
    stale: [],
    undoToken: 't',
    ...over,
  });

  it('the bulk toast says how many untracked files it could not mark', () => {
    const merged = mergeResponses([
      response({ untrackedOmitted: 60 }),
      response({ untrackedOmitted: 1 }),
      response({}),
    ]);
    expect(merged.untrackedOmitted).toBe(61);
    expect(describeBulkResult(merged)).toBe(
      '6 files marked reviewed · 61 untracked files are not listed and cannot be marked',
    );
    expect(describeBulkResult(response({}))).toBe('2 files marked reviewed');
  });

  function reviewedRow(omitted: number | null): WorktreeRow {
    const backend = new MockBackend({ dataset: 'gallery' });
    const model = buildSidebar(
      backend.listProjects().projects,
      NO_SIDEBAR_FILTERS,
      undefined,
      [],
      [],
    );
    const row = [...model.byId.values()].find((r) => r.worktree.branch === 'feat/reviewed');
    if (!row?.summary) throw new Error('gallery changed');
    if (omitted === null) return row;
    return {
      ...row,
      summary: {
        ...row.summary,
        untrackedOmitted: { count: omitted, limit: 2000, directories: [] },
      },
    };
  }

  function mountRow(row: WorktreeRow) {
    const backend = new MockBackend({ dataset: 'gallery' });
    const api = createApiClient({ baseUrl: 'http://mock.local', fetch: createMockFetch(backend) });
    render(
      <ApiContext value={api}>
        <QueryClientProvider client={createQueryClient()}>
          <WorktreeItem
            row={row}
            selected={false}
            onSelect={vi.fn()}
            onMenu={vi.fn()}
            onHide={vi.fn()}
          />
        </QueryClientProvider>
      </ApiContext>,
    );
  }

  it('a row still to review says it too, for screen readers and on the marker', () => {
    // The reviewed row with nine files still to review.
    const row: WorktreeRow = { ...reviewedRow(40), unreviewed: 9, stage: 'review' };
    expect(rowIndicator(row).kind).toBe('review');
    mountRow(row);
    expect(screen.getByTestId('row-status-text').textContent).toBe(
      '9 unreviewed files to review, 40 untracked files not listed',
    );
    expect(screen.getByTestId('not-listed-marker').textContent).toBe('+40 not listed');
  });

  it('a reviewed row with omitted files has its own indicator and a marker', () => {
    expect(rowIndicator(reviewedRow(null)).kind).toBe('reviewed');
    const row = reviewedRow(2500);
    expect(rowIndicator(row)).toEqual({
      kind: 'notListed',
      label: 'reviewed, 2500 untracked files not listed',
    });
    const backend = new MockBackend({ dataset: 'gallery' });
    const api = createApiClient({ baseUrl: 'http://mock.local', fetch: createMockFetch(backend) });
    render(
      <ApiContext value={api}>
        <QueryClientProvider client={createQueryClient()}>
          <WorktreeItem
            row={row}
            selected={false}
            onSelect={vi.fn()}
            onMenu={vi.fn()}
            onHide={vi.fn()}
          />
        </QueryClientProvider>
      </ApiContext>,
    );
    const item = screen.getByTestId('worktree-item');
    expect(item.dataset.stage).toBe('reviewed');
    expect(item.dataset.indicator).toBe('notListed');
    const marker = screen.getByTestId('not-listed-marker');
    expect(marker.textContent).toBe('+2.5k not listed');
    expect(marker.getAttribute('title')).toContain('2500 untracked files are not listed');
    expect(screen.getByTestId('row-status-text').textContent).toContain(
      '2500 untracked files not listed',
    );
  });
});
