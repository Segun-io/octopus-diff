import { isGitCoreError } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { createGitCore } from '../src/index.js';

describe('git-core placeholder', () => {
  it('implements the GitCore shape', async () => {
    const core = createGitCore();
    const error = await core.version().catch((e: unknown) => e);
    expect(isGitCoreError(error, 'not_implemented')).toBe(true);
    await core.dispose();
  });
});
