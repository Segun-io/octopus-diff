/**
 * Synthetic file contents and git-style unified patches for the mock backend.
 */
import type { FileStatus } from '@octopus-diff/contracts';
import { structuredPatch } from 'diff';
import { fnv1a32, hash40, intBetween, pick, prng } from './util.js';

/** How a mock file's two sides are produced. */
export type MockFileKind =
  | 'text'
  | 'whitespace' // only indentation changes (exercises "hide whitespace")
  | 'crlf'
  | 'binary'
  | 'submodule'
  | 'symlink'
  | 'mode-only' // 100644 → 100755, no content change
  | 'empty' // empty file added
  | 'conflict'
  | 'huge' // too large (soft limit) and truncated even with full=true
  | 'big' // large but under the soft limit (virtualization)
  | 'trojan'; // bidi / invisible characters in the content (SEC-05)

export interface MockFile {
  path: string;
  /** Base64 raw path bytes for non-UTF-8 names. */
  rawPath?: string;
  oldPath: string | null;
  status: FileStatus;
  kind: MockFileKind;
  staged: boolean;
  unstaged: boolean;
  seed: number;
  /** Bumped by the change simulator; changes the new side. */
  version: number;
  /** Approximate base length in lines. */
  lines: number;
}

const WORDS = [
  'alpha',
  'beta',
  'cache',
  'delta',
  'event',
  'fetch',
  'graph',
  'hash',
  'index',
  'json',
  'kernel',
  'layout',
  'merge',
  'node',
  'octopus',
  'patch',
  'query',
  'review',
  'scope',
  'token',
  'update',
  'value',
  'worktree',
];

function ext(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot + 1);
}

function codeLine(rand: () => number, language: string, n: number): string[] {
  const a = pick(rand, WORDS);
  const b = pick(rand, WORDS);
  const c = intBetween(rand, 0, 999);
  switch (language) {
    case 'md':
      return [`## ${a} ${b}`, '', `The ${a} step updates ${b} for item ${c}.`, ''];
    case 'json':
      return [`  "${a}${n}": { "${b}": ${c} },`];
    case 'css':
      return [`.${a}-${n} {`, `  margin: ${c % 32}px;`, `  color: var(--${b});`, '}'];
    case 'py':
      return [`def ${a}_${n}(${b}):`, `    return ${b} * ${c}`, ''];
    case 'go':
      return [`func ${a}${n}(${b} int) int {`, `\treturn ${b} + ${c}`, '}', ''];
    case 'rs':
      return [`fn ${a}_${n}(${b}: u32) -> u32 {`, `    ${b} + ${c}`, '}', ''];
    default:
      return [
        `export function ${a}${n}(${b}: number): number {`,
        `  const ${a} = ${b} * ${c};`,
        `  return ${a} + ${n};`,
        '}',
        '',
      ];
  }
}

/** Deterministic base content of roughly `lines` lines. */
export function baseContent(path: string, seed: number, lines: number): string {
  const rand = prng(seed);
  const language = ext(path);
  const out: string[] = [];
  if (language === 'ts' || language === 'tsx' || language === 'js') {
    out.push(`// ${path}`, `import { ${pick(rand, WORDS)} } from './${pick(rand, WORDS)}.js';`, '');
  }
  let n = 0;
  while (out.length < lines) out.push(...codeLine(rand, language, n++));
  return `${out.join('\n')}\n`;
}

/** Applies `version` rounds of deterministic edits (insert, delete, replace). */
export function mutateContent(
  path: string,
  content: string,
  seed: number,
  version: number,
): string {
  const lines = content.split('\n');
  const language = ext(path);
  const editRounds = Math.max(1, version);
  for (let v = 0; v < editRounds; v++) {
    const rand = prng(seed ^ fnv1a32(`edit:${v}`));
    const edits = intBetween(rand, 1, 3);
    for (let e = 0; e < edits; e++) {
      const at = intBetween(rand, 0, Math.max(0, lines.length - 2));
      const op = rand();
      if (op < 0.4) {
        lines.splice(at, 0, ...codeLine(rand, language, 1000 + v * 10 + e));
      } else if (op < 0.65 && lines.length > 6) {
        lines.splice(at, intBetween(rand, 1, 3));
      } else {
        const line = lines[at] ?? '';
        lines[at] = `${line.replace(/\s+$/, '')} // ${pick(rand, WORDS)} v${v}`;
      }
    }
  }
  return lines.join('\n');
}

