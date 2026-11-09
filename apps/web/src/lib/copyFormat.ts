/**
 * What the copy tools put on the clipboard (docs/COPY-TOOLS.md §5). Pure: no DOM, no React.
 *
 * Every text is passed through `escapeSuspicious` (SEC-05): a copy holds the visible `⟨U+…⟩`
 * escapes, never invisible or bidirectional characters, because pasting those into an agent
 * prompt is the attack the diff view guards against.
 *
 * `selectedDiffLines` and `languageForPath` are adapted from T3 Code (MIT, Copyright (c) 2026
 * T3 Tools Inc.), apps/web/src/reviewCommentContext.ts (`buildDiffReviewLines`,
 * `inferReviewCommentFenceLanguage`); `fenceFor` follows its `formatReviewCommentFence`.
 */
import type { DiffScope } from '@octopus-diff/contracts';
import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import { SCOPE_LABELS } from './scopeLabels.ts';
import { escapeSuspicious, hasSuspicious } from './unicode.ts';

export const SHORT_SHA_LENGTH = 7;

/** `a1b2c3d` (or the whole id with `short = false`). */
export function shaCopyText(sha: string, short = true): string {
  return short ? sha.slice(0, SHORT_SHA_LENGTH) : sha;
}

/** The branch name, or null when HEAD is detached (or the entry is bare). */
export function branchCopyText(worktree: { branch: string | null }): string | null {
  return worktree.branch === null ? null : escapeSuspicious(worktree.branch);
}

