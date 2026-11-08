import { describe, expect, it } from 'vitest';
import { cssValue } from './css.js';
import { countPatchLines, hasComparableLineCounts, sampleLines, statusMatches } from './patch.js';

const patch = [
  'diff --git a/x.ts b/x.ts',
  'index 1111111..2222222 100644',
  '--- a/x.ts',
  '+++ b/x.ts',
  '@@ -1,3 +1,3 @@',
  ' context line here',
  '-removed line text',
  '+added line text',
  '+another added line',
  '',
].join('\n');

const file = {
  path: 'x.ts',
  oldPath: null,
  status: 'added' as const,
  binary: false,
  additions: 2,
  deletions: 1,
  oldMode: null,
  newMode: '100644',
};

describe('patch helpers', () => {
  it('counts hunk lines, not headers', () => {
    expect(countPatchLines(patch)).toEqual({ additions: 2, deletions: 1 });
    expect(countPatchLines('')).toEqual({ additions: 0, deletions: 0 });
  });

  it('samples the first added and removed lines', () => {
    expect(sampleLines(patch)).toEqual({ added: 'added line text', removed: 'removed line text' });
  });

  it('treats copied as an acceptable report for an oracle "added" file', () => {
    expect(statusMatches('copied', file)).toBe(true);
    expect(statusMatches('modified', file)).toBe(false);
  });

  it('skips line-count comparison for binary, symlink and submodule entries', () => {
    expect(hasComparableLineCounts(file)).toBe(true);
    expect(hasComparableLineCounts({ ...file, binary: true })).toBe(false);
    expect(hasComparableLineCounts({ ...file, newMode: '160000' })).toBe(false);
    expect(hasComparableLineCounts({ ...file, newMode: '120000' })).toBe(false);
  });

  it('escapes CSS attribute values', () => {
    expect(cssValue('a"b\\c')).toBe('a\\"b\\\\c');
  });
});
