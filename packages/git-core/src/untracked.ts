import { createHash, type Hash } from 'node:crypto';
import { lstat, readlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { bstrFromBuffer, bstrToBuffer } from './bstr.js';
import type { ObjectFormat } from './context.js';
import { LruCache, mapLimit, openRegularFile, readFileHead } from './fs-utils.js';
import { hashParts, PATCH_HASH_LENGTH, PatchHasher } from './hash.js';

/** git's binary heuristic: a NUL byte within the first 8000 bytes (xdiff FIRST_FEW_BYTES). */
export const BINARY_SNIFF_BYTES = 8000;
const READ_CONCURRENCY = 16;
/** Files up to this size are read once into memory; larger ones are streamed twice. */
const READ_CHUNK = 1024 * 1024;

/**
 * The `diff` attribute of a path as `git check-attr` reports it: `set` (always text), `unset`
 * (binary, e.g. from the `binary` macro or `-diff`), `unspecified`, or a driver name.
 */
export type DiffAttribute = string;

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
  /**
   * Change detector: `size:mtimeNs:ctimeNs:ino:mode`, or `missing`; for a nested repository
   * also its HEAD (which moves without touching the directory's own stat data).
   */
  statSig: string;
  /** Nested repository: the commit its HEAD points to, when it can be resolved. */
  headSha: string | null;
  patchHash: string;
}

interface ContentFacts {
  /** Everything the facts depend on besides the content: stat signature, mode, attributes. */
  sig: string;
  binary: boolean;
  lines: number;
  patchHash: string;
}

export type UntrackedCache = LruCache<string, ContentFacts>;

export function createUntrackedCache(): UntrackedCache {
  return new LruCache<string, ContentFacts>(20_000);
}

export interface InspectOptions {
  /**
   * Read file contents (line counts and content-based patchHash). False when the worktree has
   * more untracked files than `maxUntrackedFiles`: then every file is fingerprinted by stat,
   * so a file's hash never depends on its position among the others.
   */
  readContent: boolean;
  /** Platforms without an executable bit report 100644 (git's core.fileMode=false). */
  executableBit: boolean;
  /** Files above this size are binary, as git's diff treats them (`core.bigFileThreshold`). */
  bigFileThreshold: number;
  objectFormat: ObjectFormat;
  /** `diff` attribute per key (bstr); missing keys are `unspecified`. */
  diffAttributes?: ReadonlyMap<string, DiffAttribute>;
}

/** Absolute path of a repo-relative bstr path, as a Buffer (works for non-UTF-8 names). */
export function absolutePathBuffer(root: string, key: string): Buffer {
  return Buffer.concat([Buffer.from(root + path.sep, 'utf8'), bstrToBuffer(key)]);
}

