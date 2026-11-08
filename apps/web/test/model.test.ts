import type { ChangedFile, InboxEntry } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import {
  buildSidebar,
  type FileGroup,
  flattenGroups,
  nextUnreviewed,
  repairSelection,
  sortFiles,
  sortInboxEntries,
  stepFile,
  stepWorktree,
  visibleIf,
} from '../src/lib/model.ts';

function demo() {
  const backend = new MockBackend({ dataset: 'demo' });
  return {
    backend,
    projects: backend.listProjects().projects,
    inbox: backend.inbox({ kind: 'working' }, false),
  };
}

function groupsOf(entries: InboxEntry[]): FileGroup[] {
  return sortInboxEntries(entries).map((e) => ({
    project: e.project,
    worktree: e.worktree,
    files: sortFiles(e.files),
  }));
}

function withReviewed(entries: InboxEntry[], reviewed: (f: ChangedFile) => boolean): InboxEntry[] {
  return entries.map((e) => ({
    ...e,
    files: e.files.map((f) => ({ ...f, reviewed: reviewed(f) })),
  }));
}

describe('sidebar model', () => {
  it('sorts projects by name and puts the main worktree first', () => {
    const { projects, inbox } = demo();
    const model = buildSidebar(projects, inbox.entries, {
      text: '',
      onlyDirty: false,
      onlyUnreviewed: false,
    });
    expect(model.groups.map((g) => g.project.name)).toEqual([
      'docs-site',
      'infra',
      'legacy-tool',
      'octopus-api',
      'web-dashboard',
    ]);
    const api = model.groups.find((g) => g.project.name === 'octopus-api');
    expect(api?.rows[0]?.worktree.isMain).toBe(true);
    // Detached worktrees sort after named branches.
    expect(api?.rows.at(-1)?.worktree.branch).toBeNull();
    expect(model.order).toHaveLength(model.byId.size);
  });

  it('filters by text, dirty and unreviewed', () => {
    const { projects, inbox } = demo();
    const text = buildSidebar(projects, inbox.entries, {
      text: 'CACHE',
      onlyDirty: false,
      onlyUnreviewed: false,
    });
    expect(text.order.map((id) => text.byId.get(id)?.worktree.branch)).toEqual(['fix/cache']);

    const dirty = buildSidebar(projects, inbox.entries, {
      text: '',
      onlyDirty: true,
      onlyUnreviewed: false,
    });
    expect(dirty.order).toHaveLength(inbox.entries.length);
    expect([...dirty.order].sort()).toEqual(inbox.entries.map((e) => e.worktree.id).sort());

    const allReviewedApiMain = withReviewed(
      inbox.entries,
      (f) => f.path === 'README.md' || f.path === 'src/server/router.ts',
    );
    const unreviewed = buildSidebar(projects, allReviewedApiMain, {
      text: '',
      onlyDirty: false,
      onlyUnreviewed: true,
    });
    expect(unreviewed.order).toHaveLength(inbox.entries.length - 1);
  });
});

describe('keyboard navigation', () => {
  const { inbox } = demo();
  const entries = flattenGroups(groupsOf(inbox.entries));
  const all = visibleIf(true);

  it('j/k move through files across groups and stop at the ends', () => {
    const first = stepFile(entries, null, 1, all);
    expect(first?.key).toBe(entries[0]?.key);
    const second = stepFile(entries, first?.key ?? null, 1, all);
    expect(second?.key).toBe(entries[1]?.key);
    expect(stepFile(entries, second?.key ?? null, -1, all)?.key).toBe(first?.key);
    expect(stepFile(entries, entries.at(-1)?.key ?? null, 1, all)).toBeNull();
    expect(stepFile(entries, first?.key ?? null, -1, all)).toBeNull();
    // k with nothing selected picks the last file.
    expect(stepFile(entries, null, -1, all)?.key).toBe(entries.at(-1)?.key);
  });

  it('j skips hidden (reviewed) files but keeps the position of a hidden selection', () => {
    const reviewedEntries = flattenGroups(groupsOf(withReviewed(inbox.entries, (_f) => false)));
    const hideIdx = new Set([1, 2]);
    const marked = reviewedEntries.map((e, i) => ({
      ...e,
      file: { ...e.file, reviewed: hideIdx.has(i) },
    }));
    const visible = visibleIf(false);
    // Selection is index 1 (hidden): j goes to 3, k goes to 0.
    expect(stepFile(marked, marked[1]?.key ?? null, 1, visible)?.key).toBe(marked[3]?.key);
    expect(stepFile(marked, marked[1]?.key ?? null, -1, visible)?.key).toBe(marked[0]?.key);
  });

  it('n jumps to the next unreviewed file across projects, wrapping, never the selection', () => {
    // Everything reviewed except one file in web-dashboard and one in docs-site (first group).
    const targets = new Set(['content/intro.md', 'src/components/Table.tsx']);
    const list = flattenGroups(groupsOf(withReviewed(inbox.entries, (f) => !targets.has(f.path))));
    const docs = list.find((e) => e.file.path === 'content/intro.md');
    const table = list.find((e) => e.file.path === 'src/components/Table.tsx');
    expect(nextUnreviewed(list, null)?.key).toBe(docs?.key);
    expect(nextUnreviewed(list, docs?.key ?? null)?.key).toBe(table?.key);
    // From the last unreviewed file it wraps to the first one.
    expect(nextUnreviewed(list, table?.key ?? null)?.key).toBe(docs?.key);
    // From a reviewed file in the middle (octopus-api) it continues forward.
    const middle = list.find((e) => e.file.path === 'src/auth/session.ts');
    expect(nextUnreviewed(list, middle?.key ?? null)?.key).toBe(table?.key);
    // Nothing else left.
    const single = list.filter((e) => e.key === docs?.key || e.file.reviewed);
    expect(nextUnreviewed(single, docs?.key ?? null)).toBeNull();
  });

  it('J/K walk [inbox, ...worktrees] without wrapping', () => {
    const order = ['a', 'b', 'c'];
    expect(stepWorktree(order, null, 1)).toEqual({ changed: true, worktreeId: 'a' });
    expect(stepWorktree(order, 'a', -1)).toEqual({ changed: true, worktreeId: null });
    expect(stepWorktree(order, null, -1)).toEqual({ changed: false, worktreeId: null });
    expect(stepWorktree(order, 'c', 1)).toEqual({ changed: false, worktreeId: 'c' });
    expect(stepWorktree(order, 'gone', 1)).toEqual({ changed: true, worktreeId: 'a' });
  });
});

describe('selection repair', () => {
  const { inbox } = demo();
  const entries = flattenGroups(groupsOf(inbox.entries));
  const all = visibleIf(true);

  it('keeps an existing selection', () => {
    const key = entries[4]?.key ?? null;
    expect(repairSelection(entries, key, 0, all)?.key).toBe(key);
  });

  it('hands over to the neighbor at the same index when the file disappears', () => {
    const removed = entries[4];
    const without = entries.filter((e) => e !== removed);
    expect(repairSelection(without, removed?.key ?? null, 4, all)?.key).toBe(entries[5]?.key);
    // Past the end: clamps to the last file.
    expect(repairSelection(without, 'gone', 999, all)?.key).toBe(without.at(-1)?.key);
    expect(repairSelection([], 'gone', 0, all)).toBeNull();
  });
});
