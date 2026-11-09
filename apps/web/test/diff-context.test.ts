import { DIFF_CONTEXT_MAX, DiffQuerySchema } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { diffViewKey } from '../src/api/queries.ts';
import {
  CONTEXT_STEP,
  clampContext,
  DEFAULT_CONTEXT,
  FULL_CONTEXT,
  isFullContext,
  nextContext,
  patchShowsWholeFile,
} from '../src/state/diffContext.ts';

const HEADER = 'diff --git a/f.ts b/f.ts\nindex 1111111..2222222 100644\n--- a/f.ts\n+++ b/f.ts\n';

describe('context steps', () => {
  it('never exceeds what the API accepts', () => {
    expect(FULL_CONTEXT).toBe(DIFF_CONTEXT_MAX);
    expect(nextContext(undefined)).toBe(DEFAULT_CONTEXT + CONTEXT_STEP);
    expect(nextContext(FULL_CONTEXT)).toBe(FULL_CONTEXT);
    expect(nextContext(FULL_CONTEXT - 1)).toBe(FULL_CONTEXT);
    // Every step from the default up to "Expand all" stays valid at the API boundary.
    let context: number | undefined;
    for (let i = 0; i < 60_000; i++) context = nextContext(context);
    expect(context).toBe(FULL_CONTEXT);
    const parsed = DiffQuerySchema.safeParse({
      path: 'f.ts',
      scope: 'working',
      context: String(nextContext(FULL_CONTEXT)),
    });
    expect(parsed.success).toBe(true);
  });

  it('clamps odd values', () => {
    expect(clampContext(-5)).toBe(0);
    expect(clampContext(2.6)).toBe(3);
    expect(clampContext(Number.POSITIVE_INFINITY)).toBe(FULL_CONTEXT);
    expect(clampContext(Number.NaN)).toBe(0);
    expect(isFullContext(undefined)).toBe(false);
    expect(isFullContext(FULL_CONTEXT)).toBe(true);
  });
});

describe('patchShowsWholeFile', () => {
  it('is false while unchanged lines are still collapsed', () => {
    const twoHunks = `${HEADER}@@ -1,4 +1,4 @@\n-a\n+A\n b\n c\n d\n@@ -10,4 +10,4 @@\n i\n j\n k\n-l\n+L\n`;
    expect(patchShowsWholeFile(twoHunks, 3)).toBe(false);
    // One hunk that does not start at line 1.
    const middle = `${HEADER}@@ -5,7 +5,7 @@\n e\n f\n g\n-h\n+H\n i\n j\n k\n`;
    expect(patchShowsWholeFile(middle, 3)).toBe(false);
    // Starts at line 1 but the trailing context is full: more lines may follow.
    const head = `${HEADER}@@ -1,4 +1,4 @@\n-a\n+A\n b\n c\n d\n`;
    expect(patchShowsWholeFile(head, 3)).toBe(false);
  });

  it('is true once one hunk covers the file from the first to the last line', () => {
    const whole = `${HEADER}@@ -1,5 +1,5 @@\n-a\n+A\n b\n c\n d\n-e\n+E\n`;
    expect(patchShowsWholeFile(whole, 3)).toBe(true);
    const shortTail = `${HEADER}@@ -1,4 +1,4 @@\n-a\n+A\n b\n c\n d\n`;
    expect(patchShowsWholeFile(shortTail, 23)).toBe(true);
    const noNewline = `${HEADER}@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n`;
    expect(patchShowsWholeFile(noNewline, 3)).toBe(true);
  });

  it('treats added and deleted files as whole, and patches without hunks as not expandable', () => {
    expect(patchShowsWholeFile(`${HEADER}@@ -0,0 +1,3 @@\n+a\n+b\n+c\n`, 3)).toBe(true);
    expect(patchShowsWholeFile(`${HEADER}@@ -1,3 +0,0 @@\n-a\n-b\n-c\n`, 3)).toBe(true);
    expect(patchShowsWholeFile('', 3)).toBe(false);
    expect(patchShowsWholeFile(`${HEADER}Binary files a/f.png and b/f.png differ\n`, 3)).toBe(
      false,
    );
  });

  it('checks every section of a typechange patch', () => {
    const removed =
      'diff --git a/l b/l\ndeleted file mode 120000\n--- a/l\n+++ /dev/null\n@@ -1 +0,0 @@\n-target\n';
    const added =
      'diff --git a/l b/l\nnew file mode 100644\n--- /dev/null\n+++ b/l\n@@ -0,0 +1,2 @@\n+x\n+y\n';
    expect(patchShowsWholeFile(removed + added, 3)).toBe(true);
    const partial = `${HEADER}@@ -3,4 +3,4 @@\n c\n d\n e\n-f\n+F\n`;
    expect(patchShowsWholeFile(removed + partial, 3)).toBe(false);
  });
});

describe('diffViewKey', () => {
  it('differs for every view option, so highlight caches never mix patches', () => {
    const keys = new Set([
      diffViewKey({ ignoreWhitespace: false }),
      diffViewKey({ ignoreWhitespace: true }),
      diffViewKey({ ignoreWhitespace: false, context: 23 }),
      diffViewKey({ ignoreWhitespace: false, context: FULL_CONTEXT }),
      diffViewKey({ ignoreWhitespace: false, full: true }),
    ]);
    expect(keys.size).toBe(5);
  });
});
