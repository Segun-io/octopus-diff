import path from 'node:path';
import {
  GIT_OBJECT_MISSING,
  GitCoreError,
  type GitTreeChildCount,
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
import { type GitContext, type RepoInfo, readSmallFile } from './context.js';
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
  readonly #children = new Map<string, GitTreeChildCount[]>();
  /** Failed counts by key: until when they are not retried (`Infinity`: an output above the cap). */
  readonly #failures = new Map<string, { until: number; error: GitCoreError }>();
  /** Common dirs whose `ls-tree` must not read blob sizes (a partial clone, P2-1). */
  readonly noSizes = new Set<string>();
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

  children(key: string): GitTreeChildCount[] | undefined {
    return this.#children.get(key);
  }

  setChildren(key: string, value: GitTreeChildCount[]): void {
    this.#children.delete(key);
    this.#children.set(key, value);
    while (this.#children.size > 2000) {
      const oldest = this.#children.keys().next();
      if (oldest.done) break;
      this.#children.delete(oldest.value);
    }
  }

  /** A remembered failure of `key` that has not expired. */
  failure(key: string, now = Date.now()): GitCoreError | undefined {
    const hit = this.#failures.get(key);
    if (!hit) return undefined;
    if (hit.until <= now) {
      this.#failures.delete(key);
      return undefined;
    }
    return hit.error;
  }

  setFailure(key: string, error: GitCoreError, now = Date.now()): void {
    // An output above the cap fails the same way for an immutable tree: for good. Anything else
    // (a timeout under load) for a minute.
    const until = error.code === 'output_too_large' ? Number.POSITIVE_INFINITY : now + 60_000;
    this.#failures.delete(key);
    this.#failures.set(key, { until, error });
    while (this.#failures.size > 2000) {
      const oldest = this.#failures.keys().next();
      if (oldest.done) break;
      this.#failures.delete(oldest.value);
    }
  }

  clear(): void {
    this.#map.clear();
    this.#counts.clear();
    this.#children.clear();
    this.#failures.clear();
    this.noSizes.clear();
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
 * Parses `ls-tree -z -l` output (bstr): `<mode> SP <type> SP <oid> SP+ <size|-> TAB <name> NUL`,
 * or `ls-tree -z` output (no size: every size null). A size git cannot read (`BAD`: a blob a
 * partial clone lacks) is null. Entries git prints in tree order; an unknown type is skipped.
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
    if (!mode || !type || !oid || !OID.test(oid) || name.length === 0) {
      throw new GitCoreError('git_failed', 'unexpected ls-tree output');
    }
    const kind = kindOf(mode, type);
    if (kind === null) continue;
    const bytes = size === undefined || size === '-' ? null : Number(size);
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

/** stderr of a git that tried to fetch a missing object from a promisor remote (and could not). */
const PROMISOR_FETCH = /from promisor remote|lazy fetch|promisor/i;
/** stderr of a git that lacks an object (a partial clone's missing tree, or a pruned one). */
const MISSING_OBJECT =
  /not a tree object|bad object|missing (tree|blob|object)|could not read|not a valid object/i;

function objectMissing(object: string, cause: unknown): GitCoreError {
  return new GitCoreError(
    'not_found',
    `the repository does not have ${object} locally (a partial clone?)`,
    { reason: GIT_OBJECT_MISSING, object },
    { cause },
  );
}

/**
 * The repository is a partial clone (a promisor remote, or `extensions.partialClone`), read from
 * its config file; includes are not followed, which only costs the fallback below one failed run.
 */
async function hasPromisor(repo: RepoInfo): Promise<boolean> {
  const text = (await readSmallFile(path.join(repo.commonDir, 'config'), 1024 * 1024))?.toString(
    'utf8',
  );
  return text !== undefined && /^\s*(promisor\s*=\s*true|partialclone\s*=)/im.test(text);
}

/**
 * `ls-tree -l` reads every blob's size (P2-1). In a partial clone a missing blob makes git before
 * 2.44 (no `GIT_NO_LAZY_FETCH`) start a fetch, which `GIT_ALLOW_PROTOCOL=none` blocks, and the
 * whole listing fails. So: no sizes below 2.44 in a partial clone, and after any such failure no
 * sizes for that repository again (sizes are then null; nothing else changes).
 */
async function readsSizes(deps: TreeDeps, repo: RepoInfo): Promise<boolean> {
  if (deps.trees.noSizes.has(repo.commonDir)) return false;
  const version = await deps.ctx.version();
  if (!version.features.noLazyFetch && (await hasPromisor(repo))) {
    deps.trees.noSizes.add(repo.commonDir);
    return false;
  }
  return true;
}

async function lsTree(deps: TreeDeps, repo: RepoInfo, tree: string): Promise<Buffer> {
  const sizes = await readsSizes(deps, repo);
  try {
    return (await deps.ctx.git(repo, ['ls-tree', '-z', ...(sizes ? ['-l'] : []), tree])).stdout;
  } catch (error) {
    const stderr = isGitCoreError(error, 'git_failed') ? (error.details.stderr ?? '') : '';
    if (sizes && PROMISOR_FETCH.test(stderr)) {
      deps.trees.noSizes.add(repo.commonDir);
      try {
        return (await deps.ctx.git(repo, ['ls-tree', '-z', tree])).stdout;
      } catch (again) {
        const err = isGitCoreError(again, 'git_failed') ? (again.details.stderr ?? '') : '';
        if (MISSING_OBJECT.test(err) || PROMISOR_FETCH.test(err))
          throw objectMissing(`tree ${tree}`, again);
        throw again;
      }
    }
    if (MISSING_OBJECT.test(stderr)) throw objectMissing(`tree ${tree}`, error);
    throw error;
  }
}

async function readTree(deps: TreeDeps, repo: RepoInfo, tree: string): Promise<CachedTree> {
  return deps.trees.run(`${repo.commonDir}${NUL}${tree}`, async () => {
    const entries = parseLsTree(bstrFromBuffer(await lsTree(deps, repo, tree)));
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
  // The commit was resolved (from a ref, HEAD or a verified id): its tree is what is missing, as in
  // a treeless partial clone (`--filter=tree:0`, P3-6). Nothing is fetched.
  if (tree === undefined) throw objectMissing(`the tree of commit ${commit}`, null);
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
  if (options.withEntries === false) return { commit, tree, kind: 'dir', entries: [] };
  const listing = await readTree(deps, repo, tree);
  const prefix = parts.join('/');
  return {
    commit,
    tree,
    kind: 'dir',
    entries: listing.entries.map((e) => toEntry(prefix, e)),
  };
}

/** `ls-tree -r -z <tree>` with the failure memo (P3-3): a failure is not retried for every state. */
async function lsTreeRecursive(deps: TreeDeps, repo: RepoInfo, tree: string): Promise<Buffer> {
  const key = `${repo.commonDir}${NUL}${tree}`;
  const failed = deps.trees.failure(key);
  if (failed) throw failed;
  try {
    return (await deps.ctx.git(repo, ['ls-tree', '-r', '-z', tree])).stdout;
  } catch (error) {
    let mapped: unknown = error;
    const stderr = isGitCoreError(error, 'git_failed') ? (error.details.stderr ?? '') : '';
    if (MISSING_OBJECT.test(stderr) || PROMISOR_FETCH.test(stderr))
      mapped = objectMissing(`tree ${tree}`, error);
    // Cancellation and shutdown are the caller's, not the tree's: never remembered.
    if (mapped instanceof GitCoreError && mapped.code !== 'aborted' && mapped.code !== 'disposed') {
      deps.trees.setFailure(key, mapped);
    }
    throw mapped;
  }
}

function validTree(options: { tree: string }): void {
  if (typeof options?.tree !== 'string' || !OID.test(options.tree)) {
    throw new GitCoreError('invalid_argument', 'tree must be a full object id');
  }
}

/** Files below each child directory of `tree`, from one `ls-tree -r` (memoized, P3-3). */
export async function countTreeChildren(
  deps: TreeDeps,
  worktree: WorktreeLocator,
  options: { tree: string },
): Promise<GitTreeChildCount[]> {
  validTree(options);
  await deps.ctx.ensureSupported();
  const repo = await deps.ctx.repo(worktree.path);
  const key = `${repo.commonDir}${NUL}${options.tree}`;
  const known = deps.trees.children(key);
  if (known) return known;
  const out = bstrFromBuffer(await lsTreeRecursive(deps, repo, options.tree));
  const counts = new Map<string, number>();
  let total = 0;
  let at = 0;
  while (at < out.length) {
    const end = out.indexOf(NUL, at);
    const record = end === -1 ? out.slice(at) : out.slice(at, end);
    at = end === -1 ? out.length : end + 1;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    total++;
    const rel = record.slice(tab + 1);
    const slash = rel.indexOf('/');
    if (slash === -1) continue; // a file of the tree itself, not of a child directory
    const name = rel.slice(0, slash);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  deps.trees.setCount(key, total);
  const result: GitTreeChildCount[] = [];
  for (const [name, count] of counts) {
    const decoded = decodeRepoPath(name);
    result.push({
      name: decoded.path,
      ...(decoded.rawPath !== undefined ? { rawName: decoded.rawPath } : {}),
      count,
    });
  }
  deps.trees.setChildren(key, result);
  return result;
}

export async function countTreeFiles(
  deps: TreeDeps,
  worktree: WorktreeLocator,
  options: { tree: string },
): Promise<number> {
  validTree(options);
  await deps.ctx.ensureSupported();
  const repo = await deps.ctx.repo(worktree.path);
  const key = `${repo.commonDir}${NUL}${options.tree}`;
  const known = deps.trees.count(key);
  if (known !== undefined) return known;
  const out = await lsTreeRecursive(deps, repo, options.tree);
  // One record per blob, symlink or gitlink below the tree, NUL-terminated.
  let count = 0;
  for (let i = out.indexOf(0); i !== -1; i = out.indexOf(0, i + 1)) count++;
  deps.trees.setCount(key, count);
  return count;
}
