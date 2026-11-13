/**
 * URL <-> UI state (docs/DECISIONS.md #459). The address bar carries what is selected, as plain
 * query parameters on `/`:
 *
 *   ?worktree=<id>[&tab=request][&file=<path>[&raw=<rawPath>]][&scope=<kind>[&base=..][&sha=..][&working=1]]
 *   ?project=<id>      ?folder=<scanRootId>      (the Overview of a project / folder)
 *
 * The daemon token is never part of this: it lives in the fragment (`api/token.ts`), which the
 * router never reads, writes or keeps. Everything here is a pure function so the mapping is unit
 * tested without a router: parsing is lenient (anything invalid is dropped, never thrown), and a
 * stale id is only known to be stale once the project list has loaded, where the landing flow
 * (`useLanding`) takes over.
 */
import {
  CommitShaSchema,
  type DiffScope,
  RefNameSchema,
  type ScopeKind,
  ScopeKindSchema,
  scopeFromQueryFields,
} from '@octopus-diff/contracts';
import { type FileRef, fileRefKey } from '../lib/fileRef.ts';
import type { View } from './ui.tsx';

/** The query parameters, all plain strings (see `parseSearch`). */
export type UrlSearch = Partial<
  Record<
    | 'worktree'
    | 'project'
    | 'folder'
    | 'tab'
    | 'file'
    | 'raw'
    | 'scope'
    | 'base'
    | 'sha'
    | 'working',
    string
  >
>;

/** What the URL says about the selection. `scope` is null when it names none. */
export interface UrlState {
  view: View;
  selected: FileRef | null;
  scope: DiffScope | null;
}

/** Ids are opaque to the web; this only keeps junk (control characters, huge values) out. */
const MAX_VALUE = 4096;
const ID_PATTERN = /^[A-Za-z0-9._~:@-]{1,256}$/;

function id(value: unknown): string | undefined {
  return typeof value === 'string' && ID_PATTERN.test(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= MAX_VALUE ? value : undefined;
}

/**
 * Query string -> plain string values (a router default would JSON-parse them, turning an
 * all-digit id into a number). Unknown and repeated keys are ignored.
 */
export function parseSearch(search: string): UrlSearch {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!(key in out) && value !== '') out[key] = value;
  }
  return out as UrlSearch;
}

export function stringifySearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === 'string' && value !== '') params.set(key, value);
  }
  const out = params.toString();
  return out === '' ? '' : `?${out}`;
}

/** The router's `validateSearch`: keep the parameters this module knows, as valid strings. */
export function validateSearch(input: Record<string, unknown>): UrlSearch {
  return searchOf(stateOfSearch(input));
}

function scopeOfSearch(input: Record<string, unknown>): DiffScope | null {
  const kind = ScopeKindSchema.safeParse(input.scope);
  if (!kind.success) return null;
  const k: ScopeKind = kind.data;
  const base = RefNameSchema.safeParse(input.base);
  const sha = CommitShaSchema.safeParse(input.sha);
  try {
    return scopeFromQueryFields({
      scope: k,
      ...(base.success ? { base: base.data } : {}),
      ...(sha.success ? { sha: sha.data } : {}),
      ...(input.working === '1' ? { working: '1' as const } : {}),
    });
  } catch {
    // `scope=commit` without a usable sha, `scope=review` with a base that is not a commit id.
    return null;
  }
}

/** Parses query parameters (already split) into the selection they name. Never throws. */
export function stateOfSearch(input: Record<string, unknown>): UrlState {
  const worktreeId = id(input.worktree);
  if (worktreeId !== undefined) {
    const file = text(input.file);
    const raw = text(input.raw);
    return {
      view: {
        kind: 'worktree',
        worktreeId,
        ...(input.tab === 'request' ? { tab: 'request' as const } : {}),
      },
      selected:
        file === undefined
          ? null
          : { worktreeId, path: file, ...(raw !== undefined ? { rawPath: raw } : {}) },
      scope: scopeOfSearch(input),
    };
  }
  const projectId = id(input.project);
  if (projectId !== undefined) {
    return { view: { kind: 'project', projectId }, selected: null, scope: null };
  }
  const scanRootId = id(input.folder);
  if (scanRootId !== undefined) {
    return { view: { kind: 'folder', scanRootId }, selected: null, scope: null };
  }
  return { view: { kind: 'none' }, selected: null, scope: null };
}

/** The query parameters for a selection (the inverse of `stateOfSearch`). */
export function searchOf(state: UrlState): UrlSearch {
  const { view, selected, scope } = state;
  switch (view.kind) {
    case 'none':
      return {};
    case 'folder':
      return { folder: view.scanRootId };
    case 'project':
      return { project: view.projectId };
    case 'worktree': {
      const out: UrlSearch = { worktree: view.worktreeId };
      if (view.tab === 'request') out.tab = 'request';
      if (selected && selected.worktreeId === view.worktreeId) {
        out.file = selected.path;
        if (selected.rawPath !== undefined && selected.rawPath !== selected.path) {
          out.raw = selected.rawPath;
        }
      }
      if (scope) {
        out.scope = scope.kind;
        if ((scope.kind === 'branch' || scope.kind === 'review') && scope.base) {
          out.base = scope.base;
        }
        if (scope.kind === 'branch' && scope.includeWorking) out.working = '1';
        if (scope.kind === 'commit') out.sha = scope.sha;
      }
      return out;
    }
  }
}

/** Stable text of a search, for "is the URL already saying this?" comparisons. */
export function searchKey(search: UrlSearch): string {
  return stringifySearch(search as Record<string, unknown>);
}

/** The worktree and file a selection points at, ignoring the scope. */
function placeKey(state: UrlState): string {
  const { view } = state;
  const file = state.selected ? fileRefKey(state.selected) : '';
  switch (view.kind) {
    case 'none':
      return 'none';
    case 'folder':
      return `folder:${view.scanRootId}`;
    case 'project':
      return `project:${view.projectId}`;
    case 'worktree':
      return `worktree:${view.worktreeId}:${view.tab === 'request' ? 'request' : ''}:${file}`;
  }
}

/**
 * How a change of the selection enters the history: a new entry when the user moved to another
 * place (a worktree, a tab, a file of a worktree already showing one); a replacement for the first
 * landing, for a scope change, and when the old place is gone or was never a real one (`known`
 * says whether a worktree/project/folder id still exists), so Back never lands on a dead entry.
 */
export function historyMode(
  prev: UrlState,
  next: UrlState,
  known: (view: View) => boolean,
): 'push' | 'replace' {
  if (prev.view.kind === 'none' || !known(prev.view)) return 'replace';
  if (placeKey(prev) === placeKey(next)) return 'replace';
  // The first file chosen inside a worktree that had none is part of opening it. A tab change is
  // not: on a clean worktree, Changes and Request must stay two entries (PR #105).
  if (
    prev.view.kind === 'worktree' &&
    next.view.kind === 'worktree' &&
    prev.view.worktreeId === next.view.worktreeId &&
    prev.selected === null &&
    next.selected !== null &&
    (prev.view.tab === 'request') === (next.view.tab === 'request')
  ) {
    return 'replace';
  }
  return 'push';
}

/** True when two states name the same selection (view, tab, file and, if both name one, scope). */
export function sameState(a: UrlState, b: UrlState): boolean {
  return searchKey(searchOf(a)) === searchKey(searchOf(b));
}
