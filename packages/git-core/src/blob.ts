import {
  BLOB_MAX_BYTES_DEFAULT,
  type BlobRead,
  type BlobReadOptions,
  BlobReadOptionsSchema,
  GitCoreError,
  isGitCoreError,
  type WorktreeLocator,
} from '@octopus-diff/contracts';
import type { GitContext } from './context.js';

/** git's binary heuristic: a NUL byte within the first 8000 bytes (xdiff FIRST_FEW_BYTES). */
const BINARY_SNIFF_BYTES = 8000;

/** Stderr of `cat-file` for an id that is not in the object database. */
const MISSING_OBJECT = /could not get object info|not a valid object name|bad file|bad object/i;

function missing(oid: string, cause: unknown): GitCoreError {
  return new GitCoreError('not_found', `no object ${oid} in this repository`, {}, { cause });
}

/**
 * Reads one blob by full object id for the live feed (#37), at most `maxBytes` (default 1 MiB).
 *
 * Read-only and bounded: `cat-file -t` must say `blob` (a tree, commit or tag is refused), then
 * `cat-file blob` runs with the output cap set to `maxBytes`; only when that cap trips is
 * `cat-file -s` asked for the real size. No filters, textconv or working tree are involved, and
 * the id is validated as a full object id first, so it can never be read as an option or a ref.
 * A deleted tracked file's blob id comes from `git status` (`hI` for `.D`, `hH` for `D.`); the
 * object stays readable after a commit or reset until `git gc` prunes it.
 */
export async function readBlob(
  ctx: GitContext,
  worktree: WorktreeLocator,
  input: BlobReadOptions,
): Promise<BlobRead> {
  const parsed = BlobReadOptionsSchema.safeParse(input);
  if (!parsed.success) {
    throw new GitCoreError(
      'invalid_argument',
      `invalid blob read: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  const { oid } = parsed.data;
  const maxBytes = parsed.data.maxBytes ?? BLOB_MAX_BYTES_DEFAULT;
  await ctx.ensureSupported();
  const repo = await ctx.repo(worktree.path);

  let type: string;
  try {
    type = (await ctx.git(repo, ['cat-file', '-t', oid])).stdout.toString('utf8').trim();
  } catch (error) {
    if (isGitCoreError(error, 'git_failed') && MISSING_OBJECT.test(error.details.stderr ?? '')) {
      throw missing(oid, error);
    }
    throw error;
  }
  if (type !== 'blob') {
    throw new GitCoreError('invalid_argument', `object ${oid} is a ${type}, not a blob`);
  }

  let bytes: Buffer;
  try {
    bytes = (await ctx.git(repo, ['cat-file', 'blob', oid], { maxOutputBytes: maxBytes })).stdout;
  } catch (error) {
    if (isGitCoreError(error, 'output_too_large')) {
      const size = Number(
        (await ctx.git(repo, ['cat-file', '-s', oid])).stdout.toString('utf8').trim(),
      );
      return {
        oid,
        kind: 'too_large',
        size: Number.isFinite(size) ? size : maxBytes + 1,
        maxBytes,
        content: null,
      };
    }
    if (isGitCoreError(error, 'git_failed') && MISSING_OBJECT.test(error.details.stderr ?? '')) {
      // Pruned between the two calls.
      throw missing(oid, error);
    }
    throw error;
  }
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { oid, kind: 'binary', size: bytes.length, maxBytes, content: null };
  }
  return { oid, kind: 'text', size: bytes.length, maxBytes, content: bytes.toString('utf8') };
}
