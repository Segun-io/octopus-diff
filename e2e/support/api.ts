import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ApiClient, InboxEntry, ServerEvent } from '@octopus-diff/contracts';

/**
 * API-level helpers for the UX round 1 specs (settings, review policy, bulk review). They drive
 * the real daemon over HTTP with the contracts' `ApiClient`; no UI involved.
 */

export interface EventLog {
  readonly events: ServerEvent[];
  waitFor(predicate: (e: ServerEvent) => boolean, timeoutMs?: number): Promise<ServerEvent>;
  /** Events of one type received so far. */
  ofType<T extends ServerEvent['type']>(type: T): Array<Extract<ServerEvent, { type: T }>>;
  close(): void;
}

/** Subscribes to `/api/events`; resolves once the `hello` event arrived. */
export function recordEvents(client: ApiClient): Promise<EventLog> {
  const events: ServerEvent[] = [];
  const waiters: Array<{
    predicate: (e: ServerEvent) => boolean;
    resolve: (e: ServerEvent) => void;
  }> = [];
  let onHello: () => void = () => {};
  const hello = new Promise<void>((resolve) => {
    onHello = resolve;
  });
  const sub = client.subscribe({
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'hello') onHello();
      for (const w of [...waiters]) {
        if (w.predicate(event)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(event);
        }
      }
    },
    reconnectDelayMs: 100,
  });
  const log: EventLog = {
    events,
    waitFor(predicate, timeoutMs = 5000) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(`timed out waiting for event; got: ${events.map((e) => e.type).join(', ')}`),
          );
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
      });
    },
    ofType<T extends ServerEvent['type']>(type: T) {
      return events.filter((e) => e.type === type) as Array<Extract<ServerEvent, { type: T }>>;
    },
    close: () => sub.close(),
  };
  return hello.then(() => log);
}

/** worktree id -> summary stateHash for every worktree that has a summary. */
export async function stateHashes(client: ApiClient): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of (await client.listProjects()).projects) {
    for (const w of p.worktrees) if (w.summary) out[w.worktree.id] = w.summary.stateHash;
  }
  return out;
}

/** Polls until the worktree's stateHash differs from `previous`; returns the new one. */
export async function waitForStateHashChange(
  client: ApiClient,
  worktreeId: string,
  previous: string,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = (await stateHashes(client))[worktreeId];
    if (current && current !== previous) return current;
    if (Date.now() > deadline) throw new Error(`stateHash of ${worktreeId} did not change`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function reviewedPaths(client: ApiClient, worktreeId: string): Promise<string[]> {
  const { files } = await client.listFiles(worktreeId);
  return files
    .filter((f) => f.reviewed)
    .map((f) => f.path)
    .sort();
}

/** Review marks are per project: distinct (project, rawPath ?? path, patchHash) across entries. */
export function distinctMarks(entries: readonly Pick<InboxEntry, 'project' | 'files'>[]): number {
  const keys = new Set<string>();
  for (const e of entries) {
    for (const f of e.files) keys.add(`${e.project.id}\0${f.rawPath ?? f.path}\0${f.patchHash}`);
  }
  return keys.size;
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = performance.now();
  const value = await fn();
  return { ms: performance.now() - started, value };
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
