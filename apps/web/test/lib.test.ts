import { describe, expect, it } from 'vitest';
import { planBulk } from '../src/lib/bulk.ts';
import { fuzzyMatch, rankBy } from '../src/lib/fuzzy.ts';
import type { FileGroup, NavEntry } from '../src/lib/model.ts';
import { middleEllipsis, worktreeSource } from '../src/lib/source.ts';
import { activeView, selectionOf, viewsFor } from '../src/views/registry.ts';

describe('fuzzy', () => {
  it('matches subsequences and ranks word starts and prefixes first', () => {
    expect(fuzzyMatch('fc', 'fix/cache')?.positions).toEqual([0, 4]);
    expect(fuzzyMatch('xyz', 'fix/cache')).toBeNull();
    const ranked = rankBy(
      'set rev',
      ['Settings: Review', 'Reset everything', 'Settings: General'],
      (s) => s,
    );
    expect(ranked[0]?.item).toBe('Settings: Review');
    expect(rankBy('', ['a', 'b'], (s) => s)).toHaveLength(2);
  });
});

describe('source chip and activity', () => {
  it('infers the worktree source from the path only', () => {
    expect(worktreeSource('/home/dev/.t3/worktrees/x/y')?.id).toBe('t3');
    expect(worktreeSource('/home/dev/code/x/.claude/worktrees/y')?.id).toBe('claude');
    expect(worktreeSource('/home/dev/.codex/worktrees/y')?.id).toBe('codex');
    expect(worktreeSource('/Users/me/conductor/workspaces/y')?.id).toBe('conductor');
    expect(worktreeSource('/home/dev/code/x')).toBeNull();
  });
  it('middle-ellipsis keeps both ends of a path', () => {
    expect(middleEllipsis('/home/dev/code/project/src/index.ts', 20)).toBe('/home/dev/…/index.ts');
  });
});

describe('view registry', () => {
  it('routes worktrees to Changes, folders and projects to Overview', () => {
    expect(activeView({ kind: 'worktree', worktreeId: 'a' }).id).toBe('changes');
    expect(activeView({ kind: 'folder', scanRootId: 'a' }).id).toBe('overview');
    expect(activeView({ kind: 'project', projectId: 'a' }).id).toBe('overview');
    expect(viewsFor(selectionOf({ kind: 'project', projectId: 'a' })).map((v) => v.id)).toEqual([
      'overview',
    ]);
    // Nothing open yet has no view: the app settles it before it renders one.
    expect(() => activeView({ kind: 'none' })).toThrow();
  });
});

describe('planBulk', () => {
  const file = (path: string, reviewed = false) => ({
    path,
    oldPath: null,
    status: 'modified' as const,
    binary: false,
    oldMode: '100644',
    newMode: '100644',
    additions: 1,
    deletions: 0,
    patchHash: `h-${path}`,
    staged: false,
    unstaged: true,
    reviewed,
  });
  const project = { id: 'p', name: 'p' } as unknown as FileGroup['project'];
  const wt = (id: string) => ({
    id,
    projectId: 'p',
    path: `/${id}`,
    branch: id,
    headSha: null,
    detached: false,
    isMain: false,
    bare: false,
    locked: false,
    prunable: false,
    missing: false,
  });
  const groups: FileGroup[] = [
    { project, worktree: wt('a'), files: [file('x'), file('y', true)] },
    { project, worktree: wt('b'), files: [file('z')] },
  ];
  const entries: NavEntry[] = groups.flatMap((g) =>
    g.files.map((f) => ({
      key: `${g.worktree.id}:${f.path}`,
      worktreeId: g.worktree.id,
      projectId: 'p',
      file: f,
    })),
  );
  const hashes = new Map([
    ['a', 'ha'],
    ['b', 'hb'],
  ]);

  it('uses one all request when every worktree is covered and per-worktree paths otherwise', () => {
    const all = planBulk({
      scope: { kind: 'working' },
      reviewed: true,
      groups,
      entries,
      visible: () => true,
      stateHashes: hashes,
      disabled: new Set(),
      allUnfiltered: true,
    });
    expect(all.target).toBe('all');
    expect(all.count).toBe(2);
    expect(all.requests[0]).toMatchObject({
      target: { kind: 'all' },
      expectedStateHashes: { a: 'ha', b: 'hb' },
    });
    const filtered = planBulk({
      scope: { kind: 'working' },
      reviewed: true,
      groups,
      entries,
      visible: (e) => !e.file.reviewed,
      stateHashes: hashes,
      disabled: new Set(['b']),
      allUnfiltered: false,
    });
    expect(filtered.requests).toHaveLength(1);
    expect(filtered.requests[0]).toMatchObject({
      target: { kind: 'worktree', worktreeId: 'a' },
      paths: [{ path: 'x' }],
      expectedStateHashes: { a: 'ha' },
    });
    const clear = planBulk({
      scope: { kind: 'commit', sha: 'abc' },
      reviewed: false,
      groups,
      entries,
      visible: () => true,
      stateHashes: hashes,
      disabled: new Set(),
      allUnfiltered: false,
    });
    expect(clear.count).toBe(1);
    expect(clear.requests[0]?.scope).toEqual({ kind: 'working' });
  });
});

describe('unicode (SEC-05)', () => {
  it('finds, counts, describes and escapes bidi and invisible characters', async () => {
    const { describeSuspicious, escapeSuspicious, findSuspicious, hasSuspicious } = await import(
      '../src/lib/unicode.ts'
    );
    const text = 'user‮ ⁦// admin⁩ ⁦';
    expect(hasSuspicious(text)).toBe(true);
    expect(hasSuspicious(text)).toBe(true); // stateless across calls
    expect(hasSuspicious('plain')).toBe(false);
    const found = findSuspicious(text);
    expect(found.map((f) => [f.codePoint.toString(16), f.count])).toEqual([
      ['2066', 2],
      ['202e', 1],
      ['2069', 1],
    ]);
    expect(describeSuspicious(found)).toBe(
      '4 invisible or bidirectional characters: U+2066 ×2, U+202E, U+2069',
    );
    expect(escapeSuspicious('a‮evil.txt')).toBe('a⟨U+202E⟩evil.txt');
    expect(escapeSuspicious('﻿x​')).toBe('⟨U+FEFF⟩x⟨U+200B⟩');
  });
});
