import { lstat, open, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  AbsolutePathSchema,
  GitCoreError,
  type GitVersion,
  isGitCoreError,
  type Logger,
} from '@octopus-diff/contracts';
import { realpathOrSelf } from './fs-utils.js';
import type { GitLocation, GitRunner, GitRunOptions, GitRunResult } from './runner/runner.js';
import { MIN_GIT_VERSION, parseGitVersion } from './version.js';

export interface Settings {
  timeoutMs: number;
  maxOutputBytes: number;
  maxPatchBytes: number;
  maxUntrackedFiles: number;
  /** Pinned `core.bigFileThreshold`: larger files are diffed (and listed) as binary. */
  bigFileThreshold: number;
  logger: Logger;
}

export type ObjectFormat = 'sha1' | 'sha256';

export const EMPTY_TREE: Readonly<Record<ObjectFormat, string>> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};

/** What git-core knows about the repository behind one worktree (or bare git dir). */
export interface RepoInfo {
  /** Directory git runs in: the worktree root, or the git dir of a bare repository. */
  cwd: string;
  /**
   * Realpath of the worktree root containing the resolved path; null outside a worktree. It is
   * the directory whose `.git` entry points at `gitDir` (found by git-core, not by git), and it
   * is passed to every git call as `--work-tree`, so `core.worktree` in repository config can
   * never redirect git to files outside it (SEC-06).
   */
  toplevel: string | null;
  /** This worktree's git dir (realpath). Passed to every git call as `--git-dir`. */
  gitDir: string;
  /** The common git dir (realpath). */
  commonDir: string;
  /** No usable work tree: a bare repository, or a path inside a git dir. */
  bare: boolean;
  objectFormat: ObjectFormat;
  emptyTree: string;
  /**
   * Filter-driver overrides, computed at most once per GitCore operation: `repo()` returns a
   * fresh object per call, so nothing is reused across operations (config may change).
   */
  filterOverrides?: Promise<Array<[string, string]>>;
}

interface CachedRepo {
  info: RepoInfo;
  at: number;
}

// Git dir, common dir, toplevel and object format of a path almost never change; a failing
// call with `not_a_repository` / `not_found` drops the entry (see `git()`). At 30 s nearly
// every refresh after a quiet period, and every 60 s worktree relist, paid one extra
// `rev-parse` spawn.
const REPO_TTL_MS = 5 * 60_000;
const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process|required)$/;
const TRUSTED_SCOPES = new Set(['system', 'global', 'command']);

/** Shared state for one GitCore instance: runner, settings, version gate and caches. */
export class GitContext {
  private versionPromise: Promise<GitVersion> | null = null;
  private readonly repos = new Map<string, CachedRepo>();

  constructor(
    readonly runner: GitRunner,
    readonly settings: Settings,
  ) {}

  /** `git --version`, parsed and cached. */
  version(): Promise<GitVersion> {
    if (!this.versionPromise) {
      this.versionPromise = this.runner.version().then((raw) => {
        const parsed = parseGitVersion(raw);
        if (!parsed) {
          throw new GitCoreError('git_unsupported', `cannot parse git version from "${raw}"`, {
            stderr: raw,
          });
        }
        return parsed;
      });
      this.versionPromise.catch(() => {
        this.versionPromise = null;
      });
    }
    return this.versionPromise;
  }

  /** Rejects with `git_unsupported` below MIN_GIT_VERSION. */
  async ensureSupported(): Promise<GitVersion> {
    const version = await this.version();
    if (!version.features.supported) {
      const min = `${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor}.${MIN_GIT_VERSION.patch}`;
      throw new GitCoreError(
        'git_unsupported',
        `git ${version.major}.${version.minor}.${version.patch} is too old; octopus-diff needs git >= ${min}`,
        { version: version.raw },
      );
    }
    return version;
  }

  /** Resolves the repository for a worktree root or bare git dir (cached). */
  async repo(cwd: string): Promise<RepoInfo> {
    assertAbsolute(cwd);
    const cached = this.repos.get(cwd);
    if (cached && Date.now() - cached.at < REPO_TTL_MS) return { ...cached.info };
    const info = await this.resolveRepo(cwd);
    this.repos.set(cwd, { info, at: Date.now() });
    return { ...info };
  }

