/**
 * The random operations of the fuzz tests (`incremental-fuzz.test.ts`, `diff-from-summary-fuzz.test.ts`):
 * worktree edits (text, binary, deletes, renames, chmod, touch, symlinks, directories, ignore files) and git
 * operations (add, add -N, reset, rm --cached, mv, commit, checkout -f, symbolic-ref HEAD, stash) over a
 * small universe of paths (spaces, Unicode, a newline, case variants, nesting).
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { Fixture } from './fixture.js';

/** mulberry32: small, seedable, good enough for picking operations. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The path universe: spaces, unicode, a newline, nesting, an ignored pattern, a binary. */
const BASE_PATHS = [
  'a.txt',
  'b.txt',
  'c.txt',
  'dir/d.txt',
  'dir/e.txt',
  'dir/sub/f.txt',
  'other/g.txt',
  'sp ace.txt',
  'ünï/çödé.txt',
  'new\nline.txt',
  'bin.dat',
  'x.log',
  'keep.log',
  'dir/keep.log',
  'ign/y.txt',
  'Case.txt',
  'case.txt',
];
const BASE_DIRS = ['dir', 'dir/sub', 'other', 'ünï', 'ign', 'fresh', 'fresh/deep'];
/**
 * Extra shapes for the capped seeds (#43, PR #91): dependency and build-output names at several
 * depths (omitted first), an ordinary folder named `build` next to source, a bidi name (no ignore
 * line). The plan and its description must still agree between incremental and full.
 */
const PLAN_PATHS = [
  'node_modules/a.js',
  'node_modules/p/b.js',
  'pkg/node_modules/c.js',
  'pkg/src.ts',
  'dist/x.js',
  'dist/assets/y.js',
  'src/build/z.ts',
  'src/build/gen/w.ts',
  'out/v.txt',
  '\u202eevil/e.txt',
];
const PLAN_DIRS = ['node_modules', 'pkg/node_modules', 'dist', 'src/build'];
/**
 * The path universe of the running seed (live bindings: `useUniverse` widens it for the capped
 * seeds, importers see the change).
 */
export let PATHS: readonly string[] = BASE_PATHS;
export let DIRS: readonly string[] = BASE_DIRS;

/**
 * How many nested repositories the operations may still create (0: none). Off by default: a nested
 * repository keeps incremental refreshes off for the rest of a run, which the incremental fuzz's
 * thresholds do not allow; the diff fuzz turns it on.
 */
let nestedBudget = 0;
export function allowNestedRepositories(count: number): void {
  nestedBudget = count;
}

/** Chooses the universe of the next seed: with the plan shapes (#43) or without. */
export function useUniverse(planShapes: boolean): void {
  PATHS = planShapes ? [...BASE_PATHS, ...PLAN_PATHS] : BASE_PATHS;
  DIRS = planShapes ? [...BASE_DIRS, ...PLAN_DIRS] : BASE_DIRS;
}

export const BODIES = [
  (r: () => number) =>
    Array.from({ length: 20 }, (_, i) => `shared line ${i}\n`).join('') +
    `tail ${Math.floor(r() * 4)}\n`,
  (r: () => number) => `short ${Math.floor(r() * 3)}\n`,
  (r: () => number) =>
    Array.from(
      { length: 8 + Math.floor(r() * 8) },
      (_, i) => `row ${i} ${Math.floor(r() * 2)}\n`,
    ).join(''),
];

export interface Step {
  name: string;
  /** Its events are lost: no hint will ever name what it changed (PR #89 F1). */
  silent?: boolean;
  /** Worktree paths a watcher would report (null: a git operation; hint stays the paths touched). */
  touched: string[];
}

export type Op = (fx: Fixture, repo: string, r: () => number) => Step | null;

export const pick = <T>(r: () => number, list: readonly T[]): T =>
  list[Math.floor(r() * list.length)] as T;
export const abs = (repo: string, rel: string): string => path.join(repo, rel);
export const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Creates missing parent directories; returns the topmost one created (a watcher reports it). */
export function ensureParent(repo: string, rel: string): string | null {
  const parts = rel.split('/').slice(0, -1);
  let created: string | null = null;
  for (let i = 1; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    const full = abs(repo, dir);
    if (exists(full) && !lstatSync(full).isDirectory()) return 'blocked';
    if (!exists(full)) {
      mkdirSync(full);
      created ??= dir;
    }
  }
  return created;
}

