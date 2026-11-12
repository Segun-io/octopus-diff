import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  AbsolutePathSchema,
  GitCoreError,
  type GitVersion,
  isGitCoreError,
  type Logger,
} from '@octopus-diff/contracts';
import { LruCache, readFileHead, realpathOrSelf } from './fs-utils.js';
import { Flight, shared } from './runner/call-context.js';
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
   * Config scan (filter-driver overrides, attributes file), read at most once per GitCore
   * operation (`repo()` returns a fresh object per call). Across operations it is reused only
   * while every config file's stat signature is unchanged (`GitContext.configScan`).
   */
  configScan?: Promise<ConfigScan>;
}

/** What git-core reads from a repository's config once per operation. */
export interface ConfigScan {
  /** Filter-driver neutralization entries (see `GitContext.filterOverrides`). */
  overrides: Array<[string, string]>;
  /** Values of `core.attributesFile` in any config scope (last one wins), raw. */
  attributesFiles: string[];
}

interface ConfigReadRun {
  /** `performance.now()` when its git process started; null while it waits for a slot. */
  spawnedAt: number | null;
  flight: Flight<unknown>;
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
/**
 * A config scan is reused across operations for at most this long, even when no config file we
 * know of changed: git may read a system file in a place git-core does not stat (a packager's
 * prefix). Those are trusted scopes, so this only bounds how long a changed trusted value can be
 * missed; untrusted (repository) files are always in the signature.
 */
const CONFIG_SCAN_TTL_MS = 60_000;
/**
 * A config file changed this recently (or stamped in the future) is not cached: on a file system
 * with coarse timestamps a second write within the same tick would keep the same signature
 * (git's "racy" problem). Two seconds covers FAT's 2 s mtime resolution.
 */
const CONFIG_RACY_NS = 2_000_000_000n;
const CONFIG_SCAN_CACHE_MAX = 512;
/** Keys whose presence means config depends on more than the files we stat (`include*`). */
const INCLUDE_KEY = /^include(if)?\./;
const CONFIG_SCAN_REGEX = '^filter\\.|^core\\.attributesfile$|^include\\.|^includeif\\.';
const IMMUTABLE_CACHE_MAX = 20_000;
const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process|required)$/;
const TRUSTED_SCOPES = new Set(['system', 'global', 'command']);

/** Shared state for one GitCore instance: runner, settings, version gate and caches. */
export class GitContext {
  private versionPromise: Promise<GitVersion> | null = null;
  private readonly repos = new Map<string, CachedRepo>();
  private readonly resolving = new Map<string, Flight<RepoInfo>>();
  /**
   * Config reads (the scan, #29; the remote config, #74) by
   * `<kind>\0<commonDir>\0<signatures of every config file git reads>`.
   */
  private readonly configReads = new LruCache<string, { at: number; value: unknown }>(
    CONFIG_SCAN_CACHE_MAX,
  );
  /** Config reads in flight, by the same key (`cachedConfigRead`). */
  private readonly configReadRuns = new Map<string, ConfigReadRun>();
  /**
   * Results that cannot change for a given key: facts about commits, keyed by the common dir
   * and the commit ids (`merge-base`, ancestry, ahead/behind, review ranges). Objects are
   * immutable; only positive results are stored (a commit that is missing now may be fetched).
   */
  private readonly immutable = new LruCache<string, unknown>(IMMUTABLE_CACHE_MAX);
  private readonly immutableRuns = new Map<string, Flight<unknown>>();
  /** Branch refs checked out in a project's worktrees, from the last `worktree list` (#29). */
  private readonly checkedOut = new Map<string, readonly string[]>();

  constructor(
    readonly runner: GitRunner,
    readonly settings: Settings,
  ) {}

