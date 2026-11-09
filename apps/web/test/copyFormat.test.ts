import type { DiffScope } from '@octopus-diff/contracts';
import { type FileDiffMetadata, parsePatchFiles } from '@pierre/diffs';
import { describe, expect, it } from 'vitest';
import {
  branchCopyText,
  buildSelectionCopy,
  fenceFor,
  fileCopyTexts,
  inlineCode,
  joinWorktreePath,
  languageForPath,
  rangeLabel,
  type SelectionCopyMeta,
  scopeCopyLabel,
  selectedDiffLines,
  shaCopyText,
} from '../src/lib/copyFormat.ts';
import { escapeSuspicious } from '../src/lib/unicode.ts';

function parse(patch: string): FileDiffMetadata {
  const file = parsePatchFiles(patch, { throwOnError: true })[0]?.files[0];
  if (!file) throw new Error('no file');
  return file;
}

// Old: 1 a / 2 b / 3 c / 4 d / 5 e. New: 1 a / 2 B / 3 B2 / 4 c / 5 d / 6 e.
const MIXED = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,5 +1,6 @@
 a
-b
+B
+B2
 c
 d
 e
`;

const ADDED = `diff --git a/new.py b/new.py
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.py
@@ -0,0 +1,3 @@
+one
+two
+three
`;

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const META: SelectionCopyMeta = {
  project: 'octopus-diff',
  branch: 'feature/x',
  worktreePath: '/home/me/wt/forges',
  headSha: HEAD,
  scope: { kind: 'working' },
  defaultBranch: 'main',
  filePath: 'src/foo.ts',
};

describe('names and paths', () => {
  it('copies relative, name and absolute paths', () => {
    expect(fileCopyTexts({ path: 'src/a/b.ts' }, '/repo')).toEqual({
      relative: 'src/a/b.ts',
      name: 'b.ts',
      absolute: '/repo/src/a/b.ts',
      escaped: false,
    });
    expect(fileCopyTexts({ path: 'top.md' }, '/repo/').absolute).toBe('/repo/top.md');
  });

  it('offers the old path of a rename', () => {
    const t = fileCopyTexts({ path: 'new/x.ts', oldPath: 'old/x.ts' }, '/r');
    expect(t.relative).toBe('new/x.ts');
    expect(t.oldRelative).toBe('old/x.ts');
    expect(fileCopyTexts({ path: 'x', oldPath: 'x' }, '/r').oldRelative).toBeUndefined();
  });

  it('joins Windows roots with backslashes', () => {
    expect(joinWorktreePath('C:\\src\\repo', 'a/b.ts')).toBe('C:\\src\\repo\\a\\b.ts');
  });

  it('escapes invisible and bidirectional characters in paths', () => {
    const t = fileCopyTexts({ path: 'evil\u202Etxt.js' }, '/r');
    expect(t.escaped).toBe(true);
    expect(t.relative).toBe('evil⟨U+202E⟩txt.js');
    expect(t.relative).not.toContain('\u202E');
    expect(t.absolute).toBe('/r/evil⟨U+202E⟩txt.js');
  });

  it('branch and sha', () => {
    expect(branchCopyText({ branch: 'feature/x' })).toBe('feature/x');
    expect(branchCopyText({ branch: null })).toBeNull();
    expect(shaCopyText(HEAD)).toBe('a1b2c3d');
    expect(shaCopyText(HEAD, false)).toBe(HEAD);
  });
});

describe('markdown helpers', () => {
  it('fences longer than any backtick run', () => {
    expect(fenceFor('plain')).toBe('```');
    expect(fenceFor('a ``` b')).toBe('````');
    expect(fenceFor('`````')).toBe('``````');
  });

  it('inline code lengthens its delimiter', () => {
    expect(inlineCode('main')).toBe('`main`');
    expect(inlineCode('a`b')).toBe('``a`b``');
    expect(inlineCode('`x')).toBe('`` `x ``');
  });

  it('language by extension', () => {
    expect(languageForPath('src/a.ts')).toBe('ts');
    expect(languageForPath('a.tsx')).toBe('tsx');
    expect(languageForPath('x/y.py')).toBe('python');
    expect(languageForPath('C:\\r\\main.rs')).toBe('rust');
    expect(languageForPath('Dockerfile')).toBe('dockerfile');
    expect(languageForPath('.gitignore')).toBe('gitignore');
    expect(languageForPath('README')).toBe('text');
    expect(languageForPath('weird.`x')).toBe('text');
  });

  it('scope labels use the toolbar words', () => {
    const label = (scope: DiffScope) => scopeCopyLabel(scope, 'main');
    expect(label({ kind: 'working' })).toBe('uncommitted');
    expect(label({ kind: 'staged' })).toBe('staged');
    expect(label({ kind: 'review' })).toBe('to review');
    expect(label({ kind: 'branch' })).toBe('branch vs `main`');
    expect(label({ kind: 'branch', includeWorking: true })).toBe('all on branch vs `main`');
    expect(label({ kind: 'branch', base: 'dev' })).toBe('branch vs `dev`');
    expect(scopeCopyLabel({ kind: 'branch' }, null)).toBe('branch');
    expect(label({ kind: 'commit', sha: HEAD })).toBe('commit `a1b2c3d`');
  });
});

