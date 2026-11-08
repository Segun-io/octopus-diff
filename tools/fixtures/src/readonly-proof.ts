import { type FSWatcher, watch } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { type IsolatedGitEnv, READ_ONLY_GIT_ARGS, runGit } from './git.js';
import type { FixtureManifest, RepoRole } from './manifest.js';

/**
 * Read-only proof harness (PLAN §5.5, §8 item 8).
 *
 * Before a run: snapshot every control repository (stat of every file in the common git dir,
 * including `index`, `HEAD`, refs, `packed-refs`, per-worktree git dirs and submodule git dirs,
 * plus `git status --porcelain=v2` of each worktree). During the run: watch the git dirs for any
 * file event and poll for `*.lock` files, so even a lock that exists for a millisecond is seen.
 * After the run: snapshot again and diff. Any difference, lock or write event is a violation.
 *
 * The harness itself only runs `git status` with `--no-optional-locks` and `GIT_OPTIONAL_LOCKS=0`
 * so it cannot cause what it is looking for.
 */

export interface ProofTarget {
  name: string;
  /** Realpath of the common git dir. */
  commonDir: string;
  /** Realpaths of the worktrees whose `git status` is compared (no bare entries). */
  worktrees: string[];
}

interface FileStat {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  ino: bigint;
  mode: bigint;
}

export interface RepoSnapshot {
  name: string;
  commonDir: string;
  files: Map<string, FileStat>;
  status: Map<string, string>;
}

export interface ProofEvent {
  repo: string;
  /** Path relative to the repo's common git dir. */
  path: string;
  /** `lock` = a `*.lock` file was seen; `write` = any other file event inside a git dir. */
  kind: 'lock' | 'write';
  source: 'watch' | 'poll';
  at: string;
}

export interface ProofReport {
  ok: boolean;
  violations: string[];
  events: ProofEvent[];
  repos: string[];
  warnings: string[];
  startedAt: string;
  finishedAt: string;
  pollCount: number;
}

export interface ReadOnlyProofOptions {
  env: IsolatedGitEnv;
  targets: ProofTarget[];
  /** Poll interval for `*.lock` files (default 20 ms). */
  pollIntervalMs?: number;
  /**
   * Treat every file event inside a git dir as a violation, not just locks (default true).
   * Read-only git never writes there, so any event means something wrote.
   */
  strictEvents?: boolean;
}

export interface ReadOnlyProof {
  readonly targets: readonly ProofTarget[];
  /** Events seen so far. */
  readonly events: readonly ProofEvent[];
  /** Stops watching, re-snapshots and returns the report (does not throw). */
  finish(): Promise<ProofReport>;
}

export class ReadOnlyViolationError extends Error {
  readonly report: ProofReport;

  constructor(report: ProofReport) {
    const lines = report.violations.slice(0, 50).map((v) => `  - ${v}`);
    if (report.violations.length > 50) lines.push(`  … and ${report.violations.length - 50} more`);
    super(
      `READ-ONLY PROOF FAILED: ${report.violations.length} violation(s) in fixture repositories that ` +
        `nothing was allowed to modify (PLAN §5.5):\n${lines.join('\n')}`,
    );
    this.name = 'ReadOnlyViolationError';
    this.report = report;
  }
}

export function assertReadOnly(report: ProofReport): void {
  if (!report.ok) throw new ReadOnlyViolationError(report);
}

/** Control (and helper source) repositories from a manifest: the ones nothing may modify. */
export function proofTargetsFromManifest(
  manifest: FixtureManifest,
  roles: readonly RepoRole[] = ['control', 'source'],
): ProofTarget[] {
  return manifest.projects
    .filter((p) => roles.includes(p.role))
    .map((p) => ({
      name: p.name,
      commonDir: p.commonDir,
      worktrees: p.worktrees.filter((w) => !w.bare).map((w) => w.path),
    }));
}

async function walk(dir: string, visit: (path: string, isDir: boolean) => void | Promise<void>) {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const isDir = entry.isDirectory();
    await visit(full, isDir);
    if (isDir) await walk(full, visit);
  }
}

async function statFile(path: string): Promise<FileStat | null> {
  try {
    const s = await lstat(path, { bigint: true });
    return { size: s.size, mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs, ino: s.ino, mode: s.mode };
  } catch {
    return null;
  }
}

