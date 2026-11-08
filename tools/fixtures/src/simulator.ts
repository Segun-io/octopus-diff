import { existsSync } from 'node:fs';
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { type IsolatedGitEnv, runGit } from './git.js';
import { codeLines, createRng, type Rng, word } from './random.js';

/**
 * Agent simulator: behaves like a coding agent working in a worktree. At seeded random intervals
 * it edits, appends to, adds, renames and deletes files, and sometimes stages or commits (like an
 * agent running git). It refuses to touch anything outside the OS temp dir.
 */

export const SIMULATOR_ACTIONS = [
  'edit',
  'append',
  'add',
  'rename',
  'delete',
  'stage',
  'commit',
] as const;
export type SimulatorActionKind = (typeof SIMULATOR_ACTIONS)[number];

export const DEFAULT_ACTION_WEIGHTS: Record<SimulatorActionKind, number> = {
  edit: 40,
  append: 20,
  add: 12,
  rename: 6,
  delete: 6,
  stage: 10,
  commit: 6,
};

export interface SimulatorTarget {
  /** Worktree root (must be inside the OS temp dir and contain `.git`). */
  path: string;
  /** Label for logs (default: the path). */
  name?: string;
}

export interface SimulatorAction {
  /** Milliseconds since the simulator started. */
  at: number;
  kind: SimulatorActionKind;
  target: string;
  /** Repo-relative path acted on (for commit: null). */
  path: string | null;
  oldPath?: string;
  ok: boolean;
  error?: string;
}

export interface SimulatorOptions {
  targets: SimulatorTarget[];
  env: IsolatedGitEnv;
  seed?: number;
  /** Stop after this long (default 10 s). */
  durationMs?: number;
  /** Stop after this many actions (default unlimited). */
  maxActions?: number;
  /** Pause between actions, uniformly random in [min, max] (defaults 150–1200 ms). */
  minIntervalMs?: number;
  maxIntervalMs?: number;
  weights?: Partial<Record<SimulatorActionKind, number>>;
  onAction?: (action: SimulatorAction) => void;
  signal?: AbortSignal;
}

export interface SimulatorReport {
  actions: SimulatorAction[];
  durationMs: number;
  byKind: Record<SimulatorActionKind, number>;
  errors: number;
}

export interface SimulatorHandle {
  readonly actions: readonly SimulatorAction[];
  /** Resolves when the run ends (duration, maxActions, stop() or abort). */
  readonly done: Promise<SimulatorReport>;
  stop(): Promise<SimulatorReport>;
}

const SKIP_DIRS = new Set(['.git', 'node_modules']);

/** Throws unless `path` is a git worktree inside the OS temp dir. */
export async function assertSafeTarget(path: string): Promise<string> {
  const tmp = await realpath(tmpdir());
  const real = await realpath(path);
  if (!real.startsWith(tmp + sep)) {
    throw new Error(`agent simulator refuses to touch ${real}: not inside ${tmp}`);
  }
  if (!existsSync(join(real, '.git'))) {
    throw new Error(`agent simulator refuses to touch ${real}: not a git worktree`);
  }
  return real;
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip nested repositories (submodules).
        if (existsSync(join(full, '.git'))) continue;
        await visit(full);
      } else if (entry.isFile()) {
        out.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  await visit(root);
  return out.sort();
}

async function isTextFile(path: string): Promise<boolean> {
  try {
    const content = await readFile(path);
    return content.length < 512 * 1024 && !content.subarray(0, 8000).includes(0);
  } catch {
    return false;
  }
}

async function textFiles(root: string): Promise<string[]> {
  const files = await listFiles(root);
  const result: string[] = [];
  for (const file of files) if (await isTextFile(join(root, file))) result.push(file);
  return result;
}

/**
 * Performs one simulator action in `root` (an already validated worktree). Exposed for tests
 * and the bench, which want individual, deterministic steps.
 */
