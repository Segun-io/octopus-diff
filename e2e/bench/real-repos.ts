/**
 * Read-only profile of REAL repositories (issue #26, decision 3 in #25).
 *
 * The synthetic fixtures say how the app behaves on the shapes we thought of; this says how git
 * behaves on yours, so the work list (#27 to #45) can be ranked by what is actually slow. For each
 * repository and each of its worktrees it measures, one git process at a time:
 * tracked files, `ls-files`, `status` (default and `--untracked-files=all`, best of N), untracked
 * count, `diff --numstat HEAD`, and the config that matters for speed (`core.untrackedCache`,
 * `core.fsmonitor`, `core.splitIndex`, `feature.manyFiles`, `index.version`). A worktree whose
 * `status` is over twice its fastest sibling's (and its untracked files do not explain it) is flagged
 * as a probable stale index.
 *
 * It never writes to a repository (the `--json` file may not be inside any profiled repository, any of its
 * linked worktrees or any git directory, symlinks resolved):
 * - every git process goes through git-core's runner (the same subcommand allowlist as the app,
 *   `--no-optional-locks`, no pager, no external diff or textconv);
 * - `.git/index` (size, mtime, inode) is read before and after and reported, so "index untouched"
 *   is checked, not assumed;
 * - results go to stdout and, with `--json`, to a file that must not be inside a profiled repo.
 *
 * Usage (from the repository root; sources run directly):
 *   pnpm --filter @octopus-diff/e2e profile:real ~/code/app ~/code/other
 *   pnpm --filter @octopus-diff/e2e profile:real --scan-root ~/code --depth 3 --redact --json /tmp/real.json
 *   --repeat N   status runs per variant, best is reported (default 3)
 *   --redact     print repo-1 / worktree-2 instead of paths (safe to paste into an issue)
 *   --max N      stop after N repositories (default 40)
 */
