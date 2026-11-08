import { describe, expect, it } from 'vitest';
import {
  AppSettingsPatchSchema,
  BULK_REVIEW_PATHS_MAX,
  BulkReviewRequestSchema,
  BulkReviewResponseSchema,
  createApiClient,
  DEFAULT_APP_SETTINGS,
  InboxEntrySchema,
  type ReviewPolicyTarget,
  ReviewPolicyTargetSchema,
  ROUTES,
  resolveReviewPolicy,
  reviewTargetKey,
  SetReviewPolicyRequestSchema,
  SettingsResponseSchema,
  TEST_IDS,
  WorktreeListItemSchema,
} from '../src/index.js';

const id = '0123456789abcdef';
const other = 'fedcba9876543210';

describe('review policy targets', () => {
  it('accepts every level and rejects bad ids / refs', () => {
    for (const target of [
      { kind: 'folder', scanRootId: id },
      { kind: 'project', projectId: id },
      { kind: 'branch', projectId: id, branch: 'feature/x' },
      { kind: 'worktree', worktreeId: id },
    ]) {
      expect(ReviewPolicyTargetSchema.parse(target)).toEqual(target);
    }
    expect(ReviewPolicyTargetSchema.safeParse({ kind: 'worktree', worktreeId: 'x' }).success).toBe(
      false,
    );
    expect(
      ReviewPolicyTargetSchema.safeParse({ kind: 'branch', projectId: id, branch: '--force' })
        .success,
    ).toBe(false);
    expect(ReviewPolicyTargetSchema.safeParse({ kind: 'repo', projectId: id }).success).toBe(false);
  });

  it('null enabled clears an override', () => {
    const body = { target: { kind: 'project', projectId: id }, enabled: null };
    expect(SetReviewPolicyRequestSchema.parse(body)).toEqual(body);
  });
});

