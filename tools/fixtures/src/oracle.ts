import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { FileStatus, InProgressOperation } from '@octopus-diff/contracts';
import { EMPTY_TREE_SHA1, type IsolatedGitEnv, READ_ONLY_GIT_ARGS, runGit } from './git.js';
import type {
  CommitFixture,
  ExpectedCounts,
  ExpectedFile,
  ExpectedStatusEntry,
} from './manifest.js';

/**
 * A git "oracle": computes expected per-scope file lists, statuses and counts by asking git
 * directly (read-only: `--no-optional-locks`, `GIT_OPTIONAL_LOCKS=0`), independently of
 * `@octopus-diff/git-core`. Used at generation time to fill the manifest, and by tests that
 * re-derive expectations after mutating a fixture.
 */

/** Contracts #8: first 16 hex chars of SHA-256 over the UTF-8 realpath. */
export function fixtureId(realPath: string): string {
  return createHash('sha256').update(realPath, 'utf8').digest('hex').slice(0, 16);
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** Raw path bytes → display path, plus base64 `rawPath` when the bytes are not valid UTF-8. */
export function decodePath(bytes: Buffer): { path: string; rawPath?: string } {
  try {
    return { path: strictUtf8.decode(bytes) };
  } catch {
    return { path: bytes.toString('utf8'), rawPath: bytes.toString('base64') };
  }
}

function splitNul(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) {
      parts.push(buffer.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buffer.length) parts.push(buffer.subarray(start));
  return parts;
}

/** Splits `count` space-separated fields off the front; the rest (may contain spaces) is last. */
function splitFields(record: Buffer, count: number): { fields: string[]; rest: Buffer } {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < record.length && fields.length < count; i++) {
    if (record[i] === 0x20) {
      fields.push(record.subarray(start, i).toString('latin1'));
      start = i + 1;
    }
  }
  return { fields, rest: record.subarray(start) };
}

export interface OracleOptions {
  env: IsolatedGitEnv;
}

function ro(options: OracleOptions, cwd: string) {
  return {
    cwd,
    env: options.env,
    extraEnv: { GIT_OPTIONAL_LOCKS: '0' },
  };
}

async function gitRo(
  options: OracleOptions,
  cwd: string,
  args: string[],
  allowFailure = false,
): Promise<{ stdout: Buffer; code: number }> {
  const result = await runGit([...READ_ONLY_GIT_ARGS, ...args], {
    ...ro(options, cwd),
    allowFailure,
  });
  return { stdout: result.stdout, code: result.code };
}

// ---------------------------------------------------------------------------------------------
// status --porcelain=v2
// ---------------------------------------------------------------------------------------------

export interface PorcelainStatus {
  oid: string | null;
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  entries: ExpectedStatusEntry[];
  /** Modes per path from the status records: [head, index, worktree]. */
  modes: Map<string, { head: string; index: string; worktree: string }>;
}

export function parsePorcelainV2(stdout: Buffer): PorcelainStatus {
  const parts = splitNul(stdout);
  const status: PorcelainStatus = {
    oid: null,
    head: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
    entries: [],
    modes: new Map(),
  };
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i] as Buffer;
    if (record.length === 0) continue;
    const type = String.fromCharCode(record[0] as number);
    if (type === '#') {
      const line = record.toString('utf8');
      const [, key, ...valueParts] = line.split(' ');
      const value = valueParts.join(' ');
      if (key === 'branch.oid') status.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') {
        status.detached = value === '(detached)';
        status.head = status.detached ? null : value;
      } else if (key === 'branch.upstream') status.upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          status.ahead = Number(match[1]);
          status.behind = Number(match[2]);
        }
      }
      continue;
    }
    if (type === '1') {
      const { fields, rest } = splitFields(record, 8);
      const xy = fields[1] ?? '..';
      status.entries.push({
        ...decodePath(rest),
        oldPath: null,
        kind: 'ordinary',
        x: xy.charAt(0),
        y: xy.charAt(1),
      });
      status.modes.set(decodePath(rest).path, {
        head: fields[3] ?? '000000',
        index: fields[4] ?? '000000',
        worktree: fields[5] ?? '000000',
      });
    } else if (type === '2') {
      const { fields, rest } = splitFields(record, 9);
      const xy = fields[1] ?? '..';
      const orig = parts[++i] ?? Buffer.alloc(0);
      status.entries.push({
        ...decodePath(rest),
        oldPath: decodePath(orig).path,
        kind: 'renamed',
        x: xy.charAt(0),
        y: xy.charAt(1),
      });
      status.modes.set(decodePath(rest).path, {
        head: fields[3] ?? '000000',
        index: fields[4] ?? '000000',
        worktree: fields[5] ?? '000000',
      });
    } else if (type === 'u') {
      const { fields, rest } = splitFields(record, 10);
      const xy = fields[1] ?? 'UU';
      status.entries.push({
        ...decodePath(rest),
        oldPath: null,
        kind: 'unmerged',
        x: xy.charAt(0),
        y: xy.charAt(1),
      });
    } else if (type === '?') {
      status.entries.push({
        ...decodePath(record.subarray(2)),
        oldPath: null,
        kind: 'untracked',
        x: '?',
        y: '?',
      });
    }
  }
  return status;
}