  forgetRepo(cwd: string): void {
    this.repos.delete(cwd);
  }

  /**
   * Resolves git dir, common dir, bareness and object format for a directory inside a
   * repository. Rejects with `not_a_repository` / `not_found`.
   *
   * This is the only git call without a pinned location (it is the discovery). Git's own idea
   * of the work tree is not used: it honors `core.worktree`, which repository config (untrusted)
   * can point anywhere. The work tree is the nearest directory at or above `cwd` whose `.git`
   * entry (directory, symlink or gitfile) resolves to the git dir git found.
   */
  async resolveRepo(cwd: string): Promise<RepoInfo> {
    const result = await this.runner.run(
      [
        'rev-parse',
        '--path-format=absolute',
        '--git-dir',
        '--git-common-dir',
        '--is-bare-repository',
        '--show-object-format',
        '--is-inside-git-dir',
      ],
      { cwd },
    );
    const [gitDirOut = '', commonDirOut = '', bareOut = '', format = '', insideGitDir = ''] =
      result.stdout.toString('utf8').split('\n');
    if (!gitDirOut || !commonDirOut) {
      throw new GitCoreError('git_failed', 'git rev-parse returned no git dir', {
        cwd,
        args: result.args,
      });
    }
    const objectFormat: ObjectFormat = format.trim() === 'sha256' ? 'sha256' : 'sha1';
    const gitDir = await realpathOrSelf(path.resolve(cwd, gitDirOut));
    const commonDir = await realpathOrSelf(path.resolve(cwd, commonDirOut));
    const gitBare = bareOut.trim() === 'true';
    const toplevel =
      gitBare || insideGitDir.trim() === 'true' ? null : await findWorktreeRoot(cwd, gitDir);
    return {
      cwd: toplevel ?? cwd,
      toplevel,
      gitDir,
      commonDir,
      bare: gitBare || toplevel === null,
      objectFormat,
      emptyTree: EMPTY_TREE[objectFormat],
    };
  }

  /**
   * Runs git in a repository. Commands that may read worktree content (`status`, `diff`) get
   * the repository's filter-driver neutralization (see `filterOverrides`).
   */
  async git(
    repo: RepoInfo,
    args: readonly string[],
    options: Omit<GitRunOptions, 'cwd'> & { cwd?: string } = {},
  ): Promise<GitRunResult> {
    const needsOverrides = args[0] === 'status' || args[0] === 'diff';
    const configEnv = needsOverrides ? await this.filterOverrides(repo) : [];
    try {
      return await this.runner.run(args, {
        queueKey: repo.commonDir,
        ...options,
        cwd: options.cwd ?? repo.cwd,
        location: repoLocation(repo),
        configEnv: [...configEnv, ...(options.configEnv ?? [])],
      });
    } catch (error) {
      if (isGitCoreError(error, 'not_a_repository') || isGitCoreError(error, 'not_found')) {
        this.forgetRepo(repo.cwd);
      }
      throw error;
    }
  }

  /**
   * Filter drivers (`filter.<name>.clean/smudge/process`) run external programs when git reads
   * worktree files, and `.gitattributes` (committed content) decides which files use them. A
   * driver defined in repository-local config (`local`/`worktree` scope) is untrusted: it is
   * reset to the value from system/global config if there is one (so e.g. git-lfs keeps
   * working), else emptied and made non-required, which disables it. Entries are passed via
   * `GIT_CONFIG_COUNT`, which overrides repository config. Read once per operation, not
   * cached: config can include other files and depend on HEAD (`includeIf onbranch:`).
   */
  filterOverrides(repo: RepoInfo): Promise<Array<[string, string]>> {
    repo.filterOverrides ??= this.readFilterOverrides(repo);
    return repo.filterOverrides;
  }

  private async readFilterOverrides(repo: RepoInfo): Promise<Array<[string, string]>> {
    const result = await this.runner.run(
      ['config', '--null', '--show-scope', '--get-regexp', '^filter\\.'],
      {
        cwd: repo.cwd,
        queueKey: repo.commonDir,
        okExitCodes: [0, 1],
        location: repoLocation(repo),
      },
    );
    const entries = computeFilterOverrides(result.stdout.toString('utf8'));
    if (entries.length > 0) {
      this.settings.logger.warn('neutralizing repository-local git filter drivers', {
        repo: repo.cwd,
        keys: entries.map(([key]) => key),
      });
    }
    return entries;
  }
}

