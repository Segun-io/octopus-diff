import { constants } from 'node:fs';
import { access, lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type DiffOptions,
  type FileSelector,
  FileSelectorSchema,
  type FileStatus,
  type GitChangedFile,
  GitCoreError,
  type GitFileDiff,
  isGitCoreError,
  type ScopeOptions,
  type WorktreeLocator,
} from '@octopus-diff/contracts';
import {
  bstrFromBuffer,
  bstrToBuffer,
  bstrToUtf8,
  compareBstr,
  decodeRepoPath,
  isValidUtf8,
  selectorToBstr,
} from './bstr.js';
import type { GitContext, RepoInfo } from './context.js';
import { LruCache, mapLimit } from './fs-utils.js';
import { hashParts, PATCH_HASH_LENGTH, PatchHasher, STATE_HASH_LENGTH } from './hash.js';
import { imageComparison } from './images.js';
import {
  changedSince,
  keysInRegion,
  Region,
  readStamp,
  regionOfKeys,
  type SummaryTrack,
  stampChange,
  type TrackStore,
  trackBlocker,
} from './incremental.js';
import { DiffOutputParser, type NumstatEntry, type RawEntry } from './parse/diff-output.js';
import { type ChunkKind, PatchSplitter } from './parse/patch.js';
import { parseStatusV2, type StatusEntry, type StatusResult } from './parse/status.js';
import {
  CANONICAL_CONTEXT,
  DIFF_PINS,
  parseScope,
  planScope,
  resolveHead,
  type ScopePlan,
  unbornRevArgs,
} from './scope.js';
import {
  absolutePathBuffer,
  type DiffAttribute,
  type InspectOptions,
  inspectUntracked,
  type UntrackedCache,
  type UntrackedInfo,
  writeUntrackedPatch,
} from './untracked.js';

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

export const STATUS_ARGS: readonly string[] = [
  'status',
  '--porcelain=v2',
  '-z',
  '--branch',
  '--untracked-files=all',
  '--ignore-submodules=dirty',
  '--find-renames',
  '--ahead-behind',
  '--ignored=no',
];

export interface StatusSnapshot extends StatusResult {
  /** Raw stdout (bstr), hashed into stateHash. */
  output: string;
}

export async function readStatus(ctx: GitContext, repo: RepoInfo): Promise<StatusSnapshot> {
  const result = await ctx.git(repo, STATUS_ARGS);
  const output = bstrFromBuffer(result.stdout);
  return { ...parseStatusV2(output), output };
}

/** `size:mtimeNs:ctimeNs:ino:mode` of a worktree path (lstat), or `missing`. */
export async function lstatSignature(root: string, key: string): Promise<string> {
  try {
    const info = await lstat(absolutePathBuffer(root, key), { bigint: true });
    return `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}:${info.mode}`;
  } catch {
    return 'missing';
  }
}

// ---------------------------------------------------------------------------------------------
// Unreadable worktree files (F7)
// ---------------------------------------------------------------------------------------------

const REGULAR_MODES = new Set(['100644', '100755']);
const DENIED = new Set(['EACCES', 'EPERM']);
/** Total bytes of explicit pathspecs git-core passes as argv (Windows caps a command line). */
const PATHSPEC_BUDGET = process.platform === 'win32' ? 24_000 : 512_000;

/**
 * Tracked paths with worktree changes whose file exists but cannot be read. `git status`
 * tolerates them, but any `git diff` that reads the worktree exits 128 on them ("cannot hash"),
 * which would fail the whole worktree.
 */
export async function findUnreadable(
  root: string,
  entries: readonly StatusEntry[],
): Promise<Set<string>> {
  const candidates = entries.filter((entry) => {
    if (entry.kind === 'unmerged') return REGULAR_MODES.has(entry.modes[3]);
    if (entry.kind !== 'ordinary' && entry.kind !== 'renamed') return false;
    return entry.y !== '.' && entry.y !== 'D' && REGULAR_MODES.has(entry.modeWorktree);
  });
  const unreadable = new Set<string>();
  await mapLimit(candidates, 32, async (entry) => {
    try {
      await access(absolutePathBuffer(root, entry.path), constants.R_OK);
    } catch (error) {
      if (DENIED.has((error as NodeJS.ErrnoException).code ?? '')) unreadable.add(entry.path);
    }
  });
  return unreadable;
}

/**
 * Literal pathspecs for every path git status reports as changed (tracked entries and rename
 * sources), except `exclude` and the rename sources of excluded entries. Null when they cannot
 * be passed (a path that is not UTF-8, or too many bytes for a command line).
 */