async function readContent(file: Buffer): Promise<Buffer> {
  const handle = await openRegularFile(file, { noFollow: true });
  if (!handle) throw new Error('not a regular file');
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------------------------
// The canonical new-file patch
// ---------------------------------------------------------------------------------------------

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

function blobHasher(format: ObjectFormat, size: number): Hash {
  return createHash(format === 'sha256' ? 'sha256' : 'sha1').update(`blob ${size}\u0000`);
}

function nullOid(format: ObjectFormat): string {
  return '0'.repeat(format === 'sha256' ? 64 : 40);
}

/** `diff --git` … `index` lines of a new file (bstr). */
function newFileHeader(key: string, mode: string, oid: string, format: ObjectFormat): string {
  const quotedA = quotePathName(`a/${key}`);
  const quotedB = quotePathName(`b/${key}`);
  return `diff --git ${quotedA} ${quotedB}\nnew file mode ${mode}\nindex ${nullOid(format)}..${oid}\n`;
}

function binaryLine(key: string): string {
  return `Binary files /dev/null and ${quotePathName(`b/${key}`)} differ\n`;
}

/** `---` / `+++` / hunk header lines for a new text file with `count` lines (bstr). */
function textPrelude(key: string, count: number): string {
  // git appends a TAB to the +++ line when the (unquoted) name contains a space.
  const tab = key.includes(' ') ? '\t' : '';
  return `--- /dev/null\n+++ ${quotePathName(`b/${key}`)}${tab}\n@@ -0,0 +1${count === 1 ? '' : `,${count}`} @@\n`;
}

const NO_NEWLINE = '\n\\ No newline at end of file\n';

/** Writes `+`-prefixed lines of new-file content to a hasher, chunk by chunk. */
class AddedLines {
  private atLineStart = true;

  constructor(private readonly out: PatchHasher) {}

  write(chunk: Uint8Array): void {
    let start = 0;
    while (start < chunk.length) {
      if (this.atLineStart) this.out.update('+');
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline + 1;
      this.out.updateBytes(chunk.subarray(start, end));
      this.atLineStart = newline >= 0;
      start = end;
    }
  }

  end(): void {
    if (!this.atLineStart) this.out.update(NO_NEWLINE);
  }
}

/**
 * Synthesizes the new-file patch git prints for an untracked file: exactly the text of
 * `git diff --no-index /dev/null <path>`, and of `git diff HEAD -- <path>` after
 * `git add -N` or `git add` (with `--full-index`), as a bstr. `binary` defaults to git's NUL
 * sniff; pass the verdict from the `diff` attribute when there is one. Content conversions on
 * `git add` (eol / text / filters / working-tree-encoding) are not applied.
 */
export function synthesizeNewFilePatch(
  key: string,
  mode: string,
  content: Buffer,
  format: ObjectFormat,
  binary?: boolean,
): string {
  const oid = blobHasher(format, content.length).update(content).digest('hex');
  let out = newFileHeader(key, mode, oid, format);
  if (content.length === 0) return out;
  if (binary ?? content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return out + binaryLine(key);
  const text = bstrFromBuffer(content);
  const lines = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  if (endsWithNewline) lines.pop();
  out += textPrelude(key, lines.length);
  out += lines.map((line) => `+${line}\n`).join('');
  if (!endsWithNewline) out += '\\ No newline at end of file\n';
  return out;
}

/** The new-file patch of a nested repository once added as a gitlink (bstr). */
export function synthesizeGitlinkPatch(key: string, sha: string, format: ObjectFormat): string {
  return `${newFileHeader(key, '160000', sha, format)}${textPrelude(key, 1)}+Subproject commit ${sha}\n`;
}

function hashOfText(text: string): string {
  const hasher = new PatchHasher('patch');
  hasher.update(text);
  return hasher.digest();
}

// ---------------------------------------------------------------------------------------------
// Inspecting untracked files
// ---------------------------------------------------------------------------------------------

/** Binary verdict from the `diff` attribute; null when git sniffs the content. */
export function attributeBinary(attribute: DiffAttribute | undefined): boolean | null {
  if (attribute === 'unset') return true;
  if (attribute === 'set') return false;
  return null;
}

class ContentChanged extends Error {}

/**
 * Reads a file and computes line count, binary verdict and the patchHash of its canonical
 * new-file patch (the PatchHasher digest `listChangedFiles` computes for the same file once
 * it is added). Files up to 1 MiB are read once; larger ones are streamed twice (the patch
 * starts with the blob id and the line count), and rejected if they change in between.
 */
async function factsFromFile(
  file: Buffer,
  key: string,
  mode: string,
  size: number,
  sig: string,
  options: InspectOptions,
  attribute: DiffAttribute | undefined,
): Promise<ContentFacts> {
  const handle = await openRegularFile(file, { noFollow: true });
  if (!handle) throw new ContentChanged();
  try {
    const first = blobHasher(options.objectFormat, size);
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK, Math.max(size, 1)));
    let total = 0;
    let lines = 0;
    let sniffedNul = false;
    let last = -1;
    let whole: Buffer | null = null;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      first.update(chunk);
      if (total < BINARY_SNIFF_BYTES && chunk.subarray(0, BINARY_SNIFF_BYTES - total).includes(0)) {
        sniffedNul = true;
      }
      for (let index = chunk.indexOf(10); index >= 0; index = chunk.indexOf(10, index + 1)) {
        lines += 1;
      }
      last = chunk[bytesRead - 1] as number;
      if (total === 0 && bytesRead === size) whole = Buffer.from(chunk);
      total += bytesRead;
    }
    if (total !== size) throw new ContentChanged();
    if (total > 0 && last !== 10) lines += 1;
    const oid = first.digest('hex');
    // git diffs files above core.bigFileThreshold as binary, unless the attribute says text.
    const binary = attributeBinary(attribute) ?? (sniffedNul || total > options.bigFileThreshold);

    const hasher = new PatchHasher('patch');
    hasher.update(newFileHeader(key, mode, oid, options.objectFormat));
    if (total > 0 && binary) hasher.update(binaryLine(key));
    else if (total > 0) {
      hasher.update(textPrelude(key, lines));
      const added = new AddedLines(hasher);
      if (whole) added.write(whole);
      else {
        const again = blobHasher(options.objectFormat, size);
        let position = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (bytesRead === 0) break;
          const chunk = buffer.subarray(0, bytesRead);
          again.update(chunk);
          added.write(chunk);
          position += bytesRead;
        }
        if (position !== size || again.digest('hex') !== oid) throw new ContentChanged();
      }
      added.end();
    }
    return { sig, binary, lines: binary ? 0 : lines, patchHash: hasher.digest() };
  } finally {
    await handle.close();
  }
}

