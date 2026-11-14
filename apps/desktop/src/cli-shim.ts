/**
 * The `octopus-diff` command the app installs (docs/DESKTOP.md §3.2, roadmap #21): the pure parts.
 * A small launcher that runs the app's bundled CLI with `ELECTRON_RUN_AS_NODE=1`, so
 * `octopus-diff add .` in any terminal talks to the app's daemon. Nothing here touches the disk or
 * a process: quoting, the launcher text, the marker, the location, which target to run, PATH
 * checks and the install/update/refuse decision. `cli-shim-service.ts` wires them to effects.
 *
 * Adapted from T3 Code's `apps/desktop/src/app/DesktopCliShim.ts` (MIT, Copyright (c) 2026 T3
 * Tools Inc.; see scripts/credits/acknowledgements.json): the `shellWord` / `cmdWord` quoting, the
 * `.cmd` layout (a `goto`, not a parenthesized block; UTF-8 code page only for non-ASCII paths) and
 * the AppImage launcher that mounts the image itself. The marker rules, the never-overwrite
 * decision, PATH handling and the unstable-location checks are ours.
 *
 * The rules this file exists for (mutation-checked, scripts/mutation-check.mjs):
 * - the launcher carries a marker line; only a file with it is ever rewritten (`isOwnLauncher`);
 * - a real npm-installed `octopus-diff` is never overwritten, and if one is on PATH nothing is
 *   installed (`decide`).
 */
import path from 'node:path';
import type { DesktopCliConflict } from '@octopus-diff/contracts';

export const COMMAND_NAME = 'octopus-diff';

/**
 * Line 2 of every launcher (`# …` in sh, `rem …` in cmd). It must never change: an older app's
 * launcher is recognised as ours by it, so a newer app may rewrite it (after an update moved the
 * app). ASCII only: cmd reads the lines before the code-page switch in the old code page.
 */
export const MARKER =
  "Written by the octopus-diff desktop app: runs the app's bundled CLI. Delete this file to remove the command.";

/** Lines at the top of a file searched for the marker (the shebang or `@echo off`, then the marker). */
const MARKER_SEARCH_LINES = 4;

export class CliShimError extends Error {
  override readonly name = 'CliShimError';
}

// --- quoting --------------------------------------------------------------------------------------

