import { describe, expect, it } from 'vitest';
import { pathspecsExcluding } from '../src/diff.js';
import type { StatusEntry } from '../src/parse/status.js';

const entry = (path: string): StatusEntry =>
  ({
    kind: 'ordinary',
    path,
    x: '.',
    y: 'M',
    sub: 'N...',
    modeHead: '100644',
    modeIndex: '100644',
    modeWorktree: '100644',
    oidHead: '',
    oidIndex: '',
    line: '',
  }) as StatusEntry;

describe('the pathspec budget counts what exec counts (macOS ARG_MAX, #45 CI)', () => {
  it("counts each argument's pointer as well as its text", () => {
    // 50 000 short paths: about 400 KB of text, plus 400 KB of argv pointers (8 bytes each).
    // macOS gives argv and env 1 MiB together, pointers included: past the budget.
    const many = Array.from({ length: 50_000 }, (_, i) => entry(`d/${i}`));
    expect(pathspecsExcluding(many, new Set())).toBeNull();
    const fewer = Array.from({ length: 20_000 }, (_, i) => entry(`d/${i}`));
    expect(pathspecsExcluding(fewer, new Set())).toHaveLength(20_000);
  });
});