export function pathspecsExcluding(
  entries: readonly StatusEntry[],
  exclude: ReadonlySet<string>,
): string[] | null {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'untracked' || entry.kind === 'ignored') continue;
    if (exclude.has(entry.path)) continue;
    paths.add(entry.path);
    if (entry.kind === 'renamed') paths.add(entry.origPath);
  }
  for (const entry of entries) {
    if (entry.kind === 'renamed' && exclude.has(entry.path)) paths.delete(entry.origPath);
  }
  const out: string[] = [];
  let bytes = 0;
  for (const key of paths) {
    if (!isValidUtf8(key)) return null;
    bytes += key.length + 1;
    if (bytes > PATHSPEC_BUDGET) return null;
    out.push(bstrToUtf8(key));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Patch collection
// ---------------------------------------------------------------------------------------------

export interface ChunkResult {
  kind: ChunkKind;
  hash: string;
  /** Total size of the chunk text in bytes. */
  bytes: number;
  /** Retained text (bstr), at most the retain limit (cut at a line boundary). */
  text: string;
  /** Retained text is shorter than the chunk. */
  cut: boolean;
}

interface ChunkState {
  kind: ChunkKind;
  hasher: PatchHasher;
  parts: string[];
  retained: number;
  retain: boolean;
}

/**
 * Hashes per-file chunks of a patch stream and retains the text of selected files. Several
 * chunks for the same path (typechange = deletion + creation) are concatenated.
 */
export class PatchCollector {
  private readonly states = new Map<string, ChunkState>();
  readonly splitter: PatchSplitter;

  constructor(
    private readonly options: {
      /** Only these keys are processed (null = all). */
      only?: ReadonlySet<string> | null;
      /** Keys whose text is retained. */
      retain?: ReadonlySet<string>;
      retainLimit?: number;
    } = {},
  ) {
    this.splitter = new PatchSplitter((info) => {
      if (!info) return null;
      if (this.options.only && !this.options.only.has(info.key)) return null;
      let state = this.states.get(info.key);
      if (!state) {
        state = {
          kind: info.kind,
          hasher: new PatchHasher('patch'),
          parts: [],
          retained: 0,
          retain: this.options.retain?.has(info.key) ?? false,
        };
        this.states.set(info.key, state);
      }
      const target = state;
      const limit = this.options.retainLimit ?? 0;
      return {
        write(data: string) {
          target.hasher.update(data);
          if (target.retain && target.retained <= limit) {
            const room = limit + 1 - target.retained;
            const piece = data.length > room ? data.slice(0, room) : data;
            target.parts.push(piece);
            target.retained += piece.length;
          }
        },
        end() {},
      };
    });
  }

  write(data: string): void {
    this.splitter.write(data);
  }

  end(): void {
    this.splitter.end();
  }

  results(): Map<string, ChunkResult> {
    const out = new Map<string, ChunkResult>();
    const limit = this.options.retainLimit ?? 0;
    for (const [key, state] of this.states) {
      const bytes = state.hasher.bytes;
      let text = state.parts.join('');
      if (text.length > limit) {
        // Cut at the limit, at a line boundary (never inside a line or a UTF-8 sequence).
        text = text.slice(0, limit);
        const newline = text.lastIndexOf('\n');
        text = newline >= 0 ? text.slice(0, newline + 1) : '';
      }
      out.set(key, {
        kind: state.kind,
        hash: state.hasher.digest(),
        bytes,
        text,
        cut: bytes > text.length,
      });
    }
    return out;
  }
}

interface DiffRun {
  raw: RawEntry[];
  numstat: NumstatEntry[];
  chunks: Map<string, ChunkResult>;
}

interface DiffRunOptions {
  /** Include `--raw --numstat -z` before the patch. */
  head: boolean;
  /** Include the patch (`-p`). */
  patch: boolean;
  /** `-U<n>` (default 3). */
  context?: number;
  ignoreWhitespace?: boolean;
  /** Literal pathspecs (null = whole scope). */
  pathspecs?: string[] | null;
  only?: ReadonlySet<string> | null;
  retain?: ReadonlySet<string>;
  retainLimit?: number;
  /** Override the plan's revision args. */
  revArgs?: string[];
}

function diffArgs(plan: ScopePlan, revArgs: readonly string[], options: DiffRunOptions): string[] {
  const args = ['diff', ...DIFF_PINS];
  if (plan.findCopies) args.push('--find-copies');
  if (options.head) args.push('--raw', '--numstat', '-z');
  if (options.patch) {
    args.push('-p', `-U${options.context ?? CANONICAL_CONTEXT}`);
    if (options.ignoreWhitespace) args.push('--ignore-all-space');
  }
  if (!options.head && !options.patch) args.push('--raw', '-z');
  args.push(...revArgs, '--', ...(options.pathspecs ?? []));
  return args;
}

async function runDiffOnce(
  ctx: GitContext,
  repo: RepoInfo,
  plan: ScopePlan,
  revArgs: readonly string[],
  options: DiffRunOptions,
): Promise<DiffRun> {
  const collector = options.patch
    ? new PatchCollector({
        only: options.only ?? null,
        retain: options.retain ?? new Set(),
        retainLimit: options.retainLimit ?? 0,
      })
    : null;
  const usesHead = options.head || !options.patch;
  const parser = usesHead ? new DiffOutputParser((data) => collector?.write(data)) : null;
  await ctx.git(repo, diffArgs(plan, revArgs, options), {
    onStdout: (chunk) => {
      const data = bstrFromBuffer(chunk);
      if (parser) parser.write(data);
      else collector?.write(data);
    },
  });
  parser?.end();
  collector?.end();
  return {
    raw: parser?.raw ?? [],
    numstat: parser?.numstat ?? [],
    chunks: collector?.results() ?? new Map(),
  };
}

/** Runs a scope's diff; on an unborn branch, retries with `HEAD` replaced by the empty tree. */
async function runScopeDiff(
  ctx: GitContext,
  repo: RepoInfo,
  plan: ScopePlan,
  options: DiffRunOptions,
): Promise<DiffRun> {
  const revArgs = options.revArgs ?? plan.revArgs;
  try {
    return await runDiffOnce(ctx, repo, plan, revArgs, options);
  } catch (error) {
    if (!plan.usesHead || options.revArgs || !isGitCoreError(error, 'git_failed')) throw error;
    if ((await resolveHead(ctx, repo)) !== null) throw error;
    return runDiffOnce(ctx, repo, plan, unbornRevArgs(plan, repo), options);
  }
}

// ---------------------------------------------------------------------------------------------
// Building file entries
// ---------------------------------------------------------------------------------------------

const NULL_MODE = /^0+$/;

function modeOrNull(mode: string): string | null {
  return NULL_MODE.test(mode) || !/^[0-7]{6}$/.test(mode) ? null : mode;
}

function mapStatus(letter: string): FileStatus {
  switch (letter) {
    case 'A':
      return 'added';
    case 'C':
      return 'copied';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'T':
      return 'typechange';
    case 'U':
      return 'conflicted';
    default:
      return 'modified';
  }
}

interface StatusIndex {
  tracked: Map<string, StatusEntry>;
  /** Rename sources (`2` entries' original paths): their removal is a staged change. */
  renameSources: Set<string>;
  conflicted: Set<string>;
  untracked: string[];
}

function indexStatus(status: StatusResult): StatusIndex {
  const tracked = new Map<string, StatusEntry>();
  const renameSources = new Set<string>();
  const conflicted = new Set<string>();
  const untracked: string[] = [];
  for (const entry of status.entries) {
    if (entry.kind === 'untracked') untracked.push(entry.path);
    else if (entry.kind === 'ignored') continue;
    else {
      tracked.set(entry.path, entry);
      if (entry.kind === 'renamed') renameSources.add(entry.origPath);
      if (entry.kind === 'unmerged') conflicted.add(entry.path);
    }
  }
  return { tracked, renameSources, conflicted, untracked };
}

function flagsFor(
  plan: ScopePlan,
  index: StatusIndex | null,
  key: string,
): { staged: boolean; unstaged: boolean } {
  const entry = index?.tracked.get(key);
  // A path git status reports only as a rename source (the diff paired it differently):
  // its removal from the index is staged.
  const renameSource = entry === undefined && (index?.renameSources.has(key) ?? false);
  const indexChanged =
    renameSource ||
    (entry !== undefined &&
      (entry.kind === 'ordinary' || entry.kind === 'renamed') &&
      entry.x !== '.');
  const worktreeChanged =
    entry !== undefined &&
    (entry.kind === 'unmerged' ||
      entry.kind === 'untracked' ||
      ((entry.kind === 'ordinary' || entry.kind === 'renamed') && entry.y !== '.'));
  // working, review, branch with includeWorking: flags relative to HEAD, from git status.
  if (plan.vsWorktree) return { staged: indexChanged, unstaged: worktreeChanged };
  switch (plan.kind) {
    case 'staged':
      return { staged: true, unstaged: worktreeChanged };
    case 'unstaged':
      return { staged: indexChanged, unstaged: true };
    default:
      return { staged: false, unstaged: false };
  }
}

/**
 * The raw entry for `key`. git can report an unmerged path twice (`U` plus a diff against
 * stage 2) depending on the output format; prefer a combined entry, then a non-`U` one.
 */
function pickEntry(entries: readonly RawEntry[], key: string): RawEntry | undefined {
  let first: RawEntry | undefined;
  let nonUnmerged: RawEntry | undefined;
  for (const entry of entries) {
    if (entry.path !== key) continue;
    if (entry.combined) return entry;
    first ??= entry;
    if (entry.status !== 'U') nonUnmerged ??= entry;
  }
  return nonUnmerged ?? first;
}

/**
 * With `diff.autoRefreshIndex=false`, a file whose stat data changed but whose content did not
 * is still reported in raw output (modified, same mode), but has no patch chunk (and no
 * numstat entry, or a binary one). Such entries are not changes and are dropped.
 */
function isStatOnly(
  entry: RawEntry,
  chunk: ChunkResult | undefined,
  numstat: NumstatEntry | undefined,
): boolean {
  if (entry.combined || entry.status !== 'M' || entry.srcMode !== entry.dstMode) return false;
  if (chunk !== undefined) return false;
  // Text files get no numstat entry; binary files still get `-\t-` (both counts null).
  return numstat === undefined || (numstat.added === null && numstat.deleted === null);
}

/** patchHash for a tracked entry without a patch chunk (e.g. a race, or an unmerged path). */
function fallbackPatchHash(entry: RawEntry): string {
  return hashParts(['nochunk', entry.meta, entry.srcPath, entry.path], PATCH_HASH_LENGTH);
}

type Identity = Omit<GitChangedFile, 'staged' | 'unstaged'>;

function trackedIdentity(
  entry: RawEntry,
  numstat: NumstatEntry | undefined,
  patchHash: string,
  conflicted: boolean,
): Identity {
  const decoded = decodeRepoPath(entry.path);
  const renamed = entry.status === 'R' || entry.status === 'C';
  const binary = numstat ? numstat.added === null || numstat.deleted === null : false;
  const identity: Identity = {
    path: decoded.path,
    oldPath: renamed ? decodeRepoPath(entry.srcPath).path : null,
    status: conflicted ? 'conflicted' : mapStatus(entry.status),
    binary,
    oldMode: modeOrNull(entry.srcMode),
    newMode: entry.status === 'D' ? null : modeOrNull(entry.dstMode),
    additions: numstat && !binary ? numstat.added : null,
    deletions: numstat && !binary ? numstat.deleted : null,
    patchHash,
  };
  if (decoded.rawPath !== undefined) identity.rawPath = decoded.rawPath;
  return identity;
}

function untrackedIdentity(info: UntrackedInfo): Identity {
  const decoded = decodeRepoPath(info.key);
  const identity: Identity = {
    path: decoded.path,
    oldPath: null,
    status: 'untracked',
    binary: info.binary,
    oldMode: null,
    newMode: info.mode,
    additions: info.lines,
    deletions: info.lines === null ? null : 0,
    patchHash: info.patchHash,
  };
  if (decoded.rawPath !== undefined) identity.rawPath = decoded.rawPath;
  return identity;
}

function readsWorktree(plan: ScopePlan): boolean {
  return plan.vsWorktree || plan.kind === 'unstaged';
}

/**
 * A changed tracked file whose worktree content cannot be read (F7), described from its
 * `git status` entry: no line counts, and a patchHash over the status entry (index and HEAD
 * object ids, modes) and the file's stat signature, so it changes whenever the file does.
 */
function unreadableIdentity(plan: ScopePlan, entry: StatusEntry, statSig: string): Identity {
  // Described relative to HEAD (git status) in every worktree-vs-commit scope.
  const working = plan.vsWorktree;
  let status: FileStatus = 'modified';
  let oldPath: string | null = null;
  let oldMode: string | null = null;
  let newMode: string | null = null;
  if (entry.kind === 'unmerged') {
    status = 'conflicted';
    oldMode = modeOrNull(entry.modes[1]);
    newMode = modeOrNull(entry.modes[3]);
  } else if (entry.kind === 'ordinary' || entry.kind === 'renamed') {
    oldMode = modeOrNull(working ? entry.modeHead : entry.modeIndex);
    newMode = modeOrNull(entry.modeWorktree);
    if (working && entry.kind === 'renamed') {
      status = entry.score.startsWith('C') ? 'copied' : 'renamed';
      oldPath = decodeRepoPath(entry.origPath).path;
    } else if (entry.y === 'A' || (working && entry.x === 'A')) status = 'added';
    else if (entry.y === 'T' || (working && entry.x === 'T')) status = 'typechange';
  }
  const decoded = decodeRepoPath(entry.path);
  const identity: Identity = {
    path: decoded.path,
    oldPath,
    status,
    binary: false,
    oldMode,
    newMode,
    additions: null,
    deletions: null,
    // Same hash as `working` when the scope diffs against HEAD; otherwise the base commit is
    // part of it (the status entry only describes the change relative to HEAD).
    patchHash: hashParts(
      working && plan.revArgs[0] !== 'HEAD'
        ? ['unreadable', 'working', entry.line, statSig, plan.revArgs.join(' ')]
        : ['unreadable', working ? 'working' : plan.kind, entry.line, statSig],
      PATCH_HASH_LENGTH,
    ),
  };
  if (decoded.rawPath !== undefined) identity.rawPath = decoded.rawPath;
  return identity;
}

/** Untracked paths in the scope: sorted, de-duplicated against tracked entries. */
function untrackedKeys(index: StatusIndex, trackedKeys: ReadonlySet<string>): string[] {
  const keys: string[] = [];
  for (const raw of index.untracked) {
    const key = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    if (!trackedKeys.has(key)) keys.push(raw);
  }
  return keys.sort(compareBstr);
}

/** Collects the combined (`diff --cc`) chunks of unmerged paths in the unstaged scope. */
async function collectCombinedChunks(
  ctx: GitContext,
  repo: RepoInfo,
  plan: ScopePlan,
  keys: readonly string[],
  extra: Partial<DiffRunOptions> = {},
): Promise<Map<string, ChunkResult>> {
  if (keys.length === 0) return new Map();
  const pathspecs = keys.every(isValidUtf8) ? keys.map(bstrToUtf8) : null;
  const run = await runScopeDiff(ctx, repo, plan, {
    head: false,
    patch: true,
    pathspecs,
    only: new Set(keys),
    ...extra,
  });
  return run.chunks;
}

export interface DiffDeps {
  ctx: GitContext;
  untrackedCache: UntrackedCache;
  attributeCache: AttributeCache;
  /** The last summary state per worktree (#40). */
  tracks: TrackStore;
  /** The last list per worktree and scope that reads the worktree (#40). */
  lists: ListCache;
  /** `GitCoreOptions.incremental` (default true). */
  incremental: boolean;
}

/**
 * Inspection options for the untracked files of one status snapshot. Contents are read only
 * when the worktree has at most `maxUntrackedFiles` untracked entries (all or none, so a
 * file's hash never depends on the other files), counted on git status' list.
 */
export function inspectOptions(
  ctx: GitContext,
  repo: RepoInfo,
  untrackedCount: number,
  diffAttributes?: ReadonlyMap<string, DiffAttribute>,
): InspectOptions {
  return {
    readContent: untrackedCount <= ctx.settings.maxUntrackedFiles,
    bigFileThreshold: ctx.settings.bigFileThreshold,
    executableBit: process.platform !== 'win32',
    objectFormat: repo.objectFormat,
    diffAttributes,
  };
}

/** `diff` attribute verdicts of one worktree, valid while its attribute sources are unchanged. */
interface AttributeCacheEntry {
  stateKey: string;
  verdicts: Map<string, DiffAttribute>;
}
export type AttributeCache = LruCache<string, AttributeCacheEntry>;

export function createAttributeCache(): AttributeCache {
  return new LruCache<string, AttributeCacheEntry>(1000);
}

/** Directories checked for `.gitattributes` before git-core stops trying to be clever. */
const MAX_ATTRIBUTE_DIRS = 1000;

async function sourceSignature(file: string | Buffer): Promise<string> {
  try {
    const info = await stat(file, { bigint: true });
    return `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}`;
  } catch {
    return 'none';
  }
}

interface AttributeState {
  /** False only when no attributes source exists: every verdict is `unspecified`. */
  mayApply: boolean;
  /** Changes whenever an attributes source changes; null when it cannot be computed. */
  stateKey: string | null;
}

/**
 * Where `diff` attributes of untracked `keys` can come from, and a key over all of it: the
 * `.gitattributes` in the worktree root and every directory containing one of `keys`, status
 * entries for `.gitattributes` files (deleted, untracked, modified), `info/attributes`,
 * `core.attributesFile` (from the per-operation config read), the global default
 * (`$XDG_CONFIG_HOME/git/attributes`) and the system file (`/etc/gitattributes`,
 * `<prefix>/etc/gitattributes`). Only file stats, no git process.
 */
async function attributeState(
  ctx: GitContext,
  repo: RepoInfo,
  keys: readonly string[],
  entries: readonly StatusEntry[],
): Promise<AttributeState> {
  const root = repo.toplevel;
  if (root === null) return { mayApply: true, stateKey: null };
  let mayApply = process.platform === 'win32';
  const parts: string[] = [];
  for (const entry of entries) {
    const named =
      path.posix.basename(entry.path) === '.gitattributes' ||
      (entry.kind === 'renamed' && path.posix.basename(entry.origPath) === '.gitattributes');
    if (named) {
      mayApply = true;
      parts.push(entry.line);
    }
  }
  const dirs = new Set<string>(['']);
  for (const key of keys) {
    for (let slash = key.indexOf('/'); slash >= 0; slash = key.indexOf('/', slash + 1)) {
      dirs.add(key.slice(0, slash));
      if (dirs.size > MAX_ATTRIBUTE_DIRS) return { mayApply: true, stateKey: null };
    }
  }
  const env = (name: string): string | undefined => ctx.runner.envValue(name) || undefined;
  const home = env('HOME');
  const candidates: Array<string | Buffer> = [...dirs].map((dir) =>
    absolutePathBuffer(root, dir ? `${dir}/.gitattributes` : '.gitattributes'),
  );
  candidates.push(path.join(repo.commonDir, 'info', 'attributes'));
  const xdg = env('XDG_CONFIG_HOME') ?? (home ? path.join(home, '.config') : undefined);
  if (xdg) candidates.push(path.join(xdg, 'git', 'attributes'));
  if (!/^(1|true|yes|on)$/i.test(env('GIT_ATTR_NOSYSTEM') ?? '')) {
    candidates.push('/etc/gitattributes');
    try {
      candidates.push(
        path.join(path.dirname(path.dirname(ctx.runner.binary())), 'etc', 'gitattributes'),
      );
    } catch {
      return { mayApply: true, stateKey: null };
    }
  }
  const configured = (await ctx.configScan(repo)).attributesFiles;
  if (configured.length > 0) {
    mayApply = true;
    parts.push(...configured);
    const last = configured[configured.length - 1] as string;
    const expanded = last.startsWith('~/') && home ? path.join(home, last.slice(2)) : last;
    if (expanded) candidates.push(path.resolve(root, expanded));
  }
  const signatures = await mapLimit(candidates, 32, sourceSignature);
  if (signatures.some((sig) => sig !== 'none')) mayApply = true;
  candidates.forEach((candidate, i) => {
    const name = typeof candidate === 'string' ? candidate : bstrFromBuffer(candidate);
    parts.push(`${name}\u0000${signatures[i]}`);
  });
  return { mayApply, stateKey: hashParts(parts, STATE_HASH_LENGTH) };
}

/**
 * The `diff` attribute of untracked paths, so `binary` / `-diff` / `diff` attributes give the
 * same verdict as git's diff after `git add` (F8). Asks `git check-attr -z --stdin diff` (one
 * call) only for paths whose verdict is not cached for the current attribute sources, and
 * not at all when no source exists or contents are not read anyway (over the cap, unless
 * `wanted` is given). Keys are bstr; a trailing `/` (nested repositories) is dropped. The
 * cache key covers all of `rawKeys` (every untracked path of the status snapshot); `wanted`
 * limits which verdicts are looked up and returned (getFileDiff needs one).
 */
export async function readDiffAttributes(
  deps: DiffDeps,
  repo: RepoInfo,
  rawKeys: readonly string[],
  entries: readonly StatusEntry[],
  wanted?: readonly string[],
): Promise<Map<string, DiffAttribute>> {
  const { ctx } = deps;
  const all = rawKeys.filter((key) => !key.endsWith('/'));
  const keys = wanted ? wanted.filter((key) => !key.endsWith('/')) : all;
  if (keys.length === 0) return new Map();
  if (!wanted && rawKeys.length > ctx.settings.maxUntrackedFiles) return new Map();
  const state = await attributeState(ctx, repo, all, entries);
  if (!state.mayApply) return new Map();
  const cacheKey = repo.toplevel ?? repo.gitDir;
  const cached = state.stateKey === null ? undefined : deps.attributeCache.get(cacheKey);
  let verdicts = cached?.stateKey === state.stateKey ? cached.verdicts : new Map<string, string>();
  const missing = keys.filter((key) => !verdicts.has(key));
  if (missing.length > 0) {
    const input = bstrToBuffer(missing.map((key) => `${key}\u0000`).join(''));
    let output: Buffer;
    try {
      output = (await ctx.git(repo, ['check-attr', '-z', '--stdin', 'diff'], { input })).stdout;
    } catch (error) {
      // Attributes only refine binary detection: fall back to git's content sniff.
      if (!isGitCoreError(error, 'git_failed')) throw error;
      ctx.settings.logger.warn('git check-attr failed; untracked binary detection by content', {
        repo: repo.cwd,
        error: error.message,
      });
      return new Map();
    }
    const tokens = bstrFromBuffer(output).split('\u0000');
    if (verdicts.size + missing.length > 4 * Math.max(ctx.settings.maxUntrackedFiles, 1)) {
      verdicts = new Map(
        keys.flatMap((key) => (verdicts.has(key) ? [[key, verdicts.get(key) as string]] : [])),
      );
    }
    for (let i = 0; i + 2 < tokens.length; i += 3) {
      verdicts.set(tokens[i] as string, tokens[i + 2] as string);
    }
  }
  if (state.stateKey !== null) {
    deps.attributeCache.set(cacheKey, { stateKey: state.stateKey, verdicts });
  }
  return new Map(keys.map((key) => [key, verdicts.get(key) ?? 'unspecified']));
}

// ---------------------------------------------------------------------------------------------
// listChangedFiles
// ---------------------------------------------------------------------------------------------

/** A listed file with its bstr key (and rename source), so a list can be updated by path. */
interface ListRow {
  key: string;
  /** Rename or copy source (bstr), else null. */
  oldKey: string | null;
  file: GitChangedFile;
}

/** The last list of a scope that reads the worktree, for incremental updates (#40). */
export interface ListEntry {
  /** `SummaryTrack.version` the list is at least as new as (-1: no summary yet). */
  version: number;
  /** HEAD commit of that summary. */
  headSha: string | null;
  readContent: boolean;
  /** Sorted by key. */
  rows: ListRow[];
  /** `rows`' keys, in the same order (binary search). */
  keys: string[];
}
export type ListCache = LruCache<string, ListEntry>;

/** How file lists of worktree-reading scopes were computed, process-wide (tests, diagnostics). */
export const listRefreshCounts = { incremental: 0, seeded: 0, full: 0 };

export function createListCache(): ListCache {
  return new LruCache<string, ListEntry>(64);
}

/** Rows of the tracked entries of one diff run (all of the scope, or a pathspec-limited part). */
async function trackedRows(
  ctx: GitContext,
  repo: RepoInfo,
  plan: ScopePlan,
  run: DiffRun,
  index: StatusIndex | null,
): Promise<ListRow[]> {
  const numstat = new Map(run.numstat.map((entry) => [entry.path, entry]));
  const combinedKeys = run.raw.filter((entry) => entry.combined).map((entry) => entry.path);
  const combinedChunks = await collectCombinedChunks(ctx, repo, plan, combinedKeys);
  const rows: ListRow[] = [];
  const seen = new Set<string>();
  for (const candidate of run.raw) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    const entry = pickEntry(run.raw, candidate.path) ?? candidate;
    const chunk = entry.combined ? combinedChunks.get(entry.path) : run.chunks.get(entry.path);
    if (isStatOnly(entry, chunk, numstat.get(entry.path))) continue;
    const conflicted = entry.combined || (index?.conflicted.has(entry.path) ?? false);
    const identity = trackedIdentity(
      entry,
      numstat.get(entry.path),
      chunk?.hash ?? fallbackPatchHash(entry),
      conflicted,
    );
    const renamed = entry.status === 'R' || entry.status === 'C';
    rows.push({
      key: entry.path,
      oldKey: renamed ? entry.srcPath : null,
      file: { ...identity, ...flagsFor(plan, index, entry.path) },
    });
  }
  return rows;
}

