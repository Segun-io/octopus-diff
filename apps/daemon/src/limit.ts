/**
 * At most `max` tasks run at once; the rest wait in arrival order. Used where one change fans out
 * to every worktree of a project (a fetch that moves `origin/main` relabels all of them, #33), so
 * that background work cannot fill git-core's queue ahead of interactive requests.
 */
export class Limiter {
  readonly #max: number;
  #running = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(max: number) {
    this.#max = Math.max(1, Math.floor(max));
  }

  /** Tasks running now (tests). */
  get running(): number {
    return this.#running;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#running >= this.#max) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else {
      this.#running++;
    }
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      // The slot passes straight to the next task (the count stays the same).
      if (next) next();
      else this.#running--;
    }
  }
}
