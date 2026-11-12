import { describe, expect, it } from 'vitest';
import { ownWork } from '../src/bulk-review.js';
import { Limiter } from '../src/limit.js';
import { defaultBranchCommits } from '../src/review-state.js';

/** #33 building blocks without git: the default-branch commits of a range, the limiter, bulk files. */

const c = (sha: string, ...parents: string[]) => ({ sha, parents });

describe('defaultBranchCommits', () => {
  // base B0; own F1, F2; main M1, M2 merged by X (parents F2, M2); own F3 after the merge.
  //   F3 - X - F2 - F1 - B0
  //         \- M2 - M1 - B0
  const range = {
    commits: [
      c('F3', 'X'),
      c('X', 'F2', 'M2'),
      c('M2', 'M1'),
      c('M1', 'B0'),
      c('F2', 'F1'),
      c('F1', 'B0'),
    ],
  };

  it('is N and its ancestors inside the range', () => {
    expect([...defaultBranchCommits(range, 'M2')].sort()).toEqual(['M1', 'M2']);
  });

  it('nothing when N is unknown or outside the range', () => {
    expect(defaultBranchCommits(range, null).size).toBe(0);
    expect(defaultBranchCommits(range, 'B0').size).toBe(0);
    expect(defaultBranchCommits({ commits: [] }, 'M2').size).toBe(0);
  });

  it('HEAD = N (the branch only moved along the default branch): every commit', () => {
    const update = { commits: [c('M2', 'M1'), c('M1', 'B0')] };
    expect([...defaultBranchCommits(update, 'M2')].sort()).toEqual(['M1', 'M2']);
  });

  it('a truncated range only knows its listed commits', () => {
    const truncated = { commits: [c('X', 'F2', 'M2'), c('M2', 'M1')] };
    expect([...defaultBranchCommits(truncated, 'M2')].sort()).toEqual(['M2']);
  });
});

describe('ownWork', () => {
  it('drops base files, keeps own (absent origin) and mixed', () => {
    const files = [
      { origin: 'base' as const },
      {},
      { origin: 'mixed' as const },
      { origin: 'own' as const },
    ];
    expect(ownWork(files)).toEqual([{}, { origin: 'mixed' }, { origin: 'own' }]);
  });
});

describe('Limiter', () => {
  it('runs at most max tasks at once, in arrival order', async () => {
    const limiter = new Limiter(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const releases: Array<() => void> = [];
    const tasks = [0, 1, 2, 3, 4].map((i) =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        order.push(i);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return i;
      }),
    );
    for (let n = 0; n < 5; n++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      releases.shift()?.();
    }
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(limiter.running).toBe(0);
  });

  it('a failing task frees its slot', async () => {
    const limiter = new Limiter(1);
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await limiter.run(async () => 'next')).toBe('next');
    expect(limiter.running).toBe(0);
  });
});
