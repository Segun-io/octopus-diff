import {
  GitCoreError,
  type GitTreeEntry,
  type GitTreeListing,
  isGitCoreError,
  RawPathSchema,
  RefNameSchema,
  type TreeListOptions,
  type WorktreeLocator,
} from '@octopus-diff/contracts';
import { bstrFromBuffer, bstrFromUtf8, decodeRepoPath } from './bstr.js';
import { verifyCommit } from './commits.js';
import type { GitContext, RepoInfo } from './context.js';
import { OID, resolveRefFromFiles } from './ref-files.js';
import { Flight } from './runner/call-context.js';
import { resolveCommit, resolveHead } from './scope.js';

/**
 * The file explorer's directory listing (#9).
 *
 * - **Objects only.** A directory is reached by walking tree objects from the commit's root tree,
 *   one component at a time, each tree listed with `ls-tree -z -l <tree oid>`: no path, pathspec
 *   or ref ever reaches git's command line (the allowlist only lets `ls-tree` take one object id),
 *   and the working tree is never read. A component that is not a tree (a file, a symlink, a
 *   submodule's commit) ends the walk: a symlink is never followed, inside or out of the repo.
 * - **Shared and immutable.** A tree object never changes, so listings are cached by
 *   `(common dir, tree oid)`: every worktree of a project, every branch and every commit that holds
 *   the same directory share one entry. The cache is bounded by an estimate of its bytes (LRU).
 * - **Refs.** `HEAD` comes from the worktree's HEAD file when it can tell (no process); a full
 *   commit id is verified once (memoized); a branch or tag from the ref files, else `rev-parse`.
 *   The commit → root tree step is memoized by commit id.
 */

const NUL = '\u0000';
/** Default bound of the listing cache (an estimate of the bytes its entries hold). */
export const TREE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const ENTRY_OVERHEAD_BYTES = 160;

/** One entry of a tree object, as cached: the name in bytes (bstr), no path. */
interface RawTreeEntry {
  name: string;
  mode: string;
  kind: GitTreeEntry['kind'];
  oid: string;
  size: number | null;
}

interface CachedTree {
  entries: RawTreeEntry[];
  bytes: number;
  /** Name (bstr) → index, built on the first lookup through this tree. */
  index?: Map<string, number>;
}

/** The byte-bounded LRU of tree listings and the in-flight `ls-tree` runs. */
export class TreeCache {
  readonly #map = new Map<string, CachedTree>();
  readonly #runs = new Map<string, Flight<CachedTree>>();
  readonly #counts = new Map<string, number>();
  #bytes = 0;

  constructor(readonly maxBytes = TREE_CACHE_MAX_BYTES) {}

