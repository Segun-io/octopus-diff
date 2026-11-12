import { useEffect, useState } from 'react';
import { STALE_CLOCK_MS, WAIT_NOTE_DELAY_MS } from './wait.ts';

/**
 * True once `active` has been true for `delayMs` without a break; false again as soon as it is not.
 * This is the threshold of every attributed message (#11): a load that ends sooner never shows one.
 */
export function useDelayedFlag(active: boolean, delayMs: number = WAIT_NOTE_DELAY_MS): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const timer = setTimeout(() => setOn(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && on;
}

/**
 * `active` until it has been continuously true for `ms`, then false until it resets. For a state
 * that is only claimed for a while (a daemon that never answers must not keep a note up for ever).
 * `key` restarts the clock (the project being waited on).
 */
export function useExpiring(active: boolean, key: string, ms: number): boolean {
  const [expired, setExpired] = useState<string | null>(null);
  useEffect(() => {
    if (!active) {
      setExpired(null);
      return;
    }
    const timer = setTimeout(() => setExpired(key), ms);
    return () => clearTimeout(timer);
  }, [active, key, ms]);
  return active && expired !== key;
}

/** `Date.now()`, refreshed every `intervalMs` while `enabled` (a display clock for "3 min ago"). */
export function useNow(enabled: boolean, intervalMs: number = STALE_CLOCK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
}
