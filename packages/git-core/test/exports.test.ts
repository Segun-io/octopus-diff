import type { CreateGitCore } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { createGitCore, GIT_CORE_IMPLEMENTED, hashId, MIN_GIT_VERSION } from '../src/index.js';

describe('public exports', () => {
  it('exports the real implementation', async () => {
    expect(GIT_CORE_IMPLEMENTED).toBe(true);
    const factory: CreateGitCore = createGitCore;
    const core = factory();
    for (const method of [
      'version',
      'resolveProject',
      'listWorktrees',
      'detectDefaultBranch',
      'scan',
      'getSummary',
      'listChangedFiles',
      'getFileDiff',
      'listCommits',
      'getWatchTargets',
      'dispose',
    ] as const) {
      expect(typeof core[method]).toBe('function');
    }
    await core.dispose();
    expect(hashId('x')).toHaveLength(16);
    expect(MIN_GIT_VERSION).toEqual({ major: 2, minor: 31, patch: 0 });
  });

  it('rejects invalid options', () => {
    expect(() => createGitCore({ concurrency: 0 })).toThrowError(
      expect.objectContaining({ code: 'invalid_argument' }),
    );
    expect(() => createGitCore({ timeoutMs: -1 })).toThrowError(
      expect.objectContaining({ code: 'invalid_argument' }),
    );
  });
});
