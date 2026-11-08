import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import '../src/api/queries.ts';

describe('CSP: no eval', () => {
  it("disables zod's JIT so the Function('') probe never runs under script-src 'self'", () => {
    expect(z.config().jitless).toBe(true);
  });
});
