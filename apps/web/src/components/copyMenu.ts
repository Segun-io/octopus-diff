/**
 * The "Copy" menu groups shared by the sidebar, the file list, the tree, the diff header and the
 * Overview (docs/COPY-TOOLS.md §4 step 2). Item test ids are stable: e2e relies on them.
 */
import type { Worktree } from '@octopus-diff/contracts';
import { branchCopyText, fileCopyTexts, shaCopyText } from '../lib/copyFormat.ts';
import { escapeSuspicious, hasSuspicious } from '../lib/unicode.ts';
import type { CopyFn } from '../state/copy.ts';
import type { MenuItem, MenuPosition } from './ContextMenu.tsx';

export const COPY_TEST_IDS = {
  branch: 'copy-branch',
  worktreePath: 'copy-worktree-path',
  sha: 'copy-sha',
  path: 'copy-path',
  oldPath: 'copy-old-path',
  name: 'copy-name',
  absolutePath: 'copy-absolute-path',
  fileDiff: 'copy-file-diff',
  /** The icon button next to the path in the diff header. */
  pathButton: 'copy-path-button',
  /** The diff header's "more" (⋯) menu button. */
  diffMenuButton: 'diff-header-menu',
  commitButton: 'copy-commit-button',
  toast: 'copy-toast',
  selectionBar: 'copy-selection-bar',
  selectionCopy: 'copy-selection-plain',
  selectionMarkdown: 'copy-selection-markdown',
} as const;

/** Copy branch name / worktree path / HEAD commit id for a worktree. */
export function worktreeCopyItems(
  worktree: Pick<Worktree, 'branch' | 'path' | 'headSha'>,
  copy: CopyFn,
  at?: MenuPosition,
): MenuItem[] {
  const branch = branchCopyText(worktree);
  const items: MenuItem[] = [
    {
      id: 'copy-branch',
      label: 'Copy branch name',
      testId: COPY_TEST_IDS.branch,
      disabled: branch === null,
      title: branch === null ? 'Detached HEAD' : undefined,
      onSelect: () =>
        branch !== null &&
        copy(branch, {
          what: 'branch name',
          escaped: hasSuspicious(worktree.branch ?? ''),
          at,
        }),
    },
    {
      id: 'copy-worktree-path',
      label: 'Copy worktree path',
      testId: COPY_TEST_IDS.worktreePath,
      onSelect: () =>
        copy(escapeSuspicious(worktree.path), {
          what: 'worktree path',
          escaped: hasSuspicious(worktree.path),
          at,
        }),
    },
  ];
  const sha = worktree.headSha;
  if (sha) {
    items.push({
      id: 'copy-sha',
      label: `Copy commit id (${shaCopyText(sha)})`,
      testId: COPY_TEST_IDS.sha,
      onSelect: () => copy(sha, { what: 'commit id', at }),
    });
  }
  return items;
}

/** Copy path / old path / file name / absolute path for a changed file. */
export function fileCopyItems(
  file: { path: string; oldPath?: string | null },
  worktreePath: string | undefined,
  copy: CopyFn,
  at?: MenuPosition,
): MenuItem[] {
  const t = fileCopyTexts(file, worktreePath ?? '');
  const items: MenuItem[] = [
    {
      id: 'copy-path',
      label: 'Copy path',
      testId: COPY_TEST_IDS.path,
      onSelect: () => copy(t.relative, { what: 'path', escaped: t.escaped, at }),
    },
  ];
  if (t.oldRelative !== undefined) {
    const old = t.oldRelative;
    items.push({
      id: 'copy-old-path',
      label: 'Copy old path',
      testId: COPY_TEST_IDS.oldPath,
      onSelect: () => copy(old, { what: 'old path', escaped: t.escaped, at }),
    });
  }
  items.push({
    id: 'copy-name',
    label: 'Copy file name',
    testId: COPY_TEST_IDS.name,
    onSelect: () => copy(t.name, { what: 'file name', escaped: t.escaped, at }),
  });
  if (worktreePath) {
    items.push({
      id: 'copy-absolute-path',
      label: 'Copy absolute path',
      testId: COPY_TEST_IDS.absolutePath,
      onSelect: () => copy(t.absolute, { what: 'absolute path', escaped: t.escaped, at }),
    });
  }
  return items;
}

/** Marks the first item of a group with a separator (the "Copy" group under other actions). */
export function separated(items: MenuItem[]): MenuItem[] {
  return items.map((item, i) => (i === 0 ? { ...item, separator: true } : item));
}
