import { describe, expect, it } from 'vitest';
import { LoadSequence, UiLoad, type UiLoadDeps, urlForLog } from '../src/ui-load.js';
import { FakeClock, settle, TOKEN } from './fakes.js';

const TARGET = `http://127.0.0.1:7428/#token=${TOKEN}`;

/** Electron's loadURL rejection: the message holds the URL (so the token), the code does not. */
function loadError(code: string): Error {
  return Object.assign(new Error(`${code} (-3) loading '${TARGET}'`), { code, errno: -3 });
}

interface Pending {
  url: string;
  resolve(): void;
  reject(error: unknown): void;
}

function harness(over: Partial<UiLoadDeps> = {}) {
  const clock = new FakeClock();
  const loads = new LoadSequence();
  const notes: string[] = [];
  const pending: Pending[] = [];
  const gaveUp: { note: string; attempts: number }[] = [];
  let wanted = true;
  const deps: UiLoadDeps = {
    load: (url) =>
      new Promise<void>((resolve, reject) => {
        pending.push({ url, resolve, reject });
      }),
    loads,
    timers: clock,
    note: (line) => notes.push(line),
    wanted: () => wanted,
    giveUp: (note, attempts) => gaveUp.push({ note, attempts }),
    policy: { commitTimeoutMs: 20_000, maxAttempts: 3, retryDelayMs: 1_000 },
    ...over,
  };
  const ui = new UiLoad(TARGET, deps);
  return {
    ui,
    clock,
    loads,
    notes,
    pending,
    gaveUp,
    last: () => pending[pending.length - 1] as Pending,
    unwant: () => {
      wanted = false;
    },
  };
}

