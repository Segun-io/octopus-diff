import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeFixtureRoot } from './generator.js';
import { cleanGitEnv, createIsolatedGitEnv, type IsolatedGitEnv, runGit } from './git.js';

/**
 * The large layout (issue #26): one monorepo with many tracked files and three worktrees, built
 * to reproduce what a profiling pass found on a real 100k-file monorepo:
 *
 * - `main` (the main checkout): a few hundred dirty and untracked files and a very large file
 *   rewritten end to end (the 300k-line diff);
 * - `stale-index`: a linked worktree whose index no longer matches the files' stat data (every
 *   file looks changed to git until the index is refreshed, which `--no-optional-locks` never
 *   does), so every `git status` re-hashes all tracked files;
 * - `untracked-heavy`: a linked worktree with tens of thousands of untracked files;
 * - `many-changed` (only with `manyChanged` > 0, issue #42): a linked worktree where a format run
 *   rewrote tens of thousands of tracked files, so its file list is that long (no cap applies to
 *   tracked changes).
 *
 * Every worktree also carries its own dirty tracked and untracked files. The history is built with
 * `git fast-import`, so 100k files take seconds. Fixture setup is the one place outside git-core
 * that may spawn git against repositories (AGENTS.md), and it only touches its own temp dir.
 */
export interface LargeLayoutOptions {
  /** Tracked files in the monorepo (`HEAD` of every worktree). */
  files: number;
  /** Modified tracked files per worktree. */
  dirtyTracked: number;
  /** New untracked files per worktree (one directory). */
  untracked: number;
  /** Extra untracked files in the `untracked-heavy` worktree (spread over many directories). */
  manyUntracked: number;
  /** Lines of the tracked file the main worktree rewrites completely. */
  rewriteLines: number;
  /**
   * Tracked files a format run rewrote in the `many-changed` worktree (#42); 0 or absent: no such
   * worktree. At most `files`.
   */
  manyChanged?: number;
}

/** `large` is the issue's layout; `large-ci` keeps the same shape at ~20k files for CI. */
export const LARGE_LAYOUTS = {
  large: {
    files: 100_000,
    dirtyTracked: 300,
    untracked: 400,
    manyUntracked: 30_000,
    rewriteLines: 300_000,
  },
  'large-ci': {
    files: 20_000,
    dirtyTracked: 100,
    untracked: 150,
    manyUntracked: 5_000,
    rewriteLines: 30_000,
  },
  /**
   * Paged file lists (#42): 40k tracked files, and a linked worktree with 36k of them rewritten
   * (the issue's "36k-file worktree"); the other worktrees stay small.
   */
  'large-paged': {
    files: 40_000,
    dirtyTracked: 100,
    untracked: 150,
    manyUntracked: 1_000,
    rewriteLines: 30_000,
    manyChanged: 36_000,
  },
} as const satisfies Record<string, LargeLayoutOptions>;
export type LargeLayoutName = keyof typeof LARGE_LAYOUTS;

export type LargeWorktreeRole = 'main' | 'stale-index' | 'untracked-heavy' | 'many-changed';

export interface LargeWorktree {
  role: LargeWorktreeRole;
  name: string;
  path: string;
  branch: string;
  /** Expected `git status --untracked-files=all` entries (modified / untracked). */
  expectedModified: number;
  expectedUntracked: number;
}

export interface LargeFixtureSet {
  readonly root: string;
  readonly options: LargeLayoutOptions;
  readonly env: IsolatedGitEnv;
  /** The monorepo's main checkout: the path to register with the daemon. */
  readonly projectPath: string;
  readonly worktrees: readonly LargeWorktree[];
  readonly generationMs: number;
  cleanup(): Promise<void>;
}

export interface GenerateLargeOptions {
  /** A named layout, or explicit sizes (merged over `large-ci`). Default `large-ci`. */
  layout?: LargeLayoutName | Partial<LargeLayoutOptions>;
  parentDir?: string;
  prefix?: string;
}

/** Path of tracked file `i`: 8 apps × 10 packages × 10 modules × 5 subdirs → deep, even paths. */
export function largeFilePath(i: number): string {
  const d = i % 125;
  const rest = Math.floor(i / 125);
  const c = rest % 10;
  const b = Math.floor(rest / 10) % 10;
  const a = Math.floor(rest / 100);
  return `apps/app${a % 8}/packages/pkg${b}/src/mod${c}/sub${Math.floor(d / 25)}/file_${a}_${d}.ts`;
}