function untrackedRows(infos: readonly UntrackedInfo[]): ListRow[] {
  return infos.map((info) => ({
    key: info.key,
    oldKey: null,
    file: { ...untrackedIdentity(info), staged: false, unstaged: true },
  }));
}

function sortRows(rows: ListRow[]): ListRow[] {
  return rows.sort((a, b) => compareBstr(a.key, b.key));
}

/** Two key-sorted row lists merged (a stable merge: `a` first on equal keys). */
function mergeRows(a: readonly ListRow[], b: readonly ListRow[]): ListRow[] {
  if (b.length === 0) return [...a];
  const out: ListRow[] = [];
  let j = 0;
  for (const row of a) {
    while (j < b.length && (b[j] as ListRow).key < row.key) out.push(b[j++] as ListRow);
    out.push(row);
  }
  while (j < b.length) out.push(b[j++] as ListRow);
  return out;
}

function listKeyOf(repo: RepoInfo, plan: ScopePlan): string {
  return [repo.cwd, plan.kind, plan.findCopies ? 'C' : '', ...plan.revArgs].join('\u0000');
}

/** git status of the summary state (`SummaryTrack`), as `readStatus` would have parsed it. */
function trackStatus(track: SummaryTrack): StatusResult {
  return {
    branch: track.branch,
    header: track.header,
    entries: [...track.tracked.values(), ...track.untracked.values()],
  };
}