async function worktreeStatus(env: IsolatedGitEnv, worktree: string): Promise<string> {
  const result = await runGit(
    [...READ_ONLY_GIT_ARGS, 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'],
    { cwd: worktree, env, extraEnv: { GIT_OPTIONAL_LOCKS: '0' }, allowFailure: true },
  );
  return result.code === 0
    ? result.stdout.toString('base64')
    : `error(${result.code}): ${result.stderr.trim()}`;
}

export async function snapshotRepo(
  env: IsolatedGitEnv,
  target: ProofTarget,
): Promise<RepoSnapshot> {
  const files = new Map<string, FileStat>();
  // Stat first, then run status: status runs with --no-optional-locks, so it can't touch them.
  await walk(target.commonDir, async (path, isDir) => {
    if (isDir) return;
    const stat = await statFile(path);
    if (stat) files.set(relative(target.commonDir, path), stat);
  });
  for (const worktree of target.worktrees) {
    const dotGit = await statFile(join(worktree, '.git'));
    if (dotGit && (dotGit.mode & 0o170000n) !== 0o040000n)
      files.set(`<worktree:${worktree}>/.git`, dotGit);
  }
  const status = new Map<string, string>();
  for (const worktree of target.worktrees)
    status.set(worktree, await worktreeStatus(env, worktree));
  return { name: target.name, commonDir: target.commonDir, files, status };
}

export function diffSnapshots(before: RepoSnapshot, after: RepoSnapshot): string[] {
  const violations: string[] = [];
  const repo = before.name;
  for (const [path, a] of before.files) {
    const b = after.files.get(path);
    if (!b) {
      violations.push(`${repo}: ${path} was deleted`);
      continue;
    }
    const changed: string[] = [];
    if (a.size !== b.size) changed.push(`size ${a.size}→${b.size}`);
    if (a.mtimeNs !== b.mtimeNs) changed.push('mtime');
    if (a.ino !== b.ino) changed.push('inode (replaced)');
    if (a.mode !== b.mode) changed.push('mode');
    if (a.ctimeNs !== b.ctimeNs && changed.length === 0) changed.push('ctime');
    if (changed.length) violations.push(`${repo}: ${path} changed (${changed.join(', ')})`);
  }
  for (const path of after.files.keys()) {
    if (!before.files.has(path)) violations.push(`${repo}: ${path} was created`);
  }
  for (const [worktree, status] of before.status) {
    if (after.status.get(worktree) !== status) {
      violations.push(`${repo}: git status of ${worktree} changed`);
    }
  }
  return violations;
}

const SKIP_WATCH_DIRS = new Set(['objects']);

/** Starts the proof: snapshots now, then watches until `finish()`. */
export async function startReadOnlyProof(options: ReadOnlyProofOptions): Promise<ReadOnlyProof> {
  const { env, targets } = options;
  const strict = options.strictEvents ?? true;
  const pollIntervalMs = options.pollIntervalMs ?? 20;
  const startedAt = new Date().toISOString();
  const warnings: string[] = [];
  const events: ProofEvent[] = [];
  const seen = new Set<string>();
  const record = (
    target: ProofTarget,
    path: string,
    kind: ProofEvent['kind'],
    source: ProofEvent['source'],
  ) => {
    const key = `${kind}:${target.name}:${path}:${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push({ repo: target.name, path, kind, source, at: new Date().toISOString() });
  };

  const before = new Map<string, RepoSnapshot>();
  for (const target of targets) before.set(target.name, await snapshotRepo(env, target));

  // --- watchers: one non-recursive fs.watch per directory (objects/ excluded) ---------------
  const watchers: FSWatcher[] = [];
  let watchFailed = false;
  const watchDir = (target: ProofTarget, dir: string) => {
    if (watchFailed) return;
    try {
      const watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (!filename) return;
        const full = join(dir, filename.toString());
        const rel = relative(target.commonDir, full);
        if (rel.split(sep)[0] === 'objects') return;
        if (rel.endsWith('.lock')) record(target, rel, 'lock', 'watch');
        else if (strict) record(target, rel, 'write', 'watch');
        // New directories (e.g. refs/heads/feature) get their own watcher.
        void lstat(full)
          .then((s) => {
            if (s.isDirectory()) watchDir(target, full);
          })
          .catch(() => {});
      });
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch (error) {
      watchFailed = true;
      warnings.push(`fs.watch unavailable (${(error as Error).message}); relying on polling only`);
    }
  };
  for (const target of targets) {
    watchDir(target, target.commonDir);
    await walk(target.commonDir, (path, isDir) => {
      if (!isDir) return;
      const rel = relative(target.commonDir, path);
      if (SKIP_WATCH_DIRS.has(rel.split(sep)[0] ?? '')) return;
      watchDir(target, path);
    });
  }

  // --- poller: any *.lock anywhere in the git dirs (objects/ excluded) ----------------------
  let pollCount = 0;
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      for (const target of targets) {
        await walk(target.commonDir, (path) => {
          const rel = relative(target.commonDir, path);
          if (rel.endsWith('.lock')) record(target, rel, 'lock', 'poll');
        });
      }
      pollCount++;
    } finally {
      polling = false;
    }
  };
  await poll();
  const timer = setInterval(() => void poll(), pollIntervalMs);
  timer.unref?.();

  return {
    targets,
    events,
    async finish() {
      clearInterval(timer);
      await poll();
      // Let pending watcher callbacks for the last writes arrive.
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (const watcher of watchers) watcher.close();
      const violations: string[] = [];
      for (const target of targets) {
        const after = await snapshotRepo(env, target);
        const snapshot = before.get(target.name);
        if (snapshot) violations.push(...diffSnapshots(snapshot, after));
      }
      for (const event of events) {
        violations.push(
          event.kind === 'lock'
            ? `${event.repo}: lock file ${event.path} appeared (${event.source})`
            : `${event.repo}: write event on ${event.path} (${event.source})`,
        );
      }
      return {
        ok: violations.length === 0,
        violations,
        events: [...events],
        repos: targets.map((t) => t.name),
        warnings,
        startedAt,
        finishedAt: new Date().toISOString(),
        pollCount,
      };
    },
  };
}
