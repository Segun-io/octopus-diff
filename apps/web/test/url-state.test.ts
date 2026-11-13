import { describe, expect, it } from 'vitest';
import type { View } from '../src/state/ui.tsx';
import {
  historyMode,
  parseSearch,
  searchOf,
  stateOfSearch,
  stringifySearch,
  type UrlState,
  validateSearch,
} from '../src/state/urlState.ts';

const WT = '0123456789abcdef';
const SHA = 'a'.repeat(40);

const wt = (extra: Partial<UrlState> = {}, tab?: 'request'): UrlState => ({
  view: { kind: 'worktree', worktreeId: WT, ...(tab ? { tab } : {}) },
  selected: null,
  scope: { kind: 'working' },
  ...extra,
});

describe('URL <-> state mapping (#459)', () => {
  it('round-trips a worktree, file and scope through the query string', () => {
    const states: UrlState[] = [
      wt(),
      wt({ selected: { worktreeId: WT, path: 'src/a b/ü.ts' } }),
      wt({ selected: { worktreeId: WT, path: 'x', rawPath: 'x\\303' } }),
      wt({ scope: { kind: 'branch', base: 'origin/main', includeWorking: true } }),
      wt({ scope: { kind: 'branch' } }),
      wt({ scope: { kind: 'commit', sha: SHA } }),
      wt({ scope: { kind: 'review', base: SHA } }),
      wt({ scope: { kind: 'review' } }, 'request'),
      { view: { kind: 'project', projectId: WT }, selected: null, scope: null },
      { view: { kind: 'folder', scanRootId: 'direct' }, selected: null, scope: null },
    ];
    for (const state of states) {
      const text = stringifySearch(searchOf(state) as Record<string, unknown>);
      expect(stateOfSearch(parseSearch(text))).toEqual(state);
    }
  });

  it('keeps ids as strings (an all-digit id is not a number)', () => {
    expect(parseSearch('?worktree=1234567890123456').worktree).toBe('1234567890123456');
    expect(stateOfSearch(parseSearch('?worktree=1234567890123456')).view).toEqual({
      kind: 'worktree',
      worktreeId: '1234567890123456',
    });
  });

  it('names no selection for an empty or unrelated address', () => {
    for (const q of ['', '?', '?foo=bar', '?file=src/a.ts', '?scope=branch']) {
      expect(stateOfSearch(parseSearch(q))).toEqual({
        view: { kind: 'none' },
        selected: null,
        scope: null,
      });
    }
  });

  it('drops invalid values without throwing', () => {
    // An id with a slash or a space, a control character, a huge value: no view.
    for (const q of [
      '?worktree=a/b',
      '?worktree=has%20space',
      '?worktree=%00',
      `?worktree=${'x'.repeat(300)}`,
      '?worktree=',
    ]) {
      expect(stateOfSearch(parseSearch(q)).view.kind).toBe('none');
    }
    // A good id keeps its view while a bad scope falls back to "no scope named".
    for (const q of [
      `?worktree=${WT}&scope=bogus`,
      `?worktree=${WT}&scope=commit`,
      `?worktree=${WT}&scope=commit&sha=zzzz`,
      `?worktree=${WT}&scope=review&base=main`,
      `?worktree=${WT}&scope=branch&base=a..b`,
    ]) {
      const state = stateOfSearch(parseSearch(q));
      expect(state.view).toEqual({ kind: 'worktree', worktreeId: WT });
      if (q.includes('scope=branch')) expect(state.scope).toEqual({ kind: 'branch' });
      else expect(state.scope).toBeNull();
    }
    expect(stateOfSearch(parseSearch(`?worktree=${WT}&tab=nope`)).view).toEqual({
      kind: 'worktree',
      worktreeId: WT,
    });
    // A file without a worktree is meaningless.
    expect(stateOfSearch(parseSearch('?file=a.ts')).selected).toBeNull();
  });

  it('validateSearch keeps only what it understands (the router never persists anything else)', () => {
    expect(
      validateSearch({
        worktree: WT,
        token: 'secret-token-0123456789',
        junk: '1',
        scope: 'working',
      }),
    ).toEqual({ worktree: WT, scope: 'working' });
    expect(validateSearch({ worktree: 12 })).toEqual({});
  });

  it('a file belongs to its own worktree only', () => {
    expect(
      searchOf({
        view: { kind: 'worktree', worktreeId: WT },
        selected: { worktreeId: 'fedcba9876543210', path: 'a.ts' },
        scope: null,
      }),
    ).toEqual({ worktree: WT });
  });

  describe('history mode', () => {
    const known = (ids: string[]) => (v: View) =>
      v.kind === 'worktree' && ids.includes(v.worktreeId);
    const other = '1111111111111111';

    it('replaces the landing and anything leaving a stale or empty address', () => {
      const none: UrlState = { view: { kind: 'none' }, selected: null, scope: null };
      expect(historyMode(none, wt(), known([WT]))).toBe('replace');
      expect(
        historyMode(wt(), wt({ view: { kind: 'worktree', worktreeId: other } }), known([other])),
      ).toBe('replace');
    });

    it('pushes a move to another worktree, tab or file; replaces a scope change', () => {
      const here = wt({ selected: { worktreeId: WT, path: 'a.ts' } });
      const k = known([WT, other]);
      expect(historyMode(here, wt({ view: { kind: 'worktree', worktreeId: other } }), k)).toBe(
        'push',
      );
      expect(historyMode(here, wt({ selected: { worktreeId: WT, path: 'b.ts' } }), k)).toBe('push');
      expect(
        historyMode(
          here,
          { ...here, view: { kind: 'worktree', worktreeId: WT, tab: 'request' } },
          k,
        ),
      ).toBe('push');
      expect(historyMode(here, { ...here, scope: { kind: 'branch' } }, k)).toBe('replace');
    });

    it('opening a worktree and its first file is one entry', () => {
      expect(
        historyMode(wt(), wt({ selected: { worktreeId: WT, path: 'a.ts' } }), known([WT])),
      ).toBe('replace');
    });
  });
});
