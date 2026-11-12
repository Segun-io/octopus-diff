/**
 * #37: the live-feed contracts are additive. The snapshot is opt-in on `getSummary`, the blob read
 * is an optional `GitCore` method, and object ids are validated as full, lowercase, non-null ids.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BLOB_MAX_BYTES_LIMIT,
  BlobReadOptionsSchema,
  BlobReadSchema,
  type GitCore,
  GitObjectIdSchema,
  SNAPSHOT_MAX_ENTRIES_LIMIT,
  type SummaryOptions,
  type SummaryResult,
  SummarySnapshotOptionSchema,
  SummarySnapshotSchema,
  type WorktreeSummary,
  WorktreeSummarySchema,
} from '../src/index.js';

const sha1 = 'a'.repeat(40);
const sha256 = 'b'.repeat(64);

describe('GitObjectIdSchema', () => {
  it('accepts full 40 and 64 digit lowercase ids only', () => {
    expect(GitObjectIdSchema.safeParse(sha1).success).toBe(true);
    expect(GitObjectIdSchema.safeParse(sha256).success).toBe(true);
    for (const bad of [
      '',
      'abc1234',
      'a'.repeat(39),
      'a'.repeat(41),
      'a'.repeat(63),
      'A'.repeat(40),
      `${'a'.repeat(39)}g`,
      'HEAD',
      '0'.repeat(40),
      '0'.repeat(64),
      `-${'a'.repeat(39)}`,
      `${sha1}\n`,
    ]) {
      expect(GitObjectIdSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('BlobReadOptionsSchema', () => {
  it('bounds maxBytes', () => {
    expect(BlobReadOptionsSchema.safeParse({ oid: sha1 }).success).toBe(true);
    expect(BlobReadOptionsSchema.safeParse({ oid: sha1, maxBytes: 1 }).success).toBe(true);
    for (const maxBytes of [0, -1, 1.5, BLOB_MAX_BYTES_LIMIT + 1]) {
      expect(BlobReadOptionsSchema.safeParse({ oid: sha1, maxBytes }).success).toBe(false);
    }
    expect(BlobReadOptionsSchema.safeParse({ oid: 'main' }).success).toBe(false);
  });

  it('parses the three result kinds', () => {
    const base = { oid: sha1, size: 3, maxBytes: 10 };
    expect(BlobReadSchema.safeParse({ ...base, kind: 'text', content: 'abc' }).success).toBe(true);
    expect(BlobReadSchema.safeParse({ ...base, kind: 'binary', content: null }).success).toBe(true);
    expect(BlobReadSchema.safeParse({ ...base, kind: 'huge', content: null }).success).toBe(false);
  });
});

describe('SummarySnapshotSchema', () => {
  it('parses entries with and without oids', () => {
    const entry = { path: 'a', xy: '.M', hH: sha1, hI: sha1, sig: 's', added: 1, deleted: 0 };
    const parsed = SummarySnapshotSchema.parse({
      entries: [
        entry,
        { ...entry, path: 'u', xy: '??', hH: null, hI: null, added: null, deleted: null },
      ],
      total: 2,
      truncated: false,
    });
    expect(parsed.entries).toHaveLength(2);
    expect(
      SummarySnapshotSchema.safeParse({
        entries: [{ ...entry, xy: 'M' }],
        total: 1,
        truncated: false,
      }).success,
    ).toBe(false);
  });
});

describe('GitCore additions', () => {
  it('keeps summaries assignable and the new members optional', () => {
    expectTypeOf<WorktreeSummary>().toExtend<SummaryResult>();
    expectTypeOf<GitCore['getSummary']>().parameter(1).toEqualTypeOf<SummaryOptions | undefined>();
    expectTypeOf<GitCore['readBlob']>().toBeNullable();
    // The summary schema does not know the snapshot: it never reaches an API payload by accident.
    expect('snapshot' in WorktreeSummarySchema.shape).toBe(false);
  });
});

describe('SummarySnapshotOptionSchema (PR #70 review)', () => {
  it('accepts a boolean or { maxEntries } and nothing else', () => {
    for (const ok of [
      true,
      false,
      {},
      { maxEntries: 1 },
      { maxEntries: SNAPSHOT_MAX_ENTRIES_LIMIT },
    ]) {
      expect(SummarySnapshotOptionSchema.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    }
    for (const bad of [
      null,
      5,
      'yes',
      [],
      { maxEntries: 0 },
      { maxEntries: 1.5 },
      { maxEntries: SNAPSHOT_MAX_ENTRIES_LIMIT + 1 },
      { maxEntries: '10' },
      { max: 10 },
    ]) {
      expect(SummarySnapshotOptionSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
