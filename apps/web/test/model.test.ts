import type { ChangedFile, ChangeRequest, InboxEntry } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import {
  activityMs,
  branchesWithoutWorktree,
  buildSidebar,
  compareByActivity,
  defaultBranchFirst,
  type FileGroup,
  flattenGroups,
  isDefaultBranch,
  NO_SIDEBAR_FILTERS,
  nextUnreviewed,
  placeOf,
  repairSelection,
  rowState,
  settledWord,
  settleToggle,
  sortFiles,
  sortInboxEntries,
  stageOf,
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
  it('sorts projects by name and worktrees by recent activity', () => {
    const { projects, inbox } = demo();
    const model = buildSidebar(projects, inbox.entries, NO_SIDEBAR_FILTERS);
    expect(model.groups.map((g) => g.project.name)).toEqual([
      'docs-site',
      'infra',
      'legacy-tool',
      'octopus-api',
      'web-dashboard',
    ]);
    for (const group of model.groups) {
      const times = group.allRows.map((r) => activityMs(r.summary) ?? -1);
      expect(times).toEqual([...times].sort((a, b) => b - a));
    }
    const branches = (name: string) =>
      model.groups.find((g) => g.project.name === name)?.allRows.map((r) => r.worktree.branch);
    expect(branches('octopus-api')).toEqual(['main', 'feat/auth', 'fix/cache', null]);
    // Recency, not "main first": an agent just committed on agent/codex-123.
    expect(branches('web-dashboard')).toEqual(['agent/codex-123', 'main']);
    expect(model.order).toHaveLength(model.byId.size);
  });

  it('puts worktrees without activity last, and breaks ties main first, detached last', () => {
    const items = demo().projects.flatMap((p) => p.worktrees);
    const main = items.find((w) => w.worktree.isMain);
    const branch = items.find((w) => !w.worktree.isMain && w.worktree.branch !== null);
    const detached = items.find((w) => w.worktree.branch === null);
    if (!main?.summary || !branch?.summary || !detached) throw new Error('demo fixture changed');
    const base = main.summary;
    const at = (iso: string | null) => ({ ...base, activityAt: iso });
    const older = { worktree: main.worktree, summary: at('2026-11-01T00:00:00.000Z') };
    const newer = { worktree: branch.worktree, summary: at('2026-11-02T00:00:00.000Z') };
    const unknown = { worktree: branch.worktree, summary: at(null) };
    const loading = { worktree: main.worktree, summary: null };
    expect([older, unknown, newer].sort(compareByActivity)).toEqual([newer, older, unknown]);
    expect(compareByActivity(loading, newer)).toBeGreaterThan(0);
    // Same (or no) activity: the previous order.
    const tie = '2026-11-03T00:00:00.000Z';
    const rows = [
      { worktree: detached.worktree, summary: at(tie) },
      { worktree: branch.worktree, summary: at(tie) },
      { worktree: main.worktree, summary: at(tie) },
    ];
    expect(rows.sort(compareByActivity).map((r) => r.worktree.id)).toEqual([
      main.worktree.id,
      branch.worktree.id,
      detached.worktree.id,
    ]);
  });

  it('filters by picked projects and worktrees (a union), dirty and unreviewed', () => {
    const { projects, inbox } = demo();
    const cache = projects
      .flatMap((p) => p.worktrees)
      .find((w) => w.worktree.branch === 'fix/cache');
    const infra = projects.find((p) => p.project.name === 'infra');
    if (!cache || !infra) throw new Error('demo fixture changed');
    const one = buildSidebar(projects, inbox.entries, {
      ...NO_SIDEBAR_FILTERS,
      worktrees: [cache.worktree.id],
    });
    expect(one.order.map((id) => one.byId.get(id)?.worktree.branch)).toEqual(['fix/cache']);
    // byId keeps every row: the dropdown lists what the filters hide.
    expect(one.byId.size).toBe(projects.flatMap((p) => p.worktrees).length);

    const union = buildSidebar(projects, inbox.entries, {
      ...NO_SIDEBAR_FILTERS,
      projects: [infra.project.id],
      worktrees: [cache.worktree.id],
    });
    const cacheProject = projects.find((p) => p.worktrees.includes(cache))?.project.name;
    expect(union.groups.map((g) => g.project.name).sort()).toEqual(
      [infra.project.name, cacheProject].sort(),
    );
    expect(union.order).toHaveLength(infra.worktrees.length + 1);

    const dirty = buildSidebar(projects, inbox.entries, {
      ...NO_SIDEBAR_FILTERS,
      onlyDirty: true,
    });
    expect(dirty.order).toHaveLength(inbox.entries.length);
    expect([...dirty.order].sort()).toEqual(inbox.entries.map((e) => e.worktree.id).sort());

    const allReviewedApiMain = withReviewed(
      inbox.entries,
      (f) => f.path === 'README.md' || f.path === 'src/server/router.ts',
    );
    const unreviewed = buildSidebar(projects, allReviewedApiMain, {
      ...NO_SIDEBAR_FILTERS,
      onlyUnreviewed: true,
    });
    expect(unreviewed.order).toHaveLength(inbox.entries.length - 1);
  });
});

