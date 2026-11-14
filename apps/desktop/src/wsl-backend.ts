/**
 * The WSL backend's preflight (#22, docs/DESKTOP.md §11): before the supervisor starts `wsl.exe …
 * serve`, check that the chosen distro is listed (and is not a tool's own, like docker-desktop),
 * then run the read-only probe in it and turn missing prerequisites into a screen. On success it
 * returns the `wsl.exe` arguments for `serve`. Nothing is installed, ever.
 *
 * Over an injected `run` (argv only, never a shell): `main.ts` gives it `child_process.spawn` with
 * a timeout; the tests give it fakes.
 */
import {
  decodeWslText,
  isSafeDistroName,
  parseWslList,
  parseWslProbe,
  WSL_EXE,
  WSL_LIST_ARGS,
  WSL_PROBE_SCRIPT,
  type WslDistro,
  type WslProblem,
  wslProbeArgs,
  wslProblems,
  wslServeArgs,
} from './wsl.js';

export interface RunWslResult {
  /** The exit code, or null when it did not exit normally. */
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  /** `missing`: no wsl.exe; `timeout`: killed after `timeoutMs`; `spawn`: could not start. */
  error?: 'missing' | 'timeout' | 'spawn';
}

/** Runs `wsl.exe` with these arguments (and `input` on stdin, then EOF). Never throws. */
export type RunWsl = (
  args: readonly string[],
  options: { input?: string; timeoutMs: number },
) => Promise<RunWslResult>;

export const LIST_TIMEOUT_MS = 15_000;
/** A stopped distro boots first (several seconds), then the login shell runs. */
export const PROBE_TIMEOUT_MS = 60_000;

export type WslList = { ok: true; distros: WslDistro[] } | { ok: false; reason: string };

/** Text from a failed command for a screen: no control characters, short. */
export function cleanOutput(bytes: Buffer): string {
  return (
    decodeWslText(bytes)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal colour codes are dropped
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are dropped
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .trim()
      .slice(-300)
  );
}

export async function listWslDistros(run: RunWsl): Promise<WslList> {
  const r = await run(WSL_LIST_ARGS, { timeoutMs: LIST_TIMEOUT_MS });
  if (r.error === 'missing') {
    return { ok: false, reason: 'WSL is not installed (wsl.exe was not found).' };
  }
  if (r.error)
    return { ok: false, reason: `${WSL_EXE} --list --verbose did not answer (${r.error}).` };
  const distros = parseWslList(r.stdout);
  if (distros.length === 0) {
    return {
      ok: false,
      reason: 'WSL has no distros installed (wsl.exe --list --verbose lists none).',
    };
  }
  return { ok: true, distros };
}

export type WslPreflight =
  | {
      ok: true;
      distro: string;
      command: typeof WSL_EXE;
      /** The `serve` command line for one spawn attempt's ready nonce (a fresh one each time). */
      argsFor(nonce: string): string[];
      /** The distro's `octopus-diff --version`, for the log. */
      cliVersion: string | null;
    }
  | {
      ok: false;
      kind: 'no-wsl' | 'no-distro' | 'probe-failed' | 'prerequisites';
      reason: string;
      problems?: WslProblem[];
    };

export interface PreflightInput {
  run: RunWsl;
  distro: string;
  port: number | null;
  minNode: number;
  minGit: string;
}

export async function prepareWslBackend(input: PreflightInput): Promise<WslPreflight> {
  const { distro } = input;
  if (!isSafeDistroName(distro)) {
    return { ok: false, kind: 'no-distro', reason: 'The chosen WSL distro name is not valid.' };
  }
  const list = await listWslDistros(input.run);
  if (!list.ok) {
    const noWsl = list.reason.startsWith('WSL is not installed');
    return { ok: false, kind: noWsl ? 'no-wsl' : 'no-distro', reason: list.reason };
  }
  const found = list.distros.find((d) => d.name === distro);
  if (!found) {
    return { ok: false, kind: 'no-distro', reason: `The WSL distro "${distro}" is not installed.` };
  }
  if (found.system) {
    return {
      ok: false,
      kind: 'no-distro',
      reason: `"${distro}" belongs to another tool (it is not a distro to work in).`,
    };
  }
  const r = await input.run(wslProbeArgs(distro), {
    input: WSL_PROBE_SCRIPT,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const probe = r.error ? null : parseWslProbe(r.stdout.toString('utf8'));
  if (!probe) {
    const why = r.error
      ? `it did not answer (${r.error})`
      : `it stopped early (exit code ${r.code ?? 'unknown'})`;
    const detail = cleanOutput(r.stderr);
    return {
      ok: false,
      kind: 'probe-failed',
      reason: `Checking "${distro}" failed: ${why}.${detail ? ` ${detail}` : ''}`,
    };
  }
  const problems = wslProblems(probe, { minNode: input.minNode, minGit: input.minGit });
  if (problems.length > 0 || probe.path === null || probe.cli === null) {
    return {
      ok: false,
      kind: 'prerequisites',
      reason: `"${distro}" is missing what the app needs to run its backend there.`,
      problems,
    };
  }
  const { path, cli } = probe;
  // Checked once here, so a bad value fails the preflight (with a screen), not every attempt.
  try {
    wslServeArgs({ distro, path, cli, nonce: '0'.repeat(32), port: input.port });
  } catch (error) {
    return {
      ok: false,
      kind: 'probe-failed',
      reason: `"${distro}" cannot run the backend: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
  return {
    ok: true,
    distro,
    command: WSL_EXE,
    argsFor: (nonce) => wslServeArgs({ distro, path, cli, nonce, port: input.port }),
    cliVersion: probe.cliVersion,
  };
}