import { existsSync } from 'node:fs';
import { lstat, readdir, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import {
  GitRunner,
  parseRawNumstat,
  parseStatusV2,
  parseWorktreeList,
} from '@octopus-diff/git-core';

const { values: args, positionals } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  allowPositionals: true,
  options: {
    'scan-root': { type: 'string', multiple: true },
    depth: { type: 'string', default: '3' },
    repeat: { type: 'string', default: '3' },
    max: { type: 'string', default: '40' },
    json: { type: 'string' },
    redact: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (args.help || (positionals.length === 0 && !args['scan-root']?.length)) {
  process.stderr.write(
    'usage: profile:real <repo>... | --scan-root <dir> [--depth 3] [--repeat 3] [--max 40] [--redact] [--json <file>]\n',
  );
  process.exit(args.help ? 0 : 1);
}

const REPEAT = Math.max(1, Number(args.repeat));
const MAX = Math.max(1, Number(args.max));
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.pnpm-store', 'target', 'dist']);

const git = new GitRunner({ concurrency: 1, timeoutMs: 300_000 });
const log = (m: string) => process.stderr.write(`[real] ${sanitize(m)}\n`);

const expand = (p: string) => resolve(p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

/** Every path whose contents the profiler must never overwrite (worktrees, git dirs, common dirs). */
const protectedRoots = new Set<string>();

/**
 * With `--redact` nothing that names a path or a branch may leave the process: logs, the table and the
 * JSON all go through this. Known paths turn into repo-N / worktree-M; any other absolute path
 * (inside an error message, say) becomes `<path>`.
 */
const labels = new Map<string, string>();
function sanitize(text: string): string {
  if (!args.redact) return text;
  let out = text;
  for (const [path, label] of [...labels].sort((a, b) => b[0].length - a[0].length)) {
    out = out.split(path).join(label);
  }
  return out
    .split(homedir())
    .join('~')
    .replace(/(^|[\s'"(=])(?:\/[^\s:'"`,;()]+)+/g, '$1<path>');
}

async function findRepos(root: string, depth: number, out: string[]): Promise<void> {
  if (out.length >= MAX * 4) return;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  if (entries.some((e) => e.name === '.git')) {
    out.push(root);
    return; // do not descend into a repository (nested repos are other projects; list them yourself)
  }
  if (depth <= 0) return;
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink() || SKIP_DIRS.has(e.name)) continue;
    await findRepos(join(root, e.name), depth - 1, out);
  }
}

async function out(cwd: string, sub: string[]): Promise<string | null> {
  try {
    return (await git.run(sub, { cwd })).stdout.toString('utf8');
  } catch {
    return null;
  }
}

async function timed(cwd: string, sub: string[], repeat = 1) {
  let best = Number.POSITIVE_INFINITY;
  let last: Buffer = Buffer.alloc(0);
  let failed: string | null = null;
  for (let i = 0; i < repeat; i++) {
    const started = performance.now();
    try {
      last = (await git.run(sub, { cwd })).stdout;
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error);
      break;
    }
    best = Math.min(best, performance.now() - started);
  }
  return { ms: failed ? null : Math.round(best * 10) / 10, stdout: last, failed };
}

const count = (buffer: Buffer) => {
  let n = 0;
  for (const byte of buffer) if (byte === 0) n++;
  return n;
};

/** Reads a config value the way the user's own git does: the pins the runner passes with -c (scope `command`) are ignored. */
async function configValue(cwd: string, key: string): Promise<string | null> {
  const text = await out(cwd, ['config', '--show-scope', '--get-all', key]);
  if (!text) return null;
  const values = text
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([scope]) => scope !== 'command')
    .map(([, ...value]) => value.join('\t').trim());
  return values.length ? (values[values.length - 1] ?? null) : null;
}

async function indexStamp(gitDir: string | null) {
  if (!gitDir) return null;
  const s = await stat(join(gitDir, 'index')).catch(() => null);
  return s ? `${s.size}:${s.mtimeMs}:${s.ino}` : null;
}

interface WorktreeProfile {
  path: string;
  isMain: boolean;
  branch: string | null;
  trackedFiles: number | null;
  lsFilesMs: number | null;
  statusMs: number | null;
  statusAllMs: number | null;
  statusEntries: number | null;
  untrackedFiles: number | null;
  diffNumstatMs: number | null;
  diffFiles: number | null;
  statusMsPer10kTracked: number | null;
  probableStaleIndex: boolean;
  indexUntouched: boolean | null;
  config: Record<string, string | null>;
  error: string | null;
}

const CONFIG_KEYS = [
  'core.untrackedCache',
  'core.fsmonitor',
  'core.splitIndex',
  'feature.manyFiles',
  'index.version',
];

async function profileWorktree(path: string, isMain: boolean, branch: string | null) {
  const gitDir = (await out(path, ['rev-parse', '--absolute-git-dir']))?.trim() ?? null;
  protectedRoots.add(path);
  if (gitDir) protectedRoots.add(gitDir);
  const before = await indexStamp(gitDir);
  const profile: WorktreeProfile = {
    path,
    isMain,
    branch,
    trackedFiles: null,
    lsFilesMs: null,
    statusMs: null,
    statusAllMs: null,
    statusEntries: null,
    untrackedFiles: null,
    diffNumstatMs: null,
    diffFiles: null,
    statusMsPer10kTracked: null,
    probableStaleIndex: false,
    indexUntouched: null,
    config: {},
    error: null,
  };
  const ls = await timed(path, ['ls-files', '-z']);
  profile.lsFilesMs = ls.ms;
  profile.trackedFiles = ls.failed ? null : count(ls.stdout);
  // The runner pins status.showUntrackedFiles=all, so the mode is chosen explicitly on the command line:
  // `normal` is what a plain `git status` does by default, `all` lists every untracked file.
  const status = await timed(
    path,
    ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal'],
    REPEAT,
  );
  profile.statusMs = status.ms;
  let parseError: string | null = null;
  try {
    profile.statusEntries = status.failed
      ? null
      : parseStatusV2(status.stdout.toString('utf8')).entries.length;
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  const statusAll = await timed(
    path,
    ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'],
    1,
  );
  profile.statusAllMs = statusAll.ms;
  if (!statusAll.failed) {
    try {
      profile.untrackedFiles = parseStatusV2(statusAll.stdout.toString('utf8')).entries.filter(
        (entry) => entry.kind === 'untracked',
      ).length;
    } catch (error) {
      parseError ??= error instanceof Error ? error.message : String(error);
    }
  }
  const diff = await timed(path, ['diff', '--raw', '--numstat', '-z', 'HEAD']);
  profile.diffNumstatMs = diff.ms;
  try {
    profile.diffFiles = diff.failed
      ? null
      : parseRawNumstat(diff.stdout.toString('utf8')).raw.length;
  } catch (error) {
    parseError ??= error instanceof Error ? error.message : String(error);
  }
  profile.error = sanitizeError(
    ls.failed ?? status.failed ?? statusAll.failed ?? diff.failed ?? parseError ?? null,
  );
  if (profile.statusMs !== null && profile.trackedFiles) {
    profile.statusMsPer10kTracked =
      Math.round((profile.statusMs / (profile.trackedFiles / 10_000)) * 10) / 10;
  }
  for (const key of CONFIG_KEYS) {
    profile.config[key] = await configValue(path, key);
  }
  const after = await indexStamp(gitDir);
  profile.indexUntouched = before === null ? null : before === after;
  return profile;
}

const sanitizeError = (text: string | null) => (text === null ? null : sanitize(text));

interface RepoProfile {
  path: string;
  commonDir: string;
  worktrees: WorktreeProfile[];
}

function flagStale(repo: RepoProfile) {
  // Same repository, same tracked files: a worktree whose status costs over twice the fastest
  // sibling's (and is slow enough to matter) is the stale-index pattern from #24.
  // Lots of untracked files also make status slow, so a sibling with far more of them is excused.
  const measured = repo.worktrees.filter((w) => w.statusMs !== null);
  if (measured.length < 2) return;
  const fastest = measured.reduce((a, b) => ((a.statusMs ?? 0) <= (b.statusMs ?? 0) ? a : b));
  const untrackedBudget = (fastest.untrackedFiles ?? 0) * 1.5 + 100;
  for (const w of repo.worktrees) {
    w.probableStaleIndex =
      w !== fastest &&
      (w.statusMs ?? 0) > 2 * (fastest.statusMs ?? 0) &&
      (w.statusMs ?? 0) > 150 &&
      (w.untrackedFiles ?? 0) <= untrackedBudget;
  }
}

/**
 * The path a file would really be written to. Symlinks are followed even when they dangle (a link to
 * a file that does not exist yet still creates it at the link's target), and the deepest existing
 * ancestor is resolved with `realpath`.
 */
async function realTarget(path: string): Promise<string> {
  let current = resolve(path);
  for (let hops = 0; hops < 40; hops++) {
    const info = await lstat(current).catch(() => null);
    if (!info?.isSymbolicLink()) break;
    current = resolve(dirname(current), await readlink(current));
  }
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      rest.push(basename(current));
      current = parent;
    }
  }
}

async function main() {
  const candidates: string[] = positionals.map(expand);
  for (const root of args['scan-root'] ?? []) {
    await findRepos(expand(root), Number(args.depth), candidates);
  }
  const seen = new Set<string>();
  const repos: RepoProfile[] = [];
  for (const candidate of candidates) {
    if (repos.length >= MAX) break;
    if (!existsSync(candidate)) {
      log(`skip ${args.redact ? 'a path' : candidate}: not found`);
      continue;
    }
    const common = (
      await out(candidate, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    )?.trim();
    if (!common || seen.has(common)) continue;
    seen.add(common);
    const ri = repos.length;
    labels.set(candidate, `repo-${ri + 1}`);
    labels.set(common, `repo-${ri + 1}`);
    protectedRoots.add(common);
    const list = await out(candidate, ['worktree', 'list', '--porcelain', '-z']);
    const records = list ? parseWorktreeList(list, true) : [];
    const worktrees = records.filter((r) => !r.bare);
    if (worktrees.length === 0)
      worktrees.push({ path: candidate, branch: null } as (typeof records)[number]);
    for (const [wi, w] of worktrees.entries()) {
      if (!labels.has(w.path)) labels.set(w.path, `repo-${ri + 1}/worktree-${wi + 1}`);
    }
    log(`${candidate}: ${worktrees.length} worktree(s)`);
    const profiled: WorktreeProfile[] = [];
    for (const [index, w] of worktrees.entries()) {
      profiled.push(
        await profileWorktree(w.path, index === 0, w.branch?.replace(/^refs\/heads\//, '') ?? null),
      );
    }
    const repo = { path: candidate, commonDir: common, worktrees: profiled };
    flagStale(repo);
    repos.push(repo);
  }
  // The output file must not land inside anything that was profiled: not a repository, not a linked
  // worktree elsewhere on disk, not a git directory. Symlinks are resolved on both sides.
  let jsonTarget: string | null = null;
  if (args.json) {
    jsonTarget = await realTarget(args.json);
    for (const root of protectedRoots) {
      for (const candidate of [root, root.replace(/\/\.git\/?$/, '')]) {
        const real = await realpath(candidate).catch(() => candidate);
        if (jsonTarget === real || jsonTarget.startsWith(real + sep)) {
          throw new Error(
            `--json must not be inside a profiled repository, worktree or git directory (${real})`,
          );
        }
      }
    }
  }
  const redact = args.redact;
  const nameOf = (repo: RepoProfile, ri: number) => (redact ? `repo-${ri + 1}` : repo.path);
  const wtName = (w: WorktreeProfile, wi: number) =>
    redact ? `worktree-${wi + 1}` : basename(w.path);
  const fmt = (v: number | null, unit = '') => (v === null ? 'n/a' : `${v}${unit}`);
  const lines = [
    '# Real-repository profile (read-only)',
    '',
    `${repos.length} repositories, ${repos.reduce((n, r) => n + r.worktrees.length, 0)} worktrees; best of ${REPEAT} for default \`status\`. \`.git/index\` untouched in every worktree: ${repos.every((r) => r.worktrees.every((w) => w.indexUntouched !== false)) ? 'yes' : '**NO, investigate**'}.`,
    '',
    '| Repository / worktree | Tracked | ls-files | status | status -uall | Untracked | diff HEAD | status per 10k tracked | Flags |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [ri, repo] of repos.entries()) {
    for (const [wi, w] of repo.worktrees.entries()) {
      const flags = [
        w.probableStaleIndex ? 'probable stale index' : '',
        w.config['core.untrackedCache'] === 'true' ? '' : 'no untrackedCache',
        w.config['core.fsmonitor'] && w.config['core.fsmonitor'] !== 'false' ? 'fsmonitor' : '',
        w.error ? `error: ${sanitize(w.error).slice(0, 60)}` : '',
      ].filter(Boolean);
      lines.push(
        `| ${nameOf(repo, ri)} / ${wtName(w, wi)} | ${fmt(w.trackedFiles)} | ${fmt(w.lsFilesMs, ' ms')} | ${fmt(w.statusMs, ' ms')} | ${fmt(w.statusAllMs, ' ms')} | ${fmt(w.untrackedFiles)} | ${fmt(w.diffNumstatMs, ' ms')} | ${fmt(w.statusMsPer10kTracked, ' ms')} | ${flags.join(', ')} |`,
      );
    }
  }
  const all = repos.flatMap((r) => r.worktrees);
  const slow = [...all].sort((a, b) => (b.statusMs ?? 0) - (a.statusMs ?? 0)).slice(0, 3);
  lines.push(
    '',
    `Slowest default \`status\`: ${slow.map((w) => `${fmt(w.statusMs, ' ms')} (${fmt(w.trackedFiles)} tracked)`).join(', ')}.`,
  );
  process.stdout.write(`${lines.join('\n')}\n`);
  if (args.json) {
    const payload = redact
      ? repos.map((r, ri) => ({
          ...r,
          path: nameOf(r, ri),
          commonDir: nameOf(r, ri),
          worktrees: r.worktrees.map((w, wi) => ({ ...w, path: wtName(w, wi), branch: null })),
        }))
      : repos;
    await writeFile(
      jsonTarget ?? resolve(args.json),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), repos: payload }, null, 2)}\n`,
    );
    log(args.redact ? 'wrote the JSON file' : `wrote ${jsonTarget}`);
  }
  await git.dispose();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[real] FAILED: ${sanitize(error instanceof Error ? error.message : String(error))}\n`,
  );
  process.exitCode = 1;
});