  /** `git --version`, parsed and cached. */
  version(): Promise<GitVersion> {
    if (!this.versionPromise) {
      // Shared by every call (#44: not cancelled by the one that happened to start it).
      this.versionPromise = shared(() => this.runner.version()).then((raw) => {
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

  /** Resolves the repository for a worktree root or bare git dir (cached, single-flight). */
  async repo(cwd: string): Promise<RepoInfo> {
    assertAbsolute(cwd);
    const cached = this.repos.get(cwd);
    if (cached && Date.now() - cached.at < REPO_TTL_MS) return { ...cached.info };
    let run = this.resolving.get(cwd);
    if (!run) {
      // Single-flight: cancelled only when every call waiting for it aborted (#44).
      const flight: Flight<RepoInfo> = new Flight(
        () =>
          this.resolveRepo(cwd).then((info) => {
            this.repos.set(cwd, { info, at: Date.now() });
            return info;
          }),
        () => {
          if (this.resolving.get(cwd) === flight) this.resolving.delete(cwd);
        },
      );
      run = flight;
      this.resolving.set(cwd, flight);
      void flight.settled.then(() => {
        if (this.resolving.get(cwd) === flight) this.resolving.delete(cwd);
      });
    }
    return { ...(await run.join()) };
  }

  forgetRepo(cwd: string): void {
    this.repos.delete(cwd);
  }

  /** Records what git's discovery found for `cwd` (from `resolveProject`). */
  seedRepo(cwd: string, info: RepoInfo): void {
    const { configScan: _scan, ...plain } = info;
    this.repos.set(cwd, { info: plain, at: Date.now() });
  }

  /**
   * Records the project-level repository (`repo(commonDir)`: the common dir as a git dir, no
   * work tree) from a repository git just discovered, unless the common dir holds a `.git`
   * entry of its own (then git's discovery from it could find something else).
   */
  async seedProjectRepo(found: RepoInfo): Promise<void> {
    const { commonDir } = found;
    if ((await dotGitTarget(commonDir)) !== null) return;
    this.seedRepo(commonDir, {
      cwd: commonDir,
      toplevel: null,
      gitDir: commonDir,
      commonDir,
      bare: true,
      objectFormat: found.objectFormat,
      emptyTree: found.emptyTree,
    });
  }

  /**
   * Records the repository of a worktree that `git worktree list` reported for `project`,
   * derived from files instead of a `rev-parse` per worktree (#29): `<path>/.git` refers to its
   * git dir, whose `commondir` file (linked worktrees) must lead back to the project's common
   * dir. Skipped (left to git's discovery) when anything differs, when the worktree is not
   * owned by this user (git's `safe.directory` check must stay git's decision), or on Windows.
   */
  async seedWorktreeRepo(worktreePath: string, project: RepoInfo): Promise<void> {
    const cached = this.repos.get(worktreePath);
    if (cached && Date.now() - cached.at < REPO_TTL_MS) return;
    const info = await deriveWorktreeRepo(worktreePath, project);
    if (info) this.repos.set(worktreePath, { info, at: Date.now() });
  }

  noteCheckedOutBranches(commonDir: string, refs: readonly string[]): void {
    this.checkedOut.set(commonDir, [...new Set(refs)].sort());
  }

  /** Branch refs checked out in the project's worktrees (as of the last listing). */
  checkedOutBranches(commonDir: string): readonly string[] {
    return this.checkedOut.get(commonDir) ?? [];
  }

  /**
   * Where a repository's visible history can change without any commit changing: the shallow
   * boundary (`shallow`, rewritten by `fetch --unshallow` / `--deepen`) and grafts. Facts that
   * depend on parents or reachability (parents, merge-base, ancestry, counts, review ranges)
   * carry this stamp in their cache key, so they are recomputed when it changes. Two `stat` calls,
   * no git process. (`refs/replace/` is not covered: it needs a ref listing; see DECISIONS #192.)
   */
  async historyStamp(repo: RepoInfo): Promise<string> {
    const stamp = (file: string): Promise<string> =>
      stat(path.join(repo.commonDir, file)).then(
        (info) => `${info.mtimeMs}:${info.size}`,
        () => '-',
      );
    return (await Promise.all([stamp('shallow'), stamp(path.join('info', 'grafts'))])).join('|');
  }

  /**
   * A cached result that can never change for `key` (see `immutable`), computed once and
   * single-flight. `compute` returning `undefined` means "unknown": nothing is stored.
   */
  async memo<T>(key: string, compute: () => Promise<T | undefined>): Promise<T | undefined> {
    const hit = this.immutable.get(key);
    if (hit !== undefined) return hit as T;
    const running = this.immutableRuns.get(key);
    if (running) return (await running.join()) as T | undefined;
    const run: Flight<unknown> = new Flight(
      () =>
        compute().then((value) => {
          if (value !== undefined) this.immutable.set(key, value);
          return value;
        }),
      () => {
        if (this.immutableRuns.get(key) === run) this.immutableRuns.delete(key);
      },
    );
    this.immutableRuns.set(key, run);
    // Dropped when the work settles or loses its last waiter (`onCancel`), not when this caller
    // stops waiting: other calls may still be joined to it, and a third must join them, not start
    // the same git work again.
    void run.settled.then(() => {
      if (this.immutableRuns.get(key) === run) this.immutableRuns.delete(key);
    });
    return (await run.join()) as T | undefined;
  }

  /** Stores an immutable fact found as a by-product (e.g. one row of a batched query). */
  remember(key: string, value: unknown): void {
    if (value !== undefined) this.immutable.set(key, value);
  }

  /** A stored immutable fact, if any. */
  recall<T>(key: string): T | undefined {
    return this.immutable.get(key) as T | undefined;
  }

  /** Drops every cache (dispose). */
  clearCaches(): void {
    this.repos.clear();
    this.configReads.clear();
    this.immutable.clear();
    this.checkedOut.clear();
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
   * `GIT_CONFIG_COUNT`, which overrides repository config. Read once per operation; reused
   * across operations only under the conditions of `configScan`.
   */
  async filterOverrides(repo: RepoInfo): Promise<Array<[string, string]>> {
    return (await this.configScan(repo)).overrides;
  }

  /**
   * The config read (one `git config --get-regexp`), at most once per operation. Repository
   * config is untrusted, so a scan is reused by a later operation (#29) only when:
   * - every config file git reads for this worktree has the same stat signature (size, mtime and
   *   ctime in ns, inode, mode, or "absent") as when the scan was read: system, global, the
   *   common dir's `config` and the worktree's `config.worktree`; the signatures are taken
   *   *before* git reads, so a write during the read changes them;
   * - none of those files changed in the last two seconds (or is stamped in the future);
   * - the scan saw no `include.*` / `includeIf.*` key in any scope: included files (and
   *   `onbranch:` / `gitdir:` conditions) are not covered by the signatures, so such a
   *   repository is re-read on every operation, as before;
   * - it is younger than `CONFIG_SCAN_TTL_MS`.
   * Any stat error other than "absent" means no reuse. Worktrees of one project share a scan
   * while their `config.worktree` files are absent (the usual case).
   */
  configScan(repo: RepoInfo): Promise<ConfigScan> {
    repo.configScan ??= this.cachedConfigRead(repo, 'scan', (onSpawn) =>
      this.readConfigScan(repo, onSpawn),
    );
    return repo.configScan;
  }

  /**
   * A config read through the cache of `configScan` (same signature, racy and include rules),
   * keyed by `kind`, reused for at most `ttlMs` (default `CONFIG_SCAN_TTL_MS`). `read` reports
   * whether the output had an `include*` key and must pass `onSpawn` to the runner.
   *
   * On top of reuse, an operation may join a read of the same key whose git process **started
   * after this operation asked** (or has not started yet: it waits for a free process slot),
   * whatever the signature says: git reads the config files after its process starts, so the
   * answer is at least as new as one this operation would have started itself. That keeps the
   * worktrees of a project that refresh together at one read while a config file is younger than
   * two seconds (`git remote add`, `push -u` or `git config` just before the daemon looked, #74)
   * or uses `include*`. Equal keys also mean the same files in the same state at the time of the
   * operation's own stat calls, so the joined read covers this worktree's files too.
   */
  async cachedConfigRead<T>(
    repo: RepoInfo,
    kind: string,
    read: (onSpawn: () => void) => Promise<{ value: T; includes: boolean }>,
    ttlMs = CONFIG_SCAN_TTL_MS,
  ): Promise<T> {
    const askedAt = performance.now();
    const signature = await this.configSignature(repo);
    if (signature === null) return (await read(() => {})).value;
    const key = `${kind}\u0000${repo.commonDir}\u0000${signature.text}`;
    if (!signature.racy) {
      const hit = this.configReads.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    }
    const running = this.configReadRuns.get(key);
    if (running) {
      // A joined read is used only when its output had no `include*` key: included files and
      // `gitdir:` / `onbranch:` conditions are not in the key, so with them another worktree (or
      // file) could resolve differently (a filter or fsmonitor enabled in one worktree only).
      // Such a read is not shared: this operation reads for itself.
      if (running.spawnedAt === null || running.spawnedAt > askedAt) {
        const shared = (await running.flight.join()) as { value: T; includes: boolean };
        if (!shared.includes) return shared.value;
      } else if (!signature.racy) {
        // Started before this operation asked, but its signatures (taken before git read) are this
        // operation's: nothing changed in between.
        const shared = (await running.flight.join()) as { value: T; includes: boolean };
        if (!shared.includes) return shared.value;
      }
    }
    const at = Date.now();
    // Other operations may join this read: it is cancelled only when all of them aborted (#44).
    // `onSpawn` may run synchronously, inside the `Flight` constructor (a free slot).
    const spawn = { at: null as number | null };
    const flight = new Flight(
      () =>
        read(() => {
          spawn.at = performance.now();
        }),
      () => {
        if (this.configReadRuns.get(key) === run) this.configReadRuns.delete(key);
      },
    );
    const run: ConfigReadRun = {
      get spawnedAt() {
        return spawn.at;
      },
      flight,
    };
    this.configReadRuns.set(key, run);
    void flight.settled.then(() => {
      if (this.configReadRuns.get(key) === run) this.configReadRuns.delete(key);
    });
    const { value, includes } = (await run.flight.join()) as { value: T; includes: boolean };
    if (!includes && !signature.racy) this.configReads.set(key, { at, value });
    return value;
  }

  /**
   * Files git reads config from for `repo` (see `configScan`), as `[label, path]`. The label of
   * the worktree's own `config.worktree` does not name its path, so worktrees of one project
   * that have none share a key.
   */
  private configFiles(repo: RepoInfo): Array<[string, string]> {
    const env = (name: string): string | undefined => this.runner.envValue(name) || undefined;
    const files: string[] = [];
    if (!/^(1|true|yes|on)$/i.test(env('GIT_CONFIG_NOSYSTEM') ?? '')) {
      const system = env('GIT_CONFIG_SYSTEM');
      if (system) files.push(system);
      else {
        files.push('/etc/gitconfig');
        try {
          files.push(
            path.join(path.dirname(path.dirname(this.runner.binary())), 'etc', 'gitconfig'),
          );
        } catch {
          // No resolvable binary: the run itself will fail.
        }
      }
    }
    const global = env('GIT_CONFIG_GLOBAL');
    if (global) files.push(global);
    else {
      const home = env('HOME');
      const xdg = env('XDG_CONFIG_HOME') ?? (home ? path.join(home, '.config') : undefined);
      if (xdg) files.push(path.join(xdg, 'git', 'config'));
      if (home) files.push(path.join(home, '.gitconfig'));
    }
    const labelled: Array<[string, string]> = files.map((file) => [file, file]);
    labelled.push([path.join(repo.commonDir, 'config'), path.join(repo.commonDir, 'config')]);
    labelled.push(['config.worktree', path.join(repo.gitDir, 'config.worktree')]);
    return labelled;
  }

  /**
   * Stat signatures of `configFiles`, or null when one cannot be stat'ed. `racy`: a file changed
   * in the last two seconds (or is stamped in the future), so equal signatures do not prove equal
   * content and the read must not be reused (only joined before it starts, `cachedConfigRead`).
   */
  private async configSignature(repo: RepoInfo): Promise<{ text: string; racy: boolean } | null> {
    const files = this.configFiles(repo);
    const now = BigInt(Date.now()) * 1_000_000n;
    let racy = false;
    const parts = await Promise.all(
      files.map(async ([label, file]): Promise<string | null> => {
        if (!path.isAbsolute(file)) return null;
        try {
          const st = await stat(file, { bigint: true });
          if (st.mtimeNs > now - CONFIG_RACY_NS || st.ctimeNs > now - CONFIG_RACY_NS) racy = true;
          return `${label}\u0000${st.size}:${st.mtimeNs}:${st.ctimeNs}:${st.ino}:${st.mode}`;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          return code === 'ENOENT' || code === 'ENOTDIR' ? `${label}\u0000-` : null;
        }
      }),
    );
    return parts.some((part) => part === null) ? null : { text: parts.join('\u0000'), racy };
  }

  private async readConfigScan(
    repo: RepoInfo,
    onSpawn: () => void,
  ): Promise<{ value: ConfigScan; includes: boolean }> {
    const result = await this.runner.run(
      ['config', '--null', '--show-scope', '--get-regexp', CONFIG_SCAN_REGEX],
      {
        cwd: repo.cwd,
        queueKey: repo.commonDir,
        okExitCodes: [0, 1],
        location: repoLocation(repo),
        onSpawn,
      },
    );
    const output = result.stdout.toString('utf8');
    const entries = computeFilterOverrides(output);
    if (entries.length > 0) {
      this.settings.logger.warn('neutralizing repository-local git filter drivers', {
        repo: repo.cwd,
        keys: entries.map(([key]) => key),
      });
    }
    const attributesFiles: string[] = [];
    let includes = false;
    const tokens = output.split('\u0000');
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const token = tokens[i + 1] as string;
      if (INCLUDE_KEY.test(token)) includes = true;
      if (token === 'core.attributesfile') attributesFiles.push('');
      else if (token.startsWith('core.attributesfile\n')) {
        attributesFiles.push(token.slice('core.attributesfile\n'.length));
      }
    }
    return { value: { overrides: entries, attributesFiles }, includes };
  }
}

/** See `GitContext.seedWorktreeRepo`. */
async function deriveWorktreeRepo(
  worktreePath: string,
  project: RepoInfo,
): Promise<RepoInfo | null> {
  if (typeof process.getuid !== 'function' || process.platform === 'win32') return null;
  const gitDir = await dotGitTarget(worktreePath);
  if (gitDir === null) return null;
  let commonDir = gitDir;
  if (gitDir !== project.commonDir) {
    const content = await readSmallFile(path.join(gitDir, 'commondir'));
    if (content === null) return null;
    const text = content.toString('utf8').replace(/[\r\n]+$/, '');
    if (text.length === 0 || text.includes('\n') || text.includes('\u0000')) return null;
    commonDir = await realpathOrSelf(path.resolve(gitDir, text));
  }
  if (commonDir !== project.commonDir) return null;
  const uid = process.getuid();
  try {
    const owners = await Promise.all(
      [worktreePath, path.join(worktreePath, '.git'), gitDir].map(
        async (p) => (await lstat(p)).uid,
      ),
    );
    if (owners.some((owner) => owner !== uid)) return null;
  } catch {
    return null;
  }
  return {
    cwd: worktreePath,
    toplevel: worktreePath,
    gitDir,
    commonDir,
    bare: false,
    objectFormat: project.objectFormat,
    emptyTree: project.emptyTree,
  };
}

/** `--git-dir` (always) and `--work-tree` (when the repository has one) for `repo`. */
export function repoLocation(repo: RepoInfo): GitLocation {
  return repo.toplevel === null
    ? { gitDir: repo.gitDir }
    : { gitDir: repo.gitDir, workTree: repo.toplevel };
}

const GITFILE_MAX_BYTES = 4096;

/** Reads at most `max` bytes of a small regular file; null if it cannot be read. */
export function readSmallFile(file: string, max = GITFILE_MAX_BYTES): Promise<Buffer | null> {
  return readFileHead(file, max);
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