/** Paths (bstr) that differ between two commits, memoized by their ids (`diff-tree`, no renames). */
async function committedKeys(
  ctx: GitContext,
  repo: RepoInfo,
  from: string,
  to: string,
): Promise<ReadonlySet<string>> {
  if (from === to) return new Set();
  const key = `list-names\u0000${repo.commonDir}\u0000${from}\u0000${to}`;
  const names = await ctx.memo(key, async () => {
    const result = await ctx.git(repo, [
      'diff-tree',
      '-r',
      '-z',
      '--name-only',
      '--no-renames',
      '--no-commit-id',
      '--end-of-options',
      from,
      to,
      '--',
    ]);
    return new Set(
      bstrFromBuffer(result.stdout)
        .split('\u0000')
        .filter((name) => name.length > 0),
    );
  });
  return names ?? new Set();
}

const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * A list of a scope that reads the worktree, from the summary state the caller holds (#40):
 *
 * - **update**: the cached list, re-diffed for the paths whose summary records changed since it
 *   was computed (`changedSince`) plus the list's rename candidates (every added, deleted,
 *   renamed or type-changed file: a rename pairs a deletion with an addition anywhere);
 * - **seed** (no usable cached list): one diff limited to the paths that can differ at all, the
 *   summary's status paths plus, against another commit than HEAD, the paths that differ between
 *   it and HEAD (`diff-tree`, memoized). Everywhere else the base, HEAD, the index and the file
 *   agree (git status compares contents), so a full diff would show nothing there, and every
 *   addition or deletion is inside, so renames pair the same way. A stale index costs nothing.
 *
 * File flags and untracked files come from the summary's status (no `git status`). Null when
 * it cannot be done (the caller lists in full).
 */