const HUGE_FILE = 'docs/generated/huge.txt';
const FIXED_DATE = '2026-01-01T00:00:00Z';

function resolveOptions(layout: GenerateLargeOptions['layout']): LargeLayoutOptions {
  if (typeof layout === 'string') return { ...LARGE_LAYOUTS[layout] };
  return { ...LARGE_LAYOUTS['large-ci'], ...layout };
}

function hugeLines(tag: string, lines: number): string {
  const out: string[] = new Array(lines);
  const pad = 'x'.repeat(40);
  for (let i = 0; i < lines; i++) out[i] = `line ${i} ${tag} ${pad}`;
  return `${out.join('\n')}\n`;
}

/** Runs `task` over `items` with bounded concurrency. */
async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}

async function fastImport(
  cwd: string,
  env: IsolatedGitEnv,
  files: Iterable<[string, string]>,
  message: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['fast-import', '--quiet'], {
      cwd,
      env: cleanGitEnv({
        ...env.vars,
        GIT_AUTHOR_DATE: FIXED_DATE,
        GIT_COMMITTER_DATE: FIXED_DATE,
      }),
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`git fast-import exited ${code}: ${stderr}`)),
    );
    const write = async (data: string | Buffer) => {
      if (!child.stdin.write(data)) await new Promise((r) => child.stdin.once('drain', r));
    };
    (async () => {
      await write(
        `commit refs/heads/main\ncommitter Octopus Fixture <fixtures@octopus-diff.invalid> 1767225600 +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`,
      );
      for (const [path, content] of files) {
        const body = Buffer.from(content);
        await write(`M 100644 inline ${path}\ndata ${body.length}\n`);
        await write(body);
        await write('\n');
      }
      child.stdin.end();
    })().catch(reject);
  });
}

function* trackedFiles(options: LargeLayoutOptions): Generator<[string, string]> {
  for (let i = 0; i < options.files; i++) {
    yield [largeFilePath(i), `export const v${i} = ${i};\n// line\n`.repeat(3)];
  }
  yield ['README.md', '# large monorepo fixture\n'];
  yield [HUGE_FILE, hugeLines('a', options.rewriteLines)];
}

/** Every tracked file gets a new mtime/ctime with unchanged content: the index goes stale. */
async function makeIndexStale(worktreePath: string, files: number): Promise<void> {
  const when = new Date('2030-01-01T00:00:00Z');
  await forEachLimit(range(files), 64, (i) =>
    utimes(join(worktreePath, largeFilePath(i)), when, when),
  );
}

/** The `many-changed` worktree: the first `count` tracked files rewritten (a format run), plus new files. */
async function formatRun(worktreePath: string, options: LargeLayoutOptions, count: number) {
  await forEachLimit(range(count), 64, (i) =>
    writeFile(
      join(worktreePath, largeFilePath(i)),
      `export const v${i} = ${i};\n// line\n`.repeat(3).replaceAll(' = ', '='),
    ),
  );
  await mkdir(join(worktreePath, 'scratch', 'gen'), { recursive: true });
  await forEachLimit(range(options.untracked), 64, (u) =>
    writeFile(join(worktreePath, 'scratch', 'gen', `new_${u}.ts`), `export const u${u} = 1;\n`),
  );
}

