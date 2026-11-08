import path from 'node:path';
import {
  AbsolutePathSchema,
  GitCoreError,
  type GitVersion,
  isGitCoreError,
  type Logger,
} from '@octopus-diff/contracts';
import { realpathOrSelf } from './fs-utils.js';
import type { GitRunner, GitRunOptions, GitRunResult } from './runner/runner.js';
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
  /** Realpath of the worktree root containing the resolved path; null outside a worktree. */
  toplevel: string | null;
  /** This worktree's git dir (realpath). */
  gitDir: string;
  /** The common git dir (realpath). */
  commonDir: string;
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
        '--is-inside-work-tree',
        '--show-prefix',
      ],
      { cwd },
    );
    const [gitDir = '', commonDir = '', bare = '', format = '', inside = '', prefix = ''] =
      result.stdout.toString('utf8').split('\n');
    if (!gitDir || !commonDir) {
      throw new GitCoreError('git_failed', 'git rev-parse returned no git dir', {
        cwd,
        args: result.args,
      });
    }
    const objectFormat: ObjectFormat = format.trim() === 'sha256' ? 'sha256' : 'sha1';
    let toplevel: string | null = null;
    if (inside.trim() === 'true') {
      // `--show-prefix` is the path from the worktree root to cwd, e.g. `src/lib/`.
      const depth = prefix.split('/').filter((segment) => segment.length > 0).length;
      toplevel = await realpathOrSelf(path.resolve(cwd, ...Array<string>(depth).fill('..')));
    }
    return {
      cwd: toplevel ?? cwd,
      toplevel,
      gitDir: await realpathOrSelf(path.resolve(cwd, gitDir)),
      commonDir: await realpathOrSelf(path.resolve(cwd, commonDir)),
      bare: bare.trim() === 'true',
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
      { cwd: repo.cwd, queueKey: repo.commonDir, okExitCodes: [0, 1] },
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