describe('Overview helpers', () => {
  it('puts the default-branch worktree first and keeps the rest in order', () => {
    const { projects, inbox } = demo();
    const model = buildSidebar(projects, inbox.entries, NO_SIDEBAR_FILTERS);
    const web = model.groups.find((g) => g.project.name === 'web-dashboard');
    if (!web) throw new Error('no web-dashboard');
    expect(web.allRows.map((r) => r.worktree.branch)).toEqual(['agent/codex-123', 'main']);
    expect(defaultBranchFirst(web.allRows).map((r) => r.worktree.branch)).toEqual([
      'main',
      'agent/codex-123',
    ]);
    expect(web.allRows.filter((r) => isDefaultBranch(r.worktree, r.project))).toHaveLength(1);
    // Detached worktrees are never the default branch.
    const api = model.groups.find((g) => g.project.name === 'octopus-api');
    const detached = api?.allRows.find((r) => r.worktree.branch === null);
    if (!detached) throw new Error('no detached worktree');
    expect(isDefaultBranch(detached.worktree, detached.project)).toBe(false);
  });

  it('lists the branches no worktree has checked out', () => {
    const { projects, inbox } = demo();
    const model = buildSidebar(projects, inbox.entries, NO_SIDEBAR_FILTERS);
    const web = model.groups.find((g) => g.project.name === 'web-dashboard');
    if (!web) throw new Error('no web-dashboard');
    const branches = [{ name: 'main' }, { name: 'old/x' }, { name: 'agent/codex-123' }];
    expect(branchesWithoutWorktree(branches, web.allRows)).toEqual([{ name: 'old/x' }]);
  });
});