async function dirtyWorktree(
  worktreePath: string,
  options: LargeLayoutOptions,
  tag: string,
  extra: { manyUntracked?: number },
): Promise<void> {
  // Modified tracked files, spread over the tree (every `stride`-th file).
  const stride = Math.max(1, Math.floor(options.files / Math.max(1, options.dirtyTracked)));
  const modified = range(options.dirtyTracked).map((k) => largeFilePath(k * stride));
  await forEachLimit(modified, 64, (rel) =>
    writeFile(join(worktreePath, rel), `// changed in ${tag}\nexport const changed = true;\n`),
  );
  await mkdir(join(worktreePath, 'scratch', 'gen'), { recursive: true });
  await forEachLimit(range(options.untracked), 64, (u) =>
    writeFile(join(worktreePath, 'scratch', 'gen', `new_${u}.ts`), `export const u${u} = 1;\n`),
  );
  const many = extra.manyUntracked ?? 0;
  if (many > 0) {
    const perDir = 100;
    const dirs = Math.ceil(many / perDir);
    for (let d = 0; d < dirs; d += 50) {
      const batch = range(Math.min(50, dirs - d)).map((k) => d + k);
      await forEachLimit(batch, 8, async (dir) => {
        const target = join(worktreePath, 'scratch', 'many', `pkg${dir % 20}`, `d${dir}`);
        await mkdir(target, { recursive: true });
        const count = Math.min(perDir, many - dir * perDir);
        await Promise.all(
          range(count).map((f) => writeFile(join(target, `f${f}.txt`), `untracked ${dir}/${f}\n`)),
        );
      });
    }
  }
}

export async function generateLargeFixtures(
  generate: GenerateLargeOptions = {},
): Promise<LargeFixtureSet> {
  const started = performance.now();
  const options = resolveOptions(generate.layout);
  const parentDir = generate.parentDir ?? tmpdir();
  const root = await realpath(
    await mkdtemp(join(parentDir, generate.prefix ?? 'octopus-diff-large-')),
  );
  try {
    const env = await createIsolatedGitEnv(root);
    const git = (cwd: string, args: string[]) =>
      runGit(args, {
        cwd,
        env,
        timeoutMs: 600_000,
        extraEnv: { GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
      });
    const mono = join(root, 'mono');
    await mkdir(mono, { recursive: true });
    await git(mono, ['init', '-q', '--initial-branch=main', '.']);
    await fastImport(mono, env, trackedFiles(options), 'large: initial\n');
    await git(mono, ['checkout', '-q', '-f', 'main']);

    const stale = join(root, 'mono-stale-index');
    const heavy = join(root, 'mono-untracked-heavy');
    await git(mono, ['worktree', 'add', '-q', '-b', 'feat-stale-index', stale, 'main']);
    await git(mono, ['worktree', 'add', '-q', '-b', 'feat-untracked-heavy', heavy, 'main']);

    // The stale index first (touching unchanged files), then each worktree's dirt.
    await makeIndexStale(stale, options.files);
    await dirtyWorktree(mono, options, 'main', {});
    await writeFile(join(mono, HUGE_FILE), hugeLines('b', options.rewriteLines));
    await dirtyWorktree(stale, options, 'stale-index', {});
    await dirtyWorktree(heavy, options, 'untracked-heavy', {
      manyUntracked: options.manyUntracked,
    });
    const manyChanged = Math.min(options.manyChanged ?? 0, options.files);
    const many = join(root, 'mono-many-changed');
    if (manyChanged > 0) {
      await git(mono, ['worktree', 'add', '-q', '-b', 'feat-many-changed', many, 'main']);
      await formatRun(many, options, manyChanged);
    }

    const worktrees: LargeWorktree[] = [
      {
        role: 'main',
        name: 'mono',
        path: mono,
        branch: 'main',
        expectedModified: options.dirtyTracked + 1,
        expectedUntracked: options.untracked,
      },
      {
        role: 'stale-index',
        name: 'mono-stale-index',
        path: stale,
        branch: 'feat-stale-index',
        expectedModified: options.dirtyTracked,
        expectedUntracked: options.untracked,
      },
      {
        role: 'untracked-heavy',
        name: 'mono-untracked-heavy',
        path: heavy,
        branch: 'feat-untracked-heavy',
        expectedModified: options.dirtyTracked,
        expectedUntracked: options.untracked + options.manyUntracked,
      },
      ...(manyChanged > 0
        ? [
            {
              role: 'many-changed' as const,
              name: 'mono-many-changed',
              path: many,
              branch: 'feat-many-changed',
              expectedModified: manyChanged,
              expectedUntracked: options.untracked,
            },
          ]
        : []),
    ];
    let cleaned = false;
    return {
      root,
      options,
      env,
      projectPath: mono,
      worktrees,
      generationMs: Math.round(performance.now() - started),
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await removeFixtureRoot(root, parentDir);
      },
    };
  } catch (error) {
    await removeFixtureRoot(root, parentDir).catch(() => {});
    throw error;
  }
}