async function listFromSummary(
  deps: DiffDeps,
  repo: RepoInfo,
  plan: ScopePlan,
  key: string,
): Promise<GitChangedFile[] | null> {
  const { ctx } = deps;
  const track = deps.tracks.get(repo.cwd);
  if (!track || trackBlocker(track) || plan.revArgs.length !== 1) return null;
  const headSha = track.branch.oid;
  if (headSha === null) return null;
  // The summary's state is what the list is built for: an index, ignore, config or attributes
  // file that changed since (no summary yet) means another state.
  const stamp = await readStamp(repo, (name) => ctx.runner.envValue(name) || undefined);
  if (stampChange(track.stamp, stamp)) return null;
  const listed = deps.lists.get(key);
  const cached = listed && listed.version >= 0 && listed.headSha === headSha ? listed : undefined;
  const changed = cached ? changedSince(track, cached.version) : null;
  const update = cached !== undefined && changed !== null;
  if (update && changed.size === 0) return cached.rows.map((row) => row.file);

  const specs = new Set<string>();
  if (update) {
    for (const k of changed) specs.add(k);
    for (const row of cached.rows) {
      if (row.file.status === 'conflicted') return null;
      if (row.file.status === 'untracked' || row.file.status === 'modified') continue;
      specs.add(row.key);
      if (row.oldKey !== null) specs.add(row.oldKey);
    }
  } else {
    for (const entry of track.tracked.values()) {
      if (entry.kind === 'unmerged') return null;
      specs.add(entry.path);
      if (entry.kind === 'renamed') specs.add(entry.origPath);
    }
    const base = plan.revArgs[0] as string;
    if (base !== 'HEAD' && base !== headSha) {
      if (!FULL_OID.test(base)) return null;
      for (const k of await committedKeys(ctx, repo, base, headSha)) specs.add(k);
    }
  }
  const status = trackStatus(track);
  const index = indexStatus(status);
  let fresh: ListRow[] = [];
  // Nothing tracked can differ (a seed of a clean tree, or only untracked files changed).
  const region = specs.size === 0 ? new Region([]) : regionOfKeys(specs);
  if (!region) return null;
  if (region.size > 0) {
    let run: DiffRun;
    try {
      run = await runScopeDiff(ctx, repo, plan, {
        head: true,
        patch: true,
        pathspecs: region.specs.map(bstrToUtf8),
      });
    } catch (error) {
      // An unreadable file (F7) and the other fallbacks are the full list's business.
      if (isGitCoreError(error, 'git_failed')) return null;
      throw error;
    }
    if (run.raw.some((entry) => entry.combined)) return null;
    fresh = await trackedRows(ctx, repo, plan, run, index);
    for (const row of fresh) {
      if (!region.has(row.key) || (row.oldKey !== null && !region.has(row.oldKey))) return null;
    }
  }
  // Rows of a list with tens of thousands of untracked files: the region's ones found by binary
  // search, the rest kept in order.
  const inRegion = update ? new Set(keysInRegion(cached.keys, region)) : new Set<string>();
  const kept = update
    ? cached.rows.filter(
        (row) => !inRegion.has(row.key) && (row.oldKey === null || !region.has(row.oldKey)),
      )
    : [];
  const trackedKeys = new Set<string>();
  for (const row of [...kept, ...fresh]) {
    if (row.file.status !== 'untracked') trackedKeys.add(row.key);
  }
  const attributes = plan.includeUntracked
    ? await readDiffAttributes(deps, repo, index.untracked, status.entries)
    : new Map<string, DiffAttribute>();
  const inspect = inspectOptions(ctx, repo, index.untracked.length, attributes);
  if (update && inspect.readContent !== cached.readContent) return null;
  // An update re-inspects the region's untracked files only (binary search, no scan of all).
  const keys = !plan.includeUntracked
    ? []
    : update
      ? keysInRegion(track.untrackedOrder, region).filter((raw) => {
          const key = raw.endsWith('/') ? raw.slice(0, -1) : raw;
          return !trackedKeys.has(key);
        })
      : untrackedKeys(index, trackedKeys);
  // The summary inspected every untracked file with these same options (count, verdicts): its
  // inspections are the list's, without an lstat each (30k untracked files: about a second).
  const reuse = track.readContent === inspect.readContent;
  const missing: string[] = [];
  const known = new Map<string, UntrackedInfo>();
  for (const raw of keys) {
    const key = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    const held = reuse ? track.untrackedInfos.get(key) : undefined;
    if (held && held.attribute === (attributes.get(key) ?? '')) known.set(raw, held.info);
    else missing.push(raw);
  }
  const inspected = await inspectUntracked(repo.cwd, missing, deps.untrackedCache, inspect);
  for (const [i, raw] of missing.entries()) known.set(raw, inspected[i] as UntrackedInfo);
  const infos = keys.map((raw) => known.get(raw) as UntrackedInfo);
  const rows = mergeRows(kept, sortRows([...fresh, ...untrackedRows(infos)]));
  if (update) listRefreshCounts.incremental++;
  else listRefreshCounts.seeded++;
  const latest = deps.lists.get(key);
  if (!latest || latest.version <= track.version) {
    deps.lists.set(key, {
      version: track.version,
      headSha,
      readContent: inspect.readContent,
      rows,
      keys: rows.map((row) => row.key),
    });
  }
  return rows.map((row) => row.file);
}