export function countsFromStatus(entries: readonly ExpectedStatusEntry[]): ExpectedCounts {
  const counts: ExpectedCounts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  for (const entry of entries) {
    if (entry.kind === 'untracked') counts.untracked++;
    else if (entry.kind === 'unmerged') counts.conflicted++;
    else {
      if (entry.x !== '.') counts.staged++;
      if (entry.y !== '.') counts.unstaged++;
    }
  }
  return counts;
}

export async function readStatus(options: OracleOptions, cwd: string): Promise<PorcelainStatus> {
  const { stdout } = await gitRo(options, cwd, [
    'status',
    '--porcelain=v2',
    '-z',
    '--branch',
    '--untracked-files=all',
  ]);
  return parsePorcelainV2(stdout);
}

// ---------------------------------------------------------------------------------------------
// diff --raw / --numstat
// ---------------------------------------------------------------------------------------------

const STATUS_LETTERS: Record<string, FileStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'conflicted',
};

interface RawRecord {
  path: string;
  rawPath?: string;
  oldPath: string | null;
  status: FileStatus;
  oldMode: string | null;
  newMode: string | null;
}

function nullMode(mode: string): string | null {
  return /^0+$/.test(mode) ? null : mode;
}

export function parseRawZ(stdout: Buffer): RawRecord[] {
  const parts = splitNul(stdout);
  const records: RawRecord[] = [];
  for (let i = 0; i < parts.length; i++) {
    const header = (parts[i] as Buffer).toString('latin1');
    if (!header.startsWith(':')) continue;
    const [oldMode = '000000', newMode = '000000', , , letterScore = 'M'] = header
      .slice(1)
      .split(' ');
    const letter = letterScore.charAt(0);
    if (letter === 'R' || letter === 'C') {
      const oldPath = decodePath(parts[++i] ?? Buffer.alloc(0)).path;
      const next = decodePath(parts[++i] ?? Buffer.alloc(0));
      records.push({
        ...next,
        oldPath,
        status: STATUS_LETTERS[letter] ?? 'modified',
        oldMode: nullMode(oldMode),
        newMode: nullMode(newMode),
      });
    } else {
      const next = decodePath(parts[++i] ?? Buffer.alloc(0));
      records.push({
        ...next,
        oldPath: null,
        status: STATUS_LETTERS[letter] ?? 'modified',
        oldMode: nullMode(oldMode),
        newMode: nullMode(newMode),
      });
    }
  }
  return records;
}

