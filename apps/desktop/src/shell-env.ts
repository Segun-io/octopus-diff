/**
 * Login-shell PATH (docs/DESKTOP.md §6). A GUI launch on macOS (and some Linux desktops) gets a
 * minimal PATH, so Homebrew's or MacPorts' `git`, `gh` and `glab` are not found. Like VS Code and
 * T3 Code, ask the user's login shell once: `$SHELL -ilc 'printf …"$PATH"…'` with a timeout. The
 * command is a constant argv (never built from input, never `shell: true` on our side); markers
 * around the value skip whatever the shell's rc files print.
 *
 * Windows keeps its PATH (GUI apps get the user's PATH there).
 */
import { spawn } from 'node:child_process';

export const PATH_MARKER_START = '__OCTOPUS_DIFF_PATH_START__';
export const PATH_MARKER_END = '__OCTOPUS_DIFF_PATH_END__';
export const SHELL_ENV_TIMEOUT_MS = 5_000;

/**
 * The script run with `-ilc` (one argv entry). It must parse in every accepted shell, fish
 * included: no `${PATH}` expansion (fish rejects it) and no `$(...)`; `printenv PATH` prints the
 * exported PATH (what a child would inherit) in all of them, and `;` separates commands in all of
 * them. The markers are printed by `printf`, whose output never gets a newline.
 */
export const PATH_SCRIPT = `printf '%s' '${PATH_MARKER_START}'; printenv PATH; printf '%s' '${PATH_MARKER_END}'`;

export type RunShell = (
  shell: string,
  args: readonly string[],
  options: { env: Record<string, string | undefined>; timeoutMs: number },
) => Promise<string>;

export interface ShellEnvInput {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  run: RunShell;
  timeoutMs?: number;
}

export type ShellPathResult =
  | { source: 'login-shell'; path: string; shell: string }
  | { source: 'inherited'; path: string; reason: string };

/** The PATH between the markers, or null when the output has none (or an empty one). */
export function extractPath(output: string): string | null {
  const start = output.lastIndexOf(PATH_MARKER_START);
  if (start === -1) return null;
  const from = start + PATH_MARKER_START.length;
  const end = output.indexOf(PATH_MARKER_END, from);
  if (end === -1) return null;
  const value = output.slice(from, end).trim();
  return value === '' ? null : value;
}

/** The login shell's entries first, then the inherited ones it lacks (no duplicates, no blanks). */
export function mergePath(
  loginPath: string,
  inherited: string | undefined,
  delimiter = ':',
): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...loginPath.split(delimiter), ...(inherited ?? '').split(delimiter)]) {
    if (entry === '' || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.join(delimiter);
}

/** A shell we can run with `-ilc`: an absolute path (no lookup), not something odd. */
export function usableShell(shell: string | undefined): string | null {
  if (!shell?.startsWith('/')) return null;
  const name = shell.slice(shell.lastIndexOf('/') + 1);
  // csh/tcsh have no `-l` with `-c`; nushell and others don't take POSIX `printf` quoting.
  if (!/^(?:ba|z|k|fi|da|mk|)sh$/.test(name)) return null;
  return shell;
}

export async function resolveShellPath(input: ShellEnvInput): Promise<ShellPathResult> {
  const inherited = input.env.PATH ?? '';
  if (input.platform === 'win32') {
    return { source: 'inherited', path: inherited, reason: 'Windows keeps its PATH' };
  }
  const shell = usableShell(input.env.SHELL);
  if (!shell) {
    return { source: 'inherited', path: inherited, reason: 'no usable $SHELL' };
  }
  let output: string;
  try {
    output = await input.run(shell, ['-ilc', PATH_SCRIPT], {
      // rc files can check this to skip slow or interactive parts (VS Code uses its own name).
      env: { ...input.env, OCTOPUS_DIFF_RESOLVING_ENVIRONMENT: '1' },
      timeoutMs: input.timeoutMs ?? SHELL_ENV_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { source: 'inherited', path: inherited, reason: `${shell} failed: ${message}` };
  }
  const loginPath = extractPath(output);
  if (!loginPath) {
    return { source: 'inherited', path: inherited, reason: `${shell} printed no PATH` };
  }
  return { source: 'login-shell', path: mergePath(loginPath, inherited), shell };
}

/** Output cap: a PATH is a few KB; rc files that print more are cut off (the markers decide). */
const MAX_OUTPUT = 1024 * 1024;

/**
 * Runs the shell with stdin closed (an interactive rc file must not wait for input), collects
 * stdout, and kills it (SIGKILL) at the timeout. Rejects on a non-zero exit or the timeout.
 */
export const defaultRunShell: RunShell = (shell, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(shell, args, {
      env: options.env,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (out.length < MAX_OUTPUT) out += chunk;
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${options.timeoutMs} ms`));
    }, options.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // `exit` is the shell's own end; `close` also waits for every process still holding stdout,
    // which an rc file starting a background job keeps open for as long as it runs. After `exit`
    // the output already written is read for a moment, then the pipe is dropped.
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      if (code === 0) resolve(out);
      else reject(new Error(signal ? `killed by ${signal}` : `exited with code ${code}`));
    };
    child.on('exit', (code, signal) => {
      setTimeout(() => finish(code, signal), 250).unref();
    });
    child.on('close', finish);
  });
