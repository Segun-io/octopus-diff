import type { FileDiff } from '@octopus-diff/contracts';

export const SYMLINK_MODE = '120000';
export const SUBMODULE_MODE = '160000';

/** How the diff pane presents one file diff. */
export type DiffDisplay =
  | { kind: 'binary' }
  | { kind: 'too-large'; byteLength: number | null }
  | { kind: 'submodule'; oldCommit: string | null; newCommit: string | null }
  | { kind: 'symlink'; oldTarget: string | null; newTarget: string | null; typechange: boolean }
  | { kind: 'empty'; reason: string }
  | { kind: 'patch'; truncated: boolean };

function hunkLines(patch: string): { minus: string[]; plus: string[] } {
  const minus: string[] = [];
  const plus: string[] = [];
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git')) inHunk = false;
    else if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('-')) minus.push(line.slice(1));
    else if (inHunk && line.startsWith('+')) plus.push(line.slice(1));
  }
  return { minus, plus };
}

/** Lines of the section (one `diff --git` block) whose mode line mentions `mode`. */
function sectionWithMode(patch: string, mode: string): string {
  const sections = patch.split(/^(?=diff --git )/m);
  return (
    sections.find((s) => new RegExp(`mode ${mode}\\b|index \\S+ ${mode}$`, 'm').test(s)) ?? patch
  );
}

export function hasHunks(patch: string): boolean {
  return /^@@ /m.test(patch);
}

function emptyReason(diff: FileDiff, ignoreWhitespace: boolean): string {
  const patch = diff.patch;
  const oldMode = /^old mode (\d+)$/m.exec(patch)?.[1] ?? diff.oldMode;
  const newMode = /^new mode (\d+)$/m.exec(patch)?.[1] ?? diff.newMode;
  if (diff.status === 'renamed' || diff.status === 'copied') {
    return `${diff.status === 'renamed' ? 'Renamed' : 'Copied'} without content changes`;
  }
  if (oldMode && newMode && oldMode !== newMode) return `File mode changed ${oldMode} → ${newMode}`;
  if (diff.status === 'added' || diff.status === 'untracked') return 'New empty file';
  if (diff.status === 'deleted') return 'Deleted empty file';
  if (ignoreWhitespace) return 'Only whitespace changed (hidden by the whitespace toggle)';
  return 'No content changes';
}

export function classifyDiff(diff: FileDiff, ignoreWhitespace = false): DiffDisplay {
  if (diff.binary) return { kind: 'binary' };
  if (diff.tooLarge) return { kind: 'too-large', byteLength: diff.byteLength };
  const modes = [diff.oldMode, diff.newMode];
  if (modes.includes(SUBMODULE_MODE)) {
    const { minus, plus } = hunkLines(sectionWithMode(diff.patch, SUBMODULE_MODE));
    const sha = (lines: string[]) =>
      lines.map((l) => /^Subproject commit ([0-9a-f]+)/.exec(l)?.[1]).find(Boolean) ?? null;
    return { kind: 'submodule', oldCommit: sha(minus), newCommit: sha(plus) };
  }
  if (modes.includes(SYMLINK_MODE)) {
    const section = sectionWithMode(diff.patch, SYMLINK_MODE);
    const { minus, plus } = hunkLines(section);
    const typechange =
      diff.oldMode !== diff.newMode && diff.oldMode !== null && diff.newMode !== null;
    const oldIsLink = diff.oldMode === SYMLINK_MODE;
    const newIsLink = diff.newMode === SYMLINK_MODE;
    return {
      kind: 'symlink',
      oldTarget: oldIsLink ? (minus[0] ?? null) : null,
      newTarget: newIsLink ? (plus[0] ?? null) : null,
      typechange,
    };
  }
  if (!hasHunks(diff.patch)) return { kind: 'empty', reason: emptyReason(diff, ignoreWhitespace) };
  return { kind: 'patch', truncated: diff.truncated };
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * A patch cut at the daemon's hard cap usually ends mid-hunk, so the last hunk header claims
 * more lines than are present. Rewrites that header to the lines actually present so the
 * parser renders the partial hunk instead of complaining.
 */
export function repairTruncatedPatch(patch: string): string {
  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let headerIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (line.startsWith('@@ ')) {
      headerIndex = i;
      break;
    }
    if (line.startsWith('diff --git ')) return patch;
  }
  if (headerIndex === -1) return patch;
  const match = HUNK_HEADER.exec(lines[headerIndex] ?? '');
  if (!match) return patch;
  let oldCount = 0;
  let newCount = 0;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const c = (lines[i] ?? '')[0];
    if (c === ' ' || c === undefined) {
      oldCount++;
      newCount++;
    } else if (c === '-') oldCount++;
    else if (c === '+') newCount++;
  }
  const oldStart = Number(match[1]);
  const newStart = Number(match[3]);
  const fix = (start: number, count: number) =>
    `${count === 0 ? Math.max(0, start) : start},${count}`;
  lines[headerIndex] =
    `@@ -${fix(oldStart, oldCount)} +${fix(newStart, newCount)} @@${match[5] ?? ''}`;
  return `${lines.join('\n')}\n`;
}
