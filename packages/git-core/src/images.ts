import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { GitChangedFile, GitFileDiff } from '@octopus-diff/contracts';
import type { GitContext, RepoInfo } from './context.js';
import { openRegularFile } from './fs-utils.js';
import type { RawEntry } from './parse/diff-output.js';
import type { ScopePlan } from './scope.js';
import { absolutePathBuffer } from './untracked.js';

const LIMIT = 10 * 1024 * 1024;
type Preview = NonNullable<GitFileDiff['images']>['before'];

function preview(bytes: Buffer): Preview {
  const hex = bytes.subarray(0, 12).toString('hex');
  const mime = hex.startsWith('89504e470d0a1a0a')
    ? 'image/png'
    : hex.startsWith('ffd8ff')
      ? 'image/jpeg'
      : /^474946383[79]61/.test(hex)
        ? 'image/gif'
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
          ? 'image/webp'
          : hex.startsWith('424d')
            ? 'image/bmp'
            : null;
  return mime ? { mime, base64: bytes.toString('base64'), byteLength: bytes.length } : null;
}

/** Read only the two sides Git selected; never resolve a client-supplied revision/path. */
export async function imageComparison(
  ctx: GitContext,
  repo: RepoInfo,
  plan: ScopePlan,
  entry: RawEntry | null,
  file: Pick<GitChangedFile, 'path' | 'oldMode' | 'newMode' | 'status'>,
  untrackedKey?: string,
): Promise<GitFileDiff['images']> {
  if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(file.path)) return undefined;
  let warning: string | undefined;
  async function blob(oid: string | undefined, mode: string | null): Promise<Preview> {
    if (
      !mode ||
      !/^100(644|755)$/.test(mode) ||
      !oid ||
      !/^[a-f0-9]{40,64}$/.test(oid) ||
      /^0+$/.test(oid)
    )
      return null;
    const size = await ctx.git(repo, ['cat-file', '-s', oid]);
    if (Number(size.stdout.toString().trim()) > LIMIT) {
      warning = 'Images larger than 10 MiB are not previewed.';
      return null;
    }
    return preview(
      (await ctx.git(repo, ['cat-file', 'blob', oid], { maxOutputBytes: LIMIT })).stdout,
    );
  }
  async function working(): Promise<Preview> {
    if (!file.newMode || !/^100(644|755)$/.test(file.newMode)) return null;
    const target = absolutePathBuffer(repo.cwd, untrackedKey ?? entry?.path ?? '');
    // Refuse links outside the worktree, including symlinked parent directories.
    const resolved = await realpath(target);
    const relative = path.relative(repo.cwd, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      return null;
    const handle = await openRegularFile(target, { noFollow: true });
    if (!handle) return null;
    try {
      const size = (await handle.stat()).size;
      if (size > LIMIT) {
        warning = 'Images larger than 10 MiB are not previewed.';
        return null;
      }
      const buffer = Buffer.alloc(size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > size) {
        warning = 'Image changed while loading. Refresh to try again.';
        return null;
      }
      return preview(buffer.subarray(0, offset));
    } finally {
      await handle.close();
    }
  }
  async function safe(read: () => Promise<Preview>): Promise<Preview> {
    try {
      return await read();
    } catch {
      warning = 'An image could not be read. Refresh to try again.';
      return null;
    }
  }
  if (file.status === 'conflicted')
    return { before: null, after: null, warning: 'Resolve the conflict to compare these images.' };
  const before = await safe(() => blob(entry?.srcOid, file.oldMode));
  const after = await safe(() =>
    plan.vsWorktree || plan.kind === 'unstaged' ? working() : blob(entry?.dstOid, file.newMode),
  );
  if (!before && !after && !warning) return undefined;
  return { before, after, ...(warning ? { warning } : {}) };
}