describe('UiLoad', () => {
  it('loads the target once when the load succeeds', async () => {
    const h = harness();
    h.ui.start();
    expect(h.pending).toHaveLength(1);
    expect(h.last().url).toBe(TARGET);
    h.last().resolve();
    await h.clock.advance(60_000);
    expect(h.pending).toHaveLength(1);
    expect(h.gaveUp).toEqual([]);
    expect(h.notes.at(-1)).toBe('window: the UI loaded (attempt 1)');
    expect(h.clock.pending).toBe(0);
  });

  // The macOS CI flake (DECISIONS #591): an ERR_ABORTED that no newer load caused was taken for
  // "superseded" and dropped, and nothing ever replaced the starting screen.
  it('retries an ERR_ABORTED load that no newer load replaced, then gives up', async () => {
    const h = harness();
    h.ui.start();
    h.last().reject(loadError('ERR_ABORTED'));
    await settle();
    expect(h.notes.join('\n')).toContain('UI load attempt 1 failed (ERR_ABORTED)');
    await h.clock.advance(1_000);
    expect(h.pending).toHaveLength(2);
    h.last().reject(loadError('ERR_ABORTED'));
    await h.clock.advance(1_000);
    expect(h.pending).toHaveLength(3);
    h.last().reject(loadError('ERR_ABORTED'));
    await h.clock.advance(1_000);
    expect(h.pending).toHaveLength(3);
    expect(h.gaveUp).toEqual([{ note: 'ERR_ABORTED', attempts: 3 }]);
  });

  it('drops a failure once a newer load (a screen) began: no retry, no failure screen', async () => {
    const h = harness();
    h.ui.start();
    h.loads.begin(); // showScreen(...)
    h.last().reject(loadError('ERR_ABORTED'));
    await h.clock.advance(60_000);
    expect(h.pending).toHaveLength(1);
    expect(h.gaveUp).toEqual([]);
    expect(h.notes.join('\n')).not.toContain('failed');
  });

  it('drops a failure with any code once superseded (not only ERR_ABORTED)', async () => {
    const h = harness();
    h.ui.start();
    h.loads.begin();
    h.last().reject(loadError('ERR_CONNECTION_REFUSED'));
    await h.clock.advance(60_000);
    expect(h.pending).toHaveLength(1);
    expect(h.gaveUp).toEqual([]);
  });

  it('retries a load that never commits (the watchdog), and the stalled one is ignored', async () => {
    const h = harness({ describe: () => 'visible, loading, on a screen' });
    h.ui.start();
    const stalled = h.last();
    await h.clock.advance(19_999);
    expect(h.pending).toHaveLength(1);
    await h.clock.advance(1);
    expect(h.notes.join('\n')).toContain(
      'UI load attempt 1 failed (no page within 20000 ms; visible, loading, on a screen)',
    );
    await h.clock.advance(1_000);
    expect(h.pending).toHaveLength(2);
    // The retry aborts the stalled navigation: its rejection is not a failure of attempt 2.
    stalled.reject(loadError('ERR_ABORTED'));
    await h.clock.advance(1_000);
    expect(h.pending).toHaveLength(2);
    expect(h.notes.join('\n')).not.toContain('ERR_ABORTED');
    // Attempt 2's watchdog still runs.
    expect(h.clock.pending).toBe(1);
    h.ui.committed();
    h.last().resolve();
    await h.clock.advance(60_000);
    expect(h.pending).toHaveLength(2);
    expect(h.gaveUp).toEqual([]);
    expect(h.notes.at(-1)).toBe('window: the UI loaded (attempt 2)');
  });

  it('gives up after maxAttempts stalled loads, with the reason but not the window state', async () => {
    const h = harness({ describe: () => 'hidden' });
    h.ui.start();
    await h.clock.advance(20_000 + 1_000 + 20_000 + 1_000 + 20_000);
    expect(h.pending).toHaveLength(3);
    expect(h.gaveUp).toEqual([{ note: 'no page within 20000 ms', attempts: 3 }]);
    await h.clock.advance(60_000);
    expect(h.pending).toHaveLength(3);
  });

  it('a committed page turns the watchdog off (a slow page is not reloaded)', async () => {
    const h = harness();
    h.ui.start();
    await h.clock.advance(5_000);
    h.ui.committed();
    await h.clock.advance(120_000);
    expect(h.pending).toHaveLength(1);
    expect(h.gaveUp).toEqual([]);
    expect(h.notes.join('\n')).toContain('window: the UI page committed (attempt 1)');
  });

  it('a failure after the page committed is logged, not retried', async () => {
    const h = harness();
    h.ui.start();
    h.ui.committed();
    h.last().reject(loadError('ERR_FAILED'));
    await h.clock.advance(60_000);
    expect(h.pending).toHaveLength(1);
    expect(h.gaveUp).toEqual([]);
    expect(h.notes.at(-1)).toBe('window: the UI page reported ERR_FAILED after it committed');
  });

  it('a late success of a stalled attempt cancels its retry', async () => {
    const h = harness();
    h.ui.start();
    await h.clock.advance(20_000);
    h.last().resolve();
    await h.clock.advance(60_000);
    expect(h.pending).toHaveLength(1);
    expect(h.gaveUp).toEqual([]);
  });

  it('a commit during the retry delay cancels the retry', async () => {
    const h = harness();
    h.ui.start();
    await h.clock.advance(20_000);
    h.ui.committed();
    await h.clock.advance(60_000);
    expect(h.pending).toHaveLength(1);
    expect(h.gaveUp).toEqual([]);
  });

  it('does nothing once the window is gone or after cancel()', async () => {
    const gone = harness();
    gone.ui.start();
    gone.unwant();
    gone.last().reject(loadError('ERR_CONNECTION_REFUSED'));
    await gone.clock.advance(60_000);
    expect(gone.pending).toHaveLength(1);
    expect(gone.gaveUp).toEqual([]);

    const cancelled = harness();
    cancelled.ui.start();
    cancelled.ui.cancel();
    await cancelled.clock.advance(60_000);
    expect(cancelled.pending).toHaveLength(1);
    expect(cancelled.gaveUp).toEqual([]);
    expect(cancelled.clock.pending).toBe(0);
  });

  it('a load that throws synchronously counts as a failed attempt', async () => {
    let calls = 0;
    const h = harness({
      load: () => {
        calls++;
        throw loadError('ERR_INVALID_URL');
      },
    });
    h.ui.start();
    await h.clock.advance(10_000);
    expect(calls).toBe(3);
    expect(h.gaveUp).toEqual([{ note: 'ERR_INVALID_URL', attempts: 3 }]);
  });

  it('never logs the URL or the token', async () => {
    const h = harness();
    h.ui.start();
    h.last().reject(loadError('ERR_CONNECTION_REFUSED'));
    await h.clock.advance(1_000);
    await h.clock.advance(20_000 + 1_000);
    h.last().reject(new Error(`weird failure for ${TARGET}`));
    await h.clock.advance(1_000);
    const text = `${h.notes.join('\n')}\n${JSON.stringify(h.gaveUp)}`;
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('#token=');
    expect(text).not.toContain('127.0.0.1');
    expect(h.gaveUp).toEqual([{ note: 'unknown error', attempts: 3 }]);
  });
});

describe('LoadSequence', () => {
  it('only the newest ticket is current', () => {
    const s = new LoadSequence();
    const a = s.begin();
    expect(s.isCurrent(a)).toBe(true);
    const b = s.begin();
    expect(s.isCurrent(a)).toBe(false);
    expect(s.isCurrent(b)).toBe(true);
  });
});

describe('urlForLog', () => {
  it('http(s): the origin only, never the path, query or fragment', () => {
    expect(urlForLog(TARGET)).toBe('http://127.0.0.1:7428');
    expect(urlForLog(`https://example.com:8443/a/b?token=${TOKEN}#x`)).toBe(
      'https://example.com:8443',
    );
  });

  it('screens, empty and other schemes', () => {
    expect(urlForLog('data:text/html;charset=utf-8,%3C!doctype')).toBe('a screen');
    expect(urlForLog('')).toBe('no page');
    expect(urlForLog('file:///etc/passwd')).toBe('a file: URL');
    expect(urlForLog('about:blank')).toBe('a about: URL');
    expect(urlForLog('not a url')).toBe('an unparsable URL');
  });
});
