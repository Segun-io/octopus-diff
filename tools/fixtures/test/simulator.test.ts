import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSafeTarget,
  createRng,
  type FixtureSet,
  findWorktree,
  generateFixtures,
  performAction,
  proofTargetsFromManifest,
  readStatus,
  SIMULATOR_ACTIONS,
  startAgentSimulator,
  startReadOnlyProof,
} from '../src/index.js';

let set: FixtureSet;

beforeAll(async () => {
  set = await generateFixtures({ seed: 11, largeFileBytes: 64 * 1024 });
}, 120_000);

afterAll(async () => {
  await set?.cleanup();
});

describe('agent simulator', () => {
  it('refuses targets outside the temp dir or that are not worktrees', async () => {
    await expect(assertSafeTarget(homedir())).rejects.toThrow(/refuses/);
    const plain = await mkdtemp(join(tmpdir(), 'octopus-diff-plain-'));
    try {
      await expect(assertSafeTarget(plain)).rejects.toThrow(/not a git worktree/);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('performs every action kind and changes git status', async () => {
    const { worktree } = findWorktree(set.manifest, 'live-agent');
    const before = await readStatus({ env: set.env }, worktree.path);
    const rng = createRng(5);
    for (const [i, kind] of SIMULATOR_ACTIONS.entries()) {
      const action = await performAction(rng, set.env, worktree.path, kind, i);
      expect(action.ok, `${kind}`).toBe(true);
      expect(action.kind === 'delete' || action.kind === kind).toBe(true);
    }
    const after = await readStatus({ env: set.env }, worktree.path);
    expect(after.oid).not.toBe(before.oid); // the commit action moved HEAD
  });

  it('runs for a bounded number of actions and only touches its targets', async () => {
    const proof = await startReadOnlyProof({
      env: set.env,
      targets: proofTargetsFromManifest(set.manifest),
    });
    const live = findWorktree(set.manifest, 'live').worktree;
    const agent = findWorktree(set.manifest, 'live-agent').worktree;
    const seen: string[] = [];
    const sim = startAgentSimulator({
      targets: [
        { path: live.path, name: 'live' },
        { path: agent.path, name: 'live-agent' },
      ],
      env: set.env,
      seed: 99,
      maxActions: 25,
      minIntervalMs: 0,
      maxIntervalMs: 5,
      onAction: (a) => seen.push(a.target),
    });
    const report = await sim.done;
    expect(report.actions).toHaveLength(25);
    expect(report.errors).toBe(0);
    expect(new Set(seen)).toEqual(new Set(['live', 'live-agent']));
    const proofReport = await proof.finish();
    expect(proofReport.violations).toEqual([]);
  }, 60_000);

  it('is deterministic for a seed (same action sequence)', async () => {
    const run = async (seed: number) => {
      const fresh = await generateFixtures({ seed: 11, largeFileBytes: 64 * 1024 });
      try {
        const { worktree } = findWorktree(fresh.manifest, 'live');
        const report = await startAgentSimulator({
          targets: [{ path: worktree.path, name: 'live' }],
          env: fresh.env,
          seed,
          maxActions: 12,
          minIntervalMs: 0,
          maxIntervalMs: 0,
          weights: { commit: 0 },
        }).done;
        return report.actions.map((a) => `${a.kind}:${a.oldPath ?? ''}:${a.path}`);
      } finally {
        await fresh.cleanup();
      }
    };
    expect(await run(7)).toEqual(await run(7));
  }, 120_000);

  it('stop() ends a timed run early', async () => {
    const live = findWorktree(set.manifest, 'live').worktree;
    const sim = startAgentSimulator({
      targets: [{ path: live.path }],
      env: set.env,
      durationMs: 60_000,
      minIntervalMs: 20,
      maxIntervalMs: 40,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    const report = await sim.stop();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(report.durationMs).toBeLessThan(10_000);
    expect(report.actions.length).toBeGreaterThan(0);
  });
});