interface NumstatRecord {
  path: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export function parseNumstatZ(stdout: Buffer): NumstatRecord[] {
  const parts = splitNul(stdout);
  const records: NumstatRecord[] = [];
  for (let i = 0; i < parts.length; i++) {
    const text = (parts[i] as Buffer).toString('latin1');
    if (text === '') continue;
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(text);
    if (!match) continue;
    const binary = match[1] === '-' && match[2] === '-';
    let pathBytes: Buffer;
    if (match[3] === '') {
      // Rename/copy: `add\tdel\t\0old\0new\0`.
      i++;
      pathBytes = parts[++i] ?? Buffer.alloc(0);
    } else {
      const record = parts[i] as Buffer;
      const tab2 = record.indexOf(0x09, record.indexOf(0x09) + 1);
      pathBytes = record.subarray(tab2 + 1);
    }
    records.push({
      path: decodePath(pathBytes).path,
      additions: binary ? null : Number(match[1]),
      deletions: binary ? null : Number(match[2]),
      binary,
    });
  }
  return records;
}

/**
 * Plumbing only (`diff-index` / `diff-files` / `diff-tree`). Porcelain `git diff` against the
 * working tree refreshes and rewrites `.git/index` when it finds stat-dirty entries, *even with
 * `--no-optional-locks`* (verified on git 2.53; see docs/DECISIONS.md, WS4). Plumbing never writes
 * but lists stat-dirty, content-identical files in `--raw`; those are dropped below because they
 * have no `--numstat` line.
 */
async function diffFiles(
  options: OracleOptions,
  cwd: string,
  command: 'diff-index' | 'diff-files' | 'diff-tree',
  args: string[],
) {
  const common = [
    command,
    '--no-ext-diff',
    '--no-textconv',
    ...(command === 'diff-tree' ? ['-r'] : []),
  ];
  const [raw, numstat] = await Promise.all([
    gitRo(options, cwd, [...common, '--raw', '-z', ...args]),
    gitRo(options, cwd, [...common, '--numstat', '-z', ...args]),
  ]);
  const counts = new Map(parseNumstatZ(numstat.stdout).map((r) => [r.path, r]));
  const seen = new Set<string>();
  const files: ExpectedFile[] = [];
  for (const record of parseRawZ(raw.stdout)) {
    if (seen.has(record.path)) continue;
    seen.add(record.path);
    const stat = counts.get(record.path);
    const statDirtyOnly =
      record.status === 'modified' && record.oldMode === record.newMode && stat === undefined;
    if (statDirtyOnly) continue;
    const binary = stat?.binary ?? false;
    files.push({
      path: record.path,
      ...(record.rawPath ? { rawPath: record.rawPath } : {}),
      oldPath: record.oldPath,
      status: record.status,
      binary,
      additions: stat ? stat.additions : null,
      deletions: stat ? stat.deletions : null,
      oldMode: record.oldMode,
      newMode: record.newMode,
    });
  }
  return files;
}

/** Line counts git would report for an untracked file (`diff --no-index` semantics). */
export async function untrackedFileStats(
  absolutePath: Buffer | string,
): Promise<{ binary: boolean; additions: number | null }> {
  const content = await readFile(absolutePath);
  const head = content.subarray(0, 8000);
  if (head.includes(0)) return { binary: true, additions: null };
  if (content.length === 0) return { binary: false, additions: 0 };
  let lines = 0;
  for (const byte of content) if (byte === 0x0a) lines++;
  if (content[content.length - 1] !== 0x0a) lines++;
  return { binary: false, additions: lines };
}

export type OracleScope =
  | { kind: 'working' }
  | { kind: 'staged' }
  | { kind: 'unstaged' }
  | { kind: 'branch'; base: string }
  | { kind: 'commit'; sha: string };

/** Expected files for one scope of the worktree at `cwd`, straight from git. */
export async function scopeFiles(
  options: OracleOptions,
  cwd: string,
  scope: OracleScope,
  status?: PorcelainStatus,
): Promise<ExpectedFile[]> {
  const st = status ?? (await readStatus(options, cwd));
  const base = st.oid ?? EMPTY_TREE_SHA1;
  const renames = ['-M'];
  switch (scope.kind) {
    case 'staged':
      return diffFiles(options, cwd, 'diff-index', ['--cached', ...renames, base, '--']);
    case 'unstaged':
      return diffFiles(options, cwd, 'diff-files', ['--']);
    case 'branch': {
      const mergeBase = await gitRo(options, cwd, ['merge-base', 'HEAD', scope.base], true);
      if (mergeBase.code !== 0) return [];
      const mb = mergeBase.stdout.toString('utf8').trim();
      return diffFiles(options, cwd, 'diff-tree', [...renames, mb, 'HEAD', '--']);
    }
    case 'commit':
      return commitFiles(options, cwd, scope.sha);
    default: {
      const tracked = await diffFiles(options, cwd, 'diff-index', [...renames, base, '--']);
      const unmerged = new Set(st.entries.filter((e) => e.kind === 'unmerged').map((e) => e.path));
      const files = tracked.map((file) =>
        unmerged.has(file.path) ? { ...file, status: 'conflicted' as const } : file,
      );
      const known = new Set(files.map((f) => f.path));
      for (const entry of st.entries) {
        if (entry.kind === 'unmerged' && !known.has(entry.path)) {
          files.push({
            path: entry.path,
            oldPath: null,
            status: 'conflicted',
            binary: false,
            additions: null,
            deletions: null,
            oldMode: null,
            newMode: null,
          });
          known.add(entry.path);
        }
        if (entry.kind !== 'untracked') continue;
        const abs = entry.rawPath
          ? Buffer.concat([Buffer.from(`${cwd}/`), Buffer.from(entry.rawPath, 'base64')])
          : join(cwd, entry.path);
        const stats = await untrackedFileStats(abs);
        files.push({
          path: entry.path,
          ...(entry.rawPath ? { rawPath: entry.rawPath } : {}),
          oldPath: null,
          status: 'untracked',
          binary: stats.binary,
          additions: stats.additions,
          deletions: stats.binary ? null : 0,
          oldMode: null,
          newMode: '100644',
        });
      }
      return files;
    }
  }
}

export async function commitFiles(
  options: OracleOptions,
  cwd: string,
  sha: string,
): Promise<ExpectedFile[]> {
  const parents = await gitRo(options, cwd, ['rev-list', '--parents', '-n', '1', sha]);
  const ids = parents.stdout.toString('utf8').trim().split(' ');
  const parent = ids[1] ?? EMPTY_TREE_SHA1;
  return diffFiles(options, cwd, 'diff-tree', ['-M', parent, sha, '--']);
}

export async function listCommits(
  options: OracleOptions,
  cwd: string,
  limit = 20,
): Promise<CommitFixture[]> {
  const result = await gitRo(
    options,
    cwd,
    ['log', `-n${limit}`, '--format=%H%x1f%P%x1f%s%x1e', 'HEAD'],
    true,
  );
  if (result.code !== 0) return [];
  return result.stdout
    .toString('utf8')
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha = '', parents = '', subject = ''] = chunk.split('\x1f');
      return { sha, subject, parents: parents ? parents.split(' ') : [] };
    });
}

