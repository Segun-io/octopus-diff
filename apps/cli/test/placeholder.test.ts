import { describe, expect, it } from 'vitest';
import { USAGE } from '../src/index.js';

describe('cli placeholder', () => {
  it('has usage text', () => {
    expect(USAGE).toContain('serve');
  });
});