  get bytes(): number {
    return this.#bytes;
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: string): CachedTree | undefined {
    const hit = this.#map.get(key);
    if (hit) {
      this.#map.delete(key);
      this.#map.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: CachedTree): void {
    const old = this.#map.get(key);
    if (old) {
      this.#bytes -= old.bytes;
      this.#map.delete(key);
    }
    // A single listing above the bound is served but not kept.
    if (value.bytes > this.maxBytes) return;
    this.#map.set(key, value);
    this.#bytes += value.bytes;
    while (this.#bytes > this.maxBytes) {
      const oldest = this.#map.entries().next();
      if (oldest.done) break;
      this.#map.delete(oldest.value[0]);
      this.#bytes -= oldest.value[1].bytes;
    }
  }

  run(key: string, compute: () => Promise<CachedTree>): Promise<CachedTree> {
    const hit = this.get(key);
    if (hit) return Promise.resolve(hit);
    let run = this.#runs.get(key);
    if (!run || run.cancelled) {
      const flight: Flight<CachedTree> = new Flight(
        () =>
          compute().then((value) => {
            this.set(key, value);
            return value;
          }),
        () => {
          if (this.#runs.get(key) === flight) this.#runs.delete(key);
        },
      );
      run = flight;
      this.#runs.set(key, flight);
      void flight.settled.then(() => {
        if (this.#runs.get(key) === flight) this.#runs.delete(key);
      });
    }
    return run.join();
  }

  count(key: string): number | undefined {
    return this.#counts.get(key);
  }

  setCount(key: string, value: number): void {
    this.#counts.delete(key);
    this.#counts.set(key, value);
    while (this.#counts.size > 20_000) {
      const oldest = this.#counts.keys().next();
      if (oldest.done) break;
      this.#counts.delete(oldest.value);
    }
  }

  clear(): void {
    this.#map.clear();
    this.#counts.clear();
    this.#bytes = 0;
  }
}

export interface TreeDeps {
  ctx: GitContext;
  trees: TreeCache;
}

function kindOf(mode: string, type: string): GitTreeEntry['kind'] | null {
  if (type === 'tree') return 'dir';
  if (type === 'commit') return 'submodule';
  if (type !== 'blob') return null;
  return mode === '120000' ? 'symlink' : 'file';
}

/**
 * Parses `ls-tree -z -l` output (bstr): `<mode> SP <type> SP <oid> SP+ <size|-> TAB <name> NUL`.
 * Entries git prints in tree order; an entry of an unknown type is skipped.
 */
export function parseLsTree(out: string): RawTreeEntry[] {
  const entries: RawTreeEntry[] = [];
  let at = 0;
  while (at < out.length) {
    const end = out.indexOf(NUL, at);
    const record = end === -1 ? out.slice(at) : out.slice(at, end);
    at = end === -1 ? out.length : end + 1;
    if (record.length === 0) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) throw new GitCoreError('git_failed', 'unexpected ls-tree output (no tab)');
    const meta = record.slice(0, tab).split(' ').filter(Boolean);
    const name = record.slice(tab + 1);
    const [mode, type, oid, size] = meta;
    if (!mode || !type || !oid || size === undefined || !OID.test(oid) || name.length === 0) {
      throw new GitCoreError('git_failed', 'unexpected ls-tree output');
    }
    const kind = kindOf(mode, type);
    if (kind === null) continue;
    const bytes = size === '-' ? null : Number(size);
    entries.push({
      name,
      mode: mode.padStart(6, '0'),
      kind,
      oid,
      size: bytes !== null && Number.isSafeInteger(bytes) ? bytes : null,
    });
  }
  return entries;
}

async function readTree(deps: TreeDeps, repo: RepoInfo, tree: string): Promise<CachedTree> {
  return deps.trees.run(`${repo.commonDir}${NUL}${tree}`, async () => {
    const result = await deps.ctx.git(repo, ['ls-tree', '-z', '-l', tree]);
    const entries = parseLsTree(bstrFromBuffer(result.stdout));
    let bytes = 0;
    for (const e of entries) bytes += e.name.length + ENTRY_OVERHEAD_BYTES;
    return { entries, bytes };
  });
}

/** The directory as path components in bytes (bstr), or `invalid_argument`. */
export function treePathComponents(options: Pick<TreeListOptions, 'path' | 'rawPath'>): string[] {
  let raw: string;
  if (options.rawPath !== undefined) {
    if (!RawPathSchema.safeParse(options.rawPath).success) {
      throw new GitCoreError('invalid_argument', 'rawPath must be base64');
    }
    raw = bstrFromBuffer(Buffer.from(options.rawPath, 'base64'));
  } else {
    if (typeof options.path !== 'string') {
      throw new GitCoreError('invalid_argument', 'path must be a string');
    }
    raw = bstrFromUtf8(options.path);
  }
  if (raw.length > 4096) throw new GitCoreError('invalid_argument', 'path is too long');
  if (raw === '') return [];
  const parts = raw.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..' || part.includes(NUL)) {
      throw new GitCoreError(
        'invalid_argument',
        'path must be a repo-relative directory without empty, "." or ".." components',
      );
    }
  }
  return parts;
}

/** The commit `ref` names for this worktree: null for an unborn `HEAD`. */
async function resolveTreeRef(
  ctx: GitContext,
  repo: RepoInfo,
  ref: string,
): Promise<string | null> {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new GitCoreError('invalid_argument', 'ref must be a non-empty string');
  }
  if (ref === 'HEAD') return resolveHead(ctx, repo);
  if (OID.test(ref)) return verifyCommit(ctx, repo, ref);
  if (!RefNameSchema.safeParse(ref).success) {
    throw new GitCoreError('invalid_argument', `invalid ref: ${ref}`);
  }
  const fromFiles = await resolveRefFromFiles(repo.commonDir, ref);
  // A ref's target may be a tag object: peel it to its commit (memoized by object id).
  if (fromFiles) return verifyCommit(ctx, repo, fromFiles.oid);
  return resolveCommit(ctx, repo, ref);
}