export function writeFile(repo: string, rel: string, content: string | Buffer): Step | null {
  const created = ensureParent(repo, rel);
  if (created === 'blocked') return null;
  const full = abs(repo, rel);
  if (exists(full) && lstatSync(full).isDirectory()) return null;
  if (exists(full) && lstatSync(full).isSymbolicLink()) rmSync(full);
  writeFileSync(full, content);
  return { name: `write ${JSON.stringify(rel)}`, touched: created ? [created, rel] : [rel] };
}

export const git = (fx: Fixture, repo: string, args: string[]): void => {
  fx.git(repo, args, { allowFail: true });
};

/** Paths edited by a silent op in the current seed: a silent restore mostly undoes one of them. */
export const silentlyEdited: string[] = [];

export const OPS: Array<[number, Op]> = [
  [
    1,
    (_fx, repo, r) => {
      // An edit whose events are lost.
      const rel = pick(r, PATHS);
      const done = writeFile(repo, rel, pick(r, BODIES)(r));
      if (done) silentlyEdited.push(rel);
      return done ? { name: `silent ${done.name}`, touched: [], silent: true } : null;
    },
  ],
  [
    1,
    (fx, repo, r) => {
      // Back to HEAD's content, events lost too: what a list read mid-edit must not keep.
      const rel = silentlyEdited.length > 0 && r() < 0.8 ? pick(r, silentlyEdited) : pick(r, PATHS);
      const shown = spawnSync('git', ['show', `HEAD:${rel}`], {
        cwd: repo,
        env: { ...process.env, ...fx.env, LC_ALL: 'C' },
      });
      if (shown.status !== 0) return null;
      const done = writeFile(repo, rel, shown.stdout);
      return done
        ? { name: `silent restore ${JSON.stringify(rel)}`, touched: [], silent: true }
        : null;
    },
  ],
  [6, (_fx, repo, r) => writeFile(repo, pick(r, PATHS), pick(r, BODIES)(r))],
  [
    2,
    (_fx, repo, r) => {
      const rel = pick(r, PATHS);
      return writeFile(repo, rel, Buffer.from([0, 1, 2, Math.floor(r() * 255), 0, 10]));
    },
  ],
  [
    3,
    (fx, repo, r) => {
      // Back to HEAD's content by a plain write (no index change): a clean file again, which is
      // what leaves a phantom row in a list read while the edit was pending (PR #89 P1).
      const rel = pick(r, PATHS);
      const shown = spawnSync('git', ['show', `HEAD:${rel}`], {
        cwd: repo,
        env: { ...process.env, ...fx.env, LC_ALL: 'C' },
      });
      if (shown.status !== 0) return null;
      return writeFile(repo, rel, shown.stdout);
    },
  ],
  [
    3,
    (_fx, repo, r) => {
      const rel = pick(r, PATHS);
      const full = abs(repo, rel);
      if (!exists(full) || lstatSync(full).isDirectory()) return null;
      rmSync(full);
      return { name: `delete ${JSON.stringify(rel)}`, touched: [rel] };
    },
  ],
  [
    3,
    (_fx, repo, r) => {
      const from = pick(r, PATHS);
      const to = pick(r, PATHS);
      if (from === to || !exists(abs(repo, from)) || lstatSync(abs(repo, from)).isDirectory()) {
        return null;
      }
      const created = ensureParent(repo, to);
      if (
        created === 'blocked' ||
        (exists(abs(repo, to)) && lstatSync(abs(repo, to)).isDirectory())
      ) {
        return null;
      }
      renameSync(abs(repo, from), abs(repo, to));
      return {
        name: `rename ${JSON.stringify(from)} -> ${JSON.stringify(to)}`,
        touched: created ? [created, from, to] : [from, to],
      };
    },
  ],
  [
    1,
    (_fx, repo, r) => {
      const rel = pick(r, PATHS);
      const full = abs(repo, rel);
      if (!exists(full) || !lstatSync(full).isFile()) return null;
      chmodSync(full, lstatSync(full).mode & 0o100 ? 0o644 : 0o755);
      return { name: `chmod ${JSON.stringify(rel)}`, touched: [rel] };
    },
  ],
  [
    1,
    (_fx, repo, r) => {
      const rel = pick(r, PATHS);
      const full = abs(repo, rel);
      if (!exists(full) || lstatSync(full).isDirectory()) return null;
      const t = new Date(Date.now() - Math.floor(r() * 100_000));
      lutimesSync(full, t, t);
      return { name: `touch ${JSON.stringify(rel)}`, touched: [rel] };
    },
  ],
  [
    1,
    (_fx, repo, r) => {
      const rel = pick(r, PATHS);
      const created = ensureParent(repo, rel);
      const full = abs(repo, rel);
      if (created === 'blocked' || (exists(full) && lstatSync(full).isDirectory())) return null;
      if (exists(full)) rmSync(full);
      symlinkSync(pick(r, ['a.txt', 'missing', '../outside']), full);
      return { name: `symlink ${JSON.stringify(rel)}`, touched: created ? [created, rel] : [rel] };
    },
  ],
  [
    1,
    (_fx, repo, r) => {
      const dir = pick(r, DIRS);
      const full = abs(repo, dir);
      if (exists(full)) {
        rmSync(full, { recursive: true, force: true });
        return { name: `rm -rf ${dir}`, touched: [dir] };
      }
      const created = ensureParent(repo, `${dir}/x`);
      if (created === 'blocked') return null;
      writeFileSync(path.join(full, 'made.txt'), 'made in a new directory\n');
      return { name: `mkdir ${dir} + file`, touched: [created ?? dir, `${dir}/made.txt`] };
    },
  ],
  [
    1,
    (_fx, repo, r) => {
      const rules = pick(r, ['*.log\n', '*.log\nign/\n', 'ign/\n*.dat\n', '']);
      writeFileSync(abs(repo, '.gitignore'), rules);
      return { name: `.gitignore = ${JSON.stringify(rules)}`, touched: ['.gitignore'] };
    },
  ],
  [
    1,
    (fx, repo, r) => {
      const exclude = path.join(repo, '.git', 'info', 'exclude');
      mkdirSync(path.dirname(exclude), { recursive: true });
      writeFileSync(exclude, pick(r, ['', 'b.txt\n', 'other/\n']));
      void fx;
      return { name: 'info/exclude', touched: [] };
    },
  ],
  [
    2,
    (_fx, repo, r) => {
      // A `.gitignore` in any directory (negations included) written or deleted: whether a path is
      // listed as untracked changes with no change to the path itself (PR #93 review).
      const dir = pick(r, ['', 'dir', 'dir/sub', 'other']);
      const rel = dir === '' ? '.gitignore' : `${dir}/.gitignore`;
      const full = abs(repo, rel);
      if (r() < 0.4) {
        if (!exists(full) || lstatSync(full).isDirectory()) return null;
        rmSync(full);
        return { name: `delete ${rel}`, touched: [rel] };
      }
      const created = dir === '' ? null : ensureParent(repo, rel);
      if (created === 'blocked') return null;
      const rules = pick(r, ['*.log\n', '!keep.log\n', 'keep.log\n', '*.log\n!keep.log\n', '']);
      writeFileSync(full, rules);
      return {
        name: `${rel} = ${JSON.stringify(rules)}`,
        touched: created ? [created, rel] : [rel],
      };
    },
  ],
  [
    2,
    (_fx, repo, r) => {
      // A `.gitignore` written or deleted with its event lost, likely right after a summary that
      // listed a new file under younger rules (PR #93 P1: a refresh elsewhere must not trust the
      // new rules for the old entry).
      const dir = pick(r, ['', 'dir', 'dir/sub', 'other']);
      const rel = dir === '' ? '.gitignore' : `${dir}/.gitignore`;
      const full = abs(repo, rel);
      if (r() < 0.3) {
        if (!exists(full) || lstatSync(full).isDirectory()) return null;
        rmSync(full);
      } else {
        if (dir !== '' && ensureParent(repo, rel) === 'blocked') return null;
        writeFileSync(full, pick(r, ['*.log\n', '!keep.log\n', 'keep.log\n', '*.txt\n']));
      }
      return { name: `silent ${rel}`, touched: [], silent: true };
    },
  ],
  [
    1,
    (_fx, repo, r) => {
      // The file `core.excludesFile` names (some fuzz repositories set it): no event, no hint.
      const file = `${repo}.excludes`;
      if (r() < 0.3) rmSync(file, { force: true });
      else writeFileSync(file, pick(r, ['*.log\n', '', '!keep.log\n', 'ign/\n']));
      return { name: 'core.excludesFile content', touched: [], silent: true };
    },
  ],
  [
    1,
    (fx, repo, r) => {
      // A repository created inside a directory (git init + a commit) with its event lost: the
      // paths below it now belong to it, whatever the parent's index, HEAD and ignore files say
      // (PR #93 P1). Usually a directory that holds untracked files.
      if (nestedBudget <= 0) return null;
      // The diff fuzz keeps an untracked `nest/` (with an old .gitignore) for exactly this.
      const dir = r() < 0.5 ? 'nest' : pick(r, ['dir', 'dir/sub', 'other', 'ünï', 'fresh']);
      const full = abs(repo, dir);
      if (!exists(full) || !lstatSync(full).isDirectory() || exists(path.join(full, '.git'))) {
        return null;
      }
      nestedBudget -= 1;
      fx.git(full, ['init', '-q'], { allowFail: true });
      fx.git(full, ['add', '-A'], { allowFail: true });
      fx.git(full, ['commit', '-q', '-m', 'inner', '--allow-empty'], { allowFail: true });
      return { name: `nested repository in ${dir}`, touched: [], silent: true };
    },
  ],
  // Git operations: the index or HEAD changes (the daemon would see git-dir events and refresh
  // in full; git-core must notice on its own when handed a path hint anyway).
  [
    3,
    (fx, repo, r) => {
      const rel = pick(r, PATHS);
      git(fx, repo, ['add', '--', rel]);
      return { name: `git add ${JSON.stringify(rel)}`, touched: [] };
    },
  ],
  [
    1,
    (fx, repo, r) => {
      const rel = pick(r, PATHS);
      git(fx, repo, ['add', '-N', '--', rel]);
      return { name: `git add -N ${JSON.stringify(rel)}`, touched: [] };
    },
  ],
  [
    2,
    (fx, repo, r) => {
      const rel = pick(r, PATHS);
      git(fx, repo, ['reset', '-q', '--', rel]);
      return { name: `git reset ${JSON.stringify(rel)}`, touched: [] };
    },
  ],
  [
    1,
    (fx, repo, r) => {
      const rel = pick(r, PATHS);
      git(fx, repo, ['rm', '-q', '--cached', '--', rel]);
      return { name: `git rm --cached ${JSON.stringify(rel)}`, touched: [] };
    },
  ],
  [
    1,
    (fx, repo, r) => {
      const from = pick(r, PATHS);
      const to = pick(r, PATHS);
      ensureParent(repo, to);
      git(fx, repo, ['mv', '-k', '--', from, to]);
      return { name: `git mv ${JSON.stringify(from)} ${JSON.stringify(to)}`, touched: [from, to] };
    },
  ],
  [
    2,
    (fx, repo, r) => {
      if (r() < 0.5) git(fx, repo, ['add', '-A']);
      git(fx, repo, ['commit', '-q', '-m', 'step']);
      return { name: 'git commit', touched: [] };
    },
  ],
  [
    1,
    (fx, repo, r) => {
      const branch = pick(r, ['main', 'side']);
      git(fx, repo, ['checkout', '-q', '-f', branch]);
      return { name: `git checkout -f ${branch}`, touched: PATHS.slice(0, 4) };
    },
  ],
  [
    1,
    (fx, repo, r) => {
      // HEAD moves, the index stays: only the status header tells.
      const branch = pick(r, ['main', 'side']);
      git(fx, repo, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
      return { name: `git symbolic-ref HEAD ${branch}`, touched: [pick(r, PATHS)] };
    },
  ],
  [
    1,
    (fx, repo, r) => {
      if (r() < 0.5) git(fx, repo, ['stash', 'push', '-q', '-u']);
      else git(fx, repo, ['stash', 'pop', '-q']);
      return { name: 'git stash', touched: PATHS.slice(0, 3) };
    },
  ],
];
export const WEIGHT = OPS.reduce((sum, [w]) => sum + w, 0);

export function nextOp(r: () => number): Op {
  let x = r() * WEIGHT;
  for (const [w, op] of OPS) {
    x -= w;
    if (x < 0) return op;
  }
  return (OPS[0] as [number, Op])[1];
}