/** `--git-dir` (always) and `--work-tree` (when the repository has one) for `repo`. */
export function repoLocation(repo: RepoInfo): GitLocation {
  return repo.toplevel === null
    ? { gitDir: repo.gitDir }
    : { gitDir: repo.gitDir, workTree: repo.toplevel };
}

const GITFILE_MAX_BYTES = 4096;

/** Reads at most `max` bytes of a small file; null if it cannot be read. */
export async function readSmallFile(file: string, max = GITFILE_MAX_BYTES): Promise<Buffer | null> {
  try {
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(max);
      const { bytesRead } = await handle.read(buffer, 0, max, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * The git dir a `.git` entry in `dir` refers to, as a realpath: the directory itself (or a
 * symlink's target), or the target of a gitfile (`gitdir: <path>`, relative to `dir`, as git's
 * `read_gitfile` parses it). Null when there is no `.git` entry or it is not usable.
 */
export async function dotGitTarget(dir: string): Promise<string | null> {
  const entry = path.join(dir, '.git');
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(entry);
    if (info.isSymbolicLink()) info = await stat(entry);
  } catch {
    return null;
  }
  if (info.isDirectory()) return realpathOrSelf(entry);
  if (!info.isFile()) return null;
  const content = await readSmallFile(entry);
  if (content === null) return null;
  const text = content.toString('utf8');
  if (!text.startsWith('gitdir: ')) return null;
  const target = text.slice('gitdir: '.length).replace(/[\r\n]+$/, '');
  if (target.length === 0 || target.includes('\n') || target.includes('\u0000')) return null;
  return realpathOrSelf(path.resolve(dir, target));
}

/**
 * The nearest directory at or above `start` whose `.git` entry refers to `gitDir` (both
 * realpaths), i.e. the work tree root git's discovery found, without consulting repository
 * config. Null if there is none.
 */
export async function findWorktreeRoot(start: string, gitDir: string): Promise<string | null> {
  let dir = await realpathOrSelf(start);
  for (;;) {
    if ((await dotGitTarget(dir)) === gitDir) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Computes `[key, value]` overrides from `git config --null --show-scope --get-regexp ^filter\.`
 * output (`scope NUL key LF value NUL`, or `scope NUL key NUL` for valueless keys).
 */
export function computeFilterOverrides(output: string): Array<[string, string]> {
  const tokens = output.split('\u0000');
  const byKey = new Map<string, Array<{ scope: string; value: string }>>();
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const scope = tokens[i] as string;
    const entry = tokens[i + 1] as string;
    const newline = entry.indexOf('\n');
    const key = newline < 0 ? entry : entry.slice(0, newline);
    const value = newline < 0 ? '' : entry.slice(newline + 1);
    if (!FILTER_KEY.test(key)) continue;
    const list = byKey.get(key) ?? [];
    list.push({ scope, value });
    byKey.set(key, list);
  }

  const overrides: Array<[string, string]> = [];
  const disabledDrivers = new Set<string>();
  for (const [key, list] of byKey) {
    const match = FILTER_KEY.exec(key);
    if (!match || match[2] === 'required') continue;
    const effective = list[list.length - 1];
    if (!effective || TRUSTED_SCOPES.has(effective.scope)) continue;
    const trusted = list.filter((entry) => TRUSTED_SCOPES.has(entry.scope)).pop();
    if (trusted) {
      overrides.push([key, trusted.value]);
    } else {
      overrides.push([key, '']);
      disabledDrivers.add(match[1] as string);
    }
  }
  for (const driver of disabledDrivers) {
    overrides.push([`filter.${driver}.required`, 'false']);
  }
  return overrides;
}

export function assertAbsolute(value: string): void {
  if (!AbsolutePathSchema.safeParse(value).success || !path.isAbsolute(value)) {
    throw new GitCoreError('invalid_argument', `expected an absolute path: ${String(value)}`);
  }
}
