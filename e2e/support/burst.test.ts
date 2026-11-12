import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiClient } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { diffDuringBurst } from '../bench/burst.js';

const client = { getDiff: async () => ({}) } as unknown as ApiClient;

describe('diffDuringBurst', () => {
  it('stops probing and rethrows when an edit fails (PR #81 review)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'octopus-diff-burst-'));
    try {
      // The second target does not exist: its append fails with ENOENT.
      await writeFile(join(dir, 'README.md'), '');
      const result = diffDuringBurst({
        client,
        target: { id: 'w' },
        file: 'README.md',
        editTargets: [{ path: dir }, { path: join(dir, 'missing') }],
        edits: 4,
        intervalMs: 0,
        probeEveryMs: 5,
        idleProbes: 1,
        quiet: async () => true,
      });
      await expect(result).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);

  it('still reports a burst whose edits all succeed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'octopus-diff-burst-'));
    try {
      await writeFile(join(dir, 'README.md'), '');
      const result = await diffDuringBurst({
        client,
        target: { id: 'w' },
        file: 'README.md',
        editTargets: [{ path: dir }],
        edits: 3,
        intervalMs: 0,
        probeEveryMs: 5,
        tailMs: 20,
        idleProbes: 1,
        quiet: async () => true,
      });
      expect(result.edits).toBe(3);
      expect(result.settled).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