/** The root tree of a commit, memoized by (common dir, commit). */
async function rootTree(ctx: GitContext, repo: RepoInfo, commit: string): Promise<string> {
  const key = `root-tree${NUL}${repo.commonDir}${NUL}${commit}`;
  const tree = await ctx.memo<string>(key, async () => {
    const result = await ctx.git(
      repo,
      ['rev-parse', '--quiet', '--verify', '--end-of-options', `${commit}^{tree}`],
      { okExitCodes: [0, 1, 128] },
    );
    const out = result.stdout.toString('utf8').trim();
    return result.exitCode === 0 && OID.test(out) ? out : undefined;
  });
  if (tree === undefined) throw new GitCoreError('not_found', `commit not found: ${commit}`);
  return tree;
}

function lookup(tree: CachedTree, name: string): RawTreeEntry | undefined {
  if (!tree.index) {
    const index = new Map<string, number>();
    tree.entries.forEach((e, i) => {
      index.set(e.name, i);
    });
    tree.index = index;
  }
  const at = tree.index.get(name);
  return at === undefined ? undefined : tree.entries[at];
}

function toEntry(prefix: string, raw: RawTreeEntry): GitTreeEntry {
  const name = decodeRepoPath(raw.name);
  const full = decodeRepoPath(prefix === '' ? raw.name : `${prefix}/${raw.name}`);
  return {
    name: name.path,
    ...(name.rawPath !== undefined ? { rawName: name.rawPath } : {}),
    path: full.path,
    ...(full.rawPath !== undefined ? { rawPath: full.rawPath } : {}),
    kind: raw.kind,
    mode: raw.mode,
    oid: raw.oid,
    size: raw.kind === 'file' || raw.kind === 'symlink' ? raw.size : null,
  };
}

export async function listTree(
  deps: TreeDeps,
  worktree: WorktreeLocator,
  options: TreeListOptions,
): Promise<GitTreeListing> {
  const parts = treePathComponents(options);
  await deps.ctx.ensureSupported();
  const repo = await deps.ctx.repo(worktree.path);
  const commit = await resolveTreeRef(deps.ctx, repo, options.ref);
  if (commit === null) return { commit: null, tree: null, kind: null, entries: [] };
  let tree = await rootTree(deps.ctx, repo, commit);
  for (let i = 0; i < parts.length; i++) {
    const listing = await readTree(deps, repo, tree);
    const child = lookup(listing, parts[i] as string);
    if (!child) return { commit, tree: null, kind: null, entries: [] };
    if (child.kind !== 'dir') {
      // Never entered. Below a non-directory the path is not in the commit at all.
      const last = i === parts.length - 1;
      return { commit, tree: null, kind: last ? child.kind : null, entries: [] };
    }
    tree = child.oid;
  }
  const listing = await readTree(deps, repo, tree);
  const prefix = parts.join('/');
  return {
    commit,
    tree,
    kind: 'dir',
    entries: listing.entries.map((e) => toEntry(prefix, e)),
  };
}

export async function countTreeFiles(
  deps: TreeDeps,
  worktree: WorktreeLocator,
  options: { tree: string },
): Promise<number> {
  if (typeof options?.tree !== 'string' || !OID.test(options.tree)) {
    throw new GitCoreError('invalid_argument', 'tree must be a full object id');
  }
  await deps.ctx.ensureSupported();
  const repo = await deps.ctx.repo(worktree.path);
  const key = `${repo.commonDir}${NUL}${options.tree}`;
  const known = deps.trees.count(key);
  if (known !== undefined) return known;
  let out: Buffer;
  try {
    out = (await deps.ctx.git(repo, ['ls-tree', '-r', '-z', options.tree])).stdout;
  } catch (error) {
    if (
      isGitCoreError(error, 'git_failed') &&
      /not a tree object/i.test(error.details.stderr ?? '')
    ) {
      throw new GitCoreError('not_found', `no tree ${options.tree}`, {}, { cause: error });
    }
    throw error;
  }
  // One record per blob, symlink or gitlink below the tree, NUL-terminated.
  let count = 0;
  for (let i = out.indexOf(0); i !== -1; i = out.indexOf(0, i + 1)) count++;
  deps.trees.setCount(key, count);
  return count;
}