export interface FileCopyTexts {
  /** Repo-relative path (the new path of a rename). */
  relative: string;
  /** The last path segment. */
  name: string;
  /** `<worktree path>/<relative>`. */
  absolute: string;
  /** Repo-relative old path, only for a rename or copy. */
  oldRelative?: string;
  /** Some text contained invisible / bidirectional characters and was copied escaped. */
  escaped: boolean;
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

/** Joins a worktree root and a repo-relative path with the root's separator. */
export function joinWorktreePath(root: string, relative: string): string {
  if (isWindowsPath(root)) {
    return `${root.replace(/[\\/]+$/, '')}\\${relative.replaceAll('/', '\\')}`;
  }
  return `${root.replace(/\/+$/, '')}/${relative}`;
}

export function fileCopyTexts(
  file: { path: string; oldPath?: string | null },
  worktreePath: string,
): FileCopyTexts {
  const escaped =
    hasSuspicious(file.path) ||
    hasSuspicious(worktreePath) ||
    (file.oldPath ? hasSuspicious(file.oldPath) : false);
  const relative = escapeSuspicious(file.path);
  const root = escapeSuspicious(worktreePath);
  const name = relative.slice(relative.lastIndexOf('/') + 1);
  const out: FileCopyTexts = {
    relative,
    name,
    absolute: joinWorktreePath(root, relative),
    escaped,
  };
  if (file.oldPath && file.oldPath !== file.path) out.oldRelative = escapeSuspicious(file.oldPath);
  return out;
}

/** A backtick fence longer than any backtick run in `contents` (at least three). */
export function fenceFor(contents: string): string {
  let longest = 0;
  for (const match of contents.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Markdown inline code whose delimiter is longer than any backtick run inside. */
export function inlineCode(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const delimiter = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${delimiter}${pad}${text}${pad}${delimiter}`;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: 'sh',
  cc: 'cpp',
  cjs: 'js',
  cs: 'csharp',
  cxx: 'cpp',
  h: 'c',
  hpp: 'cpp',
  htm: 'html',
  kt: 'kotlin',
  kts: 'kotlin',
  md: 'markdown',
  mdx: 'mdx',
  mjs: 'js',
  mts: 'ts',
  cts: 'ts',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  yml: 'yaml',
  zsh: 'sh',
};

const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  justfile: 'just',
};

/** The fence language for a path: its extension (normalised for common ones), else `text`. */
export function languageForPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  const byName = LANGUAGE_BY_NAME[fileName];
  if (byName) return byName;
  const dot = fileName.lastIndexOf('.');
  let extension = '';
  if (dot > 0 && dot < fileName.length - 1) extension = fileName.slice(dot + 1);
  else if (dot === 0 && fileName.length > 1) extension = fileName.slice(1);
  if (!extension) return 'text';
  const language = LANGUAGE_BY_EXTENSION[extension] ?? extension;
  // An info string must not contain backticks; keep it to plain identifier characters.
  return /^[a-z0-9][a-z0-9+#_-]*$/.test(language) ? language : 'text';
}

export interface DiffLine {
  change: 'context' | 'add' | 'delete';
  /** Old-file line number (null for an added line). */
  oldLine: number | null;
  /** New-file line number (null for a deleted line). */
  newLine: number | null;
  /** For an added line: the old line it was inserted before; for a deleted one: the new line. */
  oldAt: number;
  newAt: number;
  content: string;
}

function stripNewline(value: string): string {
  return value.replace(/\r?\n$/, '');
}

/** Every line of a parsed patch, in unified order (context, then deletions, then additions). */
export function diffLines(fileDiff: FileDiffMetadata): DiffLine[] {
  const rows: DiffLine[] = [];
  for (const hunk of fileDiff.hunks) {
    let oldLine = hunk.deletionStart;
    let newLine = hunk.additionStart;
    // `@@ -0,0 +1,3 @@`: a zero-count side starts *after* the given line.
    if (hunk.deletionCount === 0) oldLine += 1;
    if (hunk.additionCount === 0) newLine += 1;
    for (const segment of hunk.hunkContent) {
      if (segment.type === 'context') {
        for (let i = 0; i < segment.lines; i++) {
          rows.push({
            change: 'context',
            oldLine,
            newLine,
            oldAt: oldLine,
            newAt: newLine,
            content: stripNewline(
              fileDiff.additionLines[segment.additionLineIndex + i] ??
                fileDiff.deletionLines[segment.deletionLineIndex + i] ??
                '',
            ),
          });
          oldLine++;
          newLine++;
        }
        continue;
      }
      for (let i = 0; i < segment.deletions; i++) {
        rows.push({
          change: 'delete',
          oldLine,
          newLine: null,
          oldAt: oldLine,
          newAt: newLine,
          content: stripNewline(fileDiff.deletionLines[segment.deletionLineIndex + i] ?? ''),
        });
        oldLine++;
      }
      for (let i = 0; i < segment.additions; i++) {
        rows.push({
          change: 'add',
          oldLine: null,
          newLine,
          oldAt: oldLine,
          newAt: newLine,
          content: stripNewline(fileDiff.additionLines[segment.additionLineIndex + i] ?? ''),
        });
        newLine++;
      }
    }
  }
  return rows;
}

function indexOfLine(
  rows: readonly DiffLine[],
  line: number,
  side: 'additions' | 'deletions' | undefined,
): number {
  const onOld = (r: DiffLine) => r.change !== 'add' && r.oldLine === line;
  const onNew = (r: DiffLine) => r.change !== 'delete' && r.newLine === line;
  const [first, second] = side === 'deletions' ? [onOld, onNew] : [onNew, onOld];
  const index = rows.findIndex(first);
  return index >= 0 ? index : rows.findIndex(second);
}

/**
 * The lines a `SelectedLineRange` covers, in diff order (a reversed range is normalised). In
 * split mode a range that stays in one column keeps only that column's lines (deleted + context
 * on the left, added + context on the right), which is what the reader saw highlighted.
 */
export function selectedDiffLines(
  fileDiff: FileDiffMetadata,
  range: SelectedLineRange,
  mode: 'split' | 'unified' = 'unified',
): DiffLine[] {
  const rows = diffLines(fileDiff);
  const endSide = range.endSide ?? range.side;
  const a = indexOfLine(rows, range.start, range.side);
  const b = indexOfLine(rows, range.end, endSide);
  if (a < 0 || b < 0) return [];
  const picked = rows.slice(Math.min(a, b), Math.max(a, b) + 1);
  if (mode === 'split' && range.side !== undefined && range.side === endSide) {
    const drop = range.side === 'deletions' ? 'add' : 'delete';
    return picked.filter((r) => r.change !== drop);
  }
  return picked;
}

export interface SelectionCopyMeta {
  project: string;
  /** Null when HEAD is detached. */
  branch: string | null;
  worktreePath: string;
  headSha: string | null;
  scope: DiffScope;
  /** The project's default branch, for `branch vs <base>`. */
  defaultBranch?: string | null;
  filePath: string;
  oldPath?: string | null;
}

/** `uncommitted`, `branch vs \`main\``, `commit \`a1b2c3d\``… (the toolbar's words). */
export function scopeCopyLabel(scope: DiffScope, defaultBranch?: string | null): string {
  switch (scope.kind) {
    case 'branch': {
      const base = scope.base ?? defaultBranch ?? null;
      const words = scope.includeWorking ? SCOPE_LABELS.branch.toLowerCase() : 'branch';
      return base ? `${words} vs ${inlineCode(escapeSuspicious(base))}` : words;
    }
    case 'commit':
      return `commit ${inlineCode(shaCopyText(scope.sha))}`;
    case 'review':
      return scope.base
        ? `to review since ${inlineCode(shaCopyText(scope.base))}`
        : SCOPE_LABELS.review.toLowerCase();
    default:
      return SCOPE_LABELS[scope.kind].toLowerCase();
  }
}

function span(numbers: number[]): string {
  const lo = Math.min(...numbers);
  const hi = Math.max(...numbers);
  return lo === hi ? `L${lo}` : `L${lo}–${hi}`;
}

/** `L12`, `L12–18`, or with deleted lines `old L10–12 → new L10–14`. */
export function rangeLabel(lines: readonly DiffLine[]): string {
  const oldNumbers = lines.flatMap((l) => (l.oldLine === null ? [] : [l.oldLine]));
  const newNumbers = lines.flatMap((l) => (l.newLine === null ? [] : [l.newLine]));
  if (!lines.some((l) => l.change === 'delete')) return newNumbers.length ? span(newNumbers) : '';
  if (newNumbers.length === 0) return `old ${span(oldNumbers)}`;
  return `old ${span(oldNumbers)} → new ${span(newNumbers)}`;
}

function hunkHeader(lines: readonly DiffLine[]): string {
  const side = (key: 'oldLine' | 'newLine', at: 'oldAt' | 'newAt') => {
    const numbers = lines.flatMap((l) => (l[key] === null ? [] : [l[key] as number]));
    if (numbers.length === 0) {
      // Nothing on this side: git writes the line *before* the insertion point with count 0.
      return `${Math.max(0, (lines[0]?.[at] ?? 1) - 1)},0`;
    }
    return `${Math.min(...numbers)},${numbers.length}`;
  };
  return `@@ -${side('oldLine', 'oldAt')} +${side('newLine', 'newAt')} @@`;
}

export type SelectionCopyFormat = 'plain' | 'markdown';

export interface SelectionCopy {
  text: string;
  /** Lines in the selection. */
  lines: number;
}

/** The text of selected lines: plain code, or Markdown with where it lives (§5). */
export function buildSelectionCopy({
  fileDiff,
  range,
  mode = 'unified',
  meta,
  format,
}: {
  fileDiff: FileDiffMetadata;
  range: SelectedLineRange;
  mode?: 'split' | 'unified';
  meta: SelectionCopyMeta;
  format: SelectionCopyFormat;
}): SelectionCopy | null {
  const lines = selectedDiffLines(fileDiff, range, mode);
  if (lines.length === 0) return null;
  const hasDeleted = lines.some((l) => l.change === 'delete');
  const newSide = lines.filter((l) => l.change !== 'delete');
  const content = (rows: readonly DiffLine[]) =>
    rows.map((l) => escapeSuspicious(l.content)).join('\n');

  if (format === 'plain') {
    return { text: content(newSide.length > 0 ? newSide : lines), lines: lines.length };
  }

  const path = escapeSuspicious(meta.filePath);
  const renamed =
    meta.oldPath && meta.oldPath !== meta.filePath
      ? ` (renamed from ${inlineCode(escapeSuspicious(meta.oldPath))})`
      : '';
  const short = meta.headSha ? shaCopyText(meta.headSha) : null;
  const where =
    meta.branch !== null
      ? inlineCode(escapeSuspicious(meta.branch))
      : short
        ? `detached at ${inlineCode(short)}`
        : 'detached';
  const line1 = [
    `${inlineCode(path)}${renamed} ${rangeLabel(lines)}`,
    where,
    escapeSuspicious(meta.project),
  ].join(' · ');
  const line2 = [
    `worktree ${inlineCode(escapeSuspicious(meta.worktreePath))}`,
    scopeCopyLabel(meta.scope, meta.defaultBranch),
    ...(short ? [`head ${inlineCode(short)}`] : []),
  ].join(' · ');

  const body = hasDeleted
    ? [
        hunkHeader(lines),
        ...lines.map(
          (l) =>
            `${l.change === 'add' ? '+' : l.change === 'delete' ? '-' : ' '}${escapeSuspicious(l.content)}`,
        ),
      ].join('\n')
    : content(newSide);
  const fence = fenceFor(body);
  const language = hasDeleted ? 'diff' : languageForPath(meta.filePath);
  const text = `${line1}\n${line2}\n\n${fence}${language}\n${body.replace(/\n+$/, '')}\n${fence}`;
  return { text, lines: lines.length };
}
