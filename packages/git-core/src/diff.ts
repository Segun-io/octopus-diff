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
  bstrToUtf8,
  compareBstr,
  decodeRepoPath,
  isValidUtf8,
  selectorToBstr,
} from './bstr.js';
import type { GitContext, RepoInfo } from './context.js';
import { hashParts, PATCH_HASH_LENGTH, PatchHasher } from './hash.js';
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
  inspectUntracked,
  readUntrackedContent,
  synthesizeNewFilePatch,
  type UntrackedCache,
  type UntrackedInfo,
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
  conflicted: Set<string>;
  untracked: string[];
}

function indexStatus(status: StatusResult): StatusIndex {
  const tracked = new Map<string, StatusEntry>();
  const conflicted = new Set<string>();
  const untracked: string[] = [];
  for (const entry of status.entries) {
    if (entry.kind === 'untracked') untracked.push(entry.path);
    else if (entry.kind === 'ignored') continue;
    else {
      tracked.set(entry.path, entry);
      if (entry.kind === 'unmerged') conflicted.add(entry.path);
    }
  }
  return { tracked, conflicted, untracked };
}

function flagsFor(
  plan: ScopePlan,
  entry: StatusEntry | undefined,
): { staged: boolean; unstaged: boolean } {
  const indexChanged =
    entry !== undefined &&
    (entry.kind === 'ordinary' || entry.kind === 'renamed') &&
    entry.x !== '.';
  const worktreeChanged =
    entry !== undefined &&
    (entry.kind === 'unmerged' ||
      entry.kind === 'untracked' ||
      ((entry.kind === 'ordinary' || entry.kind === 'renamed') && entry.y !== '.'));
  switch (plan.kind) {
    case 'working':
      return { staged: indexChanged, unstaged: worktreeChanged };
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
 * is still reported in raw output (modified, same mode), but has no numstat entry and no patch.
 * Such entries are not changes and are dropped.
 */
function isStatOnly(
  entry: RawEntry,
  chunk: ChunkResult | undefined,
  numstat: NumstatEntry | undefined,
): boolean {
  return (
    !entry.combined &&
    entry.status === 'M' &&
    entry.srcMode === entry.dstMode &&
    chunk === undefined &&
    numstat === undefined
  );
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
  /** Results for immutable plans (branch/commit), keyed by commonDir + plan key. */
  immutableCache: {
    get(key: string): GitChangedFile[] | undefined;
    set(key: string, value: GitChangedFile[]): void;
  };
}

function inspectOptions(ctx: GitContext) {
  return {
    maxFiles: ctx.settings.maxUntrackedFiles,
    readLimit: ctx.settings.maxOutputBytes,
    executableBit: process.platform !== 'win32',
  };
}

// ---------------------------------------------------------------------------------------------
// listChangedFiles
// ---------------------------------------------------------------------------------------------

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
  if (plan.empty) return [];
  const cacheKey = plan.immutableKey ? `${repo.commonDir}\u0000${plan.immutableKey}` : null;
  if (cacheKey) {
    const cached = deps.immutableCache.get(cacheKey);
    if (cached) return cached.map((file) => ({ ...file }));
  }

  const [run, status] = await Promise.all([
    runScopeDiff(ctx, repo, plan, { head: true, patch: true }),
    plan.statusBased ? readStatus(ctx, repo) : Promise.resolve(null),
  ]);
  const index = status ? indexStatus(status) : null;
  const numstat = new Map(run.numstat.map((entry) => [entry.path, entry]));
  const combinedKeys = run.raw.filter((entry) => entry.combined).map((entry) => entry.path);
  const combinedChunks = await collectCombinedChunks(ctx, repo, plan, combinedKeys);

  const rows: Array<{ key: string; file: GitChangedFile }> = [];
  const trackedKeys = new Set<string>();
  for (const candidate of run.raw) {
    if (trackedKeys.has(candidate.path)) continue;
    trackedKeys.add(candidate.path);
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
    rows.push({
      key: entry.path,
      file: { ...identity, ...flagsFor(plan, index?.tracked.get(entry.path)) },
    });
  }

  if (plan.includeUntracked && index) {
    const keys = untrackedKeys(index, trackedKeys);
    const infos = await inspectUntracked(
      repo.cwd,
      keys.map((key, position) => ({ key, index: position })),
      deps.untrackedCache,
      inspectOptions(ctx),
    );
    for (const info of infos) {
      rows.push({
        key: info.key,
        file: { ...untrackedIdentity(info), staged: false, unstaged: true },
      });
    }
  }

  rows.sort((a, b) => compareBstr(a.key, b.key));
  const files = rows.map((row) => row.file);
  if (cacheKey)
    deps.immutableCache.set(
      cacheKey,
      files.map((file) => ({ ...file })),
    );
  return files;
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
    const pathspecs =
      identified.status === 'C' || !usable
        ? null
        : renamed
          ? [bstrToUtf8(identified.srcPath), bstrToUtf8(key)]
          : [bstrToUtf8(key)];
    // 2. The canonical patch, in exactly the output format listChangedFiles uses (git reports
    //    unmerged paths differently depending on the format), so identity and hash match.
    const run = await runScopeDiff(ctx, repo, plan, {
      head: true,
      patch: true,
      pathspecs,
      only,
      retain: retainCanonical,
      retainLimit: limit,
    });
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
      ...present(shownChunk, identity.binary, limit, view.full),
      byteLength: canonical?.bytes ?? null,
    };
  }

  if (!plan.includeUntracked || !index) throw notFound();
  const trackedKeys = new Set(ident.raw.map((candidate) => candidate.path));
  const keys = untrackedKeys(index, trackedKeys);
  const position = keys.findIndex((raw) => (raw.endsWith('/') ? raw.slice(0, -1) : raw) === key);
  const rawKey = keys[position];
  if (position < 0 || rawKey === undefined) throw notFound();
  const [info] = await inspectUntracked(
    repo.cwd,
    [{ key: rawKey, index: position }],
    deps.untrackedCache,
    inspectOptions(ctx),
  );
  if (!info) throw notFound();
  return {
    ...untrackedIdentity(info),
    ...(await untrackedPatch(deps, repo, info, limit, view.full)),
  };
}

async function untrackedPatch(
  deps: DiffDeps,
  repo: RepoInfo,
  info: UntrackedInfo,
  limit: number,
  full: boolean,
): Promise<Shown & { byteLength: number | null }> {
  const empty = { patch: '', tooLarge: false, truncated: false, byteLength: null };
  if (info.kind === 'directory' || info.kind === 'missing' || info.kind === 'other') return empty;
  if (info.binary) return empty;
  const estimate = info.size + (info.lines ?? info.size) + 512 + info.key.length * 3;
  if (!full && estimate > limit) return { ...empty, tooLarge: true };

  // `--no-index` chunks are keyed by the path as given; retain whatever chunk appears.
  const collector = new PatchCollector({ retain: new AnyKeySet(), retainLimit: limit });
  if (isValidUtf8(info.key)) {
    await deps.ctx.git(
      repo,
      [
        'diff',
        '--no-index',
        ...DIFF_PINS,
        '-p',
        `-U${CANONICAL_CONTEXT}`,
        '--',
        '/dev/null',
        bstrToUtf8(info.key),
      ],
      { onStdout: (data) => collector.write(bstrFromBuffer(data)) },
    );
  } else {
    const content = await readUntrackedContent(repo.cwd, info);
    if (content === null) return empty;
    collector.write(
      synthesizeNewFilePatch(info.key, info.mode ?? '100644', content, repo.objectFormat),
    );
  }
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
