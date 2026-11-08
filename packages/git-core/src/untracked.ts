import { createHash } from 'node:crypto';
import { lstat, open, readlink } from 'node:fs/promises';
import path from 'node:path';
import { bstrFromBuffer, bstrToBuffer } from './bstr.js';
import type { ObjectFormat } from './context.js';
import { LruCache, mapLimit } from './fs-utils.js';
import { hashParts, PATCH_HASH_LENGTH } from './hash.js';

/** git's binary heuristic: a NUL byte within the first 8000 bytes (xdiff FIRST_FEW_BYTES). */
export const BINARY_SNIFF_BYTES = 8000;
const READ_CONCURRENCY = 16;

export interface UntrackedInfo {
  /** Path (bstr), without the trailing `/` git prints for nested repositories. */
  key: string;
  kind: 'file' | 'symlink' | 'directory' | 'missing' | 'other';
  /** Git-style mode of the new file (null when missing). */
  mode: string | null;
  size: number;
  binary: boolean;
  /** Line count; null when binary, not read (over caps) or not a file. */
  lines: number | null;
  /** Content was read and hashed (under `maxUntrackedFiles` and the read limit). */
  read: boolean;
  /** `size:mtimeNs:ctimeNs:ino:mode`, or `missing`. */
  statSig: string;
  patchHash: string;
}

interface ContentFacts {
  sig: string;
  binary: boolean;
  lines: number;
  contentHash: string;
}

export type UntrackedCache = LruCache<string, ContentFacts>;

export function createUntrackedCache(): UntrackedCache {
  return new LruCache<string, ContentFacts>(20_000);
}

export interface InspectOptions {
  /** Inspect at most this many files' contents (by position in the sorted untracked list). */
  maxFiles: number;
  /** Files larger than this are fingerprinted by stat only. */
  readLimit: number;
  /** Platforms without an executable bit report 100644 (git's core.fileMode=false). */
  executableBit: boolean;
}

/** Absolute path of a repo-relative bstr path, as a Buffer (works for non-UTF-8 names). */
export function absolutePathBuffer(root: string, key: string): Buffer {
  return Buffer.concat([Buffer.from(root + path.sep, 'utf8'), bstrToBuffer(key)]);
}

function countLines(content: Buffer): number {
  if (content.length === 0) return 0;
  let lines = 0;
  let index = content.indexOf(10);
  while (index >= 0) {
    lines += 1;
    index = content.indexOf(10, index + 1);
  }
  if (content[content.length - 1] !== 10) lines += 1;
  return lines;
}