function factsForLink(
  target: Buffer,
  key: string,
  sig: string,
  format: ObjectFormat,
): ContentFacts {
  const binary = target.subarray(0, BINARY_SNIFF_BYTES).includes(0);
  return {
    sig,
    binary,
    lines: binary ? 0 : target.length > 0 ? 1 : 0,
    patchHash: hashOfText(synthesizeNewFilePatch(key, '120000', target, format, binary)),
  };
}

/**
 * Inspects untracked files: type, mode, binary-ness, line count and a patchHash. `keys` are
 * bstr paths as git status prints them (nested repositories end in `/`).
 *
 * The patchHash of a file whose content is read is the hash of its canonical new-file patch,
 * so it equals the patchHash the same file gets in the working scope after `git add -N` or
 * `git add` (F4), when adding does not convert its content. Without reading (over
 * `maxUntrackedFiles`, above the big-file threshold, unreadable) it is derived from the stat
 * signature, which still changes whenever the file is rewritten. A nested repository's hash
 * follows its HEAD.
 */
export async function inspectUntracked(
  root: string,
  keys: readonly string[],
  cache: UntrackedCache,
  options: InspectOptions,
): Promise<UntrackedInfo[]> {
  return mapLimit(keys, READ_CONCURRENCY, async (key) => inspectOne(root, key, cache, options));
}

function statHash(mode: string, key: string, statSig: string): string {
  return hashParts(['untracked-stat', mode, key, statSig], PATCH_HASH_LENGTH);
}

