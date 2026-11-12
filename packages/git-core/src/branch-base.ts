import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  type BranchBase,
  GitCoreError,
  type ProjectLocator,
  RefNameSchema,
  type ScopeOptions,
} from '@octopus-diff/contracts';
import type { GitContext } from './context.js';
import { projectRepoFor, resolveRefName } from './discovery.js';
import { parseDefaultBranch } from './scope.js';

/**
 * `GitCore.readBranchBase`: which commit a branch scope diffs against, as a cache identity.
 * Loose refs and `packed-refs` are plain files, so this normally spawns nothing: a repeat call
 * costs a few small reads. Anything it cannot read with certainty (a symbolic ref such as
 * `origin/HEAD`, a reftable repository, an odd file) falls back to the same `for-each-ref` lookup
 * the scope itself uses, so the answer never disagrees with `planScope`.
 *
 * Read-only: files are only read, under the repository's common git dir, with ref names that
 * passed `RefNameSchema` (no `..`, no leading `-`, no control characters).
 */

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PACKED_CACHE_MAX = 16;
const REFTABLE_TTL_MS = 60_000;

interface PackedRefs {
  signature: string;
  /** The file's text, ending in a newline. */
  text: string;
}

const packedCache = new Map<string, PackedRefs>();
const reftableCache = new Map<string, { at: number; value: boolean }>();

/** `refs/heads/<n>`, `refs/remotes/<n>`, `refs/tags/<n>` in git-core's usual order (`resolveRefName`). */
function candidatesFor(name: string): string[] {
  return name.startsWith('refs/')
    ? [name]
    : [`refs/heads/${name}`, `refs/remotes/${name}`, `refs/tags/${name}`];
}

function safeRefPath(ref: string): boolean {
  return ref
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes('\\'));
}

async function isReftable(commonDir: string): Promise<boolean> {
  const cached = reftableCache.get(commonDir);
  if (cached && Date.now() - cached.at < REFTABLE_TTL_MS) return cached.value;
  let value = false;
  try {
    value = (await stat(path.join(commonDir, 'reftable'))).isDirectory();
  } catch {
    value = false;
  }
  reftableCache.set(commonDir, { at: Date.now(), value });
  return value;
}

async function readPackedRefs(commonDir: string): Promise<string | null> {
  const file = path.join(commonDir, 'packed-refs');
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(file);
  } catch {
    packedCache.delete(file);
    return null;
  }
  const signature = `${st.size}:${st.mtimeMs}:${st.ino}:${st.ctimeMs}`;
  const cached = packedCache.get(file);
  if (cached?.signature === signature) return cached.text;
  const buffer = await readFile(file);
  let text = buffer.toString('utf8');
  if (!text.endsWith('\n')) text += '\n';
  packedCache.delete(file);
  packedCache.set(file, { signature, text });
  while (packedCache.size > PACKED_CACHE_MAX) {
    const oldest = packedCache.keys().next().value;
    if (oldest === undefined) break;
    packedCache.delete(oldest);
  }
  return text;
}

/** The oid of `ref` in `packed-refs` text, or null. */
function findPacked(text: string, ref: string): string | null {
  const needle = ` ${ref}\n`;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) return null;
    const lineStart = text.lastIndexOf('\n', at - 1) + 1;
    const oid = text.slice(lineStart, at);
    if (OID.test(oid)) return oid;
    from = at + 1;
  }
}

/**
 * The object id `ref` points at: a string; null when the ref certainly does not exist; undefined
 * when the files cannot tell (symbolic ref, reftable, unreadable or malformed content).
 */
async function readRefOid(commonDir: string, ref: string): Promise<string | null | undefined> {
  if (!safeRefPath(ref)) return undefined;
  if (await isReftable(commonDir)) return undefined;
  try {
    const content = (await readFile(path.join(commonDir, ref), 'utf8')).trim();
    if (OID.test(content)) return content;
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A directory (`refs/heads/a` when `refs/heads/a/b` exists) or a missing file: not loose.
    if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EISDIR') return undefined;
  }
  try {
    const text = await readPackedRefs(commonDir);
    return text === null ? null : findPacked(text, ref);
  } catch {
    return undefined;
  }
}

export async function readBranchBase(
  ctx: GitContext,
  project: ProjectLocator,
  options: (ScopeOptions & { base?: string }) | undefined,
): Promise<BranchBase | null> {
  const name = options?.base ?? parseDefaultBranch(options);
  if (name === null) return null;
  if (!RefNameSchema.safeParse(name).success) {
    throw new GitCoreError('invalid_argument', `invalid ref name: ${name}`);
  }
  for (const ref of candidatesFor(name)) {
    const oid = await readRefOid(project.commonDir, ref);
    if (oid === undefined) return viaGit(ctx, project, name);
    if (oid !== null) return { name, ref, oid };
  }
  return null;
}

async function viaGit(
  ctx: GitContext,
  project: ProjectLocator,
  name: string,
): Promise<BranchBase | null> {
  await ctx.ensureSupported();
  const repo = await projectRepoFor(ctx, project);
  const resolved = await resolveRefName(ctx, repo, name);
  return resolved ? { name: resolved.name, ref: resolved.ref, oid: resolved.oid } : null;
}
