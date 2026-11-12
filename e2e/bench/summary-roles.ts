/**
 * Summary cost per worktree role of the large layouts (#43), measured with git-core in the bench
 * process once the daemon is stopped (nothing else runs): what one full refresh of each worktree
 * costs cold (a new git-core, as at daemon startup) and warm (a kept state: the reconciliation,
 * focus, a poll, a git-dir event), what a later one-file edit costs (incremental), and how big the
 * worktree's file list is. The daemon's own edit → SSE numbers are in the refresh table.
 */
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGitCore } from '@octopus-diff/git-core';

export interface RoleSummaryTimes {
  role: string;
  untracked: number;
  /** Untracked files counted but not inspected or listed (`untrackedOmitted.count`), 0 if none. */
  omitted: number;
  coldMs: number;
  /** Full refreshes with a kept state. */
  warmMs: number[];
  /** Incremental refreshes after a one-line append to a tracked file. */
  editMs: number[];
  /** The working list (`summaryState` of the last summary): rows and JSON bytes. */
  listRows: number;
  listBytes: number;
}

const ms = (start: number): number => Math.round((performance.now() - start) * 10) / 10;

export async function summaryRoles(
  worktrees: ReadonlyArray<{ path: string; role: string }>,
  env: Readonly<Record<string, string>>,
  samples = 3,
): Promise<RoleSummaryTimes[]> {
  const out: RoleSummaryTimes[] = [];
  for (const { path, role } of worktrees) {
    const core = createGitCore({ env: { ...env } });
    const locator = { projectId: 'bench', worktreeId: role, path };
    try {
      let start = performance.now();
      let summary = await core.getSummary(locator, { snapshot: true });
      const coldMs = ms(start);
      const warmMs: number[] = [];
      for (let i = 0; i < samples; i++) {
        start = performance.now();
        summary = await core.getSummary(locator, { snapshot: true });
        warmMs.push(ms(start));
      }
      const editMs: number[] = [];
      for (let i = 0; i < samples; i++) {
        await appendFile(join(path, 'README.md'), `summary bench ${i}\n`);
        start = performance.now();
        summary = await core.getSummary(locator, { snapshot: true, changedPaths: ['README.md'] });
        editMs.push(ms(start));
      }
      const files = await core.listChangedFiles(
        locator,
        { kind: 'working' },
        { summaryState: summary.stateHash },
      );
      out.push({
        role,
        untracked: summary.counts.untracked,
        omitted: summary.untrackedOmitted?.count ?? 0,
        coldMs,
        warmMs,
        editMs,
        listRows: files.length,
        listBytes: Buffer.byteLength(JSON.stringify(files)),
      });
    } finally {
      await core.dispose();
    }
  }
  return out;
}
