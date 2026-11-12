import { createHash } from 'node:crypto';
import {
  GitCoreError,
  SNAPSHOT_MAX_ENTRIES_DEFAULT,
  SNAPSHOT_MAX_ENTRIES_LIMIT,
  type SummaryOptions,
  type SummarySnapshot,
  type SummarySnapshotEntry,
  SummarySnapshotOptionSchema,
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
  const raw: unknown = options?.snapshot;
  if (raw === undefined) return null;
  // Every boundary input is parsed with its contract schema before any field is read: `null`, a
  // number, an unknown key or a cap outside 1..LIMIT is an `invalid_argument`.
  const parsed = SummarySnapshotOptionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GitCoreError(
      'invalid_argument',
      `snapshot must be a boolean or { maxEntries: an integer 1..${SNAPSHOT_MAX_ENTRIES_LIMIT} }`,
    );
  }
  const wanted = parsed.data;
  if (wanted === false) return null;
  const max = wanted === true ? undefined : wanted.maxEntries;
  return max ?? SNAPSHOT_MAX_ENTRIES_DEFAULT;
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
  // One entry per path: after `git rm --cached f` (the file stays on disk) status lists f twice,
  // as a staged deletion and as untracked. The tracked entry wins (it carries the blob oids, so the
  // removed content stays readable), and the untracked copy is not listed or counted again.
  const trackedKeys = new Set<string>();
  for (const entry of tracked) trackedKeys.add(entry.path);
  const untracked = input.untracked.filter((info) => !trackedKeys.has(info.key));
  const total = tracked.length + untracked.length;
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

  for (const info of untracked) {
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

  return {
    entries,
    total,
    truncated: total > entries.length,
    contentHash: contentHash(tracked, untracked, input),
  };
}

/**
 * Hash of every changed path (the capped-off ones too): path, content signature, line counts and
 * whether it is a deletion, which is what the activity feed compares per file. Nothing about refs
 * (`git status` headers: HEAD, upstream, ahead/behind) and nothing about staging (status letters,
 * index object ids), so a fetch, a commit elsewhere or a `git add` never moves it. It is what tells
 * a truncated snapshot that a path beyond its cap was edited.
 */
function contentHash(
  tracked: readonly StatusEntry[],
  untracked: readonly UntrackedInfo[],
  input: SnapshotInput,
): string {
  const hash = createHash('sha256');
  const part = (value: string | number | null | undefined): void => {
    hash.update(String(value ?? ''), 'latin1').update('\u0000');
  };
  for (const entry of tracked) {
    part(entry.path);
    part(input.signatureOf(entry.path));
    const counts = input.counts.get(entry.path);
    part(counts?.added);
    part(counts?.deleted);
    // Only what the activity feed's per-file comparison looks at: staging (status letters, index
    // object id) is not an edit, a deletion is.
    const deletion =
      entry.kind === 'ordinary' || entry.kind === 'renamed'
        ? entry.x === 'D' || entry.y === 'D'
        : false;
    part(deletion ? 1 : 0);
  }
  part('untracked');
  for (const info of untracked) {
    part(info.key);
    part(info.statSig);
    part(info.lines);
  }
  return hash.digest('hex').slice(0, 32);
}
