/**
 * A virtual filesystem for the mock's folder picker (`GET /api/fs/dirs`): the known worktrees and
 * scan roots, their ancestors, and a few extra folders so browsing looks like a real home.
 */
import type { DirEntry, DirKind, DirsResponse } from '@octopus-diff/contracts';
import { MockApiError, type MockBackend } from './backend.js';

export const MOCK_HOME = '/home/dev';

/** Folders that exist in every mock, with their kind. */
const EXTRA_DIRS: Array<[string, DirKind]> = [
  ['/home/dev/code/fresh', 'repo'],
  ['/home/dev/code/side-project', 'repo'],
  ['/home/dev/code/scratch', 'dir'],
  ['/home/dev/code/scratch/sandbox', 'repo'],
  ['/home/dev/code/vendor/lib-one', 'repo'],
  ['/home/dev/code/vendor/lib-two', 'repo'],
  ['/home/dev/Documents', 'dir'],
  ['/home/dev/Downloads', 'dir'],
  ['/home/dev/.config/octopus-diff', 'dir'],
  ['/home/dev/.cache', 'dir'],
  ['/tmp', 'dir'],
  ['/usr/local', 'dir'],
];

function parentOf(p: string): string | null {
  if (p === '/') return null;
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function normalize(input: string): string {
  let p = input.trim();
  if (p === '~') p = MOCK_HOME;
  else if (p.startsWith('~/')) p = `${MOCK_HOME}/${p.slice(2)}`;
  else if (!p.startsWith('/')) p = `${MOCK_HOME}/${p}`;
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

/** `known`: path → kind for worktrees (`repo` for main checkouts, `gitfile` for linked ones). */
export function mockListDirs(known: Map<string, DirKind>, input: string | undefined): DirsResponse {
  const kinds = new Map<string, DirKind>([['/', 'dir']]);
  for (const [p, kind] of [...EXTRA_DIRS, ...known]) {
    kinds.set(p, kind);
    for (let up = parentOf(p); up && !kinds.has(up); up = parentOf(up)) kinds.set(up, 'dir');
  }
  const dir = input === undefined ? MOCK_HOME : normalize(input);
  const kind = kinds.get(dir);
  if (kind === undefined) throw new MockApiError(404, 'not_found', `no such folder: ${input}`);

  const entries: DirEntry[] = [...kinds.keys()]
    .filter((p) => p !== dir && parentOf(p) === dir)
    .map((p) => {
      const name = p.slice(p.lastIndexOf('/') + 1);
      return {
        name,
        path: p,
        kind: kinds.get(p) ?? 'dir',
        hidden: name.startsWith('.'),
        symlink: false,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

  return {
    path: dir,
    parent: parentOf(dir),
    kind,
    sep: '/',
    home: MOCK_HOME,
    entries,
    truncated: false,
    places: [
      { label: 'Home', path: MOCK_HOME },
      { label: 'Root', path: '/' },
    ],
  };
}

/** Lists `input` in the virtual filesystem built from the backend's worktrees and scan roots. */
export function listMockDirs(backend: MockBackend, input: string | undefined): DirsResponse {
  const known = new Map<string, DirKind>();
  for (const root of backend.scanRoots) known.set(root.path, 'dir');
  for (const mp of backend.projects) {
    for (const mw of mp.worktrees) {
      known.set(mw.worktree.path, mw.worktree.isMain ? 'repo' : 'gitfile');
    }
  }
  return mockListDirs(known, input);
}