describe('selected lines', () => {
  const diff = parse(MIXED);

  it('maps added and context lines by new line number', () => {
    const lines = selectedDiffLines(diff, { start: 2, side: 'additions', end: 4 });
    expect(lines.map((l) => [l.change, l.content])).toEqual([
      ['add', 'B'],
      ['add', 'B2'],
      ['context', 'c'],
    ]);
    expect(rangeLabel(lines)).toBe('L2–4');
  });

  it('normalises a reversed range', () => {
    const lines = selectedDiffLines(diff, { start: 4, side: 'additions', end: 2 });
    expect(lines.map((l) => l.content)).toEqual(['B', 'B2', 'c']);
  });

  it('spans deleted and added lines in unified order', () => {
    const lines = selectedDiffLines(diff, {
      start: 1,
      side: 'additions',
      end: 3,
      endSide: 'additions',
    });
    expect(lines.map((l) => l.change)).toEqual(['context', 'delete', 'add', 'add']);
    expect(rangeLabel(lines)).toBe('old L1–2 → new L1–3');
  });

  it('keeps one column in split mode', () => {
    const left = selectedDiffLines(
      diff,
      { start: 1, side: 'deletions', end: 3, endSide: 'deletions' },
      'split',
    );
    expect(left.map((l) => l.content)).toEqual(['a', 'b', 'c']);
    const right = selectedDiffLines(
      diff,
      { start: 1, side: 'additions', end: 4, endSide: 'additions' },
      'split',
    );
    expect(right.map((l) => l.content)).toEqual(['a', 'B', 'B2', 'c']);
  });

  it('returns nothing for a line outside the patch', () => {
    expect(selectedDiffLines(diff, { start: 40, end: 41 })).toEqual([]);
  });
});

