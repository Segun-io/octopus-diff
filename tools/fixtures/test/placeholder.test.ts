import { describe, expect, it } from 'vitest';
import { FIXTURES_PLACEHOLDER } from '../src/index.js';

describe('fixtures placeholder', () => {
  it('exists', () => {
    expect(FIXTURES_PLACEHOLDER).toBe(true);
  });
});