async function readContent(file: Buffer): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function factsFor(content: Buffer, sig: string): ContentFacts {
  const sniff = content.subarray(0, BINARY_SNIFF_BYTES);
  const binary = sniff.includes(0);
  return {
    sig,
    binary,
    lines: binary ? 0 : countLines(content),
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
}

/**
 * Inspects untracked files: type, mode, binary-ness, line count and a patchHash. `keys` must be
 * in the sorted order used for the `maxFiles` cap, with `index` giving each key's position.
 *
 * patchHash of an untracked file is SHA-256 over (mode, path, SHA-256 of content): the new-file
 * patch is a pure function of those. Above the caps it is computed from the stat signature
 * instead (size, mtime, ctime, inode), which still changes whenever the file is rewritten.
 */
export async function inspectUntracked(
  root: string,
  items: ReadonlyArray<{ key: string; index: number }>,
  cache: UntrackedCache,
  options: InspectOptions,
): Promise<UntrackedInfo[]> {
  return mapLimit(items, READ_CONCURRENCY, async ({ key, index }) =>
    inspectOne(root, key, index, cache, options),
  );
}

async function inspectOne(
  root: string,
  rawKey: string,
  index: number,
  cache: UntrackedCache,
  options: InspectOptions,
): Promise<UntrackedInfo> {
  const key = rawKey.endsWith('/') ? rawKey.slice(0, -1) : rawKey;
  const file = absolutePathBuffer(root, key);
  let info: Awaited<ReturnType<typeof lstat>> & { mtimeNs: bigint; ctimeNs: bigint };
  try {
    info = (await lstat(file, { bigint: true })) as typeof info;
  } catch {
    return {
      key,
      kind: 'missing',
      mode: null,
      size: 0,
      binary: false,
      lines: null,
      read: false,
      statSig: 'missing',
      patchHash: hashParts(['untracked-missing', key], PATCH_HASH_LENGTH),
    };
  }
  const size = Number(info.size);
  const statSig = `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}:${info.mode}`;

  if (info.isDirectory()) {
    // A nested repository (git prints it as `dir/` and does not descend into it).
    return {
      key,
      kind: 'directory',
      mode: '160000',
      size: 0,
      binary: false,
      lines: null,
      read: false,
      statSig,
      patchHash: hashParts(['untracked-dir', key], PATCH_HASH_LENGTH),
    };
  }

  let kind: UntrackedInfo['kind'];
  let mode: string;
  if (info.isSymbolicLink()) {
    kind = 'symlink';
    mode = '120000';
  } else if (info.isFile()) {
    kind = 'file';
    mode = options.executableBit && (Number(info.mode) & 0o111) !== 0 ? '100755' : '100644';
  } else {
    kind = 'other';
    mode = '100644';
  }

  const canRead = kind !== 'other' && index < options.maxFiles && size <= options.readLimit;
  if (!canRead) {
    return {
      key,
      kind,
      mode,
      size,
      binary: false,
      lines: null,
      read: false,
      statSig,
      patchHash: hashParts(['untracked-stat', mode, key, statSig], PATCH_HASH_LENGTH),
    };
  }

  const cacheKey = bstrFromBuffer(file);
  let facts = cache.get(cacheKey);
  if (!facts || facts.sig !== statSig) {
    try {
      const content =
        kind === 'symlink' ? await readlink(file, { encoding: 'buffer' }) : await readContent(file);
      facts = factsFor(content, statSig);
      cache.set(cacheKey, facts);
    } catch {
      return {
        key,
        kind,
        mode,
        size,
        binary: false,
        lines: null,
        read: false,
        statSig,
        patchHash: hashParts(['untracked-stat', mode, key, statSig], PATCH_HASH_LENGTH),
      };
    }
  }
  return {
    key,
    kind,
    mode,
    size,
    binary: facts.binary,
    lines: facts.binary ? null : facts.lines,
    read: true,
    statSig,
    patchHash: hashParts(['untracked', mode, key, facts.contentHash], PATCH_HASH_LENGTH),
  };
}

function needsQuote(name: string): boolean {
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x22 || code === 0x5c) return true;
  }
  return false;
}
const C_ESCAPES: Record<string, string> = {
  '\x07': '\\a',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\v': '\\v',
  '\f': '\\f',
  '\r': '\\r',
  '"': '\\"',
  '\\': '\\\\',
};

/** git's `quote_c_style` with core.quotePath=false, on a bstr. */
export function quotePathName(name: string): string {
  if (!needsQuote(name)) return name;
  let out = '"';
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    const escaped = C_ESCAPES[ch];
    if (escaped) out += escaped;
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

function blobOid(content: Buffer, format: ObjectFormat): string {
  return createHash(format === 'sha256' ? 'sha256' : 'sha1')
    .update(`blob ${content.length}\u0000`)
    .update(content)
    .digest('hex');
}

/**
 * Synthesizes the new-file patch git prints for an untracked file (`git diff --no-index
 * /dev/null <path>` with `--full-index`), as a bstr. Used for paths that cannot be passed as
 * argv (not valid UTF-8). Does not apply .gitattributes.
 */
export function synthesizeNewFilePatch(
  key: string,
  mode: string,
  content: Buffer,
  format: ObjectFormat,
): string {
  const quotedA = quotePathName(`a/${key}`);
  const quotedB = quotePathName(`b/${key}`);
  const nullOid = '0'.repeat(format === 'sha256' ? 64 : 40);
  let out = `diff --git ${quotedA} ${quotedB}\nnew file mode ${mode}\n`;
  out += `index ${nullOid}..${blobOid(content, format)}\n`;
  if (content.length === 0) return out;
  const plusName = quotePathName(`b/${key}`);
  // git appends a TAB to the +++ line when the (unquoted) name contains a space.
  const tab = key.includes(' ') ? '\t' : '';
  if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return `${out}Binary files /dev/null and ${plusName} differ\n`;
  }
  const text = bstrFromBuffer(content);
  const lines = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  if (endsWithNewline) lines.pop();
  const count = lines.length;
  out += `--- /dev/null\n+++ ${plusName}${tab}\n`;
  out += `@@ -0,0 +1${count === 1 ? '' : `,${count}`} @@\n`;
  out += lines.map((line) => `+${line}\n`).join('');
  if (!endsWithNewline) out += '\\ No newline at end of file\n';
  return out;
}

export async function readUntrackedContent(
  root: string,
  info: UntrackedInfo,
): Promise<Buffer | null> {
  const file = absolutePathBuffer(root, info.key);
  try {
    if (info.kind === 'symlink') return await readlink(file, { encoding: 'buffer' });
    if (info.kind === 'file') return await readContent(file);
  } catch {
    return null;
  }
  return null;
}
