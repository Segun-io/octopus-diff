// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { util } from 'zod/v4/core';
import '../src/App.tsx';

describe('CSP: no eval', () => {
  it("disables zod's JIT before the contracts build their schemas (no Function('') probe)", () => {
    expect(z.config().jitless).toBe(true);
    // Evaluated when the first object schema was built; false means the probe never ran.
    expect(util.allowsEval.value).toBe(false);
  });
});
