/**
 * #31: merge-noise fields are additive and optional, so payloads of older daemons (no origin
 * fields) and newer ones both parse, and unknown origin values are rejected.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ChangedFileSchema,
  FILE_ORIGIN_VIAS,
  FILE_ORIGINS,
  FileOriginSchema,
  type FileOrigins,
  FileOriginViaSchema,
  type GitCore,
  WorktreeReviewSchema,
} from '../src/index.js';

const file = {
  path: 'a.txt',
  oldPath: null,
  status: 'modified',
  staged: false,
  unstaged: false,
  binary: false,
  oldMode: '100644',
  newMode: '100644',
  additions: 1,
  deletions: 0,
  patchHash: 'p',
  reviewed: false,
} as const;

const review = {
  bookmark: null,
  base: null,
  newCommits: 0,
  unreviewedFiles: 3,
  historyRewritten: false,
};

describe('file origin enums', () => {
  it('lists the origins and vias of the design', () => {
    expect(FILE_ORIGINS).toEqual(['own', 'mixed', 'base']);
    expect(FILE_ORIGIN_VIAS).toEqual([
      'merge',
      'rebase',
      'cherry-pick',
      'update',
      'same-as-base',
      'in-progress',
    ]);
    expect(FileOriginSchema.safeParse('theirs').success).toBe(false);
    expect(FileOriginViaSchema.safeParse('squash').success).toBe(false);
  });
});

describe('ChangedFile.origin / originVia', () => {
  it('parses a file without them (older daemons: own)', () => {
    const parsed = ChangedFileSchema.parse(file);
    expect(parsed.origin).toBeUndefined();
    expect(parsed.originVia).toBeUndefined();
  });

  it('parses base and mixed files', () => {
    const base = { ...file, origin: 'base', originVia: 'merge' } as const;
    expect(ChangedFileSchema.parse(base)).toEqual(base);
    const mixed = { ...file, origin: 'mixed', originVia: 'in-progress' } as const;
    expect(ChangedFileSchema.parse(mixed)).toEqual(mixed);
  });

  it('rejects unknown values', () => {
    expect(ChangedFileSchema.safeParse({ ...file, origin: 'theirs' }).success).toBe(false);
    expect(ChangedFileSchema.safeParse({ ...file, originVia: 'squash' }).success).toBe(false);
  });
});

describe('WorktreeReview noise counts', () => {
  it('parses a review without them (older daemons)', () => {
    expect(WorktreeReviewSchema.parse(review)).toEqual(review);
  });

  it('parses the new counts and label', () => {
    const value = { ...review, baseFiles: 2, unreviewedOwnFiles: 1, integrationRef: 'origin/main' };
    expect(WorktreeReviewSchema.parse(value)).toEqual(value);
  });

  it('rejects negative counts and an empty label', () => {
    expect(WorktreeReviewSchema.safeParse({ ...review, baseFiles: -1 }).success).toBe(false);
    expect(WorktreeReviewSchema.safeParse({ ...review, unreviewedOwnFiles: 1.5 }).success).toBe(
      false,
    );
    expect(WorktreeReviewSchema.safeParse({ ...review, integrationRef: '' }).success).toBe(false);
  });
});

describe('GitCore.readFileOrigins', () => {
  it('is optional, keyed by review-mark path, with nullable via', () => {
    // Optional: a GitCore without it (test doubles, older implementations) still type-checks.
    expectTypeOf<undefined>().toExtend<GitCore['readFileOrigins']>();
    const result: FileOrigins = {
      integrationRef: 'origin/main',
      n: 'a'.repeat(40),
      tip: 'b'.repeat(40),
      origins: new Map([
        ['a.txt', { origin: 'own', via: null }],
        ['b.txt', { origin: 'base', via: 'same-as-base' }],
      ]),
    };
    expect(result.origins.get('b.txt')?.origin).toBe('base');
  });
});
