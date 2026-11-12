/**
 * Opening a diff during an edit burst (issue #44): background summaries (one per edited worktree)
 * must not delay a request the user waits on. git-core runs `/diff` in its interactive lane, ahead
 * of queued summaries; this phase measures what that buys against the real daemon.
 *
 * The probe is `GET /diff` of one changed file of a worktree the burst does not touch, timed by
 * the client. First a few probes on the quiet daemon (the baseline), then `edits` appends spread
 * over the other worktrees, `intervalMs` apart (default 0: back to back, so every summary is queued
 * at once; at 20 ms apart the queue never builds on a fast machine and the lane makes no difference), with a probe every `probeEveryMs` from the first
 * edit until `tailMs` after the last one (the summaries outlive the burst; the probes spawn git
 * themselves, so "quiet" can only be waited for once they stop). Then the phase waits until the
 * daemon is quiet; `settled` says whether it got there. Probes run one at a time (a user opens one
 * diff at a time).
 */
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiClient } from '@octopus-diff/contracts';
import { summarize } from '@octopus-diff/fixtures';

export interface BurstOptions {
  client: ApiClient;
  /** Worktree whose diff is opened (not edited by the burst). */
  target: { id: string };
  file: string;
  /** Worktrees the burst edits, round-robin (their `README.md` is appended to). */
  editTargets: ReadonlyArray<{ path: string }>;
  edits?: number;
  intervalMs?: number;
  probeEveryMs?: number;
  /** Probing goes on this long after the last edit (default 2 s). */
  tailMs?: number;
  idleProbes?: number;
  /** Resolves when the daemon is quiet (no git process, trace not growing); false on timeout. */
  quiet: () => Promise<boolean>;
}

export interface BurstResult {
  edits: number;
  editedWorktrees: number;
  intervalMs: number;
  burstMs: number;
  idle: ReturnType<typeof summarize>;
  underBurst: ReturnType<typeof summarize>;
  /** p95 under the burst minus the quiet median: what the burst costs the user. */
  delayP95Ms: number | null;
  probes: Array<{ atMs: number; ms: number }>;
  settled: boolean;
  /** Epoch ms of the first edit and of the end of the phase (for the spawn trace). */
  window: [number, number];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function diffDuringBurst(options: BurstOptions): Promise<BurstResult> {
  const edits = options.edits ?? 60;
  const intervalMs = options.intervalMs ?? 0;
  const probeEveryMs = options.probeEveryMs ?? 100;
  const { client, target, file } = options;
  const probe = async (): Promise<number> => {
    const t0 = performance.now();
    await client.getDiff(target.id, { scope: { kind: 'working' }, path: file });
    return performance.now() - t0;
  };
  await options.quiet();
  await probe(); // warm: discovery and config reads are cached from here on
  const idle: number[] = [];
  for (let i = 0; i < (options.idleProbes ?? 7); i++) {
    idle.push(await probe());
    await sleep(50);
  }

  const from = Date.now();
  const t0 = performance.now();
  let burstDone = false;
  let stopAt = Number.POSITIVE_INFINITY;
  // A failed edit (a full disk, a removed worktree) is observed here, at once: the probe loop stops
  // and the error is rethrown after it, instead of an unhandled rejection that nothing awaits.
  let burstError: unknown;
  const burst = (async () => {
    try {
      for (let i = 0; i < edits; i++) {
        const wt = options.editTargets[i % options.editTargets.length];
        if (wt) await appendFile(join(wt.path, 'README.md'), `burst edit ${i}\n`);
        await sleep(intervalMs);
      }
      burstDone = true;
      stopAt = performance.now() + (options.tailMs ?? 2_000);
    } catch (error) {
      burstError = error;
      stopAt = 0;
    }
  })();
  const probes: Array<{ atMs: number; ms: number }> = [];
  while (performance.now() < stopAt) {
    const atMs = performance.now() - t0;
    probes.push({ atMs: Math.round(atMs), ms: Math.round(await probe()) });
    await sleep(probeEveryMs);
  }
  await burst;
  if (burstError !== undefined) throw burstError;
  const settled = await options.quiet();
  const burstMs = Math.round(performance.now() - t0);
  const underBurst = summarize(probes.map((p) => p.ms));
  const idleStats = summarize(idle);
  return {
    edits,
    editedWorktrees: Math.min(edits, options.editTargets.length),
    intervalMs,
    burstMs,
    idle: idleStats,
    underBurst,
    delayP95Ms: burstDone && probes.length > 0 ? Math.round(underBurst.p95 - idleStats.p50) : null,
    probes,
    settled,
    window: [from, Date.now()],
  };
}
