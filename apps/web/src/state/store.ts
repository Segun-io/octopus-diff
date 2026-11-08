import { useSyncExternalStore } from 'react';

/** Minimal external store (no dependency): `getState`, `setState`, `subscribe`, plus a hook. */
export interface Store<S> {
  getState(): S;
  setState(update: Partial<S> | ((state: S) => Partial<S>)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    setState(update) {
      const patch = typeof update === 'function' ? update(state) : update;
      let changed = false;
      for (const key of Object.keys(patch) as (keyof S)[]) {
        if (!Object.is(state[key], patch[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Subscribes to a slice of the store. The selector must return a stable value for equal state. */
export function useStoreSelector<S, T>(store: Store<S>, selector: (state: S) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}
