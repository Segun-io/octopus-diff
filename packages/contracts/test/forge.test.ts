import { describe, expect, it } from 'vitest';
import {
  AppSettingsPatchSchema,
  AppSettingsSchema,
  ChangeRequestSchema,
  DEFAULT_APP_SETTINGS,
  ForgeHostSchema,
  ForgeRepositoryPathSchema,
  ForgesResponseSchema,
} from '../src/index.js';

describe('forge contracts', () => {
  it('accepts bare hostnames only', () => {
    for (const host of ['github.com', 'gitlab.example.com:8443', 'ghe.corp.example']) {
      expect(ForgeHostSchema.safeParse(host).success).toBe(true);
    }
    for (const host of [
      'GitHub.com',
      'evil.com/x',
      'user@github.com',
      '-github.com',
      'github.com.',
      'github.com:x',
      '',
    ]) {
      expect(ForgeHostSchema.safeParse(host).success).toBe(false);
    }
  });

  it('accepts owner/name and nested GitLab paths, rejects dot segments', () => {
    expect(ForgeRepositoryPathSchema.safeParse('pingdotgg/t3code').success).toBe(true);
    expect(ForgeRepositoryPathSchema.safeParse('group/sub/project.js').success).toBe(true);
    expect(ForgeRepositoryPathSchema.safeParse('name').success).toBe(false);
    expect(ForgeRepositoryPathSchema.safeParse('a/../b').success).toBe(false);
    expect(ForgeRepositoryPathSchema.safeParse('a/b?x').success).toBe(false);
  });

  it('settings default to enabled with no host overrides, and older documents still parse', () => {
    expect(DEFAULT_APP_SETTINGS.forges).toEqual({ enabled: true, hosts: {} });
    expect(AppSettingsSchema.parse({ review: { defaultEnabled: true } }).forges).toBeUndefined();
    expect(
      AppSettingsPatchSchema.parse({ forges: { hosts: { 'git.corp.example': 'gitlab' } } }),
    ).toEqual({ forges: { hosts: { 'git.corp.example': 'gitlab' } } });
    expect(
      AppSettingsPatchSchema.safeParse({ forges: { hosts: { 'Bad Host': 'gitlab' } } }).success,
    ).toBe(false);
  });

  it('parses a full response', () => {
    const changeRequest = {
      kind: 'github',
      number: 12,
      title: 'Add forges',
      url: 'https://github.com/o/r/pull/12',
      state: 'open',
      draft: false,
      author: 'octo',
      baseBranch: 'main',
      headBranch: 'feat/forges',
      headSha: 'a'.repeat(40),
      crossRepository: false,
      headRepository: 'o/r',
      updatedAt: '2026-11-08T10:00:00.000Z',
      checks: { state: 'pending', passed: 3, failed: 0, pending: 1, total: 4 },
      review: 'review_required',
      conflicts: false,
      comments: 2,
    };
    expect(ChangeRequestSchema.parse(changeRequest)).toEqual(changeRequest);
    const response = {
      enabled: true,
      clis: [
        {
          kind: 'github',
          executable: 'gh',
          available: true,
          version: 'gh version 2.46.0',
          auth: 'authenticated',
          accounts: [{ host: 'github.com', account: 'octo' }],
          hint: 'Run `gh auth login`.',
          detail: null,
          checkedAt: '2026-11-08T10:00:00.000Z',
        },
      ],
      projects: [
        {
          projectId: '0123456789abcdef',
          forge: {
            kind: 'github',
            host: 'github.com',
            repository: 'o/r',
            webUrl: 'https://github.com/o/r',
            remoteName: 'origin',
            detectedBy: 'hostname',
          },
          status: 'ok',
          message: null,
          worktrees: [
            {
              worktreeId: 'fedcba9876543210',
              branch: 'feat/forges',
              changeRequest,
              sync: 'same',
            },
          ],
          fetchedAt: '2026-11-08T10:00:00.000Z',
        },
      ],
      generatedAt: '2026-11-08T10:00:00.000Z',
    };
    expect(ForgesResponseSchema.parse(response)).toEqual(response);
  });
});
