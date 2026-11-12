import { isGitCoreError } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { FlightMap, raceSignal, SharedFlight } from '../src/flight.js';

/** A computation that settles when the test says so and records its own signal. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SharedFlight (#44)', () => {
  it('keeps running for the remaining waiter when one aborts', async () => {
    const work = deferred<string>();
    let seen: AbortSignal | undefined;
    const flight = new SharedFlight((signal) => {
      seen = signal;
      return work.promise;
    });
    const a = new AbortController();
    const b = new AbortController();
    const leaving = flight.join(a.signal).catch((e: unknown) => e);
    const staying = flight.join(b.signal);
    a.abort();
    expect(isGitCoreError(await leaving, 'aborted')).toBe(true);
    expect(seen?.aborted).toBe(false);
    expect(flight.cancelled).toBe(false);
    work.resolve('done');
    expect(await staying).toBe('done');
  });

  it('is cancelled when the last waiter leaves, and calls onCancel first', async () => {
    const work = deferred<string>();
    let seen: AbortSignal | undefined;
    const order: string[] = [];
    const flight = new SharedFlight(
      (signal) => {
        seen = signal;
        signal.addEventListener('abort', () => order.push('abort'));
        return work.promise;
      },
      () => order.push('cancel'),
    );
    const a = new AbortController();
    const b = new AbortController();
    const first = flight.join(a.signal).catch((e: unknown) => e);
    const second = flight.join(b.signal).catch((e: unknown) => e);
    a.abort();
    expect(seen?.aborted).toBe(false);
    b.abort();
    expect(isGitCoreError(await first, 'aborted')).toBe(true);
    expect(isGitCoreError(await second, 'aborted')).toBe(true);
    expect(seen?.aborted).toBe(true);
    expect(flight.cancelled).toBe(true);
    expect(order).toEqual(['cancel', 'abort']);
    // The computation's own rejection is not unhandled.
    work.reject(new Error('stopped'));
    await flight.settled;
  });

  it('a waiter without a signal pins the run', async () => {
    const work = deferred<number>();
    let seen: AbortSignal | undefined;
    const flight = new SharedFlight((signal) => {
      seen = signal;
      return work.promise;
    });
    const a = new AbortController();
    const leaving = flight.join(a.signal).catch((e: unknown) => e);
    const pinned = flight.join();
    a.abort();
    await leaving;
    expect(seen?.aborted).toBe(false);
    work.resolve(7);
    expect(await pinned).toBe(7);
  });

  it('a waiter with an already-aborted signal is refused and may cancel an unwanted run', async () => {
    const work = deferred<number>();
    let seen: AbortSignal | undefined;
    const flight = new SharedFlight((signal) => {
      seen = signal;
      return work.promise;
    });
    const refused = await flight.join(AbortSignal.abort()).catch((e: unknown) => e);
    expect(isGitCoreError(refused, 'aborted')).toBe(true);
    expect(seen?.aborted).toBe(true);
    work.resolve(1);
  });
});

describe('FlightMap (#44)', () => {
  it('shares one run per key, and a cancelled run is replaced, not joined', async () => {
    const map = new FlightMap<string, string>();
    const runs: Array<{ signal: AbortSignal; work: ReturnType<typeof deferred<string>> }> = [];
    const compute = (signal: AbortSignal) => {
      const work = deferred<string>();
      runs.push({ signal, work });
      return work.promise;
    };
    const a = new AbortController();
    const first = map.run('k', a.signal, compute).catch((e: unknown) => e);
    const b = new AbortController();
    const second = map.run('k', b.signal, compute);
    expect(runs).toHaveLength(1);
    a.abort();
    expect(isGitCoreError(await first, 'aborted')).toBe(true);
    runs[0]?.work.resolve('one');
    expect(await second).toBe('one');
    await Promise.resolve();
    expect(map.size).toBe(0);

    // Every waiter leaves: the run is cancelled and dropped at once; the next caller starts anew.
    const c = new AbortController();
    const third = map.run('k', c.signal, compute).catch((e: unknown) => e);
    expect(runs).toHaveLength(2);
    c.abort();
    expect(isGitCoreError(await third, 'aborted')).toBe(true);
    expect(runs[1]?.signal.aborted).toBe(true);
    expect(map.size).toBe(0);
    const fourth = map.run('k', undefined, compute);
    expect(runs).toHaveLength(3);
    runs[1]?.work.reject(new Error('cancelled'));
    runs[2]?.work.resolve('fresh');
    expect(await fourth).toBe('fresh');
  });

  it('raceSignal rejects at once and leaves the work alone', async () => {
    const work = deferred<number>();
    const controller = new AbortController();
    const raced = raceSignal(work.promise, controller.signal).catch((e: unknown) => e);
    controller.abort();
    expect(isGitCoreError(await raced, 'aborted')).toBe(true);
    work.resolve(2);
    expect(await work.promise).toBe(2);
    expect(await raceSignal(Promise.resolve(3), undefined)).toBe(3);
  });
});