export async function performAction(
  rng: Rng,
  env: IsolatedGitEnv,
  root: string,
  kind: SimulatorActionKind,
  counter = 0,
): Promise<Omit<SimulatorAction, 'at' | 'target'>> {
  const files = await textFiles(root);
  const ensureFile = () => {
    if (files.length === 0) throw new Error('no text files to act on');
    return rng.pick(files);
  };
  switch (kind) {
    case 'edit': {
      const path = ensureFile();
      const lines = (await readFile(join(root, path), 'utf8')).split('\n');
      const edits = rng.int(1, 3);
      for (let i = 0; i < edits; i++) {
        const at = rng.int(0, Math.max(0, lines.length - 1));
        lines[at] = `// agent edit ${counter}.${i}: ${word(rng)} ${word(rng)}`;
      }
      await writeFile(join(root, path), lines.join('\n'));
      return { kind, path, ok: true };
    }
    case 'append': {
      const path = ensureFile();
      await appendFile(
        join(root, path),
        `${codeLines(rng, rng.int(1, 8), counter * 10).join('\n')}\n`,
      );
      return { kind, path, ok: true };
    }
    case 'add': {
      const dirs = [
        ...new Set(files.map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''))),
      ];
      const dir = dirs.length ? rng.pick(dirs) : '';
      const name = `agent-${word(rng)}-${counter}.ts`;
      const path = dir ? `${dir}/${name}` : name;
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), `${codeLines(rng, rng.int(3, 30)).join('\n')}\n`);
      return { kind, path, ok: true };
    }
    case 'rename': {
      const oldPath = ensureFile();
      const slash = oldPath.lastIndexOf('/');
      const path = `${slash >= 0 ? `${oldPath.slice(0, slash)}/` : ''}renamed-${counter}-${oldPath.slice(slash + 1)}`;
      await rename(join(root, oldPath), join(root, path));
      return { kind, path, oldPath, ok: true };
    }
    case 'delete': {
      if (files.length <= 3) return performAction(rng, env, root, 'add', counter);
      const path = ensureFile();
      await rm(join(root, path), { force: true });
      return { kind, path, ok: true };
    }
    case 'stage': {
      const path = ensureFile();
      await runGit(['add', '-A', '--', path], { cwd: root, env });
      return { kind, path, ok: true };
    }
    case 'commit': {
      await runGit(['add', '-A'], { cwd: root, env });
      const result = await runGit(
        ['commit', '-q', '--no-verify', '-m', `agent: step ${counter} (${word(rng)})`],
        { cwd: root, env, allowFailure: true },
      );
      // Exit 1 = nothing to commit; still a valid agent action.
      return { kind, path: null, ok: result.code === 0 || result.code === 1 };
    }
  }
}

export function startAgentSimulator(options: SimulatorOptions): SimulatorHandle {
  if (options.targets.length === 0) throw new Error('agent simulator needs at least one target');
  const rng = createRng(options.seed ?? 1);
  const weights = { ...DEFAULT_ACTION_WEIGHTS, ...options.weights };
  const entries = SIMULATOR_ACTIONS.map((k) => [k, weights[k]] as const);
  const minInterval = options.minIntervalMs ?? 150;
  const maxInterval = Math.max(minInterval, options.maxIntervalMs ?? 1200);
  const durationMs = options.durationMs ?? 10_000;
  const actions: SimulatorAction[] = [];
  const controller = new AbortController();
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  const started = Date.now();

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      controller.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });

  const run = async (): Promise<SimulatorReport> => {
    const roots = await Promise.all(options.targets.map((t) => assertSafeTarget(t.path)));
    let counter = 0;
    while (!controller.signal.aborted) {
      if (Date.now() - started >= durationMs) break;
      if (options.maxActions !== undefined && counter >= options.maxActions) break;
      const index = rng.int(0, roots.length - 1);
      const root = roots[index] as string;
      const target = options.targets[index]?.name ?? root;
      const kind = rng.weighted(entries);
      counter++;
      let action: SimulatorAction;
      try {
        const result = await performAction(rng, options.env, root, kind, counter);
        action = { at: Date.now() - started, target, ...result };
      } catch (error) {
        action = {
          at: Date.now() - started,
          target,
          kind,
          path: null,
          ok: false,
          error: String(error),
        };
      }
      actions.push(action);
      options.onAction?.(action);
      if (options.maxActions !== undefined && counter >= options.maxActions) break;
      await sleep(rng.int(minInterval, maxInterval));
    }
    const byKind = Object.fromEntries(SIMULATOR_ACTIONS.map((k) => [k, 0])) as Record<
      SimulatorActionKind,
      number
    >;
    for (const action of actions) byKind[action.kind]++;
    return {
      actions,
      durationMs: Date.now() - started,
      byKind,
      errors: actions.filter((a) => !a.ok).length,
    };
  };

  const done = run();
  return {
    actions,
    done,
    stop: async () => {
      controller.abort();
      return done;
    },
  };
}
