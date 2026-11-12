/** Reads and summarises the spawn trace written by `spawn-trace.mjs` (one JSON line per child). */
import { readFile } from 'node:fs/promises';
import { summarize } from '@octopus-diff/fixtures';

export interface TracedSpawn {
  t0: number;
  t1: number;
  ms: number;
  /** Executable base name; absent in traces written before it was recorded. */
  cmd?: string;
  sub: string;
  args: string[];
  cwd: string | null;
  code: number | null;
}

export async function readSpawns(file: string): Promise<TracedSpawn[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TracedSpawn);
}

/** Only git processes (the daemon runs nothing else against the fixtures, but be explicit). */
export function gitSpawns(spawns: readonly TracedSpawn[]): TracedSpawn[] {
  return spawns.filter((s) => (s.cmd ?? 'git') === 'git');
}

export interface SpawnGroup {
  count: number;
  totalMs: number;
  p50: number;
  p95: number;
}

export interface SpawnStats {
  total: number;
  /** Sum of every process's wall time (overlapping processes add up). */
  wallMs: number;
  bySub: Record<string, SpawnGroup>;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function spawnStats(spawns: readonly TracedSpawn[]): SpawnStats {
  const groups = new Map<string, number[]>();
  for (const s of spawns) {
    // `git --version` has no subcommand: the trace then records the executable.
    let key = s.sub.includes('/') ? '--version' : s.sub;
    if (s.sub === 'diff' && s.args.includes('--numstat')) key = 'diff --numstat';
    else if (s.sub === 'diff' && s.args.includes('--raw')) key = 'diff --raw';
    const list = groups.get(key) ?? [];
    list.push(s.ms);
    groups.set(key, list);
  }
  const bySub: Record<string, SpawnGroup> = {};
  for (const [key, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const st = summarize(list);
    bySub[key] = {
      count: list.length,
      totalMs: Math.round(list.reduce((a, b) => a + b, 0)),
      p50: round1(st.p50),
      p95: round1(st.p95),
    };
  }
  return {
    total: spawns.length,
    wallMs: Math.round(spawns.reduce((a, s) => a + s.ms, 0)),
    bySub,
  };
}

/** Spawns that started in `[from, to)` (epoch ms). */
export function within(spawns: readonly TracedSpawn[], from: number, to: number): TracedSpawn[] {
  return spawns.filter((s) => s.t0 >= from && s.t0 < to);
}
