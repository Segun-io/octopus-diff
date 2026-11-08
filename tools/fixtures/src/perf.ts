import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/**
 * Perf-bench helpers that don't need the daemon: CPU sampling from `/proc/<pid>/stat` and
 * simple summary statistics. Linux only (the bench reports `supported: false` elsewhere).
 */

export interface ProcCpuTimes {
  /** user + system ticks of the process itself. */
  selfTicks: number;
  /** user + system ticks of reaped children (git processes the daemon spawned). */
  childTicks: number;
  rssBytes: number | null;
}

let cachedClockTicks: number | null = null;

/** `sysconf(_SC_CLK_TCK)` via `getconf` (almost always 100). */
export function clockTicksPerSecond(): number {
  if (cachedClockTicks !== null) return cachedClockTicks;
  try {
    const value = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
    cachedClockTicks = Number.isFinite(value) && value > 0 ? value : 100;
  } catch {
    cachedClockTicks = 100;
  }
  return cachedClockTicks;
}

/** Parses the contents of `/proc/<pid>/stat` (handles spaces/parens in the comm field). */
export function parseProcStat(text: string): {
  utime: number;
  stime: number;
  cutime: number;
  cstime: number;
  rssPages: number;
} {
  const close = text.lastIndexOf(')');
  if (close < 0) throw new Error('malformed /proc/<pid>/stat');
  // Fields after the comm: index 0 = state (field 3 in proc(5)).
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const num = (i: number) => Number(fields[i] ?? 0);
  // proc(5): utime=14, stime=15, cutime=16, cstime=17, rss=24 → offsets from field 3.
  return { utime: num(11), stime: num(12), cutime: num(13), cstime: num(14), rssPages: num(21) };
}

export async function readProcCpu(pid: number): Promise<ProcCpuTimes> {
  const stat = parseProcStat(await readFile(`/proc/${pid}/stat`, 'utf8'));
  return {
    selfTicks: stat.utime + stat.stime,
    childTicks: stat.cutime + stat.cstime,
    rssBytes: stat.rssPages > 0 ? stat.rssPages * 4096 : null,
  };
}

export interface CpuSampleResult {
  supported: boolean;
  durationMs: number;
  /** Average CPU of the process (incl. reaped children) as % of one core. */
  averagePercent: number;
  /** Same, process only. */
  averageSelfPercent: number;
  /** Highest per-interval value. */
  maxIntervalPercent: number;
  intervals: number[];
  rssBytes: number | null;
}

/** Samples a process' CPU usage over `durationMs`, one reading per `intervalMs`. */
export async function sampleProcessCpu(
  pid: number,
  durationMs: number,
  intervalMs = 1000,
): Promise<CpuSampleResult> {
  if (process.platform !== 'linux') {
    return {
      supported: false,
      durationMs: 0,
      averagePercent: Number.NaN,
      averageSelfPercent: Number.NaN,
      maxIntervalPercent: Number.NaN,
      intervals: [],
      rssBytes: null,
    };
  }
  const hz = clockTicksPerSecond();
  const first = await readProcCpu(pid);
  const start = performance.now();
  let previous = first;
  let previousAt = start;
  const intervals: number[] = [];
  while (performance.now() - start < durationMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const now = performance.now();
    const current = await readProcCpu(pid);
    const ticks = current.selfTicks + current.childTicks - previous.selfTicks - previous.childTicks;
    intervals.push(((ticks / hz) * 1000 * 100) / (now - previousAt));
    previous = current;
    previousAt = now;
  }
  const elapsed = previousAt - start;
  const total = previous.selfTicks + previous.childTicks - first.selfTicks - first.childTicks;
  const self = previous.selfTicks - first.selfTicks;
  return {
    supported: true,
    durationMs: Math.round(elapsed),
    averagePercent: ((total / hz) * 1000 * 100) / elapsed,
    averageSelfPercent: ((self / hz) * 1000 * 100) / elapsed,
    maxIntervalPercent: intervals.length ? Math.max(...intervals) : 0,
    intervals: intervals.map((v) => Math.round(v * 100) / 100),
    rssBytes: previous.rssBytes,
  };
}

export interface Stats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
}

/** Nearest-rank percentiles. */
export function summarize(values: readonly number[]): Stats {
  if (values.length === 0) {
    return {
      count: 0,
      min: Number.NaN,
      max: Number.NaN,
      mean: Number.NaN,
      p50: Number.NaN,
      p90: Number.NaN,
      p95: Number.NaN,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] as number;
  return {
    count: sorted.length,
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: rank(0.5),
    p90: rank(0.9),
    p95: rank(0.95),
  };
}
