import type { DirEntry, DirsResponse } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import {
  appendSegment,
  displayPath,
  filterEntries,
  folderText,
  hasTrailingSeparator,
  isBrowseQuery,
  isForeignWindowsPath,
  nextFolderText,
  resolvePastedPath,
  resolveRelative,
  resolveTarget,
  splitLocation,
  startText,
  tabCompletion,
  wslUncToLinux,
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

describe('separators (T3 Code rules)', () => {
  it('splits a /… path only at /, since \\ is a legal file name character there', () => {
    expect(splitLocation('/a\\b')).toEqual({ dir: '/', partial: 'a\\b' });
    expect(hasTrailingSeparator('/a\\')).toBe(false);
    expect(splitLocation('C:\\Users\\me')).toEqual({ dir: 'C:\\Users\\', partial: 'me' });
    expect(splitLocation('~/code\\x')).toEqual({ dir: '~/code\\', partial: 'x' });
  });

  it('enters a folder by appending its name to what was typed', () => {
    expect(appendSegment('~/co', 'code')).toBe('~/code/');
    expect(appendSegment('./', 'src')).toBe('./src/');
    expect(appendSegment('C:\\Users\\', 'me')).toBe('C:\\Users\\me\\');
  });

  it('knows which palette text is a path', () => {
    for (const q of ['/', '~/', '~/code', './x', '../', 'C:\\', '\\\\host\\share']) {
      expect(isBrowseQuery(q)).toBe(true);
    }
    for (const q of ['', '~', '.', '..', 'fix cache', 'settings']) {
      expect(isBrowseQuery(q)).toBe(false);
    }
  });

  it('resolves ./ and ../ against the repository in view', () => {
    expect(resolveRelative('./', '/home/u/code/app', '/')).toBe('/home/u/code/app/');
    expect(resolveRelative('../lib', '/home/u/code/app', '/')).toBe('/home/u/code/lib');
    expect(resolveRelative('../../', '/home/u/code/app', '/')).toBe('/home/u/');
    expect(resolveRelative('../../../../..', '/home/u', '/')).toBe('/');
    expect(resolveRelative('..\\x', 'C:\\code\\app', '\\')).toBe('C:\\code\\x');
    expect(resolveRelative('./x', null, '/')).toBe('./x');
    expect(resolveRelative('~/x', '/home/u', '/')).toBe('~/x');
  });

  it('turns the start folder setting into location text', () => {
    expect(startText('')).toBe('~/');
    expect(startText('  ~/code ')).toBe('~/code/');
    expect(startText('/srv/')).toBe('/srv/');
    expect(startText('D:\\work')).toBe('D:\\work\\');
  });

  it('flags a Windows path sent to a Unix daemon', () => {
    expect(isForeignWindowsPath('C:\\Users', '/')).toBe(true);
    expect(isForeignWindowsPath('C:\\Users', '\\')).toBe(false);
    expect(isForeignWindowsPath('/mnt/c/Users', '/')).toBe(false);
  });
});

// Cases ported from T3 Code's packages/shared/src/path.test.ts (MIT).
describe('resolvePastedPath', () => {
  it.each([
    ['Finder, a space', '', "'/Users/me/Monarch Money'", '/Users/me/Monarch Money'],
    ['Finder, an apostrophe', '', "/Users/me/Bob\\'s\\ Stuff", "/Users/me/Bob's Stuff"],
    ['Finder, a backslash', '', '/Users/me/a\\\\\\ b', '/Users/me/a\\ b'],
    ['Explorer, a drive', '', '"C:\\Users\\me\\My Code"', 'C:\\Users\\me\\My Code'],
    ['Explorer, a share', '', '"\\\\host\\share\\My Code"', '\\\\host\\share\\My Code'],
    ['a shell, home-relative', '', "~/Bob\\'s\\ Stuff", "~/Bob's Stuff"],
    ['surrounding whitespace', '', "  '/Users/me/My Code'\n", '/Users/me/My Code'],
    ['over a selection', '/Users/me/old', "'/Users/me/My Code'", '/Users/me/My Code'],
    ['after a prefilled folder', '~/', "~/'/Users/me/My Code'", '/Users/me/My Code'],
    ['plain, after a prefilled folder', '~/', '~//Users/me/code', '/Users/me/code'],
    ["a shell's quoted apostrophe", '', "'/Users/me/Bob'\\''s Work'", "/Users/me/Bob's Work"],
    ['over part of the box', '~/code/old', "~/code/'/a b'", '/a b'],
  ])('reads the path copied from %s', (_source, previous, next, expected) => {
    expect(resolvePastedPath(previous, next)).toBe(expected);
  });

  it.each([
    ['typing a separator', '/Users/me', '/Users/me/'],
    ['typing a separator after a folder', '~/', '~//'],
    ['deleting', '/Users/me/', '/Users/me'],
    ['pasting a relative folder', '~/', '~/Documents/code'],
    ['a longer path after a folder', '/Users/me/', '/Users/me/code'],
    ['quoted text that is no path', '', "'hello world'"],
    ['a search ending in a quoted path', '', "find '/tmp/repo'"],
    ['a quote left open', '', "'/Users/me/My Code"],
    ['Windows separators', '', 'C:\\Users\\me\\code'],
    ['a backslash before a letter', '', '/Users/me/a\\b'],
  ])('keeps %s', (_case, previous, next) => {
    expect(resolvePastedPath(previous, next)).toBe(next);
  });
});

describe('WSL paths from Windows Explorer', () => {
  it('maps \\\\wsl.localhost and \\\\wsl$ paths to Linux paths', () => {
    expect(wslUncToLinux('\\\\wsl.localhost\\Ubuntu\\home\\me\\code')).toBe('/home/me/code');
    expect(wslUncToLinux('\\\\wsl$\\Ubuntu-24.04\\srv\\')).toBe('/srv');
    expect(wslUncToLinux('\\\\wsl.localhost\\Ubuntu')).toBe('/');
    expect(wslUncToLinux('\\\\host\\share\\x')).toBeNull();
    expect(wslUncToLinux('\\\\wsl.localhost\\bad\u0007name\\x')).toBeNull();
  });

  it('converts a pasted one on a Unix daemon, never while typing', () => {
    const unc = '\\\\wsl.localhost\\Ubuntu\\home\\me';
    expect(nextFolderText('~/', unc, '/')).toBe('/home/me');
    expect(nextFolderText('~/', unc, '\\')).toBe(unc);
    expect(nextFolderText(unc.slice(0, -1), unc, '/')).toBe(unc);
  });
});
