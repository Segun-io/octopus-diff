import {
  GitCoreError,
  SNAPSHOT_MAX_ENTRIES_DEFAULT,
  SNAPSHOT_MAX_ENTRIES_LIMIT,
  type SummaryOptions,
  type SummarySnapshot,
  type SummarySnapshotEntry,
} from '@octopus-diff/contracts';
import { decodeRepoPath } from './bstr.js';
import type { StatusEntry } from './parse/status.js';
import type { UntrackedInfo } from './untracked.js';

/**
 * The per-file snapshot of `getSummary` (live feed, #37). It only reshapes what the summary
 * computed anyway (the `git status` entries, the numstat counts, the lstat signatures and the
 * untracked inspection): it never runs git or reads a file.
 */

/** Resolves `SummaryOptions.snapshot` to an entry cap, or null when no snapshot was asked for. */
export function snapshotCap(options: SummaryOptions | undefined): number | null {
  const wanted = options?.snapshot;
  if (wanted === undefined || wanted === false) return null;
  const max = wanted === true ? undefined : wanted.maxEntries;
  if (max === undefined) return SNAPSHOT_MAX_ENTRIES_DEFAULT;
  if (!Number.isInteger(max) || max < 1 || max > SNAPSHOT_MAX_ENTRIES_LIMIT) {
    throw new GitCoreError(
      'invalid_argument',
      `snapshot.maxEntries must be an integer 1..${SNAPSHOT_MAX_ENTRIES_LIMIT}`,
    );
  }
  return max;
}

/** An empty snapshot (bare repositories have no worktree). */
export function emptySnapshot(): SummarySnapshot {
  return { entries: [], total: 0, truncated: false };
}

/** The object id as the contract has it: git prints the null id for "not on this side". */
function oidOrNull(oid: string): string | null {
  return oid.length === 0 || /^0+$/.test(oid) ? null : oid;
}

export interface SnapshotInput {
  /** Every `git status` entry (tracked and untracked; ignored ones are skipped). */
  entries: readonly StatusEntry[];
  /** Signature of a tracked path (bstr key) as hashed or measured by the summary. */
  signatureOf(key: string): string | undefined;
  /** numstat counts by tracked path (bstr); absent when numstat did not run for the path. */
  counts: ReadonlyMap<string, { added: number | null; deleted: number | null }>;
  /** The summary's inspection of the untracked files, in path order. */
  untracked: readonly UntrackedInfo[];
  cap: number;
}

function paths(key: string): Pick<SummarySnapshotEntry, 'path' | 'rawPath'> {
  const { path, rawPath } = decodeRepoPath(key);
  return rawPath === undefined ? { path } : { path, rawPath };
}

/** Tracked entries in status order, then untracked in path order; at most `cap` are built. */
export function buildSnapshot(input: SnapshotInput): SummarySnapshot {
  const tracked = input.entries.filter(
    (entry) => entry.kind !== 'untracked' && entry.kind !== 'ignored',
  );
  const total = tracked.length + input.untracked.length;
  const entries: SummarySnapshotEntry[] = [];

  for (const entry of tracked) {
    if (entries.length >= input.cap) break;
    const counts = input.counts.get(entry.path);
    const base = {
      ...paths(entry.path),
      sig: input.signatureOf(entry.path) ?? 'unknown',
      added: counts?.added ?? null,
      deleted: counts?.deleted ?? null,
    };
    if (entry.kind === 'unmerged') {
      // oids are [base, ours, theirs]: "ours" is HEAD's side; there is no single index blob.
      entries.push({
        ...base,
        xy: `${entry.x}${entry.y}`,
        hH: oidOrNull(entry.oids[1]),
        hI: null,
      });
      continue;
    }
    if (entry.kind !== 'ordinary' && entry.kind !== 'renamed') continue;
    const old = entry.kind === 'renamed' ? decodeRepoPath(entry.origPath) : null;
    entries.push({
      ...base,
      ...(old
        ? { oldPath: old.path, ...(old.rawPath === undefined ? {} : { oldRawPath: old.rawPath }) }
        : {}),
      xy: `${entry.x}${entry.y}`,
      hH: oidOrNull(entry.oidHead),
      hI: oidOrNull(entry.oidIndex),
    });
  }

  for (const info of input.untracked) {
    if (entries.length >= input.cap) break;
    entries.push({
      ...paths(info.key),
      xy: '??',
      hH: null,
      hI: null,
      sig: info.statSig,
      added: info.lines,
      deleted: info.lines === null ? null : 0,
    });
  }

  return { entries, total, truncated: total > entries.length };
}