function reindent(content: string, version: number): string {
  return content
    .split('\n')
    .map((line, i) => (line && i % 3 === version % 3 ? `\t${line.trimStart()}` : line))
    .join('\n');
}

export interface FileSides {
  oldContent: string | null;
  newContent: string | null;
  oldMode: string | null;
  newMode: string | null;
}

/** Old/new content and modes of a mock file. */
export function fileSides(file: MockFile): FileSides {
  const seedOld = file.oldPath ? fnv1a32(file.oldPath) ^ file.seed : file.seed;
  const regular = '100644';
  switch (file.kind) {
    case 'binary':
      return {
        oldContent: file.status === 'added' || file.status === 'untracked' ? null : 'bin',
        newContent: file.status === 'deleted' ? null : `bin${file.version}`,
        oldMode: file.status === 'added' || file.status === 'untracked' ? null : regular,
        newMode: file.status === 'deleted' ? null : regular,
      };
    case 'submodule':
      return {
        oldContent: `Subproject commit ${hash40(`sub:${file.seed}`)}\n`,
        newContent: `Subproject commit ${hash40(`sub:${file.seed}:${file.version + 1}`)}\n`,
        oldMode: '160000',
        newMode: '160000',
      };
    case 'symlink':
      return {
        oldContent: file.status === 'added' ? null : '../shared/config.json',
        newContent: `../shared/config.v${file.version + 2}.json`,
        oldMode: file.status === 'added' ? null : '120000',
        newMode: '120000',
      };
    case 'mode-only': {
      const content = baseContent(file.path, file.seed, file.lines);
      return { oldContent: content, newContent: content, oldMode: regular, newMode: '100755' };
    }
    case 'empty':
      return { oldContent: null, newContent: '', oldMode: null, newMode: regular };
    case 'conflict': {
      const base = baseContent(file.path, file.seed, file.lines);
      const lines = base.split('\n');
      const at = Math.min(6, lines.length);
      lines.splice(
        at,
        0,
        '<<<<<<< HEAD',
        '  const retries = 3;',
        '=======',
        '  const retries = 5;',
        '>>>>>>> feature/retry',
      );
      return { oldContent: base, newContent: lines.join('\n'), oldMode: regular, newMode: regular };
    }
    case 'whitespace': {
      const base = baseContent(file.path, file.seed, file.lines);
      return {
        oldContent: base,
        newContent: reindent(base, file.version),
        oldMode: regular,
        newMode: regular,
      };
    }
    case 'trojan': {
      const base = baseContent(file.path, file.seed, file.lines);
      const next = `${base}\nfunction isAdmin(accessLevel: string) {\n  if (accessLevel != "user\u202E \u2066// Check if admin\u2069 \u2066") {\n    return true;\n  }\n  return false;\n}\n`;
      return { oldContent: base, newContent: next, oldMode: regular, newMode: regular };
    }
    case 'crlf': {
      const base = baseContent(file.path, file.seed, file.lines).replace(/\n/g, '\r\n');
      const next = mutateContent(file.path, base, file.seed, file.version + 1);
      return { oldContent: base, newContent: next, oldMode: regular, newMode: regular };
    }
    default: {
      const oldBase = baseContent(file.oldPath ?? file.path, seedOld, file.lines);
      const added = file.status === 'added' || file.status === 'untracked';
      const deleted = file.status === 'deleted';
      const pureRename =
        (file.status === 'renamed' || file.status === 'copied') && file.version === 0;
      let newContent: string | null;
      if (deleted) newContent = null;
      else if (added) newContent = mutateContent(file.path, oldBase, file.seed, file.version);
      else if (pureRename) newContent = oldBase;
      else newContent = mutateContent(file.path, oldBase, file.seed, file.version + 1);
      if (file.status === 'typechange') {
        return {
          oldContent: oldBase,
          newContent: '../elsewhere/target.ts',
          oldMode: regular,
          newMode: '120000',
        };
      }
      return {
        oldContent: added ? null : oldBase,
        newContent,
        oldMode: added ? null : regular,
        newMode: deleted ? null : regular,
      };
    }
  }
}

function shortId(content: string | null): string {
  return content === null ? '0000000' : hash40(content).slice(0, 7);
}

function quotePath(path: string): string {
  // git quotes paths with special characters; mirror that for non-ASCII names.
  return /[^\x20-\x7e]|"/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path;
}