describe('buildSelectionCopy', () => {
  const diff = parse(MIXED);
  const copy = (
    range: Parameters<typeof buildSelectionCopy>[0]['range'],
    format: 'plain' | 'markdown',
    meta: Partial<SelectionCopyMeta> = {},
    fileDiff = diff,
  ) => buildSelectionCopy({ fileDiff, range, meta: { ...META, ...meta }, format })?.text;

  it('plain copy is the new-side text without markers', () => {
    expect(copy({ start: 1, side: 'additions', end: 4, endSide: 'additions' }, 'plain')).toBe(
      'a\nB\nB2\nc',
    );
  });

  it('plain copy of only deleted lines is the old-side text', () => {
    expect(copy({ start: 2, side: 'deletions', end: 2, endSide: 'deletions' }, 'plain')).toBe('b');
  });

  it('markdown for new-side lines uses the file language', () => {
    expect(copy({ start: 2, side: 'additions', end: 4 }, 'markdown')).toBe(
      [
        '`src/foo.ts` L2–4 · `feature/x` · octopus-diff',
        'worktree `/home/me/wt/forges` · uncommitted · head `a1b2c3d`',
        '',
        '```ts',
        'B',
        'B2',
        'c',
        '```',
      ].join('\n'),
    );
  });

  it('a single line is L<n>', () => {
    expect(copy({ start: 3, side: 'additions', end: 3 }, 'markdown')?.split('\n')[0]).toBe(
      '`src/foo.ts` L3 · `feature/x` · octopus-diff',
    );
  });

  it('markdown with deleted lines is a diff with a hunk header', () => {
    expect(
      copy({ start: 1, side: 'additions', end: 3, endSide: 'additions' }, 'markdown', {
        scope: { kind: 'branch' },
      }),
    ).toBe(
      [
        '`src/foo.ts` old L1–2 → new L1–3 · `feature/x` · octopus-diff',
        'worktree `/home/me/wt/forges` · branch vs `main` · head `a1b2c3d`',
        '',
        '```diff',
        '@@ -1,2 +1,3 @@',
        ' a',
        '-b',
        '+B',
        '+B2',
        '```',
      ].join('\n'),
    );
  });

  it('only deleted lines: count 0 on the new side', () => {
    const text = copy({ start: 2, side: 'deletions', end: 2 }, 'markdown');
    expect(text?.split('\n')[0]).toBe('`src/foo.ts` old L2 · `feature/x` · octopus-diff');
    expect(text).toContain('@@ -2,1 +1,0 @@\n-b\n');
  });

  it('a new file', () => {
    const text = copy(
      { start: 1, side: 'additions', end: 3 },
      'markdown',
      { filePath: 'new.py' },
      parse(ADDED),
    );
    expect(text?.split('\n')[0]).toBe('`new.py` L1–3 · `feature/x` · octopus-diff');
    expect(text).toContain('```python\none\ntwo\nthree\n```');
  });

  it('detached HEAD and a commit scope', () => {
    const text = copy({ start: 2, side: 'additions', end: 2 }, 'markdown', {
      branch: null,
      scope: { kind: 'commit', sha: HEAD },
    });
    expect(text?.split('\n').slice(0, 2)).toEqual([
      '`src/foo.ts` L2 · detached at `a1b2c3d` · octopus-diff',
      'worktree `/home/me/wt/forges` · commit `a1b2c3d` · head `a1b2c3d`',
    ]);
    expect(
      copy({ start: 2, side: 'additions', end: 2 }, 'markdown', { branch: null, headSha: null })
        ?.split('\n')
        .slice(0, 2),
    ).toEqual([
      '`src/foo.ts` L2 · detached · octopus-diff',
      'worktree `/home/me/wt/forges` · uncommitted',
    ]);
  });

  it('renames name the old path', () => {
    const text = copy({ start: 2, side: 'additions', end: 2 }, 'markdown', {
      oldPath: 'src/old.ts',
    });
    expect(text?.split('\n')[0]).toBe(
      '`src/foo.ts` (renamed from `src/old.ts`) L2 · `feature/x` · octopus-diff',
    );
  });

  it('fences around backticks and escapes backticks in the branch', () => {
    const patch = `diff --git a/a.md b/a.md
--- a/a.md
+++ b/a.md
@@ -1,1 +1,1 @@
-old
+\`\`\`js
`;
    const md = buildSelectionCopy({
      fileDiff: parse(patch),
      range: { start: 1, side: 'additions', end: 1 },
      meta: { ...META, filePath: 'a.md', branch: 'we`ird' },
      format: 'markdown',
    })?.text;
    expect(md?.split('\n')[0]).toBe('`a.md` L1 · ``we`ird`` · octopus-diff');
    expect(md).toContain('````markdown\n```js\n````');
  });

  it('keeps ⟨U+…⟩ escapes and never copies raw invisible characters', () => {
    // The renderer is fed the escaped patch; the copy keeps the escapes as they are.
    const raw = `diff --git a/b.js b/b.js
--- a/b.js
+++ b/b.js
@@ -1,1 +1,1 @@
-x
+if (admin\u202E) {}
`;
    const fileDiff = parse(escapeSuspicious(raw));
    const plain = buildSelectionCopy({
      fileDiff,
      range: { start: 1, side: 'additions', end: 1 },
      meta: { ...META, filePath: 'b\u2066.js' },
      format: 'plain',
    })?.text;
    expect(plain).toBe('if (admin⟨U+202E⟩) {}');
    const md = buildSelectionCopy({
      fileDiff,
      range: { start: 1, side: 'additions', end: 1 },
      meta: { ...META, filePath: 'b\u2066.js' },
      format: 'markdown',
    })?.text;
    expect(md).toContain('`b⟨U+2066⟩.js`');
    expect(md).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
  });

  it('no trailing blank lines', () => {
    const patch = `diff --git a/t.txt b/t.txt
--- a/t.txt
+++ b/t.txt
@@ -1,1 +1,3 @@
 x
+
+
`;
    const md = buildSelectionCopy({
      fileDiff: parse(patch),
      range: { start: 1, side: 'additions', end: 3 },
      meta: { ...META, filePath: 't.txt' },
      format: 'markdown',
    })?.text;
    expect(md?.endsWith('```txt\nx\n```')).toBe(true);
  });
});
