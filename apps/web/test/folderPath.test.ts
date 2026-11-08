import type { DirEntry, DirsResponse } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import {
  displayPath,
  filterEntries,
  folderText,
  resolveTarget,
  splitLocation,
  tabCompletion,
} from '../src/lib/folderPath.ts';

const entry = (name: string, kind: DirEntry['kind'] = 'dir'): DirEntry => ({
  name,
  path: `/home/u/code/${name}`,
  kind,
  hidden: name.startsWith('.'),
  symlink: false,
});

const listing = (entries: DirEntry[]): DirsResponse => ({
  path: '/home/u/code',
  parent: '/home/u',
  kind: 'dir',
  sep: '/',
  home: '/home/u',
  entries,
  truncated: false,
  places: [],
});

describe('folder picker paths', () => {
  it('splits the location into the listed folder and the typed name', () => {
    expect(splitLocation('~/code/oc')).toEqual({ dir: '~/code/', partial: 'oc' });
    expect(splitLocation('~/code/')).toEqual({ dir: '~/code/', partial: '' });
    expect(splitLocation('~')).toEqual({ dir: '~/', partial: '' });
    expect(splitLocation('/')).toEqual({ dir: '/', partial: '' });
    expect(splitLocation('code')).toEqual({ dir: '', partial: 'code' });
    expect(splitLocation('C:\\Users\\me')).toEqual({ dir: 'C:\\Users\\', partial: 'me' });
  });

  it('shows home as ~ and always ends folder text with a separator', () => {
    expect(displayPath('/home/u', '/home/u', '/')).toBe('~');
    expect(displayPath('/home/u/code', '/home/u', '/')).toBe('~/code');
    expect(displayPath('/home/user2', '/home/u', '/')).toBe('/home/user2');
    expect(folderText('/home/u', '/home/u', '/')).toBe('~/');
    expect(folderText('/', '/home/u', '/')).toBe('/');
    expect(folderText('/tmp', '/home/u', '/')).toBe('/tmp/');
  });

  it('filters by prefix and reveals hidden folders only after a dot', () => {
    const all = [entry('.cache'), entry('alpha'), entry('Alps'), entry('beta')];
    expect(filterEntries(all, '').map((e) => e.name)).toEqual(['alpha', 'Alps', 'beta']);
    expect(filterEntries(all, 'al').map((e) => e.name)).toEqual(['alpha', 'Alps']);
    expect(filterEntries(all, 'ph')).toEqual([]);
    expect(filterEntries(all, '.').map((e) => e.name)).toEqual(['.cache']);
  });

  it('completes like a shell: one match enters, several extend the common prefix', () => {
    expect(tabCompletion([entry('octopus-diff')], 'oc')).toEqual({
      name: 'octopus-diff',
      complete: true,
    });
    expect(tabCompletion([entry('octopus-api'), entry('octopus-diff')], 'oc')).toEqual({
      name: 'octopus-',
      complete: false,
    });
    expect(tabCompletion([entry('side'), entry('scratch')], 's')).toBeNull();
    expect(tabCompletion([], 'x')).toBeNull();
  });

  it('targets the listed folder, the exact entry, or the raw text', () => {
    const l = listing([entry('alpha', 'repo'), entry('notes')]);
    expect(resolveTarget('  ', l)).toBeNull();
    expect(resolveTarget('~/code/', l)).toEqual({
      path: '/home/u/code',
      kind: 'dir',
      exists: true,
    });
    expect(resolveTarget('~/code/alpha', l)).toEqual({
      path: '/home/u/code/alpha',
      kind: 'repo',
      exists: true,
    });
    expect(resolveTarget('~/code/alp', l)).toEqual({
      path: '~/code/alp',
      kind: null,
      exists: false,
    });
    expect(resolveTarget('~/code/alpha', undefined)).toEqual({
      path: '~/code/alpha',
      kind: null,
      exists: null,
    });
  });
});