export async function listChangedFiles(
  deps: DiffDeps,
  worktree: WorktreeLocator,
  scopeInput: unknown,
  options: ScopeOptions | undefined,
): Promise<GitChangedFile[]> {
  const { ctx } = deps;
  await ctx.ensureSupported();
  const scope = parseScope(scopeInput);
  const repo = await ctx.repo(worktree.path);
  const plan = await planScope(ctx, repo, scope, options);
  // No caching across worktrees, not even for branch/commit scopes: tree-to-tree diffs still
  // read `.gitattributes` from the worktree (binary, diff drivers), which can differ per
  // worktree and change over time. Scopes that read the worktree keep their last list per
  // worktree, updated from the summary's changed paths (#40).
  if (plan.empty) return [];
  const incremental = deps.incremental && plan.vsWorktree && plan.statusBased;
  const key = listKeyOf(repo, plan);
  const held = options?.summaryState;
  if (incremental && held !== undefined && deps.tracks.get(repo.cwd)?.stateHash === held) {
    const listed = await listFromSummary(deps, repo, plan, key);
    if (listed) return listed;
  }
  /** The summary state this list is at least as new as (its status runs after). */
  const track = incremental ? deps.tracks.get(repo.cwd) : undefined;

  const statusPromise = plan.statusBased ? readStatus(ctx, repo) : Promise.resolve(null);
  const attributesPromise = statusPromise.then((snapshot) => {
    if (!plan.includeUntracked || !snapshot) return new Map<string, DiffAttribute>();
    const untracked = snapshot.entries.filter((entry) => entry.kind === 'untracked');
    return readDiffAttributes(
      deps,
      repo,
      untracked.map((entry) => entry.path),
      snapshot.entries,
    );
  });
  let unreadable = new Set<string>();
  const runPromise = runScopeDiff(ctx, repo, plan, { head: true, patch: true }).catch(
    async (error: unknown): Promise<DiffRun> => {
      // One unreadable tracked file fails the whole diff (F7): diff the other changed paths
      // and list it from git status, without a patch.
      const snapshot = await statusPromise;
      if (!readsWorktree(plan) || !snapshot || !isGitCoreError(error, 'git_failed')) throw error;
      unreadable = await findUnreadable(repo.cwd, snapshot.entries);
      if (unreadable.size === 0) throw error;
      const pathspecs = pathspecsExcluding(snapshot.entries, unreadable);
      if (pathspecs === null) throw error;
      ctx.settings.logger.warn('some changed files cannot be read; listing them without a diff', {
        repo: repo.cwd,
        files: [...unreadable].slice(0, 20).map(bstrToUtf8),
      });
      if (pathspecs.length === 0) return { raw: [], numstat: [], chunks: new Map() };
      return runScopeDiff(ctx, repo, plan, { head: true, patch: true, pathspecs });
    },
  );
  const [run, status, attributes] = await Promise.all([
    runPromise,
    statusPromise,
    attributesPromise,
  ]);
  const index = status ? indexStatus(status) : null;
  const rows = await trackedRows(ctx, repo, plan, run, index);
  const trackedKeys = new Set(rows.map((row) => row.key));

  for (const key of [...unreadable].sort(compareBstr)) {
    const entry = index?.tracked.get(key);
    if (trackedKeys.has(key) || !entry || !index) continue;
    trackedKeys.add(key);
    const identity = unreadableIdentity(plan, entry, await lstatSignature(repo.cwd, key));
    rows.push({ key, oldKey: null, file: { ...identity, ...flagsFor(plan, index, key) } });
  }

  let readContent = false;
  if (plan.includeUntracked && index) {
    const keys = untrackedKeys(index, trackedKeys);
    const inspect = inspectOptions(ctx, repo, index.untracked.length, attributes);
    readContent = inspect.readContent;
    const infos = await inspectUntracked(repo.cwd, keys, deps.untrackedCache, inspect);
    rows.push(...untrackedRows(infos));
  }

  sortRows(rows);
  if (incremental) listRefreshCounts.full++;
  if (incremental && unreadable.size === 0) {
    const previous = deps.lists.get(key);
    const version = track?.version ?? -1;
    if (!previous || previous.version <= version) {
      deps.lists.set(key, {
        version,
        headSha: track?.branch.oid ?? null,
        readContent,
        rows,
        keys: rows.map((row) => row.key),
      });
    }
  }
  return rows.map((row) => row.file);
}

