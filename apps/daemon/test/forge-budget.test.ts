import { describe, expect, it } from 'vitest';
import { ForgeBudget } from '../src/forge-budget.js';

const HOUR = 3_600_000;

function make(start = Date.UTC(2026, 10, 11, 10, 0, 0)) {
  let now = start;
  const budget = new ForgeBudget({ now: () => now });
  return {
    budget,
    at: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('ForgeBudget', () => {
  it('stops each priority at its own ceiling and resumes as the hour passes', () => {
    const { budget, advance } = make();
    // 1 495 points spent over the first minutes.
    for (let i = 0; i < 5; i++) {
      budget.spend('github', 'github.com', 299);
      advance(60_000);
    }
    expect(budget.decide('github', 'github.com', 'background', 5).ok).toBe(true);
    expect(budget.decide('github', 'github.com', 'background', 6)).toMatchObject({
      ok: false,
      reason: 'busy',
    });
    // Events and the user keep going to their higher ceilings.
    expect(budget.decide('github', 'github.com', 'event', 100).ok).toBe(true);
    expect(budget.decide('github', 'github.com', 'interactive', 100).ok).toBe(true);
    budget.spend('github', 'github.com', 1000);
    expect(budget.decide('github', 'github.com', 'event', 10).ok).toBe(false);
    expect(budget.decide('github', 'github.com', 'interactive', 10).ok).toBe(true);
    budget.spend('github', 'github.com', 1500);
    expect(budget.decide('github', 'github.com', 'interactive', 10).ok).toBe(false);
    // An hour later the first spending has expired.
    advance(HOUR);
    expect(budget.decide('github', 'github.com', 'background', 6).ok).toBe(true);
  });

  it('keeps hosts apart', () => {
    const { budget } = make();
    budget.spend('github', 'github.com', 1500);
    expect(budget.decide('github', 'github.com', 'background', 1).ok).toBe(false);
    expect(budget.decide('github', 'ghe.corp.example', 'background', 1).ok).toBe(true);
  });

  it('follows what the forge reports as left: low reserves the user, the floor stops all', () => {
    const { budget, at } = make();
    budget.observe('github', 'github.com', {
      remaining: 400,
      resetAt: new Date(at() + 30 * 60_000).toISOString(),
    });
    expect(budget.decide('github', 'github.com', 'background', 1)).toMatchObject({
      ok: false,
      reason: 'low',
    });
    expect(budget.decide('github', 'github.com', 'event', 1).ok).toBe(false);
    expect(budget.decide('github', 'github.com', 'interactive', 1).ok).toBe(true);
    budget.observe('github', 'github.com', { remaining: 99, resetAt: null });
    expect(budget.decide('github', 'github.com', 'interactive', 1).ok).toBe(false);
    expect(budget.snapshot()[0]).toMatchObject({ state: 'low', remaining: 99 });
  });

  it('forgets the reported remaining once its window has reset', () => {
    const { budget, at, advance } = make();
    budget.observe('github', 'github.com', {
      remaining: 10,
      resetAt: new Date(at() + 10 * 60_000).toISOString(),
    });
    expect(budget.decide('github', 'github.com', 'interactive', 1).ok).toBe(false);
    advance(11 * 60_000);
    expect(budget.decide('github', 'github.com', 'background', 1).ok).toBe(true);
    // Without a reset time, a report is trusted for an hour at most.
    budget.observe('github', 'ghe.example', { remaining: 10, resetAt: null });
    expect(budget.decide('github', 'ghe.example', 'interactive', 1).ok).toBe(false);
    advance(HOUR + 1);
    expect(budget.decide('github', 'ghe.example', 'interactive', 1).ok).toBe(true);
  });

  it('backs off exponentially after a refusal, and until the reported reset when known', () => {
    const { budget, at, advance } = make();
    budget.rateLimited('github', 'github.com');
    const first = budget.decide('github', 'github.com', 'interactive', 1);
    expect(first).toMatchObject({ ok: false, reason: 'backoff', resumeAt: at() + 5 * 60_000 });
    // A second failure from a query that was already running does not lengthen it.
    budget.rateLimited('github', 'github.com');
    expect(budget.snapshot()[0]?.resumeAt).toBe(new Date(at() + 5 * 60_000).toISOString());
    advance(5 * 60_000);
    expect(budget.decide('github', 'github.com', 'interactive', 1).ok).toBe(true);
    // Refused again before any success: twice as long.
    budget.rateLimited('github', 'github.com');
    expect(budget.snapshot()[0]).toMatchObject({
      state: 'backoff',
      resumeAt: new Date(at() + 10 * 60_000).toISOString(),
    });
    advance(10 * 60_000);
    budget.succeeded('github', 'github.com');
    budget.rateLimited('github', 'github.com');
    expect(budget.snapshot()[0]?.resumeAt).toBe(new Date(at() + 5 * 60_000).toISOString());

    // With a known reset: wait for it (plus a few seconds), however far.
    const other = make();
    other.budget.observe('github', 'github.com', {
      remaining: 12,
      resetAt: new Date(other.at() + 40 * 60_000).toISOString(),
    });
    other.budget.rateLimited('github', 'github.com');
    expect(other.budget.snapshot()[0]?.resumeAt).toBe(
      new Date(other.at() + 40 * 60_000 + 5_000).toISOString(),
    );
  });

  it('caps the backoff at an hour', () => {
    const { budget, at, advance } = make();
    for (let i = 0; i < 8; i++) {
      budget.rateLimited('gitlab', 'gitlab.com');
      advance(60 * 60_000 + 1);
    }
    budget.rateLimited('gitlab', 'gitlab.com');
    expect(budget.snapshot()[0]?.resumeAt).toBe(new Date(at() + HOUR).toISOString());
  });

  it('reports spending, ceilings and a busy state in the snapshot', () => {
    const { budget } = make();
    budget.spend('github', 'github.com', 1500);
    expect(budget.snapshot()).toEqual([
      expect.objectContaining({
        host: 'github.com',
        kind: 'github',
        state: 'busy',
        spentLastHour: 1500,
        backgroundLimit: 1500,
        hourlyLimit: 4000,
        remaining: null,
      }),
    ]);
    expect(budget.totalSpent).toBe(1500);
  });
});
