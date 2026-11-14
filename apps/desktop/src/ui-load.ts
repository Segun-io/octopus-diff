/**
 * Loading the web UI into the window (DECISIONS #590-#594). Pure and Electron-free: `main.ts` gives
 * it `webContents.loadURL`, the clock and the log, and tells it when the main frame committed a page
 * of the UI's origin (`did-navigate`).
 *
 * - **Superseded is a sequence number, not an error code.** Every load the window starts (a screen
 *   or the UI) takes a ticket from one `LoadSequence`. A failed UI load is dropped as "superseded"
 *   only when a newer load began; an `ERR_ABORTED` that nothing replaced is a failure like any other
 *   (before #591 it was dropped silently, and the window stayed on the starting screen).
 * - **A commit watchdog.** `loadURL` has no timeout: a navigation that never commits leaves the
 *   previous page (the starting screen) up for ever. A UI load with no committed page within
 *   `commitTimeoutMs` is retried; once the page committed, the web UI shows its own loading and
 *   offline states and the watchdog is off.
 * - **A few attempts, then the failure screen.** A failed or stalled attempt is retried after
 *   `retryDelayMs`, up to `maxAttempts`; then `giveUp` shows the error screen ("Try again").
 *
 * Every line it logs is safe: error codes only (`loadFailureNote`), never a URL (the UI's URL holds
 * the token in its fragment).
 */
import type { TimersLike } from './backend.js';
import { loadFailureNote } from './policy.js';

export interface UiLoadPolicy {
  /** No committed UI page by then: the attempt has stalled and is retried. */
  commitTimeoutMs: number;
  /** Attempts before the failure screen. */
  maxAttempts: number;
  /** Delay before the next attempt after a failed or stalled one. */
  retryDelayMs: number;
}

export const DEFAULT_UI_LOAD_POLICY: UiLoadPolicy = {
  commitTimeoutMs: 20_000,
  maxAttempts: 3,
  retryDelayMs: 1_000,
};

/** Numbers the window's loads: the newest ticket is the load the window wants. */
export class LoadSequence {
  #current = 0;

  begin(): number {
    this.#current += 1;
    return this.#current;
  }

  isCurrent(ticket: number): boolean {
    return ticket === this.#current;
  }
}

export interface UiLoadDeps {
  /** `webContents.loadURL`: resolves when the page finished loading, rejects when it failed. */
  load(url: string): Promise<unknown>;
  loads: LoadSequence;
  timers: TimersLike;
  note(line: string): void;
  /** False once this UI is not wanted any more (its window closed). Newer loads are `loads`' job. */
  wanted(): boolean;
  /** Every attempt failed: show the failure screen. `note` is an error code, never a URL. */
  giveUp(note: string, attempts: number): void;
  /** A short, token-free description of the window (visible, loading, page) for a stalled attempt. */
  describe?(): string;
  policy?: Partial<UiLoadPolicy>;
}

export class UiLoad {
  readonly #target: string;
  readonly #deps: UiLoadDeps;
  readonly #policy: UiLoadPolicy;
  #attempt = 0;
  #ticket = 0;
  #timer: unknown = null;
  #committed = false;
  #done = false;

  constructor(target: string, deps: UiLoadDeps) {
    this.#target = target;
    this.#deps = deps;
    this.#policy = { ...DEFAULT_UI_LOAD_POLICY, ...deps.policy };
  }

  /** Attempts started so far. */
  get attempts(): number {
    return this.#attempt;
  }

  start(): void {
    if (this.#attempt === 0) this.#next();
  }

  /** Stops it: no more attempts, no failure screen (a newer load or screen took over). */
  cancel(): void {
    this.#done = true;
    this.#clearTimer();
  }

  /** The main frame committed a page of the UI's origin: the page is on show and takes over. */
  committed(): void {
    if (!this.#live() || this.#committed) return;
    this.#committed = true;
    this.#clearTimer();
    this.#deps.note(`window: the UI page committed (attempt ${this.#attempt})`);
  }

  #live(): boolean {
    return !this.#done && this.#deps.loads.isCurrent(this.#ticket) && this.#deps.wanted();
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      this.#deps.timers.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #next(): void {
    this.#attempt += 1;
    const attempt = this.#attempt;
    const ticket = this.#deps.loads.begin();
    this.#ticket = ticket;
    this.#committed = false;
    this.#deps.note(`window: loading the UI (attempt ${attempt} of ${this.#policy.maxAttempts})`);
    this.#timer = this.#deps.timers.setTimeout(() => {
      this.#timer = null;
      if (this.#ticket !== ticket || this.#committed || !this.#live()) return;
      const state = this.#deps.describe?.();
      this.#failed(
        attempt,
        `no page within ${this.#policy.commitTimeoutMs} ms${state ? `; ${state}` : ''}`,
      );
    }, this.#policy.commitTimeoutMs);
    let loading: Promise<unknown>;
    try {
      loading = this.#deps.load(this.#target);
    } catch (error) {
      loading = Promise.reject(error);
    }
    loading.then(
      () => {
        if (this.#ticket !== ticket || !this.#live()) return;
        this.#clearTimer();
        this.#done = true;
        this.#deps.note(`window: the UI loaded (attempt ${attempt})`);
      },
      (error: unknown) => {
        // Our own next attempt replaced this one (a stalled load is aborted by the retry).
        if (this.#ticket !== ticket) return;
        // A newer load (a screen, a forced reload) replaced it: whatever the code, not a failure.
        if (!this.#live()) return;
        this.#clearTimer();
        const note = loadFailureNote(error);
        if (this.#committed) {
          // The page is on show (the web UI handles its own errors from here): not retried.
          this.#done = true;
          this.#deps.note(`window: the UI page reported ${note} after it committed`);
          return;
        }
        this.#failed(attempt, note);
      },
    );
  }

  #failed(attempt: number, reason: string): void {
    if (attempt >= this.#policy.maxAttempts) {
      this.#done = true;
      this.#deps.note(`window: the UI did not load in ${attempt} attempts (${reason})`);
      this.#deps.giveUp(reason.split(';')[0] ?? reason, attempt);
      return;
    }
    this.#deps.note(
      `window: UI load attempt ${attempt} failed (${reason}); trying again in ${this.#policy.retryDelayMs} ms`,
    );
    this.#timer = this.#deps.timers.setTimeout(() => {
      this.#timer = null;
      if (this.#live()) this.#next();
    }, this.#policy.retryDelayMs);
  }
}

/**
 * What may be logged about a page URL: the origin of an http(s) page, "a screen" for our `data:`
 * pages, the scheme of anything else. Never the path, query or fragment (the UI's fragment holds
 * the token).
 */
export function urlForLog(url: string): string {
  if (url === '') return 'no page';
  if (url.startsWith('data:text/html')) return 'a screen';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'an unparsable URL';
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
  return `a ${parsed.protocol} URL`;
}

export interface UiWantedInput {
  /** The app is quitting (`before-quit`): the daemon is being stopped, the window hidden. */
  quitting: boolean;
  /** The app's window now (`win`), and the window this UI load is for. */
  current: unknown;
  window: unknown;
  destroyed: boolean;
}

/**
 * `UiLoad`'s `wanted`: this window still wants the UI. Not once the app is quitting: the watchdog or a
 * retry timer must not load against the daemon being stopped, nor put the failure screen into the
 * hidden window (PR #112 review).
 */
export function uiWanted(input: UiWantedInput): boolean {
  return !input.quitting && input.current === input.window && !input.destroyed;
}
