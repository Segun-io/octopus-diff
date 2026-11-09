import { describe, expect, it } from 'vitest';
import { ForgeCli, ForgeClient, type ForgeQueryCost } from '../src/index.js';

/**
 * Talks to the real github.com / gitlab.com through the installed CLIs. Opt-in only
 * (`OCTOPUS_FORGE_LIVE=1`, optionally `OCTOPUS_FORGE_GLAB=/path/to/glab`): it needs a network,
 * a signed-in `gh`, and only reads public repositories.
 */
const live = process.env.OCTOPUS_FORGE_LIVE === '1';

describe.runIf(live)('live forges', () => {
  const glab = process.env.OCTOPUS_FORGE_GLAB;
  const costs: ForgeQueryCost[] = [];
  const client = new ForgeClient(new ForgeCli(glab ? { binaries: { gitlab: glab } } : {}), {
    onCost: (cost) => costs.push(cost),
  });

  it('probes gh and reads public pull requests', async () => {
    const status = await client.probe('github');
    expect(status.available).toBe(true);
    if (status.auth !== 'authenticated') return;
    const result = await client.fetchChangeRequests(
      { kind: 'github', host: 'github.com', repository: 'cli/cli' },
      ['trunk', 'no-such-branch-octopus-diff'],
    );
    expect(result.get('no-such-branch-octopus-diff')).toEqual([]);
    expect(Array.isArray(result.get('trunk'))).toBe(true);
    // The batch query (with the hover card's scalars) still costs one rate-limit point.
    const batch = costs.filter((c) => c.operation === 'OctopusDiffPullRequests');
    expect(batch.length).toBeGreaterThan(0);
    for (const c of batch) expect(c.cost).toBeLessThanOrEqual(1);
  }, 30_000);

  it.runIf(Boolean(glab))(
    'probes glab and reads public merge requests',
    async () => {
      const status = await client.probe('gitlab');
      expect(status.available).toBe(true);
      const result = await client.fetchChangeRequests(
        { kind: 'gitlab', host: 'gitlab.com', repository: 'gitlab-org/cli' },
        ['main'],
      );
      expect(result.get('main')?.every((mr) => mr.kind === 'gitlab')).toBe(true);
    },
    30_000,
  );
});