export async function aheadBehind(
  options: OracleOptions,
  cwd: string,
  ref: string,
): Promise<{ ahead: number; behind: number } | null> {
  const result = await gitRo(
    options,
    cwd,
    ['rev-list', '--left-right', '--count', `HEAD...${ref}`, '--'],
    true,
  );
  if (result.code !== 0) return null;
  const [ahead = '0', behind = '0'] = result.stdout.toString('utf8').trim().split(/\s+/);
  return { ahead: Number(ahead), behind: Number(behind) };
}

export async function absoluteGitDir(options: OracleOptions, cwd: string): Promise<string> {
  const result = await gitRo(options, cwd, ['rev-parse', '--absolute-git-dir']);
  return realpath(result.stdout.toString('utf8').trim());
}

export async function commonGitDir(options: OracleOptions, cwd: string): Promise<string> {
  const result = await gitRo(options, cwd, ['rev-parse', '--git-common-dir']);
  const value = result.stdout.toString('utf8').trim();
  return realpath(isAbsolute(value) ? value : resolve(cwd, value));
}

export function inProgressOperation(gitDir: string): InProgressOperation | null {
  if (existsSync(join(gitDir, 'rebase-merge'))) return 'rebase';
  if (existsSync(join(gitDir, 'rebase-apply', 'applying'))) return 'am';
  if (existsSync(join(gitDir, 'rebase-apply'))) return 'rebase';
  if (existsSync(join(gitDir, 'MERGE_HEAD'))) return 'merge';
  if (existsSync(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  if (existsSync(join(gitDir, 'REVERT_HEAD'))) return 'revert';
  if (existsSync(join(gitDir, 'BISECT_LOG'))) return 'bisect';
  return null;
}

export interface PorcelainWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export function parseWorktreeListZ(stdout: Buffer): PorcelainWorktree[] {
  const worktrees: PorcelainWorktree[] = [];
  let current: PorcelainWorktree | null = null;
  for (const part of splitNul(stdout)) {
    const line = part.toString('utf8');
    if (line === '') {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = {
        path: line.slice('worktree '.length),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
    } else if (current) {
      if (line.startsWith('HEAD ')) {
        const sha = line.slice(5);
        current.head = /^0+$/.test(sha) ? null : sha;
      } else if (line.startsWith('branch '))
        current.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === 'detached') current.detached = true;
      else if (line === 'bare') current.bare = true;
      else if (line === 'locked' || line.startsWith('locked ')) current.locked = true;
      else if (line === 'prunable' || line.startsWith('prunable ')) current.prunable = true;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

export async function listWorktrees(
  options: OracleOptions,
  cwd: string,
): Promise<PorcelainWorktree[]> {
  const { stdout } = await gitRo(options, cwd, ['worktree', 'list', '--porcelain', '-z']);
  return parseWorktreeListZ(stdout);
}
