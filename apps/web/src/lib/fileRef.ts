import type { ChangedFile } from '@octopus-diff/contracts';

/** Identifies one changed file in one worktree (scope is global UI state). */
export interface FileRef {
  worktreeId: string;
  path: string;
  rawPath?: string | undefined;
}

/** Stable string key for a file (rawPath wins over path, as in the contract). */
export function fileRefKey(ref: FileRef): string {
  return `${ref.worktreeId}\u0000${ref.rawPath ?? ref.path}`;
}

export function toFileRef(
  worktreeId: string,
  file: Pick<ChangedFile, 'path' | 'rawPath'>,
): FileRef {
  return file.rawPath
    ? { worktreeId, path: file.path, rawPath: file.rawPath }
    : { worktreeId, path: file.path };
}

export function sameFile(a: FileRef | null | undefined, b: FileRef | null | undefined): boolean {
  if (!a || !b) return false;
  return fileRefKey(a) === fileRefKey(b);
}