// ---------------------------------------------------------------------------------------------
// getFileDiff
// ---------------------------------------------------------------------------------------------

function parseSelector(file: unknown): FileSelector {
  const parsed = FileSelectorSchema.safeParse(file);
  if (!parsed.success) {
    throw new GitCoreError('invalid_argument', `invalid file selector: ${parsed.error.message}`);
  }
  return parsed.data;
}

function parseDiffOptions(options: DiffOptions | undefined): {
  context: number;
  ignoreWhitespace: boolean;
  full: boolean;
} {
  const context = options?.contextLines ?? CANONICAL_CONTEXT;
  if (!Number.isInteger(context) || context < 0 || context > 1_000_000) {
    throw new GitCoreError('invalid_argument', `invalid contextLines: ${String(context)}`);
  }
  return {
    context,
    ignoreWhitespace: options?.ignoreWhitespace === true,
    full: options?.full === true,
  };
}

interface Shown {
  patch: string;
  tooLarge: boolean;
  truncated: boolean;
}

function present(
  chunk: ChunkResult | undefined,
  binary: boolean,
  limit: number,
  full: boolean,
): Shown {
  if (binary || !chunk) return { patch: '', tooLarge: false, truncated: false };
  if (chunk.bytes > limit) {
    if (!full) return { patch: '', tooLarge: true, truncated: false };
    return { patch: bstrToUtf8(chunk.text), tooLarge: false, truncated: true };
  }
  return { patch: bstrToUtf8(chunk.text), tooLarge: false, truncated: false };
}