describe('resolveReviewPolicy', () => {
  const base = {
    defaultEnabled: true,
    worktreeId: id,
    projectId: other,
    branch: 'feature/x',
    scanRootId: '1111111111111111',
  };
  const ov = (target: ReviewPolicyTarget, enabled: boolean) => ({ target, enabled });

  it('falls back to the default, which is what new repos/worktrees/branches get', () => {
    expect(resolveReviewPolicy({ ...base, overrides: [] })).toEqual({
      enabled: true,
      source: 'default',
    });
    expect(resolveReviewPolicy({ ...base, defaultEnabled: false, overrides: [] })).toEqual({
      enabled: false,
      source: 'default',
    });
  });

  it('applies worktree > branch > project > folder > default', () => {
    const folder = ov({ kind: 'folder', scanRootId: base.scanRootId }, false);
    const project = ov({ kind: 'project', projectId: base.projectId }, true);
    const branch = ov({ kind: 'branch', projectId: base.projectId, branch: 'feature/x' }, false);
    const worktree = ov({ kind: 'worktree', worktreeId: id }, true);
    const at = (overrides: Array<ReturnType<typeof ov>>) =>
      resolveReviewPolicy({ ...base, overrides });
    expect(at([folder])).toEqual({ enabled: false, source: 'folder' });
    expect(at([folder, project])).toEqual({ enabled: true, source: 'project' });
    expect(at([folder, project, branch])).toEqual({ enabled: false, source: 'branch' });
    expect(at([worktree, branch, project, folder])).toEqual({ enabled: true, source: 'worktree' });
  });

  it('ignores overrides of other branches, other projects and a missing branch or folder', () => {
    const otherBranch = ov({ kind: 'branch', projectId: base.projectId, branch: 'main' }, false);
    const otherProject = ov({ kind: 'project', projectId: '2222222222222222' }, false);
    const folder = ov({ kind: 'folder', scanRootId: base.scanRootId }, false);
    expect(resolveReviewPolicy({ ...base, overrides: [otherBranch, otherProject] })).toEqual({
      enabled: true,
      source: 'default',
    });
    const branchOnly = ov(
      { kind: 'branch', projectId: base.projectId, branch: 'feature/x' },
      false,
    );
    expect(resolveReviewPolicy({ ...base, branch: null, overrides: [branchOnly] }).source).toBe(
      'default',
    );
    expect(resolveReviewPolicy({ ...base, scanRootId: null, overrides: [folder] }).source).toBe(
      'default',
    );
  });

  it('keys are unique per level and target', () => {
    const keys = [
      reviewTargetKey({ kind: 'folder', scanRootId: id }),
      reviewTargetKey({ kind: 'project', projectId: id }),
      reviewTargetKey({ kind: 'worktree', worktreeId: id }),
      reviewTargetKey({ kind: 'branch', projectId: id, branch: 'a' }),
      reviewTargetKey({ kind: 'branch', projectId: id, branch: 'b' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('settings', () => {
  it('defaults review on, patches partially, and round-trips a response', () => {
    expect(DEFAULT_APP_SETTINGS.review.defaultEnabled).toBe(true);
    expect(AppSettingsPatchSchema.parse({})).toEqual({});
    expect(AppSettingsPatchSchema.parse({ review: { defaultEnabled: false } })).toEqual({
      review: { defaultEnabled: false },
    });
    const response = {
      settings: DEFAULT_APP_SETTINGS,
      overrides: [
        {
          target: { kind: 'worktree', worktreeId: id },
          enabled: false,
          updatedAt: new Date(0).toISOString(),
        },
      ],
      revision: 4,
    };
    expect(SettingsResponseSchema.parse(response)).toEqual(response);
  });

  it('keeps the effective policy optional on list and inbox items (older daemons)', () => {
    const parsed = WorktreeListItemSchema.shape.review.safeParse(undefined);
    expect(parsed.success).toBe(true);
    expect(
      InboxEntrySchema.shape.review.safeParse({ enabled: false, source: 'branch' }).success,
    ).toBe(true);
    expect(
      InboxEntrySchema.shape.review.safeParse({ enabled: false, source: 'repo' }).success,
    ).toBe(false);
  });
});

describe('bulk review', () => {
  it('fills defaults: working scope, reviewed = true, includeDisabled = false', () => {
    expect(BulkReviewRequestSchema.parse({ target: { kind: 'all' } })).toEqual({
      target: { kind: 'all' },
      scope: { kind: 'working' },
      reviewed: true,
      includeDisabled: false,
    });
  });

  it('validates targets, scopes, paths and expected hashes', () => {
    const ok = BulkReviewRequestSchema.safeParse({
      target: { kind: 'worktree', worktreeId: id },
      scope: { kind: 'branch', base: 'main' },
      reviewed: false,
      paths: [{ path: 'src/a.ts' }, { path: 'b�.txt', rawPath: 'Yv8udHh0' }],
      expectedStateHashes: { [id]: 'abc' },
    });
    expect(ok.success).toBe(true);
    for (const bad of [
      { target: { kind: 'worktree' } },
      { target: { kind: 'all' }, paths: [{ path: '../etc/passwd' }] },
      { target: { kind: 'all' }, expectedStateHashes: { nothex: 'abc' } },
      { target: { kind: 'all' }, scope: { kind: 'nope' } },
    ]) {
      expect(BulkReviewRequestSchema.safeParse(bad).success).toBe(false);
    }
    expect(BULK_REVIEW_PATHS_MAX).toBeGreaterThan(10_000);
  });

  it('describes what was skipped and carries an undo token', () => {
    const response = {
      ok: true,
      reviewed: true,
      changed: 41,
      unchanged: 2,
      worktrees: 5,
      skippedDisabled: [id],
      stale: [other],
      undoToken: 'u-1',
    };
    expect(BulkReviewResponseSchema.parse(response)).toEqual(response);
    const nothingChanged = BulkReviewResponseSchema.parse({
      ...response,
      changed: 0,
      undoToken: null,
    });
    expect(nothingChanged.undoToken).toBeNull();
  });
});

describe('client: settings and bulk review', () => {
  it('calls the right routes with the right bodies', async () => {
    const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    const respond = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const settings = { settings: DEFAULT_APP_SETTINGS, overrides: [], revision: 1 };
    const client = createApiClient({
      baseUrl: 'http://127.0.0.1:7428',
      fetch: async (url, init) => {
        calls.push({
          url,
          method: init?.method,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        });
        if (url.endsWith(ROUTES.bulkReview.path)) {
          return respond({
            ok: true,
            reviewed: true,
            changed: 1,
            unchanged: 0,
            worktrees: 1,
            skippedDisabled: [],
            stale: [],
            undoToken: 't',
          });
        }
        if (url.endsWith(ROUTES.undoReview.path)) return respond({ ok: true, restored: 1 });
        return respond(settings);
      },
    });
    await client.getSettings();
    await client.updateSettings({ review: { defaultEnabled: false } });
    await client.setReviewPolicy({ target: { kind: 'project', projectId: id }, enabled: null });
    const bulk = await client.bulkReview({ target: { kind: 'all' } });
    const undo = await client.undoReview({ undoToken: bulk.undoToken ?? '' });
    expect(undo.restored).toBe(1);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /api/settings',
      'PATCH /api/settings',
      'PUT /api/review-policy',
      'POST /api/review/bulk',
      'POST /api/review/undo',
    ]);
    expect(calls[1]?.body).toEqual({ review: { defaultEnabled: false } });
    expect(calls[2]?.body).toEqual({ target: { kind: 'project', projectId: id }, enabled: null });
    expect(calls[4]?.body).toEqual({ undoToken: 't' });
  });

  it('test ids are unique', () => {
    const values = Object.values(TEST_IDS);
    expect(new Set(values).size).toBe(values.length);
  });
});