describe('stages (docs/STATUS-FLOW.md §2.2)', () => {
  const { projects } = demo();
  const all = projects.flatMap((p) => p.worktrees);
  const base = all.find((w) => w.summary && !w.worktree.missing && !w.summary.inProgress);
  if (!base?.summary) throw new Error('fixture');
  const summary = { ...base.summary, counts: { ...base.summary.counts, conflicted: 0 } };
  const worktree = base.worktree;
  const on = { enabled: true };

  it('derives each stage', () => {
    expect(
      stageOf({ summary: { ...summary, inProgress: 'rebase' }, worktree, unreviewed: 3 }),
    ).toBe('blocked');
    expect(
      stageOf({
        summary: { ...summary, counts: { ...summary.counts, conflicted: 1 } },
        worktree,
        unreviewed: 0,
        review: { enabled: false },
      }),
    ).toBe('blocked');
    expect(stageOf({ summary, worktree, unreviewed: 2, review: on })).toBe('review');
    // commits count through their files: nothing unreviewed left = reviewed
    expect(stageOf({ summary, worktree, unreviewed: 0, newCommits: 2, review: on })).toBe(
      'reviewed',
    );
    expect(stageOf({ summary, worktree, unreviewed: 0, newCommits: 0, review: on })).toBe(
      'reviewed',
    );
    expect(stageOf({ summary, worktree, unreviewed: 4, review: { enabled: false } })).toBe('off');
    expect(stageOf({ summary: null, worktree, unreviewed: 0 })).toBe('off');
    expect(stageOf({ summary, worktree: { ...worktree, missing: true }, unreviewed: 1 })).toBe(
      'off',
    );
  });

  it('forge stages: In PR, merged/closed for this HEAD, never over To review (§2.5)', () => {
    const cr = (over: Partial<ChangeRequest>): ChangeRequest => ({
      kind: 'github',
      number: 42,
      title: 't',
      url: 'https://github.com/o/r/pull/42',
      state: 'open',
      draft: false,
      author: null,
      baseBranch: 'main',
      headBranch: 'feature',
      headSha: summary.headSha,
      crossRepository: false,
      headRepository: null,
      updatedAt: null,
      checks: null,
      review: null,
      conflicts: null,
      comments: null,
      ...over,
    });
    const clean = { ...summary, changedFiles: 0 };
    const forge = (
      over: Partial<ChangeRequest>,
      sync: 'same' | 'differs' | 'unknown' = 'unknown',
    ) => ({
      changeRequest: cr(over),
      sync,
    });
    const at = (f: ReturnType<typeof forge>, unreviewed = 0, s = clean) =>
      stageOf({ summary: s, worktree, unreviewed, review: on, forge: f });
    expect(at(forge({}))).toBe('inPR');
    expect(at(forge({}), 3)).toBe('review'); // never overrides To review
    expect(at(forge({ draft: true }))).toBe('reviewed');
    expect(at(forge({ state: 'merged' }))).toBe('merged');
    expect(at(forge({ state: 'closed' }))).toBe('closed');
    // merged even with unreviewed commits: they are counted on the target branch
    expect(at(forge({ state: 'merged' }), 2)).toBe('merged');
    // a newer local HEAD: the request is not this work any more
    expect(at(forge({ state: 'merged', headSha: 'f'.repeat(40) }))).toBe('reviewed');
    expect(at(forge({ state: 'merged', headSha: 'f'.repeat(40) }, 'same'))).toBe('merged');
    // merged with uncommitted work left: not the shelf, To review or quietly under the project
    const dirty = { ...summary, changedFiles: 2 };
    expect(at(forge({ state: 'merged' }), 2, dirty)).toBe('review');
    expect(at(forge({ state: 'merged' }), 0, dirty)).toBe('merged');
    expect(placeOf('merged', true)).toBe('active');
    expect(placeOf('merged', false)).toBe('settled');
    // forges off / no data: those stages never apply
    expect(stageOf({ summary: clean, worktree, unreviewed: 0, review: on, forge: null })).toBe(
      'reviewed',
    );
  });

  it('Show brings back a merged worktree with unreviewed files (forge data on the row)', () => {
    const { projects: list } = demo();
    const target = list.flatMap((p) => p.worktrees).find((w) => w.worktree.id === worktree.id);
    if (!target?.summary) throw new Error('fixture');
    const merged = {
      ...target.summary,
      counts: { ...target.summary.counts, conflicted: 0 },
      inProgress: null,
      changedFiles: 0,
      review: {
        bookmark: 'a'.repeat(40),
        base: 'a'.repeat(40),
        newCommits: 3,
        unreviewedFiles: 1,
        historyRewritten: false,
      },
    };
    const projects = list.map((p) => ({
      ...p,
      worktrees: p.worktrees.map((w) =>
        w.worktree.id === worktree.id ? { ...w, summary: merged } : w,
      ),
    }));
    const forges = new Map([
      [
        worktree.id,
        {
          changeRequest: {
            kind: 'github' as const,
            number: 3,
            title: 't',
            url: 'https://github.com/o/r/pull/3',
            state: 'merged' as const,
            draft: false,
            author: null,
            baseBranch: 'main',
            headBranch: 'feature',
            headSha: merged.headSha,
            crossRepository: false,
            headRepository: null,
            updatedAt: null,
            checks: null,
            review: null,
            conflicts: null,
            comments: null,
          },
          sync: 'unknown' as const,
        },
      ],
    ]);
    const build = (settle: Parameters<typeof buildSidebar>[5] = []) =>
      buildSidebar(projects, undefined, NO_SIDEBAR_FILTERS, undefined, [], settle, forges).byId.get(
        worktree.id,
      );
    const hidden = build();
    expect(hidden?.state).toBe('settled');
    if (!hidden) throw new Error('row');
    const next = settleToggle(hidden);
    expect(next).toBe('active');
    const shown = build([
      { worktreeId: worktree.id, state: 'active', stateHash: merged.stateHash },
    ]);
    expect(shown?.state).toBe('active');
    // and Hide sends it back to the shelf by dropping the override
    if (!shown) throw new Error('row');
    expect(settleToggle(shown)).toBeNull();
  });

  it('places stages: blocked and To review under the project, the rest in the shelf', () => {
    expect(placeOf('blocked')).toBe('blocked');
    expect(placeOf('review')).toBe('attention');
    expect(placeOf('inPR')).toBe('active');
    for (const stage of ['reviewed', 'merged', 'closed', 'off'] as const) {
      expect(placeOf(stage)).toBe('settled');
    }
  });

  it('"Hide until it changes" holds only for the same state hash; blocked is never hidden', () => {
    const hide = {
      worktreeId: worktree.id,
      state: 'settled' as const,
      stateHash: summary.stateHash,
    };
    expect(rowState({ summary, worktree, unreviewed: 2 }, hide)).toEqual({
      state: 'settled',
      settledBy: 'user',
    });
    const changed = { ...summary, stateHash: 'other' };
    expect(rowState({ summary: changed, worktree, unreviewed: 2 }, hide).state).toBe('attention');
    const blocked = { ...summary, inProgress: 'merge' as const };
    expect(
      rowState({ summary: blocked, worktree, unreviewed: 2 }, { ...hide, stateHash: 'x' }).state,
    ).toBe('blocked');
  });

  it('says "reviewed", never "verified"', () => {
    const review = { enabled: true, source: 'default' as const };
    const dirty = { ...summary, changedFiles: 2 };
    expect(settledWord({ summary: dirty, worktree, error: null, review })).toBe('reviewed');
    expect(
      settledWord({ summary: { ...summary, changedFiles: 0 }, worktree, error: null, review }),
    ).toBe('clean');
  });

  it('the sidebar takes no scope: the same inputs give the same rows', () => {
    const { projects: list, inbox } = demo();
    const a = buildSidebar(list, inbox.entries, NO_SIDEBAR_FILTERS);
    const b = buildSidebar(list, inbox.entries, NO_SIDEBAR_FILTERS);
    expect([...a.byId.values()].map((r) => [r.worktree.id, r.state, r.stage])).toEqual(
      [...b.byId.values()].map((r) => [r.worktree.id, r.state, r.stage]),
    );
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

describe('document title', () => {
  it('shows the unreviewed count only when enabled and non-zero', async () => {
    const { formatTitle } = await import('../src/lib/title.ts');
    expect(formatTitle(12, true)).toBe('(12) octopus-diff');
    expect(formatTitle(0, true)).toBe('octopus-diff');
    expect(formatTitle(12, false)).toBe('octopus-diff');
  });
});