export async function getFileDiff(
  deps: DiffDeps,
  worktree: WorktreeLocator,
  scopeInput: unknown,
  fileInput: unknown,
  options: DiffOptions | undefined,
): Promise<GitFileDiff> {
  const { ctx } = deps;
  await ctx.ensureSupported();
  const scope = parseScope(scopeInput);
  const selector = parseSelector(fileInput);
  const view = parseDiffOptions(options);
  const key = selectorToBstr(selector);
  const repo = await ctx.repo(worktree.path);
  const plan = await planScope(ctx, repo, scope, options);
  const notFound = (): GitCoreError =>
    new GitCoreError('not_found', `file is not changed in this scope: ${selector.path}`, {
      path: selector.path,
    });
  if (plan.empty) throw notFound();

  // 1. Identify the file in the whole scope (cheap: raw output only, no patch text).
  const [ident, status] = await Promise.all([
    runScopeDiff(ctx, repo, plan, { head: false, patch: false }),
    plan.statusBased ? readStatus(ctx, repo) : Promise.resolve(null),
  ]);
  const index = status ? indexStatus(status) : null;
  const identified = pickEntry(ident.raw, key);
  const limit = view.full ? ctx.settings.maxOutputBytes : ctx.settings.maxPatchBytes;
  const needsView = view.ignoreWhitespace || view.context !== CANONICAL_CONTEXT;

  if (identified) {
    const only = new Set([key]);
    const retainCanonical = needsView ? new Set<string>() : only;
    const renamed = identified.status === 'R';
    const usable = isValidUtf8(key) && (!renamed || isValidUtf8(identified.srcPath));
    // Copies are diffed in the whole scope: with a narrowed pathspec git could pair the
    // source as a rename instead, which would change the patch (and its hash).
    let pathspecs =
      identified.status === 'C' || !usable
        ? null
        : renamed
          ? [bstrToUtf8(identified.srcPath), bstrToUtf8(key)]
          : [bstrToUtf8(key)];
    // 2. The canonical patch, in exactly the output format listChangedFiles uses (git reports
    //    unmerged paths differently depending on the format), so identity and hash match.
    const canonicalOptions: DiffRunOptions = {
      head: true,
      patch: true,
      only,
      retain: retainCanonical,
      retainLimit: limit,
    };
    let run = await runScopeDiff(ctx, repo, plan, { ...canonicalOptions, pathspecs });
    const narrowed = pickEntry(run.raw, key);
    if (
      pathspecs !== null &&
      (narrowed === undefined ||
        (!narrowed.combined &&
          (narrowed.status !== identified.status || narrowed.srcPath !== identified.srcPath)))
    ) {
      // A literal pathspec also matches paths below it (`foo` matches `foo/x`), which can
      // change rename pairing. Fall back to the whole scope so the patch matches the list.
      pathspecs = null;
      run = await runScopeDiff(ctx, repo, plan, { ...canonicalOptions, pathspecs });
    }
    const entry = pickEntry(run.raw, key) ?? identified;
    const numstat = run.numstat.find((candidate) => candidate.path === key);
    let canonical = run.chunks.get(key);
    if (entry.combined) {
      const chunks = await collectCombinedChunks(ctx, repo, plan, [key], {
        retain: retainCanonical,
        retainLimit: limit,
      });
      canonical = chunks.get(key);
    }
    if (isStatOnly(entry, canonical, numstat)) throw notFound();
    const conflicted = entry.combined || (index?.conflicted.has(key) ?? false);

    const identity = trackedIdentity(
      entry,
      numstat,
      canonical?.hash ?? fallbackPatchHash(entry),
      conflicted,
    );
    let shownChunk = canonical;
    if (needsView && !identity.binary) {
      const run = await runScopeDiff(ctx, repo, plan, {
        head: false,
        patch: true,
        context: view.context,
        ignoreWhitespace: view.ignoreWhitespace,
        pathspecs,
        only,
        retain: only,
        retainLimit: limit,
      });
      shownChunk = run.chunks.get(key);
    }
    return {
      ...identity,
      images: await imageComparison(ctx, repo, plan, entry, identity),
      ...present(shownChunk, identity.binary, limit, view.full),
      byteLength: canonical?.bytes ?? null,
    };
  }

  if (!plan.includeUntracked || !index) throw notFound();
  const trackedKeys = new Set(ident.raw.map((candidate) => candidate.path));
  const rawKey = untrackedKeys(index, trackedKeys).find(
    (raw) => (raw.endsWith('/') ? raw.slice(0, -1) : raw) === key,
  );
  if (rawKey === undefined) throw notFound();
  const attributes = await readDiffAttributes(deps, repo, index.untracked, status?.entries ?? [], [
    rawKey,
  ]);
  const [info] = await inspectUntracked(
    repo.cwd,
    [rawKey],
    deps.untrackedCache,
    inspectOptions(ctx, repo, index.untracked.length, attributes),
  );
  if (!info) throw notFound();
  return {
    ...untrackedIdentity(info),
    ...(info.binary
      ? { images: await imageComparison(ctx, repo, plan, null, untrackedIdentity(info), info.key) }
      : {}),
    ...(await untrackedPatch(ctx, repo, info, attributes.get(info.key), limit, view.full)),
  };
}

/**
 * The displayed patch of an untracked entry: the synthesized canonical new-file patch (the
 * text whose hash is the entry's patchHash), view options do not apply to pure additions.
 */
async function untrackedPatch(
  ctx: GitContext,
  repo: RepoInfo,
  info: UntrackedInfo,
  attribute: DiffAttribute | undefined,
  limit: number,
  full: boolean,
): Promise<Shown & { byteLength: number | null }> {
  const empty = { patch: '', tooLarge: false, truncated: false, byteLength: null };
  if (info.kind === 'missing' || info.kind === 'other' || info.binary) return empty;
  if (info.kind !== 'directory') {
    const estimate = info.size + (info.lines ?? info.size) + 512 + info.key.length * 3;
    if (!full && estimate > limit) return { ...empty, tooLarge: true };
  }
  const collector = new PatchCollector({ retain: new AnyKeySet(), retainLimit: limit });
  const written = await writeUntrackedPatch(
    repo.cwd,
    info,
    repo.objectFormat,
    ctx.settings.bigFileThreshold,
    attribute,
    {
      update: (data) => collector.write(data),
      updateBytes: (data) =>
        collector.write(bstrFromBuffer(Buffer.from(data.buffer, data.byteOffset, data.byteLength))),
    },
  );
  if (!written) return empty;
  collector.end();
  const chunk = [...collector.results().values()][0];
  if (!chunk) return empty;
  if (/^Binary files /m.test(chunk.text) && !chunk.text.includes('\n@@')) return empty;
  return { ...present(chunk, false, limit, full), byteLength: chunk.bytes };
}

/** A set that contains every key (retain all chunks). */
class AnyKeySet extends Set<string> {
  override has(_key: string): boolean {
    return true;
  }
}
