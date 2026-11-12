import { useSyncExternalStore } from 'react';

/**
 * A shared clock for the short ages in the sidebar ("7m", "3h"): one interval for the whole
 * page, started by the first subscriber and stopped with the last. A row's age is a leaf that
 * subscribes here, so the tick re-renders those leaves only, never a row (rows are memoised).
 */
const TICK_MS = 30_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = Date.now();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The current time, refreshed every 30 seconds while something is subscribed. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now, Date.now);
}
