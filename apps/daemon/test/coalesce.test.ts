/**
 * `Coalescer` on Effect (#48) against the Promise implementation it replaced, kept here as the
 * reference model: over random sequences of requests and run completions (successes and
 * failures) both start the same runs and settle the same callers at every step. Then the
 * guarantees themselves, including a request made in the reaction to a run's end, where the two
 * differ in timing only (the Effect version starts the follow-up at once).
 */
import { describe, expect, it } from 'vitest';
import { Coalescer, settleWithin } from '../src/coalesce.js';
import { Timers } from '../src/timers.js';

/** The implementation before #48, verbatim (apps/daemon/src/coalesce.ts at 9bf3e6d). */
class ReferenceCoalescer {
  #current: Promise<void> | null = null;
  #queued: Promise<void> | null = null;
  readonly #fn: () => Promise<void>;

  constructor(fn: () => Promise<void>) {
    this.#fn = fn;
  }

  get running(): boolean {
    return this.#current !== null;
  }

  get current(): Promise<void> | null {
    return this.#queued ?? this.#current;
  }

  run(): Promise<void> {
    if (!this.#current) {
      const p = this.#fn()
        .catch(() => {})
        .finally(() => {
          if (this.#current === p) this.#current = null;
        });
      this.#current = p;
      return p;
    }
    if (!this.#queued) {
      this.#queued = this.#current.then(() => {
        this.#queued = null;
        return this.run();
      });
    }
    return this.#queued;
  }
}

interface Coalescing {
  readonly running: boolean;
  readonly current: Promise<void> | null;
  run(): Promise<void>;
}

/** A coalescer whose runs the test ends one by one. */
function harness(make: (fn: () => Promise<void>) => Coalescing) {
  const runs: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const coalescer = make(
    () =>
      new Promise<void>((resolve, reject) => {
        runs.push({ resolve, reject });
      }),
  );
  const settled: number[] = [];
  let calls = 0;
  return {
    coalescer,
    runs,
    settled,
    call(): number {
      const n = calls++;
      void coalescer.run().then(() => settled.push(n));
      return n;
    },
    /** Ends the oldest run that has not ended yet. */
    finish(ok: boolean, ended: { n: number }): void {
      const run = runs[ended.n];
      if (!run) return;
      ended.n++;
      if (ok) run.resolve();
      else run.reject(new Error('boom'));
    },
  };
}

/** Lets promise reactions and resumed fibers run. */
const flush = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('Coalescer (Effect) against the reference model', () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`random requests and completions, seed ${seed}`, async () => {
      const random = lcg(seed);
      const model = harness((fn) => new ReferenceCoalescer(fn));
      const actual = harness((fn) => new Coalescer(fn));
      const endedModel = { n: 0 };
      const endedActual = { n: 0 };
      for (let step = 0; step < 120; step++) {
        const r = random();
        if (r < 0.45) {
          // A burst of requests in one tick.
          const burst = 1 + Math.floor(random() * 3);
          for (let i = 0; i < burst; i++) {
            model.call();
            actual.call();
          }
        } else {
          const ok = random() < 0.8;
          model.finish(ok, endedModel);
          actual.finish(ok, endedActual);
        }
        await flush();
        expect(actual.runs.length, `runs started at step ${step}`).toBe(model.runs.length);
        expect(
          [...actual.settled].sort((a, b) => a - b),
          `settled at step ${step}`,
        ).toEqual([...model.settled].sort((a, b) => a - b));
        expect(actual.coalescer.running, `running at step ${step}`).toBe(model.coalescer.running);
        expect(actual.coalescer.current === null).toBe(model.coalescer.current === null);
        // At most one run in flight.
        expect(actual.runs.length - endedActual.n).toBeLessThanOrEqual(1);
      }
      // Drain: every caller settles, in both.
      while (model.runs.length > endedModel.n || actual.runs.length > endedActual.n) {
        model.finish(true, endedModel);
        actual.finish(true, endedActual);
        await flush();
      }
      expect(actual.settled.length).toBe(model.settled.length);
      expect(actual.coalescer.running).toBe(false);
      expect(actual.coalescer.current).toBeNull();
    });
  }
});

describe('Coalescer (Effect) guarantees', () => {
  it('starts the first run synchronously inside run()', () => {
    let started = 0;
    const c = new Coalescer(async () => {
      started++;
    });
    void c.run();
    expect(started).toBe(1);
    expect(c.running).toBe(true);
  });

  it('a caller never observes a run that started before its request; one follow-up at most', async () => {
    const h = harness((fn) => new Coalescer(fn));
    const ended = { n: 0 };
    const a = h.call(); // run 0
    const b = h.call(); // follow-up (run 1)
    const c = h.call(); // same follow-up
    expect(h.runs.length).toBe(1);
    h.finish(true, ended);
    await flush();
    expect(h.settled).toEqual([a]);
    expect(h.runs.length).toBe(2);
    h.finish(false, ended); // a failed run still settles its callers (never rejects)
    await flush();
    expect(h.settled.sort()).toEqual([a, b, c].sort());
    expect(h.runs.length).toBe(2);
    expect(h.coalescer.running).toBe(false);
  });

  it('a request made right after a run ended is served by a run that starts after it', async () => {
    const scenario = async (make: (fn: () => Promise<void>) => Coalescing) => {
      const h = harness(make);
      const ended = { n: 0 };
      h.call(); // run 0
      h.call(); // its follow-up
      h.finish(true, ended);
      // In the reaction to run 0's end, before the follow-up may have started.
      let startedBefore = -1;
      let settledAfterEnds = -1;
      await Promise.resolve().then(() => {
        startedBefore = h.runs.length;
        void h.coalescer.run().then(() => {
          settledAfterEnds = ended.n;
        });
      });
      for (let i = 0; i < 10; i++) {
        await flush();
        h.finish(true, ended);
      }
      await flush();
      return { runs: h.runs.length, startedBefore, settledAfterEnds };
    };
    const reference = await scenario((fn) => new ReferenceCoalescer(fn));
    const actual = await scenario((fn) => new Coalescer(fn));
    // The late request settles only after a run that started after it has ended: some run with
    // index >= the number of runs started when it asked.
    expect(actual.settledAfterEnds).toBeGreaterThan(actual.startedBefore);
    expect(reference.settledAfterEnds).toBeGreaterThan(reference.startedBefore);
    // Run 0, its follow-up, and at most one more for the late request (the Effect version starts
    // the follow-up as soon as run 0 ends, so a request after that needs a run of its own).
    expect(reference.runs).toBeLessThanOrEqual(3);
    expect(actual.runs).toBeLessThanOrEqual(3);
  });

  it('closing its timers settles waiting callers and starts nothing more', async () => {
    const timers = new Timers();
    const h = harness((fn) => new Coalescer(fn, { timers }));
    h.call();
    h.call();
    timers.close();
    await flush();
    expect(h.settled.length).toBe(2);
    expect(h.coalescer.running).toBe(false);
    h.call();
    await flush();
    expect(h.runs.length).toBe(1);
  });
});

describe('settleWithin', () => {
  it('resolves with the promise, or after ms, and never rejects', async () => {
    await settleWithin(Promise.reject(new Error('x')), 10_000);
    const started = Date.now();
    await settleWithin(new Promise(() => {}), 30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});
