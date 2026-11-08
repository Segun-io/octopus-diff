import { APP_NAME } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';

describe('web placeholder', () => {
  it('resolves workspace contracts from source', () => {
    expect(APP_NAME).toBe('octopus-diff');
  });
});
