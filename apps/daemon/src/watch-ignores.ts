import path from 'node:path';
import { readSmallRegularFile } from './watch-identity.js';

/**
 * Build-output directories (review F5). They are big and churn during builds, so the watcher
 * skips them, but only where git ignores them too: tracked `dist/` (GitHub Actions), `build/`
 * (Kubernetes, Go) or `tools/build/` must stay live. Whether git ignores a directory is
 * approximated from `.gitignore` / `info/exclude` rules that name it directly; anything this
 * parser does not understand leaves the directory watched (costs watches, never hides edits).
 * Global excludes (`core.excludesFile`) are not read.
 */
export const BUILD_OUTPUT_DIRS: readonly string[] = ['dist', 'build', 'out', 'target', 'coverage'];

const BUILD_NAMES = new Set(BUILD_OUTPUT_DIRS);

/** Bigger ignore files are not parsed (their rules are then ignored: directories stay watched). */
const MAX_IGNORE_FILE_BYTES = 256 * 1024;

/** Build directories one ignore file (or the root rule set) ignores as a whole. */
export interface BuildDirRules {
  /** Names ignored at any depth below the ignore file's directory (`dist`, `dist/`, `**\/dist`). */
  anyDepth: Set<string>;
  /** Specific directories, relative to the ignore file's directory, `/`-separated (`/dist`, `app/build/`). */
  dirs: Set<string>;
}

export function emptyBuildDirRules(): BuildDirRules {
  return { anyDepth: new Set(), dirs: new Set() };
}

const GLOB_CHARS = /[*?[\]\\]/;

/**
 * Parses gitignore-format texts for rules that ignore a whole build directory. A negation
 * (`!…`) that mentions a build name cancels every rule for that name (conservative: it may
 * re-include tracked files).
 */
export function parseBuildDirRules(texts: readonly string[]): BuildDirRules {
  const rules = emptyBuildDirRules();
  const negated = new Set<string>();
  for (const text of texts) {
    for (const raw of text.split('\n')) {
      let line = raw.replace(/\r$/, '');
      if (!line || line.startsWith('#')) continue;
      line = line.replace(/(?<!\\)[ \t]+$/, '');
      if (!line) continue;
      if (line.startsWith('!')) {
        for (const name of BUILD_OUTPUT_DIRS) if (line.includes(name)) negated.add(name);
        continue;
      }
      if (line.startsWith('\\')) line = line.slice(1);
      const pattern = line.replace(/\/+$/, '');
      for (const suffix of ['/**', '/*']) {
        if (pattern.startsWith('**/') && pattern.endsWith(suffix)) {
          addAnyDepth(rules, pattern.slice(3, -suffix.length));
        }
      }
      if (pattern.startsWith('**/')) {
        addAnyDepth(rules, pattern.slice(3));
        continue;
      }
      let anchored = pattern.includes('/');
      let body = pattern.startsWith('/') ? pattern.slice(1) : pattern;
      // `dist/**` and `dist/*` ignore everything inside: as good as the directory itself.
      for (const suffix of ['/**', '/*']) {
        if (body.endsWith(suffix)) {
          body = body.slice(0, -suffix.length);
          anchored = true;
        }
      }
      if (!body || GLOB_CHARS.test(body)) continue;
      const segments = body.split('/');
      const last = segments[segments.length - 1] ?? '';
      if (!BUILD_NAMES.has(last) || segments.some((s) => s === '' || s === '.' || s === '..')) {
        continue;
      }
      if (anchored) rules.dirs.add(body);
      else rules.anyDepth.add(last);
    }
  }
  for (const name of negated) {
    rules.anyDepth.delete(name);
    for (const dir of [...rules.dirs])
      if (path.posix.basename(dir) === name) rules.dirs.delete(dir);
  }
  return rules;
}

function addAnyDepth(rules: BuildDirRules, name: string): void {
  if (BUILD_NAMES.has(name)) rules.anyDepth.add(name);
}

/** `<commonDir>/info/exclude` (shared by every worktree of a repository), or null. */
export function readExcludeFile(commonDir: string): Promise<string | null> {
  return readSmallRegularFile(path.join(commonDir, 'info', 'exclude'), MAX_IGNORE_FILE_BYTES);
}

/** Rules that apply at the worktree root: `<root>/.gitignore` plus the `info/exclude` text. */
export async function readRootBuildDirRules(
  root: string,
  excludeText: string | null,
): Promise<BuildDirRules> {
  const gitignore = await readSmallRegularFile(
    path.join(root, '.gitignore'),
    MAX_IGNORE_FILE_BYTES,
  );
  return parseBuildDirRules([gitignore, excludeText].filter((t): t is string => t !== null));
}

/** Rules of a nested `.gitignore` (`relDir` is `/`-separated, relative to the worktree root). */
export async function readNestedBuildDirRules(
  root: string,
  relDir: string,
): Promise<BuildDirRules> {
  const text = await readSmallRegularFile(
    path.join(root, ...relDir.split('/'), '.gitignore'),
    MAX_IGNORE_FILE_BYTES,
  );
  return text === null ? emptyBuildDirRules() : parseBuildDirRules([text]);
}

/**
 * Paths and globs (for `@parcel/watcher`) of build directories the root rules ignore, except
 * directories known to hold tracked files (`forced`) and, for any-depth names, every directory
 * of that name once one of them is forced (the event filter handles the rest).
 */
export function buildDirIgnoreEntries(rules: BuildDirRules, forced: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const forcedNames = new Set([...forced].map((d) => path.posix.basename(d)));
  for (const name of [...rules.anyDepth].sort()) {
    if (forcedNames.has(name)) continue;
    out.push(name, `**/${name}`);
  }
  for (const dir of [...rules.dirs].sort()) {
    if (
      rules.anyDepth.has(path.posix.basename(dir)) &&
      !forcedNames.has(path.posix.basename(dir))
    ) {
      continue;
    }
    if (!forced.has(dir)) out.push(dir);
  }
  return out;
}

/** Build directories along a `/`-separated relative path, outermost first (`a/dist/b` → `a/dist`). */
export function buildDirsOf(relPath: string): string[] {
  const segments = relPath.split('/');
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (BUILD_NAMES.has(segments[i] ?? '')) out.push(segments.slice(0, i + 1).join('/'));
  }
  return out;
}

/** Directories strictly between the root and `relDir` whose `.gitignore` can affect it. */
export function ancestorsOf(relDir: string): string[] {
  const segments = relDir.split('/');
  const out: string[] = [];
  for (let i = 1; i < segments.length; i++) out.push(segments.slice(0, i).join('/'));
  return out;
}

/**
 * Does git ignore build directory `relDir` according to the root rules and the nested
 * `.gitignore` rules of its ancestors? `nested(dir)` returns cached rules, or undefined if the
 * file has not been read yet (then the answer is undefined too).
 */
export function isIgnoredBuildDir(
  relDir: string,
  rootRules: BuildDirRules,
  nested: (dir: string) => BuildDirRules | undefined,
): boolean | undefined {
  const name = path.posix.basename(relDir);
  if (rootRules.anyDepth.has(name) || rootRules.dirs.has(relDir)) return true;
  let unknown = false;
  for (const dir of ancestorsOf(relDir)) {
    const rules = nested(dir);
    if (!rules) {
      unknown = true;
      continue;
    }
    if (rules.anyDepth.has(name) || rules.dirs.has(path.posix.relative(dir, relDir))) return true;
  }
  return unknown ? undefined : false;
}
