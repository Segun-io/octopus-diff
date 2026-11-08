/**
 * Shared @pierre/diffs worker pool so syntax highlighting stays off the main thread.
 *
 * Adapted from T3 Code's `apps/web/src/components/DiffWorkerPoolProvider.tsx`
 * (https://github.com/pingdotgg/t3code, MIT License, Copyright (c) T3 Tools Inc.): a module-level
 * pool shared by every consumer, released after an idle TTL instead of on each unmount (which
 * also survives React StrictMode's double mount).
 */
import { WorkerPoolContext } from '@pierre/diffs/react';
import { WorkerPoolManager } from '@pierre/diffs/worker';
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker';
import { type ReactNode, useSyncExternalStore } from 'react';

export const DIFF_THEMES = { dark: 'pierre-dark', light: 'pierre-light' } as const;

const IDLE_TTL_MS = 30_000;

function poolSize(): number {
  const cores =
    typeof navigator === 'undefined' ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
  return Math.max(2, Math.min(4, Math.floor(cores / 2)));
}

interface PoolEntry {
  pool: WorkerPoolManager;
  consumers: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

let shared: PoolEntry | undefined;

function createPool(): PoolEntry | undefined {
  if (typeof Worker === 'undefined') return undefined;
  const pool = new WorkerPoolManager(
    {
      workerFactory: () => new DiffsWorker(),
      poolSize: poolSize(),
      totalASTLRUCacheSize: 200,
      onWorkerError: (event) => {
        event.preventDefault?.();
        console.warn(
          'octopus-diff: diff highlighting worker failed; falling back to the main thread',
        );
      },
    },
    {
      theme: DIFF_THEMES,
      tokenizeMaxLineLength: 1000,
      lineDiffType: 'word-alt',
    },
  );
  return { pool, consumers: 0, idleTimer: undefined };
}

function subscribe(onChange: () => void): () => void {
  if (!shared) shared = createPool();
  const entry = shared;
  if (!entry) return () => {};
  clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
  entry.consumers += 1;
  onChange();
  return () => {
    entry.consumers -= 1;
    if (entry.consumers !== 0) return;
    entry.idleTimer = setTimeout(() => {
      entry.pool.terminate();
      if (shared === entry) shared = undefined;
    }, IDLE_TTL_MS);
  };
}

export function DiffWorkerPoolProvider({ children }: { children: ReactNode }) {
  const pool = useSyncExternalStore(
    subscribe,
    () => shared?.pool,
    () => undefined,
  );
  return <WorkerPoolContext value={pool}>{children}</WorkerPoolContext>;
}
