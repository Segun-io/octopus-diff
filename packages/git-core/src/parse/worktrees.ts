import { isNullOid } from './tokens.js';

/** One record of `git worktree list --porcelain`. */
export interface WorktreeRecord {
  /** Absolute path as printed by git (not necessarily a realpath). */
  path: string;
  /** HEAD commit; null for bare entries and unborn branches. */
  head: string | null;
  /** Full ref name (`refs/heads/x`) or null. */
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  lockedReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
}

function emptyRecord(path: string): WorktreeRecord {
  return {
    path,
    head: null,
    branch: null,
    bare: false,
    detached: false,
    locked: false,
    lockedReason: null,
    prunable: false,
    prunableReason: null,
  };
}

function applyAttribute(record: WorktreeRecord, line: string): void {
  const space = line.indexOf(' ');
  const key = space < 0 ? line : line.slice(0, space);
  const value = space < 0 ? null : line.slice(space + 1);
  switch (key) {
    case 'HEAD':
      record.head = value && !isNullOid(value) ? value : null;
      break;
    case 'branch':
      record.branch = value;
      break;
    case 'bare':
      record.bare = true;
      break;
    case 'detached':
      record.detached = true;
      break;
    case 'locked':
      record.locked = true;
      record.lockedReason = value;
      break;
    case 'prunable':
      record.prunable = true;
      record.prunableReason = value;
      break;
    default:
      break;
  }
}

/**
 * Parses `git worktree list --porcelain` output. With `-z` (git >= 2.36) every line ends in
 * NUL and records are separated by an empty token; without it, lines end in LF and records are
 * separated by blank lines.
 */
export function parseWorktreeList(output: string, nulTerminated: boolean): WorktreeRecord[] {
  const lines = output.split(nulTerminated ? '\u0000' : '\n');
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | null = null;
  for (const line of lines) {
    if (line.length === 0) {
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      current = emptyRecord(line.slice('worktree '.length));
      records.push(current);
      continue;
    }
    if (current) applyAttribute(current, line);
  }
  return records;
}
