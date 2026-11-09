import { describe, expect, it } from 'vitest';
import {
  AddScanRootRequestSchema,
  appendScopeParams,
  ChangedFileSchema,
  DiffQuerySchema,
  DiffScopeSchema,
  FilesQuerySchema,
  InboxQuerySchema,
  ProjectSchema,
  RefNameSchema,
  RepoPathSchema,
  ReviewRequestSchema,
  scopeKey,
  WorktreeSummarySchema,
} from '../src/index.js';

const id = '0123456789abcdef';
const now = new Date('2026-11-08T12:00:00.000Z').toISOString();

describe('RepoPathSchema', () => {
  it.each(['a.txt', 'src/index.ts', 'dir with space/ü.md', '.gitignore', '..foo', 'a/.b/c'])(
    'accepts %s',
    (value) => {
      expect(RepoPathSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each(['', '/etc/passwd', '../x', 'a/../b', 'a/./b', '.', 'a\u0000b'])(
    'rejects %j',
    (value) => {
      expect(RepoPathSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('RefNameSchema', () => {
  it.each(['main', 'origin/main', 'refs/heads/feature/x', 'release-1.2', 'v1.0'])(
    'accepts %s',
    (value) => {
      expect(RefNameSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each([
    '',
    '-main',
    '--output=/tmp/x',
    'a..b',
    'a b',
    'main~1',
    'main^',
    'a:b',
    'x@{1}',
    'x.lock',
    'trailing/',
    '@',
    'a\tb',
  ])('rejects %j', (value) => {
    expect(RefNameSchema.safeParse(value).success).toBe(false);
  });
});

describe('DiffScopeSchema', () => {
  it('parses every scope kind', () => {
    for (const scope of [
      { kind: 'working' },
      { kind: 'staged' },
      { kind: 'unstaged' },
      { kind: 'branch' },
      { kind: 'branch', base: 'main' },
      { kind: 'commit', sha: 'deadbeef' },
      { kind: 'branch', includeWorking: true },
      { kind: 'review' },
      { kind: 'review', base: 'a'.repeat(40) },
    ]) {
      expect(DiffScopeSchema.parse(scope)).toEqual(scope);
    }
  });

  it('rejects a commit scope without a hex sha', () => {
    expect(DiffScopeSchema.safeParse({ kind: 'commit', sha: 'HEAD' }).success).toBe(false);
    expect(DiffScopeSchema.safeParse({ kind: 'commit' }).success).toBe(false);
  });

  it('builds stable scope keys', () => {
    expect(scopeKey({ kind: 'working' })).toBe('working');
    expect(scopeKey({ kind: 'branch' })).toBe('branch');
    expect(scopeKey({ kind: 'branch', base: 'main' })).toBe('branch:main');
    expect(scopeKey({ kind: 'commit', sha: 'DEADBEEF' })).toBe('commit:deadbeef');
    expect(scopeKey({ kind: 'branch', includeWorking: true })).toBe('branch:~w');
    expect(scopeKey({ kind: 'branch', base: 'main', includeWorking: true })).toBe('branch:main:~w');
    expect(scopeKey({ kind: 'review' })).toBe('review');
    expect(scopeKey({ kind: 'review', base: 'ABCDEF12' })).toBe('review:abcdef12');
  });

  it('rejects a review scope whose base is not a commit id', () => {
    expect(DiffScopeSchema.safeParse({ kind: 'review', base: 'main' }).success).toBe(false);
  });
});

describe('query schemas', () => {
  it('defaults to the working scope', () => {
    expect(FilesQuerySchema.parse({})).toEqual({ scope: { kind: 'working' } });
  });

  it('parses branch and commit scopes from query fields', () => {
    expect(FilesQuerySchema.parse({ scope: 'branch', base: 'main' })).toEqual({
      scope: { kind: 'branch', base: 'main' },
    });
    expect(FilesQuerySchema.parse({ scope: 'commit', sha: 'abc123' })).toEqual({
      scope: { kind: 'commit', sha: 'abc123' },
    });
  });

  it('parses the status-flow scopes from query fields and writes them back', () => {
    expect(FilesQuerySchema.parse({ scope: 'branch', working: '1' })).toEqual({
      scope: { kind: 'branch', includeWorking: true },
    });
    expect(FilesQuerySchema.parse({ scope: 'review' })).toEqual({ scope: { kind: 'review' } });
    expect(FilesQuerySchema.parse({ scope: 'review', base: 'abc123' })).toEqual({
      scope: { kind: 'review', base: 'abc123' },
    });
    expect(FilesQuerySchema.safeParse({ scope: 'review', base: 'main' }).success).toBe(false);
    for (const scope of [
      { kind: 'branch', base: 'main', includeWorking: true },
      { kind: 'review', base: 'abc123' },
    ] as const) {
      const params = Object.fromEntries(appendScopeParams(new URLSearchParams(), scope));
      expect(FilesQuerySchema.parse(params)).toEqual({ scope });
    }
  });

  it('requires sha for scope=commit', () => {
    const result = FilesQuerySchema.safeParse({ scope: 'commit' });
    expect(result.success).toBe(false);
  });

  it('parses inbox and diff query flags', () => {
    expect(InboxQuerySchema.parse({ onlyUnreviewed: 'true' })).toEqual({
      onlyUnreviewed: true,
      scope: { kind: 'working' },
    });
    expect(
      DiffQuerySchema.parse({
        scope: 'staged',
        path: 'src/a.ts',
        ignoreWhitespace: '1',
        context: '10',
      }),
    ).toEqual({
      scope: { kind: 'staged' },
      path: 'src/a.ts',
      ignoreWhitespace: true,
      context: 10,
      full: false,
    });
  });

  it('rejects path traversal in diff queries', () => {
    expect(DiffQuerySchema.safeParse({ path: '../../etc/passwd' }).success).toBe(false);
    expect(DiffQuerySchema.safeParse({ path: '/etc/passwd' }).success).toBe(false);
  });

  it('defaults scan depth', () => {
    expect(AddScanRootRequestSchema.parse({ path: '~/code' })).toEqual({
      path: '~/code',
      depth: 3,
    });
    expect(AddScanRootRequestSchema.safeParse({ path: '~/code', depth: 99 }).success).toBe(false);
  });

  it('validates review requests', () => {
    const body = {
      projectId: id,
      scopeKind: 'working',
      path: 'a.txt',
      patchHash: 'abc',
      reviewed: true,
    };
    expect(ReviewRequestSchema.parse(body)).toEqual(body);
    expect(ReviewRequestSchema.safeParse({ ...body, projectId: 'nope' }).success).toBe(false);
  });
});

describe('domain schemas', () => {
  it('accepts a project', () => {
    const project = {
      id,
      name: 'demo',
      commonDir: '/tmp/demo/.git',
      mainWorktreePath: '/tmp/demo',
      bare: false,
      defaultBranch: 'main',
      defaultBranchOverride: null,
      scanRootId: null,
      addedAt: now,
    };
    expect(ProjectSchema.parse(project)).toEqual(project);
    expect(ProjectSchema.safeParse({ ...project, commonDir: 'relative/.git' }).success).toBe(false);
  });

  it('accepts a summary and a changed file', () => {
    const summary = {
      worktreeId: id,
      projectId: id,
      branch: 'main',
      headSha: 'a'.repeat(40),
      detached: false,
      upstream: null,
      aheadBehindRef: null,
      ahead: null,
      behind: null,
      counts: { staged: 1, unstaged: 2, untracked: 3, conflicted: 0 },
      changedFiles: 6,
      additions: 10,
      deletions: 4,
      inProgress: null,
      stateHash: 'h',
      updatedAt: now,
    };
    expect(WorktreeSummarySchema.parse(summary)).toEqual(summary);

    const file = {
      path: 'new name.txt',
      oldPath: 'old name.txt',
      status: 'renamed',
      staged: true,
      unstaged: false,
      binary: false,
      oldMode: '100644',
      newMode: '100644',
      additions: 1,
      deletions: 0,
      patchHash: 'p',
      reviewed: false,
    };
    expect(ChangedFileSchema.parse(file)).toEqual(file);
    expect(ChangedFileSchema.safeParse({ ...file, status: 'weird' }).success).toBe(false);
  });
});