async function inspectOne(
  root: string,
  rawKey: string,
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
      headSha: null,
      patchHash: hashParts(['untracked-missing', key], PATCH_HASH_LENGTH),
    };
  }
  const size = Number(info.size);
  const statSig = `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}:${info.mode}`;

  if (info.isDirectory()) {
    // A nested repository (git prints it as `dir/` and does not descend into it). Its own
    // stat data does not change when it commits, so its HEAD is part of the signature.
    const head = await nestedRepoHead(file);
    return {
      key,
      kind: 'directory',
      mode: '160000',
      size: 0,
      binary: false,
      lines: null,
      read: false,
      statSig: `${statSig}|${head.fingerprint}`,
      headSha: head.sha,
      patchHash: head.sha
        ? hashOfText(synthesizeGitlinkPatch(key, head.sha, options.objectFormat))
        : hashParts(['untracked-repo', key, head.fingerprint], PATCH_HASH_LENGTH),
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
  const base = { key, kind, mode, size, statSig, headSha: null };

  // Files above git's big-file threshold are binary for git anyway: fingerprint them by stat
  // instead of reading them (they may be huge).
  const big = kind === 'file' && size > options.bigFileThreshold;
  if (kind === 'other' || !options.readContent || big) {
    return {
      ...base,
      binary: big,
      lines: null,
      read: false,
      patchHash: statHash(mode, key, statSig),
    };
  }

  // Symlinks get no diff driver from attributes (git only looks them up for regular files).
  const attribute = kind === 'file' ? options.diffAttributes?.get(key) : undefined;
  const sig = `${statSig}|${mode}|${attribute ?? ''}|${options.objectFormat}`;
  const cacheKey = bstrFromBuffer(file);
  const cached = cache.get(cacheKey);
  const facts =
    cached && cached.sig === sig
      ? cached
      : await (kind === 'symlink'
          ? readlink(file, { encoding: 'buffer' }).then((target) =>
              factsForLink(target, key, sig, options.objectFormat),
            )
          : factsFromFile(file, key, mode, size, sig, options, attribute)
        ).catch(() => null);
  if (!facts) {
    return {
      ...base,
      binary: false,
      lines: null,
      read: false,
      patchHash: statHash(mode, key, statSig),
    };
  }
  cache.set(cacheKey, facts);
  return {
    ...base,
    binary: facts.binary,
    lines: facts.binary ? null : facts.lines,
    read: true,
    patchHash: facts.patchHash,
  };
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

/**
 * The canonical patch text of an untracked entry (bstr), or null when it cannot be produced.
 * For an entry whose content was read, its hash is `info.patchHash`. Entries fingerprinted by
 * stat (over `maxUntrackedFiles`) are still displayed, with git's binary rules.
 */
export async function untrackedPatchText(
  root: string,
  info: UntrackedInfo,
  format: ObjectFormat,
  attribute: DiffAttribute | undefined,
): Promise<string | null> {
  if (info.kind === 'directory') {
    return info.headSha ? synthesizeGitlinkPatch(info.key, info.headSha, format) : null;
  }
  if ((info.kind !== 'file' && info.kind !== 'symlink') || info.mode === null) return null;
  const content = await readUntrackedContent(root, info);
  if (content === null) return null;
  const binary = info.read
    ? info.binary
    : ((info.kind === 'file' ? attributeBinary(attribute) : null) ?? undefined);
  return synthesizeNewFilePatch(info.key, info.mode, content, format, binary);
}

// ---------------------------------------------------------------------------------------------
// Nested repository HEAD (no git process: these may be many, and the summary is hot)
// ---------------------------------------------------------------------------------------------

const SMALL_FILE = 4096;
const PACKED_REFS_MAX = 4 * 1024 * 1024;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** A loose ref name git-core is willing to read as a file (no traversal, no odd bytes). */
function isPlainRefName(ref: string): boolean {
  if (!ref.startsWith('refs/') || ref.split('/').some((part) => part === '' || part === '..')) {
    return false;
  }
  for (let i = 0; i < ref.length; i += 1) {
    const code = ref.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || '~^:?*[\\'.includes(ref[i] as string)) return false;
  }
  return true;
}

export interface NestedHead {
  /** The commit HEAD resolves to (loose refs, packed-refs), or null (unborn, reftable, ...). */
  sha: string | null;
  /** Changes whenever HEAD moves (exact sha when known, else the ref files' contents/stat). */
  fingerprint: string;
}

async function readSmall(file: string, max = SMALL_FILE): Promise<string | null> {
  const content = await readFileHead(bstrToBuffer(file), max);
  return content === null ? null : bstrFromBuffer(content);
}

async function refStorageSig(file: string): Promise<string> {
  try {
    const info = await stat(bstrToBuffer(file), { bigint: true });
    return `${info.size}:${info.mtimeNs}:${info.ino}`;
  } catch {
    return 'none';
  }
}

// Paths below are bstrs (latin1 strings holding raw bytes, so non-UTF-8 names work); path.join
// and path.resolve only look at `/` and `.`, which are single bytes in every encoding git allows.

/** The git dir of a nested repository at `dir` (bstr): `.git` directory or gitfile target. */
async function nestedGitDir(dir: string): Promise<string | null> {
  const entry = path.join(dir, '.git');
  try {
    const info = await stat(bstrToBuffer(entry));
    if (info.isDirectory()) return entry;
    if (!info.isFile()) return null;
  } catch {
    return null;
  }
  const text = await readSmall(entry);
  if (!text?.startsWith('gitdir: ')) return null;
  const target = text.slice('gitdir: '.length).replace(/[\r\n]+$/, '');
  if (!target || target.includes('\n') || target.includes('\u0000')) return null;
  return path.resolve(dir, target);
}

/**
 * Resolves the HEAD of the repository at `dir` (an absolute path, raw bytes) by reading its
 * git dir directly: `HEAD`, symrefs (up to 5 levels), loose refs (in the git dir, then the
 * common dir), then `packed-refs`. Reftable repositories and anything unusual yield
 * `sha: null` with a fingerprint of the ref storage that still changes on every ref update.
 */
export async function nestedRepoHead(dirBuffer: Buffer): Promise<NestedHead> {
  const dir = bstrFromBuffer(dirBuffer);
  const gitDir = await nestedGitDir(dir);
  if (gitDir === null) return { sha: null, fingerprint: 'no-git-dir' };
  const commonText = await readSmall(path.join(gitDir, 'commondir'));
  const commonDir = commonText ? path.resolve(gitDir, commonText.replace(/[\r\n]+$/, '')) : gitDir;
  const head = await readSmall(path.join(gitDir, 'HEAD'));
  if (head === null) return { sha: null, fingerprint: 'no-head' };

  let value = head.trim();
  const chain: string[] = [value];
  for (let depth = 0; depth < 5 && value.startsWith('ref: '); depth += 1) {
    const ref = value.slice('ref: '.length).trim();
    if (!isPlainRefName(ref)) break;
    const loose =
      (await readSmall(path.join(gitDir, ref))) ??
      (commonDir !== gitDir ? await readSmall(path.join(commonDir, ref)) : null);
    if (loose !== null) {
      value = loose.trim();
      chain.push(value);
      continue;
    }
    const packed = await readSmall(path.join(commonDir, 'packed-refs'), PACKED_REFS_MAX);
    const line = packed?.split('\n').find((candidate) => candidate.endsWith(` ${ref}`));
    value = line ? line.slice(0, line.indexOf(' ')) : `unresolved ${ref}`;
    chain.push(value);
    break;
  }
  if (OID.test(value)) return { sha: value, fingerprint: `sha:${value}` };
  // Unborn branch, reftable, or something odd: fingerprint the ref storage instead.
  const parts = [
    ...chain,
    await refStorageSig(path.join(commonDir, 'packed-refs')),
    (await readSmall(path.join(commonDir, 'reftable', 'tables.list'))) ?? 'none',
  ];
  return { sha: null, fingerprint: hashParts(parts, 32) };
}