function hunkRange(start: number, count: number): string {
  const s = count === 0 ? start - 1 : start;
  return count === 1 ? `${s}` : `${s},${count}`;
}

function hunks(
  oldName: string,
  newName: string,
  oldContent: string,
  newContent: string,
  context: number,
  ignoreWhitespace: boolean,
): string[] {
  const patch = structuredPatch(oldName, newName, oldContent, newContent, undefined, undefined, {
    context,
    ignoreWhitespace,
  });
  const out: string[] = [];
  for (const h of patch.hunks) {
    out.push(`@@ -${hunkRange(h.oldStart, h.oldLines)} +${hunkRange(h.newStart, h.newLines)} @@`);
    out.push(...h.lines);
  }
  return out;
}

export interface PatchOptions {
  context?: number;
  ignoreWhitespace?: boolean;
}

/** Builds a git-style per-file patch (`diff --git` header included). */
export function buildPatch(file: MockFile, options: PatchOptions = {}): string {
  const context = options.context ?? 3;
  const ignoreWhitespace = options.ignoreWhitespace ?? false;
  const sides = fileSides(file);
  const newPath = file.path;
  const oldPath = file.oldPath ?? file.path;
  const a = `a/${quotePath(oldPath)}`;
  const b = `b/${quotePath(newPath)}`;

  if (file.status === 'typechange') {
    const del = [
      `diff --git ${a} ${a.replace(/^a/, 'b')}`,
      `deleted file mode ${sides.oldMode}`,
      `index ${shortId(sides.oldContent)}..0000000`,
      `--- ${a}`,
      '+++ /dev/null',
      ...hunks(oldPath, newPath, sides.oldContent ?? '', '', context, ignoreWhitespace),
    ];
    const add = [
      `diff --git ${b.replace(/^b/, 'a')} ${b}`,
      `new file mode ${sides.newMode}`,
      `index 0000000..${shortId(sides.newContent)}`,
      '--- /dev/null',
      `+++ ${b}`,
      ...hunks(oldPath, newPath, '', sides.newContent ?? '', context, ignoreWhitespace),
    ];
    return `${[...del, ...add].join('\n')}\n`;
  }

  const lines = [`diff --git ${a} ${b}`];
  const isNew = sides.oldContent === null;
  const isDeleted = sides.newContent === null;
  if (isNew) lines.push(`new file mode ${sides.newMode}`);
  else if (isDeleted) lines.push(`deleted file mode ${sides.oldMode}`);
  else if (sides.oldMode !== sides.newMode) {
    lines.push(`old mode ${sides.oldMode}`, `new mode ${sides.newMode}`);
  }
  if (file.oldPath && (file.status === 'renamed' || file.status === 'copied')) {
    const similarity = sides.oldContent === sides.newContent ? 100 : 87;
    const verb = file.status === 'renamed' ? 'rename' : 'copy';
    lines.push(
      `similarity index ${similarity}%`,
      `${verb} from ${quotePath(oldPath)}`,
      `${verb} to ${quotePath(newPath)}`,
    );
  }
  if (sides.oldContent === sides.newContent) {
    // Mode change or pure rename: header only, no hunks.
    return `${lines.join('\n')}\n`;
  }
  const modeSuffix =
    !isNew && !isDeleted && sides.oldMode === sides.newMode ? ` ${sides.newMode}` : '';
  lines.push(`index ${shortId(sides.oldContent)}..${shortId(sides.newContent)}${modeSuffix}`);
  if (file.kind === 'binary') {
    lines.push(`Binary files ${isNew ? '/dev/null' : a} and ${isDeleted ? '/dev/null' : b} differ`);
    return `${lines.join('\n')}\n`;
  }
  if (sides.newContent === '' && isNew) return `${lines.join('\n')}\n`;
  lines.push(`--- ${isNew ? '/dev/null' : a}`, `+++ ${isDeleted ? '/dev/null' : b}`);
  lines.push(
    ...hunks(
      oldPath,
      newPath,
      sides.oldContent ?? '',
      sides.newContent ?? '',
      context,
      ignoreWhitespace,
    ),
  );
  return `${lines.join('\n')}\n`;
}

/** `git diff --numstat`-style counts from a patch; null for binary files. */
export function countLines(
  patch: string,
  binary: boolean,
): { additions: number | null; deletions: number | null } {
  if (binary) return { additions: null, deletions: null };
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git')) inHunk = false;
    else if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('+')) additions++;
    else if (inHunk && line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}
