import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { readFileHead } from './fs-utils.js';

/**
 * Ref lookups from the files git keeps them in (#27, #29), so the hot paths spawn nothing: loose
 * refs (`<commonDir>/refs/...`), `packed-refs` and a worktree's `HEAD`. Every answer is one of:
 * the object id (a string); `null` when the ref certainly does not exist; `undefined` when the
 * files cannot tell (a symbolic ref, a reftable repository, a per-worktree ref namespace, an odd
 * or unreadable file). Callers fall back to git on `undefined`, so a file answer never disagrees
 * with what `for-each-ref` / `rev-parse` would say for the same ref.
 *
 * Read-only: files are only read, under the repository's git dirs, with ref names that passed
 * `RefNameSchema` or were checked here (no `..`, no empty or `.` components, no backslashes).
 */

export const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PACKED_CACHE_MAX = 16;
const REFTABLE_TTL_MS = 60_000;
const HEAD_MAX_BYTES = 4096;

/**
 * Ref namespaces git stores per worktree (in the worktree's own git dir, not the common dir):
 * those are never answered from the common dir's files.
 */
const PER_WORKTREE_PREFIXES = ['refs/bisect/', 'refs/worktree/', 'refs/rewritten/'];

interface PackedRefs {
  signature: string;
  /** The file's text, ending in a newline. */
  text: string;
}

const packedCache = new Map<string, PackedRefs>();
const reftableCache = new Map<string, { at: number; value: boolean }>();

/** Drops the module's file caches (tests, `dispose`). */
export function clearRefFileCaches(): void {
  packedCache.clear();
  reftableCache.clear();
}

/** `refs/heads/<n>`, `refs/remotes/<n>`, `refs/tags/<n>`: git-core's lookup order for a name. */
export function refCandidates(name: string): string[] {
  return name.startsWith('refs/')
    ? [name]
    : [`refs/heads/${name}`, `refs/remotes/${name}`, `refs/tags/${name}`];
}

function safeRefPath(ref: string): boolean {
  return (
    ref.startsWith('refs/') &&
    !PER_WORKTREE_PREFIXES.some((prefix) => ref.startsWith(prefix)) &&
    ref
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          !part.includes('\\') &&
          ![...part].some((ch) => ch.charCodeAt(0) < 0x20),
      )
  );
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

/** The object id a shared ref (`refs/...`) points at; see the module comment for the answers. */
export async function readRefOid(
  commonDir: string,
  ref: string,
): Promise<string | null | undefined> {
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

export interface FileRef {
  /** Display name, e.g. `main` or `origin/main`. */
  name: string;
  /** Full ref name, e.g. `refs/heads/main`. */
  ref: string;
  oid: string;
}

/**
 * `name` resolved like `resolveRefName` (heads, remotes, tags; first that exists), from files.
 * `name` must already have passed `RefNameSchema`.
 */
export async function resolveRefFromFiles(
  commonDir: string,
  name: string,
): Promise<FileRef | null | undefined> {
  for (const ref of refCandidates(name)) {
    const oid = await readRefOid(commonDir, ref);
    if (oid === undefined) return undefined;
    if (oid !== null) return { name, ref, oid };
  }
  return null;
}

/**
 * The target of a symbolic ref stored as a loose file (`ref: <target>`), e.g.
 * `refs/remotes/origin/HEAD`: the target ref; null when the ref does not exist or is not
 * symbolic (a packed or plain ref has no target); undefined when the files cannot tell.
 */
export async function readSymrefTarget(
  commonDir: string,
  ref: string,
): Promise<string | null | undefined> {
  if (!safeRefPath(ref)) return undefined;
  if (await isReftable(commonDir)) return undefined;
  let content: string;
  try {
    content = (await readFile(path.join(commonDir, ref), 'utf8')).trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null; // Symbolic refs are never packed.
    return undefined;
  }
  if (OID.test(content)) return null;
  if (!content.startsWith('ref: ')) return undefined;
  const target = content.slice('ref: '.length).trim();
  return safeRefPath(target) ? target : undefined;
}

export interface FileHead {
  /** The full ref HEAD points at (`refs/heads/<b>`), or null when detached. */
  ref: string | null;
  /** HEAD's commit id; null on an unborn branch. */
  sha: string | null;
}

/**
 * A worktree's HEAD from `<gitDir>/HEAD` and the ref files: what `symbolic-ref -q HEAD` and
 * `rev-parse --verify HEAD^{commit}` report. Undefined when the files cannot tell (reftable, a
 * symlinked or odd HEAD, a ref outside `refs/heads/`, an unreadable ref).
 */
export async function readHeadFromFiles(
  gitDir: string,
  commonDir: string,
): Promise<FileHead | undefined> {
  if (await isReftable(commonDir)) return undefined;
  const file = path.join(gitDir, 'HEAD');
  try {
    if (!(await lstat(file)).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const buffer = await readFileHead(file, HEAD_MAX_BYTES);
  if (buffer === null) return undefined;
  const content = buffer.toString('utf8').trim();
  if (OID.test(content)) return { ref: null, sha: content };
  if (!content.startsWith('ref: ')) return undefined;
  const ref = content.slice('ref: '.length).trim();
  if (!ref.startsWith('refs/heads/') || !safeRefPath(ref)) return undefined;
  const oid = await readRefOid(commonDir, ref);
  if (oid === undefined) return undefined;
  return { ref, sha: oid };
}