/** A POSIX shell word: single quotes around everything, `'` as `'"'"'`. Safe for any path. */
export function shellWord(value: string): string {
  if (value.includes('\0')) throw new CliShimError('a path cannot contain a NUL byte');
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Text inside a cmd double-quoted word: `%` is expanded even inside quotes, so it is doubled.
 * A Windows path cannot hold `"`, and a line break or NUL would end the line: refused.
 */
export function cmdText(value: string): string {
  if (/["\r\n\0]/.test(value)) {
    throw new CliShimError('a Windows path cannot contain a quote, a line break or a NUL byte');
  }
  return value.replaceAll('%', '%%');
}

export function cmdWord(value: string): string {
  return `"${cmdText(value)}"`;
}

// --- the launcher ---------------------------------------------------------------------------------

export type LauncherTarget =
  /** An installed app (deb, macOS .app): run its binary on the bundled CLI entry. */
  | { kind: 'direct'; executable: string; entry: string }
  /** An AppImage: `appImage` is the file; `executable` and `entry` are relative to its mount. */
  | { kind: 'appimage'; appImage: string; executable: string; entry: string }
  /** Windows: a `.cmd` file. */
  | { kind: 'windows'; executable: string; entry: string };

const MOVED =
  'octopus-diff: the desktop app was moved or removed. Open it once to update this command, or reinstall it.';

const NON_ASCII = /[\u0080-\u{10ffff}]/u;

function renderWindows(target: { executable: string; entry: string }): string {
  // Validates (throws) before anything is written.
  const exe = cmdWord(target.executable);
  const entry = cmdWord(target.entry);
  const utf8 = NON_ASCII.test(target.executable) || NON_ASCII.test(target.entry);
  const restore = utf8 ? ['chcp %octopus_codepage% >nul'] : [];
  return [
    '@echo off',
    `rem ${MARKER}`,
    // Delayed expansion would rewrite `!name!` in paths and arguments.
    'setlocal EnableExtensions DisableDelayedExpansion',
    // cmd reads a batch file line by line in the console's current code page: switch to UTF-8 for
    // the lines below only when a path needs it, and restore it on every way out (Ctrl-C skips it).
    ...(utf8
      ? [
          `for /f "tokens=2 delims=:." %%c in ('chcp') do set "octopus_codepage=%%c"`,
          'chcp 65001 >nul',
        ]
      : []),
    'set "ELECTRON_RUN_AS_NODE=1"',
    // A goto, not a parenthesized block: "Program Files (x86)" would close the block early.
    `if exist ${exe} goto run`,
    ...restore,
    `echo ${MOVED} 1>&2`,
    'exit /b 127',
    ':run',
    `${exe} ${entry} %*`,
    'set "octopus_exit=%ERRORLEVEL%"',
    ...restore,
    'exit /b %octopus_exit%',
    '',
  ].join('\r\n');
}

const SH_HEADER = (appPath: string) => [
  '#!/bin/sh',
  `# ${MARKER}`,
  'export ELECTRON_RUN_AS_NODE=1',
  `app=${shellWord(appPath)}`,
  'if [ ! -x "$app" ]; then',
  `  echo ${shellWord(MOVED)} >&2`,
  '  exit 127',
  'fi',
];

function renderAppImage(target: { appImage: string; executable: string; entry: string }): string {
  return [
    ...SH_HEADER(target.appImage),
    // Extract-and-run would make the runtime start the app instead of mounting it.
    'unset APPIMAGE_EXTRACT_AND_RUN',
    'work=$(mktemp -d) || exit 1',
    'child=',
    'mounter=',
    // TERM, then KILL if it does not leave within about 5 s; the pid is not touched once it is gone.
    'stop() {',
    '  [ -n "$1" ] || return 0',
    '  kill "$1" 2>/dev/null || return 0',
    '  n=0',
    '  while kill -0 "$1" 2>/dev/null && [ "$n" -lt 100 ]; do sleep 0.05; n=$((n + 1)); done',
    '  if kill -0 "$1" 2>/dev/null; then kill -9 "$1" 2>/dev/null; fi',
    '  wait "$1" 2>/dev/null',
    '}',
    // The CLI runs in the background so a signal can be handled while `wait` waits (a foreground
    // child would defer the trap, and nothing would stop it). The runtime stays mounted until
    // killed: stopping it unmounts. Every way out, SIGHUP included (it skips an EXIT trap unless it
    // is trapped), ends here: the CLI is stopped, the mount is released, the work dir (the whole
    // extracted image without FUSE) is removed.
    'cleanup() { stop "$child"; stop "$mounter"; rm -rf "$work"; }',
    'trap cleanup EXIT',
    "trap 'exit 129' HUP",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    // The file exists before the job starts (the redirection happens in the job, a moment later).
    ': >"$work/mount"',
    '"$app" --appimage-mount >"$work/mount" 2>/dev/null &',
    'mounter=$!',
    'mount=',
    'while kill -0 "$mounter" 2>/dev/null; do',
    // `read` succeeds only on a whole line: a half-written path is never taken for the mount.
    '  if IFS= read -r mount <"$work/mount" && [ -d "$mount" ]; then break; fi',
    '  mount=',
    '  sleep 0.05',
    'done',
    // Without FUSE the runtime cannot mount (it exits at once); extracting the image still works.
    'if [ -z "$mount" ]; then',
    `  (cd "$work" && "$app" --appimage-extract >/dev/null) || { echo "octopus-diff: could not open $app." >&2; exit 1; }`,
    '  mount="$work/squashfs-root"',
    'fi',
    // A background job gets /dev/null for stdin in a shell without job control: hand it ours.
    'if (exec 3<&0) 2>/dev/null; then exec 3<&0; else exec 3</dev/null; fi',
    `"$mount"/${shellWord(target.executable)} "$mount"/${shellWord(target.entry)} "$@" <&3 3<&- &`,
    'child=$!',
    'wait "$child"',
    'status=$?',
    'child=',
    'exit "$status"',
    '',
  ].join('\n');
}

/** The launcher file's text for a target. Throws `CliShimError` for a path that cannot be quoted. */
export function renderLauncher(target: LauncherTarget): string {
  switch (target.kind) {
    case 'windows':
      return renderWindows(target);
    case 'appimage':
      return renderAppImage(target);
    case 'direct':
      return [
        ...SH_HEADER(target.executable),
        `exec "$app" ${shellWord(target.entry)} "$@"`,
        '',
      ].join('\n');
  }
}

/**
 * True for a launcher this app wrote (any version): the marker comment is on one of the first
 * lines, exactly. Text elsewhere or a longer line does not count, and an npm shim never has it.
 * This is the ONLY test that lets the installer replace a file.
 */
export function isOwnLauncher(content: string): boolean {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/, MARKER_SEARCH_LINES);
  return lines.some((line) => line === `# ${MARKER}` || line === `rem ${MARKER}`);
}

/** The word `shellWord` wrote at the start of `text`, up to the end of its line; null if it is anything else. */
function parseShellWord(text: string): string | null {
  let out = '';
  let i = 0;
  while (i < text.length && text[i] !== '\n') {
    const quote = text[i];
    if (quote !== "'" && quote !== '"') return null;
    const end = text.indexOf(quote, i + 1);
    if (end < 0) return null;
    const part = text.slice(i + 1, end);
    // `shellWord` only ever writes `"'"` as a double-quoted piece.
    if (quote === '"' && /[$`\\]/.test(part)) return null;
    out += part;
    i = end + 1;
  }
  return out === '' ? null : out;
}

/**
 * The file our launcher runs: the AppImage, or the app's binary (`app=…` in the sh launchers,
 * `if exist "…" goto run` in the `.cmd`). Null when it is not our launcher or the text is not what
 * `renderLauncher` writes (an older body, say). The startup refresh uses it: a launcher is only
 * retargeted when this file is gone (DECISIONS #574).
 */
export function launcherApp(content: string): string | null {
  if (!isOwnLauncher(content)) return null;
  // The first `app=` line is the header's; the quoted path (it may hold a newline) comes after it.
  const at = content.search(/^app=/m);
  if (at >= 0) return parseShellWord(content.slice(at + 4));
  const cmd = /^if exist "([^"\r\n]*)" goto run$/m.exec(content);
  return cmd?.[1] ? cmd[1].replaceAll('%%', '%') : null;
}

// --- where it goes ----------------------------------------------------------------------------------

export interface LauncherLocation {
  dir: string;
  file: string;
}

export function launcherLocation(input: {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  homedir: string;
}): LauncherLocation {
  if (input.platform === 'win32') {
    const w = path.win32;
    const local = input.env.LOCALAPPDATA;
    const base = local && w.isAbsolute(local) ? local : w.join(input.homedir, 'AppData', 'Local');
    const dir = w.join(base, COMMAND_NAME, 'bin');
    return { dir, file: w.join(dir, `${COMMAND_NAME}.cmd`) };
  }
  const dir = path.posix.join(input.homedir, '.local', 'bin');
  return { dir, file: path.posix.join(dir, COMMAND_NAME) };
}

// --- what it runs -----------------------------------------------------------------------------------

export type TargetResolution = { ok: true; target: LauncherTarget } | { ok: false; reason: string };

export interface TargetInput {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** `process.execPath`: the app binary. */
  execPath: string;
  /** The bundled CLI entry (`<app>/resources/app.asar/dist/cli/index.js`). */
  entry: string;
  isPackaged: boolean;
}

function inside(dir: string, file: string): boolean {
  const rel = path.posix.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.posix.isAbsolute(rel);
}

const MOVE_TO_APPLICATIONS =
  'octopus-diff is running from a disk image or a temporary location, which will not stay. ' +
  'Move it to your Applications folder, open it from there, then install the command.';

/**
 * What the launcher should run, or why there is nothing to install:
 * - a development run (`electron .`) has no installed app to point at;
 * - an AppImage's mount path changes every run, so the launcher runs the AppImage file itself
 *   (`$APPIMAGE`, set by its runtime together with `$APPDIR`; a stale `$APPIMAGE` that does not
 *   contain this process is ignored);
 * - a macOS app on a mounted dmg or translocated by Gatekeeper, and a `.mount_*` run whose
 *   AppImage file is unknown, would leave a launcher pointing at a path that is gone soon.
 */
export function resolveTarget(input: TargetInput): TargetResolution {
  if (!input.isPackaged) {
    return {
      ok: false,
      reason:
        'The command can only be installed from the installed app, not from a development run.',
    };
  }
  if (input.platform === 'win32') {
    return {
      ok: true,
      target: { kind: 'windows', executable: input.execPath, entry: input.entry },
    };
  }
  if (input.platform === 'linux') {
    const appImage = input.env.APPIMAGE;
    const appDir = input.env.APPDIR;
    if (
      appImage &&
      appDir &&
      path.posix.isAbsolute(appImage) &&
      path.posix.isAbsolute(appDir) &&
      inside(appDir, input.execPath)
    ) {
      if (!inside(appDir, input.entry)) {
        return { ok: false, reason: 'The AppImage does not contain the bundled command line.' };
      }
      return {
        ok: true,
        target: {
          kind: 'appimage',
          appImage,
          executable: path.posix.relative(appDir, input.execPath),
          entry: path.posix.relative(appDir, input.entry),
        },
      };
    }
    if (input.execPath.split('/').some((part) => part.startsWith('.mount_'))) {
      return {
        ok: false,
        reason:
          'octopus-diff is running from an AppImage that could not be identified. ' +
          'Start it by running the .AppImage file, then install the command.',
      };
    }
  }
  if (
    input.platform === 'darwin' &&
    (input.execPath.startsWith('/Volumes/') || input.execPath.includes('/AppTranslocation/'))
  ) {
    return { ok: false, reason: MOVE_TO_APPLICATIONS };
  }
  return { ok: true, target: { kind: 'direct', executable: input.execPath, entry: input.entry } };
}

// --- PATH -----------------------------------------------------------------------------------------

type Env = Readonly<Record<string, string | undefined>>;

function envValue(env: Env, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** A Windows PATH entry as a plain path: quotes off, `%VAR%` expanded; null if a variable is unknown. */
function expandWindowsEntry(entry: string, env: Env): string | null {
  let unknown = false;
  const expanded = entry
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/%([^%]+)%/g, (_all, name: string) => {
      const value = envValue(env, name);
      if (value === undefined) unknown = true;
      return value ?? '';
    });
  return unknown || expanded === '' ? null : expanded;
}

interface PathEntry {
  /** The directory as a path (expanded on Windows). */
  dir: string;
  /** Comparison key: normalised, no trailing separator, lower case on Windows. */
  key: string;
}

function windowsKey(dir: string): string {
  let normalized = path.win32.normalize(dir);
  while (normalized.length > 3 && normalized.endsWith('\\')) normalized = normalized.slice(0, -1);
  return normalized.toLowerCase();
}

function pathEntries(pathValue: string, platform: NodeJS.Platform, env: Env): PathEntry[] {
  if (platform === 'win32') {
    return pathValue.split(';').flatMap((raw) => {
      const dir = expandWindowsEntry(raw, env);
      // A drive letter with a separator, or UNC: `.`, `bin`, `C:foo` and `\\foo` depend on the
      // current directory or drive, which a repository must not be able to plant a command in.
      if (dir === null || !/^(?:[a-zA-Z]:[\\/]|[\\/]{2})/.test(dir)) return [];
      return [{ dir, key: windowsKey(dir) }];
    });
  }
  return pathValue.split(':').flatMap((dir) => {
    if (!path.posix.isAbsolute(dir)) return [];
    let normalized = path.posix.normalize(dir);
    while (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
    return [{ dir: normalized, key: normalized }];
  });
}

export function pathContainsDir(
  pathValue: string,
  dir: string,
  platform: NodeJS.Platform,
  env: Env,
): boolean {
  const want = pathEntries(dir, platform, env)[0]?.key;
  return want !== undefined && pathEntries(pathValue, platform, env).some((e) => e.key === want);
}

const WINDOWS_COMMAND_SUFFIXES = ['', '.cmd', '.exe', '.bat', '.com', '.ps1'];

/**
 * The files an `octopus-diff` command could be, in each absolute PATH entry (once each), except
 * the launcher's own file. A relative or empty entry means "the current directory": never searched
 * (a repository must not be able to plant a command, PLAN SEC-03).
 */
export function pathCandidates(input: {
  platform: NodeJS.Platform;
  env: Env;
  pathValue: string;
  /** The launcher's file: not a candidate (case-insensitive on Windows). */
  target: string;
}): string[] {
  const win = input.platform === 'win32';
  const api = win ? path.win32 : path.posix;
  const targetKey = win ? windowsKey(input.target) : input.target;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of pathEntries(input.pathValue, input.platform, input.env)) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    for (const suffix of win ? WINDOWS_COMMAND_SUFFIXES : ['']) {
      const file = api.join(entry.dir, `${COMMAND_NAME}${suffix}`);
      if ((win ? windowsKey(file) : file) !== targetKey) out.push(file);
    }
  }
  return out;
}

/**
 * The new value of the user's PATH with `dir` appended (Windows). Existing entries are kept byte
 * for byte, so `%VAR%` references stay unexpanded.
 */
export function addToUserPathValue(
  current: string | null,
  dir: string,
  env: Env,
): { changed: boolean; value: string } {
  if (current !== null && pathContainsDir(current, dir, 'win32', env)) {
    return { changed: false, value: current };
  }
  const base = current ?? '';
  if (base.trim() === '') return { changed: true, value: dir };
  return { changed: true, value: `${base.endsWith(';') ? base : `${base};`}${dir}` };
}

// --- the decision -----------------------------------------------------------------------------------

/** What is at a path (the installer reads the top of a file; a symlink is never followed). */
export type FileFacts =
  | { kind: 'missing' }
  | { kind: 'file'; content: string }
  | { kind: 'symlink' }
  /** A directory or anything else that is not a command (a FIFO, a socket). */
  | { kind: 'other' }
  /** Something is there that cannot be looked at or read (execute-only, a directory that cannot be searched). */
  | { kind: 'unreadable' };

export interface ShimFacts {
  /** The launcher text this app would write. */
  desired: string;
  targetPath: string;
  target: FileFacts;
  /** Other `octopus-diff` candidates found on PATH (`pathCandidates`), with what is there. */
  others: readonly { path: string; facts: FileFacts }[];
}

export type Decision =
  | { action: 'install' }
  | { action: 'update' }
  | { action: 'current' }
  | { action: 'refuse'; conflict: DesktopCliConflict };

/**
 * Install, update, leave alone, or refuse:
 * - anything at the target that is not our launcher (an npm shim, a symlink, a directory): refuse;
 * - another `octopus-diff` on PATH that is not our launcher (npm's, pnpm's, a symlink): refuse,
 *   even when our launcher is already installed. Nothing is written;
 * - otherwise write when missing, rewrite when it differs (only ever our own file), else leave it.
 */
export function decide(facts: ShimFacts): Decision {
  const { target } = facts;
  if (target.kind !== 'missing' && !(target.kind === 'file' && isOwnLauncher(target.content))) {
    return { action: 'refuse', conflict: { kind: 'at-target', path: facts.targetPath } };
  }
  for (const other of facts.others) {
    const isCommand =
      other.facts.kind === 'symlink' ||
      // Cheaper to refuse than to guess: a command we cannot read may well be npm's.
      other.facts.kind === 'unreadable' ||
      (other.facts.kind === 'file' && !isOwnLauncher(other.facts.content));
    if (isCommand) return { action: 'refuse', conflict: { kind: 'on-path', path: other.path } };
  }
  if (target.kind === 'missing') return { action: 'install' };
  return target.kind === 'file' && target.content === facts.desired
    ? { action: 'current' }
    : { action: 'update' };
}
