import {
  type DiffScope,
  type GitChangedFile,
  GitChangedFileSchema,
  type GitCore,
  type GitFileDiff,
  GitFileDiffSchema,
  type WorktreeLocator,
  WorktreeSummarySchema,
} from '@octopus-diff/contracts';
import { expect } from 'vitest';
import { hashId } from '../../src/index.js';

/** A locator for a worktree root (ids computed like git-core does). */
export function locator(worktreePath: string, commonDir = worktreePath): WorktreeLocator {
  return { projectId: hashId(commonDir), worktreeId: hashId(worktreePath), path: worktreePath };
}

/** Lists files and validates every entry against the contract schema. */
export async function listFiles(
  core: GitCore,
  wt: WorktreeLocator,
  scope: DiffScope,
  options?: Parameters<GitCore['listChangedFiles']>[2],
): Promise<GitChangedFile[]> {
  const files = await core.listChangedFiles(wt, scope, options);
  for (const file of files) GitChangedFileSchema.parse(file);
  return files;
}

export async function fileDiff(
  core: GitCore,
  wt: WorktreeLocator,
  scope: DiffScope,
  file: { path: string; rawPath?: string },
  options?: Parameters<GitCore['getFileDiff']>[3],
): Promise<GitFileDiff> {
  const selector = file.rawPath ? { path: file.path, rawPath: file.rawPath } : { path: file.path };
  const diff = await core.getFileDiff(wt, scope, selector, options);
  GitFileDiffSchema.parse(diff);
  return diff;
}

export function byPath(files: readonly GitChangedFile[]): Map<string, GitChangedFile> {
  return new Map(files.map((file) => [file.path, file]));
}

export function expectFile(
  files: readonly GitChangedFile[],
  path: string,
  expected: Partial<GitChangedFile>,
): GitChangedFile {
  const file = files.find((candidate) => candidate.path === path);
  expect(file, `expected ${path} in ${files.map((f) => f.path).join(', ')}`).toBeDefined();
  expect(file).toMatchObject(expected);
  return file as GitChangedFile;
}

/**
 * For every listed file: getFileDiff returns the same identity and patchHash, also with view
 * options (ignoreWhitespace, other context), which must not change patchHash.
 */
export async function expectConsistentHashes(
  core: GitCore,
  wt: WorktreeLocator,
  scope: DiffScope,
  files: readonly GitChangedFile[],
): Promise<void> {
  for (const file of files) {
    const plain = await fileDiff(core, wt, scope, file);
    expect(plain.patchHash, `patchHash of ${file.path} (${scope.kind})`).toBe(file.patchHash);
    expect(plain.status).toBe(file.status);
    expect(plain.path).toBe(file.path);
    expect(plain.oldPath).toBe(file.oldPath);
    expect(plain.binary).toBe(file.binary);
    expect(plain.additions).toBe(file.additions);
    expect(plain.deletions).toBe(file.deletions);
    const ws = await fileDiff(core, wt, scope, file, { ignoreWhitespace: true, contextLines: 0 });
    expect(ws.patchHash, `patchHash of ${file.path} with -w -U0`).toBe(file.patchHash);
    const wide = await fileDiff(core, wt, scope, file, { contextLines: 25 });
    expect(wide.patchHash, `patchHash of ${file.path} with -U25`).toBe(file.patchHash);
  }
}

export function expectSummary(value: unknown): void {
  WorktreeSummarySchema.parse(value);
}
